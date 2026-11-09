import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import test from 'node:test'
import { parseBoard } from '../src/shared/board.ts'
import { MAX_ATTEMPTS } from '../src/host/board-write.ts'
import { boardRoute } from '../src/host/route.ts'

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
  const route = boardRoute({ fs, sessionCwd: async id => ({ 'sess-1': '/work' })[id] })
  const post = async body => {
    const response = await route.fetch(new Request('http://127.0.0.1:3996/api/canvas/board', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { fs, route, post, text: () => fs.store.get(PATH).text, version: () => fs.store.get(PATH).version }
}

const nodeIds = text => parseBoard(text).board.nodes.map(node => node.id)
const nodeOf = (text, id) => parseBoard(text).board.nodes.find(node => node.id === id)

/** The agent's own edit of the board: one new node after `logo`, written the way DSH's edit tool does. */
function agentAddsNode(text) {
  return text.replace('"height":120}\n', '"height":120},\n\t\t{"id":"agent","type":"text","text":"agent 加的","x":0,"y":420,"width":200,"height":80}\n')
}

test('the board route is one exact owner route for POST', () => {
  const { route } = harness()
  assert.equal(route.path, '/api/canvas/board')
  assert.deepEqual(route.methods, ['POST'])
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
