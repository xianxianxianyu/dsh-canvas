import { basename } from 'node:path'
import type { Comment } from '../shared/comment-schema.ts'
import { isPending, outlineTargets, threadsOf } from '../shared/comments.ts'
import { renderDiagram } from '../shared/diagram.ts'
import { MODES, SUFFIXES, type ModeId } from '../shared/modes.ts'
import { parseMock } from '../shared/mock.ts'
import type { MockInspection } from '../shared/mock-dom.ts'
import { diagramNodes } from '../shared/nodes.ts'
import { mockPage, pageHtml, type Page } from '../shared/page.ts'
import { formatCheck, type CommentsNote, type Diagnostic, type ImageNote } from '../shared/report.ts'
import { resolveArtifact } from './artifact.ts'
import { checkBoard } from './board-check.ts'
import type { HeadlessBrowser, BrowserLocation } from './browser.ts'
import type { CommentStore } from './comments.ts'
import type { Agent, Attachments, FileSystem, ImageAttachment, Llm, Tool, ToolExecution, WorkingDirectory } from './dsh.ts'
import { imageScale, renderMock, screenshot, type Screenshot } from './raster.ts'
import type { BoardJournal } from './board-journal.ts'

export type Checked =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
    readonly ok: true
    readonly detail: string
    readonly diagnostics: readonly Diagnostic[]
    /** A board's embedded files, one line each. */
    readonly embeds?: readonly string[]
    /** Commentable id → visible label; undefined means present but not measured. */
    readonly labels: ReadonlyMap<string, string | undefined>
    /** The shared page, with these elements framed. */
    page(outline: readonly string[]): Page
  }

/** What a mode's check may read besides the file's text: a board reads the files it embeds. */
export interface CheckContext {
  readonly fs: FileSystem
  /** The checked file's canonical absolute path. */
  readonly path: string
  readonly signal: AbortSignal
}

/** How the host validates and lays out each mode; the client keeps the matching surface map. */
const HOST_MODES: { readonly [K in ModeId]: { check(source: string, context: CheckContext): Promise<Checked> } } = {
  diagram: {
    async check(source) {
      const diagram = renderDiagram(source)
      if (!diagram.ok) return diagram
      return {
        ok: true,
        detail: `${diagram.kind}，${Math.ceil(diagram.width)}×${Math.ceil(diagram.height)} px`,
        diagnostics: [],
        labels: new Map(diagramNodes(diagram.svg).map(node => [node.id, node.label])),
        // The model always gets the light page; the preview follows DSH's theme.
        page: outline => pageHtml({ markup: diagram.svg, width: diagram.width, height: diagram.height }, 'light', { outline }),
      }
    },
  },
  board: { check: checkBoard },
  mock: {
    async check(source) {
      const mock = parseMock(source)
      if (!mock.ok) return mock
      return {
        ok: true,
        detail: `${mock.document.viewport.width}×${mock.document.viewport.height} px`,
        diagnostics: mock.diagnostics,
        labels: mock.document.targets,
        page: outline => mockPage(mock.document, { outline }),
      }
    },
  },
}

export interface CheckArgs {
  readonly path: string
  readonly image: boolean
}

/**
 * Narrow model arguments at the tool boundary.
 * @param raw - the call's arguments.
 * @returns the path and whether a picture was asked for (default yes).
 */
export function parseCheckArgs(raw: unknown): CheckArgs {
  if (typeof raw !== 'object' || raw === null) throw new Error('canvas_check 需要参数对象 { path, image? }')
  const { path, image } = raw as { path?: unknown; image?: unknown }
  if (typeof path !== 'string' || !path.trim()) throw new Error('path 必须是非空字符串')
  if (image !== undefined && typeof image !== 'boolean') throw new Error('image 必须是 true 或 false')
  return { path, image: image ?? true }
}

/**
 * Whether the calling route can see images, decided like DSH's `read_image`: the Session's routed
 * provider and model, else the agent's, must declare `image` input.
 * @param llm - the optional `llm` service.
 * @param agent - the calling agent.
 * @param signal - cancels the model lookup.
 * @returns yes, or why not.
 */
export async function imageRoute(llm: Llm | undefined, agent: Agent | undefined, signal: AbortSignal): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const routed = agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? agent?.options.provider
  const model = routed?.model ?? agent?.options.model
  if (provider === undefined || model === undefined || llm === undefined) return { ok: false, reason: '无法确定当前模型能否看图' }
  let modalities: readonly string[] | undefined
  try {
    modalities = (await llm.resolveModelInfo(provider, model, signal)).inputModalities
  } catch (error) {
    signal.throwIfAborted()
    return { ok: false, reason: `无法确定模型 ${model} 能否看图：${firstLine(error)}` }
  }
  return modalities?.includes('image') ? { ok: true } : { ok: false, reason: `当前模型 ${model} 不支持看图` }
}

