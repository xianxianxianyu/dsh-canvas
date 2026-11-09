import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseBoard } from '../src/shared/board.ts'
import { applyBoardOps } from '../src/shared/board-ops.ts'

const BOARD = readFileSync(new URL('fixtures/plan.canvas', import.meta.url), 'utf8')

/** Indexes of the lines that differ; both texts must have the same number of lines. */
function changedLines(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  assert.equal(b.length, a.length, 'same number of lines')
  return a.flatMap((line, index) => line === b[index] ? [] : [index])
}

function applied(text, ops) {
  const result = applyBoardOps(text, ops)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(parseBoard(result.text).ok, true, 'the result is still a valid board')
  return result
}

test('moving one node rewrites its line only; every other byte stays', () => {
  const { text, statuses } = applied(BOARD, [{ op: 'place', id: 'why', x: 600, y: 40 }])
  assert.deepEqual(statuses, ['applied'])
  assert.deepEqual(changedLines(BOARD, text), [3])
  assert.equal(text.split('\n')[3], '\t\t{"id":"why","type":"text","text":"## 为什么\\n支付失败要能重试","x":600,"y":40,"width":280,"height":160,"color":"4"},')
  const lines = BOARD.split('\n')
  const head = Buffer.from(lines.slice(0, 3).join('\n'))
  const tail = Buffer.from(lines.slice(4).join('\n'))
  const out = Buffer.from(text)
  assert.ok(out.subarray(0, head.length).equals(head), 'the bytes before the line are identical')
  assert.ok(out.subarray(out.length - tail.length).equals(tail), 'the bytes after the line are identical')

  const resized = applied(BOARD, [{ op: 'place', id: 'flow', x: 0, y: 0, width: 600, height: 400 }])
  assert.deepEqual(changedLines(BOARD, resized.text), [2])
  assert.equal(resized.text.split('\n')[2], '\t\t{"id":"flow","type":"file","file":"order.mmd","x":0,"y":0,"width":600,"height":400},')
})

test('a touched element keeps unknown members and the original spelling of untouched values', () => {
  const source = '{"nodes":[\n  {"id":"a", "type":"text", "text":"caf\\u00e9 \\/ ok", "x":1.0, "y":2, "width":10, "height":10, "styleAttributes":{"shape":"pill"}}\n]}\n'
  const { text } = applied(source, [{ op: 'place', id: 'a', x: 5, y: 2 }])
  assert.equal(text, '{"nodes":[\n  {"id":"a","type":"text","text":"caf\\u00e9 \\/ ok","x":5,"y":2,"width":10,"height":10,"styleAttributes":{"shape":"pill"}}\n]}\n')
})

test('the same batch twice: the second time everything is unchanged and the text is identical', () => {
  const batch = [
    { op: 'place', id: 'flow', x: 20, y: 30, width: 500, height: 340 },
    { op: 'addNote', id: 'n-1', text: '价格要含税', x: 0, y: 400, width: 260, height: 80 },
    { op: 'setText', id: 'why', text: '## 为什么\n失败后一键重试', ifText: '## 为什么\n支付失败要能重试' },
    { op: 'addEdge', id: 'e-2', fromNode: 'n-1', toNode: 'flow', fromSide: 'top', toSide: 'bottom', label: '影响' },
    { op: 'removeEdge', id: 'e1' },
    { op: 'removeNodes', ids: ['logo'] },
  ]
  const once = applied(BOARD, batch)
  assert.deepEqual(once.statuses, ['applied', 'applied', 'applied', 'applied', 'applied', 'applied'])
  const twice = applied(once.text, batch)
  assert.deepEqual(twice.statuses, ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged'])
  assert.equal(twice.text, once.text)
  assert.equal(once.text, [
    '{',
    '\t"nodes":[',
    '\t\t{"id":"flow","type":"file","file":"order.mmd","x":20,"y":30,"width":500,"height":340},',
    '\t\t{"id":"why","type":"text","text":"## 为什么\\n失败后一键重试","x":560,"y":0,"width":280,"height":160,"color":"4"},',
    '\t\t{"id":"n-1","type":"text","text":"价格要含税","x":0,"y":400,"width":260,"height":80}',
    '\t],',
    '\t"edges":[',
    '\t\t{"id":"e-2","fromNode":"n-1","fromSide":"top","toNode":"flow","toSide":"bottom","label":"影响"}',
    '\t]',
    '}',
    '',
  ].join('\n'))
})

test('a file that is not a valid board is refused whole, with its diagnostics', () => {
  for (const broken of ['{"nodes":[', BOARD.replace('"toNode":"flow"', '"toNode":"gone"'), '']) {
    const result = applyBoardOps(broken, [{ op: 'place', id: 'why', x: 1, y: 1 }])
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.length > 0 && result.diagnostics.every(d => d.severity === 'error' && d.line >= 1))
    assert.equal('text' in result, false, 'no text to write')
  }
})

