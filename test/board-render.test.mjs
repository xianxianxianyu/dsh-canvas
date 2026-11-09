import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import test from 'node:test'
import { checkBoard, prepareBoard } from '../src/host/board-check.ts'
import { boardRenderRoute } from '../src/host/board-render.ts'
import { apply } from '../src/host/index.ts'
import { parseBoard, scene } from '../src/shared/board.ts'
import { renderDiagram } from '../src/shared/diagram.ts'
import { boardColor, boardNodePageHtml, boardPageHtml, edgePath, EDGE_LABEL } from '../src/shared/page.ts'

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const BOARD = fixture('plan.canvas')
const DIAGRAM = fixture('statechart.mmd')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const PATH = '/work/boards/plan.canvas'
const signal = new AbortController().signal

function harness(files = {}, aliases = {}) {
  const store = new Map(Object.entries(files))
  const calls = []
  const fs = {
    async resolve(path, options) {
      const absolute = posix.resolve(options?.cwd ?? '/', path)
      calls.push({ method: 'resolve', path: absolute, cwd: options?.cwd })
      return { displayPath: aliases[absolute] ?? absolute }
    },
    processPath(target) { return target.displayPath },
    async stat(target) {
      calls.push({ method: 'stat', path: target.displayPath })
      const value = store.get(target.displayPath)
      return value === undefined ? undefined : { type: 'file', version: 'v1', size: Buffer.byteLength(value) }
    },
    async readText(target) {
      calls.push({ method: 'readText', path: target.displayPath })
      const value = store.get(target.displayPath)
      if (value instanceof Error) throw value
      if (value === undefined) throw new Error('missing file')
      return String(value)
    },
    async readBytes(target, _signal, maxBytes) {
      calls.push({ method: 'readBytes', path: target.displayPath })
      const value = store.get(target.displayPath)
      if (value === undefined) throw new Error('missing file')
      if (value.length > maxBytes) throw new Error('too large')
      return new Uint8Array(Buffer.from(value))
    },
    async writeText(target, value) {
      calls.push({ method: 'writeText', path: target.displayPath })
      store.set(target.displayPath, value)
      return { version: 'v2' }
    },
  }
  const route = boardRenderRoute({ fs })
  const post = async body => {
    const response = await route.fetch(new Request('http://localhost/api/canvas/board-render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
  }
  return { fs, route, calls, store, post, context: { fs, path: PATH, signal } }
}

const files = {
  [PATH]: 'the current file may already differ from the caller’s snapshot',
  '/work/boards/order.mmd': DIAGRAM,
  '/work/boards/img/logo.png': PNG,
}

test('board rendering is a separate exact owner-only POST route in the connection scope', () => {
  const { fs, route } = harness()
  assert.equal(route.path, '/api/canvas/board-render')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  const registered = []
  const ctx = {
    fs, workingDirectory: { ensure: async () => '/work' },
    tools: { register() {} }, skills: { registerProvider() {} }, effect() {}, get() {},
    inject(names, callback) {
      assert.deepEqual(names, ['connection', 'sessions'])
      callback({ ...ctx, sessions: { get() {} }, connection: { fetch: { register: item => registered.push(item) } } })
    },
  }
  apply(ctx, { root: '/canvas-test-data' })
  assert.equal(registered.filter(item => item.path === '/api/canvas/board-render').length, 1)
  assert.deepEqual(registered.find(item => item.path === '/api/canvas/board-render').methods, ['POST'])
})

test('the supplied source prepares reusable Markdown, diagram SVG and image bytes without reading or writing the board', async () => {
  const { post, calls, store, context } = harness(files)
  const before = new Map(store)
  const result = await post({ path: PATH, source: BOARD })
  assert.equal(result.status, 200)
  assert.equal(result.cache, 'no-store')
  assert.deepEqual(Object.keys(result.body).sort(), ['contents', 'diagnostics'])
  assert.deepEqual(result.body.diagnostics, [])
  const contents = new Map(result.body.contents)
  assert.equal(contents.get('why').html, '<h2>为什么</h2>\n<p>支付失败要能重试</p>\n')
  const diagram = renderDiagram(DIAGRAM)
  assert.equal(diagram.ok, true)
  assert.deepEqual(contents.get('flow'), { kind: 'svg', markup: diagram.svg, width: diagram.width, height: diagram.height })
  assert.deepEqual(contents.get('logo'), { kind: 'image', src: `data:image/png;base64,${PNG.toString('base64')}` })
  assert.equal(calls.filter(call => call.method === 'readText').length, 1, 'the embedded diagram was actually read')
  assert.equal(calls.filter(call => call.method === 'readBytes').length, 1, 'the embedded image was actually read')
  assert.equal(calls.some(call => call.path === PATH && call.method !== 'resolve'), false)
  assert.equal(calls.some(call => call.method === 'writeText'), false)
  assert.deepEqual(store, before)

  const checked = await checkBoard(BOARD, context)
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.diagnostics, result.body.diagnostics)
  for (const node of parseBoard(BOARD).board.nodes) {
    const page = boardNodePageHtml(node, contents.get(node.id), 'light')
    const expected = contents.get(node.id)
    const markup = expected.kind === 'html' ? expected.html : expected.kind === 'svg' ? expected.markup : expected.src
    assert.ok(page.html.includes(markup))
    assert.ok(checked.page([]).html.includes(markup), 'the check and node page consume the same content')
  }
})

test('inline and embedded Markdown keep raw HTML inert in both node and whole-board pages', async () => {
  const source = JSON.stringify({ nodes: [
    { id: 'note', type: 'text', text: '# Safe\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>', x: 0, y: 0, width: 300, height: 200 },
    { id: 'file', type: 'file', file: '../notes.md', x: 400, y: 0, width: 300, height: 200 },
  ] })
  const { post } = harness({ '/work/notes.md': '## Embedded\n\n<iframe src="https://evil.invalid"></iframe>' })
  const result = await post({ path: PATH, source })
  assert.equal(result.status, 200)
  const contents = new Map(result.body.contents)
  assert.match(contents.get('note').html, /<h1>Safe<\/h1>/u)
  assert.match(contents.get('note').html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
  assert.match(contents.get('file').html, /&lt;iframe/u)
  const board = parseBoard(source).board
  const pages = [boardPageHtml(scene(board), contents, 'light'), ...board.nodes.map(node => boardNodePageHtml(node, contents.get(node.id), 'light'))]
  for (const page of pages) {
    assert.doesNotMatch(page.html, /<(?:script|iframe)|<img src=x/iu)
    assert.match(page.html, /content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/u)
  }
})

test('relative embeds resolve from the canonical board directory through the filesystem', async () => {
  const source = JSON.stringify({ nodes: [{ id: 'f', type: 'file', file: '../notes.md', x: 0, y: 0, width: 200, height: 120 }] })
  const { post, calls } = harness({ '/canonical/notes.md': '**Canonical**' }, { '/alias/plan.canvas': '/canonical/boards/plan.canvas' })
  const result = await post({ path: '/alias/plan.canvas', source })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.contents, [['f', { kind: 'html', html: '<p><strong>Canonical</strong></p>\n' }]])
  assert.ok(calls.some(call => call.method === 'resolve' && call.cwd === '/canonical/boards' && call.path === '/canonical/notes.md'))
  assert.ok(calls.some(call => call.method === 'readText' && call.path === '/canonical/notes.md'))
})

test('missing embeds remain cards on a valid board while canvas_check still fails with identical diagnostics', async () => {
  const { post, context } = harness({ '/work/boards/img/logo.png': PNG })
  const result = await post({ path: PATH, source: BOARD })
  assert.equal(result.status, 200)
  assert.deepEqual(new Map(result.body.contents).get('flow'), { kind: 'card', title: 'order.mmd', detail: '文件不存在' })
  assert.deepEqual(result.body.diagnostics, [{ severity: 'error', line: 3, column: 3, message: '节点 flow 嵌入的文件不存在：order.mmd（/work/boards/order.mmd）' }])
  const prepared = await prepareBoard(BOARD, context)
  assert.equal(prepared.ok, true, 'embed failure does not invalidate the board structure')
  const checked = await checkBoard(BOARD, context)
  assert.equal(checked.ok, false)
  assert.deepEqual(checked.diagnostics, result.body.diagnostics)
})

test('a broken embedded diagram returns a card and located child diagnostics, not invalid-source', async () => {
  const { post, context } = harness({ ...files, '/work/boards/order.mmd': fixture('broken.mmd') })
  const result = await post({ path: PATH, source: BOARD })
  assert.equal(result.status, 200)
  assert.deepEqual(new Map(result.body.contents).get('flow'), { kind: 'card', title: 'order.mmd', detail: '画不出来' })
  assert.equal(result.body.diagnostics[0].file, 'order.mmd')
  assert.equal(result.body.diagnostics[0].line, 4)
  assert.equal(result.body.diagnostics[0].severity, 'error')
  assert.deepEqual((await checkBoard(BOARD, context)).diagnostics, result.body.diagnostics)
})

test('structurally invalid source is refused before reading any embeds', async () => {
  for (const source of ['{', BOARD.replace('"toNode":"flow"', '"toNode":"missing"')]) {
    const { post, calls } = harness(files)
    const result = await post({ path: PATH, source })
    assert.equal(result.status, 409)
    assert.equal(result.cache, 'no-store')
    assert.equal(result.body.error, 'invalid-source')
    assert.equal(typeof result.body.message, 'string')
    assert.deepEqual(result.body.diagnostics, parseBoard(source).diagnostics)
    assert.equal('contents' in result.body, false)
    assert.equal(calls.some(call => call.method !== 'resolve'), false)
  }
})

test('the boundary rejects relative paths, non-board paths, invalid JSON and malformed payloads', async () => {
  const { post, calls } = harness()
  for (const body of [
    '{', {}, { path: PATH, source: 42 }, { path: 'plan.canvas', source: BOARD },
    { path: PATH, source: BOARD, ops: [] }, { path: '/work/diagram.mmd', source: BOARD },
  ]) {
    const result = await post(body)
    assert.equal(result.status, 400)
    assert.equal(result.body.error, 'bad-request')
    assert.equal(result.cache, 'no-store')
    assert.equal(typeof result.body.message, 'string')
  }
  assert.equal(calls.some(call => call.method !== 'resolve'), false)
})

test('node pages are responsive and geometry-independent, with the exact whole-board content and pixel metrics', () => {
  const node = parseBoard(BOARD).board.nodes.find(node => node.id === 'why')
  const content = { kind: 'html', html: '<h2>为什么</h2>\n<p>支付失败要能重试</p>\n' }
  for (const scheme of ['light', 'dark']) {
    const page = boardNodePageHtml(node, content, scheme)
    const moved = boardNodePageHtml({ ...node, x: -901, y: 753, width: 701, height: 509 }, content, scheme)
    assert.equal(page.html, moved.html, 'geometry changes never reload a node document')
    assert.deepEqual([page.width, page.height, page.background], [280, 160, 'transparent'])
    assert.deepEqual([moved.width, moved.height], [701, 509])
    assert.match(page.html, /html,body\{[^}]*height:100%[^}]*background:transparent/u)
    assert.match(page.html, /body\{width:100%;height:100%;position:relative;overflow:hidden/u)
    assert.match(page.html, /data-node-id="why" style="left:0px;top:0px;width:100%;height:100%;--c:#44cf6e"/u)
    assert.match(page.html, /\.node\{[^}]*box-sizing:border-box;border:2px solid[^}]*border-radius:8px/u)
    assert.match(page.html, /\.md\{[^}]*padding:12px;font-size:14px;line-height:1.5/u)
    assert.match(page.html, /\.md h2\{font-size:17px\}/u)
    const whole = boardPageHtml(scene({ nodes: [node], edges: [] }), new Map([[node.id, content]]), scheme)
    assert.ok(page.html.includes(`<div class="md">${content.html}</div>`))
    assert.ok(whole.html.includes(`<div class="md">${content.html}</div>`))
    assert.match(whole.html, /data-node-id="why" style="left:16px;top:16px;width:280px;height:160px;--c:#44cf6e"/u)
  }
})

