import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CommentStatus, UserOp } from '../shared/comment-schema.ts'
import { COMMENT_STATUSES, type Drift, type Thread } from '../shared/comments.ts'
import type { DocumentBodyProps } from './dsh.ts'

/** Badge colors per status: open matches the red frame on the page. */
export function statusColor(status: CommentStatus, open: string): string {
  return status === 'open' ? open : status === 'addressed' ? '#d48a0b' : 'color-mix(in srgb, currentColor 45%, transparent)'
}

export type StatusFilter = { readonly [S in CommentStatus]: boolean }

const small: CSSProperties = { fontSize: 12, opacity: 0.7 }
const action: CSSProperties = {
  height: 24, padding: '0 8px', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', borderRadius: 6,
  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer',
}

function driftText(t: DocumentBodyProps['t'], target: string, label: string, drift: Drift): string {
  const head = drift.kind === 'gone' ? t('comment.gone', { target, label }) : t('comment.renamed', { target, label, now: drift.label })
  return drift.movedTo.length ? `${head}；${t('comment.movedTo', { label, ids: drift.movedTo.join('、') })}` : head
}

function when(at: string): string {
  const date = new Date(at)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

function ThreadItem({ thread, focused, open, t, apply, onFocus }: {
  readonly thread: Thread
  readonly focused: boolean
  readonly open: string
  readonly t: DocumentBodyProps['t']
  readonly apply: (ops: readonly UserOp[]) => Promise<boolean>
  readonly onFocus: () => void
}): ReactNode {
  const { root, replies, drift } = thread
  const [confirming, setConfirming] = useState(false)
  const element = useRef<HTMLElement>(null)
  useEffect(() => { if (focused) element.current?.scrollIntoView({ block: 'nearest' }) }, [focused])
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => { setConfirming(false) }, 3000)
    return () => { clearTimeout(timer) }
  }, [confirming])
  const status = (next: 'open' | 'resolved') => { void apply([{ op: 'status', id: root.id, status: next }]) }
  return <article ref={element} data-canvas-thread={root.id} data-status={root.status} aria-current={focused || undefined} style={{
    padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
    background: focused ? 'color-mix(in srgb, currentColor 7%, transparent)' : undefined,
  }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <button type="button" onClick={onFocus} style={{ ...action, border: 0, padding: 0, height: 'auto', fontWeight: 600, textAlign: 'left', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {root.anchor === undefined ? t('comment.whole') : root.anchor.label || root.anchor.target}
      </button>
      <span data-canvas-status style={{ fontSize: 12, color: statusColor(root.status, open), whiteSpace: 'nowrap' }}>● {t(`comment.status.${root.status}`)}</span>
    </header>
    {drift !== undefined && root.anchor !== undefined && <p role="note" style={{ margin: '0 0 4px', fontSize: 12, color: '#d48a0b' }}>⚠ {driftText(t, root.anchor.target, root.anchor.label, drift)}</p>}
    <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{root.text}</p>
    <div style={small}>{root.author === 'user' ? t('comment.you') : t('comment.agent')} · {when(root.at)}</div>
    {replies.map(reply => <div key={reply.id} data-canvas-reply={reply.id} style={{ margin: '6px 0 0 10px', paddingLeft: 8, borderLeft: '2px solid color-mix(in srgb, currentColor 20%, transparent)' }}>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><strong>{reply.author === 'user' ? t('comment.you') : t('comment.agent')}</strong> {reply.text}</div>
      <div style={small}>{when(reply.at)}</div>
    </div>)}
    <footer style={{ display: 'flex', gap: 6, marginTop: 8 }}>
      {root.status !== 'resolved' && <button type="button" style={action} onClick={() => { status('resolved') }}>{t('comment.resolve')}</button>}
      {root.status !== 'open' && <button type="button" style={action} onClick={() => { status('open') }}>{t('comment.reopen')}</button>}
      {root.author === 'user' && <button type="button" style={{ ...action, marginLeft: 'auto', color: confirming ? open : undefined }} onClick={() => {
        if (confirming) void apply([{ op: 'delete', id: root.id }])
        else setConfirming(true)
      }}>{confirming ? t('comment.confirmDelete') : t('comment.delete')}</button>}
    </footer>
  </article>
}

/**
 * The side list: threads filtered by status, each with its replies, drift warning and actions.
 */
export function CommentList({ threads, filter, onFilter, focused, onFocus, open, error, t, apply, onClose }: {
  readonly threads: readonly Thread[]
  readonly filter: StatusFilter
  readonly onFilter: (filter: StatusFilter) => void
  readonly focused: string | undefined
  readonly onFocus: (thread: Thread) => void
  readonly open: string
  readonly error: string | undefined
  readonly t: DocumentBodyProps['t']
  readonly apply: (ops: readonly UserOp[]) => Promise<boolean>
  readonly onClose: () => void
}): ReactNode {
  const visible = threads.filter(thread => filter[thread.root.status])
  return <aside data-canvas-comments aria-label={t('comment.list')} style={{
    width: 300, maxWidth: '55%', flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0,
    borderLeft: '1px solid color-mix(in srgb, currentColor 15%, transparent)', fontSize: 13,
  }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 8px 8px 12px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
      <div role="group" aria-label={t('comment.filter')} style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap' }}>
        {COMMENT_STATUSES.map(status => <button key={status} type="button" aria-pressed={filter[status]} data-canvas-filter={status}
          onClick={() => { onFilter({ ...filter, [status]: !filter[status] }) }}
          style={{ ...action, background: filter[status] ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent' }}>
          {t(`comment.status.${status}`)} {threads.filter(thread => thread.root.status === status).length}
        </button>)}
      </div>
      <button type="button" aria-label={t('comment.close')} title={t('comment.close')} style={{ ...action, border: 0 }} onClick={onClose}>✕</button>
    </header>
    {error !== undefined && <p role="alert" style={{ margin: 0, padding: '8px 12px', color: open }}>{t('comment.saveFailed', { error })}</p>}
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {visible.length === 0
        ? <p style={{ margin: 0, padding: 12, opacity: 0.7 }}>{threads.length ? t('comment.emptyFiltered') : t('comment.empty')}</p>
        : visible.map(thread => <ThreadItem key={thread.root.id} thread={thread} focused={thread.root.id === focused} open={open} t={t} apply={apply} onFocus={() => { onFocus(thread) }} />)}
    </div>
  </aside>
}
