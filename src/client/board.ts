import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { embedOf, type Board } from '../shared/board.ts'
import type { BoardOp } from '../shared/board-schema.ts'
import type { OpStatus } from '../shared/board-ops.ts'
import type { BoardContent } from '../shared/page.ts'
import type { Diagnostic } from '../shared/report.ts'
import type { BoardRuntime } from './dsh.ts'
import { reconcile, type LostBatch } from './board-ui.ts'

export type BoardLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly board: Board; readonly revision: number }
  | { readonly kind: 'invalid-source'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'not-found' | 'failed'; readonly message: string }

export interface OpFeedback { readonly op: BoardOp; readonly status: OpStatus }
export interface BoardHandle {
  readonly load: BoardLoad
  readonly contents: ReadonlyMap<string, BoardContent>
  readonly diagnostics: readonly Diagnostic[]
  readonly saving: boolean
  readonly refreshing: boolean
  readonly feedback: readonly OpFeedback[]
  readonly error: string | undefined
  readonly retryOps: readonly BoardOp[] | undefined
  readonly lost: readonly LostBatch[]
  submit(ops: readonly BoardOp[]): Promise<boolean>
  decline(ids: readonly string[]): Promise<void>
  refresh(): Promise<void>
}

type RouteFailure = { readonly error: string; readonly message?: string; readonly diagnostics?: readonly Diagnostic[] }
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const failureMessage = (body: RouteFailure, status: number): string => body.message ?? body.error ?? `HTTP ${status}`

/**
 * One tab owns one read generation and one submitted batch. File reads always replace the board;
 * no pending operations are rebased over an agent's new file. React Flow owns only gesture frames.
 * Metadata watches are the same public DSH resources used by the diagram document preview.
 */
