/** Rebuild BreakOpus #3: canonical one-element-per-line boards, with optional chain edges. */
export function largeBoard(count, edges = count === 600) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, type: 'text', text: `N${i}`, x: i % 20 * 160, y: Math.floor(i / 20) * 100, width: 140, height: 80 }))
  const links = edges ? nodes.slice(1).map((node, i) => ({ id: `e${i}`, fromNode: nodes[i].id, fromSide: 'right', toNode: node.id, toSide: 'left' })) : []
  const source = `{\n"nodes":[\n${nodes.map(node => JSON.stringify(node)).join(',\n')}\n],\n"edges":[${links.length ? '\n' + links.map(edge => JSON.stringify(edge)).join(',\n') + '\n' : ''}]\n}\n`
  return { source, nodes, edges: links }
}
export function dragOps(nodes, start = 0, count = 200, delta = 17) {
  return nodes.slice(start, start + count).map(node => ({ op: 'place', id: node.id, x: node.x + delta, y: node.y + delta }))
}
