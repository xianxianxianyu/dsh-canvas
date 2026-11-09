import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { renderDiagram } from '../src/shared/diagram.ts'
import { diagramNodes } from '../src/shared/nodes.ts'

const render = source => {
  const diagram = renderDiagram(source)
  assert.equal(diagram.ok, true)
  return diagram.svg
}

test('state chart nodes carry their Mermaid id, visible label and box in SVG pixels', async () => {
  const nodes = diagramNodes(render(await readFile(new URL('fixtures/statechart.mmd', import.meta.url), 'utf8')))
  assert.deepEqual(nodes.map(node => [node.id, node.label]), [
    ['root_start', ''], ['s1', '购物车'], ['s2', '支付中'], ['s3', '支付失败'], ['s4', '已支付'],
  ])
  // <g data-id="s3" transform="translate(200.5,314)"><rect x="-48" y="-22" width="96" height="44">
  assert.deepEqual(nodes.find(node => node.id === 's3').boxes, [{ x: 152.5, y: 292, width: 96, height: 44 }])
  // <g data-id="root_start" transform="translate(144.5,15)"><circle r="7">
  assert.deepEqual(nodes[0].boxes, [{ x: 137.5, y: 8, width: 14, height: 14 }])
})

test('flowchart shapes, wrapped labels and escaped text', () => {
  const nodes = diagramNodes(render([
    'flowchart LR',
    '  a["first line<br>second line &amp; more"] --> b{支付?}',
    '  b --> c((发货))',
    '  c --> d["这是一个非常非常长的标签，用来测试换行是否会发生在中文里面"]',
  ].join('\n')))
  const byId = new Map(nodes.map(node => [node.id, node]))
  assert.equal(byId.get('a').label, 'first line second line & more')
  assert.equal(byId.get('b').label, '支付?')
  assert.equal(byId.get('d').label, '这是一个非常非常长的标签，用来测试换行是否会发生在中文里面', 'CJK lines join without a space')
  const diamond = byId.get('b').boxes[0]
  assert.ok(diamond.width > 0 && diamond.height > 0, 'polygon nodes get a box')
  const circle = byId.get('c').boxes[0]
  assert.equal(circle.width, circle.height, 'circle nodes get a square box')
})

test('a participant drawn twice keeps both boxes under one id; edges are not nodes', () => {
  const nodes = diagramNodes(render('sequenceDiagram\n  participant A as 用户\n  participant B as 服务\n  A->>B: 请求\n  B-->>A: 响应'))
  assert.deepEqual(nodes.map(node => [node.id, node.label, node.boxes.length]), [['A', '用户', 2], ['B', '服务', 2]])
})

test('nested group transforms add up', () => {
  const nodes = diagramNodes(render('mindmap\n  root((中心))\n    A\n      B'))
  const a = nodes.find(node => node.id === 'A')
  // <g transform="translate(36,36)"> … <g data-id="A" transform="translate(97.34,0)"><rect x="-17.34" y="-15" …>
  assert.ok(Math.abs(a.boxes[0].x - (36 + 97.34 - 17.34)) < 1e-9)
  assert.ok(Math.abs(a.boxes[0].y - (36 - 15)) < 1e-9)
})
