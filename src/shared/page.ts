/**
 * The complete HTML document for one rendered artifact. The client preview shows it in a sandboxed
 * iframe and the host screenshots it in headless Chrome, so the person and the model see one page.
 * Every page is script-free and offline: the CSP allows inline styles and data: images only.
 */
import { FILE_NODE, NOTE_TEXT, type BoardNode, type Scene, type SceneEdge } from './board.ts'
import { DIAGRAM_FONT } from './diagram.ts'
import type { MockDocument, MockViewport } from './mock.ts'

export type Scheme = 'light' | 'dark'

/** Space around the artifact, in CSS pixels. */
export const PAGE_PADDING = 16

interface Theme {
  /** pele's own color variables (https://pele.run/theming). */
  readonly pele: { readonly bg: string; readonly fg: string; readonly muted: string; readonly line: string; readonly surface: string; readonly 'surface-alt': string; readonly border: string }
  /** Group colors for `class sN <group>`. */
  readonly groups: Readonly<Record<'blue' | 'orange' | 'purple' | 'yellow' | 'teal' | 'tan' | 'pink', string>>
  /** Bug marks: `breaks` and `mayBreak` set fill and text, `bugPath` and `repeats` set the border. */
  readonly breaks: { readonly fill: string; readonly stroke: string; readonly text: string }
  readonly mayBreak: { readonly fill: string; readonly stroke: string; readonly text: string }
  readonly bugPath: string
  readonly repeats: string
  /** The dashed frame around nodes with pending comments, in the preview and the model's picture. */
  readonly comment: string
}

// The statechart palette from pstack's statechart skill, references/render.md (MIT, © 2026 Lauren Tan).
export const THEMES: { readonly [S in Scheme]: Theme } = {
  light: {
    pele: { bg: '#ffffff', fg: '#1c1c1c', muted: '#656565', line: '#808080', surface: '#fcfcfc', 'surface-alt': '#f1f1f1', border: '#c9c9c9' },
    groups: { blue: '#c3e0ff', orange: '#f0d3bf', purple: '#e3d5ff', yellow: '#f0dcbf', teal: '#bfe3df', tan: '#e5d9ce', pink: '#ffcbe6' },
    breaks: { fill: '#ffecee', stroke: '#e72e3b', text: '#cd2834' },
    mayBreak: { fill: '#fff3e6', stroke: '#e8730c', text: '#b85a06' },
    bugPath: '#1680f3',
    repeats: '#9b35d6',
    comment: '#e5484d',
  },
  dark: {
    pele: { bg: '#1f1f1f', fg: '#f5f5f5', muted: '#acacac', line: '#939393', surface: '#121212', 'surface-alt': '#2c2c2c', border: '#4e4e4e' },
    groups: { blue: '#1b3857', orange: '#573117', purple: '#3c2e57', yellow: '#573d17', teal: '#174641', tan: '#3d3127', pink: '#57233e' },
    breaks: { fill: '#2e2021', stroke: '#cf2b35', text: '#ff6463' },
    mayBreak: { fill: '#2e2619', stroke: '#d0700f', text: '#ffa257' },
    bugPath: '#116dd2',
    repeats: '#9a3fcf',
    comment: '#ec5d5e',
  },
}

/**
 * Stylesheet for one scheme. Marks come after group colors so a mark shows over a group, and use
 * `!important` because pele writes a `classDef` as a style attribute on the node.
 * @param scheme - light or dark.
 * @returns CSS text.
 */
export function themeCss(scheme: Scheme): string {
  const theme = THEMES[scheme]
  return [
    `.pele{${Object.entries(theme.pele).map(([name, value]) => `--pele-${name}:${value}`).join(';')}}`,
    ...Object.entries(theme.groups).map(([group, fill]) => `.pele .${group} rect{fill:${fill}}`),
    `.pele .breaks rect{fill:${theme.breaks.fill}!important;stroke:${theme.breaks.stroke}!important;stroke-width:2.5px!important}`,
    `.pele .breaks text{fill:${theme.breaks.text}!important}`,
    `.pele .mayBreak rect{fill:${theme.mayBreak.fill}!important;stroke:${theme.mayBreak.stroke}!important;stroke-width:2.5px!important}`,
    `.pele .mayBreak text{fill:${theme.mayBreak.text}!important}`,
    `.pele .bugPath rect{stroke:${theme.bugPath}!important;stroke-width:2.5px!important}`,
    `.pele .repeats rect{stroke:${theme.repeats}!important;stroke-width:2.5px!important;stroke-dasharray:6 3}`,
  ].join('\n')
}

