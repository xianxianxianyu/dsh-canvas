/**
 * Recent user intent, not an undo log or a second file store. DSH may run without its optional
 * observation policy, so an agent's whole-file write can erase an acknowledged route edit.
 * Keep at most 20 applied batches per canonical board in this host lifetime and dry-run them
 * when checked. Only replayable `applied` outcomes are loss; missing targets and text conflicts
 * remain conflicts, not a reason to blindly restore content. Restart/eviction ends this coverage.
 */
import { applyBoardOps, type OpStatus } from '../shared/board-ops.ts'
import type { BoardOp } from '../shared/board-schema.ts'
import type { FileSystem, FsTarget } from './dsh.ts'
import { writeBoardOps, type BoardWrite } from './board-write.ts'

export const BOARD_JOURNAL_LIMIT = 20

export interface BoardBatch {
  readonly id: string
  readonly at: string
  readonly ops: readonly BoardOp[]
}

export interface LostBoardBatch extends BoardBatch {
  /** Number of operations whose intended result is no longer present and can be reapplied. */
  readonly count: number
}

/** A newer successful user action retires older intent on the same field/entity. */
function remaining(old: BoardOp, next: BoardOp): BoardOp | undefined {
  if (next.op === 'removeNodes') {
    const removed = new Set(next.ids)
    if (old.op === 'removeNodes') {
      const ids = old.ids.filter(id => !removed.has(id))
      return ids.length ? { ...old, ids } : undefined
    }
    if (removed.has(old.id) || (old.op === 'addEdge' && (removed.has(old.fromNode) || removed.has(old.toNode)))) return undefined
  }
  if (next.op === 'addNote' && old.op === 'removeNodes') {
    const ids = old.ids.filter(id => id !== next.id)
    return ids.length ? { ...old, ids } : undefined
  }
  if ('id' in next && 'id' in old && next.id === old.id) {
    if (next.op === old.op) return undefined
    if ((next.op === 'addEdge' || next.op === 'removeEdge') && (old.op === 'addEdge' || old.op === 'removeEdge')) return undefined
  }
  return old
}

export class BoardJournal {
  private readonly batches = new Map<string, readonly BoardBatch[]>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private sequence = 0

  /**
   * Serialize only route writes to one board, so publication order and journal order agree.
   * The agent is outside this queue: writeBoardOps still uses provider CAS against it.
   * Journal recording is synchronous after the file write and before the request resolves;
   * it is not crash-atomic with the disk, and no journal entry is promised before success.
   */
  async apply(fs: Pick<FileSystem, 'stat' | 'readText' | 'writeText'>, target: FsTarget, path: string, ops: readonly BoardOp[], signal: AbortSignal): Promise<BoardWrite> {
    const previous = this.pending.get(path) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted()
      const outcome = await writeBoardOps(fs, target, ops, signal)
      if (outcome.kind === 'done') this.record(path, ops, outcome.statuses)
      return outcome
    })
    this.pending.set(path, current)
    try {
      return await current
    } finally {
      if (this.pending.get(path) === current) this.pending.delete(path)
    }
  }

  private record(path: string, ops: readonly BoardOp[], statuses: readonly OpStatus[]): void {
    const applied = ops.filter((_, index) => statuses[index] === 'applied')
    if (!applied.length) return // retries, conflicts and refusals do not create fictitious history
    let batches = [...(this.batches.get(path) ?? [])]
    const batch: BoardBatch = { id: `board-${++this.sequence}`, at: new Date().toISOString(), ops: [] }
    batches.push(batch)
    for (let next of applied) {
      // A later move supersedes position, but preserves a previous explicit resize when omitted.
      if (next.op === 'place') {
        for (const prior of batches) for (const old of prior.ops) {
          if (old.op === 'place' && old.id === next.id) next = { ...old, ...next }
        }
      }
      batches = batches.map(prior => ({ ...prior, ops: prior.ops.flatMap(old => {
        const keep = remaining(old, next)
        return keep === undefined ? [] : [keep]
      }) }))
      const last = batches[batches.length - 1]!
      batches[batches.length - 1] = { ...last, ops: [...last.ops, next] }
    }
    this.batches.set(path, batches.filter(entry => entry.ops.length).slice(-BOARD_JOURNAL_LIMIT))
  }

  /** Pure inspection of the supplied file snapshot; never writes or refreshes agent observation. */
  lost(path: string, text: string): readonly LostBoardBatch[] {
    return (this.batches.get(path) ?? []).flatMap(batch => {
      const replay = applyBoardOps(text, batch.ops)
      if (!replay.ok) return [] // normal board validation reports invalid source instead
      const count = replay.statuses.filter(status => status === 'applied').length
      return count ? [{ ...batch, count }] : []
    })
  }
}
