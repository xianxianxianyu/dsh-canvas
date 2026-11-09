import type { ComponentType } from 'react'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { MODES, MODE_IDS, type ModeId } from '../shared/modes.ts'
import { DiagramPreview } from './DiagramPreview.tsx'
import { BoardTab } from './BoardTab.tsx'
import { MockPreview } from './MockPreview.tsx'
import type { BoardRuntime, BoardTabProps, ClientContext, DocumentBodyProps, DocumentPreviewDefinition } from './dsh.ts'
import { NS, en, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'documentPreviews', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'resources']

/**
 * How DSH shows each mode's files in the right sidebar; the host keeps the matching check map.
 * - `preview`: a renderer in the document preview's viewer menu (DSH keeps Plain text beside it).
 * - `tab`: an interactive file type with its own resource reads and watches.
 */
type Surface =
  | { readonly kind: 'preview'; readonly loading: DocumentPreviewDefinition['loading']; readonly Body: ComponentType<DocumentBodyProps> }
  | { readonly kind: 'tab'; readonly Body: ComponentType<BoardTabProps> }

const SURFACES: { readonly [K in ModeId]: Surface } = {
  diagram: { kind: 'preview', loading: 'bytes-complete', Body: DiagramPreview },
  board: { kind: 'tab', Body: BoardTab },
  mock: { kind: 'preview', loading: 'bytes-complete', Body: MockPreview },
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'canvas: dictionaries')
  const t = ctx.locale.bind(NS)
  const runtime: BoardRuntime = {
    readFile: (sessionId, path, signal) => ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal),
    watchFile(address, changed) {
      const source = ctx.resources.source(address)
      let previous: string | undefined
      const observe = (): void => {
        const next = source.getSnapshot()
        if (next.status !== 'live' && next.status !== 'failed') return
        const key = next.status === 'live' ? `live:${next.value?.version}` : `failed:${next.failure?.code}`
        if (key === previous) return
        previous = key
        // Include the first frame: a file may have changed between the byte read and watch setup.
        queueMicrotask(changed)
      }
      const release = source.subscribe(observe)
      observe()
      return release
    },
  }
  for (const id of MODE_IDS) {
    const surface = SURFACES[id]
    const key = `dsh-canvas/${id}`
    if (surface.kind === 'tab') {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: key, kind: `canvas.${id}`, patterns: MODES[id].extensions.map(extension => `*.${extension}`), priority: 'extension', keepMounted: true,
        canOpen: address => parseFileAddress(address)?.scope === 'session',
        title: address => parseFileAddress(address)?.path.split(/[\\/]/u).pop() ?? t(`mode.${id}`),
      }), `canvas: ${id} tab`)
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key, locale: NS, inject: () => runtime }, surface.Body as ComponentType<never>,
      )), `canvas: ${id} body`)
      continue
    }
    // A document renderer, not a tab type, so DSH keeps Plain text in the viewer menu.
    ctx.effect(() => ctx.documentPreviews.register({
      id: key, extensions: MODES[id].extensions, priority: 'extension', title: () => t(`mode.${id}`), loading: surface.loading, wrap: false,
    }), `canvas: ${id} preview`)
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      { name: 'sidebar.right.tab.document', key, locale: NS }, surface.Body as ComponentType<never>,
    )), `canvas: ${id} body`)
  }
}
