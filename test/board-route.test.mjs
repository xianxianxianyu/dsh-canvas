import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import test from 'node:test'
import { parseBoard } from '../src/shared/board.ts'
import { MAX_ATTEMPTS } from '../src/host/board-write.ts'
import { boardRoute } from '../src/host/route.ts'
import { BoardJournal, BOARD_JOURNAL_LIMIT } from '../src/host/board-journal.ts'
import { canvasCheckTool } from '../src/host/check.ts'
import { CommentStore } from '../src/host/comments.ts'
import { tmpdir } from 'node:os'

const BOARD = readFileSync(new URL('fixtures/plan.canvas', import.meta.url), 'utf8')
const PATH = '/work/plan.canvas'

/**
 * An in-memory Session filesystem with DSH's write semantics: every write gets a new version, and
 * `writeText(..., { kind: 'replaceIfVersion', version })` throws FS_STALE_VERSION when the file
 * moved on (fs-local's guard). `afterRead(path)` runs after a read has captured its text and
 * before the reader gets it back, which is where another writer can slip in.
 */
function memoryFs(files) {
  let counter = 0
  const store = new Map(Object.entries(files).map(([path, text]) => [path, { text, version: `v${++counter}` }]))
  const log = []
  const fs = {
    store,
    log,
    afterRead: undefined,
    /** Another writer (the agent's edit) replacing the file. */
    put(path, text) { store.set(path, { text, version: `v${++counter}` }) },
    async resolve(path, options) { return { displayPath: posix.resolve(options?.cwd ?? '/', path) } },
    processPath(target) { return target.displayPath },
    async stat(target) {
      log.push('stat')
      const file = store.get(target.displayPath)
      return file && { type: 'file', version: file.version, size: file.text.length }
    },
    async readText(target) {
      log.push('read')
      const file = store.get(target.displayPath)
      if (!file) throw Object.assign(new Error(`cannot read "${target.displayPath}": not found`), { code: 'FS_NOT_FOUND' })
      await fs.afterRead?.(target.displayPath)
      return file.text
    },
    async writeText(target, text, intent) {
      log.push('write')
      const file = store.get(target.displayPath)
      if (intent?.kind === 'replaceIfVersion' && file?.version !== intent.version) {
        throw Object.assign(new Error(`cannot write "${target.displayPath}": file changed since it was read`), { code: 'FS_STALE_VERSION' })
      }
      store.set(target.displayPath, { text, version: `v${++counter}` })
      return { operation: file ? 'update' : 'create', version: `v${counter}`, before: file?.text ?? null, after: text }
    },
  }
  return fs
}

function harness(files = { [PATH]: BOARD }) {
  const fs = memoryFs(files)
  const journal = new BoardJournal()
  const route = boardRoute({ fs, sessionCwd: async id => ({ 'sess-1': '/work' })[id], journal })
  const post = async body => {
    const response = await route.fetch(new Request('http://127.0.0.1:3996/api/canvas/board', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  const get = async () => {
    const response = await route.fetch(new Request(`http://127.0.0.1:3996/api/canvas/board?${new URLSearchParams({ path: PATH })}`))
    return { status: response.status, body: await response.json() }
  }
  const check = canvasCheckTool({
    fs, journal, workingDirectory: { ensure: async () => '/work' },
    attachments: () => undefined, llm: () => undefined,
    browser: () => ({ kind: 'missing', reason: 'not needed' }), headless: { use: () => assert.fail('image:false') },
    store: new CommentStore(posix.join(tmpdir(), 'dsh-canvas-no-such-root')),
  })
  return { fs, route, post, get, text: () => fs.store.get(PATH).text, version: () => fs.store.get(PATH).version,
    check: () => check.execute({ path: PATH, image: false }, { signal: new AbortController().signal }) }
}

const nodeIds = text => parseBoard(text).board.nodes.map(node => node.id)
const nodeOf = (text, id) => parseBoard(text).board.nodes.find(node => node.id === id)

/** The agent's own edit of the board: one new node after `logo`, written the way DSH's edit tool does. */
function agentAddsNode(text) {
  return text.replace('"height":120}\n', '"height":120},\n\t\t{"id":"agent","type":"text","text":"agent 加的","x":0,"y":420,"width":200,"height":80}\n')
}

test('the board route is one exact owner route for GET and POST', () => {
  const { route } = harness()
  assert.equal(route.path, '/api/canvas/board')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('ops are applied with a version check and answered op by op', async () => {
  const { post, fs, text, version } = harness()
  const before = version()
  const result = await post({ sessionId: 'sess-1', path: 'plan.canvas', ops: [
    { op: 'place', id: 'why', x: 600, y: 40 },
    { op: 'place', id: 'gone', x: 0, y: 0 },
    { op: 'setText', id: 'why', text: '新的', ifText: '别人改过的' },
  ] })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { version: version(), statuses: ['applied', 'missing', 'conflict'] })
  assert.notEqual(version(), before)
  assert.deepEqual([nodeOf(text(), 'why').x, nodeOf(text(), 'why').y], [600, 40])
  assert.deepEqual(fs.log, ['stat', 'read', 'write'])

  // The same request again changes nothing and writes nothing.
  fs.log.length = 0
  const again = await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 600, y: 40 }] })
  assert.deepEqual(again, { status: 200, body: { version: version(), statuses: ['unchanged'] } })
  assert.deepEqual(fs.log, ['stat', 'read'])
})