test('file, link, fallback and group node pages retain the same fitting, escaping and translucency', () => {
  const board = parseBoard(BOARD).board
  const file = board.nodes.find(node => node.id === 'flow')
  const filePage = boardNodePageHtml(file, { kind: 'card', title: '<missing>', detail: 'No <file>' }, 'light')
  assert.match(filePage.html, /<div class="name">order.mmd<\/div><div class="body"><div class="card"><b>&lt;missing&gt;<\/b><span>No &lt;file&gt;<\/span>/u)
  assert.match(filePage.html, /\.file>\.name\{flex:none;height:24px;line-height:23px;padding:0 8px;box-sizing:border-box/u)
  assert.match(filePage.html, /\.file>\.body\{flex:1;min-height:0;padding:8px;box-sizing:border-box/u)
  assert.match(filePage.html, /\.fit>svg\{display:block;width:100%;height:100%\}/u)
  assert.match(filePage.html, /\.body>img\{display:block;max-width:100%;max-height:100%;object-fit:contain\}/u)
  const fallback = boardNodePageHtml({ ...board.nodes[1], text: '<script>unsafe</script>' }, undefined, 'light')
  assert.match(fallback.html, /<div class="md plain">&lt;script&gt;unsafe&lt;\/script&gt;<\/div>/u)
  const link = boardNodePageHtml({ id: 'l', type: 'link', url: '<remote>', x: 0, y: 0, width: 200, height: 100 }, undefined, 'light')
  assert.match(link.html, /<b>链接<\/b><span>&lt;remote&gt;<\/span>/u)
  const group = boardNodePageHtml({ id: 'g', type: 'group', label: '<group>', color: '6', x: 2, y: 3, width: 400, height: 300 }, undefined, 'dark')
  assert.equal(group.background, 'transparent')
  assert.match(group.html, /\.group\{background:color-mix\(in srgb,var\(--c,#[a-f0-9]+\) 7%,transparent\)\}/u)
  assert.match(group.html, /<div class="label">&lt;group&gt;<\/div>/u)
})

test('shared edge paint preserves exact scene endpoints, curves, offsets, arrows, labels and preset colors', () => {
  const geometry = scene(parseBoard(BOARD).board)
  const edge = geometry.edges[0]
  assert.equal(edgePath(edge), 'M560 80C506 80 574 180 520 180')
  assert.equal(edgePath(edge, 16, 16), 'M576 96C522 96 590 196 536 196')
  assert.deepEqual(edge.mid, { x: 540, y: 130 })
  assert.deepEqual(EDGE_LABEL, { fontSize: 12, padding: '1px 6px', borderRadius: 4 })
  assert.deepEqual(['1', '2', '3', '4', '5', '6'].map(boardColor), ['#fb464c', '#e9973f', '#e0de71', '#44cf6e', '#53dfdd', '#a882ff'])
  assert.equal(boardColor(undefined), undefined)
  assert.equal(boardColor('#aBcDeF'), '#aBcDeF')
  for (const scheme of ['light', 'dark']) {
    const page = boardPageHtml(geometry, new Map(), scheme)
    const stroke = scheme === 'light' ? '#808080' : '#939393'
    assert.deepEqual([page.width, page.height], [872, 392])
    assert.ok(page.html.includes(`<path d="M576 96C522 96 590 196 536 196" fill="none" stroke="${stroke}" stroke-width="2" marker-end="url(#arrow-0)"/>`))
    assert.ok(page.html.includes('<marker id="arrow-0" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'))
    assert.ok(page.html.includes('<div class="edge-label" style="left:556px;top:146px">解释</div>'))
    assert.match(page.html, /\.edge-label\{[^}]*padding:1px 6px;border-radius:4px;[^}]*font-size:12px/u)
  }
})
