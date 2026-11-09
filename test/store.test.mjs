import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'
import { canvasCommentTool } from '../src/host/comment-tool.ts'
import { CommentStore } from '../src/host/comments.ts'
import { commentsRoute } from '../src/host/route.ts'

const signal = new AbortController().signal
const anchor = { target: 's3', label: '支付失败' }
const ARTIFACT = '/work/order.mmd'

/** One plugin's worth of comment wiring over a temporary root, with a fake Session filesystem. */
async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-canvas-comments-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fs = {
    async resolve(path, options) { return { displayPath: posix.resolve(options?.cwd ?? '/', path) } },
    processPath(target) { return target.displayPath },
  }
  const store = new CommentStore(root)
  const route = commentsRoute({ store, fs, sessionCwd: async id => ({ 'sess-1': '/work' })[id] })
  const tool = canvasCommentTool({ fs, workingDirectory: { ensure: async () => '/work' }, store })
  const post = async body => {
    const response = await route.fetch(new Request('http://127.0.0.1:3996/api/canvas/comments', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  const get = async query => {
    const response = await route.fetch(new Request(`http://127.0.0.1:3996/api/canvas/comments?${new URLSearchParams(query)}`))
    return { status: response.status, body: await response.json() }
  }
  const call = (args, callId) => tool.execute(args, {
    signal, callId, agent: { session: { header: { id: 'sess-1' }, snapshotEvents: () => [{ type: 'tool/call', seq: 1, data: { callId, name: 'canvas_comment' } }] }, options: {} },
  })
  return { root, store, route, tool, post, get, call }
}

test('the route is one exact owner route for GET and POST', async t => {
  const { route } = await harness(t)
  assert.equal(route.path, '/api/canvas/comments')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('comments live in <root>/comments/<sha256(path)>.jsonl behind a header line', async t => {
  const { root, post } = await harness(t)
  const created = await post({ sessionId: 'sess-1', path: 'order.mmd', ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })
  assert.equal(created.status, 200)
  assert.equal(created.body.comments.length, 1)
  const file = join(root, 'comments', `${createHash('sha256').update(ARTIFACT).digest('hex')}.jsonl`)
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines[0], { artifact: ARTIFACT })
  assert.deepEqual({ ...lines[1], at: 'T' }, { id: 'u-1', author: 'user', text: '重试', status: 'open', at: 'T', anchor })
  assert.deepEqual(await readdir(join(root, 'comments')), [file.split('/').pop()], 'no temporary file is left behind')
})

test('50 interleaved route and tool operations on one file all land', async t => {
  const { store, post, call } = await harness(t)
  assert.equal((await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-0', text: '总的意见', anchor }] })).status, 200)
  const work = []
  for (let i = 1; i <= 25; i++) {
    work.push(post({ sessionId: 'sess-1', path: 'order.mmd', ops: [{ op: 'create', id: `u-${i}`, text: `批注 ${i}`, anchor }] }))
    work.push(call({ path: 'order.mmd', id: 'u-0', reply: `回复 ${i}` }, `call-${i}`))
  }
  const results = await Promise.all(work)
  for (const [index, result] of results.entries()) {
    if (index % 2 === 0) assert.equal(result.status, 200, JSON.stringify(result.body))
  }
  const { comments } = await store.read(ARTIFACT)
  assert.equal(comments.length, 51)
  for (let i = 1; i <= 25; i++) {
    assert.ok(comments.some(comment => comment.id === `u-${i}` && comment.text === `批注 ${i}`), `user comment ${i} was lost`)
    assert.ok(comments.some(comment => 're' in comment && comment.re === 'u-0' && comment.text === `回复 ${i}`), `agent reply ${i} was lost`)
  }
})

test('GET returns the comments, then only the version while nothing changed', async t => {
  const { get, post } = await harness(t)
  const empty = await get({ path: ARTIFACT })
  assert.deepEqual(empty, { status: 200, body: { version: 'empty', comments: [] } })
  await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })
  const first = await get({ sessionId: 'sess-1', path: 'order.mmd' })
  assert.equal(first.body.comments.length, 1)
  assert.notEqual(first.body.version, 'empty')
  assert.deepEqual(await get({ sessionId: 'sess-1', path: 'order.mmd', since: first.body.version }), { status: 200, body: { version: first.body.version } })
})

test('the route validates its body and leaves resolving and deleting agent replies to the rules', async t => {
  const { post, call } = await harness(t)
  assert.equal((await post('not json')).status, 400)
  assert.equal((await post({ path: ARTIFACT, ops: [] })).status, 400)
  assert.equal((await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u 1', text: 'x', anchor }] })).status, 400)
  const addressed = await post({ path: ARTIFACT, ops: [{ op: 'status', id: 'u-1', status: 'addressed' }] })
  assert.equal(addressed.status, 400, 'the user cannot claim the agent addressed something')
  assert.equal((await post({ path: ARTIFACT, ops: [{ op: 'status', id: 'u-1', status: 'resolved' }] })).status, 404)
  assert.equal((await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })).status, 200)
  await call({ path: ARTIFACT, id: 'u-1', reply: '改好了' }, 'call-1')
  const replyId = (await post({ path: ARTIFACT, ops: [{ op: 'status', id: 'u-1', status: 'resolved' }] })).body.comments[1].id
  const deleted = await post({ path: ARTIFACT, ops: [{ op: 'delete', id: replyId }] })
  assert.equal(deleted.status, 403)
  assert.match(deleted.body.error, /agent/u)
  assert.equal((await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '另一句', anchor }] })).status, 409)
})

