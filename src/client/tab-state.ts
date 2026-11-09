import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * `useState` for one sidebar tab, kept for the page's lifetime but never persisted (PLAN §5: view
 * state is per tab). DSH unmounts a document renderer while it re-reads a changed file and mounts
 * a new one with the new bytes, so plain component state (the comment list, comment mode, an
 * unsent draft, the zoom, the comments last fetched) would reset every time the agent edits the
 * file. Callers must sit under a component keyed by the tab's address.
 */
const states = new Map<string, unknown>()

/**
 * @param address - the tab's `resourceAddress`.
 * @param key - which piece of the tab's state.
 * @param initial - the value before the tab ever set one.
 * @returns the value and its setter, as `useState` does.
 */
export function useTabState<T>(address: string, key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const id = `${key}\n${address}`
  const [value, setValue] = useState<T>(() => states.has(id) ? states.get(id) as T : initial)
  useEffect(() => { states.set(id, value) }, [id, value])
  return [value, setValue]
}
