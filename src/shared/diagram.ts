import { PeleError, render, type RenderOptions, type TextMeasurer } from 'pele'
import type { Diagnostic } from './report.ts'

/** Label font for every diagram, in the client preview and in the host screenshot alike. */
export const DIAGRAM_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif'

export type DiagramOutcome =
  | {
    readonly ok: true
    readonly svg: string
    /** Natural size in CSS pixels. */
    readonly width: number
    readonly height: number
    /** The type as Mermaid names it, such as `stateDiagram`. */
    readonly kind: string
  }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

// Adapted from pele 1.13.0's built-in width table (MIT, © 2026 kepano), which pele uses wherever a
// canvas is missing. In a browser pele measures with a canvas instead, so the client and the host
// would size labels differently. Passing this table everywhere makes both produce the same SVG.
const REGULAR = '7q7q9vfgfgopij5b9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg7q7qg8g8g8fgs7ijijk2k2ijgzlmk27qdwijfgn5k2lmijlmk2ijgzk2ijq8ijijgz7q7q7qd1fg99fgfgdwfgfg7qfgfg6666dw66n5fgfgfgfg99dw7qfgdwk2dwdwdw9a789ag8'
const BOLD = '7q99d6fgfgopk26m9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg9999g8g8g8gzr3k2k2k2k2ijgzlmk27qfgk2gzn5k2lmijlmk2ijgzk2ijq8ijijgz997q99g8fg99fggzfggzfg99gzgz7q7qfg7qopgzgzgzgzatfg99gzfglmfgfgdwat7satg8'
const SCRIPT_SCALE = 1.2

function decodeWidths(table: string): Uint16Array {
  const widths = new Uint16Array(95)
  for (let index = 0; index < 95; index++) widths[index] = parseInt(table.slice(index * 2, index * 2 + 2), 36)
  return widths
}

const regularWidths = decodeWidths(REGULAR)
const boldWidths = decodeWidths(BOLD)

function wide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0xd800 && code <= 0xdbff)
}

function zeroWidth(code: number): boolean {
  return code === 0xad || (code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f)
    || (code >= 0xdc00 && code <= 0xdfff) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0xfeff
}

/** pele's style flags: 1 bold, 4 monospace, 8 and 16 sub- and superscript. */
const tableMeasurer: TextMeasurer = {
  width(text, size, style) {
    const mono = (style & 4) !== 0
    const scaled = style & 24 ? size / SCRIPT_SCALE : size
    const widths = style & 1 ? boldWidths : regularWidths
    let units = 0
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code < 32) continue
      if (code < 127) units += mono ? 600 : widths[code - 32]!
      else if (zeroWidth(code)) continue
      else units += wide(code) ? (mono ? 1200 : 1000) : (mono ? 600 : 580)
    }
    return units * scaled / 1000
  },
}

/**
 * Width in CSS pixels of regular text in {@link DIAGRAM_FONT}, from the same table pele lays
 * labels out with; boards use it to estimate whether a note fits its box.
 */
export function measureLabel(text: string, size: number): number {
  return tableMeasurer.width(text, size, 0)
}

/** Fixed size and direction; limits sized for statecharts of a few hundred states. */
export const DIAGRAM_OPTIONS: RenderOptions = {
  measurer: tableMeasurer,
  fontFamily: DIAGRAM_FONT,
  responsive: false,
  autoDirection: false,
  idPrefix: 'canvas',
  limit: 1_000_000,
  outputLimit: 8_000_000,
  maxEdges: 10_000,
}

/**
 * Render Mermaid text with pele, or locate why it cannot be drawn.
 * @param source - the file's text.
 * @returns the SVG, or diagnostics with line, column and snippet when pele knows them.
 * @throws anything other than a PeleError, which would be a pele defect.
 */
export function renderDiagram(source: string): DiagramOutcome {
  try {
    const result = render(source, DIAGRAM_OPTIONS)
    return { ok: true, svg: result.svg, width: result.width, height: result.height, kind: result.mermaidType }
  } catch (error) {
    if (!(error instanceof PeleError)) throw error
    return { ok: false, diagnostics: [diagnosticOf(error)] }
  }
}

function diagnosticOf(error: PeleError): Diagnostic {
  // pele repeats the snippet inside its message; keep it once, in `snippet`.
  const message = (error.snippet ? error.message.replace(error.snippet, '') : error.message)
    .split('\n').map(line => line.trim()).filter(Boolean).join(' ')
  return error.line > 0
    ? { severity: 'error', message, line: error.line, column: Math.max(error.column, 1), ...error.snippet ? { snippet: error.snippet } : {} }
    : { severity: 'error', message }
}