test('an agent write between the route\'s read and its write is kept, and the op is replayed on top of it', async () => {
  const { post, fs, text } = harness()
  let raced = false
  fs.afterRead = path => {
    if (raced) return
    raced = true
    fs.put(path, agentAddsNode(fs.store.get(path).text))
  }
  const result = await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 600, y: 40 }, { op: 'addNote', id: 'n-1', text: '用户的便签', x: 300, y: 420, width: 200, height: 80 }] })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.statuses, ['applied', 'applied'])
  assert.deepEqual(nodeIds(text()), ['flow', 'why', 'logo', 'agent', 'n-1'], 'the agent\'s node and the user\'s note are both there')
  assert.deepEqual([nodeOf(text(), 'why').x, nodeOf(text(), 'why').y], [600, 40], 'the user\'s move is there')
  assert.deepEqual(fs.log, ['stat', 'read', 'write', 'stat', 'read', 'write'], 'the first write was refused as stale, the second round wrote')
})

test('when every round loses the race the route gives up as busy and writes nothing of its own', async () => {
  const { post, fs, text } = harness()
  let edits = 0
  fs.afterRead = path => {
    edits++
    fs.put(path, fs.store.get(path).text.replace(/("id":"logo".*?"y":)\d+/u, `$1${200 + edits}`))
  }
  const result = await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 600, y: 40 }] })
  assert.equal(result.status, 503)
  assert.equal(result.body.error, 'busy')
  assert.equal(edits, MAX_ATTEMPTS)
  assert.deepEqual([nodeOf(text(), 'why').x, nodeOf(text(), 'logo').y], [560, 200 + MAX_ATTEMPTS], 'only the other writer\'s changes are in the file')
})

test('a file that is not a valid board is refused with its diagnostics and left alone', async () => {
  const broken = BOARD.replace('"height":360},', '"height":360}')
  const { post, fs, text, version } = harness({ [PATH]: broken })
  const before = version()
  const result = await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 600, y: 40 }] })
  assert.equal(result.status, 409)
  assert.equal(result.body.error, 'invalid-source')
  assert.match(result.body.message, /不是合法的画板/u)
  assert.deepEqual(result.body.diagnostics.map(d => [d.line, d.column, d.message]), [[4, 3, 'JSON 语法错误：这里应该是 , 或 ]']])
  assert.equal(text(), broken)
  assert.equal(version(), before)
  assert.equal(fs.log.includes('write'), false)
})

