import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { UserOp } from '../shared/comment-schema.ts'
import { isPending, outlineTargets, threadsOf, type Thread } from '../shared/comments.ts'
import { renderDiagram, type DiagramOutcome } from '../shared/diagram.ts'
import { diagramNodes, type Box, type DiagramNode } from '../shared/nodes.ts'
import { PAGE_PADDING, THEMES, pageHtml, type Page, type Scheme } from '../shared/page.ts'
import { formatDiagnostic } from '../shared/report.ts'
import { CommentList, statusColor, type StatusFilter } from './CommentList.tsx'
import { useComments, type CommentsHandle } from './comments.ts'
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
 * The right-sidebar renderer for Mermaid files: pele's SVG in the same page the host screenshots,
 * with the person's comments pinned on its nodes. DSH re-reads the file when it changes, which
 * replaces `content` and redraws; comments refresh on their own.
 */
export function DiagramPreview({ content, resourceAddress, t }: DocumentBodyProps): ReactNode {
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
  const comments = useComments(resourceAddress)
  const nodes = useMemo(() => outcome?.ok ? diagramNodes(outcome.svg) : [], [outcome])
  const stored = comments.state.status === 'ready' ? comments.state.snapshot.comments : undefined
  const threads = useMemo(() => stored === undefined ? [] : threadsOf(stored, new Map(nodes.map(node => [node.id, node.label]))), [stored, nodes])
  // The same frames canvas_check draws for the model; the key keeps the page (and the iframe) unchanged while they stay the same.
  const outline = outlineTargets(threads).join('\n')
  const page = useMemo(() => outcome?.ok
    ? pageHtml({ markup: outcome.svg, width: outcome.width, height: outcome.height }, scheme, { outline: outline ? outline.split('\n') : [] })
    : undefined, [outcome, scheme, outline])
  if (outcome === undefined) return null
  if (page === undefined) {
    return <div role="alert" style={{ padding: 12 }}>
      <p style={{ margin: '0 0 8px' }}>{t('invalid')}</p>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
        {!outcome.ok && outcome.diagnostics.map(formatDiagnostic).join('\n')}
      </pre>
    </div>
  }
  return <Viewport page={page} scheme={scheme} nodes={nodes} threads={threads} comments={comments} t={t} />
}

interface View { readonly scale: number; readonly x: number; readonly y: number }

const MARGIN = 12
const MIN_SCALE = 0.05
const MAX_SCALE = 8
/** A press that moves less than this is a click (picks a node in comment mode), more is a pan. */
const CLICK_SLOP = 5

/** Centered, shrunk to fit the pane, never enlarged. */
function fitted(box: { readonly width: number; readonly height: number }, page: Page): View {
  const scale = Math.max(MIN_SCALE, Math.min(1, (box.width - 2 * MARGIN) / page.width, (box.height - 2 * MARGIN) / page.height))
  return { scale, x: (box.width - page.width * scale) / 2, y: Math.max(MARGIN, (box.height - page.height * scale) / 2) }
}

/** A node box (SVG pixels) on screen, in pane pixels. */
function onScreen(view: View, box: Box): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } {
  return {
    left: view.x + (PAGE_PADDING + box.x) * view.scale, top: view.y + (PAGE_PADDING + box.y) * view.scale,
    right: view.x + (PAGE_PADDING + box.x + box.width) * view.scale, bottom: view.y + (PAGE_PADDING + box.y + box.height) * view.scale,
  }
}

interface Draft { readonly id: string; readonly node: DiagramNode; readonly text: string; readonly saving: boolean }

