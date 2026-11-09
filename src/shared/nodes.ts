/**
 * The elements a person can point at in a pele diagram: each `g.pele-node[data-id]` with its
 * Mermaid id, its visible label, and where it is drawn. Read from the SVG text itself, so the
 * host (labels, for anchor drift) and the client (boxes, for picking over the sandboxed preview)
 * get the same answer without rendering. `test/chrome.test.mjs` holds the boxes to Chrome's layout.
 */

/** A rectangle in CSS pixels from the SVG element's top-left corner. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DiagramNode {
  /** pele's `data-id`: the Mermaid id of the node. */
  readonly id: string
  /** The node's `.pele-label` text, wrapped lines joined back together. */
  readonly label: string
  /** One box per time the id is drawn (a sequence participant is drawn at the top and the bottom); empty when it has no shape. */
  readonly boxes: readonly Box[]
}

type Matrix = readonly [number, number, number, number, number, number]
type Point = readonly [number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const SHAPES: Record<string, true> = { rect: true, circle: true, ellipse: true, line: true, polygon: true, polyline: true, path: true }
// Lines of wrapped CJK text join without a space; lines of other scripts join with one.
const WIDE = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/u
/** One tag, comment or run of text in pele's markup. */
const MARKUP_PIECE = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->|([^<]+)/gu
const ATTRIBUTE = /([^\s=]+)\s*=\s*"([^"]*)"/gu
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gu

function multiply(m: Matrix, n: Matrix): Matrix {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
}

function numbers(text: string): number[] {
  return (text.match(NUMBER) ?? []).map(Number)
}

/** An SVG `transform` attribute as one matrix. */
function parseTransform(value: string | undefined): Matrix {
  let result = IDENTITY
  for (const [, name, args] of value?.matchAll(/(\w+)\s*\(([^)]*)\)/gu) ?? []) {
    const [a = 0, b, c, d = 0, e = 0, f = 0] = numbers(args!)
    const radians = a * Math.PI / 180
    const step: Matrix | undefined = {
      translate: [1, 0, 0, 1, a, b ?? 0] as const,
      scale: [a, 0, 0, b ?? a, 0, 0] as const,
      matrix: [a, b ?? 0, c ?? 0, d, e, f] as const,
      rotate: multiply(multiply([1, 0, 0, 1, b ?? 0, c ?? 0], [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0]), [1, 0, 0, 1, -(b ?? 0), -(c ?? 0)]),
    }[name!]
    if (step !== undefined) result = multiply(result, step)
  }
  return result
}

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/giu, (_, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal))
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name!.toLowerCase()]!
  })
}

/** Points of an elliptical arc (SVG implementation notes, F.6.5), sampled finely enough for a bounding box. */
function arc(from: Point, rx: number, ry: number, degrees: number, large: boolean, sweep: boolean, to: Point): Point[] {
  if (rx === 0 || ry === 0) return [to]
  const phi = degrees * Math.PI / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (from[0] - to[0]) / 2
  const dy = (from[1] - to[1]) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const lambda = x1 ** 2 / rx ** 2 + y1 ** 2 / ry ** 2
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const denominator = rx ** 2 * y1 ** 2 + ry ** 2 * x1 ** 2
  const coefficient = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx ** 2 * ry ** 2 - denominator) / denominator))
  const cx1 = coefficient * rx * y1 / ry
  const cy1 = -coefficient * ry * x1 / rx
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2
  const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2
  const start = Math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
  let delta = Math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - start
  if (sweep && delta < 0) delta += 2 * Math.PI
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  const points: Point[] = []
  for (let k = 1; k <= 64; k++) {
    const angle = start + delta * k / 64
    points.push([cx + rx * Math.cos(angle) * cos - ry * Math.sin(angle) * sin, cy + rx * Math.cos(angle) * sin + ry * Math.sin(angle) * cos])
  }
  return points
}

