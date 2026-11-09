import { createHash } from 'node:crypto'
import { AGENT_STATUS_RULE, type CommentOp } from '../shared/comments.ts'
import { SUFFIXES } from '../shared/modes.ts'
import { resolveArtifact } from './artifact.ts'
import { CommentRejected, type CommentStore } from './comments.ts'
import type { FileSystem, Tool, WorkingDirectory } from './dsh.ts'

export interface CommentArgs {
  readonly path: string
  readonly id: string
  readonly reply?: string
  readonly status?: 'addressed'
}

/**
 * Narrow model arguments at the tool boundary, refusing what only the person may do in words the
 * agent can act on.
 * @param raw - the call's arguments.
 * @returns the target comment and what to do with it.
 */
export function parseCommentArgs(raw: unknown): CommentArgs {
  if (typeof raw !== 'object' || raw === null) throw new Error('canvas_comment 需要参数对象 { path, id, reply?, status? }')
  const { path, id, reply, status, ...rest } = raw as Record<string, unknown>
  if ('delete' in rest) throw new Error('agent 不能删除批注；只有用户能删除自己写的批注。')
  if (Object.keys(rest).length) throw new Error(`canvas_comment 不认识这些参数：${Object.keys(rest).join('、')}`)
  if (typeof path !== 'string' || !path.trim()) throw new Error('path 必须是非空字符串')
  if (typeof id !== 'string' || !id.trim()) throw new Error('id 必须是 canvas_check 列出的批注 id')
  if (status !== undefined && status !== 'addressed') throw new Error(status === 'resolved' || status === 'open' ? AGENT_STATUS_RULE : `status 只能是 "addressed"。${AGENT_STATUS_RULE}`)
  if (reply !== undefined && (typeof reply !== 'string' || !reply.trim() || reply.length > 4000)) throw new Error('reply 必须是 1 到 4000 个字符的文字')
  if (reply === undefined && status === undefined) throw new Error('canvas_comment 至少要给 reply 或 status（"addressed"）')
  return { path, id, ...reply === undefined ? {} : { reply: reply.trim() }, ...status === undefined ? {} : { status } }
}

/** What the agent is told after a call; the person sees the change in the sidebar. */
function outcome(args: CommentArgs, changed: boolean): string {
  if (!changed) {
    if (args.reply !== undefined && args.status !== undefined) return `批注 ${args.id} 已经回复过并标记为已处理，没有改动。`
    return args.reply !== undefined ? `批注 ${args.id} 已经回复过，没有改动。` : `批注 ${args.id} 已经是已处理，没有改动。`
  }
  if (args.reply !== undefined && args.status !== undefined) return `已回复批注 ${args.id}，并标记为已处理；用户确认后会标记为已解决。`
  return args.reply !== undefined ? `已回复批注 ${args.id}。` : `已把批注 ${args.id} 标记为已处理；用户确认后会标记为已解决。`
}

export interface CommentToolDeps {
  readonly fs: Pick<FileSystem, 'resolve' | 'processPath'>
  readonly workingDirectory: WorkingDirectory
  readonly store: CommentStore
}

/**
 * The `canvas_comment` tool (public contract, PLAN section 6): the agent replies to a comment
 * and marks it addressed. A reply's id comes from its durable invocation, so replay adds nothing.
 * @param deps - the Session filesystem and directory, and the store shared with the route.
 * @returns the tool definition.
 */
export function canvasCommentTool(deps: CommentToolDeps): Tool<unknown, { readonly text: string }> {
  return {
    name: 'canvas_comment',
    description: `回复用户在右侧栏写在图上的批注，并在改好后标记为已处理。批注的 id、位置和内容来自 canvas_check。改完文件、再用 canvas_check 确认之后，对每条处理过的批注调用一次：reply 写你改了什么（用户在批注下面看到），status 传 "addressed"。只有用户能把批注标记为已解决或重新打开，agent 也不能删除批注。只处理 ${SUFFIXES} 文件。`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', description: '批注所在的文件，和 canvas_check 用的同一个；相对路径按当前工作目录解析。' },
        id: { type: 'string', description: 'canvas_check 列出的批注 id。' },
        reply: { type: 'string', description: '给用户的回复：改了什么、为什么，或者为什么没改。' },
        status: { type: 'string', enum: ['addressed'], description: '改好了就传 "addressed"（已处理）。' },
      },
      required: ['path', 'id'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw, exec) {
      exec.signal.throwIfAborted()
      const args = parseCommentArgs(raw)
      // DSH records tool/call before execution. Its seq is unique in the session, unlike a
      // provider's callId; PTC sub-dispatches share the outer call seq but have distinct callIds.
      // Capture before awaiting directory/filesystem work, while this invocation is current.
      const session = exec.agent?.session
      const invocation = args.reply === undefined ? undefined : session?.snapshotEvents().findLast(event =>
        event.type === 'tool/call' && typeof event.data === 'object' && event.data !== null
        && 'callId' in event.data && event.data.callId === (exec.rootCallId ?? exec.callId))
      if (args.reply !== undefined && invocation === undefined) throw new Error('canvas_comment 回复需要会话中的工具调用记录；未写入批注。')
      const cwd = exec.agent === undefined ? undefined : await deps.workingDirectory.ensure(exec.agent, exec.signal)
      const artifact = await resolveArtifact(deps.fs, args.path, cwd, exec.signal)
      if (artifact.mode === undefined) throw new Error(`canvas_comment 只处理 ${SUFFIXES} 文件：${artifact.path}`)
      const ops: CommentOp[] = []
      if (args.reply !== undefined) {
        const id = `a-${createHash('sha256').update(JSON.stringify([session!.header.id, invocation!.seq, exec.callId, args.id])).digest('hex').slice(0, 32)}`
        ops.push({ op: 'reply', id, re: args.id, text: args.reply })
      }
      if (args.status !== undefined) ops.push({ op: 'status', id: args.id, status: args.status })
      try {
        const { changed } = await deps.store.apply(artifact.path, ops, 'agent')
        return { text: outcome(args, changed) }
      } catch (error) {
        if (error instanceof CommentRejected && error.code === 'missing') throw new Error(`${error.message}；先运行 canvas_check 看这个文件现在的批注和 id`)
        if (error instanceof CommentRejected && error.code === 'conflict') throw new Error('同一次调用已经写入了不同的回复；先运行 canvas_check 查看现有回复，需要补充时请发起新的 canvas_comment 调用。')
        throw error
      }
    },
  }
}
