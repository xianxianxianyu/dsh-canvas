# Board data and write path

The agent creates a JSON Canvas `.canvas` file, changes it with `edit`, and uses `canvas_check` to validate it and see a composite PNG: positioned notes, embedded diagrams, Markdown and images, plus edges. The owner-only board route applies small operations without rewriting untouched elements. DSH 0.2.2-rc.1 defaults `fs-observation-policy` off: an independent text hunk applies atomically to current content and preserves route geometry, but a stale whole-file `write` can lose it. A bounded host-memory journal detects retained user intent lost afterward; it is not overwrite prevention. Optional policy-on stale guards are a separate, temporary-patch check. The interactive board tab and recovery UI remain unit 4c; `.canvas` currently opens in DSH's text preview.

## Sub-features

- `board-check`: malformed JSON or invalid board data produces `isError` with line, column and source excerpt; a good board passes with node and edge counts. `image: false` validates without rendering a PNG.
- `board-composite`: a normal check attaches a PNG with the board's positions, sizes, embedded diagram SVG, Markdown notes, image and labelled edge. The agent and the verifier both look at that actual PNG.
- `board-route`: unauthenticated GET and POST are HTTP 401; the owner POST accepts `{ sessionId?, path, ops }` and returns a version and one status per op, in order. Owner GET with `path` (and `sessionId` for a relative path) returns `{ lost: [{ id, at, ops, count }] }`. Absolute paths need no session id.
- `board-ops`: `place`, `addNote`, `setText` (with `ifText`), `addEdge`, `removeEdge`, `removeNodes` report `applied`, `unchanged`, `missing` or `conflict`. Moving a canonical single-line node changes only that line. Replaying the same batch changes neither the file nor its version. Removing nodes also removes incident edges.
- `board-invalid`: a route operation against an invalid source returns HTTP 409 `invalid-source` with diagnostics and leaves every byte untouched; after repair, the same operation works.
- `board-edit-default`: with policy off, read → route placement → independent stale-view `edit` leaves both the new geometry and agent text present, without an intervening re-read.
- `board-lost-write`: with policy off, read → route placement → stale whole-file `write` loses geometry. `canvas_check` in that same host warns, and owner GET exposes the lost batch for recovery.
- `board-stale-guard`: with policy on only through a throwaway patch, both stale `edit` and overwriting `write` fail with `FS_STALE_VERSION` before any re-read. Re-read and `edit` then preserve both changes.
- `board-journal`: only applied operations enter the last 20 active batches per canonical board, held in that host's memory. Newer successful user operations supersede older geometry, text and existence intent; a newer placement carries forward omitted width/height from retained placement intent before replacing it. Active operations are dry-run against current content: `applied` means lost; `unchanged`, `missing` and `conflict` do not. Restart and eviction lose recovery history.

## How to get to it (user POV)

- Ask the agent to load `canvas-board`, create a `.canvas`, check it and present it. The tool returns the composite image; the present card opens the source as plain text for now. Changes to an existing board use `edit`, never whole-file `write`.
- Call `POST /api/canvas/board` as the signed-in owner. This is the future board UI's write path, not a second way to replace the entire file.
- After an owner route edit, ask the agent for a small independent text edit from its prior view. With the default policy off it need not re-read when that hunk still matches; a version rejection is expected only in the explicit policy-on journey.
- After a deliberately destructive stale write in this test, run `canvas_check` in the host that accepted the route batch and read `GET /api/canvas/board`. These expose a warning and recovery data now; a restore button is not implemented.

## Driving it with run-headless.mjs, board-route.mjs and dev-ui.mjs

Preconditions:

- Follow `../SKILL.md`: built checkout, doctor ready, new evidence directories under `OUT`, your own canvas-dev on port 3996. `SKILL` is this skill's absolute path, and `url` is that server's whole signed URL. Never commit it. Record the doctor's effective `fs-observation-policy` report: the default-off journey expects off, which is a warning rather than a readiness failure. Do not enable it in the plugin patch or either profile.
- Set `run=$OUT/<run>` and create `$run/work`. `ROUTE` means `node $SKILL/scripts/board-route.mjs`. Open a session with `tab = await ui.open(browser, { url, run })`; drive its agent with `ui.send`. Save the dev session's persisted tool records, the session id, route responses and final sources under this run.
- Loss detection requires the route and `canvas_check` to run in the **same DSH host process**. Prefer the canvas-dev agent and its own route. A headless agent plus a separate canvas-dev route server can share file bytes, but not the in-memory journal; sharing `--canvas-root` does not fix that. A headless alternative must mount the route server in that very host and keep it alive for the whole sequence; the stock runner does not do this.
- Use this canonical fixture as `plan.canvas` (literal newlines only between elements, tab indents):

  ```json
  {
  	"nodes":[
  		{"id":"flow","type":"file","file":"order.mmd","x":0,"y":0,"width":420,"height":360},
  		{"id":"why","type":"text","text":"## Reason\nRetry payment","x":460,"y":0,"width":280,"height":140},
  		{"id":"spec","type":"file","file":"notes.md","x":460,"y":180,"width":280,"height":180},
  		{"id":"logo","type":"file","file":"mark.svg","x":780,"y":0,"width":120,"height":120}
  	],
  	"edges":[
  		{"id":"e1","fromNode":"why","fromSide":"left","toNode":"flow","toSide":"right","label":"explains"}
  	]
  }
  ```

  `order.mmd`: `flowchart TD`, then `s1[Pending] --> s2[Paying]`, `s2 --> s3[Failed]`, `s3 --> s2`, and `class s3 breaks` on separate lines. `notes.md`: `# Acceptance` followed by `Both changes survive.`. `mark.svg`: a 100×100 SVG with a blue rectangle and a white circle. Also write `bad.canvas` as `{ "nodes": [ }`.

