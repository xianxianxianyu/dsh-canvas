import type { Scheme } from '../shared/page.ts'

/** DSH publishes the active palette through its root color-scheme. */
export function readScheme(): Scheme {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light'
}

export function watchScheme(changed: () => void): () => void {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  return () => { observer.disconnect() }
}
