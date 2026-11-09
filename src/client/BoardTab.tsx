import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ReactFlow, ReactFlowProvider, Handle, Position, NodeResizer, BaseEdge, EdgeLabelRenderer, ConnectionMode, applyNodeChanges, useReactFlow } from '@xyflow/react'
import type { Connection, Edge, EdgeProps, Node, NodeProps } from '@xyflow/react'
import flowCss from '@xyflow/react/dist/style.css'
import { SIDES, scene, type Board, type BoardNode, type SceneEdge } from '../shared/board.ts'
import { boardNodePageHtml, boardColor, edgePath, EDGE_LABEL, THEMES, type BoardContent, type Scheme } from '../shared/page.ts'
import type { BoardOp } from '../shared/board-schema.ts'
import { DIAGRAM_FONT } from '../shared/diagram.ts'
import { formatDiagnostic } from '../shared/report.ts'
import type { BoardTabProps, DocumentBodyProps } from './dsh.ts'
import { useBoard, type BoardHandle } from './board.ts'
import { boardId, connectOp, placeOp, removeOps, visibleLosses } from './board-ui.ts'

import { readScheme, watchScheme } from './scheme.ts'

type Translate = DocumentBodyProps['t']
type CanvasNode = Node<{ node: BoardNode; content: BoardContent | undefined; scheme: Scheme; editable: boolean; place: (op: BoardOp) => void }, 'canvas'>
type CanvasEdge = Edge<{ geometry: SceneEdge; scheme: Scheme }, 'canvas'>
const POSITIONS = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }
const nodeTypes = { canvas: NodeBox }
const edgeTypes = { canvas: BoardLine }
const fill: CSSProperties = { width: '100%', height: '100%', minHeight: 0, minWidth: 0 }
const button: CSSProperties = { border: '1px solid currentColor', borderRadius: 5, padding: '4px 8px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }

function NodeBox({ data, selected }: NodeProps<CanvasNode>): ReactNode {
  const page = useMemo(() => boardNodePageHtml(data.node, data.content, data.scheme), [data.node, data.content, data.scheme])
  // Each prepared document owns its frame; geometry changes keep this identity and only resize it.
  return <div data-canvas-board-node={data.node.id} style={fill}>
    <iframe key={page.html} title={data.node.id} sandbox="" srcDoc={page.html} tabIndex={-1} style={{ ...fill, display: 'block', border: 0, pointerEvents: 'none', background: 'transparent' }} />
    <NodeResizer isVisible={selected && data.editable} minWidth={40} minHeight={40} onResizeEnd={(_event, box) => { data.place(placeOp(data.node.id, box)) }} />
    {SIDES.map(side => <Handle key={side} id={side} type="source" position={POSITIONS[side]} isConnectable={data.editable}
      style={{ width: 8, height: 8, background: THEMES[data.scheme].pele.fg, borderColor: THEMES[data.scheme].pele.bg, opacity: data.editable ? 1 : 0 }} />)}
  </div>
}

function BoardLine({ id, data, selected }: EdgeProps<CanvasEdge>): ReactNode {
  const marker = `canvas-arrow-${useId()}`
  if (data === undefined) return null
  const { geometry, scheme } = data
  const color = boardColor(geometry.edge.color) ?? THEMES[scheme].pele.line
  return <>
    <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={color} /></marker></defs>
    <BaseEdge id={id} path={edgePath(geometry)} style={{ stroke: color, strokeWidth: selected ? 3 : 2 }}
      markerStart={geometry.arrows.from ? `url(#${marker})` : undefined} markerEnd={geometry.arrows.to ? `url(#${marker})` : undefined} />
    {geometry.edge.label && <EdgeLabelRenderer><div data-canvas-edge-label={id} className="nodrag nopan"
      style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${geometry.mid.x}px, ${geometry.mid.y}px)`, ...EDGE_LABEL, background: THEMES[scheme].pele.bg, color: THEMES[scheme].pele.fg, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{geometry.edge.label}</div></EdgeLabelRenderer>}
  </>
}

/** A real pane-tab body: the source Session comes from its file address, never the current chat. */
export function BoardTab(props: BoardTabProps): ReactNode {
  const { tab } = props.useTabInfo()
  return <BoardBody key={tab.contentId} address={tab.contentId} visible={tab.visible} runtime={props} t={props.t} />
}

function BoardBody({ address, visible, runtime, t }: { readonly address: string; readonly visible: boolean; readonly runtime: BoardTabProps; readonly t: Translate }): ReactNode {
  const handle = useBoard(address, visible, runtime)
  const scheme = useSyncExternalStore(watchScheme, readScheme)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const readonly = handle.load.kind !== 'ready'
  const lost = visibleLosses(handle.lost, dismissed)
  return <div data-canvas-board data-readonly={readonly ? 'true' : 'false'} style={{ ...fill, display: 'flex', flexDirection: 'column', position: 'relative', color: THEMES[scheme].pele.fg, background: THEMES[scheme].pele.bg, fontFamily: DIAGRAM_FONT, lineHeight: 'normal' }}>
    <style>{flowCss}</style>
    <style>{'[data-canvas-board] .react-flow__node-canvas{border:0;background:transparent;border-radius:8px;padding:0}[data-canvas-board] .react-flow__node.selected{outline:1px solid #688fff;outline-offset:3px}[data-canvas-board] button:disabled{opacity:.45;cursor:default}[data-canvas-board] .react-flow__attribution{font-size:9px}'}</style>
    {lost.length > 0 && <div role="alert" style={{ padding: 8, maxHeight: 180, overflow: 'auto', fontSize: 12, background: THEMES[scheme].mayBreak.fill }}>
      <strong>{t('board.lost')}</strong>
      {lost.map(batch => <div key={batch.id} data-canvas-lost={batch.id} style={{ marginTop: 6 }}>
        <div>{new Date(batch.at).toLocaleTimeString()} · {batch.count} · {batch.id}</div>
        <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0', fontSize: 11 }}>{JSON.stringify(batch.ops)}</pre>
        <button style={button} disabled={readonly || handle.saving || handle.refreshing} onClick={() => { void handle.submit(batch.ops) }}>{t('board.reapply')}</button>{' '}
        <button style={button} onClick={() => { setDismissed(previous => new Set([...previous, batch.id])) }}>{t('board.dismiss')}</button>
      </div>)}
    </div>}
    {handle.error && <div role="alert" style={{ padding: 8, fontSize: 12 }}>{handle.error}{handle.retryOps && <button style={{ ...button, marginLeft: 8 }} disabled={readonly || handle.saving || handle.refreshing} onClick={() => { void handle.submit(handle.retryOps!) }}>{t('board.retry')}</button>}</div>}
    {handle.feedback.length > 0 && <div data-canvas-board-status role="status" style={{ padding: '4px 8px', fontSize: 12 }}>
      {handle.feedback.map((item, index) => <div key={index}>{item.op.op} {'id' in item.op ? item.op.id : item.op.ids.join(', ')}: {t(`board.${item.status === 'missing' ? 'absent' : item.status}`)}</div>)}
    </div>}
    {handle.load.kind === 'loading' ? <p style={{ padding: 12 }}>{t('board.loading')}</p>
      : handle.load.kind === 'invalid-source' ? <div role="alert" style={{ padding: 12 }}><p>{t('board.readonly')}</p><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{handle.load.diagnostics.map(formatDiagnostic).join('\n')}</pre></div>
        : handle.load.kind !== 'ready' ? <div role="alert" style={{ padding: 12 }}><p>{handle.load.kind === 'not-found' ? t('board.missing') : handle.load.message}</p><button style={button} onClick={() => { void handle.refresh() }}>{t('board.refresh')}</button></div>
          : <ReactFlowProvider><BoardCanvas board={handle.load.board} revision={handle.load.revision} handle={handle} scheme={scheme} t={t} /></ReactFlowProvider>}
  </div>
}

type Draft =
  | { readonly kind: 'note'; readonly id: string; readonly x: number; readonly y: number; readonly text: string }
  | { readonly kind: 'text'; readonly id: string; readonly original: string; readonly text: string }
  | { readonly kind: 'edge'; readonly id: string; readonly connection: Connection; readonly text: string }

function BoardCanvas({ board, revision, handle, scheme, t }: { readonly board: Board; readonly revision: number; readonly handle: BoardHandle; readonly scheme: Scheme; readonly t: Translate }): ReactNode {
  const flow = useReactFlow<CanvasNode, CanvasEdge>()
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set())
  const [draft, setDraft] = useState<Draft>()
  const fitted = useRef(false)
  const editable = !handle.saving
  const submitPlace = useMemo(() => (op: BoardOp): void => { void handle.submit([op]) }, [handle.submit])

  // A new file generation replaces every local box; selection is the only retained node field.
  useLayoutEffect(() => {
    setNodes(previous => {
      const selected = new Set(previous.filter(node => node.selected).map(node => node.id))
      return scene(board).nodes.map(({ node, rect }, index) => ({
        id: node.id, type: 'canvas', position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height,
        style: { width: rect.width, height: rect.height }, selected: selected.has(node.id),
        zIndex: node.type === 'group' ? index : board.nodes.length + 2,
        data: { node, content: handle.contents.get(node.id), scheme, editable, place: submitPlace },
      }))
    })
  }, [board, revision])
  // Content/theme/lock updates must not reset a gesture's coordinates.
  useLayoutEffect(() => {
    setNodes(previous => previous.map(node => ({ ...node, data: { ...node.data, content: handle.contents.get(node.id), scheme, editable, place: submitPlace } })))
  }, [handle.contents, scheme, editable, submitPlace])
  useEffect(() => {
    if (fitted.current || !nodes.length) return
    const frame = requestAnimationFrame(() => { void flow.fitView({ padding: .15, maxZoom: 1 }); fitted.current = true })
    return () => { cancelAnimationFrame(frame) }
  }, [nodes.length, flow])

  const geometry = useMemo(() => {
    const current = new Map(nodes.map(node => [node.id, node]))
    return scene({ ...board, nodes: board.nodes.map(node => {
      const visual = current.get(node.id)
      return visual === undefined ? node : { ...node, x: visual.position.x, y: visual.position.y, width: visual.width ?? node.width, height: visual.height ?? node.height }
    }) })
  }, [board, nodes])
  const edges: CanvasEdge[] = geometry.edges.map(edge => ({ id: edge.id, type: 'canvas', source: edge.edge.fromNode, target: edge.edge.toNode,
    sourceHandle: edge.from.side, targetHandle: edge.to.side, selected: selectedEdges.has(edge.id), zIndex: board.nodes.length + 1, data: { geometry: edge, scheme } }))
  const remove = (): void => {
    if (!editable) return
    const ops = removeOps(nodes.filter(node => node.selected).map(node => node.id), edges.filter(edge => selectedEdges.has(edge.id)))
    if (ops.length) void handle.submit(ops)
  }
  const saveDraft = async (): Promise<void> => {
    if (!draft || !editable) return
    const op: BoardOp = draft.kind === 'note' ? { op: 'addNote', id: draft.id, text: draft.text, x: Math.round(draft.x), y: Math.round(draft.y), width: 240, height: 160 }
      : draft.kind === 'text' ? { op: 'setText', id: draft.id, text: draft.text, ifText: draft.original }
        : connectOp(draft.id, draft.connection, draft.text)
    if (await handle.submit([op])) setDraft(undefined)
  }
  return <div style={{ ...fill, flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 6, fontSize: 11, alignItems: 'center' }}>
      <button style={button} aria-label={t('zoomOut')} onClick={() => { void flow.zoomOut() }}>−</button>
      <button style={button} aria-label={t('zoomIn')} onClick={() => { void flow.zoomIn() }}>+</button>
      <button style={button} aria-label={t('fit')} onClick={() => { void flow.fitView({ padding: .15, maxZoom: 1 }) }}>{t('fit')}</button>
      <button style={button} disabled={!editable || (!nodes.some(node => node.selected) && !selectedEdges.size)} onClick={remove}>{t('board.delete')}</button>
      <span>{t('board.hint')}</span>
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <ReactFlow<CanvasNode, CanvasEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode={scheme}
        minZoom={.05} maxZoom={8} zoomOnDoubleClick={false} connectionMode={ConnectionMode.Loose} nodesDraggable={editable} nodesConnectable={editable}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null} onlyRenderVisibleElements={false}
        onNodesChange={changes => { setNodes(current => applyNodeChanges(changes, current)) }}
        onEdgesChange={changes => { setSelectedEdges(previous => { const next = new Set(previous); for (const change of changes) if (change.type === 'select') { if (change.selected) next.add(change.id); else next.delete(change.id) } return next }) }}
        onBeforeDelete={async ({ nodes, edges }) => { if (editable) await handle.submit(removeOps(nodes.map(node => node.id), edges)); return false }}
        onNodeDragStop={(_event, _node, dragged) => { if (editable) void handle.submit(dragged.map(node => placeOp(node.id, node.position))) }}
        onNodeDoubleClick={(_event, node) => { if (editable && node.data.node.type === 'text') setDraft({ kind: 'text', id: node.id, original: node.data.node.text, text: node.data.node.text }) }}
        onConnect={connection => { if (editable) setDraft({ kind: 'edge', id: boardId(), connection, text: '' }) }}
        onPaneClick={() => { setSelectedEdges(new Set()) }}
        onDoubleClick={event => {
          if (!editable || !(event.target as HTMLElement).classList.contains('react-flow__pane')) return
          const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
          setDraft({ kind: 'note', id: boardId(), ...point, text: '' })
        }}
      />
    </div>
    {handle.diagnostics.some(entry => entry.severity === 'error') && <div role="alert" style={{ padding: 6, fontSize: 11, maxHeight: 100, overflow: 'auto' }}>{handle.diagnostics.filter(entry => entry.severity === 'error').map(formatDiagnostic).join('\n')}</div>}
    {draft && <form data-canvas-board-editor onSubmit={event => { event.preventDefault(); void saveDraft() }}
      onKeyDown={event => { if (event.key === 'Escape') setDraft(undefined); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void saveDraft() } }}
      style={{ position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 1000, padding: 12, border: `1px solid ${THEMES[scheme].pele.border}`, borderRadius: 8, background: THEMES[scheme].pele.surface, boxShadow: '0 4px 20px #0004' }}>
      <label style={{ display: 'block', fontSize: 12 }}>{t(draft.kind === 'edge' ? 'board.label' : 'board.text')}
        {draft.kind === 'edge' ? <input autoFocus aria-label={t('board.label')} maxLength={500} value={draft.text} onChange={event => { setDraft({ ...draft, text: event.target.value }) }} style={{ width: '100%', margin: '8px 0', color: 'inherit', background: 'transparent', border: '1px solid currentColor', padding: 6 }} />
          : <textarea autoFocus aria-label={t('board.text')} rows={5} maxLength={20000} value={draft.text} onChange={event => { setDraft({ ...draft, text: event.target.value }) }} style={{ width: '100%', boxSizing: 'border-box', margin: '8px 0', color: 'inherit', background: 'transparent', border: '1px solid currentColor', padding: 6 }} />}
      </label>
      <button type="submit" style={button} disabled={!editable}>{t(draft.kind === 'edge' ? 'board.connect' : 'board.save')}</button>{' '}
      <button type="button" style={button} onClick={() => { setDraft(undefined) }}>{t('board.cancel')}</button>
    </form>}
  </div>
}
