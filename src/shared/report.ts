import { MODES, type ModeId } from './modes.ts'

/** One problem in a canvas file. Positions are 1-based; a problem without a position omits them. */
export interface Diagnostic {
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly line?: number
  readonly column?: number
  /** The source line, then a line whose caret marks the column. */
  readonly snippet?: string
}

/** What happened to the picture of a valid file. */
export type ImageNote =
  | { readonly kind: 'attached'; readonly width: number; readonly height: number; readonly scale: number }
  | { readonly kind: 'skipped'; readonly reason: string }

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
    readonly image: ImageNote
  }

/**
 * Format one diagnostic as `3:5 错误 message`, followed by its indented snippet.
 * @param diagnostic - the problem to show.
 * @returns one or more lines without a trailing newline.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.line === undefined ? '' : `${diagnostic.line}:${diagnostic.column ?? 1} `
  const head = `${where}${diagnostic.severity === 'error' ? '错误' : '警告'} ${diagnostic.message}`
  if (diagnostic.snippet === undefined) return head
  return [head, ...diagnostic.snippet.split('\n').map(line => `    ${line}`)].join('\n')
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
  if (!report.ok) {
    lines.push('改好文件后再运行 canvas_check。')
  } else if (report.image.kind === 'attached') {
    lines.push(`已出图：${report.image.width}×${report.image.height} PNG，按 ${Number(report.image.scale.toFixed(2))}× 截取，与右侧栏预览同一页面。`)
  } else {
    lines.push(`未出图：${report.image.reason}`)
  }
  return lines.join('\n')
}