export interface CheckDeps {
  readonly fs: FileSystem
  readonly workingDirectory: WorkingDirectory
  readonly attachments: () => Attachments | undefined
  readonly llm: () => Llm | undefined
  readonly browser: () => BrowserLocation
  readonly headless: Pick<HeadlessBrowser, 'use'>
  readonly store: CommentStore
  readonly journal: BoardJournal
}

export interface CheckValue {
  readonly text: string
  readonly image?: ImageAttachment
}

/**
 * Resolve, validate and, when possible, picture one canvas file.
 * @throws with the formatted diagnostics when the file has errors, so the result is `isError`.
 */
export async function checkFile(deps: CheckDeps, args: CheckArgs, exec: ToolExecution): Promise<CheckValue> {
  const { signal } = exec
  // Relative paths resolve against the Session's current directory, as DSH's file tools do.
  const cwd = exec.agent === undefined ? undefined : await deps.workingDirectory.ensure(exec.agent, signal)
  const { target, path, mode } = await resolveArtifact(deps.fs, args.path, cwd, signal)
  if (mode === undefined) throw new Error(`canvas_check 只检查 ${SUFFIXES} 文件：${target.displayPath}`)
  const info = await deps.fs.stat(target, signal)
  if (info === undefined) throw new Error(`找不到文件：${target.displayPath}`)
  if (info.type !== 'file') throw new Error(`不是普通文件：${target.displayPath}`)
  const source = await deps.fs.readText(target, signal)
  const checked = await HOST_MODES[mode].check(source, { fs: deps.fs, path, signal })
  if (!checked.ok) throw new Error(formatCheck({ path, mode, ok: false, diagnostics: checked.diagnostics }))
  const diagnostics = [...checked.diagnostics]
  if (mode === 'board') for (const batch of deps.journal.lost(path, source)) {
    const time = new Date(batch.at).toTimeString().slice(0, 5)
    diagnostics.push({
      severity: 'warning',
      message: `检测到用户在 ${time} 的 ${batch.count} 个改动被覆盖（${batch.id}）；用 edit 恢复或说明原因。操作：${JSON.stringify(batch.ops)}`,
    })
  }
  // Comments never change the verdict: a store that cannot be read becomes one line of the report.
  let comments: CommentsNote
  let storedComments: readonly Comment[] | undefined
  let outline: readonly string[] = []
  try {
    storedComments = (await deps.store.read(path)).comments
    const threads = threadsOf(storedComments, checked.labels).filter(isPending)
    comments = { kind: 'threads', threads }
    outline = outlineTargets(threads)
  } catch (error) {
    comments = { kind: 'unreadable', reason: firstLine(error) }
  }
  const picture: Picture = args.image
    ? await pictureOf(deps, checked.page(outline), `${basename(path)}.png`, exec, mode)
    : { note: { kind: 'skipped', reason: '本次只校验（image: false）' } }
  if (picture.inspection !== undefined) {
    diagnostics.push(...picture.inspection.diagnostics)
    if (storedComments !== undefined) {
      // Hidden anchors still exist; only visible labels are known well enough to detect renaming.
      const labels = new Map(checked.labels)
      for (const node of picture.inspection.nodes) labels.set(node.id, node.label)
      comments = { kind: 'threads', threads: threadsOf(storedComments, labels).filter(isPending) }
    }
  }
  const text = formatCheck({
    path, mode, ok: true, detail: checked.detail, diagnostics, image: picture.note, comments,
    ...checked.embeds === undefined ? {} : { embeds: checked.embeds },
  })
  return picture.image === undefined ? { text } : { text, image: picture.image }
}

interface Picture {
  readonly note: ImageNote
  readonly image?: ImageAttachment
  readonly inspection?: MockInspection
}

/** Attachment policy does not decide whether a mock needs Chrome layout inspection. */
async function pictureGate(deps: CheckDeps, exec: ToolExecution): Promise<{ readonly ok: true; readonly attachments: Attachments } | { readonly ok: false; readonly reason: string }> {
  const route = await imageRoute(deps.llm(), exec.agent, exec.signal)
  if (!route.ok) return route
  const attachments = deps.attachments()
  if (attachments === undefined) return { ok: false, reason: 'DSH 没有挂载附件服务' }
  if (!attachments.imageLimits.mediaTypes.includes('image/png')) return { ok: false, reason: '当前部署不接受 PNG 图片' }
  return { ok: true, attachments }
}

