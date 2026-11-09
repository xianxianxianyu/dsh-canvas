/**
 * The complete HTML document for one rendered artifact. The client preview shows it in a sandboxed
 * iframe and the host screenshots it in headless Chrome, so the person and the model see one page.
 */

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
  /** Node ids (pele's `data-id`) to frame with a dashed outline: the nodes with pending comments. */
  readonly outline?: readonly string[]
}

/** A CSS string literal that cannot end the string or the enclosing `<style>` element. */
function cssString(value: string): string {
  return `"${value.replace(/[\\"<>\n\r\f]/gu, character => character === '\\' || character === '"' ? `\\${character}` : `\\${character.charCodeAt(0).toString(16)} `)}"`
}

/**
 * Wrap trusted renderer markup (pele SVG) in a self-contained page: no scripts, no network.
 * @param content - the markup and its natural size in CSS pixels.
 * @param scheme - light or dark.
 * @param options - nodes to frame; the client preview and `canvas_check` pass the same ids.
 * @returns the document and its size.
 */
export function pageHtml(content: { readonly markup: string; readonly width: number; readonly height: number }, scheme: Scheme, options: PageOptions = {}): Page {
  const background = THEMES[scheme].pele.bg
  // CSS outline on the node's <g> follows the drawn shape's box, whatever the shape (Chrome draws it on SVG groups).
  const outline = options.outline?.length
    ? `\n.pele .pele-node:is(${options.outline.map(id => `[data-id=${cssString(id)}]`).join(',')}){outline:2.5px dashed ${THEMES[scheme].comment};outline-offset:5px}`
    : ''
  const html = `<!doctype html>
<html lang="zh" style="color-scheme:${scheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>
html,body{margin:0;background:${background}}
body{padding:${PAGE_PADDING}px;width:max-content}
.canvas-page>svg{display:block}
${themeCss(scheme)}${outline}
</style>
</head>
<body class="canvas-page">${content.markup}</body>
</html>
`
  return {
    html,
    width: Math.ceil(content.width) + 2 * PAGE_PADDING,
    height: Math.ceil(content.height) + 2 * PAGE_PADDING,
    background,
  }
}