export interface Page {
  readonly html: string
  /** Page size in CSS pixels, padding included. */
  readonly width: number
  readonly height: number
  /** The page background, for surroundings that should continue it. */
  readonly background: string
}

export interface PageOptions {
  /** Stable diagram or mock element ids to frame with a dashed outline. */
  readonly outline?: readonly string[]
}

/** A CSS string literal that cannot end the string or the enclosing `<style>` element. */
function cssString(value: string): string {
  return `"${value.replace(/[\\"<>\n\r\f]/gu, character => character === '\\' || character === '"' ? `\\${character}` : `\\${character.charCodeAt(0).toString(16)} `)}"`
}

/** The one document shell: the CSP, the theme, and the page's own CSS and body. */
function documentHtml(scheme: Scheme, css: string, bodyClass: string, body: string): string {
  return `<!doctype html>
<html lang="zh" style="color-scheme:${scheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>
html,body{margin:0;background:${THEMES[scheme].pele.bg}}
${css}
${themeCss(scheme)}
</style>
</head>
<body class="${bodyClass}">${body}</body>
</html>
`
}

/**
 * Wrap trusted renderer markup (pele SVG) in a self-contained page: no scripts, no network.
 * @param content - the markup and its natural size in CSS pixels.
 * @param scheme - light or dark.
 * @param options - nodes to frame; the client preview and `canvas_check` pass the same ids.
 * @returns the document and its size.
 */
export function pageHtml(content: { readonly markup: string; readonly width: number; readonly height: number }, scheme: Scheme, options: PageOptions = {}): Page {
  // CSS outline on the node's <g> follows the drawn shape's box, whatever the shape (Chrome draws it on SVG groups).
  const outline = options.outline?.length
    ? `\n.pele .pele-node:is(${options.outline.map(id => `[data-id=${cssString(id)}]`).join(',')}){outline:2.5px dashed ${THEMES[scheme].comment};outline-offset:5px}`
    : ''
  return {
    html: documentHtml(scheme, `body{padding:${PAGE_PADDING}px;width:max-content}\n.canvas-page>svg{display:block}${outline}`, 'canvas-page', content.markup),
    width: Math.ceil(content.width) + 2 * PAGE_PADDING,
    height: Math.ceil(content.height) + 2 * PAGE_PADDING,
    background: THEMES[scheme].pele.bg,
  }
}

/**
 * A mock is its authored document at a fixed CSS viewport, not a padded diagram. The trusted
 * prefix precedes even the author's <html style>: HTML5 merges its attributes onto the root.
 */
