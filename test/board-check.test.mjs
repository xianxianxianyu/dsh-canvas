import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'
import { canvasCheckTool } from '../src/host/check.ts'
import { CommentStore } from '../src/host/comments.ts'
import { BoardJournal } from '../src/host/board-journal.ts'
import { parseBoard, scene } from '../src/shared/board.ts'
import { renderDiagram } from '../src/shared/diagram.ts'
import { boardPageHtml } from '../src/shared/page.ts'

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const BOARD = fixture('plan.canvas')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const signal = new AbortController().signal
const llm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
const agent = { session: { requestHeader: () => undefined }, options: { provider: 'deepseek-account', model: 'deepseek-flash' } }

/** canvas_check over an in-memory Session filesystem; `files` maps absolute paths to text or bytes. */
function harness(files, { headless } = {}) {
  const fs = {
    async resolve(path, options) { return { displayPath: posix.resolve(options?.cwd ?? '/', path) } },
    async stat(target) {
      const content = files[target.displayPath]
      return content === undefined ? undefined : { type: 'file', version: 'v1', size: content.length }
    },
    async readText(target) { return files[target.displayPath] },
    async readBytes(target, _signal, maxBytes) {
      const content = files[target.displayPath]
      if (content.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      return new Uint8Array(Buffer.from(content))
    },
    processPath(target) { return target.displayPath },
  }
  const pages = []
  const recording = {
    use: async (_path, run) => run({
      newContext: async () => ({
        newPage: async () => ({ setContent: async html => { pages.push(html) }, screenshot: async () => PNG }),
        close: async () => {},
      }),
    }),
  }
  const tool = canvasCheckTool({
    fs,
    workingDirectory: { ensure: async () => '/work' },
    attachments: () => ({ imageLimits: { mediaTypes: ['image/png'] }, saveImage: async input => ({ attachmentId: 'a1', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }) }),
    llm: () => llm,
    browser: () => ({ kind: 'found', path: '/chrome' }),
    headless: headless ?? recording,
    store: new CommentStore(join(tmpdir(), 'dsh-canvas-no-such-root')),
    journal: new BoardJournal(),
  })
  return { pages, run: args => tool.execute(args, { signal, agent, callId: 'c1' }) }
}

const FILES = {
  '/work/plan.canvas': BOARD,
  '/work/order.mmd': fixture('statechart.mmd'),
  '/work/img/logo.png': PNG,
}

test('a board passes with its embeds listed, and the composite picture is attached', async () => {
  const { run, pages } = harness(FILES)
  const value = await run({ path: 'plan.canvas' })
  assert.equal(value.text, [
    '✓ 画板 /work/plan.canvas：校验通过（3 个节点、1 条连线，840×360 px）',
    '嵌入 2 个：',
    '  flow ← order.mmd：图（stateDiagram，258×344 px）',
    '  logo ← img/logo.png：图片',
    '已出图：1×1 PNG，按 2× 截取，嵌入的图、笔记、图片都按画板上的位置画出。',
  ].join('\n'))
  assert.equal(value.image.attachmentId, 'a1')
  assert.equal(pages.length, 1)
})

test('the composite page holds the child diagram SVG, the rendered note, the image and the labelled edge', async () => {
  const { run, pages } = harness({ ...FILES, '/work/plan.canvas': BOARD.replace('"file":"img/logo.png"', '"file":"notes.md"'), '/work/notes.md': '# 规格\n\n- **含税**价格\n- <script>alert(1)</script>\n' })
  await run({ path: 'plan.canvas' })
  const [html] = pages
  const svg = renderDiagram(fixture('statechart.mmd')).svg
  assert.ok(html.includes(svg), 'the pele SVG of order.mmd is inside the page, byte for byte')
  assert.ok(html.includes('data-node-id="flow"'))
  assert.ok(html.includes('<h2>为什么</h2>') && html.includes('支付失败要能重试'), 'the text node is rendered Markdown')
  assert.ok(html.includes('<h1>规格</h1>') && html.includes('<strong>含税</strong>'), 'the embedded note is rendered Markdown')
  assert.ok(!/<script/iu.test(html) && html.includes('&lt;script&gt;'), 'raw HTML in a note is shown as text, never run')
  assert.ok(html.includes('>解释<'), 'the edge label is on the page')
  assert.match(html, /<path [^>]*marker-end=/u, 'the edge is an SVG path with an arrow')
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/u)
})

