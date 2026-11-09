import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, outlineTargets, threadsOf } from '../src/shared/comments.ts'

const T0 = '2026-11-09T08:00:00.000Z'
const T1 = '2026-11-09T09:00:00.000Z'
const anchor = { target: 's3', label: '支付失败' }
const create = { op: 'create', id: 'u-1', text: '失败后应该能直接重试', anchor }

/** Apply and require success, so a test reads as a sequence of accepted steps. */
function ok(comments, ops, actor, now = T0) {
  const result = applyOps(comments, ops, actor, now)
  assert.equal(result.ok, true, result.ok ? '' : result.error.message)
  return result
}

function rejected(comments, ops, actor) {
  const result = applyOps(comments, ops, actor, T1)
  assert.equal(result.ok, false, 'expected a rejection')
  return result.error
}

test('a user comment is created once; replaying the same op changes nothing', () => {
  const first = ok([], [create], 'user')
  assert.equal(first.changed, true)
  assert.deepEqual(first.comments, [{ id: 'u-1', author: 'user', text: '失败后应该能直接重试', status: 'open', at: T0, anchor }])
  const replay = ok(first.comments, [create], 'user', T1)
  assert.equal(replay.changed, false)
  assert.equal(replay.comments, first.comments, 'an unchanged batch returns the same list')
  const clash = rejected(first.comments, [{ ...create, text: '别的话' }], 'user')
  assert.equal(clash.code, 'conflict')
})

test('status, reply and delete are idempotent by comment id', () => {
  const base = ok([], [create], 'user').comments
  const resolved = ok(base, [{ op: 'status', id: 'u-1', status: 'resolved' }], 'user')
  assert.equal(resolved.comments[0].status, 'resolved')
  assert.equal(ok(resolved.comments, [{ op: 'status', id: 'u-1', status: 'resolved' }], 'user').changed, false)

  const reply = { op: 'reply', id: 'a-1', re: 'u-1', text: '加了重试箭头' }
  const replied = ok(base, [reply], 'agent', T1)
  assert.deepEqual(replied.comments[1], { id: 'a-1', author: 'agent', text: '加了重试箭头', status: 'open', at: T1, re: 'u-1' })
  assert.equal(ok(replied.comments, [reply], 'agent').changed, false)

  const deleted = ok(replied.comments, [{ op: 'delete', id: 'u-1' }], 'user')
  assert.deepEqual(deleted.comments, [], 'deleting a root removes its thread')
  assert.equal(ok(deleted.comments, [{ op: 'delete', id: 'u-1' }], 'user').changed, false, 'deleting a gone comment is a no-op')
})

test('a batch is all or nothing', () => {
  const base = ok([], [create], 'user').comments
  const error = rejected(base, [{ op: 'status', id: 'u-1', status: 'resolved' }, { op: 'status', id: 'nope', status: 'open' }], 'user')
  assert.equal(error.code, 'missing')
  assert.match(error.message, /nope/u)
  assert.equal(base[0].status, 'open')
})

test('only the user resolves or reopens; only the agent marks addressed', () => {
  const base = ok([], [create], 'user').comments
  assert.equal(rejected(base, [{ op: 'status', id: 'u-1', status: 'resolved' }], 'agent').code, 'forbidden')
  assert.match(rejected(base, [{ op: 'status', id: 'u-1', status: 'resolved' }], 'agent').message, /只有用户能把批注标记为已解决/u)
  assert.equal(rejected(base, [{ op: 'status', id: 'u-1', status: 'open' }], 'agent').code, 'forbidden')
  assert.equal(rejected(base, [{ op: 'status', id: 'u-1', status: 'addressed' }], 'user').code, 'forbidden')
  assert.equal(rejected(base, [{ op: 'create', id: 'a-9', text: 'x', anchor }], 'agent').code, 'forbidden')

  const addressed = ok(base, [{ op: 'status', id: 'u-1', status: 'addressed' }], 'agent')
  assert.equal(addressed.comments[0].status, 'addressed')
  assert.equal(ok(addressed.comments, [{ op: 'status', id: 'u-1', status: 'addressed' }], 'agent').changed, false)
  const reopened = ok(addressed.comments, [{ op: 'status', id: 'u-1', status: 'open' }], 'user')
  assert.equal(reopened.comments[0].status, 'open', 'the user may reopen an addressed comment')
  const resolved = ok(addressed.comments, [{ op: 'status', id: 'u-1', status: 'resolved' }], 'user').comments
  const late = rejected(resolved, [{ op: 'status', id: 'u-1', status: 'addressed' }], 'agent')
  assert.equal(late.code, 'forbidden', 'the agent cannot pull a resolved comment back')
})

test('nobody deletes the other side, and replies carry no status', () => {
  const thread = ok(ok([], [create], 'user').comments, [{ op: 'reply', id: 'a-1', re: 'u-1', text: '好' }], 'agent').comments
  assert.equal(rejected(thread, [{ op: 'delete', id: 'u-1' }], 'agent').code, 'forbidden')
  assert.match(rejected(thread, [{ op: 'delete', id: 'u-1' }], 'agent').message, /不能删除用户的批注/u)
  assert.equal(rejected(thread, [{ op: 'delete', id: 'a-1' }], 'user').code, 'forbidden')
  assert.equal(rejected(thread, [{ op: 'status', id: 'a-1', status: 'addressed' }], 'agent').code, 'invalid')
  assert.equal(rejected(thread, [{ op: 'reply', id: 'a-2', re: 'gone', text: '?' }], 'agent').code, 'missing')
  const nested = ok(thread, [{ op: 'reply', id: 'a-2', re: 'a-1', text: '补充' }], 'agent')
  assert.equal(nested.comments[2].re, 'u-1', 'a reply to a reply joins the root thread')
})

test('threads report anchor drift: a changed label, or an id that is gone', () => {
  const comments = [
    { id: 'u-1', author: 'user', text: '重试', status: 'open', at: T0, anchor: { target: 's3', label: '支付失败' } },
    { id: 'u-2', author: 'user', text: '改名', status: 'addressed', at: T0, anchor: { target: 's1', label: '购物车' } },
    { id: 'a-1', author: 'agent', text: '已改', status: 'open', at: T1, re: 'u-2' },
    { id: 'u-3', author: 'user', text: '删掉', status: 'resolved', at: T0, anchor: { target: 's9', label: '旧状态' } },
    { id: 'u-4', author: 'user', text: '整体太挤', status: 'open', at: T0 },
  ]
  const labels = new Map([['s1', '订单'], ['s3', '支付失败'], ['s7', '旧状态'], ['s5', '购物车']])
  const threads = threadsOf(comments, labels)
  assert.deepEqual(threads.map(thread => [thread.root.id, thread.replies.map(reply => reply.id), thread.drift]), [
    ['u-1', [], undefined],
    ['u-2', ['a-1'], { kind: 'renamed', label: '订单', movedTo: ['s5'] }],
    ['u-3', [], { kind: 'gone', movedTo: ['s7'] }],
    ['u-4', [], undefined],
  ])
  assert.deepEqual(outlineTargets(threads), ['s3', 's1'], 'open and addressed threads whose node is still drawn')
})