/** Points on a Bézier curve of any degree, sampled. */
function bezier(controls: readonly Point[]): Point[] {
  const points: Point[] = []
  for (let k = 1; k <= 32; k++) {
    const t = k / 32
    let level = controls
    while (level.length > 1) level = level.slice(1).map((point, i) => [level[i]![0] + (point[0] - level[i]![0]) * t, level[i]![1] + (point[1] - level[i]![1]) * t] as const)
    points.push(level[0]!)
  }
  return points
}

/** Every point a path passes through, curves sampled. */
function pathPoints(d: string): Point[] {
  const points: Point[] = []
  let current: Point = [0, 0]
  let start: Point = [0, 0]
  let control: Point | undefined
  let previous = ''
  for (const [, command, args] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/gu)) {
    const values = numbers(args!)
    const relative = command === command!.toLowerCase()
    const at = (x: number, y: number): Point => relative ? [current[0] + x, current[1] + y] : [x, y]
    const upper = command!.toUpperCase()
    if (upper === 'Z') {
      current = start
      points.push(current)
      previous = upper
      continue
    }
    const arity = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 }[upper] ?? 2
    for (let i = 0; i + arity <= values.length; i += arity) {
      const v = values.slice(i, i + arity)
      let next: Point
      let curve: Point[] = []
      let nextControl: Point | undefined
      // Repeated coordinates after M are implicit line-tos.
      const kind = upper === 'M' && i > 0 ? 'L' : upper
      if (kind === 'H') next = [relative ? current[0] + v[0]! : v[0]!, current[1]]
      else if (kind === 'V') next = [current[0], relative ? current[1] + v[0]! : v[0]!]
      else if (kind === 'C' || kind === 'S') {
        const first = kind === 'C' ? at(v[0]!, v[1]!) : control && 'CS'.includes(previous) ? [2 * current[0] - control[0], 2 * current[1] - control[1]] as const : current
        const second = kind === 'C' ? at(v[2]!, v[3]!) : at(v[0]!, v[1]!)
        next = kind === 'C' ? at(v[4]!, v[5]!) : at(v[2]!, v[3]!)
        curve = bezier([current, first, second, next])
        nextControl = second
      } else if (kind === 'Q' || kind === 'T') {
        const middle = kind === 'Q' ? at(v[0]!, v[1]!) : control && 'QT'.includes(previous) ? [2 * current[0] - control[0], 2 * current[1] - control[1]] as const : current
        next = kind === 'Q' ? at(v[2]!, v[3]!) : at(v[0]!, v[1]!)
        curve = bezier([current, middle, next])
        nextControl = middle
      } else if (kind === 'A') {
        next = at(v[5]!, v[6]!)
        curve = arc(current, v[0]!, v[1]!, v[2]!, v[3] !== 0, v[4] !== 0, next)
      } else next = at(v[0]!, v[1]!)
      if (kind === 'M') start = next
      points.push(next, ...curve)
      current = next
      control = nextControl
      previous = kind
    }
  }
  return points
}

function shapePoints(name: string, attributes: ReadonlyMap<string, string>): Point[] {
  const number = (key: string): number => Number(attributes.get(key) ?? 0)
  switch (name) {
    case 'rect': {
      const x = number('x')
      const y = number('y')
      return [[x, y], [x + number('width'), y + number('height')], [x + number('width'), y], [x, y + number('height')]]
    }
    case 'circle':
    case 'ellipse': {
      const rx = name === 'circle' ? number('r') : number('rx')
      const ry = name === 'circle' ? number('r') : number('ry')
      return arc([number('cx') + rx, number('cy')], rx, ry, 0, false, true, [number('cx') - rx, number('cy')])
        .concat(arc([number('cx') - rx, number('cy')], rx, ry, 0, false, true, [number('cx') + rx, number('cy')]))
    }
    case 'line':
      return [[number('x1'), number('y1')], [number('x2'), number('y2')]]
    case 'polygon':
    case 'polyline': {
      const values = numbers(attributes.get('points') ?? '')
      return values.flatMap((value, i) => i % 2 === 0 && i + 1 < values.length ? [[value, values[i + 1]!] as const] : [])
    }
    default:
      return pathPoints(attributes.get('d') ?? '')
  }
}

