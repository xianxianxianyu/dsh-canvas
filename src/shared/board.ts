/**
 * JSON Canvas 1.0 boards (https://jsoncanvas.org/spec/1.0/): the types, validation with
 * `line:column`, where each element sits in the text, which file a node embeds, and the geometry
 * every painter shares. Pure; the host and the client both use it.
 */
import { measureLabel } from './diagram.ts'
import { sourceLocator, parseJson, type SourceLocator, type JsonMember, type JsonNode } from './json.ts'
import { modeOf, type ModeId } from './modes.ts'
import { ARTIFACT_ID_LIMIT, BOARD_TEXT_LIMIT } from './limits.ts'
import type { Diagnostic } from './report.ts'

export const SIDES = ['top', 'right', 'bottom', 'left'] as const
export type Side = (typeof SIDES)[number]
export const ENDS = ['none', 'arrow'] as const
export type End = (typeof ENDS)[number]
const NODE_TYPES = ['text', 'file', 'link', 'group'] as const
const BACKGROUND_STYLES = ['cover', 'ratio', 'repeat'] as const
/** A preset `"1"`–`"6"` (red, orange, yellow, green, cyan, purple) or a hex color. */
const COLOR = /^(?:[1-6]|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/u

interface Box {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly color?: string
}
export type TextNode = Box & { readonly type: 'text'; readonly text: string }
/** `file` is relative to the board's directory, or absolute. */
export type FileNode = Box & { readonly type: 'file'; readonly file: string; readonly subpath?: string }
export type LinkNode = Box & { readonly type: 'link'; readonly url: string }
export type GroupNode = Box & { readonly type: 'group'; readonly label?: string; readonly background?: string; readonly backgroundStyle?: (typeof BACKGROUND_STYLES)[number] }
export type BoardNode = TextNode | FileNode | LinkNode | GroupNode

export interface BoardEdge {
  readonly id: string
  readonly fromNode: string
  readonly fromSide?: Side
  readonly fromEnd?: End
  readonly toNode: string
  readonly toSide?: Side
  readonly toEnd?: End
  readonly color?: string
  readonly label?: string
}

export interface Board {
  readonly nodes: readonly BoardNode[]
  readonly edges: readonly BoardEdge[]
}

type JsonObject = JsonNode & { readonly kind: 'object' }
type JsonArray = JsonNode & { readonly kind: 'array' }

/** Where the board's parts sit in its text; `applyBoardOps` edits through this. */
export interface BoardLayout {
  readonly root: JsonObject
  /** The `"nodes"` and `"edges"` members, when the file has them. */
  readonly nodes?: { readonly member: JsonMember; readonly array: JsonArray }
  readonly edges?: { readonly member: JsonMember; readonly array: JsonArray }
  /** Every node's and edge's object in the text, by id. */
  readonly elements: ReadonlyMap<string, JsonObject>
}

/** A board that passed validation, with where its parts sit and its layout warnings. */
export interface ValidBoard {
  readonly ok: true
  readonly board: Board
  readonly layout: BoardLayout
  readonly warnings: readonly Diagnostic[]
}

export type ParsedBoard = ValidBoard | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

/**
 * Parse and validate a board. Only valid boards come back `ok`; every problem is reported, each at
 * the value that is wrong. Unknown fields are allowed and kept in the text.
 * @param text - the file's text.
 * @returns the board, its layout and layout warnings, or the errors.
 */
export function parseBoard(text: string): ParsedBoard {
  const locate = sourceLocator(text)
  const diagnosticAt = (offset: number, severity: Diagnostic['severity'], message: string): Diagnostic =>
    ({ severity, message, ...locate(offset) })
  if (!text.trim()) return { ok: false, diagnostics: [diagnosticAt(0, 'error', '画板文件是空的')] }
  const json = parseJson(text)
  if (!json.ok) return { ok: false, diagnostics: [diagnosticAt(json.offset, 'error', json.message)] }
  const problems: { readonly offset: number; readonly message: string }[] = []
  const problem = (offset: number, message: string): void => { problems.push({ offset, message }) }

  const { root } = json
  if (root.kind !== 'object') return { ok: false, diagnostics: [diagnosticAt(root.start, 'error', '画板的最外层必须是对象：{ "nodes": [...], "edges": [...] }')] }
  const rootFields = fieldsOf(root, '最外层', problem)
  const arrayOf = (key: 'nodes' | 'edges'): { member: JsonMember; array: JsonArray } | undefined => {
    const member = rootFields.get(key)
    if (member === undefined) return undefined
    if (member.value.kind !== 'array') {
      problem(member.value.start, `"${key}" 必须是数组`)
      return undefined
    }
    return { member, array: member.value }
  }
  const nodesAt = arrayOf('nodes')
  const edgesAt = arrayOf('edges')

  const elements = new Map<string, JsonObject>()
  /** Node ids written in the file, valid nodes or not: an edge to one of them is not dangling. */
  const named = new Set<string>()
  /** One element's id (reporting a missing or repeated one), its name for messages, and its field reader. */
  const open = (item: JsonObject, kind: '节点' | '连线', where: string) => {
    const idField = item.members.findLast(member => member.key === 'id')
    let id: string | undefined
    if (idField === undefined) problem(item.start, `${where}缺少 id（非空字符串）`)
    else if (idField.value.kind !== 'string' || !idField.value.value) problem(idField.value.start, `${where}的 id 必须是非空字符串`)
    else {
      id = idField.value.value
      if (id.length > ARTIFACT_ID_LIMIT) problem(idField.value.start, `${where}的 id 最长 ${ARTIFACT_ID_LIMIT} 个字符`)
      const earlier = elements.get(id)
      if (earlier !== undefined) problem(idField.value.start, `id "${id}" 重复（第 ${locate(earlier.start).line} 行已经用过）`)
      else elements.set(id, item)
    }
    const name = `${kind} ${id ?? `（${where}）`}`
    return { id, name, read: reader(item, fieldsOf(item, name, problem), name, problem) }
  }

  const nodes: BoardNode[] = []
  for (const [index, item] of (nodesAt?.array.items ?? []).entries()) {
    if (item.kind !== 'object') { problem(item.start, `nodes 的第 ${index + 1} 项不是对象`); continue }
    const { id, name, read } = open(item, '节点', `nodes 的第 ${index + 1} 项`)
    if (id !== undefined) named.add(id)
    const type = read.oneOf('type', NODE_TYPES, true, `${name} 的 type 必须是 text、file、link 或 group`)
    const box = { x: read.number('x'), y: read.number('y'), width: read.number('width', true), height: read.number('height', true), color: read.color() }
    let node: BoardNode | undefined
    if (type === 'text') {
      const text = read.string('text', '文字节点', '（字符串）')
      if (text !== undefined && text.length > BOARD_TEXT_LIMIT) problem(read.fields.get('text')!.value.start, `${name} 的 text 最长 ${BOARD_TEXT_LIMIT} 个字符`)
      if (text !== undefined) node = { id, type, text, ...box } as TextNode
    } else if (type === 'file') {
      const file = read.string('file', '文件节点', '（相对画板所在目录的路径）', true)
      const subpath = read.optionalString('subpath')
      if (subpath !== undefined && !subpath.startsWith('#')) problem(read.fields.get('subpath')!.value.start, `${name} 的 subpath 必须以 # 开头`)
      if (file !== undefined) node = { id, type, file, subpath, ...box } as FileNode
    } else if (type === 'link') {
      const url = read.string('url', '链接节点', '（网址）', true)
      if (url !== undefined) node = { id, type, url, ...box } as LinkNode
    } else if (type === 'group') {
      const label = read.optionalString('label')
      const background = read.optionalString('background')
      const backgroundStyle = read.oneOf('backgroundStyle', BACKGROUND_STYLES, false, `${name} 的 backgroundStyle 必须是 cover、ratio 或 repeat`)
      node = { id, type, label, background, backgroundStyle, ...box } as GroupNode
    }
    if (node !== undefined && id !== undefined) nodes.push(definedOnly(node))
  }
  const nodeIds = new Set(nodes.map(node => node.id))

  const edges: BoardEdge[] = []
  for (const [index, item] of (edgesAt?.array.items ?? []).entries()) {
    if (item.kind !== 'object') { problem(item.start, `edges 的第 ${index + 1} 项不是对象`); continue }
    const { id, name, read } = open(item, '连线', `edges 的第 ${index + 1} 项`)
    const end = (key: 'fromNode' | 'toNode'): string | undefined => {
      const value = read.string(key, '连线', '（节点 id）', true)
      // A node that is written but itself invalid is reported already; only an id nobody has makes the edge dangle.
      if (value !== undefined && !named.has(value)) problem(read.fields.get(key)!.value.start, `${name} 的 ${key} 指向不存在的节点 "${value}"`)
      return value !== undefined && nodeIds.has(value) ? value : undefined
    }
    const fromNode = end('fromNode')
    const fromSide = read.oneOf('fromSide', SIDES, false, `${name} 的 fromSide 必须是 top、right、bottom 或 left`)
    const fromEnd = read.oneOf('fromEnd', ENDS, false, `${name} 的 fromEnd 必须是 none 或 arrow`)
    const toNode = end('toNode')
    const toSide = read.oneOf('toSide', SIDES, false, `${name} 的 toSide 必须是 top、right、bottom 或 left`)
    const toEnd = read.oneOf('toEnd', ENDS, false, `${name} 的 toEnd 必须是 none 或 arrow`)
    const color = read.color()
    const label = read.optionalString('label')
    if (id !== undefined && fromNode !== undefined && toNode !== undefined) {
      edges.push(definedOnly({ id, fromNode, fromSide, fromEnd, toNode, toSide, toEnd, color, label }))
    }
  }

  if (problems.length) {
    const sorted = problems.map((entry, order) => ({ ...entry, order })).sort((a, b) => a.offset - b.offset || a.order - b.order)
    return { ok: false, diagnostics: sorted.map(entry => diagnosticAt(entry.offset, 'error', entry.message)) }
  }
  const layout: BoardLayout = { root, ...nodesAt ? { nodes: nodesAt } : {}, ...edgesAt ? { edges: edgesAt } : {}, elements }
  return { ok: true, board: { nodes, edges }, layout, warnings: layoutWarnings(locate, layout, nodeIds) }
}

type Fields = ReadonlyMap<string, JsonMember>

/** The members of an object by key (the last of a repeated key, as JSON.parse keeps), reporting each repeat. */
function fieldsOf(object: JsonObject, name: string, problem: (offset: number, message: string) => void): Fields {
  const fields = new Map<string, JsonMember>()
  for (const member of object.members) {
    if (fields.has(member.key)) problem(member.keySpan.start, `${name} 的 "${member.key}" 写了两次`)
    fields.set(member.key, member)
  }
  return fields
}

/** Typed field reads for one element; each problem is reported at the value, or at the element when the field is missing. */
function reader(item: JsonObject, fields: Fields, name: string, problem: (offset: number, message: string) => void) {
  return {
    fields,
    number(key: string, positive = false): number | undefined {
      const field = fields.get(key)
      if (field === undefined) return void problem(item.start, `${name} 缺少 ${key}（数字）`)
      if (field.value.kind !== 'number') return void problem(field.value.start, `${name} 的 ${key} 必须是数字`)
      if (positive && field.value.value <= 0) return void problem(field.value.start, `${name} 的 ${key} 必须大于 0`)
      return field.value.value
    },
    string(key: string, kind: string, hint: string, nonEmpty = false): string | undefined {
      const field = fields.get(key)
      const who = name.replace(/^(节点|连线)/u, kind)
      if (field === undefined) return void problem(item.start, `${who} 缺少 ${key}${hint}`)
      if (field.value.kind !== 'string' || (nonEmpty && !field.value.value)) return void problem(field.value.start, `${who} 的 ${key} 必须是${nonEmpty ? '非空' : ''}字符串`)
      return field.value.value
    },
    optionalString(key: string): string | undefined {
      const field = fields.get(key)
      if (field === undefined) return undefined
      if (field.value.kind !== 'string') return void problem(field.value.start, `${name} 的 ${key} 必须是字符串`)
      return field.value.value
    },
    oneOf<T extends string>(key: string, values: readonly T[], required: boolean, message: string): T | undefined {
      const field = fields.get(key)
      if (field === undefined) return required ? void problem(item.start, `${name} 缺少 ${key}`) : undefined
      if (field.value.kind !== 'string' || !(values as readonly string[]).includes(field.value.value)) return void problem(field.value.start, message)
      return field.value.value as T
    },
    color(): string | undefined {
      const field = fields.get('color')
      if (field === undefined) return undefined
      if (field.value.kind !== 'string' || !COLOR.test(field.value.value)) return void problem(field.value.start, `${name} 的 color 必须是 "1" 到 "6"，或 #rgb / #rrggbb 颜色`)
      return field.value.value
    },
  }
}

/** The typed board leaves absent optional fields out, as the file does. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

/** One warning when elements do not sit one per line: the route still edits them, but a drag no longer changes one line. */
function layoutWarnings(locate: SourceLocator, layout: BoardLayout, nodeIds: ReadonlySet<string>): Diagnostic[] {
  const spans = [...layout.elements].map(([id, object]) => ({ id, start: locate(object.start).line, end: locate(object.end - 1).line, offset: object.start }))
  const perLine = new Map<number, number>()
  for (const span of spans) perLine.set(span.start, (perLine.get(span.start) ?? 0) + 1)
  for (const span of spans) if (span.end !== span.start) perLine.set(span.end, (perLine.get(span.end) ?? 0) + 1)
  const crowded = spans.filter(span => span.start !== span.end || perLine.get(span.start)! > 1).sort((a, b) => a.offset - b.offset)
  if (!crowded.length) return []
  const first = crowded[0]!
  const { line, column } = locate(first.offset)
  return [{
    severity: 'warning', line, column,
    message: `${crowded.length} 个元素没有各占一行（第一个是${nodeIds.has(first.id) ? '节点' : '连线'} ${first.id}）；规范格式是每个节点、每条连线各占一行，界面拖动时只改那一行`,
  }]
}

/** What kind of file a node embeds: a canvas mode, a Markdown note, an image, or something a board cannot show. */
export type EmbedKind = ModeId | 'note' | 'image' | 'other'

const NOTE_EXTENSIONS = ['md', 'markdown']
const IMAGE_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' }

/** The media type of an embeddable image path, or undefined. */
export function imageType(path: string): string | undefined {
  return IMAGE_TYPES[extensionOf(path)]
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Posix normalization without node:path, so the browser bundle can use it. */
function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/**
 * The file a node embeds: `file` relative to the board's directory (not the Session's), or
 * absolute; and its kind by suffix.
 * @param boardPath - the board's absolute path.
 * @param file - the node's `file`.
 */
export function embedOf(boardPath: string, file: string): { readonly path: string; readonly kind: EmbedKind } {
  const path = normalize(file.startsWith('/') ? file : `${boardPath.slice(0, boardPath.lastIndexOf('/'))}/${file}`)
  const mode = modeOf(path)
  if (mode !== undefined) return { path, kind: mode }
  const extension = extensionOf(path)
  return { path, kind: NOTE_EXTENSIONS.includes(extension) ? 'note' : imageType(path) !== undefined ? 'image' : 'other' }
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface SceneNode {
  readonly id: string
  readonly node: BoardNode
  readonly rect: Rect
}

export interface SceneEdge {
  readonly id: string
  readonly edge: BoardEdge
  readonly from: Point & { readonly side: Side }
  readonly to: Point & { readonly side: Side }
  /** Cubic Bézier control points, leaving each side straight out. */
  readonly c1: Point
  readonly c2: Point
  /** The curve's midpoint, where the label goes. */
  readonly mid: Point
  /** JSON Canvas defaults: no arrow at `from`, an arrow at `to`. */
  readonly arrows: { readonly from: boolean; readonly to: boolean }
}

export interface Scene {
  /** Everything drawn: node boxes and edge curves. */
  readonly bounds: Rect
  /** Groups first (larger ones further down), then the other nodes in file order. */
  readonly nodes: readonly SceneNode[]
  readonly edges: readonly SceneEdge[]
  /** Pairs of non-group nodes whose boxes overlap, `a` before `b` in the file. */
  readonly overlaps: readonly { readonly a: string; readonly b: string; readonly rect: Rect }[]
}

const center = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })

/** The side of `from` that faces `to`, as JSON Canvas viewers pick it when the file leaves it out. */
function facing(from: Rect, to: Rect): Side {
  const a = center(from)
  const b = center(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) * from.height >= Math.abs(dy) * from.width) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

function anchor(rect: Rect, side: Side): Point & { readonly side: Side } {
  const { x, y } = center(rect)
  if (side === 'top') return { x, y: rect.y, side }
  if (side === 'bottom') return { x, y: rect.y + rect.height, side }
  return { x: side === 'left' ? rect.x : rect.x + rect.width, y, side }
}

const NORMALS: { readonly [S in Side]: Point } = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } }

