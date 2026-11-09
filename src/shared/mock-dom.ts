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
  const window = document.defaultView!
  const nodes: DiagramNode[] = []
  const diagnostics: Diagnostic[] = []
  const viewport = window.innerWidth
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0)
  if (scrollWidth > viewport) diagnostics.push({ severity: 'warning', message: `横向溢出：页面 scrollWidth ${scrollWidth} px 大于视口 ${viewport} px（超出 ${scrollWidth - viewport} px）` })
  const elements = document.body ? [document.body, ...document.body.querySelectorAll('*')] : []
  for (const element of elements) {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const id = element.getAttribute('data-canvas-id')?.trim() || element.getAttribute('id')
    // innerText follows rendered visibility/wrapping; source textContent would include hidden copy.
    let text = 'innerText' in element ? String(element.innerText) : element.textContent ?? ''
    if (!text.trim()) {
      if (element.tagName === 'INPUT') {
        const input = element as HTMLInputElement
        text = input.type === 'password' && input.value ? '•'.repeat(input.value.length) : input.value || input.placeholder
      } else if (element.tagName === 'TEXTAREA') {
        const textarea = element as HTMLTextAreaElement
        text = textarea.value || textarea.placeholder
      } else if (element.tagName === 'IMG') text = (element as HTMLImageElement).alt
    }
    text = text.replace(/\s+/gu, ' ').trim()
    if (id) nodes.push({ id, label: text, boxes: [{ x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height }] })
    // Restrict the heuristic to elements with their own text, not every clipping ancestor around
    // an image or child layout. Scrollable containers are intentional and not diagnosed as clips.
    const ownText = [...element.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())
      || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
    if (!ownText || !text) continue
    const clippedX = (style.overflowX === 'hidden' || style.overflowX === 'clip') && element.scrollWidth > element.clientWidth + 1
    const clippedY = (style.overflowY === 'hidden' || style.overflowY === 'clip') && element.scrollHeight > element.clientHeight + 1
    if (clippedX || clippedY) diagnostics.push({ severity: 'warning', message: `文字裁切：${id ? `#${id}` : `<${element.tagName.toLowerCase()}>`} 的 overflow:${clippedX ? style.overflowX : style.overflowY} 隐藏了超出内容框的文字「${text.slice(0, 60)}」` })
  }
  return { nodes, diagnostics }
}