test('the route resolves paths like canvas_check: absolute, or relative to the Session directory', async t => {
  const { post } = await harness(t)
  const relative = await post({ path: 'order.mmd', ops: [{ op: 'create', id: 'u-1', text: 'x', anchor }] })
  assert.equal(relative.status, 400)
  assert.match(relative.body.error, /绝对路径/u)
  const unknown = await post({ sessionId: 'sess-404', path: 'order.mmd', ops: [{ op: 'create', id: 'u-1', text: 'x', anchor }] })
  assert.equal(unknown.status, 404)
  const notCanvas = await post({ path: '/work/notes.md', ops: [{ op: 'create', id: 'u-1', text: 'x', anchor }] })
  assert.equal(notCanvas.status, 400)
  assert.match(notCanvas.body.error, /\.mmd, \.mermaid/u)
  const viaSession = await post({ sessionId: 'sess-1', path: 'charts/../order.mmd', ops: [{ op: 'create', id: 'u-1', text: 'x', anchor }] })
  const viaAbsolute = await post({ path: ARTIFACT, ops: [{ op: 'status', id: 'u-1', status: 'resolved' }] })
  assert.equal(viaSession.status, 200)
  assert.equal(viaAbsolute.body.comments[0].status, 'resolved', 'both spellings reach one file')
})

test('canvas_comment replies and marks addressed; a replayed call adds nothing', async t => {
  const { store, post, call } = await harness(t)
  await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })
  const done = await call({ path: 'order.mmd', id: 'u-1', reply: '加了重试箭头', status: 'addressed' }, 'call-7')
  assert.equal(done.text, '已回复批注 u-1，并标记为已处理；用户确认后会标记为已解决。')
  const again = await call({ path: 'order.mmd', id: 'u-1', reply: '加了重试箭头', status: 'addressed' }, 'call-7')
  assert.equal(again.text, '批注 u-1 已经回复过并标记为已处理，没有改动。')
  const { comments } = await store.read(ARTIFACT)
  assert.equal(comments.length, 2)
  assert.equal(comments[0].status, 'addressed')
  assert.equal(comments[1].author, 'agent')
  assert.equal((await call({ path: 'order.mmd', id: 'u-1', reply: '再补一句' }, 'call-8')).text, '已回复批注 u-1。')
  assert.equal((await call({ path: 'order.mmd', id: 'u-1', status: 'addressed' }, 'call-9')).text, '批注 u-1 已经是已处理，没有改动。')
})

