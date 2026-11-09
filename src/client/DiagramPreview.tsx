import { useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { outlineTargets, threadsOf } from '../shared/comments.ts'
import { renderDiagram, type DiagramOutcome } from '../shared/diagram.ts'
import { diagramNodes } from '../shared/nodes.ts'
import { PAGE_PADDING, pageHtml } from '../shared/page.ts'
import { CommentViewport, PreviewError } from './CommentViewport.tsx'
import { useComments } from './comments.ts'
import type { DocumentBodyProps } from './dsh.ts'
import { readScheme, watchScheme } from './scheme.ts'

const decoder = new TextDecoder()

/**
 * The right-sidebar renderer for Mermaid files: pele's SVG in the same page the host screenshots,
 * with the person's comments pinned on its nodes. DSH re-reads the file when it changes, which
 * remounts this body with the new `content`; comments refresh on their own, and the tab's state
 * (comment list, comment mode, draft, zoom) is kept per file address across those remounts.
 */
export function DiagramPreview(props: DocumentBodyProps): ReactNode {
  // One body per file, so per-tab state never carries over to another file shown in the same slot.
  return <DiagramBody key={props.resourceAddress} {...props} />
}

function DiagramBody({ content, resourceAddress, t }: DocumentBodyProps): ReactNode {
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
  // The shared viewport uses page CSS pixels; adapt SVG-local boxes exactly once here.
  const nodes = useMemo(() => outcome?.ok ? diagramNodes(outcome.svg).map(node => ({
    ...node, boxes: node.boxes.map(box => ({ ...box, x: box.x + PAGE_PADDING, y: box.y + PAGE_PADDING })),
  })) : [], [outcome])
  const stored = comments.state.status === 'ready' ? comments.state.snapshot.comments : undefined
  const threads = useMemo(() => stored === undefined ? [] : threadsOf(stored, new Map(nodes.map(node => [node.id, node.label]))), [stored, nodes])
  // The same frames canvas_check draws for the model; the key keeps the page (and the iframe) unchanged while they stay the same.
  const outline = outlineTargets(threads).join('\n')
  const page = useMemo(() => outcome?.ok
    ? pageHtml({ markup: outcome.svg, width: outcome.width, height: outcome.height }, scheme, { outline: outline ? outline.split('\n') : [] })
    : undefined, [outcome, scheme, outline])
  if (outcome === undefined) return null
  if (page === undefined) return <PreviewError diagnostics={!outcome.ok ? outcome.diagnostics : []} t={t} />
  return <CommentViewport address={resourceAddress} page={page} scheme={scheme} nodes={nodes} threads={threads} comments={comments} surface={{ kind: 'diagram' }} t={t} />
}

