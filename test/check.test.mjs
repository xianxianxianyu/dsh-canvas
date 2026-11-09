import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'
import { HeadlessBrowser } from '../src/host/browser.ts'
import { canvasCheckTool, imageRoute } from '../src/host/check.ts'
import { CommentStore } from '../src/host/comments.ts'

const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const signal = new AbortController().signal

/** A model catalogue shaped like DSH's: flash sees images, v4-pro is text only. */
const llm = {
  async resolveModelInfo(provider, model) {
    if (provider !== 'deepseek-account') throw new Error(`unknown provider ${provider}`)
    return { 'deepseek-flash': { inputModalities: ['text', 'image'] }, 'deepseek-v4-pro': {} }[model]
  },
}
const agentOn = (model, routed) => ({
  session: { requestHeader: () => routed === undefined ? undefined : { config: routed } },
  options: { provider: 'deepseek-account', model },
})

test('the image gate follows the routed model, else the agent model, like read_image', async () => {
  assert.deepEqual(await imageRoute(llm, agentOn('deepseek-flash'), signal), { ok: true })
  assert.deepEqual(await imageRoute(llm, agentOn('deepseek-v4-pro'), signal), { ok: false, reason: '当前模型 deepseek-v4-pro 不支持看图' })
  assert.deepEqual(await imageRoute(llm, agentOn('deepseek-flash', { provider: 'deepseek-account', model: 'deepseek-v4-pro' }), signal),
    { ok: false, reason: '当前模型 deepseek-v4-pro 不支持看图' }, 'the Session route wins over agent options')
  assert.deepEqual(await imageRoute(undefined, agentOn('deepseek-flash'), signal), { ok: false, reason: '无法确定当前模型能否看图' })
  assert.deepEqual(await imageRoute(llm, undefined, signal), { ok: false, reason: '无法确定当前模型能否看图' })
  assert.deepEqual(await imageRoute(llm, agentOn('m', { provider: 'other', model: 'm' }), signal),
    { ok: false, reason: '无法确定模型 m 能否看图：unknown provider other' })
})

function harness({
  files, cwd = '/work', model = 'deepseek-flash', browser = { kind: 'missing', reason: '本机找不到 Chrome 或 Edge' },
  store = new CommentStore(join(tmpdir(), 'dsh-canvas-no-such-root')), headless = new HeadlessBrowser(),
}) {
  const fs = {
    async resolve(path, options) { return { displayPath: posix.resolve(options?.cwd ?? '/', path) } },
    async stat(target) { return target.displayPath in files ? { type: 'file' } : undefined },
    async readText(target) { return files[target.displayPath] },
    processPath(target) { return target.displayPath },
  }
  const saved = []
  const tool = canvasCheckTool({
    fs,
    workingDirectory: { ensure: async () => cwd },
    attachments: () => ({ imageLimits: { mediaTypes: ['image/png'] }, saveImage: async input => { saved.push(input); return { attachmentId: 'a1', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 } } }),
    llm: () => llm,
    browser: () => browser,
    headless,
    store,
  })
  const run = async args => {
    const value = await tool.execute(args, { signal, agent: agentOn(model) })
    return { value, content: tool.output.render(args, value) }
  }
  return { tool, run, saved }
}

test('a broken file is an error naming line:column and the snippet, with no image', async () => {
  const { run, saved } = harness({ files: { '/work/charts/pay.mmd': await fixture('broken.mmd') } })
  await assert.rejects(run({ path: 'charts/pay.mmd' }), error => {
    assert.match(error.message, /^✗ 图 \/work\/charts\/pay\.mmd：1 个错误\n {2}4:6 错误 Parse error on line 4: /u)
    assert.ok(error.message.endsWith('\n        s2 -> s3\n      -----^\n改好文件后再运行 canvas_check。'))
    return true
  })
  assert.equal(saved.length, 0)
})

test('a valid file passes with a one-line reason whenever no picture is attached', async () => {
  const files = { '/work/pay.mmd': await fixture('statechart.mmd') }
  const head = '✓ 图 /work/pay.mmd：校验通过（stateDiagram，258×344 px）'
  const textOnly = await harness({ files, model: 'deepseek-v4-pro' }).run({ path: 'pay.mmd' })
  assert.deepEqual(textOnly.content, [{ type: 'text', text: `${head}\n未出图：当前模型 deepseek-v4-pro 不支持看图` }])
  const validateOnly = await harness({ files }).run({ path: '/work/pay.mmd', image: false })
  assert.equal(validateOnly.value.text, `${head}\n未出图：本次只校验（image: false）`)
  const noBrowser = await harness({ files, browser: { kind: 'missing', reason: '配置的 browserPath 不存在：/nowhere/chrome' } }).run({ path: 'pay.mmd' })
  assert.equal(noBrowser.value.text, `${head}\n未出图：配置的 browserPath 不存在：/nowhere/chrome`)
  const broken = await harness({ files, browser: { kind: 'found', path: '/nowhere/chrome' } }).run({ path: 'pay.mmd' })
  assert.match(broken.value.text, /\n未出图：无头浏览器截图失败：.+$/u)
  assert.equal(broken.value.image, undefined)
})

