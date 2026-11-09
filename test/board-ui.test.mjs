import assert from 'node:assert/strict'
import test from 'node:test'
import { placeOp, connectOp, removeOps, reconcile, describeRecoveryOp } from '../src/client/board-ui.ts'
import { zh, en } from '../src/client/locales.ts'

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

const box = { x: 0, y: 0, width: 200, height: 100 }
const recoveryBoard = {
  nodes: [
    { ...box, id: 'group-id', type: 'group', label: ' Release plan ' },
    { ...box, id: 'file-id', type: 'file', file: '/workspace/docs/guide.md' },
    { ...box, id: 'note-id', type: 'text', text: '\n # Meeting notes\r\nDetails that are not a label' },
    { ...box, id: 'empty-group', type: 'group', label: ' ' },
    { ...box, id: 'empty-note', type: 'text', text: '\n ' },
    { ...box, id: 'link-id', type: 'link', url: 'https://example.com/' },
  ],
  edges: [{ id: 'edge-id', fromNode: 'file-id', toNode: 'note-id', label: ' explains ' }],
}
const recoveryOps = [
  { op: 'place', id: 'group-id', x: 12, y: -5, width: 420, height: 160 },
  { op: 'addNote', id: 'new-note', text: '## New idea\nMore detail', x: 40, y: 50, width: 240, height: 160 },
  { op: 'setText', id: 'note-id', text: '# Revised plan\nFollow up', ifText: 'Original text' },
  { op: 'addEdge', id: 'new-edge', fromNode: 'group-id', toNode: 'file-id', label: 'depends on' },
  { op: 'removeEdge', id: 'edge-id' },
  { op: 'removeNodes', ids: ['group-id', 'file-id', 'note-id', 'missing-id'] },
]
const descriptions = {
  en: [
    'Move “Release plan” to (12, -5) · width 420 · height 160',
    'Add note “New idea” at (40, 50) · width 240 · height 160',
    'Change note “Meeting notes” text to “Revised plan”',
    'Add edge “depends on”: “Release plan” → “guide.md”',
    'Remove edge “explains”: “guide.md” → “Meeting notes”',
    'Remove nodes and their connected edges: “Release plan”, “guide.md”, “Meeting notes”, “missing-id”',
  ],
  zh: [
    '将「Release plan」移到 (12, -5) · 宽 420 · 高 160',
    '在 (40, 50) 添加便签「New idea」 · 宽 240 · 高 160',
    '将便签「Meeting notes」的文字改为「Revised plan」',
    '添加连线「depends on」：「Release plan」 → 「guide.md」',
    '删除连线「explains」：「guide.md」 → 「Meeting notes」',
    '删除节点及其相连的连线：「Release plan」、「guide.md」、「Meeting notes」、「missing-id」',
  ],
}

for (const [language, dictionary] of Object.entries({ zh, en })) {
  const t = (key, params) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]))

  test(`${language}: all six recovery operations describe intent using group, file and note labels without changing replay data`, () => {
    const before = structuredClone({ board: recoveryBoard, ops: recoveryOps })
    assert.deepEqual(recoveryOps.map(op => describeRecoveryOp(op, recoveryBoard, t)), descriptions[language])
    assert.deepEqual({ board: recoveryBoard, ops: recoveryOps }, before)
  })

  test(`${language}: recovery descriptions retain IDs and edge endpoints when the board is unavailable`, () => {
    const ops = [
      { op: 'place', id: 'missing-id', x: 0, y: -9 },
      { op: 'addNote', id: 'empty-new-note', text: ' \n ', x: 1, y: 2, width: 100, height: 80 },
      { op: 'setText', id: 'missing-note', text: '', ifText: 'Old text' },
      { op: 'addEdge', id: 'missing-edge', fromNode: 'source-id', toNode: 'target-id' },
      { op: 'removeEdge', id: 'missing-edge' },
      { op: 'removeNodes', ids: ['source-id', 'target-id'] },
    ]
    assert.deepEqual(ops.map(op => describeRecoveryOp(op, undefined, t)), language === 'en' ? [
      'Move “missing-id” to (0, -9)',
      'Add note “empty-new-note” at (1, 2) · width 100 · height 80',
      'Change note “missing-note” text to empty text',
      'Add edge “missing-edge”: “source-id” → “target-id”',
      'Remove edge “missing-edge” (endpoints unavailable)',
      'Remove nodes and their connected edges: “source-id”, “target-id”',
    ] : [
      '将「missing-id」移到 (0, -9)',
      '在 (1, 2) 添加便签「empty-new-note」 · 宽 100 · 高 80',
      '将便签「missing-note」的文字改为空文字',
      '添加连线「missing-edge」：「source-id」 → 「target-id」',
      '删除连线「missing-edge」（端点信息不可用）',
      '删除节点及其相连的连线：「source-id」、「target-id」',
    ])
  })

  test(`${language}: missing or unlabeled targets fall back to IDs and partial sizes only describe supplied dimensions`, () => {
    const ops = [
      { op: 'place', id: 'empty-group', x: 1, y: 2, width: 300 },
      { op: 'place', id: 'empty-note', x: 3, y: 4, height: 90 },
      { op: 'place', id: 'link-id', x: 5, y: 6 },
      { op: 'place', id: 'missing-id', x: 7, y: 8 },
      { op: 'setText', id: 'missing-note', text: 'Restored text\nSecond line', ifText: '' },
      { op: 'addEdge', id: 'new-edge', fromNode: 'file-id', toNode: 'missing-id', label: ' ' },
      { op: 'removeEdge', id: 'missing-edge' },
    ]
    assert.deepEqual(ops.map(op => describeRecoveryOp(op, recoveryBoard, t)), language === 'en' ? [
      'Move “empty-group” to (1, 2) · width 300',
      'Move “empty-note” to (3, 4) · height 90',
      'Move “link-id” to (5, 6)',
      'Move “missing-id” to (7, 8)',
      'Change note “missing-note” text to “Restored text”',
      'Add edge “new-edge”: “guide.md” → “missing-id”',
      'Remove edge “missing-edge” (endpoints unavailable)',
    ] : [
      '将「empty-group」移到 (1, 2) · 宽 300',
      '将「empty-note」移到 (3, 4) · 高 90',
      '将「link-id」移到 (5, 6)',
      '将「missing-id」移到 (7, 8)',
      '将便签「missing-note」的文字改为「Restored text」',
      '添加连线「new-edge」：「guide.md」 → 「missing-id」',
      '删除连线「missing-edge」（端点信息不可用）',
    ])
  })
}
