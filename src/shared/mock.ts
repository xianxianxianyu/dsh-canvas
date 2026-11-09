import { parse, serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { locate } from './json.ts'
import type { Diagnostic } from './report.ts'

export interface MockViewport { readonly width: number; readonly height: number }
export const MOCK_VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const satisfies Record<string, MockViewport>

/** Parsed, passive HTML rooted at <html>; page.ts adds the trusted doctype and CSP first. */
export interface MockDocument {
  readonly html: string
  readonly viewport: MockViewport
  /** Present target, unknown visible label: only a browser can measure CSS-hidden text correctly. */
  readonly targets: ReadonlyMap<string, undefined>
}
export type MockOutcome =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: true; readonly document: MockDocument; readonly diagnostics: readonly Diagnostic[] }

const ACTIVE: Readonly<Record<string, true>> = { script: true, iframe: true, frame: true, frameset: true, object: true, embed: true, base: true, link: true }
const INTERACTIVE: Readonly<Record<string, true>> = { button: true, a: true, input: true, select: true, textarea: true }
const URL_ATTRIBUTES: Readonly<Record<string, true>> = { src: true, href: true, poster: true, background: true, data: true, action: true, formaction: true, ping: true }
const IMAGE_ELEMENTS: Readonly<Record<string, true>> = { img: true, image: true, feimage: true, input: true }

function viewportOf(value: string): MockViewport | undefined {
  const name = value.trim().toLowerCase()
  if (name === 'desktop' || name === 'mobile') return MOCK_VIEWPORTS[name]
  const match = /^(\d+)\s*x\s*(\d+)$/u.exec(name)
  if (!match) return undefined
  const width = Number(match[1]), height = Number(match[2])
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 ? { width, height } : undefined
}

/** HTML5 parsing, source diagnostics and stripping share one tree on the host and client. */
export function parseMock(source: string): MockOutcome {
  const diagnostics: Diagnostic[] = []
  const issue = (severity: Diagnostic['severity'], message: string, offset = 0): void => {
    diagnostics.push({ severity, message, ...locate(source, offset) })
  }
  const tree = parse(source, {
    sourceCodeLocationInfo: true,
    // Match both renderers: scripts are disabled, so <noscript> contains ordinary markup.
    scriptingEnabled: false,
    onParseError(error) {
      issue(error.code === 'missing-doctype' ? 'warning' : 'error', `HTML 解析问题：${error.code}`, error.startOffset)
    },
  })
  let viewport: MockViewport | undefined
  const declareViewport = (value: string, offset: number): void => {
    const next = viewportOf(value)
    if (!next) issue('error', 'canvas-viewport 应为 desktop、mobile 或 1–4096 范围的 宽x高（例如 390x844）', offset)
    else if (viewport && (viewport.width !== next.width || viewport.height !== next.height)) issue('error', 'canvas-viewport 声明冲突；每个文件只指定一个视口', offset)
    else viewport = next
  }
  const ids = new Map<string, number>()
  const targets = new Map<string, undefined>()
  const walk = (parent: Tree.ParentNode, inert = false): void => {
    parent.childNodes = parent.childNodes.filter(node => {
      const offset = node.sourceCodeLocation?.startOffset ?? 0
      if (node.nodeName === '#comment' && 'data' in node) {
        const match = /^\s*canvas-viewport\s*:\s*(.*?)\s*$/iu.exec(node.data)
        if (match) declareViewport(match[1]!, offset)
        return false
      }
      if (!('tagName' in node)) return true
      const tag = node.tagName.toLowerCase()
      const attr = (name: string): string | undefined => node.attrs.find(item => item.name === name)?.value
      const at = (name: string): number => node.sourceCodeLocation?.attrs?.[name]?.startOffset ?? offset
      const id = attr('id')
      if (id) {
        if (ids.has(id)) issue('error', `重复 id「${id}」（第一次在第 ${locate(source, ids.get(id)!).line} 行）`, at('id'))
        else ids.set(id, at('id'))
      }
      if (tag === 'meta' && attr('name')?.toLowerCase() === 'canvas-viewport') declareViewport(attr('content') ?? '', at('content'))
      if (ACTIVE[tag] === true) {
        issue('warning', `<${tag}> 已阻止并移除；界面稿只允许静态 HTML/CSS`, offset)
        // Still diagnose scripts/resources nested in removed browsing-context markup.
        walk(node, true)
        return false
      }
      if (tag === 'meta' && attr('http-equiv') !== undefined) {
        issue('warning', 'meta http-equiv 已移除；不能覆盖页面安全策略或自动跳转', offset)
        return false
      }
      node.attrs = node.attrs.filter(attribute => {
        const name = attribute.name.toLowerCase()
        const value = attribute.value.trim()
        if (name === 'data-canvas-id') attribute.value = value
        const image = IMAGE_ELEMENTS[tag] === true && /^data:image\//iu.test(value)
        const localFragment = name === 'href' && value.startsWith('#')
        const blocked = name.startsWith('on') || name === 'srcdoc' || name === 'srcset' || name === 'autofocus'
          || (URL_ATTRIBUTES[name] === true && !(localFragment || (image && (name === 'src' || name === 'href'))))
        if (blocked) issue('warning', `<${tag}> 的 ${attribute.prefix ? `${attribute.prefix}:` : ''}${name} 已阻止并移除；不执行脚本、不加载外部资源或导航`, at(name))
        return !blocked
      })
      const anchor = attr('data-canvas-id')?.trim() || id
      if (!inert && tag !== 'head' && tag !== 'html' && tag !== 'meta' && tag !== 'style' && tag !== 'template') {
        if (anchor) {
          if (anchor.length > 200) issue('error', '批注锚点 id / data-canvas-id 最长 200 个字符', at(attr('data-canvas-id') ? 'data-canvas-id' : 'id'))
          else if (targets.has(anchor)) issue('error', `重复批注锚点「${anchor}」；id 与 data-canvas-id 不能指向不同元素`, offset)
          else targets.set(anchor, undefined)
        } else if (INTERACTIVE[tag] === true || attr('role')?.toLowerCase() === 'button') {
          issue('warning', `<${tag}> 交互元素缺少 id 或 data-canvas-id，无法定位元素批注`, offset)
        }
      }
      walk(node, inert || tag === 'head')
      if (tag === 'template' && 'content' in node) walk((node as Tree.Template).content, true)
      return true
    })
  }
  walk(tree)
  if (diagnostics.some(item => item.severity === 'error')) return { ok: false, diagnostics }
  const root = tree.childNodes.find((node): node is Tree.Element => 'tagName' in node && node.tagName === 'html')!
  return { ok: true, document: { html: serializeOuter(root), viewport: viewport ?? MOCK_VIEWPORTS.desktop, targets }, diagnostics }
}
