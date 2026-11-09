import type { DiagramNode } from './nodes.ts'
import type { Diagnostic } from './report.ts'

export interface MockInspection {
  readonly nodes: readonly DiagramNode[]
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Trusted parent/Chrome code, never inserted into the mock. Keep the body closure-free: Playwright
 * serializes this function into a JS-disabled context; the preview passes its scriptless iframe DOM.
 */
export function inspectMock(document: Document = globalThis.document): MockInspection {
  // HTMLDocument named properties and HTMLFormElement controls can shadow native APIs.
  // Read from this trusted realm's prototypes, which also accept nodes from the preview frame.
  const getter = <T>(prototype: object, name: string): ((this: object) => T) =>
    Object.getOwnPropertyDescriptor(prototype, name)!.get as (this: object) => T
  const window = getter<Window>(Document.prototype, 'defaultView').call(document)
  const root = getter<HTMLElement>(Document.prototype, 'documentElement').call(document)
  const body = getter<HTMLElement | null>(Document.prototype, 'body').call(document)
  const scrollWidthOf = getter<number>(Element.prototype, 'scrollWidth')
  const scrollHeightOf = getter<number>(Element.prototype, 'scrollHeight')
  const clientWidthOf = getter<number>(Element.prototype, 'clientWidth')
  const clientHeightOf = getter<number>(Element.prototype, 'clientHeight')
  const tagNameOf = getter<string>(Element.prototype, 'tagName')
  const childrenOf = getter<NodeListOf<ChildNode>>(Node.prototype, 'childNodes')
  const textOf = getter<string>(HTMLElement.prototype, 'innerText')
  const contentOf = getter<string | null>(Node.prototype, 'textContent')
  const namespaceOf = getter<string | null>(Element.prototype, 'namespaceURI')
  const nodes: DiagramNode[] = []
  const diagnostics: Diagnostic[] = []
  const viewport = window.innerWidth
  const scrollWidth = Math.max(scrollWidthOf.call(root), body === null ? 0 : scrollWidthOf.call(body))
  if (scrollWidth > viewport) diagnostics.push({ severity: 'warning', message: `横向溢出：页面 scrollWidth ${scrollWidth} px 大于视口 ${viewport} px（超出 ${scrollWidth - viewport} px）` })
  const elements = body === null ? [] : [body, ...Element.prototype.querySelectorAll.call(body, '*')]
  for (const element of elements) {
    const style = globalThis.getComputedStyle(element)
    const rect = Element.prototype.getBoundingClientRect.call(element)
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || !Element.prototype.checkVisibility.call(element, { checkOpacity: true, checkVisibilityCSS: true })) continue
    const id = Element.prototype.getAttribute.call(element, 'data-canvas-id')?.trim() || Element.prototype.getAttribute.call(element, 'id')
    const tag = tagNameOf.call(element)
    // innerText follows rendered visibility/wrapping; source textContent would include hidden copy.
    let text = namespaceOf.call(element) === 'http://www.w3.org/1999/xhtml' ? textOf.call(element) : contentOf.call(element) ?? ''
    if (!text.trim()) {
      if (tag === 'INPUT') {
        const input = element as HTMLInputElement
        text = input.type === 'password' && input.value ? '•'.repeat(input.value.length) : input.value || input.placeholder
      } else if (tag === 'TEXTAREA') {
        const textarea = element as HTMLTextAreaElement
        text = textarea.value || textarea.placeholder
      } else if (tag === 'IMG') text = (element as HTMLImageElement).alt
    }
    text = text.replace(/\s+/gu, ' ').trim()
    if (id) nodes.push({ id, label: text, boxes: [{ x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height }] })
    // Restrict the heuristic to elements with their own text, not every clipping ancestor around
    // an image or child layout. Scrollable containers are intentional and not diagnosed as clips.
    const ownText = [...childrenOf.call(element)].some(node => node.nodeType === 3 && node.textContent?.trim())
      || tag === 'INPUT' || tag === 'TEXTAREA'
    if (!ownText || !text) continue
    const clippedX = (style.overflowX === 'hidden' || style.overflowX === 'clip') && scrollWidthOf.call(element) > clientWidthOf.call(element) + 1
    const clippedY = (style.overflowY === 'hidden' || style.overflowY === 'clip') && scrollHeightOf.call(element) > clientHeightOf.call(element) + 1
    if (clippedX || clippedY) diagnostics.push({ severity: 'warning', message: `文字裁切：${id ? `#${id}` : `<${tag.toLowerCase()}>`} 的 overflow:${clippedX ? style.overflowX : style.overflowY} 隐藏了超出内容框的文字「${text.slice(0, 60)}」` })
  }
  return { nodes, diagnostics }
}