- **board-check / board-composite.** Run `node $SKILL/scripts/run-headless.mjs --name <run>-check --cwd $run/work '<prompt>'`, asking the agent to load `canvas-board`, check `bad.canvas` once without fixing it, check `plan.canvas` with `image:false`, then check normally and describe the image. Expect an error with location for the first check, passing node/edge counts for the other two, and one attached PNG. Read `canvas-check.txt`, look at the PNG, and record the session id. Do not count only the model's description as image evidence.
- **board-route / board-ops.** Save each response verbatim. `$ROUTE --anonymous "$url" post '<body>'` gives 401. Use `$ROUTE "$url" post '<body>'` to post a batch to `plan.canvas` with `place why x:500 y:10`, `setText why ifText:"wrong" text:"must not land"`, and `place absent x:0 y:0`. Expect statuses `applied`, `conflict`, `missing`; the conflict must not undo the placement. Compare the file before/after: exactly the `why` line changed. Repost: `unchanged`, `conflict`, `missing`, same version and bytes. Test `addNote` id `temporary`, `addEdge` id `temporary-edge` from `temporary` to `why`, replay (both unchanged), `removeEdge` and replay, then re-add the edge and `removeNodes ids:["temporary"]`; neither temporary node nor edge remains. A nonexistent file gives 404, and an empty ops array gives 400.
- **board-invalid.** Post the placement to `bad.canvas`: 409 `invalid-source`, with line and column. Compare its exact bytes before and after. Repair it to `{"nodes":[],"edges":[]}`, post an `addNote`, and observe `applied` and valid JSON. Preserve the broken original and responses in evidence.
- **Owner GET.** Set `file` to the absolute fixture path. `$ROUTE "$url" get "$file"` returns `HTTP 200` and `{ "lost": [] }` before any loss. `$ROUTE --anonymous "$url" get "$file"` returns `HTTP 401` and `unauthorized`. Save both responses verbatim. Use the same owner GET command after each edit, destructive write and restoration below.

