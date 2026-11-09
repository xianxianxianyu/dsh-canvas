import type { ComponentType } from 'react'
import { MODES, MODE_IDS, type ModeId } from '../shared/modes.ts'
import { DiagramPreview } from './DiagramPreview.tsx'
import type { ClientContext, DocumentBodyProps, DocumentPreviewDefinition } from './dsh.ts'
import { NS, en, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'documentPreviews']

/**
 * How DSH shows each mode's files in the right sidebar; the host keeps the matching check map.
 * - `preview`: a renderer in the document preview's viewer menu (DSH keeps Plain text beside it).
 * - `text`: this plugin registers nothing and DSH's own text preview shows the file. The board is
 *   here until unit 4c registers its `*.canvas` tab type (PLAN appendix B 单元 4).
 */
type Surface =
  | { readonly kind: 'preview'; readonly loading: DocumentPreviewDefinition['loading']; readonly Body: ComponentType<DocumentBodyProps> }
  | { readonly kind: 'text' }

const SURFACES: { readonly [K in ModeId]: Surface } = {
  diagram: { kind: 'preview', loading: 'bytes-complete', Body: DiagramPreview },
  board: { kind: 'text' },
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'canvas: dictionaries')
  const t = ctx.locale.bind(NS)
  for (const id of MODE_IDS) {
    const surface = SURFACES[id]
    if (surface.kind === 'text') continue
    const key = `dsh-canvas/${id}`
    // A document renderer, not a tab type, so DSH keeps Plain text in the viewer menu.
    ctx.effect(() => ctx.documentPreviews.register({
      id: key, extensions: MODES[id].extensions, priority: 'extension', title: () => t(`mode.${id}`), loading: surface.loading, wrap: false,
    }), `canvas: ${id} preview`)
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      { name: 'sidebar.right.tab.document', key, locale: NS }, surface.Body as ComponentType<never>,
    )), `canvas: ${id} body`)
  }
}
