/**
 * The person's board edits as text edits. Each operation is absolute and found by id, so a batch
 * replayed on its own result changes nothing, and replayed on someone else's newer text it lands
 * on top of their changes. Consecutive field edits share one parse and one splice pass; structural
 * edits refresh offsets at their boundary. A deletion removes its nodes and incident edges together.
 * Every other byte stays as it was. Pure; the host's write protocol (`src/host/board-write.ts`)
 * runs it between reading and writing the file.
 */
import { parseBoard, type BoardLayout, type ValidBoard } from './board.ts'
import type { BoardOp } from './board-schema.ts'
import type { JsonNode } from './json.ts'
import type { Diagnostic } from './report.ts'

/**
 * `applied`: the file changed. `unchanged`: it already said so (a replay, or someone did the same).
 * `missing`: the node it needs is gone. `conflict`: the id or the note text is not what the op expects.
 */
export type OpStatus = 'applied' | 'unchanged' | 'missing' | 'conflict'

export type BoardEdit =
  | { readonly ok: true; readonly text: string; readonly statuses: readonly OpStatus[] }
  /** The text is not a valid board; nothing may be written over it. */
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

interface Splice {
  readonly start: number
  readonly end: number
  readonly insert: string
}

type JsonObject = JsonNode & { readonly kind: 'object' }

/** The text so far and its parse; offsets refresh only after a committed group of splices. */
interface Draft {
  text: string
  parsed: ValidBoard
}

function commit(draft: Draft, splices: Splice[]): void {
  const parts: string[] = []
  let from = 0
  for (const splice of splices.sort((a, b) => a.start - b.start)) {
    parts.push(draft.text.slice(from, splice.start), splice.insert)
    from = splice.end
  }
  parts.push(draft.text.slice(from))
  draft.text = parts.join('')
  const next = parseBoard(draft.text)
  // Every op keeps ids unique and edges attached, so this is a defect, never the person's input.
  if (!next.ok) throw new Error(`canvas: a board edit produced an invalid board: ${next.diagnostics[0]!.message}`)
  draft.parsed = next
}

/**
 * Apply a batch, in order, each operation on the result of the one before.
 * @param text - the board as read.
 * @param ops - the person's operations.
 * @returns the new text and one status per operation, or the diagnostics of a text that is not a valid board.
 */
export function applyBoardOps(text: string, ops: readonly BoardOp[]): BoardEdit {
  const parsed = parseBoard(text)
  if (!parsed.ok) return parsed
  const draft: Draft = { text, parsed }
  const statuses: OpStatus[] = []
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!
    if (op.op === 'place' || op.op === 'setText') index = applyFields(draft, ops, index, statuses)
    else { statuses.push(applyOne(draft, op)); index++ }
  }
  return { ok: true, text: draft.text, statuses }
}

/** Keep sequential field semantics in an id index, then rewrite every touched span once. */
function applyFields(draft: Draft, ops: readonly BoardOp[], from: number, statuses: OpStatus[]): number {
  const nodes = new Map(draft.parsed.board.nodes.map(node => [node.id, node]))
  const pending = new Map<string, Record<string, unknown>>()
  let index = from
  for (; index < ops.length; index++) {
    const op = ops[index]!
    if (op.op !== 'place' && op.op !== 'setText') break
    const node = nodes.get(op.id)
    if (node === undefined) { statuses.push('missing'); continue }
    let changes: Record<string, unknown>
    if (op.op === 'place') {
      changes = Object.fromEntries((['x', 'y', 'width', 'height'] as const).flatMap(key => op[key] !== undefined && op[key] !== node[key] ? [[key, op[key]]] : []))
      if (!Object.keys(changes).length) { statuses.push('unchanged'); continue }
    } else {
      if (node.type !== 'text') { statuses.push('conflict'); continue }
      if (node.text === op.text) { statuses.push('unchanged'); continue }
      if (node.text !== op.ifText) { statuses.push('conflict'); continue }
      changes = { text: op.text }
    }
    nodes.set(op.id, { ...node, ...changes })
    pending.set(op.id, Object.assign(pending.get(op.id) ?? {}, changes))
    statuses.push('applied')
  }
  if (pending.size) commit(draft, [...pending].map(([id, changes]) => rewrite(draft.text, draft.parsed.layout.elements.get(id)!, changes)))
  return index
}