export function mockPage(mock: MockDocument, options: PageOptions & { readonly viewport?: MockViewport } = {}): Page {
  const viewport = options.viewport ?? mock.viewport
  const outline = options.outline?.length
    ? `${options.outline.flatMap(id => [`[data-canvas-id=${cssString(id)}]`, `[id=${cssString(id)}]:not([data-canvas-id]),[id=${cssString(id)}][data-canvas-id=""]`]).join(',')}{outline:2.5px dashed ${THEMES.light.comment}!important;outline-offset:3px!important}`
    : ''
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><meta http-equiv="x-dns-prefetch-control" content="off"><style>html{color-scheme:light}*,*::before,*::after{animation:none!important;transition:none!important}${outline}</style>`
  return {
    html: `<!doctype html>${head}${mock.html}`,
    width: viewport.width,
    height: viewport.height,
    background: '#ffffff',
  }
}

/** What a board node shows inside its box, prepared by whoever can read and render it. */
export type BoardContent =
  /** A diagram's pele SVG, scaled to fit the box. */
  | { readonly kind: 'svg'; readonly markup: string; readonly width: number; readonly height: number }
  /** Markdown (a text node's, or an embedded `.md` file's), already rendered by `markdownHtml`. */
  | { readonly kind: 'html'; readonly html: string }
  /** An image as a data: URI. */
  | { readonly kind: 'image'; readonly src: string }
  /** A file the page cannot show: its name and why. */
  | { readonly kind: 'card'; readonly title: string; readonly detail: string }

/** Text for HTML element content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

/** JSON Canvas preset colors `"1"`–`"6"`, as Obsidian draws them. */
const PRESETS: Readonly<Record<string, string>> = { 1: '#fb464c', 2: '#e9973f', 3: '#e0de71', 4: '#44cf6e', 5: '#53dfdd', 6: '#a882ff' }

/** A node's or edge's color: a preset, or the file's hex color (validated by `parseBoard`). */
export function boardColor(color: string | undefined): string | undefined {
  return color === undefined ? undefined : PRESETS[color] ?? color
}

/** Shared edge-label pixel metrics for the static page and the interactive painter. */
export const EDGE_LABEL = { fontSize: 12, padding: '1px 6px', borderRadius: 4 } as const

/** The scene's exact cubic curve, optionally translated into a static page's coordinates. */
export function edgePath({ from, to, c1, c2 }: Pick<SceneEdge, 'from' | 'to' | 'c1' | 'c2'>, dx = 0, dy = 0): string {
  return `M${from.x + dx} ${from.y + dy}C${c1.x + dx} ${c1.y + dy} ${c2.x + dx} ${c2.y + dy} ${to.x + dx} ${to.y + dy}`
}

function boardCss(scheme: Scheme, width: string, height: string): string {
  const { pele } = THEMES[scheme]
  const [h1, h2, h3] = NOTE_TEXT.headings
  return `body{width:${width};height:${height};position:relative;overflow:hidden;font-family:${DIAGRAM_FONT};color:${pele.fg}}
.node{position:absolute;box-sizing:border-box;border:${NOTE_TEXT.border}px solid var(--c,${pele.border});border-radius:8px;overflow:hidden;background:color-mix(in srgb,var(--c,transparent) 10%,${pele.surface})}
.group{background:color-mix(in srgb,var(--c,${pele.muted}) 7%,transparent)}
.group>.label{position:absolute;left:10px;top:6px;font-size:13px;font-weight:600;color:${pele.muted}}
.file{display:flex;flex-direction:column}
.file>.name{flex:none;height:${FILE_NODE.header}px;line-height:${FILE_NODE.header - 1}px;padding:0 8px;box-sizing:border-box;border-bottom:1px solid ${pele.border};font-size:12px;color:${pele.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file>.body{flex:1;min-height:0;padding:${FILE_NODE.padding}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center}
.fit{width:100%;height:100%}
.fit>svg{display:block;width:100%;height:100%}
.body>img{display:block;max-width:100%;max-height:100%;object-fit:contain}
.md{box-sizing:border-box;width:100%;height:100%;padding:${NOTE_TEXT.padding}px;font-size:${NOTE_TEXT.size}px;line-height:${NOTE_TEXT.lineHeight};overflow-wrap:anywhere}
.body>.md{padding:0;align-self:flex-start}
.md>*{margin:0}
.md>*+*{margin-top:.35em}
.md h1{font-size:${h1}px}
.md h2{font-size:${h2}px}
.md h3,.md h4,.md h5,.md h6{font-size:${h3}px}
.md ul,.md ol{padding-left:20px}
.md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:${pele['surface-alt']};border-radius:3px;padding:0 3px}
.md pre,.plain{white-space:pre-wrap}
.md table{border-collapse:collapse}
.md td,.md th{border:1px solid ${pele.border};padding:2px 6px}
.card{display:flex;flex-direction:column;gap:4px;padding:12px;box-sizing:border-box;font-size:13px;color:${pele.muted};overflow-wrap:anywhere}
.card>b{color:${pele.fg}}
.edges{position:absolute;left:0;top:0;overflow:visible}
.edge-label{position:absolute;transform:translate(-50%,-50%);padding:${EDGE_LABEL.padding};border-radius:${EDGE_LABEL.borderRadius}px;background:${pele.bg};color:${pele.fg};font-size:${EDGE_LABEL.fontSize}px;white-space:nowrap}`
}

function nodeHtml(node: BoardNode, content: BoardContent | undefined, geometry: string): string {
  const color = boardColor(node.color)
  const style = `${geometry}${color === undefined ? '' : `;--c:${color}`}`
  const open = `<div class="node ${node.type}" data-node-id="${escapeHtml(node.id)}" style="${style}">`
  if (node.type === 'text') return `${open}${content?.kind === 'html' ? `<div class="md">${content.html}</div>` : `<div class="md plain">${escapeHtml(node.text)}</div>`}</div>`
  if (node.type === 'link') return `${open}<div class="card"><b>链接</b><span>${escapeHtml(node.url)}</span></div></div>`
  if (node.type === 'group') return `${open}${node.label === undefined ? '' : `<div class="label">${escapeHtml(node.label)}</div>`}</div>`
  const shown = content ?? { kind: 'card', title: node.file, detail: '没有读这个文件' }
  const body = shown.kind === 'svg' ? `<div class="fit">${shown.markup}</div>`
    : shown.kind === 'html' ? `<div class="md">${shown.html}</div>`
      : shown.kind === 'image' ? `<img src="${escapeHtml(shown.src)}" alt="">`
        : `<div class="card"><b>${escapeHtml(shown.title)}</b><span>${escapeHtml(shown.detail)}</span></div>`
  return `${open}<div class="name">${escapeHtml(node.file)}</div><div class="body">${body}</div></div>`
}

/**
 * One board node in a sandboxed iframe. The document fills the iframe rather than baking in the
 * node's board position or dimensions, so moving and resizing never changes its HTML.
 * @param node - the validated board node; its dimensions are returned as page metrics only.
 * @param content - the same prepared content used by the composite board page.
 * @param scheme - light or dark.
 * @returns the responsive document with a transparent background, including for group nodes.
 */
export function boardNodePageHtml(node: BoardNode, content: BoardContent | undefined, scheme: Scheme): Page {
  return {
    html: documentHtml(
      scheme,
      `${boardCss(scheme, '100%', '100%')}\nhtml,body{width:100%;height:100%;background:transparent}`,
      'canvas-board-node',
      nodeHtml(node, content, 'left:0px;top:0px;width:100%;height:100%'),
    ),
    width: node.width,
    height: node.height,
    background: 'transparent',
  }
}

/**
 * The static picture of a board: nodes as absolutely positioned boxes at their board positions
 * (groups at the back), edges as one SVG layer with arrows, labels on top. `canvas_check`
 * screenshots it. The page only lays out: the caller renders what goes in the boxes (pele SVG for
 * diagrams, `markdownHtml` for notes, data: URIs for images).
 * @param scene - the board's geometry from `scene()`.
 * @param contents - what text and file nodes show, by node id; without an entry a text node shows
 *   its raw text and a file node its file name.
 * @param scheme - light or dark.
 * @param options - board node ids to frame (nodes with pending comments).
 * @returns the document and its size.
 */
export function boardPageHtml(scene: Scene, contents: ReadonlyMap<string, BoardContent>, scheme: Scheme, options: PageOptions = {}): Page {
  const width = Math.ceil(scene.bounds.width) + 2 * PAGE_PADDING
  const height = Math.ceil(scene.bounds.height) + 2 * PAGE_PADDING
  const dx = PAGE_PADDING - scene.bounds.x
  const dy = PAGE_PADDING - scene.bounds.y
  const theme = THEMES[scheme]
  const groups: string[] = []
  const others: string[] = []
  for (const { node, rect } of scene.nodes) {
    const html = nodeHtml(node, contents.get(node.id), `left:${rect.x + dx}px;top:${rect.y + dy}px;width:${rect.width}px;height:${rect.height}px`)
    ;(node.type === 'group' ? groups : others).push(html)
  }
  const colors = [...new Set(scene.edges.map(entry => boardColor(entry.edge.color) ?? theme.pele.line))]
  const markers = colors.map((color, index) => `<marker id="arrow-${index}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker>`)
  const paths = scene.edges.map(geometry => {
    const { edge, arrows } = geometry
    const color = boardColor(edge.color) ?? theme.pele.line
    const marker = `url(#arrow-${colors.indexOf(color)})`
    const d = edgePath(geometry, dx, dy)
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"${arrows.from ? ` marker-start="${marker}"` : ''}${arrows.to ? ` marker-end="${marker}"` : ''}/>`
  })
  const labels = scene.edges.flatMap(({ edge, mid }) => edge.label ? [`<div class="edge-label" style="left:${mid.x + dx}px;top:${mid.y + dy}px">${escapeHtml(edge.label)}</div>`] : [])
  const outline = options.outline?.length
    ? `\n.node:is(${options.outline.map(id => `[data-node-id=${cssString(id)}]`).join(',')}){outline:2.5px dashed ${theme.comment};outline-offset:5px}`
    : ''
  const body = [
    ...groups,
    `<svg class="edges" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${markers.join('')}</defs>${paths.join('')}</svg>`,
    ...others,
    ...labels,
  ].join('\n')
  return { html: documentHtml(scheme, `${boardCss(scheme, `${width}px`, `${height}px`)}${outline}`, 'canvas-board', body), width, height, background: theme.pele.bg }
}