test('setText changes the note only when it still reads ifText', () => {
  const stale = applied(BOARD, [{ op: 'setText', id: 'why', text: '我的版本', ifText: '我以为的旧文字' }])
  assert.deepEqual(stale.statuses, ['conflict'])
  assert.equal(stale.text, BOARD, 'nothing written on conflict')
  assert.deepEqual(applied(BOARD, [{ op: 'setText', id: 'flow', text: 'x', ifText: '' }]).statuses, ['conflict'], 'a file node has no text to set')
  assert.deepEqual(applied(BOARD, [{ op: 'setText', id: 'gone', text: 'x', ifText: '' }]).statuses, ['missing'])
})

test('removing a node removes every edge that touches it', () => {
  const { text, statuses } = applied(BOARD, [{ op: 'removeNodes', ids: ['flow'] }])
  assert.deepEqual(statuses, ['applied'])
  const board = parseBoard(text).board
  assert.deepEqual(board.nodes.map(node => node.id), ['why', 'logo'])
  assert.deepEqual(board.edges, [])
  assert.equal(text, [
    '{',
    '\t"nodes":[',
    '\t\t{"id":"why","type":"text","text":"## 为什么\\n支付失败要能重试","x":560,"y":0,"width":280,"height":160,"color":"4"},',
    '\t\t{"id":"logo","type":"file","file":"img/logo.png","x":560,"y":200,"width":120,"height":120}',
    '\t],',
    '\t"edges":[]',
    '}',
    '',
  ].join('\n'))
  assert.deepEqual(applied(text, [{ op: 'removeNodes', ids: ['flow', 'nobody'] }]).statuses, ['unchanged'])
  const last = applied(BOARD, [{ op: 'removeNodes', ids: ['logo'] }])
  assert.equal(last.text, BOARD.replace(',\n\t\t{"id":"logo","type":"file","file":"img/logo.png","x":560,"y":200,"width":120,"height":120}', ''), 'the last element goes with the comma before it')
})

test('ops on elements the agent removed or ids already taken say so and write nothing', () => {
  assert.deepEqual(applied(BOARD, [{ op: 'place', id: 'gone', x: 0, y: 0 }]).statuses, ['missing'])
  assert.deepEqual(applied(BOARD, [{ op: 'addEdge', id: 'e-9', fromNode: 'why', toNode: 'gone' }]).statuses, ['missing'])
  assert.deepEqual(applied(BOARD, [{ op: 'addNote', id: 'flow', text: 'x', x: 0, y: 0, width: 10, height: 10 }]).statuses, ['conflict'])
  assert.deepEqual(applied(BOARD, [{ op: 'addEdge', id: 'why', fromNode: 'why', toNode: 'flow' }]).statuses, ['conflict'])
  assert.deepEqual(applied(BOARD, [{ op: 'addEdge', id: 'e1', fromNode: 'flow', toNode: 'logo' }]).statuses, ['conflict'], 'same id, other ends')
  assert.deepEqual(applied(BOARD, [{ op: 'place', id: 'why', x: 560, y: 0 }]).statuses, ['unchanged'])
  assert.deepEqual(applied(BOARD, [{ op: 'removeEdge', id: 'nope' }]).statuses, ['unchanged'])
})

