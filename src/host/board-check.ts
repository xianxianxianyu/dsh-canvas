/**
 * Board content shared by the interactive tab and `canvas_check`: validate the board, prepare
 * each embedded file one level deep, and report what will look wrong. The check additionally
 * treats embed errors as failure and lays out the composite page that the model sees.
 */
import { dirname } from 'node:path'
import { FILE_NODE, NOTE_TEXT, embedOf, imageType, noteHeight, parseBoard, scene, type Board, type BoardNode, type FileNode, type Scene } from '../shared/board.ts'
import { renderDiagram } from '../shared/diagram.ts'
import { sourceLocator } from '../shared/json.ts'
import { markdownHtml } from '../shared/markdown.ts'
import { boardPageHtml, type BoardContent } from '../shared/page.ts'
import type { Diagnostic } from '../shared/report.ts'
import type { CheckContext, Checked } from './check.ts'

/** Larger images are shown as their file name: a data: URI that size would swamp the page. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** An embedded diagram drawn smaller than this is hard to read. */
const LEGIBLE_SCALE = 0.5
/** Warn well before the screenshot limit: a 16k canvas is already hard to read as one image. */
const MAX_BOARD_SPAN = 16_384
const MAX_NODE_GAP = MAX_BOARD_SPAN / 2

/** Preparation can only read; the interactive route has no write capability. */
export type BoardReadContext = Pick<CheckContext, 'path' | 'signal'> & {
  readonly fs: Pick<CheckContext['fs'], 'resolve' | 'processPath' | 'stat' | 'readText' | 'readBytes'>
}

/** Only structural source errors refuse a board; broken embeds stay visible as cards. */
export type PreparedBoard =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
    readonly ok: true
    readonly board: Board
    readonly scene: Scene
    readonly contents: ReadonlyMap<string, BoardContent>
    readonly diagnostics: readonly Diagnostic[]
    readonly embeds: readonly string[]
  }

/** What one file node turned out to be. */
interface Embedded {
  readonly content: BoardContent
  /** One line for the check's embed list, after `<id> ← <file>：`. */
  readonly summary: string
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  /** The child's own located problems (a diagram that does not parse). */
  readonly located: readonly Diagnostic[]
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.trim()
}

