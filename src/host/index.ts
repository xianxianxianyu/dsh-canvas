import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { HeadlessBrowser, browserCandidates, locateBrowser } from './browser.ts'
import { canvasCheckTool } from './check.ts'
import { BoardJournal } from './board-journal.ts'
import { boardRenderRoute } from './board-render.ts'
import { canvasCommentTool } from './comment-tool.ts'
import { CommentStore } from './comments.ts'
import type { HostContext, SkillCandidate } from './dsh.ts'
import { boardRoute, commentsRoute } from './route.ts'

export const name = 'dsh-canvas'
export const inject = ['tools', 'skills', 'fs', 'workingDirectory']

export interface Config {
  /** Absolute plugin data directory, outside the user's repository; comments live in `<root>/comments/`. */
  readonly root: string
  /** Chrome or Edge executable for screenshots; when set, discovery is skipped. */
  readonly browserPath?: string
}

const skillsRoot = fileURLToPath(new URL('../skills/', import.meta.url))
/** The shared loop every canvas-* skill ends with. */
const loopPath = join(skillsRoot, '_shared', 'loop.md')

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!frontmatter) throw new Error(`canvas: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1]!)
  if (typeof metadata !== 'object' || metadata === null || !('description' in metadata)
    || typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error(`canvas: ${path} has no description`)
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() }
}

export function apply(ctx: HostContext, config: Config): void {
  if (typeof config?.root !== 'string' || !isAbsolute(config.root)) throw new Error('canvas: root must be an absolute directory')
  if (config.browserPath !== undefined && (typeof config.browserPath !== 'string' || !isAbsolute(config.browserPath))) {
    throw new Error('canvas: browserPath must be an absolute path to a Chrome or Edge executable')
  }

  const headless = new HeadlessBrowser()
  ctx.effect(() => () => headless.dispose(), 'canvas: headless browser')
  const candidates = browserCandidates(process.platform, process.env, homedir())
  // The only writer of comments: the route and canvas_comment share it, so changes to one file run in order.
  const store = new CommentStore(config.root)
  const journal = new BoardJournal()
  ctx.tools.register(canvasCheckTool({
    fs: ctx.fs,
    workingDirectory: ctx.workingDirectory,
    attachments: () => ctx.get('attachments'),
    llm: () => ctx.get('llm'),
    browser: () => locateBrowser(config.browserPath, candidates, existsSync),
    headless,
    store,
    journal,
  }))
  ctx.tools.register(canvasCommentTool({ fs: ctx.fs, workingDirectory: ctx.workingDirectory, store }))
  ctx.inject(['connection', 'sessions'], scope => {
    // Live Sessions first, then the stored header, as DSH resolves `dsh-resource://file/session/<id>/<path>`.
    const sessionCwd = async (id: string, signal: AbortSignal): Promise<string | undefined> =>
      (scope.sessions.get(id)?.header ?? (await scope.get('sessionPersistence')?.stat(id, { signal }))?.header)?.cwd
    scope.connection.fetch.register(commentsRoute({ store, fs: ctx.fs, sessionCwd }))
    // The person's board edits; the agent edits the same file with DSH's own tools (see board-write.ts).
    scope.connection.fetch.register(boardRoute({ fs: ctx.fs, sessionCwd, journal }))
    scope.connection.fetch.register(boardRenderRoute({ fs: ctx.fs }))
  })

  ctx.skills.registerProvider(() => ({
    name: 'canvas',
    async list({ signal }) {
      const entries = await readdir(skillsRoot, { withFileTypes: true })
      const candidates: SkillCandidate[] = []
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !entry.name.startsWith('canvas-')) continue
        const directory = join(skillsRoot, entry.name)
        const path = join(directory, 'SKILL.md')
        const { description } = parseSkill(await readFile(path, { encoding: 'utf8', signal }), path)
        candidates.push({
          name: entry.name, description, invocation: { modelInvocable: true, userInvocable: true },
          provider: 'canvas', source: 'bundled', rank: 600,
          resourceBase: { kind: 'directory', path: directory }, locator: path, path,
        })
      }
      return candidates
    },
    async get(candidate, { signal }) {
      const { rank: _rank, locator, ...summary } = candidate
      const skill = parseSkill(await readFile(locator, { encoding: 'utf8', signal }), locator)
      const loop = (await readFile(loopPath, { encoding: 'utf8', signal })).trim()
      return { ...summary, ...skill, content: `${skill.content}\n\n${loop}` }
    },
  }))
}
