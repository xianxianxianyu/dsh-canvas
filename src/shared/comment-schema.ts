/**
 * The one definition of a comment and of the comment route's request, as zod schemas. Types are
 * derived from them. Only the host imports the schemas; the client imports types only, so zod is
 * never bundled into the browser module.
 */
import { z } from 'zod'
import { COMMENT_STATUSES } from './comments.ts'

const commentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u, 'id 只能用字母、数字、- 和 _，最长 64 个字符')
const commentText = z.string().trim().min(1, '批注不能为空').max(4000, '批注最长 4000 个字符')

/** The artifact element a comment points at: diagram data-id or mock id/data-canvas-id, and its visible label. */
export const anchorSchema = z.strictObject({
  target: z.string().min(1).max(200),
  label: z.string().max(500),
})

const author = z.enum(['user', 'agent'])
/** When the host stored it, ISO 8601. */
const at = z.iso.datetime()

/**
 * One line of a store file. A root comment owns the thread's status; a reply (`re`, the root's
 * id) has no status of its own and always stores `open`. Field order is the order written.
 */
export const commentSchema = z.union([
  z.strictObject({ id: commentId, author, text: commentText, status: z.enum(COMMENT_STATUSES), at, anchor: anchorSchema.optional() }),
  z.strictObject({ id: commentId, author, text: commentText, status: z.literal('open'), at, re: commentId }),
])

/** The first line of a store file names the artifact it belongs to. */
export const storeHeaderSchema = z.strictObject({ artifact: z.string().min(1) })

/** What the person may ask for through the route: create, resolve or reopen, delete their own. */
export const userOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), id: commentId, text: commentText, anchor: anchorSchema }),
  z.strictObject({ op: z.literal('status'), id: commentId, status: z.enum(['open', 'resolved']) }),
  z.strictObject({ op: z.literal('delete'), id: commentId }),
])

/** `POST /api/canvas/comments`. Without `sessionId` the path must be absolute. */
export const commentsPostSchema = z.strictObject({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1),
  ops: z.array(userOpSchema).min(1).max(50),
})

/** `GET /api/canvas/comments?sessionId&path&since`. */
export const commentsQuerySchema = z.strictObject({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1),
  since: z.string().min(1).optional(),
})

export type CommentStatus = (typeof COMMENT_STATUSES)[number]
export type Anchor = z.infer<typeof anchorSchema>
export type Comment = z.infer<typeof commentSchema>
export type RootComment = Exclude<Comment, { re: string }>
export type Reply = Extract<Comment, { re: string }>
export type UserOp = z.infer<typeof userOpSchema>

/** A comment store as the route answers it; `version` changes exactly when the file's bytes do. */
export interface CommentsSnapshot {
  readonly version: string
  readonly comments: readonly Comment[]
}
