import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { embedOf, parseBoard, scene } from '../src/shared/board.ts'

/** The canonical form the canvas-board skill teaches: one node or edge per line, tab indents. */
const BOARD = readFileSync(new URL('fixtures/plan.canvas', import.meta.url), 'utf8')

/** 1-based line and column of the first occurrence of `needle` (plus `offset` characters) in `text`. */
function at(text, needle, offset = 0) {
  const index = text.indexOf(needle)
  assert.ok(index >= 0, `${needle} not in the text`)
  const before = text.slice(0, index + offset)
  return { line: before.split('\n').length, column: index + offset - before.lastIndexOf('\n') }
}

const where = diagnostic => ({ line: diagnostic.line, column: diagnostic.column })

test('a canonical board parses into JSON Canvas nodes and edges without warnings', () => {
  const parsed = parseBoard(BOARD)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.board.nodes.map(node => [node.id, node.type]), [['flow', 'file'], ['why', 'text'], ['logo', 'file']])
  assert.deepEqual(parsed.board.nodes[1], { id: 'why', type: 'text', text: '## 为什么\n支付失败要能重试', x: 560, y: 0, width: 280, height: 160, color: '4' })
  assert.deepEqual(parsed.board.edges, [{ id: 'e1', fromNode: 'why', fromSide: 'left', toNode: 'flow', toSide: 'right', label: '解释' }])
  assert.deepEqual(parsed.warnings, [])
})

test('nodes and edges may be left out, and unknown fields are allowed', () => {
  const parsed = parseBoard('{"nodes":[{"id":"a","type":"group","x":0,"y":0,"width":10,"height":10,"styleAttributes":{}}]}')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.board.edges, [])
  assert.equal(parseBoard('{}').ok, true)
})

test('broken JSON is refused with line:column and a caret under the spot', () => {
  const missingComma = BOARD.replace('"height":360},', '"height":360}')
  const parsed = parseBoard(missingComma)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.diagnostics.length, 1)
  const [diagnostic] = parsed.diagnostics
  assert.equal(diagnostic.severity, 'error')
  assert.deepEqual(where(diagnostic), at(missingComma, '{"id":"why"'))
  assert.equal(diagnostic.message, 'JSON 语法错误：这里应该是 , 或 ]')
  const [source, caret] = diagnostic.snippet.split('\n')
  assert.ok(source.includes('{"id":"why"'))
  assert.equal(caret.indexOf('^'), source.indexOf('{"id":"why"'), 'the caret sits under the column')

  const trailing = parseBoard('{"nodes":[\n{"id":"a","type":"text","text":"x","x":0,"y":0,"width":1,"height":1},\n]}')
  assert.equal(trailing.ok, false)
  assert.equal(trailing.diagnostics[0].message, 'JSON 语法错误：最后一项后面多了 ,')
  assert.deepEqual(where(trailing.diagnostics[0]), { line: 2, column: 69 })

  assert.deepEqual(parseBoard('').diagnostics.map(d => [d.message, d.line, d.column]), [['画板文件是空的', 1, 1]])
  assert.equal(parseBoard('{"nodes":[]} x').diagnostics[0].message, 'JSON 语法错误：画板对象结束后还有多余的内容')
  assert.equal(parseBoard('// note\n{}').diagnostics[0].message, 'JSON 语法错误：这里应该是一个值')
  assert.equal(parseBoard('{"nodes":[{"id":"a\nb"}]}').diagnostics[0].message, 'JSON 语法错误：字符串里不能直接换行（写成 \\n）')
})

test('schema problems are all reported, each at the value that is wrong', () => {
  const source = [
    '{"nodes":[',
    '{"id":"a","type":"text","text":"x","x":0,"y":0,"width":100,"height":50},',
    '{"id":"a","type":"text","text":"y","x":0,"y":60,"width":100,"height":50},',
    '{"id":"b","type":"file","x":0,"y":0,"width":100,"height":50},',
    '{"id":"c","type":"text","text":"z","x":0,"y":0,"width":0,"height":50,"color":"9"},',
    '{"id":"d","type":"card","x":0,"y":0,"width":10,"height":10},',
    '{"id":"e","type":"text","text":"w","x":"0","y":0,"width":10,"height":10,"y":1}',
    '],"edges":[',
    '{"id":"e1","fromNode":"a","toNode":"nowhere","toSide":"middle"}',
    ']}',
  ].join('\n')
  const parsed = parseBoard(source)
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.diagnostics.map(d => [d.line, d.column, d.message]), [
    [3, at(source.split('\n')[2], '"a"').column, 'id "a" 重复（第 2 行已经用过）'],
    [4, 1, '文件节点 b 缺少 file（相对画板所在目录的路径）'],
    [5, at(source.split('\n')[4], '0,"height"').column, '节点 c 的 width 必须大于 0'],
    [5, at(source.split('\n')[4], '"9"').column, '节点 c 的 color 必须是 "1" 到 "6"，或 #rgb / #rrggbb 颜色'],
    [6, at(source.split('\n')[5], '"card"').column, '节点 d 的 type 必须是 text、file、link 或 group'],
    [7, at(source.split('\n')[6], '"0"').column, '节点 e 的 x 必须是数字'],
    [7, at(source.split('\n')[6], '"y":1').column, '节点 e 的 "y" 写了两次'],
    [9, at(source.split('\n')[8], '"nowhere"').column, '连线 e1 的 toNode 指向不存在的节点 "nowhere"'],
    [9, at(source.split('\n')[8], '"middle"').column, '连线 e1 的 toSide 必须是 top、right、bottom 或 left'],
  ])
  assert.ok(parsed.diagnostics.every(d => d.severity === 'error' && d.snippet.includes('^')))
  assert.deepEqual(parseBoard('[]').diagnostics.map(d => d.message), ['画板的最外层必须是对象：{ "nodes": [...], "edges": [...] }'])
  assert.deepEqual(parseBoard('{"nodes":{}}').diagnostics.map(d => d.message), ['"nodes" 必须是数组'])
})

