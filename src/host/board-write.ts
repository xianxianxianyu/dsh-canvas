/**
 * The board write protocol: how the person's operations reach a `.canvas` file the agent may be
 * editing at the same moment. The agent's side needs nothing from this plugin: DSH's
 * fs-observation-policy makes every `edit` and overwriting `write` carry the version the agent last
 * read, so a file the route changed fails the agent's next edit with FS_STALE_VERSION and it
 * re-reads. This module guards the person's side with the same version check and, when it loses,
 * replays the operations on whatever is current. PLAN appendix B 单元 4「写回协议」; unit 4b models
 * exactly the steps numbered below.
 */
import { applyBoardOps, type OpStatus } from '../shared/board-ops.ts'
import type { BoardOp } from '../shared/board-schema.ts'
import type { Diagnostic } from '../shared/report.ts'
import type { FileSystem, FsTarget } from './dsh.ts'

/** Rounds before giving up. A round is lost only to a write that landed inside it. */
export const MAX_ATTEMPTS = 3

export type BoardWrite =
  /** Written (or nothing to write); `version` is the file's version now. */
  | { readonly kind: 'done'; readonly version: string; readonly statuses: readonly OpStatus[] }
  /** The file is not a valid board; nothing was written. */
  | { readonly kind: 'invalid-source'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'not-found' }
  /** Every round lost to another writer; nothing of this batch was written, and resending it is safe. */
  | { readonly kind: 'busy' }

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * Apply the person's operations to a board file without ever overwriting a write made since it was read.
 * @param fs - the Session filesystem (DSH's `ctx.fs`).
 * @param target - the resolved `.canvas` file.
 * @param ops - the operations, already parsed at the route's boundary.
 * @param signal - cancels between steps.
 * @returns what happened; every outcome except `done` left the file untouched by this call.
 */
export async function writeBoardOps(fs: Pick<FileSystem, 'stat' | 'readText' | 'writeText'>, target: FsTarget, ops: readonly BoardOp[], signal: AbortSignal): Promise<BoardWrite> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 1. The version. Read before the text, so a write landing between the two makes step 4 refuse.
    const info = await fs.stat(target, signal)
    if (info?.type !== 'file') return { kind: 'not-found' }
    // 2. The text.
    let text: string
    try {
      text = await fs.readText(target, signal)
    } catch (error) {
      if (codeOf(error) === 'FS_NOT_FOUND') return { kind: 'not-found' }
      throw error
    }
    // 3. Parse and apply; a file that is not a valid board is never written over.
    const edit = applyBoardOps(text, ops)
    if (!edit.ok) return { kind: 'invalid-source', diagnostics: edit.diagnostics }
    // Nothing changed (a replay, or nothing left to do): no write, so the agent's view stays current.
    if (edit.text === text) return { kind: 'done', version: info.version, statuses: edit.statuses }
    // 4. Write only over the version read in step 1.
    try {
      const written = await fs.writeText(target, edit.text, { kind: 'replaceIfVersion', version: info.version }, signal)
      return { kind: 'done', version: written.version, statuses: edit.statuses }
    } catch (error) {
      // 5. Someone wrote after step 1: start over from their text.
      if (codeOf(error) !== 'FS_STALE_VERSION') throw error
    }
  }
  return { kind: 'busy' }
}