/** The text a comment on this node quotes, as `diagramNodes` gives a diagram node's label. */
function labelOf(node: BoardNode): string {
  if (node.type === 'text') return (node.text.split('\n').find(line => line.trim()) ?? '').replace(/^#+\s*/u, '').trim().slice(0, 60)
  if (node.type === 'file') return node.file
  if (node.type === 'link') return node.url
  return node.label ?? ''
}

async function embed({ fs, path, signal }: BoardReadContext, node: FileNode): Promise<Embedded> {
  const card = (detail: string): BoardContent => ({ kind: 'card', title: node.file, detail })
  const problem = (kind: 'errors' | 'warnings', message: string, summary: string): Embedded => ({
    content: card(summary), summary, errors: kind === 'errors' ? [message] : [], warnings: kind === 'warnings' ? [message] : [], located: [],
  })
  const target = await fs.resolve(node.file, { cwd: dirname(path), signal })
  const absolute = fs.processPath(target)
  const info = await fs.stat(target, signal)
  if (info === undefined) return problem('errors', `节点 ${node.id} 嵌入的文件不存在：${node.file}（${absolute}）`, '文件不存在')
  if (info.type !== 'file') return problem('errors', `节点 ${node.id} 嵌入的不是文件：${node.file}（${absolute}）`, '不是文件')
  const { kind } = embedOf(path, node.file)
  try {
    switch (kind) {
      case 'diagram': {
        const diagram = renderDiagram(await fs.readText(target, signal))
        if (!diagram.ok) {
          const located = diagram.diagnostics.map(diagnostic => ({ ...diagnostic, file: node.file, message: `节点 ${node.id} 嵌入的图：${diagnostic.message}` }))
          return { content: card('画不出来'), summary: '图，画不出来', errors: [], warnings: [], located }
        }
        const fit = Math.min(
          (node.width - 2 * NOTE_TEXT.border - 2 * FILE_NODE.padding) / diagram.width,
          (node.height - 2 * NOTE_TEXT.border - FILE_NODE.header - 2 * FILE_NODE.padding) / diagram.height,
        )
        const size = `${Math.ceil(diagram.width)}×${Math.ceil(diagram.height)} px`
        return {
          content: { kind: 'svg', markup: diagram.svg, width: diagram.width, height: diagram.height },
          summary: `图（${diagram.kind}，${size}）`, errors: [], located: [],
          warnings: fit < LEGIBLE_SCALE ? [`节点 ${node.id} 里的图缩到了 ${Math.round(Math.max(fit, 0) * 100)}%（原图 ${size}），字可能看不清；把框调大`] : [],
        }
      }
      case 'note': {
        const text = await fs.readText(target, signal)
        const needed = noteHeight(text, node.width) + FILE_NODE.header
        return {
          content: { kind: 'html', html: markdownHtml(text) }, summary: '笔记', errors: [], located: [],
          warnings: needed > node.height ? [`节点 ${node.id} 嵌入的笔记大约要 ${needed} px 高，框只有 ${node.height} px，放不下的部分会被截掉`] : [],
        }
      }
      case 'image': {
        if (info.size > MAX_IMAGE_BYTES) return problem('warnings', `节点 ${node.id} 的图片超过 8 MB，只显示文件名`, '图片太大，只显示文件名')
        const bytes = await fs.readBytes(target, signal, MAX_IMAGE_BYTES)
        return { content: { kind: 'image', src: `data:${imageType(absolute) ?? imageType(node.file)};base64,${Buffer.from(bytes).toString('base64')}` }, summary: '图片', errors: [], warnings: [], located: [] }
      }
      case 'board':
        return problem('warnings', `节点 ${node.id} 嵌入的是画板，只显示文件名，不展开（只展开一层）`, '画板，只显示文件名')
      case 'mock':
        return problem('warnings', `节点 ${node.id} 嵌入的是界面稿，请单独打开 .mock.html；画板只显示文件名`, '界面稿，只显示文件名')
      case 'other':
        return problem('warnings', `节点 ${node.id} 嵌入的 ${node.file} 画板显示不了，只显示文件名`, '画板显示不了，只显示文件名')
    }
  } catch (error) {
    signal.throwIfAborted()
    return problem('errors', `节点 ${node.id} 嵌入的 ${node.file} 读不出来：${firstLine(error)}`, '读不出来')
  }
}

/**
 * Prepare a structurally valid board's content and diagnostics without discarding broken embeds.
 * @param source - the board's text.
 * @param context - the filesystem and the board's canonical path, for its embeds.
 * @returns a refused source, or the board with all prepared content and diagnostics.
 */
export async function prepareBoard(source: string, context: BoardReadContext): Promise<PreparedBoard> {
  const parsed = parseBoard(source)
  if (!parsed.ok) return parsed
  const { board, layout } = parsed
  const locate = sourceLocator(source)
  const layoutOf = scene(board)
  const diagnostics: Diagnostic[] = [...parsed.warnings]
  const distant = new Set<string>()
  // Axis gaps find separated nodes/clusters without an extra all-pairs scan.
  for (const [position, size] of [['x', 'width'], ['y', 'height']] as const) {
    const nodes = board.nodes.filter(node => node.type !== 'group').sort((a, b) => a[position] - b[position])
    let end = nodes[0]?.[position] ?? 0
    for (const node of nodes) {
      if (node[position] - end > MAX_NODE_GAP) distant.add(node.id)
      end = Math.max(end, node[position] + node[size])
    }
  }
  if (layoutOf.bounds.width > MAX_BOARD_SPAN || layoutOf.bounds.height > MAX_BOARD_SPAN) {
    const node = board.nodes.reduce<BoardNode | undefined>((outer, node) => outer === undefined || Math.max(node.x + node.width, node.y + node.height) > Math.max(outer.x + outer.width, outer.y + outer.height) ? node : outer, undefined)
    const { line, column } = locate(source, node === undefined ? 0 : layout.elements.get(node.id)!.start)
    diagnostics.push({ severity: 'warning', line, column, message: `画板范围太大（${Math.ceil(layoutOf.bounds.width)}×${Math.ceil(layoutOf.bounds.height)} px），先把节点收拢` })
  }
  const contents = new Map<string, BoardContent>()
  const lines: string[] = []
  for (const node of board.nodes) {
    const { line, column } = locate(layout.elements.get(node.id)!.start)
    const at = (severity: Diagnostic['severity'], message: string): Diagnostic => ({ severity, message, line, column })
    if (distant.has(node.id)) diagnostics.push(at('warning', `节点 ${node.id} 距离其余节点太远（间隔超过 ${MAX_NODE_GAP} px），先把节点收拢`))
    if (node.type === 'file') {
      const embedded = await embed(context, node)
      contents.set(node.id, embedded.content)
      lines.push(`${node.id} ← ${node.file}：${embedded.summary}`)
      diagnostics.push(...embedded.errors.map(message => at('error', message)), ...embedded.located, ...embedded.warnings.map(message => at('warning', message)))
    }
    for (const overlap of layoutOf.overlaps.filter(entry => entry.b === node.id)) {
      diagnostics.push(at('warning', `节点 ${node.id} 和 ${overlap.a} 重叠 ${overlap.rect.width}×${overlap.rect.height} px`))
    }
    if (node.type === 'text') {
      contents.set(node.id, { kind: 'html', html: markdownHtml(node.text) })
      const needed = noteHeight(node.text, node.width)
      if (needed > node.height) diagnostics.push(at('warning', `节点 ${node.id} 的文字大约要 ${needed} px 高，框只有 ${node.height} px，放不下的部分会被截掉`))
    }
  }
  return { ok: true, board, scene: layoutOf, contents, diagnostics, embeds: lines }
}

/**
 * Check a board. Unlike the interactive renderer, any error (including a broken embed) fails.
 * @param source - the board's text.
 * @param context - the Session filesystem and the board's canonical path, for its embeds.
 * @returns errors or the verdict with warnings, embed lines, comment labels and the page.
 */
export async function checkBoard(source: string, context: CheckContext): Promise<Checked> {
  const prepared = await prepareBoard(source, context)
  if (!prepared.ok) return prepared
  const { board, scene: layoutOf, contents, diagnostics, embeds } = prepared
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) return { ok: false, diagnostics }
  const { width, height } = layoutOf.bounds
  return {
    ok: true,
    detail: `${board.nodes.length} 个节点、${board.edges.length} 条连线，${Math.ceil(width)}×${Math.ceil(height)} px`,
    diagnostics,
    embeds,
    labels: new Map(board.nodes.map(node => [node.id, labelOf(node)])),
    // The model gets the light page, like a diagram's.
    page: outline => boardPageHtml(layoutOf, contents, 'light', { outline }),
  }
}