test('the page puts the image in as a data URI and every node at its board position', () => {
  const board = parseBoard(BOARD).board
  const page = boardPageHtml(scene(board), new Map([
    ['flow', { kind: 'card', title: 'order.mmd', detail: '' }],
    ['logo', { kind: 'image', src: `data:image/png;base64,${PNG.toString('base64')}` }],
  ]), 'light')
  assert.ok(page.html.includes(`<img src="data:image/png;base64,${PNG.toString('base64')}"`))
  assert.match(page.html, /data-node-id="why"[^>]*style="left:576px;top:16px;width:280px;height:160px/u, 'positions are board coordinates plus the page padding')
  assert.equal(page.width, 840 + 32)
  assert.equal(page.height, 360 + 32)
})

test('missing embeds and broken child diagrams fail the check with where to look', async () => {
  const missing = harness({ '/work/plan.canvas': BOARD, '/work/img/logo.png': PNG })
  await assert.rejects(missing.run({ path: 'plan.canvas' }), error => {
    const lines = error.message.split('\n')
    assert.equal(lines[0], '✗ 画板 /work/plan.canvas：1 个错误')
    assert.equal(lines[1], '  3:3 错误 节点 flow 嵌入的文件不存在：order.mmd（/work/order.mmd）')
    assert.equal(lines.at(-1), '改好文件后再运行 canvas_check。')
    return true
  })
  const broken = harness({ ...FILES, '/work/order.mmd': fixture('broken.mmd') })
  await assert.rejects(broken.run({ path: 'plan.canvas', image: false }), error => {
    assert.match(error.message, /^✗ 画板 \/work\/plan\.canvas：1 个错误\n {2}order\.mmd:4:6 错误 节点 flow 嵌入的图：Parse error on line 4: /u)
    assert.ok(error.message.includes('\n        s2 -> s3\n      -----^\n'), 'the child file\'s own snippet')
    return true
  })
  const invalid = harness({ '/work/plan.canvas': BOARD.replace('"toNode":"flow"', '"toNode":"nobody"') })
  await assert.rejects(invalid.run({ path: 'plan.canvas' }), { message: /^✗ 画板 \/work\/plan\.canvas：1 个错误\n {2}8:\d+ 错误 连线 e1 的 toNode 指向不存在的节点 "nobody"/u })
})

test('overlaps, crowded notes, shrunken diagrams and unsupported embeds are warnings, not errors', async () => {
  const board = JSON.stringify({
    nodes: [
      { id: 'flow', type: 'file', file: 'order.mmd', x: 0, y: 0, width: 120, height: 100 },
      { id: 'long', type: 'text', text: '这一段文字很长，'.repeat(30), x: 100, y: 80, width: 200, height: 60 },
      { id: 'data', type: 'file', file: 'data.csv', x: 400, y: 0, width: 100, height: 60 },
      { id: 'sub', type: 'file', file: 'other.canvas', x: 400, y: 100, width: 100, height: 60 },
    ],
  }).replace('[{', '[\n{').replaceAll('},{', '},\n{')
  const { run } = harness({ '/work/plan.canvas': board, '/work/order.mmd': fixture('statechart.mmd'), '/work/data.csv': 'a,b\n', '/work/other.canvas': '{}' })
  const { text } = await run({ path: 'plan.canvas', image: false })
  const lines = text.split('\n')
  assert.equal(lines[0], '✓ 画板 /work/plan.canvas：校验通过（4 个节点、0 条连线，500×160 px），5 个警告')
  assert.deepEqual(lines.filter(line => line.includes('警告 ')), [
    '  2:1 警告 节点 flow 里的图缩到了 16%（原图 258×344 px），字可能看不清；把框调大',
    '  3:1 警告 节点 long 和 flow 重叠 20×20 px',
    '  3:1 警告 节点 long 的文字大约要 448 px 高，框只有 60 px，放不下的部分会被截掉',
    '  4:1 警告 节点 data 嵌入的 data.csv 画板显示不了，只显示文件名',
    '  5:1 警告 节点 sub 嵌入的是画板，只显示文件名，不展开（只展开一层）',
  ])
})