/** Client-minted comment id: time, then randomness, within the store's `[A-Za-z0-9_-]{1,64}`. */
function newCommentId(): string {
  return `u-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Pan by dragging or scrolling; zoom with ⌘/Ctrl + wheel, pinch, the buttons, or double-click.
 * Comment mode (button or C): click a node, type, Enter. The page stays a sandboxed iframe; nodes
 * are picked on a transparent layer laid over it from the SVG's own geometry.
 */
function Viewport({ page, scheme, nodes, threads, comments, t }: {
  readonly page: Page
  readonly scheme: Scheme
  readonly nodes: readonly DiagramNode[]
  readonly threads: readonly Thread[]
  readonly comments: CommentsHandle
  readonly t: DocumentBodyProps['t']
}): ReactNode {
  const pane = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  // `undefined` follows the pane: the chart refits on resize and on every redraw.
  const [manual, setManual] = useState<View>()
  const press = useRef<{ readonly pointer: number; readonly x: number; readonly y: number; readonly from: View; readonly manual: View | undefined; readonly node: string | undefined } | undefined>(undefined)
  const [commenting, setCommenting] = useState(false)
  const [draft, setDraft] = useState<Draft>()
  const [listOpen, setListOpen] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>({ open: true, addressed: true, resolved: false })
  const [focused, setFocused] = useState<string>()
  const [hovered, setHovered] = useState<string>()
  const view = manual ?? fitted(box, page)
  const latest = useRef(view)
  latest.current = view
  const red = THEMES[scheme].comment

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

  const controls = (target: EventTarget): boolean => (target as Element).closest('button, textarea, [data-canvas-ui]') !== null
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || controls(event.target)) return
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const node = (event.target as Element).closest('[data-canvas-node]')?.getAttribute('data-canvas-node') ?? undefined
    press.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: latest.current, manual, node }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = press.current
    if (start?.pointer !== event.pointerId) return
    setManual({ ...start.from, x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = press.current
    if (start?.pointer !== event.pointerId) return
    press.current = undefined
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= CLICK_SLOP) return
    // A click leaves the view as it was, including following the pane.
    setManual(start.manual)
    const node = nodes.find(candidate => candidate.id === start.node)
    if (commenting && node !== undefined) setDraft(previous => previous?.node.id === node.id ? previous : { id: newCommentId(), node, text: '', saving: false })
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as Element).closest('textarea, input') || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault()
      setCommenting(on => !on)
      setDraft(undefined)
    } else if (event.key === 'Escape' && commenting) {
      event.preventDefault()
      setCommenting(false)
      setDraft(undefined)
    }
  }
  const center = (factor: number): void => { zoom(factor, box.width / 2, box.height / 2) }

  const submit = async (): Promise<void> => {
    if (draft === undefined || !draft.text.trim() || draft.saving) return
    setDraft({ ...draft, saving: true })
    const op: UserOp = { op: 'create', id: draft.id, text: draft.text.trim(), anchor: { target: draft.node.id, label: draft.node.label } }
    // The id stays with the draft, so pressing Enter again after a failure cannot create a second comment.
    if (await comments.apply([op])) setDraft(undefined)
    else setDraft(current => current === undefined ? current : { ...current, saving: false })
  }

  // Pins: one per drawn node that has threads passing the list's filter, colored by the most urgent.
  const shown = threads.filter(thread => filter[thread.root.status] && thread.root.anchor !== undefined && thread.drift?.kind !== 'gone')
  const pins = nodes.flatMap(node => {
    const here = shown.filter(thread => thread.root.anchor!.target === node.id)
    if (!here.length || !node.boxes.length) return []
    const status = here.some(thread => thread.root.status === 'open') ? 'open' : here.some(thread => thread.root.status === 'addressed') ? 'addressed' : 'resolved'
    return [{ node, here, status, at: onScreen(view, node.boxes[0]!) } as const]
  })
  const focusedTarget = threads.find(thread => thread.root.id === focused)?.root.anchor?.target
  const pending = threads.filter(isPending).length

  const button: CSSProperties = {
    minWidth: 28, height: 28, padding: '0 6px', border: 0, borderRadius: 6, cursor: 'pointer',
    background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12,
  }
  const bar: CSSProperties = {
    position: 'absolute', display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 8,
    background: 'color-mix(in srgb, currentColor 8%, transparent)', backdropFilter: 'blur(6px)',
  }
  const draftAt = draft === undefined || !draft.node.boxes.length ? undefined : onScreen(view, draft.node.boxes[0]!)
  return <div style={{ display: 'flex', width: '100%', height: '100%', minHeight: 240 }}>
    <div ref={pane} data-canvas-diagram data-canvas-commenting={commenting || undefined} tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { press.current = undefined }}
      onKeyDown={onKeyDown}
      onDoubleClick={event => {
        if (controls(event.target) || commenting) return
        if (manual === undefined) {
          const rect = event.currentTarget.getBoundingClientRect()
          zoom(1 / view.scale, event.clientX - rect.left, event.clientY - rect.top)
        } else setManual(undefined)
      }}
      style={{
        position: 'relative', overflow: 'hidden', flex: 1, minWidth: 0, outline: 'none',
        background: page.background, touchAction: 'none', cursor: commenting ? 'crosshair' : 'grab', userSelect: 'none',
      }}>
      <iframe title={t('frame')} srcDoc={page.html} sandbox="" tabIndex={-1} style={{
        position: 'absolute', left: 0, top: 0, width: page.width, height: page.height, border: 0, pointerEvents: 'none',
        background: page.background, transformOrigin: '0 0', transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
      }} />
      {/* Hit boxes over the iframe, in page pixels under the same transform. Only comment mode makes them clickable. */}
      <div aria-hidden style={{
        position: 'absolute', left: 0, top: 0, width: page.width, height: page.height, transformOrigin: '0 0',
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, pointerEvents: commenting ? 'auto' : 'none',
      }}>
        {nodes.flatMap(node => node.boxes.map((box, index) => {
          const lit = (commenting && hovered === node.id) || focusedTarget === node.id || draft?.node.id === node.id
          return <div key={`${node.id}:${index}`} data-canvas-node={node.id} title={commenting ? node.label || node.id : undefined}
            onPointerEnter={() => { setHovered(node.id) }} onPointerLeave={() => { setHovered(current => current === node.id ? undefined : current) }}
            style={{
              position: 'absolute', left: PAGE_PADDING + box.x - 3, top: PAGE_PADDING + box.y - 3, width: box.width + 6, height: box.height + 6,
              borderRadius: 6, cursor: commenting ? 'pointer' : undefined,
              boxShadow: lit ? `0 0 0 ${2 / view.scale}px color-mix(in srgb, ${red} 70%, currentColor)` : undefined,
            }} />
        }))}
      </div>
      {pins.map(({ node, here, status, at }) => <button key={node.id} type="button" data-canvas-pin={node.id}
        aria-label={t('comment.pin', { count: here.length, label: node.label || node.id })} title={t('comment.pin', { count: here.length, label: node.label || node.id })}
        onClick={() => {
          setListOpen(true)
          setFocused(here[0]!.root.id)
        }}
        style={{
          position: 'absolute', left: at.right - 9, top: at.top - 11, minWidth: 20, height: 20, padding: '0 5px', borderRadius: 10,
          border: '2px solid #fff', background: statusColor(status, red), color: '#fff', font: 'inherit', fontSize: 11, fontWeight: 700,
          lineHeight: '16px', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,.35)',
        }}>{here.length}</button>)}
      {draft !== undefined && <form data-canvas-draft data-canvas-ui onSubmit={event => { event.preventDefault(); void submit() }} style={{
        position: 'absolute', zIndex: 2, width: 260, padding: 8, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 6,
        left: Math.max(8, Math.min((draftAt?.left ?? 8), box.width - 268)), top: Math.max(8, Math.min((draftAt?.bottom ?? 8) + 8, box.height - 140)),
        background: 'Canvas', color: 'CanvasText', boxShadow: '0 4px 16px rgba(0,0,0,.3)', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{t('comment.draftTitle', { label: draft.node.label || draft.node.id })}</div>
        <textarea autoFocus rows={3} value={draft.text} placeholder={t('comment.placeholder')} aria-label={t('comment.placeholder')}
          onChange={event => { setDraft({ ...draft, text: event.target.value }) }}
          onKeyDown={event => {
            // Enter inside an IME composition picks a candidate; it must not send.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setDraft(undefined)
              pane.current?.focus({ preventScroll: true })
            }
          }}
          style={{ resize: 'vertical', font: 'inherit', fontSize: 13, padding: 6, borderRadius: 6, border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit' }} />
        {comments.saveError !== undefined && <div role="alert" style={{ fontSize: 12, color: red }}>{t('comment.saveFailed', { error: comments.saveError })}</div>}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" style={{ ...button, border: '1px solid color-mix(in srgb, currentColor 20%, transparent)' }} onClick={() => { setDraft(undefined) }}>{t('comment.cancel')}</button>
          <button type="submit" disabled={draft.saving || !draft.text.trim()} style={{ ...button, background: red, color: '#fff', opacity: draft.saving || !draft.text.trim() ? 0.5 : 1 }}>{t('comment.send')}</button>
        </div>
      </form>}
      <div data-canvas-ui style={{ ...bar, left: 8, top: 8 }}>
        <button type="button" aria-pressed={commenting} title={t('comment.modeHint')} aria-label={t('comment.mode')} onClick={() => {
          setCommenting(on => !on)
          setDraft(undefined)
          pane.current?.focus({ preventScroll: true })
        }} style={{ ...button, background: commenting ? red : 'transparent', color: commenting ? '#fff' : 'inherit' }}>💬 {t('comment.mode')}</button>
        <button type="button" aria-pressed={listOpen} aria-label={t('comment.list')} title={t('comment.list')} onClick={() => { setListOpen(open => !open) }} style={button}>
          ☰ {pending}
        </button>
      </div>
      {commenting && <div data-canvas-ui role="status" style={{ ...bar, left: '50%', bottom: 8, transform: 'translateX(-50%)', padding: '4px 10px', fontSize: 12 }}>{t('comment.modeHint')}</div>}
      {comments.state.status === 'failed' && <div data-canvas-ui role="alert" style={{ ...bar, left: 8, bottom: 8, padding: '4px 10px', fontSize: 12, color: red }}>{t('comment.unavailable', { error: comments.state.error })}</div>}
      <div data-canvas-ui style={{ ...bar, right: 8, bottom: 8 }}>
        <button type="button" style={button} title={t('zoomOut')} aria-label={t('zoomOut')} onClick={() => { center(1 / 1.25) }}>−</button>
        <button type="button" style={button} title={t('actual')} aria-label={t('actual')} onClick={() => { center(1 / view.scale) }}>{Math.round(view.scale * 100)}%</button>
        <button type="button" style={button} title={t('zoomIn')} aria-label={t('zoomIn')} onClick={() => { center(1.25) }}>+</button>
        <button type="button" style={button} title={t('fit')} aria-label={t('fit')} onClick={() => { setManual(undefined) }}>⤢</button>
      </div>
    </div>
    {listOpen && <CommentList threads={threads} filter={filter} onFilter={setFilter} focused={focused} open={red} error={comments.saveError} t={t}
      apply={comments.apply} onClose={() => { setListOpen(false) }} onFocus={thread => { setFocused(thread.root.id) }} />}
  </div>
}
