# dsh-canvas verification map

This directory maps what a dsh-canvas user can see and do, with a recipe for driving each feature. Read this index before you drive anything, then follow the matching feature file. `../SKILL.md` covers launch, the doctor, evidence and cleanup.

## Baseline preconditions

- `pnpm build` has run in this checkout, and `node $SKILL/scripts/doctor.mjs` printed `doctor: ready`.
- Every journey has its own evidence directory `$OUT/<run>`, where `OUT` is `$CANVAS_VERIFY_OUT` or `/tmp/dsh-canvas-verify`. Never reuse a run directory.
- Dev UI journeys need the `canvas-dev` server on port 3996, started by you in this run (omp service `canvas-dev-3996`), and a tab from `ui.open(browser, { url, run })`.
- Headless journeys need nothing running, except where they call the comment route (`comments-route.mjs`), which needs that server. Each `run-headless.mjs` call is self-contained.
- Never drive a server you did not start, or the user's desktop app.

## Driving conventions

- Start every recipe from its preconditions, never from the state another recipe left behind.
- Prefer the role and name handles in `SEL` and the table in `../SKILL.md`. Use CSS only where the plugin or DSH exposes no name: `[data-canvas-diagram]`, `[data-slot="sidebar.right.pane.tab"]`, and the comment UI's own `data-canvas-*` attributes (node boxes, pins, threads, filters), which the `ui` comment helpers wrap.
- Tell the agent exact absolute paths under `$OUT/<run>/work/`, so the file it writes is evidence too.
- Treat the prompts and expected strings as literal. The strings are Chinese because the plugin's user-facing text is Chinese.
- After a mutation (breaking a file on purpose), restore it and observe the recovery.

## Proof and skip reporting

- Capture the action and the resulting state: a screenshot after each UI step, and the verbatim text it produced (`ui.sidebar(tab)`, `canvas-check.txt`).
- Look at every PNG the model received (`check-<n>.png`) instead of trusting the agent's description of it.
- Record the session id of every session you create, and prove each one is archived (`leftovers.mjs`).
- Tag each artifact in `journey.log` with the sub-feature ID it proves.
- Report an unreachable path with the command you tried and the precondition that was missing. Never count it as verified through another path.

## Feature entry contract

Each feature file opens with an H1 title and one paragraph on what the user sees. Four H2 sections follow, in this order:

1. `Sub-features`: short IDs, one line per behavior.
2. `How to get to it (user POV)`: every entry point a user has.
3. `Driving it with <harness>`: starts with `Preconditions:`, then labeled bullets that pair each user action with an exact command and the observable result.
4. `Gotchas`: traps that waste or invalidate a run.

## Features

- [Diagram preview](./diagram-preview.md): a presented `.mmd` opens rendered in the right sidebar. Covers the renderer menu, plain text, live refresh, the parse error and its recovery, zoom, and theme.
- [canvas_check](./canvas-check.md): the agent validates a canvas file and sees the sidebar's picture. Covers the error, validate-only, image, text-only model and no-browser cases.
- [Comments](./comments.md): the user pins comments on diagram nodes in the sidebar; 看批注 makes the agent see them in `canvas_check` (listed and framed), fix the chart and reply with `canvas_comment`. Covers the owner-only route, the agent's permission limit, comment mode, the list and its filters, resolve and reopen, delete, drift warnings, and state kept across file reloads.

## Not mapped yet

Each unit that adds a feature adds its file here, together with its live check:

- **Board (unit 4).** The `.canvas` tab: embedded artifacts, drag, resize, sticky notes, edges, delete, and write-back while the agent edits the same file.
- **Mock (unit 5).** `*.mock.html` in a static sandbox, element comments, and screenshots with and without Chrome.