test('requests are checked before anything is read', async () => {
  const { post, fs } = harness()
  const bad = async (body, status, error, message) => {
    const result = await post(body)
    assert.equal(result.status, status, JSON.stringify(result.body))
    assert.equal(result.body.error, error)
    if (message) assert.match(result.body.message, message)
  }
  await bad('{', 400, 'bad-request', /不是 JSON/u)
  await bad({ path: PATH, ops: [] }, 400, 'bad-request')
  await bad({ path: PATH, ops: [{ op: 'place', id: 'why', x: 1.5, y: 0 }] }, 400, 'bad-request')
  await bad({ path: PATH, ops: [{ op: 'place', id: 'why', x: 1, y: 0, width: 0 }] }, 400, 'bad-request')
  await bad({ path: PATH, ops: [{ op: 'teleport', id: 'why' }] }, 400, 'bad-request')
  await bad({ path: PATH, ops: [{ op: 'removeNodes', ids: [] }] }, 400, 'bad-request')
  await bad({ path: PATH, extra: 1, ops: [{ op: 'removeEdge', id: 'e1' }] }, 400, 'bad-request')
  await bad({ path: '/work/order.mmd', ops: [{ op: 'removeEdge', id: 'e1' }] }, 400, 'bad-request', /只能改 \.canvas 画板/u)
  await bad({ path: 'plan.canvas', ops: [{ op: 'removeEdge', id: 'e1' }] }, 400, 'bad-request', /必须是绝对路径/u)
  assert.deepEqual(fs.log, [])
  await bad({ sessionId: 'nobody', path: 'plan.canvas', ops: [{ op: 'removeEdge', id: 'e1' }] }, 404, 'not-found', /找不到会话 nobody/u)
  await bad({ path: '/work/gone.canvas', ops: [{ op: 'removeEdge', id: 'e1' }] }, 404, 'not-found', /找不到文件/u)
})

test('a blind agent overwrite is exposed as a recoverable lost user batch, then replay clears it', async () => {
  const { post, get, fs, text } = harness()
  const ops = [{ op: 'place', id: 'why', x: 600, y: 40 }]
  await post({ path: PATH, ops })
  assert.deepEqual((await get()).body, { lost: [] })
  fs.put(PATH, BOARD)
  const lost = await get()
  assert.equal(lost.status, 200)
  assert.equal(lost.body.lost.length, 1)
  assert.deepEqual(lost.body.lost[0].ops, ops)
  assert.equal(lost.body.lost[0].count, 1)
  assert.ok(lost.body.lost[0].id)
  assert.ok(!Number.isNaN(Date.parse(lost.body.lost[0].at)))
  await post({ path: PATH, ops: lost.body.lost[0].ops })
  assert.deepEqual((await get()).body, { lost: [] })
  assert.equal(nodeOf(text(), 'why').x, 600)
})

test('declining selected lost batches retires them from GET and canvas_check without changing the file', async () => {
  const before = '{"nodes":[{"id":"why","type":"text","text":"Reason","x":0,"y":0,"width":280,"height":140},{"id":"flow","type":"text","text":"Flow","x":300,"y":0,"width":280,"height":140}],"edges":[]}'
  const { post, get, check, fs, text, version } = harness({ [PATH]: before })
  await post({ path: PATH, ops: [{ op: 'removeNodes', ids: ['flow'] }] })
  await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 80, y: 40 }] })
  fs.put(PATH, before)
  const [deletion, movement] = (await get()).body.lost
  assert.match((await check()).text, /removeNodes/)
  assert.match((await check()).text, /"x":80/)
  const unchangedVersion = version()
  const decline = { sessionId: 'sess-1', path: 'plan.canvas', decline: [deletion.id] }
  assert.deepEqual(await post(decline), { status: 200, body: { declined: [deletion.id] } })
  assert.deepEqual((await get()).body.lost, [movement], 'other retained intent remains recoverable')
  const report = (await check()).text
  assert.doesNotMatch(report, /removeNodes/)
  assert.match(report, /"x":80/)
  assert.equal(text(), before, 'accepting the overwrite is not a file edit')
  assert.equal(version(), unchangedVersion)
  assert.deepEqual(await post(decline), { status: 200, body: { declined: [deletion.id] } }, 'retry by batch id is idempotent')
  await post({ path: PATH, decline: [movement.id, 'already-absent'] })
  assert.deepEqual((await get()).body, { lost: [] })
  assert.doesNotMatch((await check()).text, /改动被覆盖/)
  fs.put(PATH, before)
  assert.deepEqual((await get()).body, { lost: [] }, 'another read/overwrite cannot resurrect declined intent')
})

