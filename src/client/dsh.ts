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

/** Public file-resource frames contain metadata, not content. */
export interface FileSnapshot {
  readonly status: 'none' | 'loading' | 'live' | 'failed'
  readonly value?: { readonly version: string; readonly absolutePath: string }
  readonly failure?: { readonly code: string; readonly message: string }
}

export type FileRead =
  | { readonly ok: true; readonly value: { readonly data: Uint8Array; readonly absolutePath: string; readonly version: string } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface BoardRuntime {
  readFile(sessionId: string, path: string, signal: AbortSignal): Promise<FileRead>
  watchFile(address: string, changed: () => void): () => void
}

/** rc.5 pane-tab slots supply useTabInfo; injection adds our read/watch face. */
export interface BoardTabProps extends BoardRuntime {
  readonly useTabInfo: () => { readonly tab: { readonly contentId: string; readonly visible: boolean; readonly signal: AbortSignal } }
  readonly t: DocumentBodyProps['t']
}

/** The public DSH rc.5 browser services consumed by this plugin. */
export interface ClientContext {
  readonly slots: {
    inject(owner: string, install: () => () => void): () => void
    register(options: { readonly name: string; readonly key: string; readonly locale?: string; readonly inject?: () => BoardRuntime }, component: ComponentType<never>): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }
  readonly documentPreviews: { register(definition: DocumentPreviewDefinition): () => void }
  readonly sidebarRightTabs: {
    register(definition: { readonly id: string; readonly kind: string; readonly patterns: readonly string[]; readonly priority: 'extension'; readonly keepMounted: boolean; readonly canOpen: (address: string) => boolean; readonly title: (address: string) => string }): () => void
  }
  readonly remote: {
    readonly workspaceFiles: {
      readBytes(sessionId: string, path: string, options: Record<string, never>, signal: AbortSignal): Promise<FileRead>
    }
  }
  readonly resources: {
    source(address: string): { getSnapshot(): FileSnapshot; subscribe(changed: () => void): () => void }
  }
  effect(install: () => (() => void) | void, label?: string): () => void
}
