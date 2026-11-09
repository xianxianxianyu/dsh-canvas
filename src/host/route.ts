/**
 * The client's two owner-only routes, each registered as an exact Connection route (DSH lets only
 * owner Peers reach those):
 * - `GET|POST /api/canvas/comments` reads and changes a file's comments;
 * - `POST /api/canvas/board` applies the person's board operations to a `.canvas` file.
 * Bodies and queries are parsed with zod here; the store, the rules and the write protocol trust
 * what passes.
 */
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { boardPostSchema } from '../shared/board-schema.ts'
import { commentsPostSchema, commentsQuerySchema } from '../shared/comment-schema.ts'
import { SUFFIXES } from '../shared/modes.ts'
import { resolveArtifact, type Artifact } from './artifact.ts'
import { MAX_ATTEMPTS, writeBoardOps } from './board-write.ts'
import { CommentRejected, type CommentStore } from './comments.ts'
import type { FetchRoute, FileSystem } from './dsh.ts'

export const COMMENTS_PATH = '/api/canvas/comments'
export const BOARD_PATH = '/api/canvas/board'

interface PathDeps {
  readonly fs: Pick<FileSystem, 'resolve' | 'processPath'>
  /** The Session's workspace directory, which DSH resolves the sidebar's relative file address against. */
  readonly sessionCwd: (sessionId: string, signal: AbortSignal) => Promise<string | undefined>
}

export interface RouteDeps extends PathDeps {
  readonly store: CommentStore
}

export interface BoardRouteDeps extends PathDeps {
  readonly fs: Pick<FileSystem, 'resolve' | 'processPath' | 'stat' | 'readText' | 'writeText'>
}

class RouteError extends Error {
  readonly status: 400 | 404

  constructor(status: 400 | 404, message: string) {
    super(message)
    this.status = status
  }
}

const REJECTED_STATUS: { readonly [K in CommentRejected['code']]: number } = { invalid: 400, forbidden: 403, missing: 404, conflict: 409 }
const NO_STORE = { 'cache-control': 'no-store' }

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new RouteError(400, z.prettifyError(parsed.error))
  return parsed.data
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new RouteError(400, '请求体不是 JSON')
  }
}

/** The file a request names, as `canvas_check` resolves it: absolute, or relative to its Session's directory. */
async function artifactOf(deps: PathDeps, request: { readonly sessionId?: string | undefined; readonly path: string }, signal: AbortSignal): Promise<Artifact> {
  let cwd: string | undefined
  if (!isAbsolute(request.path) && !win32.isAbsolute(request.path)) {
    if (request.sessionId === undefined) throw new RouteError(400, `没有 sessionId 时 path 必须是绝对路径：${request.path}`)
    cwd = await deps.sessionCwd(request.sessionId, signal)
    if (cwd === undefined) throw new RouteError(404, `找不到会话 ${request.sessionId} 的工作目录`)
  }
  return resolveArtifact(deps.fs, request.path, cwd, signal)
}

async function commentArtifact(deps: PathDeps, request: { readonly sessionId?: string | undefined; readonly path: string }, signal: AbortSignal): Promise<string> {
  const artifact = await artifactOf(deps, request, signal)
  if (artifact.mode === undefined) throw new RouteError(400, `批注只支持 ${SUFFIXES} 文件：${artifact.path}`)
  return artifact.path
}

async function handleComments(deps: RouteDeps, request: Request): Promise<Response> {
  if (request.method === 'GET') {
    // An unchanged store answers with its version alone, so polling stays cheap.
    const query = parse(commentsQuerySchema, Object.fromEntries(new URL(request.url).searchParams))
    const snapshot = await deps.store.read(await commentArtifact(deps, query, request.signal))
    return Response.json(query.since === snapshot.version ? { version: snapshot.version } : snapshot, { headers: NO_STORE })
  }
  const post = parse(commentsPostSchema, await bodyOf(request))
  const { version, comments } = await deps.store.apply(await commentArtifact(deps, post, request.signal), post.ops, 'user')
  return Response.json({ version, comments }, { headers: NO_STORE })
}

/**
 * The comment route. Errors answer `{ error: message }`.
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
        return await handleComments(deps, request)
      } catch (error) {
        const status = error instanceof RouteError ? error.status : error instanceof CommentRejected ? REJECTED_STATUS[error.code] : 500
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
      }
    },
  }
}

async function handleBoard(deps: BoardRouteDeps, request: Request): Promise<Response> {
  const post = parse(boardPostSchema, await bodyOf(request))
  const artifact = await artifactOf(deps, post, request.signal)
  if (artifact.mode !== 'board') throw new RouteError(400, `只能改 .canvas 画板：${artifact.path}`)
  const outcome = await writeBoardOps(deps.fs, artifact.target, post.ops, request.signal)
  switch (outcome.kind) {
    case 'done':
      return Response.json({ version: outcome.version, statuses: outcome.statuses }, { headers: NO_STORE })
    case 'invalid-source':
      return Response.json({
        error: 'invalid-source', message: `${artifact.path} 现在不是合法的画板，没有改动；等 agent 改好或修好文件后再试`, diagnostics: outcome.diagnostics,
      }, { status: 409, headers: NO_STORE })
    case 'not-found':
      throw new RouteError(404, `找不到文件：${artifact.path}`)
    case 'busy':
      return Response.json({
        error: 'busy', message: `${artifact.path} 连续 ${MAX_ATTEMPTS} 次在写入前被别人改了，这批操作没有写入；可以原样重发`,
      }, { status: 503, headers: { ...NO_STORE, 'retry-after': '1' } })
  }
}

/**
 * The board route: `POST { sessionId?, path, ops }` → `200 { version, statuses }`. Errors answer
 * `{ error: 'bad-request' | 'not-found' | 'invalid-source' | 'busy' | 'internal', message, diagnostics? }`.
 * @param deps - the Session filesystem and Session directories.
 * @returns the route to register with `ctx.connection.fetch`.
 */
export function boardRoute(deps: BoardRouteDeps): FetchRoute {
  return {
    path: BOARD_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return await handleBoard(deps, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof RouteError) return Response.json({ error: error.status === 400 ? 'bad-request' : 'not-found', message }, { status: error.status, headers: NO_STORE })
        return Response.json({ error: 'internal', message }, { status: 500, headers: NO_STORE })
      }
    },
  }
}
