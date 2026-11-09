/**
 * Comment rules, shared by the host's store (the only writer) and the client's view: who may do
 * what, idempotent operations, threads, and anchor drift. Pure; the schemas live in
 * `comment-schema.ts` and are parsed at the host's boundaries before anything here runs.
 */
import type { Anchor, Comment, CommentStatus, Reply, RootComment } from './comment-schema.ts'
import { COMMENT_LABEL_LIMIT } from './limits.ts'

/** A thread's states in order: the person opens it, the agent addresses it, the person resolves it. Zod-free, so the client may import it. */
export const COMMENT_STATUSES = ['open', 'addressed', 'resolved'] as const

export type Actor = 'user' | 'agent'

/** One change to an artifact's comments. Ids are minted by the client (user) or the host (agent). */
export type CommentOp =
  | { readonly op: 'create'; readonly id: string; readonly text: string; readonly anchor: Anchor }
  | { readonly op: 'reply'; readonly id: string; readonly re: string; readonly text: string }
  | { readonly op: 'status'; readonly id: string; readonly status: CommentStatus }
  | { readonly op: 'delete'; readonly id: string }

export interface OpRejection {
  readonly code: 'forbidden' | 'missing' | 'conflict' | 'invalid'
  readonly message: string
}

export type Applied =
  | { readonly ok: true; readonly comments: readonly Comment[]; readonly changed: boolean }
  | { readonly ok: false; readonly error: OpRejection }

/** What the agent is told whenever it tries a status other than `addressed`. */
export const AGENT_STATUS_RULE = '只有用户能把批注标记为已解决（resolved）或重新打开；agent 只能回复，或用 status: "addressed" 标记已处理。'

export function isReply(comment: Comment): comment is Reply {
  return 're' in comment
}

const reject = (code: OpRejection['code'], message: string): OpRejection => ({ code, message })
const missing = (id: string): OpRejection => reject('missing', `找不到批注 ${id}`)
const conflict = (id: string): OpRejection => reject('conflict', `批注 ${id} 已经存在，内容不同；新批注要换一个 id`)

function applyOne(comments: readonly Comment[], op: CommentOp, actor: Actor, now: string): readonly Comment[] | OpRejection {
  const index = comments.findIndex(comment => comment.id === op.id)
  const existing = comments[index]
  switch (op.op) {
    case 'create': {
      if (actor !== 'user') return reject('forbidden', 'agent 不能新建批注，只能回复用户的批注')
      if (existing === undefined) return [...comments, { id: op.id, author: 'user', text: op.text, status: 'open', at: now, anchor: op.anchor }]
      return !isReply(existing) && existing.author === 'user' && existing.text === op.text
        && existing.anchor?.target === op.anchor.target && existing.anchor?.label === op.anchor.label ? comments : conflict(op.id)
    }
    case 'reply': {
      const target = comments.find(comment => comment.id === op.re)
      if (target === undefined) return missing(op.re)
      const re = isReply(target) ? target.re : target.id
      if (existing === undefined) return [...comments, { id: op.id, author: actor, text: op.text, status: 'open', at: now, re }]
      return isReply(existing) && existing.author === actor && existing.text === op.text && existing.re === re ? comments : conflict(op.id)
    }
    case 'status': {
      if (actor === 'agent' && op.status !== 'addressed') return reject('forbidden', AGENT_STATUS_RULE)
      if (actor === 'user' && op.status === 'addressed') return reject('forbidden', '「已处理」由 agent 标记；用户只能标记为已解决，或重新打开')
      if (existing === undefined) return missing(op.id)
      if (isReply(existing)) return reject('invalid', `${op.id} 是回复，没有自己的状态；请对它所属的批注 ${existing.re} 操作`)
      if (existing.status === op.status) return comments
      if (existing.status === 'resolved' && actor === 'agent') return reject('forbidden', `批注 ${op.id} 已被用户标记为已解决，不能再改成已处理`)
      return comments.with(index, { ...existing, status: op.status })
    }
    case 'delete': {
      if (existing === undefined) return comments
      if (existing.author !== actor) {
        return reject('forbidden', actor === 'agent' ? 'agent 不能删除用户的批注' : `${op.id} 是 agent 的回复，用户不能删除`)
      }
      // Deleting a root takes its replies with it.
      return comments.filter(comment => comment.id !== op.id && !(isReply(comment) && comment.re === op.id))
    }
  }
}