test('decline validates batch ids and is scoped to the canonical board path', async () => {
  const { post, get, fs } = harness()
  await post({ path: PATH, ops: [{ op: 'removeNodes', ids: ['flow'] }] })
  fs.put(PATH, BOARD)
  const [batch] = (await get()).body.lost
  for (const decline of [[], [''], [1], Array(201).fill('batch'), 'batch']) {
    assert.equal((await post({ path: PATH, decline })).status, 400)
  }
  assert.equal((await post({ path: PATH, decline: [batch.id], ops: [{ op: 'removeEdge', id: 'e1' }] })).status, 400)
  assert.equal((await post({ path: '/work/order.mmd', decline: [batch.id] })).status, 400)
  assert.equal((await post({ path: 'plan.canvas', decline: [batch.id] })).status, 400)
  assert.deepEqual(await post({ path: '/work/other.canvas', decline: [batch.id] }), { status: 200, body: { declined: [batch.id] } })
  assert.deepEqual((await get()).body.lost, [batch])
})

test('new user moves supersede older positions without losing an earlier resize intent', async () => {
  const { post, get, fs, text } = harness()
  await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 600, y: 40, width: 320 }] })
  await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 700, y: 50 }] })
  assert.deepEqual((await get()).body, { lost: [] }, 'the user moving again is not a lost update')
  fs.put(PATH, text().replace('"width":320', '"width":280'))
  const [batch] = (await get()).body.lost
  assert.deepEqual(batch.ops, [{ op: 'place', id: 'why', width: 320 }])
})

test('user deletion and recreation retire old add, edge, geometry and deletion intents', async () => {
  const { post, get } = harness()
  const note = { op: 'addNote', id: 'n', text: 'note', x: 0, y: 400, width: 100, height: 100 }
  await post({ path: PATH, ops: [note, { op: 'addEdge', id: 'n-edge', fromNode: 'n', toNode: 'why' }] })
  await post({ path: PATH, ops: [{ op: 'place', id: 'n', x: 20, y: 400 }] })
  await post({ path: PATH, ops: [{ op: 'removeNodes', ids: ['n'] }] })
  assert.deepEqual((await get()).body, { lost: [] })
  await post({ path: PATH, ops: [note] })
  assert.deepEqual((await get()).body, { lost: [] }, 'intentional recreation must not suggest deleting it again')
})

test('conflicting text and refused or unchanged route ops do not create loss reports', async () => {
  const { post, get, fs, text } = harness()
  const old = nodeOf(text(), 'why').text
  await post({ path: PATH, ops: [{ op: 'setText', id: 'why', ifText: old, text: 'user text' }] })
  fs.put(PATH, text().replace('"text":"user text"', '"text":"third text"'))
  assert.deepEqual((await get()).body, { lost: [] }, 'a third text is a conflict, not replayable loss')
  await post({ path: PATH, ops: [{ op: 'setText', id: 'why', ifText: old, text: 'refused' }, { op: 'place', id: 'gone', x: 0, y: 0 }] })
  assert.deepEqual((await get()).body, { lost: [] })
})

test('canvas_check warns about a lost route placement, with replay ops, but still validates the board', async () => {
  const before = '{\n"nodes":[\n{"id":"why","type":"text","text":"before","x":0,"y":0,"width":280,"height":140}\n],\n"edges":[]\n}'
  const { post, check, fs } = harness({ [PATH]: before })
  await post({ path: PATH, ops: [{ op: 'place', id: 'why', x: 80, y: 40 }] })
  assert.doesNotMatch((await check()).text, /改动被覆盖/u)
  fs.put(PATH, before.replace('"before"', '"after"'))
  const report = (await check()).text
  assert.match(report, /校验通过.*1 个警告/u)
  assert.match(report, /用户在 \d\d:\d\d 的 1 个改动被覆盖.*用 edit 恢复或说明原因/u)
  assert.ok(report.includes('"x":80,"y":40'))
})