export function useBoard(address: string, visible: boolean, runtime: BoardRuntime): BoardHandle {
  const target = useMemo(() => parseFileAddress(address), [address])
  const [load, setLoad] = useState<BoardLoad>({ kind: 'loading' })
  const [contents, setContents] = useState<ReadonlyMap<string, BoardContent>>(new Map())
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<readonly OpFeedback[]>([])
  const [error, setError] = useState<string>()
  const [retryOps, setRetryOps] = useState<readonly BoardOp[]>()
  const [lost, setLost] = useState<readonly LostBatch[]>([])
  const mounted = useRef(true)
  const active = useRef(visible)
  active.current = visible
  const latest = useRef(load)
  latest.current = load
  const sending = useRef(false)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const lossRef = useRef<() => Promise<void>>(async () => {})
  const lifetimeRef = useRef<AbortController>()

  useEffect(() => {
    mounted.current = true
    if (target?.scope !== 'session') {
      setLoad({ kind: 'failed', message: `Not a session file address: ${address}` })
      return
    }
    const lifetime = new AbortController()
    lifetimeRef.current = lifetime
    const watches = new Map<string, () => void>()
    let reading: AbortController | undefined
    let generation = 0
    let contentKey: string | undefined
    let lossesGeneration = 0
    const bodyTarget = { sessionId: target.sessionId, path: target.path }
    const pollLost = async (): Promise<void> => {
      const current = ++lossesGeneration
      try {
        const response = await fetch(`api/canvas/board?${new URLSearchParams(bodyTarget)}`, { cache: 'no-store', signal: lifetime.signal })
        const body = await response.json() as { readonly lost: readonly LostBatch[] } | RouteFailure
        if (lifetime.signal.aborted || current !== lossesGeneration) return
        if (response.ok && 'lost' in body) setLost(body.lost)
        else if ('error' in body && body.error === 'invalid-source') {
          setLoad({ kind: 'invalid-source', diagnostics: body.diagnostics ?? [] })
          setLost([])
        } else if (!response.ok && 'error' in body) setError(failureMessage(body, response.status))
      } catch (error) {
        if (!lifetime.signal.aborted) setError(messageOf(error))
      }
    }
    lossRef.current = pollLost
    const watch = (addresses: readonly string[]): void => {
      const retained = new Set([address, ...addresses])
      for (const [key, release] of watches) if (!retained.has(key)) { release(); watches.delete(key) }
      for (const key of retained) if (!watches.has(key)) {
        watches.set(key, runtime.watchFile(key, () => {
          if (key !== address) contentKey = undefined
          void refresh()
        }))
      }
    }
    const refresh = async (): Promise<void> => {
      if (lifetime.signal.aborted) return
      lossesGeneration++
      const current = ++generation
      reading?.abort()
      const request = new AbortController()
      reading = request
      setRefreshing(true)
      let readComplete = false
      try {
        const read = await runtime.readFile(target.sessionId, target.path, request.signal)
        if (lifetime.signal.aborted || request.signal.aborted || current !== generation) return
        if (!read.ok) {
          const missing = /not.found|ENOENT/i.test(read.error.code)
          setLoad({ kind: missing ? 'not-found' : 'failed', message: read.error.message })
          return
        }
        readComplete = true
        const source = new TextDecoder().decode(read.value.data)
        const next = reconcile(source)
        // Even an identical source after a refused operation retires optimistic gesture coordinates.
        setLoad(next.kind === 'ready' ? { ...next, revision: current } : next)
        if (next.kind !== 'ready') {
          contentKey = undefined
          setContents(new Map())
          setDiagnostics([])
          setLost([])
          watch([])
          return
        }
        const dependencies = next.board.nodes.flatMap(node => node.type === 'file' ? [sessionFileAddress(target.sessionId, embedOf(read.value.absolutePath, node.file).path)] : [])
        watch(dependencies)
        void pollLost()
        // Geometry is rendered responsively in shared node pages; dragging/resizing does not re-read embeds.
        const key = JSON.stringify(next.board.nodes.map(({ x: _x, y: _y, width: _w, height: _h, ...node }) => node))
        if (key !== contentKey) {
          const response = await fetch('api/canvas/board-render', {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: request.signal,
            body: JSON.stringify({ path: read.value.absolutePath, source }),
          })
          const body = await response.json() as { readonly contents: readonly (readonly [string, BoardContent])[]; readonly diagnostics: readonly Diagnostic[] } | RouteFailure
          if (lifetime.signal.aborted || request.signal.aborted || current !== generation) return
          if (!response.ok || !('contents' in body)) throw new Error(failureMessage(body as RouteFailure, response.status))
          contentKey = key
          setContents(new Map(body.contents))
          setDiagnostics(body.diagnostics)
        }
      } catch (error) {
        if (!lifetime.signal.aborted && !request.signal.aborted && current === generation) {
          if (!readComplete) setLoad({ kind: 'failed', message: messageOf(error) })
          else setError(messageOf(error))
        }
      } finally {
        if (!lifetime.signal.aborted && current === generation) setRefreshing(false)
      }
    }
    refreshRef.current = refresh
    watch([])
    void refresh()
    const timer = setInterval(() => { if (active.current && document.visibilityState === 'visible') void pollLost() }, 3000)
    return () => {
      mounted.current = false
      lifetime.abort()
      reading?.abort()
      for (const release of watches.values()) release()
      clearInterval(timer)
    }
  }, [address, target, runtime.readFile, runtime.watchFile])

  useEffect(() => { if (visible) void lossRef.current() }, [visible])
  const refresh = useCallback(() => refreshRef.current(), [])
  const submit = useCallback(async (ops: readonly BoardOp[]): Promise<boolean> => {
    if (sending.current || latest.current.kind !== 'ready' || target?.scope !== 'session' || !ops.length) return false
    sending.current = true
    setSaving(true)
    setError(undefined)
    setRetryOps(undefined)
    setFeedback([])
    let accepted = false
    try {
      const response = await fetch('api/canvas/board', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: lifetimeRef.current?.signal,
        body: JSON.stringify({ sessionId: target.sessionId, path: target.path, ops }),
      })
      const body = await response.json() as { readonly statuses: readonly OpStatus[] } | RouteFailure
      if (!mounted.current) return false
      if (response.ok && 'statuses' in body && body.statuses.length === ops.length
        && body.statuses.every(status => ['applied', 'unchanged', 'missing', 'conflict'].includes(status))) {
        setFeedback(ops.map((op, index) => ({ op, status: body.statuses[index]! })))
        accepted = body.statuses.every(status => status === 'applied' || status === 'unchanged')
      } else {
        const failure = body as RouteFailure
        setError(failureMessage(failure, response.status))
        if (failure.error === 'busy' || response.status >= 500) setRetryOps(ops)
        if (failure.error === 'invalid-source') setLoad({ kind: 'invalid-source', diagnostics: failure.diagnostics ?? [] })
        if (response.status === 404) setLoad({ kind: 'not-found', message: failureMessage(failure, response.status) })
      }
    } catch (error) {
      if (mounted.current) { setError(messageOf(error)); setRetryOps(ops) }
    } finally {
      if (mounted.current) {
        // Never wait for the watch to happen: success, conflict, busy and uncertain replies all re-read.
        await refreshRef.current()
        setSaving(false)
      }
      sending.current = false
    }
    return accepted
  }, [target])
  const decline = useCallback(async (ids: readonly string[]): Promise<void> => {
    if (sending.current || target?.scope !== 'session' || !ids.length) return
    sending.current = true
    setSaving(true)
    setError(undefined)
    try {
      const response = await fetch('api/canvas/board', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: lifetimeRef.current?.signal,
        body: JSON.stringify({ sessionId: target.sessionId, path: target.path, decline: ids }),
      })
      const body = await response.json() as { readonly declined: readonly string[] } | RouteFailure
      if (!response.ok || !('declined' in body)) throw new Error(failureMessage(body as RouteFailure, response.status))
    } catch (error) {
      if (mounted.current) setError(messageOf(error))
    } finally {
      if (mounted.current) {
        // The host owns recovery choices. Never hide a batch until its journal confirms removal.
        await lossRef.current()
        setSaving(false)
      }
      sending.current = false
    }
  }, [target])
  return { load, contents, diagnostics, saving, refreshing, feedback, error, retryOps, lost, submit, decline, refresh }
}