interface Drawn {
  readonly node: { readonly id: string; label: string | undefined; readonly boxes: Box[] }
  readonly depth: number
  min: Point
  max: Point
  lines: string[] | undefined
}

function joinLines(lines: readonly string[]): string {
  return lines.map(line => line.trim()).filter(Boolean).reduce((label, line) => {
    if (!label) return line
    return WIDE.test(label.at(-1)!) || WIDE.test(line[0]!) ? label + line : `${label} ${line}`
  }, '')
}

/**
 * Find the pickable nodes of a pele SVG.
 * @param svg - pele's markup, as `renderDiagram` returns it.
 * @returns nodes in drawing order, one entry per id.
 */
export function diagramNodes(svg: string): readonly DiagramNode[] {
  const nodes = new Map<string, Drawn['node']>()
  const stack: Matrix[] = []
  const open: Drawn[] = []
  let labelDepth = -1
  for (const [, closing, name, rawAttributes, selfClosing, text] of svg.matchAll(MARKUP_PIECE)) {
    const drawn = open.at(-1)
    if (text !== undefined) {
      if (drawn?.lines !== undefined && labelDepth >= 0) {
        if (!drawn.lines.length) drawn.lines.push('')
        drawn.lines[drawn.lines.length - 1] += decode(text)
      }
      continue
    }
    if (name === undefined) continue
    if (closing) {
      stack.pop()
      if (labelDepth === stack.length) labelDepth = -1
      if (drawn?.depth === stack.length) {
        open.pop()
        if (drawn.lines !== undefined && drawn.node.label === undefined) drawn.node.label = joinLines(drawn.lines)
        if (drawn.min[0] <= drawn.max[0]) drawn.node.boxes.push({ x: drawn.min[0], y: drawn.min[1], width: drawn.max[0] - drawn.min[0], height: drawn.max[1] - drawn.min[1] })
      }
      continue
    }
    const attributes = new Map([...rawAttributes!.matchAll(ATTRIBUTE)].map(([, key, value]) => [key!, decode(value!)]))
    const parent = stack.at(-1) ?? IDENTITY
    let matrix = multiply(parent, parseTransform(attributes.get('transform')))
    if (name === 'svg' && stack.length === 0) {
      const [vx = 0, vy = 0, vw, vh] = numbers(attributes.get('viewBox') ?? '')
      const sx = vw ? Number(attributes.get('width') ?? vw) / vw : 1
      const sy = vh ? Number(attributes.get('height') ?? vh) / vh : 1
      matrix = [sx, 0, 0, sy, -vx * sx, -vy * sy]
    }
    const classes = (attributes.get('class') ?? '').split(/\s+/u)
    const id = attributes.get('data-id')
    if (name === 'g' && id !== undefined && classes.includes('pele-node')) {
      const node = nodes.get(id) ?? { id, label: undefined, boxes: [] }
      nodes.set(id, node)
      open.push({ node, depth: stack.length, min: [Infinity, Infinity], max: [-Infinity, -Infinity], lines: undefined })
    } else if (drawn !== undefined && SHAPES[name]) {
      for (const [x, y] of shapePoints(name, attributes)) {
        const px = matrix[0] * x + matrix[2] * y + matrix[4]
        const py = matrix[1] * x + matrix[3] * y + matrix[5]
        drawn.min = [Math.min(drawn.min[0], px), Math.min(drawn.min[1], py)]
        drawn.max = [Math.max(drawn.max[0], px), Math.max(drawn.max[1], py)]
      }
    } else if (drawn !== undefined && name === 'text' && classes.includes('pele-label') && labelDepth < 0) {
      labelDepth = stack.length
      drawn.lines ??= []
      drawn.lines.push('')
    } else if (drawn?.lines !== undefined && labelDepth >= 0 && name === 'tspan') {
      drawn.lines.push('')
    }
    if (!selfClosing) stack.push(matrix)
  }
  return [...nodes.values()].map(node => ({ id: node.id, label: node.label ?? '', boxes: node.boxes }))
}
