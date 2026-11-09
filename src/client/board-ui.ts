import { parseBoard, type Board, type Side } from '../shared/board.ts'
import type { BoardOp } from '../shared/board-schema.ts'
import type { Diagnostic } from '../shared/report.ts'

/** A file read is authoritative: no position, size or text is merged from optimistic UI state. */
export type BoardState =
  | { readonly kind: 'ready'; readonly board: Board }
  | { readonly kind: 'invalid-source'; readonly diagnostics: readonly Diagnostic[] }

export function reconcile(source: string): BoardState {
  const parsed = parseBoard(source)
  return parsed.ok ? { kind: 'ready', board: parsed.board } : { kind: 'invalid-source', diagnostics: parsed.diagnostics }
}

/** Only gesture completion constructs a write; pointer frames stay inside React Flow. */
export function placeOp(id: string, box: { readonly x: number; readonly y: number; readonly width?: number; readonly height?: number }): BoardOp {
  return { op: 'place', id, x: Math.round(box.x), y: Math.round(box.y),
    ...box.width === undefined ? {} : { width: Math.round(box.width) },
    ...box.height === undefined ? {} : { height: Math.round(box.height) } }
}

export function connectOp(id: string, connection: { readonly source: string; readonly target: string; readonly sourceHandle: string | null; readonly targetHandle: string | null }, label: string): BoardOp {
  return { op: 'addEdge', id, fromNode: connection.source, toNode: connection.target,
    ...connection.sourceHandle === null ? {} : { fromSide: connection.sourceHandle as Side },
    ...connection.targetHandle === null ? {} : { toSide: connection.targetHandle as Side },
    ...label ? { label } : {} }
}

/** Node deletion already removes incident edges in the host. */
export function removeOps(nodes: readonly string[], edges: readonly { readonly id: string; readonly source: string; readonly target: string }[]): BoardOp[] {
  const removed = new Set(nodes)
  return [
    ...nodes.length ? [{ op: 'removeNodes' as const, ids: [...nodes] }] : [],
    ...edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)).map(edge => ({ op: 'removeEdge' as const, id: edge.id })),
  ]
}

export interface LostBatch {
  readonly id: string
  readonly at: string
  readonly count: number
  readonly ops: readonly BoardOp[]
}

/** Decline is local to this tab, not a claim that the host's retained intent disappeared. */
export function visibleLosses(lost: readonly LostBatch[], dismissed: ReadonlySet<string>): readonly LostBatch[] {
  return lost.filter(batch => !dismissed.has(batch.id))
}

/** Works on the plain-http DSH web client too, where randomUUID is unavailable. */
export function boardId(): string {
  return `u-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