function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

/**
 * Board geometry shared by every painter: boxes, edge curves, overlaps and bounds.
 * @param board - a valid board (edges point at existing nodes).
 */
export function scene(board: Board): Scene {
  const rects = new Map(board.nodes.map(node => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]))
  const groups = board.nodes.filter(node => node.type === 'group').sort((a, b) => b.width * b.height - a.width * a.height)
  const nodes = [...groups, ...board.nodes.filter(node => node.type !== 'group')].map(node => ({ id: node.id, node, rect: rects.get(node.id)! }))

  const edges = board.edges.map((edge): SceneEdge => {
    const a = rects.get(edge.fromNode)!
    const b = rects.get(edge.toNode)!
    const from = anchor(a, edge.fromSide ?? facing(a, b))
    const to = anchor(b, edge.toSide ?? facing(b, a))
    const reach = Math.round(Math.min(Math.max(Math.hypot(to.x - from.x, to.y - from.y) / 2, 40), 160))
    const c1 = { x: from.x + NORMALS[from.side].x * reach, y: from.y + NORMALS[from.side].y * reach }
    const c2 = { x: to.x + NORMALS[to.side].x * reach, y: to.y + NORMALS[to.side].y * reach }
    const mid = { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 }
    return { id: edge.id, edge, from, to, c1, c2, mid, arrows: { from: (edge.fromEnd ?? 'none') === 'arrow', to: (edge.toEnd ?? 'arrow') === 'arrow' } }
  })

  const solid = board.nodes.filter(node => node.type !== 'group')
  const overlaps: { a: string; b: string; rect: Rect }[] = []
  for (const [index, first] of solid.entries()) {
    for (const second of solid.slice(index + 1)) {
      const rect = intersection(rects.get(first.id)!, rects.get(second.id)!)
      if (rect !== undefined) overlaps.push({ a: first.id, b: second.id, rect })
    }
  }

  const points = [
    ...nodes.flatMap(({ rect }) => [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }]),
    ...edges.flatMap(edge => [edge.from, edge.to, edge.c1, edge.c2]),
  ]
  if (!points.length) return { bounds: { x: 0, y: 0, width: 0, height: 0 }, nodes, edges, overlaps }
  const left = Math.min(...points.map(point => point.x))
  const top = Math.min(...points.map(point => point.y))
  return {
    bounds: { x: left, y: top, width: Math.max(...points.map(point => point.x)) - left, height: Math.max(...points.map(point => point.y)) - top },
    nodes, edges, overlaps,
  }
}

