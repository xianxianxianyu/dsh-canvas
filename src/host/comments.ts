/**
 * The comment store: `<root>/comments/<sha256(artifact path)>.jsonl`, a header line naming the
 * artifact, then one comment per line. This module is the only writer. The route and
 * `canvas_comment` run in this host process and share one store, so every change to a file runs
 * on that file's promise chain (read, apply, write a temporary file, rename over the old one).
 * Serialized, atomic and idempotent by comment id: no version check or retry is needed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { commentSchema, storeHeaderSchema, type Comment, type CommentsSnapshot } from '../shared/comment-schema.ts'
import { applyOps, isReply, type Actor, type CommentOp, type OpRejection } from '../shared/comments.ts'

/** An operation the rules refused; the route maps `code` to an HTTP status, the tool reports `message`. */
export class CommentRejected extends Error {
  readonly code: OpRejection['code']

  constructor(code: OpRejection['code'], message: string) {
    super(message)
    this.code = code
  }
}

const EMPTY: CommentsSnapshot = { version: 'empty', comments: [] }

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Parse a store file at the boundary: the header must name this artifact, every line must be a
 * comment, ids must be unique, and replies must follow their root.
 * @throws an Error whose message starts with `<file>:<line> `.
 */
function parseStore(text: string, artifact: string, file: string): readonly Comment[] {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const comments: Comment[] = []
  const roots = new Set<string>()
  for (const [index, line] of lines.entries()) {
    const where = `${file}:${index + 1}`
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`${where} 不是 JSON`)
    }
    if (index === 0) {
      const header = storeHeaderSchema.safeParse(value)
      if (!header.success) throw new Error(`${where} 不是批注文件的首行：${z.prettifyError(header.error)}`)
      if (header.data.artifact !== artifact) throw new Error(`${where} 属于 ${header.data.artifact}，不是 ${artifact}`)
      continue
    }
    const parsed = commentSchema.safeParse(value)
    if (!parsed.success) throw new Error(`${where} 不是合法的批注：${z.prettifyError(parsed.error).replaceAll('\n', ' ')}`)
    const comment = parsed.data
    if (comments.some(existing => existing.id === comment.id)) throw new Error(`${where} 批注 id ${comment.id} 重复`)
    if (isReply(comment) && !roots.has(comment.re)) throw new Error(`${where} 回复的批注 ${comment.re} 不在它前面`)
    if (!isReply(comment)) roots.add(comment.id)
    comments.push(comment)
  }
  return comments
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export class CommentStore {
  readonly #root: string
  /** Per store file, the tail of its chain of changes. */
  readonly #queues = new Map<string, Promise<void>>()

  /** @param root - the plugin data directory (config `root`). */
  constructor(root: string) {
    this.#root = root
  }

  /** Where an artifact's comments live. */
  fileOf(artifact: string): string {
    return join(this.#root, 'comments', `${sha256(artifact)}.jsonl`)
  }

  /**
   * Read an artifact's comments. Safe beside a write: a write replaces the file in one rename.
   * @param artifact - canonical absolute path from {@link resolveArtifact}.
   * @returns the comments and a version that changes exactly when the file does.
   * @throws when the store file is damaged, naming file and line.
   */
  async read(artifact: string): Promise<CommentsSnapshot> {
    const file = this.fileOf(artifact)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
      throw error
    }
    return { version: sha256(text).slice(0, 16), comments: parseStore(text, artifact, file) }
  }

  /**
   * Apply a batch as one actor after every earlier change to the same file has finished; write
   * only when something changed.
   * @throws {CommentRejected} when the rules refuse an operation; nothing is written then.
   */
  apply(artifact: string, ops: readonly CommentOp[], actor: Actor): Promise<CommentsSnapshot & { readonly changed: boolean }> {
    const file = this.fileOf(artifact)
    const run = (this.#queues.get(file) ?? Promise.resolve()).then(async () => {
      const current = await this.read(artifact)
      const result = applyOps(current.comments, ops, actor, new Date().toISOString())
      if (!result.ok) throw new CommentRejected(result.error.code, result.error.message)
      if (!result.changed) return { ...current, changed: false }
      const text = [JSON.stringify({ artifact }), ...result.comments.map(comment => JSON.stringify(comment)), ''].join('\n')
      await writeAtomically(file, text)
      return { version: sha256(text).slice(0, 16), comments: result.comments, changed: true }
    })
    const tail = run.then(() => undefined, () => undefined)
    this.#queues.set(file, tail)
    void tail.then(() => { if (this.#queues.get(file) === tail) this.#queues.delete(file) })
    return run
  }
}
