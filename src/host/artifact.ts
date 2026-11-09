import { modeOf, type ModeId } from '../shared/modes.ts'
import type { FileSystem, FsTarget } from './dsh.ts'

export interface Artifact {
  readonly target: FsTarget
  /** The canonical absolute path (symlinks resolved): the file's identity, and its comment store key. */
  readonly path: string
  /** The canvas mode owning the file, if any. */
  readonly mode: ModeId | undefined
}

/**
 * Resolve a canvas file as DSH's file tools do: an absolute path as is, a relative one against
 * `cwd`. `canvas_check`, `canvas_comment` and the comment route all use this, so one file always
 * reaches one comment store.
 * @param fs - the Session filesystem.
 * @param path - what the caller wrote.
 * @param cwd - the directory relative paths start from.
 * @param signal - cancels the resolution.
 * @returns the target, its canonical path, and its mode.
 */
export async function resolveArtifact(fs: Pick<FileSystem, 'resolve' | 'processPath'>, path: string, cwd: string | undefined, signal: AbortSignal): Promise<Artifact> {
  const target = await fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal })
  const canonical = fs.processPath(target)
  return { target, path: canonical, mode: modeOf(canonical) ?? modeOf(path) }
}