/** Note box metrics; the board page's CSS is written from these, so the estimate below matches what is drawn. */
export const NOTE_TEXT = { size: 14, lineHeight: 1.5, padding: 12, border: 2, headings: [20, 17, 15] } as const
/** A file node's name bar and the padding around what it embeds, in the same page. */
export const FILE_NODE = { header: 24, padding: 8 } as const

/**
 * Roughly how tall a box of `width` must be to show a Markdown note, measured with pele's character
 * width table: enough to warn that a box cuts its text off, not a layout engine.
 */
export function noteHeight(markdown: string, width: number): number {
  const frame = NOTE_TEXT.padding + NOTE_TEXT.border
  const inner = Math.max(1, width - 2 * frame)
  let height = 2 * frame
  for (const raw of markdown.split('\n')) {
    if (!raw.trim()) { height += NOTE_TEXT.size * NOTE_TEXT.lineHeight / 3; continue }
    const heading = /^(#{1,6})\s+/u.exec(raw)
    const item = /^\s*(?:[-*+]|\d+\.)\s+/u.exec(raw)
    const size = heading ? NOTE_TEXT.headings[Math.min(heading[1]!.length, 3) - 1]! : NOTE_TEXT.size
    const line = raw.slice((heading ?? item)?.[0].length ?? 0).replace(/[*_`~]/gu, '')
    const lines = Math.max(1, Math.ceil(measureLabel(line, size) / (inner - (item ? 20 : 0))))
    height += lines * size * NOTE_TEXT.lineHeight
  }
  return Math.ceil(height)
}
