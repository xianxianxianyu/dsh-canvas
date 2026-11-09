import assert from 'node:assert/strict'
import test from 'node:test'
import { placeOp, connectOp, removeOps, reconcile, visibleLosses } from '../src/client/board-ui.ts'

const source = JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: 'before', x: 0, y: 0, width: 200, height: 100 }], edges: [] })

test('drag end is one absolute placement with rounded coordinates, never text or dimensions', () => {
  assert.deepEqual(placeOp('a', { x: 12.6, y: -3.4 }), { op: 'place', id: 'a', x: 13, y: -3 })
})

test('resize end includes rounded position and size in the same operation', () => {
  assert.deepEqual(placeOp('a', { x: 1.4, y: 2.8, width: 224.6, height: 109.2 }), { op: 'place', id: 'a', x: 1, y: 3, width: 225, height: 109 })
})

test('connecting carries the selected sides and optional label, deleting nodes avoids redundant incident-edge removals', () => {
  assert.deepEqual(connectOp('edge', { source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' }, 'explains'), { op: 'addEdge', id: 'edge', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', label: 'explains' })
  assert.deepEqual(connectOp('edge', { source: 'a', target: 'b', sourceHandle: null, targetHandle: null }, ''), { op: 'addEdge', id: 'edge', fromNode: 'a', toNode: 'b' })
  assert.deepEqual(removeOps(['a'], [{ id: 'attached', source: 'a', target: 'b' }, { id: 'other', source: 'b', target: 'c' }]), [{ op: 'removeNodes', ids: ['a'] }, { op: 'removeEdge', id: 'other' }])
})

test('each file read replaces optimistic coordinates and text, without merging old local fields', () => {
  const optimistic = { ...reconcile(source), board: { nodes: [{ id: 'a', type: 'text', text: 'local', x: 99, y: 88, width: 200, height: 100 }], edges: [] } }
  const next = reconcile(source.replace('before', 'agent'))
  assert.equal(optimistic.board.nodes[0].x, 99)
  assert.equal(next.kind, 'ready')
  assert.deepEqual(next.board.nodes[0], { id: 'a', type: 'text', text: 'agent', x: 0, y: 0, width: 200, height: 100 })
})

test('invalid source exposes located diagnostics and no editable board; repaired source returns ready', () => {
  const state = reconcile('{\n "nodes": [ }')
  assert.equal(state.kind, 'invalid-source')
  assert.equal('board' in state, false)
  assert.equal(state.diagnostics[0].line, 2)
  assert.ok(state.diagnostics[0].column > 0)
  assert.equal(reconcile(source).kind, 'ready')
})

test('lost banners retain exact replay operations and dismissal only hides the chosen batch', () => {
  const losses = [{ id: 'board-1', at: '2026-01-01T00:00:00Z', count: 1, ops: [{ op: 'place', id: 'a', x: 80, y: 40 }] }, { id: 'board-2', at: '2026-01-01T00:00:01Z', count: 1, ops: [{ op: 'removeEdge', id: 'e' }] }]
  assert.deepEqual(visibleLosses(losses, new Set()), losses)
  assert.deepEqual(visibleLosses(losses, new Set(['board-1'])), [losses[1]])
  assert.equal(visibleLosses(losses, new Set())[0].ops, losses[0].ops)
  assert.deepEqual(visibleLosses([], new Set(['board-1'])), [])
})
