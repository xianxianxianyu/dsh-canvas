import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { outlineTargets, threadsOf } from '../shared/comments.ts'
import { inspectMock } from '../shared/mock-dom.ts'
import { MOCK_VIEWPORTS, parseMock, type MockDocument, type MockOutcome, type MockViewport } from '../shared/mock.ts'
import type { DiagramNode } from '../shared/nodes.ts'
import { mockPage } from '../shared/page.ts'
import { CommentViewport, PreviewError } from './CommentViewport.tsx'
import { useComments } from './comments.ts'
import type { DocumentBodyProps } from './dsh.ts'
import { readScheme, watchScheme } from './scheme.ts'
import { useTabState } from './tab-state.ts'

const decoder = new TextDecoder()
const NO_NODES: readonly DiagramNode[] = []
type ViewportChoice = 'source' | keyof typeof MOCK_VIEWPORTS
interface Measurement {
  readonly source: MockDocument
  readonly viewport: MockViewport
  readonly nodes: readonly DiagramNode[]
}

/** Only the trusted parent inspects the script-free frame; authored HTML never enters this DOM. */
export function MockPreview(props: DocumentBodyProps): ReactNode {
  return <MockBody key={props.resourceAddress} {...props} />
}

function MockBody({ content, resourceAddress, t }: DocumentBodyProps): ReactNode {
  const scheme = useSyncExternalStore(watchScheme, readScheme)
  const data = content.kind === 'bytes' ? content.data : undefined
  const outcome = useMemo((): MockOutcome | undefined => {
    if (data === undefined) return undefined
    try {
      return parseMock(decoder.decode(data))
    } catch (error) {
      return { ok: false, diagnostics: [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }] }
    }
  }, [data])
  const source = outcome?.ok ? outcome.document : undefined
  const comments = useComments(resourceAddress)
  const [choice, setChoice] = useTabState<ViewportChoice>(resourceAddress, 'mockViewport', 'source')
  const viewport = choice === 'source' ? source?.viewport : MOCK_VIEWPORTS[choice]
  const frame = useRef<HTMLIFrameElement>(null)
  const live = useRef<{ readonly frame: HTMLIFrameElement; readonly document: Document } | undefined>(undefined)
  const [measurement, setMeasurement] = useState<Measurement>()
  const nodes = measurement?.source === source && measurement?.viewport === viewport ? measurement?.nodes ?? NO_NODES : NO_NODES
  const stored = comments.state.status === 'ready' ? comments.state.snapshot.comments : undefined
  const threads = useMemo(() => {
    if (stored === undefined || source === undefined) return []
    // Hidden or not-yet-laid-out anchors still exist. Defer rename drift until a visible label is measured.
    const labels = new Map<string, string | undefined>(source.targets)
    for (const node of nodes) labels.set(node.id, node.label)
    return threadsOf(stored, labels)
  }, [stored, source, nodes])
  const outline = outlineTargets(threads).join('\n')
  const page = useMemo(() => source === undefined || viewport === undefined ? undefined
    : mockPage(source, { viewport, outline: outline ? outline.split('\n') : [] }), [source, viewport, outline])

  useLayoutEffect(() => {
    const element = frame.current
    if (element === null || page === undefined || source === undefined || viewport === undefined) return undefined
    let active = true
    let document: Document | undefined
    let observer: ResizeObserver | undefined
    let pending: number | undefined
    const urlOf = Object.getOwnPropertyDescriptor(Document.prototype, 'URL')!.get!
    const readyStateOf = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState')!.get!
    const rootOf = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement')!.get!
    const fontsOf = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts')!.get!
    const measure = (): void => {
      pending = undefined
      if (!active || document === undefined || frame.current !== element || element.contentDocument !== document) return
      setMeasurement({ source, viewport, nodes: inspectMock(document).nodes })
    }
    const schedule = (): void => {
      if (active && pending === undefined) pending = requestAnimationFrame(measure)
    }
    const loaded = (): void => {
      if (!active || frame.current !== element) return
      const next = element.contentDocument
      // A new iframe initially exposes about:blank; its geometry must never replace the srcdoc's.
      if (next === null || urlOf.call(next) !== 'about:srcdoc' || readyStateOf.call(next) !== 'complete') return
      observer?.disconnect()
      if (document !== undefined) EventTarget.prototype.removeEventListener.call(document, 'load', schedule, true)
      document = next
      live.current = { frame: element, document }
      observer = new ResizeObserver(schedule)
      observer.observe(rootOf.call(document) as HTMLElement)
      for (const target of Document.prototype.querySelectorAll.call(document, '[id], [data-canvas-id]')) observer.observe(target)
      EventTarget.prototype.addEventListener.call(document, 'load', schedule, true)
      void (fontsOf.call(document) as FontFaceSet).ready.then(schedule)
      measure()
    }
    element.addEventListener('load', loaded)
    loaded()
    return () => {
      active = false
      if (pending !== undefined) cancelAnimationFrame(pending)
      observer?.disconnect()
      if (document !== undefined) EventTarget.prototype.removeEventListener.call(document, 'load', schedule, true)
      element.removeEventListener('load', loaded)
      if (live.current?.frame === element) live.current = undefined
    }
  }, [page, source, viewport])

  if (outcome === undefined) return null
  if (!outcome.ok) return <PreviewError diagnostics={outcome.diagnostics} t={t} />
  if (page === undefined || viewport === undefined || source === undefined) return null

  const custom = !Object.values(MOCK_VIEWPORTS).some(preset => preset.width === source.viewport.width && preset.height === source.viewport.height)
  const selected = Object.entries(MOCK_VIEWPORTS).find(([, preset]) => preset.width === viewport.width && preset.height === viewport.height)?.[0] ?? 'source'
  const button: CSSProperties = {
    minWidth: 40, minHeight: 28, padding: '0 8px', border: 0, borderRadius: 6, cursor: 'pointer', color: 'inherit', font: 'inherit', fontSize: 12,
  }
  const choices: readonly ViewportChoice[] = custom ? ['desktop', 'mobile', 'source'] : ['desktop', 'mobile']
  return <CommentViewport address={resourceAddress} page={page} scheme={scheme} nodes={nodes} threads={threads} comments={comments} t={t}
    surface={{
      kind: 'mock', frame,
      pick(x, y) {
        const current = live.current
        if (current === undefined || frame.current !== current.frame || current.frame.contentDocument !== current.document) return undefined
        const document = current.document
        const window = current.frame.contentWindow!
        let element = Document.prototype.elementFromPoint.call(document, x - window.scrollX, y - window.scrollY)
        const parentOf = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')!.get!
        while (element !== null) {
          const id = Element.prototype.getAttribute.call(element, 'data-canvas-id')?.trim() || Element.prototype.getAttribute.call(element, 'id')
          if (id && source.targets.has(id)) return id
          element = parentOf.call(element) as Element | null
        }
        return undefined
      },
      controls: choices.map(item => <button key={item} type="button" aria-pressed={selected === item} onClick={() => { setChoice(item) }}
        style={{ ...button, background: selected === item ? 'color-mix(in srgb, currentColor 18%, transparent)' : 'transparent' }}>
        {item === 'source' ? t('mock.sourceViewport', { width: source.viewport.width, height: source.viewport.height }) : t(`mock.${item}`)}
      </button>),
    }} />
}