test('journal retains at most the last bounded applied batches, not replays', async () => {
  const { post, get, fs } = harness()
  for (let index = 0; index <= BOARD_JOURNAL_LIMIT; index++) {
    const body = { path: PATH, ops: [{ op: 'addNote', id: `n${index}`, text: 'note', x: 0, y: 400 + index * 100, width: 100, height: 80 }] }
    await post(body)
    await post(body)
  }
  fs.put(PATH, BOARD)
  const { lost } = (await get()).body
  assert.equal(lost.length, BOARD_JOURNAL_LIMIT)
  assert.equal(lost[0].ops[0].id, 'n1')
})

test('F6: non-finite JSON numbers are located errors through parser, route and check', async () => {
  for (const token of ['1e999', '-1e999', 'Infinity', 'NaN']) {
    const source = `{\n"nodes":[{"id":"a","type":"text","text":"A","x":${token},"y":0,"width":100,"height":100}]}`
    const parsed = parseBoard(source)
    assert.equal(parsed.ok, false, token)
    assert.equal(parsed.diagnostics[0].line, 2)
    assert.equal(parsed.diagnostics[0].column, 49)
    const h = harness({ [PATH]: source })
    assert.equal((await h.get()).status, 409)
    assert.equal((await h.post({ path: PATH, ops: [{ op: 'place', id: 'a', x: 1, y: 2 }] })).status, 409)
    assert.equal(h.text(), source)
    await assert.rejects(h.check(), /2:49/)
  }
})

test('F10: nesting beyond 128 containers is a located refusal, never a stack overflow', async () => {
  assert.equal(parseBoard('{"meta":' + '['.repeat(127) + '0' + ']'.repeat(127) + '}').ok, true)
  for (const depth of [128, 5000]) {
    const source = '{\n"meta":' + '['.repeat(depth) + '0' + ']'.repeat(depth) + '}'
    const parsed = parseBoard(source)
    assert.equal(parsed.ok, false)
    assert.match(parsed.diagnostics[0].message, /128/)
    assert.equal(parsed.diagnostics[0].line, 2)
    assert.equal(parsed.diagnostics[0].column, 135)
    const h = harness({ [PATH]: source })
    assert.equal((await h.get()).status, 409)
    assert.equal((await h.post({ path: PATH, ops: [{ op: 'place', id: 'a', x: 1, y: 2 }] })).status, 409)
    assert.equal(h.text(), source)
    await assert.rejects(h.check(), /2:135/)
  }
})

test('F12: a drag retains resize fields under their original batch and replays only those fields', async () => {
  const before = '{"nodes":[{"id":"a","type":"text","text":"A","x":0,"y":0,"width":100,"height":100}]}'
  const h = harness({ [PATH]: before })
  await h.post({ path: PATH, ops: [{ op: 'place', id: 'a', x: 0, y: 0, width: 300, height: 50 }] })
  h.fs.put(PATH, h.text().replace('"width":300', '"width":500'))
  const [resize] = (await h.get()).body.lost
  await h.post({ path: PATH, ops: [{ op: 'place', id: 'a', x: 40, y: 40 }] })
  const [retained] = (await h.get()).body.lost
  assert.equal(retained.id, resize.id)
  assert.equal(retained.at, resize.at)
  assert.deepEqual(retained.ops, [{ op: 'place', id: 'a', width: 300, height: 50 }])
  h.fs.put(PATH, h.text().replace('"x":40,"y":40', '"x":60,"y":60'))
  assert.equal((await h.post({ path: PATH, ops: retained.ops })).status, 200)
  assert.deepEqual(nodeOf(h.text(), 'a'), { id: 'a', type: 'text', text: 'A', x: 60, y: 60, width: 300, height: 50 })
  assert.equal((await h.post({ path: PATH, ops: [{ op: 'place', id: 'a' }] })).status, 400, 'empty placement is not an intent')
  assert.equal((await h.post({ path: PATH, ops: [{ op: 'place', id: 'a', x: 80 }] })).status, 200)
  assert.equal(nodeOf(h.text(), 'a').y, 60, 'single-field recovery never invents the other coordinate')
})