- **board-edit-default (same-host, policy off).** Create a fresh `edit-default.canvas` with one text node `why`, text `before`, x:0, y:0, width:280, height:140. Through `ui.send`, ask the dev agent to `read` that file and stop. Post `{"path":"<absolute fixture path>","ops":[{"op":"place","id":"why","x":80,"y":40}]}` to this server with `$ROUTE "$url" post '<body>'`; expect `applied`. In the same agent session, request an `edit` changing only the matching text `before` to `after`, with no prior read or check and no full-line replacement from memory. Expect success, not `FS_STALE_VERSION`. Inspect the final source: x:80, y:40 and text `after` must all be present. Run that dev agent's `canvas_check` with `image:false` and owner GET: no lost-operation warning and `lost: []`. Keep the actual read, route and edit records; the final model reply alone is not proof.
- **board-lost-write (same-host, policy off).** Use a separate fresh `lost-write.canvas` with the same one-node fixture. Have the dev agent read it and stop; keep that original source as evidence. Post the same placement through this server and confirm `applied`. Tell the same agent this is an intentional destructive negative control: without re-reading or checking, use `write` to replace the entire file with its original source, changing only text to `after`. This test-only action deliberately violates the board skill. Expect the write to succeed and the final source to contain text `after` but x:0/y:0: the route geometry really was lost. Now, without restarting the host, ask **that dev agent** to call `canvas_check` with `image:false`; retain its verbatim warning in the form `检测到用户在 HH:MM 的 1 个改动被覆盖（board-N）；用 edit 恢复或说明原因。操作：[...]`. Owner GET must return one lost batch with `id`, `at`, `ops` containing the placement of `why` to x:80/y:40, and `count: 1`. Match the warning's actual batch id and operations to that GET response; `HH:MM`, `board-N` and `[...]` are placeholders here, not fixed expected values. Compare these actual values, not merely HTTP 200 or a nonempty warning.
- **Recovery data, not a recovery UI.** For the previous fresh fixture, review the returned batch against current content, then POST its `ops` to the same board using `$ROUTE "$url" post '<body>'`. Expect `applied`, restored x:80/y:40 and preserved text `after`; same-host `canvas_check` no longer warns about that placement and GET returns `lost: []`. This manual route replay proves the data can restore retained intent; it does not claim unit 4c's restore interaction exists. Do not automatically replay arbitrary old operations.
- **board-stale-guard (temporary policy-on patch).** Finish and archive the default-off UI session first. Stop only your own canvas-dev service, then write `$run/policy-on.patch.yml` outside Git:

  ```yaml
  - id: fs-observation-policy
    disabled: false
  ```

  Run `node $SKILL/scripts/doctor.mjs --no-live --patch $run/policy-on.patch.yml` and retain its effective-policy report. Restart your own server with `sh scripts/dev-server.sh --patch $run/policy-on.patch.yml`, retaining any earlier evidence-root patch before this overlay, and use its new signed URL. Open a new tracked UI session. Create two fresh one-node fixtures, `guard-edit.canvas` and `guard-write.canvas`. Ask the dev agent to read both and stop. Post the placement to each through that same server. Then ask the agent, **before re-reading either file**, to attempt (1) the independent `before` → `after` text hunk via `edit` on the first, and (2) the original whole-file source with text `after` via `write` on the second. Both must reject with `FS_STALE_VERSION` / `file changed since it was read`; x:80/y:40 and text `before` must remain in both files. Only after preserving both error records, re-read both and change the text using `edit`; both finish at x:80/y:40, text `after`. A successful guard on just one tool does not satisfy this journey.
- **Optional headless guard probe.** `node $SKILL/scripts/run-headless.mjs --name <run>-guard --patch $run/policy-on.patch.yml '<prompt>'` supplies the same temporary guard to a headless turn. Both helpers accept repeated `--patch <path>` in order. Keep the read, external route mutation and stale tool attempt in one headless process/session; a separate run has no prior observation. This can test version guards against an external server, **not** the same-host journal. The same-host dev journey above remains the preferred end-to-end proof.
- **Cleanup.** Follow the skill: archive every UI session with `ui.archive`, close the browser, stop your server, then `leftovers.mjs --clean` and `leftovers.mjs` for all run directories. Keep headless sessions in their isolated run stores; record their ids and archive them in those stores as well. Never point headless archival at the user's or canvas-dev's store.

## Gotchas

- Never re-read or check a board between the route write and its first stale-view tool attempt. Keep the route's geometry and the agent's text change independent so a source-match failure cannot masquerade as a version guard. In the policy-on pair, preserve both failures before allowing either re-read.
- `board-route.mjs` prints the response verbatim, including per-op statuses. HTTP 200 is not proof every operation applied; inspect each status. Owner GET exposes only lost retained intent, not a complete operation history.
- Policy off is the installed default, not a readiness defect. Hunk edits use current content; whole-file writes can still lose it. Neither the route's conditional write nor the journal prevents a later unguarded whole-file replacement.
- The journal is host-local memory, bounded to 20 active applied-operation batches per canonical board. A different process, a restart or an evicted batch cannot warn about or restore that history. A valid loss check must show the actual geometry loss and the warning/GET result in the original host before teardown.
- Newer successful user geometry/text/existence intent supersedes older intent. Only still-active operations whose dry-run result is `applied` count as lost; `missing` and `conflict` are not safe automatic recovery instructions. The journal is not durable undo or a complete audit log.
- A failed source parse refuses the entire batch. A valid source with a missing/conflicting operation still applies other operations; these are different contracts.
- The route does at most three stat/read/apply/conditional-write rounds. Its races, `busy` outcome and negative control are deterministic unit checks; live stale-view evidence does not by itself prove every interleaving (unit 4b models those).
- Only canonical one-element-per-line input promises a one-line move. Unknown fields and untouched elements must survive; the touched element's internal whitespace may normalize.
- A repeated old `addNote` after an intentional deletion can recreate it (no tombstones). Absolute `place` operations intentionally replace the same geometry fields; `setText` alone carries a field-level precondition.
- Temporary `--patch` overlays do not change the committed plugin patch or profile defaults. Stop the patched server after its journey; never leave a globally enabled policy behind as a supposed fix.
- Board UI dragging/resizing, zoom/pan, edit-conflict feedback, invalid-file read-only state, a user-facing recovery action and the concurrent drag/agent journey remain unit 4c, not verified by this route-and-tool recipe.
