import type { ComponentType } from 'react'
import { MODES, MODE_IDS, type ModeId } from '../shared/modes.ts'
import { DiagramPreview } from './DiagramPreview.tsx'
import type { ClientContext, DocumentBodyProps, DocumentPreviewDefinition } from './dsh.ts'
import { NS, en, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'documentPreviews']

/** How each mode appears in the right sidebar; the host keeps the matching check map. */
const PREVIEWS: { readonly [K in ModeId]: { readonly loading: DocumentPreviewDefinition['loading']; readonly Body: ComponentType<DocumentBodyProps> } } = {
  diagram: { loading: 'bytes-complete', Body: DiagramPreview },
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'canvas: dictionaries')
  const t = ctx.locale.bind(NS)
  for (const id of MODE_IDS) {
    const key = `dsh-canvas/${id}`
    const { loading, Body } = PREVIEWS[id]
    // A document renderer, not a tab type, so DSH keeps Plain text in the viewer menu.
    ctx.effect(() => ctx.documentPreviews.register({
      id: key, extensions: MODES[id].extensions, priority: 'extension', title: () => t(`mode.${id}`), loading, wrap: false,
    }), `canvas: ${id} preview`)
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      { name: 'sidebar.right.tab.document', key, locale: NS }, Body as ComponentType<never>,
    )), `canvas: ${id} body`)
  }
}