test('new elements follow the file: CRLF stays CRLF, empty and absent arrays are opened', () => {
  const crlf = BOARD.replaceAll('\n', '\r\n')
  const moved = applied(crlf, [{ op: 'place', id: 'why', x: 1, y: 1 }, { op: 'addNote', id: 'n', text: 'hi', x: 0, y: 0, width: 10, height: 10 }])
  assert.equal(moved.text.replaceAll('\r\n', '').includes('\n'), false, 'no bare LF')
  assert.ok(moved.text.includes('"height":120},\r\n\t\t{"id":"n","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}\r\n\t],'))

  const empty = applied('{\n\t"nodes":[],\n\t"edges":[]\n}\n', [{ op: 'addNote', id: 'n', text: 'hi', x: 0, y: 0, width: 10, height: 10 }])
  assert.equal(empty.text, '{\n\t"nodes":[\n\t\t{"id":"n","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}\n\t],\n\t"edges":[]\n}\n')

  const absent = applied('{\n\t"nodes":[\n\t\t{"id":"a","type":"text","text":"A","x":0,"y":0,"width":10,"height":10}\n\t]\n}\n',
    [{ op: 'addNote', id: 'b', text: 'B', x: 20, y: 0, width: 10, height: 10 }, { op: 'addEdge', id: 'ab', fromNode: 'a', toNode: 'b' }])
  assert.equal(absent.text, '{\n\t"nodes":[\n\t\t{"id":"a","type":"text","text":"A","x":0,"y":0,"width":10,"height":10},\n\t\t{"id":"b","type":"text","text":"B","x":20,"y":0,"width":10,"height":10}\n\t],\n\t"edges":[\n\t\t{"id":"ab","fromNode":"a","toNode":"b"}\n\t]\n}\n')

  assert.equal(applied('{}', [{ op: 'addNote', id: 'n', text: 'hi', x: 0, y: 0, width: 10, height: 10 }]).text,
    '{\n\t"nodes":[\n\t\t{"id":"n","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}\n\t]\n}')
})

test('a touched multiline element compacts separators but preserves untouched member spans', () => {
  const pretty = '{\n  "nodes": [\n    {\n      "id": "a",\n      "type": "text",\n      "text": "A",\n      "x": 0, "y": 0, "width": 10, "height": 10\n    },\n    {"id": "b", "type": "text", "text": "B", "x": 0, "y": 20, "width": 10, "height": 10}\n  ]\n}\n'
  const { text } = applied(pretty, [{ op: 'place', id: 'a', x: 3, y: 4 }])
  assert.equal(text, '{\n  "nodes": [\n    {"id": "a","type": "text","text": "A","x":3,"y":4,"width": 10,"height": 10},\n    {"id": "b", "type": "text", "text": "B", "x": 0, "y": 20, "width": 10, "height": 10}\n  ]\n}\n')
})

test('F4: untouched extension members retain prototype names and multiline numeric bytes', () => {
  for (const key of ['custom', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const member = `"${key}" : {\n "externalId":9007199254740993,\n "escaped":"caf\\u00e9"\n}`
    const source = `{"nodes":[{"id":"n","type":"text","text":"hi","x":0,"y":0,"width":100,"height":100,${member}}]}`
    const result = applied(source, [{ op: 'place', id: 'n', x: 1, y: 2 }])
    assert.ok(result.text.includes(member), `untouched ${key} member is byte-for-byte identical`)
    assert.deepEqual(result.statuses, ['applied'])
    assert.equal(applied(result.text, [{ op: 'place', id: 'n', x: 1, y: 2 }]).text, result.text)
  }
})
