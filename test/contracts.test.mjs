import assert from 'node:assert/strict'
import test from 'node:test'
import {parseBoard} from '../src/shared/board.ts'
import {renderDiagram} from '../src/shared/diagram.ts'
import {boardOpSchema} from '../src/shared/board-schema.ts'
import {anchorSchema} from '../src/shared/comment-schema.ts'
import {threadsOf} from '../src/shared/comments.ts'

const note = (id, text = 'note') => ({ id, type: 'text', text, x: 0, y: 0, width: 240, height: 160 })
for (const [name, value] of [
  ['250-character board node id', { nodes: [note('a'.repeat(250))] }],
  ['250-character board edge id', { nodes: [note('a')], edges: [{id: 'e'.repeat(250), fromNode: 'a', toNode: 'a'}] }],
  ['20001-character note', { nodes: [note('a', 'x'.repeat(20001))] }],
]) {
  test(`F8 check rejects ${name} as a located error`, () => {
    const result = parseBoard(JSON.stringify(value))
    assert.equal(result.ok, false)
    assert.equal(result.diagnostics[0].severity, 'error')
    assert.equal(result.diagnostics[0].line, 1)
    assert.ok(result.diagnostics[0].column > 0)
  })
}

test('F8 check rejects 250-character diagram ids before comment creation', () => {
  const result = renderDiagram(`flowchart LR\n${'a'.repeat(250)}[ok]`)
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].severity, 'error')
  assert.equal(result.diagnostics[0].line, 2)
  assert.ok(result.diagnostics[0].column > 0)
})

test('F8 maximum accepted board fields pass route schemas without truncation', () => {
  const id = 'a'.repeat(200), text = 'x'.repeat(20000)
  assert.equal(parseBoard(JSON.stringify({nodes: [note(id, text)]})).ok, true)
  assert.equal(boardOpSchema.safeParse({op: 'place', id, x: 1, y: 2}).success, true)
  assert.equal(boardOpSchema.safeParse({op: 'setText', id, text: 'new', ifText: text}).success, true)
  assert.equal(anchorSchema.safeParse({target: id, label: 'x'.repeat(500)}).success, true)
})

test('F8 anchor drift compares the same 500-character label snapshot in both directions', () => {
  const label = 'x'.repeat(500)
  const root = {id: 'u', author: 'user', text: 'fix', status: 'open', at: '2026-01-01T00:00:00Z', anchor: {target: 'a', label}}
  assert.equal(threadsOf([root], new Map([['a', label + 'suffix']]))[0].drift, undefined)
  assert.deepEqual(threadsOf([root], new Map([['b', label + 'suffix']]))[0].drift, {kind: 'gone', movedTo: ['b']})
  assert.equal(threadsOf([root], new Map([['a', 'different']]))[0].drift.kind, 'renamed')
})
