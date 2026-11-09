/**
 * The one list of canvas modes. The host (`HOST_MODES` in `src/host/check.ts`) and the client
 * (`PREVIEWS` in `src/client/index.tsx`) each keep a map typed `{ [K in ModeId]: … }`, so a new row
 * compiles only once both halves exist; `test/modes.test.mjs` requires its skill file and disjoint suffixes.
 */
export interface ModeMeta {
  /** Lowercase file suffixes without the leading dot. No two modes share one. */
  readonly extensions: readonly string[]
  /** The skill that teaches this format: `skills/<skill>/SKILL.md`. */
  readonly skill: `canvas-${string}`
  /** Renderer name in DSH's viewer menu and in check results. */
  readonly title: { readonly zh: string; readonly en: string }
}

export const MODES = {
  diagram: { extensions: ['mmd', 'mermaid'], skill: 'canvas-diagram', title: { zh: '图', en: 'Diagram' } },
} as const satisfies Record<string, ModeMeta>

export type ModeId = keyof typeof MODES

export const MODE_IDS = Object.keys(MODES) as readonly ModeId[]

/** Every claimed suffix with its dot, for messages: `.mmd, .mermaid`. */
export const SUFFIXES = MODE_IDS.flatMap(id => MODES[id].extensions.map(extension => `.${extension}`)).join(', ')

/**
 * The mode owning a file: the longest claimed suffix of its name, ignoring case, matched like
 * DSH's document preview so the tool and the sidebar always agree.
 * @param path - a file name or path in any platform's separators.
 * @returns the mode id, or undefined when no mode claims the file.
 */
export function modeOf(path: string): ModeId | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  let best: { id: ModeId; length: number } | undefined
  for (const id of MODE_IDS) {
    for (const extension of MODES[id].extensions) {
      if (name.endsWith(`.${extension}`) && extension.length > (best?.length ?? 0)) best = { id, length: extension.length }
    }
  }
  return best?.id
}
