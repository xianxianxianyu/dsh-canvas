/**
 * `GET|POST /api/canvas/comments`: the client's way to read and change comments. Registered as an
 * exact Connection route, which DSH lets only owner Peers reach. Bodies and queries are parsed with
 * zod here; the store and the rules trust what passes.
 */
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { commentsPostSchema, commentsQuerySchema } from '../shared/comment-schema.ts'
import { SUFFIXES } from '../shared/modes.ts'
import { resolveArtifact } from './artifact.ts'
import { CommentRejected, type CommentStore } from './comments.ts'
import type { FetchRoute, FileSystem } from './dsh.ts'

export const COMMENTS_PATH = '/api/canvas/comments'

export interface RouteDeps {
  readonly store: CommentStore
  readonly fs: Pick<FileSystem, 'resolve' | 'processPath'>
  /** The Session's workspace directory, which DSH resolves the preview's relative file address against. */
  readonly sessionCwd: (sessionId: string, signal: AbortSignal) => Promise<string | undefined>
}

class RouteError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const REJECTED_STATUS: { readonly [K in CommentRejected['code']]: number } = { invalid: 400, forbidden: 403, missing: 404, conflict: 409 }

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new RouteError(400, z.prettifyError(parsed.error))
  return parsed.data
}

/** The canonical path of the artifact a request names: absolute, or relative to its Session's directory. */
async function artifactOf(deps: RouteDeps, request: { readonly sessionId?: string | undefined; readonly path: string }, signal: AbortSignal): Promise<string> {
  let cwd: string | undefined
  if (!isAbsolute(request.path) && !win32.isAbsolute(request.path)) {
    if (request.sessionId === undefined) throw new RouteError(400, `没有 sessionId 时 path 必须是绝对路径：${request.path}`)
    cwd = await deps.sessionCwd(request.sessionId, signal)
    if (cwd === undefined) throw new RouteError(404, `找不到会话 ${request.sessionId} 的工作目录`)
  }
  const artifact = await resolveArtifact(deps.fs, request.path, cwd, signal)
  if (artifact.mode === undefined) throw new RouteError(400, `批注只支持 ${SUFFIXES} 文件：${artifact.path}`)
  return artifact.path
}

async function handle(deps: RouteDeps, request: Request): Promise<Response> {
  if (request.method === 'GET') {
    // An unchanged store answers with its version alone, so polling stays cheap.
    const query = parse(commentsQuerySchema, Object.fromEntries(new URL(request.url).searchParams))
    const snapshot = await deps.store.read(await artifactOf(deps, query, request.signal))
    return Response.json(query.since === snapshot.version ? { version: snapshot.version } : snapshot, { headers: { 'cache-control': 'no-store' } })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new RouteError(400, '请求体不是 JSON')
  }
  const post = parse(commentsPostSchema, body)
  const { version, comments } = await deps.store.apply(await artifactOf(deps, post, request.signal), post.ops, 'user')
  return Response.json({ version, comments }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * The comment route.
 * @param deps - the shared store, the filesystem, and Session directories.
 * @returns the route to register with `ctx.connection.fetch`.
 */
export function commentsRoute(deps: RouteDeps): FetchRoute {
  return {
    path: COMMENTS_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return await handle(deps, request)
      } catch (error) {
        const status = error instanceof RouteError ? error.status : error instanceof CommentRejected ? REJECTED_STATUS[error.code] : 500
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
      }
    },
  }
}