async function pictureOf(deps: CheckDeps, page: Page, name: string, exec: ToolExecution, mode: ModeId): Promise<Picture> {
  const skipped = (reason: string): Picture => ({ note: { kind: 'skipped', reason } })
  const mock = mode === 'mock'
  if (imageScale(page.width, page.height) === 0) {
    return skipped(mode === 'board'
      ? `画板太大（${page.width}×${page.height}），先把节点收拢`
      : `页面太大（${page.width}×${page.height}），先缩小页面`)
  }
  const gate = await pictureGate(deps, exec)
  if (!gate.ok && !mock) return skipped(gate.reason)
  const location = deps.browser()
  if (location.kind === 'missing') return skipped(gate.ok ? location.reason : gate.reason)
  let rendered: { readonly shot?: Screenshot; readonly inspection?: MockInspection }
  try {
    rendered = await deps.headless.use(location.path, async browser => mock
      ? renderMock(browser, page, exec.signal, gate.ok)
      : { shot: await screenshot(browser, page, exec.signal) }, exec.signal)
  } catch (error) {
    exec.signal.throwIfAborted()
    return skipped(gate.ok ? `无头浏览器截图失败：${firstLine(error)}` : `${gate.reason}；布局检查失败：${firstLine(error)}`)
  }
  const { inspection } = rendered
  if (!gate.ok) return { ...skipped(gate.reason), inspection }
  // Both rendering paths capture a shot when the attachment gate admits one.
  const shot = rendered.shot!
  let saved: ImageAttachment
  try {
    saved = await gate.attachments.saveImage({ data: shot.png, mediaType: 'image/png', name })
  } catch (error) {
    exec.signal.throwIfAborted()
    return { ...skipped(`图片未能保存：${firstLine(error)}`), inspection }
  }
  const image: ImageAttachment = {
    attachmentId: saved.attachmentId, mediaType: saved.mediaType, bytes: saved.bytes, width: saved.width, height: saved.height,
    ...saved.name === undefined ? {} : { name: saved.name },
    ...saved.originalDimensions === undefined ? {} : { originalDimensions: { width: saved.originalDimensions.width, height: saved.originalDimensions.height } },
  }
  return { note: { kind: 'attached', width: image.width, height: image.height, scale: shot.scale }, image, inspection }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.trim()
}

const dimensions = {
  type: 'object', additionalProperties: false,
  properties: { width: { type: 'integer' }, height: { type: 'integer' } },
  required: ['width', 'height'],
}

/**
 * The `canvas_check` tool. Public contract: `isError: false` exactly when the file validates.
 * @param deps - host services and the shared headless browser.
 * @returns the tool definition.
 */
export function canvasCheckTool(deps: CheckDeps): Tool<unknown, CheckValue> {
  const kinds = Object.values(MODES).map(mode => `${mode.title.zh}（${mode.extensions.map(extension => `.${extension}`).join(' ')}）`).join('、')
  return {
    name: 'canvas_check',
    description: `校验 canvas 文件：${kinds}。有错时返回 isError，每个错误带 行:列 和出错片段；通过时在能看图的模型上附一张 PNG：图表和右侧栏预览出自同一份 HTML，画板是把嵌入的图、笔记、图片按位置排好的合成图（嵌入的文件也一起校验）。mock 是离线、禁脚本的静态 HTML；默认有 Chrome 时检查真实布局的横向溢出、文字裁切和批注文字变化，即使模型不能看图也检查，但只有附件门禁允许时才截取和保存 PNG。传 image: false 只做静态校验，不启动 Chrome；定稿前不传 image 看一次图。不能出图时（模型不支持看图、找不到浏览器等）仍算通过，并写明「未出图」的原因。`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', description: `要检查的文件，${SUFFIXES}；相对路径按当前工作目录解析。` },
        image: { type: 'boolean', description: '是否出图，默认 true；false 只做静态校验，不启动 Chrome。mock 默认在有 Chrome 时检查布局，即使不能附图。' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string' },
          image: {
            type: 'object', additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
              bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' },
              name: { type: 'string' }, originalDimensions: dimensions,
            },
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
          },
        },
        required: ['text'],
      },
      render: (_args, value) => value.image === undefined
        ? [{ type: 'text', text: value.text }]
        : [{ type: 'text', text: value.text }, { type: 'image', attachment: value.image }],
    },
    isConcurrencySafe: () => true,
    async execute(raw, exec) {
      exec.signal.throwIfAborted()
      return checkFile(deps, parseCheckArgs(raw), exec)
    },
  }
}
