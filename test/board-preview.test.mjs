import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../src/host/browser.ts'
import { scene } from '../src/shared/board.ts'
import { renderDiagram } from '../src/shared/diagram.ts'
import { boardNodePageHtml, edgePath } from '../src/shared/page.ts'

const location = locateBrowser(undefined, browserCandidates(process.platform, process.env, homedir()), existsSync)
const skip = location.kind === 'missing' && `no Chrome or Edge installed: ${location.reason}`
const ADDRESS = 'dsh-resource://file/session/board-session/boards/plan.canvas'
const ABSOLUTE = '/workspace/boards/plan.canvas'
const BOARD = {
  nodes: [
    { id: 'a', type: 'text', text: 'Original note', x: 80, y: 80, width: 220, height: 140, color: '4' },
    { id: 'b', type: 'text', text: 'Second note', x: 440, y: 90, width: 200, height: 140 },
    { id: 'flow', type: 'file', file: 'order.mmd', x: 100, y: 340, width: 300, height: 210 },
  ],
  edges: [{ id: 'ab', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', label: 'explains' }],
}
const SOURCE = JSON.stringify(BOARD)
const diagram = renderDiagram('stateDiagram-v2\n  [*] --> ready\n  ready: Ready\n  ready --> done\n  done: Done\n')
assert.equal(diagram.ok, true)
const DIAGRAM = { kind: 'svg', markup: diagram.svg, width: diagram.width, height: diagram.height }

/**
 * React 18 and the real tab entry point, with only the public DSH file/HTTP boundary replaced.
 * Writes use the production byte-preserving operation engine; render replies are already-safe
 * content, as on the host. A held reply models a completed write whose HTTP response is delayed:
 * a later agent write must win both while that response is pending and after it arrives.
 */
const harness = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { BoardTab } from './src/client/BoardTab.tsx'
import type { BoardTabProps } from './src/client/dsh.ts'
import { en } from './src/client/locales.ts'
import { parseBoard } from './src/shared/board.ts'
import { applyBoardOps } from './src/shared/board-ops.ts'
import { escapeHtml } from './src/shared/page.ts'

const address = ${JSON.stringify(ADDRESS)}
const absolutePath = ${JSON.stringify(ABSOLUTE)}
const watches = new Map()
const lifetime = new AbortController()
let version = 0
let holdNext = false
const t = (key, params) => (en[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params?.[name]))
window.posts = []
window.renders = []
window.reads = []
window.lossReads = 0
window.busyNext = false
window.source = ''
window.losses = []
window.prepared = {}
window.changeFile = source => {
  window.source = source
  version++
  for (const changed of [...(watches.get(address) ?? [])]) changed()
}
window.holdNextPost = () => { holdNext = true }
window.changeEmbed = content => {
  window.prepared.flow = content
  for (const [key, callbacks] of watches) if (key !== address) for (const changed of [...callbacks]) changed()
}
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://board.test/')
  if (url.pathname === '/api/canvas/board-render') {
    const body = JSON.parse(init.body)
    window.renders.push(body)
    const parsed = parseBoard(body.source)
    if (!parsed.ok) return Response.json({ error: 'invalid-source', message: 'Invalid board source', diagnostics: parsed.diagnostics }, { status: 409 })
    const contents = parsed.board.nodes.flatMap(node => node.type === 'text'
      ? [[node.id, { kind: 'html', html: '<p>' + escapeHtml(node.text) + '</p>' }]]
      : node.type === 'file' ? [[node.id, window.prepared[node.id] ?? { kind: 'card', title: node.file, detail: 'Missing embed' }]] : [])
    return Response.json({ contents, diagnostics: [] })
  }
  if (url.pathname !== '/api/canvas/board') throw new Error('Unexpected fetch: ' + url)
  if (init?.method !== 'POST') {
    window.lossReads++
    const parsed = parseBoard(window.source)
    return parsed.ok ? Response.json({ lost: window.losses })
      : Response.json({ error: 'invalid-source', message: 'Invalid board source', diagnostics: parsed.diagnostics }, { status: 409 })
  }
  const body = JSON.parse(init.body)
  window.posts.push(body)
  if (body.decline) {
    if (window.rejectDecline) return Response.json({ error: 'internal', message: 'Decline failed' }, { status: 500 })
    window.losses = window.losses.filter(batch => !body.decline.includes(batch.id))
    return Response.json({ declined: body.decline })
  }
  if (window.busyNext) {
    window.busyNext = false
    return Response.json({ error: 'busy', message: 'busy: another writer changed the board' }, { status: 503, headers: { 'retry-after': '1' } })
  }
  const result = applyBoardOps(window.source, body.ops)
  if (!result.ok) return Response.json({ error: 'invalid-source', message: 'Invalid board source', diagnostics: result.diagnostics }, { status: 409 })
  window.changeFile(result.text)
  const response = Response.json({ version: 'v' + version, statuses: result.statuses })
  if (!holdNext) return response
  holdNext = false
  return new Promise(resolve => {
    window.releasePost = () => { window.releasePost = undefined; resolve(response) }
  })
}
const props = {
  useTabInfo: () => ({ tab: { contentId: address, visible: true, signal: lifetime.signal } }),
  readFile: async (sessionId, path, signal) => {
    signal.throwIfAborted()
    window.reads.push({ sessionId, path })
    return { ok: true, value: { data: new TextEncoder().encode(window.source), absolutePath, version: 'v' + version } }
  },
  watchFile: (key, changed) => {
    const callbacks = watches.get(key) ?? new Set()
    callbacks.add(changed)
    watches.set(key, callbacks)
    return () => { callbacks.delete(changed); if (!callbacks.size) watches.delete(key) }
  },
  t,
} satisfies BoardTabProps
const root = createRoot(document.getElementById('root'))
window.mount = ({ source, losses, prepared }) => {
  window.source = source
  window.losses = losses
  window.prepared = prepared
  flushSync(() => root.render(createElement(BoardTab, props)))
}
`

const bundle = (await build({
  stdin: { contents: harness, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx', sourcefile: 'board-harness.tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2023', jsx: 'automatic', logLevel: 'warning',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
})).outputFiles[0].text

const node = (page, id) => page.locator(`.react-flow__node[data-id="${id}"]`)
const editor = page => page.locator('[data-canvas-board-editor]')
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function withBoard(work, { source = SOURCE, losses = [], clock = false } = {}) {
  const headless = new HeadlessBrowser()
  try {
    await headless.use(location.path, async browser => {
      const page = await browser.newPage({ viewport: { width: 1150, height: 900 } })
      page.setDefaultTimeout(5000)
      const errors = []
      page.on('pageerror', error => { errors.push(error.message) })
      if (clock) await page.clock.install()
      await page.setContent('<!doctype html><html style="color-scheme:light"><body style="margin:0"><div id="root" style="width:1050px;height:800px"></div></body></html>')
      await page.addScriptTag({ content: bundle })
      await page.evaluate(options => { window.mount(options) }, { source, losses, prepared: { flow: DIAGRAM } })
      await page.waitForSelector('[data-canvas-board][data-readonly="false"]')
      await page.frameLocator('.react-flow__node[data-id="flow"] iframe').locator('svg').waitFor()
      await frames(page)
      await work(page)
      assert.deepEqual(errors, [], 'no uncaught errors in the mounted tab')
    })
  } finally {
    await headless.dispose()
  }
}

/** Read only public rendered geometry, never React Flow state or a component's handlers. */
async function box(page, id) {
  return node(page, id).evaluate(element => {
    const style = getComputedStyle(element)
    const transform = new DOMMatrixReadOnly(style.transform)
    return { x: transform.e, y: transform.f, width: parseFloat(style.width), height: parseFloat(style.height) }
  })
}

async function waitBox(page, id, expected) {
  await page.waitForFunction(({ id, expected }) => {
    const element = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    if (!element) return false
    const style = getComputedStyle(element)
    const transform = new DOMMatrixReadOnly(style.transform)
    const actual = { x: transform.e, y: transform.f, width: parseFloat(style.width), height: parseFloat(style.height) }
    return Object.entries(expected).every(([key, value]) => Math.abs(actual[key] - value) < .1)
  }, { id, expected })
}

async function savedPost(page, count) {
  await page.waitForFunction(count => window.posts.length >= count, count)
  await page.waitForFunction(() => document.querySelector('[data-canvas-board-status]')?.textContent.includes('applied'))
  await frames(page)
  const posts = await page.evaluate(() => window.posts)
  assert.equal(posts.length, count, 'one HTTP batch per completed action')
  return posts[count - 1]
}

async function drag(page, target, dx, dy, observe = async () => {}) {
  const rect = await target.boundingBox()
  assert.ok(rect, 'the gesture target is visible')
  const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (const fraction of [.5, 1]) {
    await page.mouse.move(start.x + dx * fraction, start.y + dy * fraction, { steps: 5 })
    await frames(page)
    await observe()
  }
  await page.mouse.up()
}

/** Find genuinely empty visible canvas, not a node, label, toolbar or editor. */
async function emptyPoint(page) {
  return page.locator('.react-flow').evaluate(element => {
    const rect = element.getBoundingClientRect()
    const viewport = new DOMMatrixReadOnly(getComputedStyle(element.querySelector('.react-flow__viewport')).transform)
    for (let y = rect.bottom - 60; y > rect.top + 40; y -= 50) {
      for (let x = rect.right - 80; x > rect.left + 40; x -= 50) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) {
          return { x, y, flowX: Math.round((x - rect.left - viewport.e) / viewport.a), flowY: Math.round((y - rect.top - viewport.f) / viewport.d) }
        }
      }
    }
    throw new Error('No visible empty canvas point')
  })
}

async function connect(page, fromSide, toSide, label) {
  const from = await node(page, 'a').locator(`[data-handleid="${fromSide}"]`).boundingBox()
  const to = await node(page, 'b').locator(`[data-handleid="${toSide}"]`).boundingBox()
  assert.ok(from && to, 'both connection handles are visible')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
  await editor(page).locator('input').fill(label)
  await editor(page).locator('button[type="submit"]').click()
  await editor(page).waitFor({ state: 'detached' })
}

async function selectEdge(page, id) {
  const point = await page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).evaluate(path => {
    const point = path.getPointAtLength(path.getTotalLength() * .35)
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM())
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.click(point.x, point.y)
  await page.waitForSelector(`.react-flow__edge.selected[data-id="${id}"]`)
}

test('drag and resize write once on release, with rounded absolute boxes and no embed rerender', { skip }, async () => {
  await withBoard(async page => {
    const renders = await page.evaluate(() => window.renders.length)
    const originalPage = await node(page, 'flow').locator('iframe').getAttribute('srcdoc')
    let moved
    await drag(page, node(page, 'a'), 57.6, 33.4, async () => {
      assert.equal(await page.evaluate(() => window.posts.length), 0, 'drag frames never write')
      moved = await box(page, 'a')
    })
    assert.ok(moved.x > 100 && moved.y > 90, 'the pointer really moved the visible node')
    const placed = await savedPost(page, 1)
    assert.deepEqual(placed, { sessionId: 'board-session', path: 'boards/plan.canvas', ops: [{ op: 'place', id: 'a', x: Math.round(moved.x), y: Math.round(moved.y) }] })
    await waitBox(page, 'a', { x: placed.ops[0].x, y: placed.ops[0].y })

    await node(page, 'flow').click()
    const corner = node(page, 'flow').locator('.react-flow__resize-control.handle.bottom.right')
    await corner.waitFor({ state: 'visible' })
    let resized
    await drag(page, corner, 71.7, 42.3, async () => {
      assert.equal(await page.evaluate(() => window.posts.length), 1, 'resize frames never write')
      resized = await box(page, 'flow')
    })
    assert.ok(resized.width > 330 && resized.height > 230, 'the corner really resized the visible node')
    const placement = { op: 'place', id: 'flow', ...Object.fromEntries(Object.entries(resized).map(([key, value]) => [key, Math.round(value)])) }
    assert.deepEqual((await savedPost(page, 2)).ops, [placement])
    await waitBox(page, 'flow', { x: placement.x, y: placement.y, width: placement.width, height: placement.height })
    assert.equal(await page.evaluate(() => window.renders.length), renders, 'position and size alone do not rerender embedded files')
    assert.equal(await node(page, 'flow').locator('iframe').getAttribute('srcdoc'), originalPage, 'the shared node document is independent of board geometry')
    const inner = await page.frameLocator('.react-flow__node[data-id="flow"] iframe').locator('.node').evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    assert.deepEqual([inner.x, inner.y], [0, 0])
    assert.equal(inner.width, inner.viewportWidth)
    assert.equal(inner.height, inner.viewportHeight, 'the diagram fills its resized iframe rather than retaining its old dimensions')
  })
})

test('double-click creates a note; editing carries the original ifText; cancelling writes nothing', { skip }, async () => {
  await withBoard(async page => {
    assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID]), [false, 'undefined'])
    const point = await emptyPoint(page)
    await page.mouse.dblclick(point.x, point.y)
    await editor(page).locator('textarea').fill('New **note**')
    await editor(page).locator('button[type="submit"]').click()
    const created = (await savedPost(page, 1)).ops[0]
    assert.match(created.id, /^u-[0-9a-z]+-[0-9a-f]+$/)
    assert.deepEqual(created, { op: 'addNote', id: created.id, text: 'New **note**', x: point.flowX, y: point.flowY, width: 240, height: 160 })
    await editor(page).waitFor({ state: 'detached' })
    await node(page, created.id).waitFor()

    await node(page, 'a').dblclick()
    assert.equal(await editor(page).locator('textarea').inputValue(), 'Original note')
    await editor(page).locator('textarea').fill('Edited note')
    await editor(page).locator('button[type="submit"]').click()
    assert.deepEqual((await savedPost(page, 2)).ops, [{ op: 'setText', id: 'a', text: 'Edited note', ifText: 'Original note' }])
    await editor(page).waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="a"] iframe')?.srcdoc.includes('Edited note'))

    await node(page, 'a').dblclick()
    await editor(page).locator('textarea').fill('Discarded draft')
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await frames(page)
    assert.equal(await editor(page).count(), 0)
    assert.equal(await page.evaluate(() => window.posts.length), 2)
    assert.equal(await page.evaluate(() => JSON.parse(window.source).nodes.find(node => node.id === 'a').text), 'Edited note')

    await node(page, 'a').dblclick()
    await editor(page).locator('textarea').fill('My competing edit')
    await page.evaluate(() => {
      const next = JSON.parse(window.source)
      next.nodes.find(node => node.id === 'a').text = 'New agent text'
      window.changeFile(JSON.stringify(next))
    })
    await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="a"] iframe')?.srcdoc.includes('New agent text'))
    await editor(page).locator('button[type="submit"]').click()
    await page.waitForFunction(() => document.querySelector('[data-canvas-board-status]')?.textContent.includes('conflict'))
    assert.deepEqual(await page.evaluate(() => window.posts[2].ops), [{ op: 'setText', id: 'a', text: 'My competing edit', ifText: 'Edited note' }], 'ifText is captured when editing begins, not replaced by a later file read')
    assert.equal(await page.evaluate(() => JSON.parse(window.source).nodes.find(node => node.id === 'a').text), 'New agent text', 'a stale editor cannot overwrite the agent text')
    assert.equal(await editor(page).locator('textarea').inputValue(), 'My competing edit', 'conflict preserves the unsent draft')
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})

test('connecting asks for an optional label; edge and node deletion persist through the route', { skip }, async () => {
  await withBoard(async page => {
    await connect(page, 'bottom', 'bottom', 'depends on')
    const labeled = (await savedPost(page, 1)).ops[0]
    assert.deepEqual(labeled, { op: 'addEdge', id: labeled.id, fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'bottom', label: 'depends on' })
    await page.waitForSelector(`.react-flow__edge[data-id="${labeled.id}"]`)
    assert.equal(await page.locator(`[data-canvas-edge-label="${labeled.id}"]`).textContent(), 'depends on')

    await connect(page, 'top', 'top', '')
    const plain = (await savedPost(page, 2)).ops[0]
    assert.deepEqual(plain, { op: 'addEdge', id: plain.id, fromNode: 'a', toNode: 'b', fromSide: 'top', toSide: 'top' })
    const blank = await emptyPoint(page)
    await page.mouse.click(blank.x, blank.y)
    await selectEdge(page, plain.id)
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    assert.deepEqual((await savedPost(page, 3)).ops, [{ op: 'removeEdge', id: plain.id }])
    await page.locator(`.react-flow__edge[data-id="${plain.id}"]`).waitFor({ state: 'detached' })
    assert.equal(await node(page, 'a').count(), 1, 'deleting an edge leaves both nodes')
    assert.equal(await node(page, 'b').count(), 1)

    await node(page, 'a').click()
    await page.keyboard.press('Delete')
    assert.deepEqual((await savedPost(page, 4)).ops, [{ op: 'removeNodes', ids: ['a'] }], 'incident edges need no redundant removeEdge operations')
    await node(page, 'a').waitFor({ state: 'detached' })
    const persisted = await page.evaluate(() => JSON.parse(window.source))
    assert.deepEqual(persisted.nodes.map(node => node.id), ['b', 'flow'])
    assert.deepEqual(persisted.edges, [])
    assert.equal(await page.locator('.react-flow__edge').count(), 0)
  })
})

test('an authoritative file update replaces local geometry even while a write response is pending', { skip }, async () => {
  await withBoard(async page => {
    await page.evaluate(() => { window.holdNextPost() })
    await drag(page, node(page, 'a'), 63, 37)
    await page.waitForFunction(() => typeof window.releasePost === 'function')
    assert.equal(await page.evaluate(() => window.posts.length), 1)
    assert.ok((await box(page, 'a')).x > 100, 'there was a visible local move to replace')

    const agent = { ...BOARD, nodes: BOARD.nodes.map(node => node.id === 'a' ? { ...node, x: 20, y: 250, width: 260, text: 'Agent revision' } : node) }
    await page.evaluate(source => { window.changeFile(source) }, JSON.stringify(agent))
    await waitBox(page, 'a', { x: 20, y: 250, width: 260 })
    await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="a"] iframe')?.srcdoc.includes('Agent revision'))
    await frames(page)
    assert.equal(await page.evaluate(() => window.posts.length), 1, 'the pending operation is not automatically replayed over new source')
    await page.evaluate(() => { window.releasePost() })
    await savedPost(page, 1)
    await waitBox(page, 'a', { x: 20, y: 250, width: 260 })
    assert.equal(await page.evaluate(() => JSON.parse(window.source).nodes.find(node => node.id === 'a').text), 'Agent revision')

    await page.evaluate(source => { window.changeFile(source) }, SOURCE)
    await waitBox(page, 'a', { x: 80, y: 80, width: 220 })
    await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="a"] iframe')?.srcdoc.includes('Original note'))
    assert.equal(await page.evaluate(() => window.posts.length), 1, 'ordinary later file reads also replace rather than rebase')
  })
})

test('invalid source disables mutation, and repairing the file restores both content and editing', { skip }, async () => {
  await withBoard(async page => {
    await page.evaluate(() => { window.changeFile('{\n "nodes": [ }') })
    await page.waitForSelector('[data-canvas-board][data-readonly="true"]')
    assert.match(await page.locator('[data-canvas-board]').textContent(), /Read-only board/)
    assert.match(await page.locator('[data-canvas-board]').textContent(), /2:\d+/)
    await page.locator('[data-canvas-board]').dblclick({ position: { x: 400, y: 350 } })
    await page.keyboard.press('Delete')
    await frames(page)
    assert.equal(await editor(page).count(), 0)
    assert.equal(await page.evaluate(() => window.posts.length), 0, 'invalid file bytes never reach a mutation request')

    await page.evaluate(source => { window.changeFile(source) }, SOURCE)
    await page.waitForSelector('[data-canvas-board][data-readonly="false"]')
    await page.frameLocator('.react-flow__node[data-id="flow"] iframe').locator('svg').waitFor()
    await frames(page)
    await drag(page, node(page, 'a'), 45, 25)
    const repaired = (await savedPost(page, 1)).ops[0]
    assert.equal(repaired.op, 'place')
    assert.equal(repaired.id, 'a')
    assert.ok(repaired.x > 80 && repaired.y > 80, 'the repaired board accepts a real gesture')
  })
})

test('busy retains the exact batch for an explicit retry, never a timer or file-change replay', { skip }, async () => {
  await withBoard(async page => {
    await page.evaluate(() => { window.busyNext = true })
    await drag(page, node(page, 'a'), 50, 30)
    const retry = page.getByRole('button', { name: 'Retry this batch', exact: true })
    await retry.waitFor()
    assert.match(await page.getByRole('alert').textContent(), /busy/)
    assert.equal(await page.evaluate(() => window.source), SOURCE, 'the rejected batch did not modify source')
    await waitBox(page, 'a', { x: 80, y: 80 })
    await page.evaluate(() => { window.changeFile(window.source) })
    await page.clock.fastForward(10_000)
    await frames(page)
    assert.equal(await page.evaluate(() => window.posts.length), 1, 'neither retry-after nor resource notifications resubmit')
    await retry.click()
    const retried = await savedPost(page, 2)
    assert.deepEqual(retried, await page.evaluate(() => window.posts[0]), 'retry preserves ids and every operation field')
    assert.equal(await retry.count(), 0)
    await waitBox(page, 'a', { x: retried.ops[0].x, y: retried.ops[0].y })
  }, { clock: true })
})

test('lost batches require explicit reapply or host-confirmed decline', { skip }, async () => {
  const losses = [
    { id: 'lost-move', at: '2026-01-01T00:00:00Z', count: 1, ops: [{ op: 'place', id: 'a', x: 25, y: 45 }] },
    { id: 'lost-delete', at: '2026-01-01T00:00:01Z', count: 1, ops: [{ op: 'removeNodes', ids: ['b'] }] },
  ]
  await withBoard(async page => {
    const move = page.locator('[data-canvas-lost="lost-move"]')
    const removal = page.locator('[data-canvas-lost="lost-delete"]')
    await move.waitFor()
    await removal.waitFor()
    assert.match(await move.textContent(), /Move “Original note” to \(25, 45\)/)
    assert.match(await removal.textContent(), /Second note/)
    assert.doesNotMatch(await move.textContent(), /"op"|"x":/)
    assert.doesNotMatch(await removal.textContent(), /removeNodes/)
    assert.equal(await page.evaluate(() => window.posts.length), 0, 'discovering retained intent does not apply it')
    await removal.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await removal.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.posts[0]), { sessionId: 'board-session', path: 'boards/plan.canvas', decline: ['lost-delete'] })
    assert.deepEqual(await page.evaluate(() => window.losses.map(batch => batch.id)), ['lost-move'])
    const reads = await page.evaluate(() => window.lossReads)
    await page.evaluate(() => { window.changeFile(window.source) })
    await page.waitForFunction(reads => window.lossReads > reads, reads)
    await frames(page)
    assert.equal(await removal.count(), 0, 'declined intent stays absent after a source reread')
    assert.equal(await move.count(), 1, 'declining one batch does not hide another')
    assert.equal(await page.evaluate(() => window.posts.length), 1)
    assert.equal(await node(page, 'b').count(), 1, 'decline has no filesystem effect')

    await move.getByRole('button', { name: 'Reapply', exact: true }).click()
    assert.deepEqual((await savedPost(page, 2)).ops, losses[0].ops)
    await waitBox(page, 'a', { x: 25, y: 45 })
    assert.equal(await node(page, 'b').count(), 1)
  }, { losses })
})

test('a failed decline keeps the recovery choice visible for an explicit retry', { skip }, async () => {
  const losses = [{ id: 'lost-delete', at: '2026-01-01T00:00:00Z', count: 1, ops: [{ op: 'removeNodes', ids: ['b'] }] }]
  await withBoard(async page => {
    const removal = page.locator('[data-canvas-lost="lost-delete"]')
    await removal.waitFor()
    await page.evaluate(() => { window.rejectDecline = true })
    await removal.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Decline failed' }).waitFor()
    assert.equal(await removal.count(), 1)
    assert.deepEqual(await page.evaluate(() => window.losses.map(batch => batch.id)), ['lost-delete'])
    await page.evaluate(() => { window.rejectDecline = false })
    await removal.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await removal.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.posts.length), 2)
  }, { losses })
})

test('mounted diagram pages are sandboxed and share exact node, edge, label and arrow geometry', { skip }, async () => {
  await withBoard(async page => {
    const iframe = node(page, 'flow').locator('iframe')
    assert.equal(await iframe.getAttribute('sandbox'), '')
    assert.equal(await iframe.evaluate(element => getComputedStyle(element).pointerEvents), 'none')
    assert.equal(await iframe.getAttribute('srcdoc'), boardNodePageHtml(BOARD.nodes[2], DIAGRAM, 'light').html)
    assert.equal(await page.frameLocator('.react-flow__node[data-id="flow"] iframe').locator('script').count(), 0)
    assert.match(await page.frameLocator('.react-flow__node[data-id="flow"] iframe').locator('svg').textContent(), /Ready/)
    const requests = await page.evaluate(() => ({ reads: window.reads, render: window.renders[0] }))
    assert.ok(requests.reads.every(read => read.sessionId === 'board-session' && read.path === 'boards/plan.canvas'))
    assert.deepEqual(requests.render, { path: ABSOLUTE, source: SOURCE }, 'host rendering receives canonical source path and the exact read bytes')

    const geometry = scene(BOARD).edges[0]
    const path = page.locator('.react-flow__edge[data-id="ab"] .react-flow__edge-path')
    assert.equal(await path.getAttribute('d'), edgePath(geometry), 'the interactive line uses the static painter path')
    const endpoints = await path.evaluate(element => {
      const from = element.getPointAtLength(0)
      const to = element.getPointAtLength(element.getTotalLength())
      return [from.x, from.y, to.x, to.y]
    })
    assert.deepEqual(endpoints, [300, 150, 440, 160], 'right and left sides land on the persisted node boundaries')
    assert.equal(await path.getAttribute('marker-start'), null)
    assert.match(await path.getAttribute('marker-end'), /url\(#.+\)/)
    const label = await page.locator('[data-canvas-edge-label="ab"]').evaluate(element => {
      const rect = element.getBoundingClientRect()
      const flow = document.querySelector('.react-flow').getBoundingClientRect()
      const viewport = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
      const point = new DOMPoint(rect.x + rect.width / 2 - flow.x, rect.y + rect.height / 2 - flow.y).matrixTransform(viewport.inverse())
      const style = getComputedStyle(element)
      return { x: point.x, y: point.y, size: style.fontSize, padding: style.padding, radius: style.borderRadius }
    })
    assert.ok(Math.abs(label.x - geometry.mid.x) < .1 && Math.abs(label.y - geometry.mid.y) < .1, 'the label is centered on the shared curve midpoint')
    assert.deepEqual([label.size, label.padding, label.radius], ['12px', '1px 6px', '4px'])

    await page.evaluate(() => { window.changeEmbed({ kind: 'card', title: 'order.mmd', detail: 'Embedded file changed' }) })
    await page.frameLocator('.react-flow__node[data-id="flow"] iframe').getByText('Embedded file changed', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.posts.length), 0, 'an embed watch refreshes content without mutating the board')
  })
})
