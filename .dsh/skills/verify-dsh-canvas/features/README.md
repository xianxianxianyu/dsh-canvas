# dsh-canvas verification map

This directory maps what a dsh-canvas user can see and do, with a recipe for driving each feature. Read this index before you drive anything, then follow the matching feature file. `../SKILL.md` covers launch, the doctor, evidence and cleanup.

## Baseline preconditions

- `pnpm build` has run in this checkout, and `node $SKILL/scripts/doctor.mjs` printed `doctor: ready`. Its default-off `fs-observation-policy` warning is not failure; do not enable the policy globally. Doctor and headless runner accept repeatable `--patch <path>` for explicit temporary-overlay journeys.
- Every journey has its own evidence directory `$OUT/<run>`, where `OUT` is `$CANVAS_VERIFY_OUT` or `/tmp/dsh-canvas-verify`. Never reuse a run directory.
- Dev UI journeys need your own `canvas-dev` server on the selected `PORT` (default 3996), and a tab from `ui.open(browser, { url, run })`. If another project holds the default, choose a free port with `PORT=` and use that same setting for doctor/cleanup; never stop the other listener.
- Headless journeys need nothing running, except where they call a route (`comments-route.mjs` or `board-route.mjs`), which needs that server. Each `run-headless.mjs` call is self-contained. Board-loss checks instead need the agent and route in one host process, preferably canvas-dev: a separate headless process cannot see its in-memory board journal, even with a shared canvas root.
- Never drive a server you did not start, or the user's desktop app.

## Driving conventions

- Start every recipe from its preconditions, never from the state another recipe left behind.
- Prefer the role and name handles in `SEL` and the table in `../SKILL.md`. Use CSS only where the plugin or DSH exposes no name: `[data-canvas-diagram]`, `[data-slot="sidebar.right.pane.tab"]`, and the comment UI's own `data-canvas-*` attributes (node boxes, pins, threads, filters), which the `ui` comment helpers wrap.
- Tell the agent exact absolute paths under `$OUT/<run>/work/`, so the file it writes is evidence too.
- Treat the prompts and expected strings as literal. The strings are Chinese because the plugin's user-facing text is Chinese.
- After a mutation (breaking a file on purpose), restore it and observe the recovery.

## Proof and skip reporting

- Capture the action and the resulting state: a screenshot after each UI step, and the verbatim text it produced (`ui.sidebar(tab)`, `canvas-check.txt`). For responsive comment drawers, compare screenshots at the same viewport/device scale and retain measured tab, drawing and drawer bounds.
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
- [Comments](./comments.md): the user pins comments on diagram nodes in the sidebar; 看批注 makes the agent see them in `canvas_check` (listed and framed), fix the chart and reply with `canvas_comment`. Covers the owner-only route, the agent's permission limit, comment mode, the list and its filters, a bottom drawer below 640 px tab width with full-width drawing above it, resolve and reopen, delete, drift warnings, and state kept across file reloads.
- [Interactive board and write path](./board.md): real `.canvas` tab with sandboxed diagram/Markdown/image nodes, group frames, shared geometry, drag/resize, note creation/editing, labelled connections and deletion. Covers per-op outcomes, retry, invalid-source read-only/repair, authoritative file refresh, concurrent agent edits and explicit lost-batch reapply/dismiss. The owner route and composite PNG are checked separately. Default policy-off permits a destructive stale whole-file write; the bounded same-host journal detects retained loss, not prevention or durable undo. Temporary policy-on controls test rejection of stale edit and write.

- [Static UI mock](./mock.md): compound `.mock.html` suffix, static HTML/CSS sandbox, viewport markers and desktop/mobile switching, zoom, element comments/pins/outlines/drift, Chrome overflow warnings and shared PNG, plus missing-browser static-only checks.
