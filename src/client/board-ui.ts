import { parseBoard, type Board, type Side } from '../shared/board.ts'
import type { BoardOp } from '../shared/board-schema.ts'
import type { Diagnostic } from '../shared/report.ts'
import type { DocumentBodyProps } from './dsh.ts'

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

/** Human recovery copy only; the retained operations remain unchanged for replay and agent checks. */
export function describeRecoveryOp(op: BoardOp, board: Board | undefined, t: DocumentBodyProps['t']): string {
  const quote = (label: string): string => t('board.recovery.target', { label })
  const nodeLabel = (id: string): string => {
    const node = board?.nodes.find(candidate => candidate.id === id)
    const label = node?.type === 'group' ? node.label?.trim()
      : node?.type === 'file' ? node.file.split('/').at(-1)
        : node?.type === 'text' ? firstLine(node.text) : undefined
    return quote(label || id)
  }
  switch (op.op) {
    case 'place':
    case 'addNote': {
      const size = (op.width === undefined ? '' : t('board.recovery.width', { width: op.width }))
        + (op.height === undefined ? '' : t('board.recovery.height', { height: op.height }))
      if (op.op === 'place' && (op.x === undefined || op.y === undefined)) {
        const position = (op.x === undefined ? '' : t('board.recovery.x', { x: op.x }))
          + (op.y === undefined ? '' : t('board.recovery.y', { y: op.y }))
        return t('board.recovery.fields', { target: nodeLabel(op.id), fields: position + size })
      }
      return t(`board.recovery.${op.op}`, { target: op.op === 'place' ? nodeLabel(op.id) : quote(firstLine(op.text) || op.id), x: op.x, y: op.y, size })
    }
    case 'setText': {
      const text = firstLine(op.text)
      return t('board.recovery.setText', { target: nodeLabel(op.id), text: text ? quote(text) : t('board.recovery.emptyText') })
    }
    case 'addEdge':
      return t('board.recovery.addEdge', { edge: quote(op.label?.trim() || op.id), from: nodeLabel(op.fromNode), to: nodeLabel(op.toNode) })
    case 'removeEdge': {
      const edge = board?.edges.find(candidate => candidate.id === op.id)
      return edge === undefined ? t('board.recovery.removeMissingEdge', { edge: quote(op.id) })
        : t('board.recovery.removeEdge', { edge: quote(edge.label?.trim() || edge.id), from: nodeLabel(edge.fromNode), to: nodeLabel(edge.toNode) })
    }
    case 'removeNodes':
      return t('board.recovery.removeNodes', { targets: op.ids.map(nodeLabel).join(t('board.recovery.separator')) })
  }
}

function firstLine(text: string): string {
  return text.trim().split(/[\r\n]/u, 1)[0]!.replace(/^#{1,6}(?:[ \t]+|$)/u, '').trim()
}

/** Works on the plain-http DSH web client too, where randomUUID is unavailable. */
export function boardId(): string {
  return `u-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