/**
 * Apply a batch of operations as one actor: all of them or none. Each is idempotent by comment
 * id: replaying a create or reply, setting the current status, or deleting a gone comment
 * changes nothing; the same id with other content is a conflict.
 * @param comments - the current comments, in file order.
 * @param ops - the batch.
 * @param actor - who asks; the rules differ for the person and the agent.
 * @param now - ISO time stamped on new comments.
 * @returns the new list (the same array when nothing changed), or the first rejection.
 */
export function applyOps(comments: readonly Comment[], ops: readonly CommentOp[], actor: Actor, now: string): Applied {
  let current = comments
  for (const op of ops) {
    const next = applyOne(current, op, actor, now)
    if ('code' in next) return { ok: false, error: next }
    current = next
  }
  return { ok: true, comments: current, changed: current !== comments }
}

/** How an anchor relates to the current artifact. `movedTo` lists ids carrying the old label. */
export type Drift =
  | { readonly kind: 'renamed'; readonly label: string; readonly movedTo: readonly string[] }
  | { readonly kind: 'gone'; readonly movedTo: readonly string[] }

export interface Thread {
  readonly root: RootComment
  readonly replies: readonly Reply[]
  readonly drift?: Drift
}

function driftOf(anchor: Anchor | undefined, labels: ReadonlyMap<string, string | undefined>): Drift | undefined {
  if (anchor === undefined) return undefined
  const now = labels.get(anchor.target)?.slice(0, COMMENT_LABEL_LIMIT)
  const before = anchor.label.slice(0, COMMENT_LABEL_LIMIT)
  if (now === before || (now === undefined && labels.has(anchor.target))) return undefined
  const movedTo = before === '' ? [] : [...labels].filter(([id, label]) => id !== anchor.target && label?.slice(0, COMMENT_LABEL_LIMIT) === before).map(([id]) => id)
  return now === undefined ? { kind: 'gone', movedTo } : { kind: 'renamed', label: now, movedTo }
}

/**
 * Group comments into threads in file order and compare each anchor with the current artifact.
 * @param comments - one artifact's comments.
 * @param labels - element id → visible label; a present undefined value means layout is unmeasured.
 * @returns every thread, resolved ones included.
 */
export function threadsOf(comments: readonly Comment[], labels: ReadonlyMap<string, string | undefined>): readonly Thread[] {
  const replies = new Map<string, Reply[]>()
  for (const comment of comments) if (isReply(comment)) replies.set(comment.re, [...replies.get(comment.re) ?? [], comment])
  return comments.filter((comment): comment is RootComment => !isReply(comment)).map(root => {
    const drift = driftOf(root.anchor, labels)
    return { root, replies: replies.get(root.id) ?? [], ...drift === undefined ? {} : { drift } }
  })
}

/** Open or addressed: the thread still waits for the person. */
export function isPending(thread: Thread): boolean {
  return thread.root.status !== 'resolved'
}

/**
 * The elements to frame in red, in the picture and the preview alike: anchors of pending threads
 * that are still drawn.
 * @param threads - threads from {@link threadsOf}.
 * @returns element ids, each once, in thread order.
 */
export function outlineTargets(threads: readonly Thread[]): readonly string[] {
  const targets = threads.filter(thread => isPending(thread) && thread.root.anchor !== undefined && thread.drift?.kind !== 'gone')
    .map(thread => thread.root.anchor!.target)
  return [...new Set(targets)]
}
