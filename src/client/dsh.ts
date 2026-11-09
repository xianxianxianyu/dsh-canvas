import type { ComponentType } from 'react'

/** rc.5 DocumentPreviewDefinition: one renderer choice in the document preview's viewer menu. */
export interface DocumentPreviewDefinition {
  readonly id: string
  readonly extensions: readonly string[]
  readonly priority?: 'builtin' | 'extension'
  readonly title: () => string
  readonly loading: 'text-pages' | 'bytes-complete' | 'renderer'
  readonly wrap?: boolean
}

/** The rc.5 `sidebar.right.tab.document` body props read here. */
export interface DocumentBodyProps {
  /** Complete file bytes for `bytes-complete` renderers; replaced when the file changes. */
  readonly content: { readonly kind: 'bytes'; readonly data: Uint8Array } | { readonly kind: 'text' | 'renderer' }
  /** The previewed file: `dsh-resource://file/session/<sessionId>/<path>` or `dsh-resource://file/absolute/<path>`. */
  readonly resourceAddress: string
  /** Namespace-bound translate; `{name}` in a dictionary entry takes `params.name`. */
  readonly t: (key: string, params?: Readonly<Record<string, unknown>>) => string
}

/** The public DSH rc.5 browser services consumed by this plugin. */
export interface ClientContext {
  readonly slots: {
    inject(owner: string, install: () => () => void): () => void
    register(options: { readonly name: string; readonly key: string; readonly locale: string }, component: ComponentType<never>): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }
  readonly documentPreviews: { register(definition: DocumentPreviewDefinition): () => void }
  effect(install: () => (() => void) | void, label?: string): () => void
}
