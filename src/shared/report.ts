import type { CommentStatus } from './comment-schema.ts'
import { outlineTargets, type Drift, type Thread } from './comments.ts'
import { MODES, type ModeId } from './modes.ts'

/**
 * One problem in a canvas file. Positions are 1-based; a problem without a position omits them.
 * `file` names the embedded file the position is in (a board's child), as the board writes it.
 */
export interface Diagnostic {
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
  /** The source line, then a line whose caret marks the column. */
  readonly snippet?: string
}

/** What happened to the picture of a valid file. */
export type ImageNote =
  | { readonly kind: 'attached'; readonly width: number; readonly height: number; readonly scale: number }
  | { readonly kind: 'skipped'; readonly reason: string }

/** The comments a passing check reports: the pending threads, or why the store could not be read. */
export type CommentsNote =
  | { readonly kind: 'threads'; readonly threads: readonly Thread[] }
  | { readonly kind: 'unreadable'; readonly reason: string }

export const STATUS_TITLES: { readonly [S in CommentStatus]: string } = { open: '未处理', addressed: '已处理', resolved: '已解决' }

/** The outcome of checking one file; text for the model comes only from {@link formatCheck}. */
export type CheckReport =
  | { readonly path: string; readonly mode: ModeId; readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
    readonly path: string
    readonly mode: ModeId
    readonly ok: true
    /** What the renderer made of the file, such as `stateDiagram，314×344 px`. */
    readonly detail: string
    readonly diagnostics: readonly Diagnostic[]
    /** A board's embedded files, one line each: `flow ← order.mmd：图（stateDiagram，258×344 px）`. */
    readonly embeds?: readonly string[]
    readonly image: ImageNote
    /** Pending comments on the file; absent when nothing reads them. */
    readonly comments?: CommentsNote
  }

/** What the attached picture is, said after its size. */
const PICTURE: { readonly [K in ModeId]: string } = {
  diagram: '与右侧栏预览同一页面',
  board: '嵌入的图、笔记、图片都按画板上的位置画出',
}

/**
 * Format one diagnostic as `3:5 错误 message` (`order.mmd:3:5 …` when it is in an embedded file),
 * followed by its indented snippet.
 * @param diagnostic - the problem to show.
 * @returns one or more lines without a trailing newline.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.line === undefined ? '' : `${diagnostic.file === undefined ? '' : `${diagnostic.file}:`}${diagnostic.line}:${diagnostic.column ?? 1} `
  const head = `${where}${diagnostic.severity === 'error' ? '错误' : '警告'} ${diagnostic.message}`
  if (diagnostic.snippet === undefined) return head
  return [head, ...diagnostic.snippet.split('\n').map(line => `    ${line}`)].join('\n')
}

function driftLine(target: string, label: string, drift: Drift): string {
  const moved = drift.movedTo.length ? `；「${label}」现在是 ${drift.movedTo.join('、')}` : ''
  return drift.kind === 'gone'
    ? `⚠ 图里已没有 ${target}（批注时是「${label}」）${moved}`
    : `⚠ ${target} 的文字已从「${label}」变成「${drift.label}」${moved}`
}

/**
 * The pending threads as the agent reads them: id, status, author, anchor, text, replies, drift.
 * @param threads - pending threads.
 * @param framed - whether the attached picture frames their nodes.
 * @returns lines, or none when nothing is pending.
 */
function commentLines(threads: readonly Thread[], framed: boolean): string[] {
  if (!threads.length) return []
  const lines = [`待处理批注 ${threads.length} 条${framed ? '（图上红色虚线框标出）' : ''}：`]
  for (const { root, replies, drift } of threads) {
    const where = root.anchor === undefined ? '整张图' : `${root.anchor.target}「${root.anchor.label}」`
    lines.push(`  ${root.id} ${STATUS_TITLES[root.status]} · ${root.author === 'user' ? '用户' : 'agent'} · ${where}：${root.text}`)
    for (const reply of replies) lines.push(`    ↳ ${reply.id} ${reply.author === 'user' ? '用户' : 'agent'}：${reply.text}`)
    if (drift !== undefined && root.anchor !== undefined) lines.push(`    ${driftLine(root.anchor.target, root.anchor.label, drift)}`)
  }
  lines.push('改完后用 canvas_comment 回复，并传 status: "addressed" 标记已处理；只有用户能标记为已解决。')
  return lines
}

/**
 * The model-facing text of a check. A failing report becomes the tool's error text.
 * @param report - the check outcome.
 * @returns the complete text, without a trailing newline.
 */
export function formatCheck(report: CheckReport): string {
  const title = MODES[report.mode].title.zh
  const errors = report.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
  const warnings = report.diagnostics.length - errors
  const lines: string[] = []
  if (!report.ok) {
    lines.push(`✗ ${title} ${report.path}：${errors} 个错误${warnings ? `，${warnings} 个警告` : ''}`)
  } else {
    lines.push(`✓ ${title} ${report.path}：校验通过（${report.detail}）${warnings ? `，${warnings} 个警告` : ''}`)
  }
  for (const diagnostic of report.diagnostics) lines.push(formatDiagnostic(diagnostic).replace(/^/gmu, '  '))
  if (report.ok && report.embeds?.length) lines.push(`嵌入 ${report.embeds.length} 个：`, ...report.embeds.map(line => `  ${line}`))
  if (!report.ok) {
    lines.push('改好文件后再运行 canvas_check。')
  } else if (report.image.kind === 'attached') {
    lines.push(`已出图：${report.image.width}×${report.image.height} PNG，按 ${Number(report.image.scale.toFixed(2))}× 截取，${PICTURE[report.mode]}。`)
  } else {
    lines.push(`未出图：${report.image.reason}`)
  }
  if (report.ok && report.comments?.kind === 'threads') {
    lines.push(...commentLines(report.comments.threads, report.image.kind === 'attached' && outlineTargets(report.comments.threads).length > 0))
  } else if (report.ok && report.comments?.kind === 'unreadable') {
    lines.push(`批注读不出来：${report.comments.reason}`)
  }
  return lines.join('\n')
}