test('F5 reused provider call ids across sessions, turns and steps create distinct replies', async t => {
  const { store, post, tool } = await harness(t)
  await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })
  for (const [sessionId, seq, reply] of [['session-A', 1, 'first fix'], ['session-B', 1, 'second fix'], ['session-A', 2, 'third fix'], ['session-A', 3, 'fourth fix']]) {
    const exec = {
      signal, callId: 'call_0',
      agent: { session: { header: { id: sessionId }, snapshotEvents: () => [{ type: 'tool/call', seq, data: { callId: 'call_0', name: 'canvas_comment' } }] }, options: {} },
    }
    const args = { path: ARTIFACT, id: 'u-1', reply }
    assert.match((await tool.execute(args, exec)).text, /已回复/u)
    assert.match((await tool.execute(args, exec)).text, /没有改动/u)
  }
  const replies = (await store.read(ARTIFACT)).comments.slice(1)
  assert.deepEqual(replies.map(reply => reply.text), ['first fix', 'second fix', 'third fix', 'fourth fix'])
  assert.equal(new Set(replies.map(reply => reply.id)).size, 4)
})

test('F5 conflicting replay does not ask the agent to change its thread id', async t => {
  const { post, call } = await harness(t)
  await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })
  await call({ path: ARTIFACT, id: 'u-1', reply: 'first' }, 'call_0')
  await assert.rejects(call({ path: ARTIFACT, id: 'u-1', reply: 'different' }, 'call_0'), error => {
    assert.doesNotMatch(error.message, /换一个 id/u)
    assert.match(error.message, /同一次调用/u)
    return true
  })
})

test('canvas_comment refuses to resolve, reopen or delete, with a message that says why', async t => {
  const { post, call } = await harness(t)
  await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })
  const only = /只有用户能把批注标记为已解决（resolved）或重新打开；agent 只能回复，或用 status: "addressed" 标记已处理。/u
  await assert.rejects(call({ path: 'order.mmd', id: 'u-1', status: 'resolved' }, 'c1'), { message: only })
  await assert.rejects(call({ path: 'order.mmd', id: 'u-1', status: 'open' }, 'c2'), { message: only })
  await assert.rejects(call({ path: 'order.mmd', id: 'u-1', delete: true }, 'c3'), { message: /agent 不能删除批注/u })
  await assert.rejects(call({ path: 'order.mmd', id: 'u-1' }, 'c4'), { message: /reply 或 status/u })
  await assert.rejects(call({ path: 'order.mmd', id: 'u-9', reply: '?' }, 'c5'), { message: /找不到批注 u-9/u })
  await assert.rejects(call({ path: 'notes.md', id: 'u-1', reply: '?' }, 'c6'), { message: 'canvas_comment 只处理 .mmd, .mermaid, .canvas, .mock.html 文件：/work/notes.md' })
  await post({ path: ARTIFACT, ops: [{ op: 'status', id: 'u-1', status: 'resolved' }] })
  await assert.rejects(call({ path: 'order.mmd', id: 'u-1', status: 'addressed' }, 'c7'), { message: /已被用户标记为已解决/u })
})

test('a damaged store file is reported with its line, never silently trimmed', async t => {
  const { root, store, post } = await harness(t)
  await post({ path: ARTIFACT, ops: [{ op: 'create', id: 'u-1', text: '重试', anchor }] })
  const file = join(root, 'comments', `${createHash('sha256').update(ARTIFACT).digest('hex')}.jsonl`)
  await writeFile(file, `${await readFile(file, 'utf8')}{"id":"u-2","author":"user"}\n`)
  await assert.rejects(store.read(ARTIFACT), error => error.message.startsWith(`${file}:3 `))
  const refused = await post({ path: ARTIFACT, ops: [{ op: 'status', id: 'u-1', status: 'resolved' }] })
  assert.equal(refused.status, 500)
  assert.match(refused.body.error, /:3 /u)
  const other = join(root, 'comments', `${createHash('sha256').update('/work/other.mmd').digest('hex')}.jsonl`)
  await mkdir(join(root, 'comments'), { recursive: true })
  await writeFile(other, '{"artifact":"/work/order.mmd"}\n')
  await assert.rejects(store.read('/work/other.mmd'), /belongs to \/work\/order\.mmd|属于 \/work\/order\.mmd/u)
})
