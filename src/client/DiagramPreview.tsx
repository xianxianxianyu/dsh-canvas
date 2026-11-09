import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { renderDiagram, type DiagramOutcome } from '../shared/diagram.ts'
import { pageHtml, type Page, type Scheme } from '../shared/page.ts'
import { formatDiagnostic } from '../shared/report.ts'
import type { DocumentBodyProps } from './dsh.ts'

// DSH sets the root `color-scheme` to the active theme's light or dark.
function readScheme(): Scheme {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light'
}

function watchScheme(changed: () => void): () => void {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  return () => { observer.disconnect() }
}

const decoder = new TextDecoder()

/**
 * The right-sidebar renderer for Mermaid files: pele's SVG in the same page the host screenshots.
 * DSH re-reads the file when it changes, which replaces `content` and redraws.
 */
export function DiagramPreview({ content, t }: DocumentBodyProps): ReactNode {
  const scheme = useSyncExternalStore(watchScheme, readScheme)
  const data = content.kind === 'bytes' ? content.data : undefined
  const outcome = useMemo((): DiagramOutcome | undefined => {
    if (data === undefined) return undefined
    try {
      return renderDiagram(decoder.decode(data))
    } catch (error) {
      return { ok: false, diagnostics: [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }] }
    }
  }, [data])
  const page = useMemo(() => outcome?.ok
    ? pageHtml({ markup: outcome.svg, width: outcome.width, height: outcome.height }, scheme)
    : undefined, [outcome, scheme])
  if (outcome === undefined) return null
  if (page === undefined) {
    return <div role="alert" style={{ padding: 12 }}>
      <p style={{ margin: '0 0 8px' }}>{t('invalid')}</p>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
        {!outcome.ok && outcome.diagnostics.map(formatDiagnostic).join('\n')}
      </pre>
    </div>
  }
  return <Viewport page={page} t={t} />
}

interface View { readonly scale: number; readonly x: number; readonly y: number }

const MARGIN = 12
const MIN_SCALE = 0.05
const MAX_SCALE = 8

/** Centered, shrunk to fit the pane, never enlarged. */
function fitted(box: { readonly width: number; readonly height: number }, page: Page): View {
  const scale = Math.max(MIN_SCALE, Math.min(1, (box.width - 2 * MARGIN) / page.width, (box.height - 2 * MARGIN) / page.height))
  return { scale, x: (box.width - page.width * scale) / 2, y: Math.max(MARGIN, (box.height - page.height * scale) / 2) }
}

/** Pan by dragging or scrolling; zoom with ⌘/Ctrl + wheel, pinch, the buttons, or double-click. */
function Viewport({ page, t }: { readonly page: Page; readonly t: DocumentBodyProps['t'] }): ReactNode {
  const pane = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  // `undefined` follows the pane: the chart refits on resize and on every redraw.
  const [manual, setManual] = useState<View>()
  const drag = useRef<{ readonly pointer: number; readonly x: number; readonly y: number; readonly from: View } | undefined>(undefined)
  const view = manual ?? fitted(box, page)
  const latest = useRef(view)
  latest.current = view

  useLayoutEffect(() => {
    const element = pane.current!
    const observer = new ResizeObserver(() => { setBox({ width: element.clientWidth, height: element.clientHeight }) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // Reads only refs and the state setter, so the wheel listener below may keep the first copy.
  const zoom = (factor: number, cx: number, cy: number): void => {
    const from = latest.current
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, from.scale * factor))
    setManual({ scale, x: cx - (cx - from.x) * scale / from.scale, y: cy - (cy - from.y) * scale / from.scale })
  }

  useEffect(() => {
    const element = pane.current!
    // React's wheel listener is passive; this one must prevent page scrolling.
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top)
      else setManual({ ...latest.current, x: latest.current.x - event.deltaX, y: latest.current.y - event.deltaY })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: latest.current }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    if (start?.pointer !== event.pointerId) return
    setManual({ ...start.from, x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer === event.pointerId) drag.current = undefined
  }
  const center = (factor: number): void => { zoom(factor, box.width / 2, box.height / 2) }

  const button: CSSProperties = {
    minWidth: 28, height: 28, padding: '0 6px', border: 0, borderRadius: 6, cursor: 'pointer',
    background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12,
  }
  return <div ref={pane} data-canvas-diagram
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
    onDoubleClick={event => {
      if ((event.target as Element).closest('button')) return
      if (manual === undefined) {
        const rect = event.currentTarget.getBoundingClientRect()
        zoom(1 / view.scale, event.clientX - rect.left, event.clientY - rect.top)
      } else setManual(undefined)
    }}
    style={{
      position: 'relative', overflow: 'hidden', width: '100%', height: '100%', minHeight: 240,
      background: page.background, touchAction: 'none', cursor: 'grab', userSelect: 'none',
    }}>
    <iframe title={t('frame')} srcDoc={page.html} sandbox="" tabIndex={-1} style={{
      position: 'absolute', left: 0, top: 0, width: page.width, height: page.height, border: 0, pointerEvents: 'none',
      background: page.background, transformOrigin: '0 0', transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    }} />
    <div style={{
      position: 'absolute', right: 8, bottom: 8, display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 8,
      background: 'color-mix(in srgb, currentColor 8%, transparent)', backdropFilter: 'blur(6px)',
    }}>
      <button type="button" style={button} title={t('zoomOut')} aria-label={t('zoomOut')} onClick={() => { center(1 / 1.25) }}>−</button>
      <button type="button" style={button} title={t('actual')} aria-label={t('actual')} onClick={() => { center(1 / view.scale) }}>{Math.round(view.scale * 100)}%</button>
      <button type="button" style={button} title={t('zoomIn')} aria-label={t('zoomIn')} onClick={() => { center(1.25) }}>+</button>
      <button type="button" style={button} title={t('fit')} aria-label={t('fit')} onClick={() => { setManual(undefined) }}>⤢</button>
    </div>
  </div>
}
