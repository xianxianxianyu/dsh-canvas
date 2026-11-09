/**
 * Owner-only content preparation for the interactive board. The caller supplies the exact source
 * it read; only embedded files are read here, so content cannot silently come from a newer board.
 * This route never reaches the board writer or journal.
 */
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { resolveArtifact } from './artifact.ts'
import { prepareBoard, type BoardReadContext } from './board-check.ts'
import type { FetchRoute } from './dsh.ts'

export const BOARD_RENDER_PATH = '/api/canvas/board-render'

const postSchema = z.strictObject({
  path: z.string().min(1).refine(path => isAbsolute(path) || win32.isAbsolute(path), 'path 必须是绝对路径'),
  source: z.string(),
})
const NO_STORE = { 'cache-control': 'no-store' }

function badRequest(message: string): Response {
  return Response.json({ error: 'bad-request', message }, { status: 400, headers: NO_STORE })
}

/**
 * `POST { path, source }` → `{ contents: [id, BoardContent][], diagnostics }`.
 * Invalid board structure returns 409; broken or over-budget embeds return cards and diagnostics.
 * @param deps - read-only access to the same filesystem used by `canvas_check`.
 * @returns an exact Connection route, which DSH restricts to owner Peers.
 */
export function boardRenderRoute(deps: Pick<BoardReadContext, 'fs'>): FetchRoute {
  return {
    path: BOARD_RENDER_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return badRequest('请求体不是 JSON')
      }
      const parsed = postSchema.safeParse(body)
      if (!parsed.success) return badRequest(z.prettifyError(parsed.error))
      try {
        const artifact = await resolveArtifact(deps.fs, parsed.data.path, undefined, request.signal)
        if (artifact.mode !== 'board') return badRequest(`只能渲染 .canvas 画板：${artifact.path}`)
        // The shared preparation enforces the same total data-URI budget as canvas_check and page.ts.
        const prepared = await prepareBoard(parsed.data.source, { fs: deps.fs, path: artifact.path, signal: request.signal })
        if (!prepared.ok) {
          return Response.json({
            error: 'invalid-source', message: `${artifact.path} 现在不是合法的画板`, diagnostics: prepared.diagnostics,
          }, { status: 409, headers: NO_STORE })
        }
        return Response.json({ contents: [...prepared.contents], diagnostics: prepared.diagnostics }, { headers: NO_STORE })
      } catch (error) {
        return Response.json({ error: 'internal', message: error instanceof Error ? error.message : String(error) }, { status: 500, headers: NO_STORE })
      }
    },
  }
}