function applyOne(draft: Draft, op: Exclude<BoardOp, { readonly op: 'place' | 'setText' }>): OpStatus {
  const { board, layout } = draft.parsed
  const node = 'id' in op ? board.nodes.find(candidate => candidate.id === op.id) : undefined
  const element = 'id' in op ? layout.elements.get(op.id) : undefined
  switch (op.op) {
    case 'addNote': {
      if (element !== undefined) return node?.type === 'text' ? 'unchanged' : 'conflict'
      const { id, text, x, y, width, height, color } = op
      commit(draft, [append(draft.text, layout, 'nodes', JSON.stringify({ id, type: 'text', text, x, y, width, height, color }))])
      return 'applied'
    }
    case 'addEdge': {
      if (element !== undefined) {
        const edge = board.edges.find(candidate => candidate.id === op.id)
        return edge?.fromNode === op.fromNode && edge.toNode === op.toNode ? 'unchanged' : 'conflict'
      }
      if (!board.nodes.some(candidate => candidate.id === op.fromNode) || !board.nodes.some(candidate => candidate.id === op.toNode)) return 'missing'
      const { id, fromNode, fromSide, toNode, toSide, label } = op
      commit(draft, [append(draft.text, layout, 'edges', JSON.stringify({ id, fromNode, fromSide, toNode, toSide, label }))])
      return 'applied'
    }
    case 'removeEdge': {
      if (!board.edges.some(edge => edge.id === op.id)) return 'unchanged'
      commit(draft, [remove(layout.edges!.array, element!)])
      return 'applied'
    }
    case 'removeNodes': {
      const ids = new Set(op.ids)
      const gone = new Set<JsonNode>(board.nodes.filter(node => ids.has(node.id)).map(node => layout.elements.get(node.id)!))
      for (const edge of board.edges) if (ids.has(edge.fromNode) || ids.has(edge.toNode)) gone.add(layout.elements.get(edge.id)!)
      if (!gone.size) return 'unchanged'
      const splices: Splice[] = []
      for (const at of [layout.nodes, layout.edges]) {
        if (at === undefined) continue
        const { array } = at
        if (array.items.length && array.items.every(item => gone.has(item))) {
          splices.push({ start: array.start + 1, end: array.end - 1, insert: '' })
          continue
        }
        for (let index = 0; index < array.items.length;) {
          if (!gone.has(array.items[index]!)) { index++; continue }
          const first = index
          while (index < array.items.length && gone.has(array.items[index]!)) index++
          splices.push(index === array.items.length
            ? { start: array.items[first - 1]!.end, end: array.items[index - 1]!.end, insert: '' }
            : { start: array.items[first]!.start, end: array.items[index]!.start, insert: '' })
        }
      }
      commit(draft, splices)
      return 'applied'
    }
  }
}

/**
 * Untouched members keep their exact source spans, including multiline extension values.
 * Changed members use JSON.stringify; only separators between members are compacted.
 */
function rewrite(text: string, element: JsonObject, changes: Readonly<Record<string, unknown>>): Splice {
  const members = element.members.map(member => {
    if (Object.hasOwn(changes, member.key)) return `${JSON.stringify(member.key)}:${JSON.stringify(changes[member.key])}`
    return text.slice(member.keySpan.start, member.value.end)
  })
  for (const [key, value] of Object.entries(changes)) {
    if (!element.members.some(member => member.key === key)) members.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`)
  }
  return { start: element.start, end: element.end, insert: `{${members.join(',')}}` }
}

/** The whitespace that starts the line `offset` is on, when nothing else comes before `offset` on it. */
function indentAt(text: string, offset: number): string | undefined {
  const lead = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset)
  return /^[ \t]*$/u.test(lead) ? lead : undefined
}

/** A new element after the last one in `which`, in the file's own indentation and line ending; opens the array when it is empty or absent. */
function append(text: string, layout: BoardLayout, which: 'nodes' | 'edges', element: string): Splice {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const spaces = /^( +)\S/mu.exec(text)?.[1]
  const unit = /^\t/mu.test(text) || spaces === undefined ? '\t' : spaces
  const at = layout[which]
  const last = at?.array.items.at(-1)
  if (last !== undefined) {
    const indent = indentAt(text, last.start)
    return { start: last.end, end: last.end, insert: indent === undefined ? `,${element}` : `,${eol}${indent}${element}` }
  }
  if (at !== undefined) {
    const indent = indentAt(text, at.member.keySpan.start) ?? ''
    return { start: at.array.start + 1, end: at.array.end - 1, insert: `${eol}${indent}${unit}${element}${eol}${indent}` }
  }
  const lastMember = layout.root.members.at(-1)
  if (lastMember === undefined) {
    return { start: layout.root.start + 1, end: layout.root.end - 1, insert: `${eol}${unit}"${which}":[${eol}${unit}${unit}${element}${eol}${unit}]${eol}` }
  }
  const indent = indentAt(text, lastMember.keySpan.start) ?? ''
  return { start: lastMember.value.end, end: lastMember.value.end, insert: `,${eol}${indent}"${which}":[${eol}${indent}${unit}${element}${eol}${indent}]` }
}

/** The element and one separator next to it; the only element leaves `[]`. */
function remove(array: JsonNode & { readonly kind: 'array' }, element: JsonNode): Splice {
  const index = array.items.indexOf(element)
  if (array.items.length === 1) return { start: array.start + 1, end: array.end - 1, insert: '' }
  if (index < array.items.length - 1) return { start: element.start, end: array.items[index + 1]!.start, insert: '' }
  return { start: array.items[index - 1]!.end, end: element.end, insert: '' }
}