test('elements that do not sit one per line get one warning, not an error', () => {
  const pretty = JSON.stringify(parseBoard(BOARD).board, null, 2)
  const parsed = parseBoard(pretty)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.warnings.map(d => [d.severity, d.line, d.message]), [
    ['warning', 3, '4 个元素没有各占一行（第一个是节点 flow）；规范格式是每个节点、每条连线各占一行，界面拖动时只改那一行'],
  ])
})

test('embedded files resolve against the board directory, by suffix', () => {
  assert.deepEqual(embedOf('/w/design/plan.canvas', 'order.mmd'), { path: '/w/design/order.mmd', kind: 'diagram' })
  assert.deepEqual(embedOf('/w/design/plan.canvas', '../notes/Spec.MD'), { path: '/w/notes/Spec.MD', kind: 'note' })
  assert.deepEqual(embedOf('/w/design/plan.canvas', './img/logo.png'), { path: '/w/design/img/logo.png', kind: 'image' })
  assert.deepEqual(embedOf('/w/design/plan.canvas', '/tmp/chart/chart.mermaid'), { path: '/tmp/chart/chart.mermaid', kind: 'diagram' })
  assert.deepEqual(embedOf('/w/plan.canvas', 'other.canvas'), { path: '/w/other.canvas', kind: 'board' })
  assert.deepEqual(embedOf('/w/plan.canvas', 'shot.webp'), { path: '/w/shot.webp', kind: 'image' })
  assert.deepEqual(embedOf('/w/plan.canvas', 'icon.svg'), { path: '/w/icon.svg', kind: 'image' })
  assert.deepEqual(embedOf('/w/plan.canvas', 'data.csv'), { path: '/w/data.csv', kind: 'other' })
  assert.deepEqual(embedOf('/w/plan.canvas', '../../../x.md'), { path: '/x.md', kind: 'note' })
})

test('scene lays out boxes, picks edge sides, finds overlaps and bounds everything', () => {
  const parsed = parseBoard(JSON.stringify({
    nodes: [
      { id: 'g', type: 'group', label: '一组', x: -40, y: -40, width: 700, height: 500 },
      { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 200, height: 100 },
      { id: 'b', type: 'text', text: 'B', x: 400, y: 0, width: 200, height: 100 },
      { id: 'c', type: 'text', text: 'C', x: 150, y: 80, width: 100, height: 100 },
      { id: 'd', type: 'text', text: 'D', x: 0, y: 400, width: 200, height: 100 },
    ],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b', label: '下一步' },
      { id: 'ad', fromNode: 'a', toNode: 'd', fromEnd: 'arrow', toEnd: 'none' },
      { id: 'bd', fromNode: 'b', fromSide: 'bottom', toNode: 'd', toSide: 'right' },
    ],
  }))
  assert.equal(parsed.ok, true)
  const s = scene(parsed.board)
  assert.equal(s.nodes[0].id, 'g', 'groups are drawn first')
  assert.deepEqual(s.nodes.map(n => n.id).slice(1), ['a', 'b', 'c', 'd'])
  const ab = s.edges.find(e => e.id === 'ab')
  assert.deepEqual([ab.from, ab.to], [{ x: 200, y: 50, side: 'right' }, { x: 400, y: 50, side: 'left' }])
  assert.deepEqual(ab.arrows, { from: false, to: true }, 'JSON Canvas: no arrow at the start, an arrow at the end')
  assert.deepEqual(ab.mid, { x: 300, y: 50 })
  const ad = s.edges.find(e => e.id === 'ad')
  assert.deepEqual([ad.from.side, ad.to.side, ad.arrows], ['bottom', 'top', { from: true, to: false }])
  const bd = s.edges.find(e => e.id === 'bd')
  assert.deepEqual([bd.from, bd.to], [{ x: 500, y: 100, side: 'bottom' }, { x: 200, y: 450, side: 'right' }])
  assert.deepEqual(s.overlaps, [{ a: 'a', b: 'c', rect: { x: 150, y: 80, width: 50, height: 20 } }], 'a group around nodes is not an overlap')
  for (const edge of s.edges) {
    for (const point of [edge.from, edge.to, edge.c1, edge.c2]) {
      assert.ok(point.x >= s.bounds.x && point.x <= s.bounds.x + s.bounds.width && point.y >= s.bounds.y && point.y <= s.bounds.y + s.bounds.height, `${edge.id} stays inside the bounds`)
    }
  }
  assert.ok(s.bounds.x <= -40 && s.bounds.y <= -40 && s.bounds.x + s.bounds.width >= 660 && s.bounds.y + s.bounds.height >= 500)
  assert.deepEqual(scene({ nodes: [], edges: [] }).bounds, { x: 0, y: 0, width: 0, height: 0 })
})