test('only canvas suffixes and existing files are checked', async () => {
  const { run } = harness({ files: { '/work/notes.md': '# hi' } })
  await assert.rejects(run({ path: 'notes.md' }), { message: 'canvas_check 只检查 .mmd, .mermaid 文件：/work/notes.md' })
  await assert.rejects(run({ path: 'gone.mmd' }), { message: '找不到文件：/work/gone.mmd' })
  await assert.rejects(run({ path: '' }), { message: 'path 必须是非空字符串' })
  await assert.rejects(run({ path: 'a.mmd', image: 'yes' }), { message: 'image 必须是 true 或 false' })
})

/** A browser stand-in that keeps the HTML it is asked to photograph and answers with a 1×1 PNG. */
function recordingHeadless(pages) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  const page = { setContent: async html => { pages.push(html) }, screenshot: async () => png }
  const browser = { newContext: async () => ({ newPage: async () => page, close: async () => {} }) }
  return { use: async (_path, run) => run(browser) }
}

async function tempStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-canvas-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, store: new CommentStore(root) }
}

test('a passing check lists pending comments and outlines their nodes on the same page', async t => {
  const { store } = await tempStore(t)
  await store.apply('/work/pay.mmd', [
    { op: 'create', id: 'u-1', text: '失败后应该能直接重试', anchor: { target: 's3', label: '支付失败' } },
    { op: 'create', id: 'u-2', text: '这个状态去掉', anchor: { target: 's9', label: '旧状态' } },
    { op: 'create', id: 'u-3', text: '已经好了', anchor: { target: 's1', label: '购物车' } },
  ], 'user')
  await store.apply('/work/pay.mmd', [{ op: 'status', id: 'u-3', status: 'resolved' }], 'user')
  await store.apply('/work/pay.mmd', [{ op: 'reply', id: 'a-1', re: 'u-1', text: '在看' }], 'agent')
  const pages = []
  const { run } = harness({
    files: { '/work/pay.mmd': await fixture('statechart.mmd') }, store,
    browser: { kind: 'found', path: '/chrome' }, headless: recordingHeadless(pages),
  })
  const { value } = await run({ path: 'pay.mmd' })
  assert.equal(value.text, [
    '✓ 图 /work/pay.mmd：校验通过（stateDiagram，258×344 px）',
    '已出图：1×1 PNG，按 2× 截取，与右侧栏预览同一页面。',
    '待处理批注 2 条（图上红色虚线框标出）：',
    '  u-1 未处理 · 用户 · s3「支付失败」：失败后应该能直接重试',
    '    ↳ a-1 agent：在看',
    '  u-2 未处理 · 用户 · s9「旧状态」：这个状态去掉',
    '    ⚠ 图里已没有 s9（批注时是「旧状态」）',
    '改完后用 canvas_comment 回复，并传 status: "addressed" 标记已处理；只有用户能标记为已解决。',
  ].join('\n'))
  assert.equal(pages.length, 1)
  assert.ok(pages[0].includes('.pele .pele-node:is([data-id="s3"]){outline:'), 'only the pending node that is still drawn is outlined')
})

test('comments never change the verdict: unreadable comments are a note, a broken file lists none', async t => {
  const { root, store } = await tempStore(t)
  await mkdir(join(root, 'comments'), { recursive: true })
  const { createHash } = await import('node:crypto')
  await writeFile(join(root, 'comments', `${createHash('sha256').update('/work/pay.mmd').digest('hex')}.jsonl`), 'not json\n')
  const { run } = harness({ files: { '/work/pay.mmd': await fixture('statechart.mmd'), '/work/bad.mmd': await fixture('broken.mmd') }, store })
  const { value } = await run({ path: 'pay.mmd', image: false })
  assert.match(value.text, /\n批注读不出来：.+\.jsonl:1 /u)
  await assert.rejects(run({ path: 'bad.mmd' }), error => !error.message.includes('批注'))
})
