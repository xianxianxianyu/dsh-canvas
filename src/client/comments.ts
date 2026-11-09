import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommentsSnapshot, UserOp } from '../shared/comment-schema.ts'

/** Document-relative, like DSH's own routes, so a mounted web app reaches its own Host. */
const ROUTE = 'api/canvas/comments'
/** The store lives in the Host's data root, which DSH's file watching does not cover; ask every few seconds instead. */
const POLL_MS = 3000

export type CommentsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: CommentsSnapshot }
  | { readonly status: 'failed'; readonly error: string }

export interface CommentsHandle {
  readonly state: CommentsState
  /** The last failed save, until the next successful one. */
  readonly saveError: string | undefined
  /** Send the person's changes; resolves false when the Host refused them (see `saveError`). */
  apply(ops: readonly UserOp[]): Promise<boolean>
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') return body.error
  } catch {
    // Fall through to the status line.
  }
  return `HTTP ${response.status}`
}

/**
 * The comments of the previewed file, kept fresh while the page is visible.
 * @param resourceAddress - the document tab's `dsh-resource://file/…` address.
 * @returns the current comments and a way to change them.
 */
export function useComments(resourceAddress: string): CommentsHandle {
  // What the route needs to find the file: the Session and its path (absolute or workspace-relative), or an absolute path alone.
  const target = useMemo((): Readonly<Record<string, string>> | undefined => {
    const address = parseFileAddress(resourceAddress)
    return address === undefined ? undefined : address.scope === 'session' ? { sessionId: address.sessionId, path: address.path } : { path: address.path }
  }, [resourceAddress])
  const [state, setState] = useState<CommentsState>({ status: 'loading' })
  const [saveError, setSaveError] = useState<string>()
  const version = useRef<string>(undefined)

  useEffect(() => {
    version.current = undefined
    if (target === undefined) {
      setState({ status: 'failed', error: resourceAddress })
      return undefined
    }
    setState({ status: 'loading' })
    const lifetime = new AbortController()
    // A failed poll keeps comments already shown; only a first load that fails shows the error.
    const failed = (error: string): void => { setState(previous => previous.status === 'ready' ? previous : { status: 'failed', error }) }
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      clearTimeout(timer)
      if (document.visibilityState === 'visible') {
        try {
          const query = new URLSearchParams({ ...target, ...version.current === undefined ? {} : { since: version.current } })
          const response = await fetch(`${ROUTE}?${query}`, { cache: 'no-store', signal: lifetime.signal })
          if (!response.ok) failed(await errorOf(response))
          else {
            const body = await response.json() as CommentsSnapshot | { readonly version: string }
            if ('comments' in body) {
              version.current = body.version
              setState({ status: 'ready', snapshot: body })
            }
          }
        } catch (error) {
          if (lifetime.signal.aborted) return
          failed(error instanceof Error ? error.message : String(error))
        }
      }
      if (!lifetime.signal.aborted) timer = setTimeout(() => { void poll() }, POLL_MS)
    }
    const onVisible = (): void => { if (document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    void poll()
    return () => {
      lifetime.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [target, resourceAddress])

  const apply = useCallback(async (ops: readonly UserOp[]): Promise<boolean> => {
    if (target === undefined) return false
    try {
      const response = await fetch(ROUTE, {
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target, ops }),
      })
      if (!response.ok) {
        setSaveError(await errorOf(response))
        return false
      }
      const snapshot = await response.json() as CommentsSnapshot
      version.current = snapshot.version
      setState({ status: 'ready', snapshot })
      setSaveError(undefined)
      return true
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [target])

  return { state, saveError, apply }
}
