---
name: verify-dsh-canvas
description: "Drive dsh-canvas through its real user surfaces: diagram and static .mock.html previews with comments, the interactive .canvas board tab, and canvas_check/canvas_comment through DSH. Keep screenshots, file diffs, tool records and session ids, then archive every session. Use after changing previews, board interactions, write feedback, recovery, comments, tools, skills or plugin wiring, and whenever a live check misbehaves."
---

# Verify dsh-canvas

dsh-canvas has four user-facing surfaces:

- **Diagram preview (web UI).** A DSH dev profile `canvas-dev` serves the web UI on `http://127.0.0.1:3996`. A user asks the agent for a diagram, the agent presents a `.mmd` file, and the user opens it from the present card into the right sidebar. There the 图 renderer draws it, and 纯文本 shows the source. In comment mode the user pins comments on its nodes and resolves them in a side list.
- **Interactive board (web UI).** A presented `.canvas` opens a React Flow board tab: pan/zoom, drag/resize, notes, connections and deletion. File changes replace its state; invalid source is read-only, and lost user batches offer explicit reapply or dismiss. Its diagram, Markdown and image boxes share the composite PNG renderer.
- **Static UI mock (web UI).** A presented `.mock.html` opens the 界面稿 document renderer, with desktop/mobile viewports, zoom, and element comments. Its script-free offline page is also the Chrome screenshot; `canvas_check` warns about layout overflow, while missing Chrome still permits static diagnostics. Follow [`features/mock.md`](features/mock.md).
- **`canvas_check` and `canvas_comment` (agent tools).** The headless profile `canvas-e2e` answers one task and exits. The agent validates a file and, when the model can see images, gets the same picture the sidebar shows, with the user's pending comments listed and framed; it replies to them with `canvas_comment`.

The feature map in [`features/`](features/README.md) has one recipe per feature. This file covers how to start, check, drive, prove and tear down.

## Ground rules

- Never drive, reload or restart the user's desktop DeepSeek Harness app or its `desktop` profile. The dev server runs the same binary (`DeepSeek Harness`), so never kill anything by process name.
- The default port is 3996, not exclusive ownership. Another local project may hold it: leave that process alone and select a free port with `PORT=`. Never stop another project's listener.
- Run `dsh` with `DSH_HOME` unset and with only `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin` added to `PATH`; the helpers do this for you. Never put `runtime/bin` on `PATH`: its `node` is an Electron wrapper that breaks `node` in the agent's own bash.
- Two canvas-dev instances cannot run side by side: they share a profile and isolated store even on different ports. Drive only a server you started yourself. A different project's listener does not block an independent canvas-dev on a free port; never take over or drive the other project's process.
- Headless runs keep their sessions, storage, attachments and canvas root inside their own run directory, and the Chrome that `canvas_check` starts gets a fresh temporary profile from playwright. The only state they share is the `canvas-e2e` profile, whose composed `cordis.yml` dsh rewrites at every boot. Running them in parallel has not been tried; run them one after another.
- The dev UI keeps its session store, storages (workspace list, archived and pinned sessions), attachments and canvas root in its own data directory, `DEV_DATA` = `$CANVAS_DEV_DATA` or `~/.cache/dsh-canvas-dev`, never in `~/.dsh`. Each DSH process loads `storages/workspace.json` once, at boot, and rewrites the whole file on every change, with no cross-process lock, so sharing `~/.dsh/storages` with the desktop app would let one side's write erase the other's archives. Its sessions therefore never appear in the user's app; the account credentials in `~/.dsh` are still read, so sign-in works. Rows in the dev UI's tree that your run did not create belong to an earlier run or another agent's run on this profile: never click them.
- Leave `fs-observation-policy` at its installed default (off on DSH 0.2.2-rc.1); the plugin does not enable it globally. Independent `edit` hunks apply atomically to current content, but stale whole-file writes can erase user changes. Test stale-version rejection only with a temporary policy-on `--patch`, never by editing the plugin patch or a profile.
- Board-loss warnings and recovery data come from a bounded in-memory journal in the host that accepted the route operation. Drive the agent and board route in that same canvas-dev process; a separate headless process cannot share the journal, even when it shares the board path or canvas root. See [`features/board.md`](features/board.md).

Paths used below:

- `REPO` is this checkout and `SKILL=$REPO/.dsh/skills/verify-dsh-canvas`.
- `OUT` is the evidence root: `$CANVAS_VERIFY_OUT`, default `/tmp/dsh-canvas-verify`. Every journey gets its own directory `$OUT/<run>`.

## Launch

Build first: `pnpm install && pnpm build`. DSH loads `lib/`, not `src/`, and `doctor.mjs` fails on a stale build.

### Dev UI: profile `canvas-dev`, default port 3996

`scripts/dev-server.sh` (in the repo, not the skill) prepares the profile and starts the server:

- **First run.** It creates `canvas-dev` from DSH's `web` template, sets the default model to `deepseek-flash` through the signed-in DeepSeek account, and links this checkout (`dsh plugin --profile canvas-dev add link:$REPO`).
- **Later runs.** It reuses the profile. If the profile already links another checkout, it does not relink; `doctor.mjs` reports that.
- **Every run.** It writes `DEV_DATA/dev.patch.yml` and boots with `--patch` on it. The patch moves the `session-persistence-jsonl` root, the `storage-json` root and `attachment-local.dshHome` into `DEV_DATA` (the rows `run-headless.mjs` moves into a run directory), the `canvas` root to `DEV_DATA/canvas`, and `workspace-controller.documentsDirectory` to `DEV_DATA/documents`, so the first-use 默认工作区 is `DEV_DATA/documents/deepseek-harness/default-workspace` instead of a folder in the user's Documents. Later runs reuse the same data: earlier sessions stay in the tree, archived.
- **Extra arguments** go to `dsh` after that patch, so a later `--patch` wins. To keep a journey's comments with its evidence, start the server with `--patch $OUT/<run>/canvas-root.patch.yml`, a file holding:

  ```yaml
  - id: canvas
    config:
      root: <absolute path of $OUT/<run>/canvas>
  ```

In omp, start it as a named service from `$REPO`:

```text
bash  command: unset DSH_HOME; sh scripts/dev-server.sh
      name:    canvas-dev-3996
      ready:   { log: "dsh web: http", port: 3996, timeout: 90 }
```

If 3996 belongs to another local project, choose an observed free port, for example
`PORT=4000 sh scripts/dev-server.sh`. Export that same `PORT` for `doctor.mjs` and
`leftovers.mjs`; both use the helper's shared port setting, defaulting to 3996.
Set the service's ready port and unique name to the chosen port too. Browser and route
helpers consume the server's actual URL, so do not rewrite it to the default port.
Changing ports never authorizes a second canvas-dev instance or stopping another project.

**Ready** means the service has printed `dsh web: http://127.0.0.1:3996/?…`. That whole URL, query included, is the one to open: the query authorizes the browser. Read it from the service output in a JS eval:

```js
const url = (await read('proc://canvas-dev-3996')).match(/dsh web: (http\S+)/)[1]
```

Never paste that URL into committed files.

The listener is the DSH Electron binary running with `--profile canvas-dev --patch DEV_DATA/dev.patch.yml … --no-open --port <PORT>`. The script `exec`s it, so the service pid is the listener.

In another harness, run the script in the background and keep its pid.

**Teardown:** `write proc://canvas-dev-3996/kill`, or `kill <the pid you kept>`.

### Headless: profile `canvas-e2e`

There is no server. Each `scripts/run-headless.mjs` call is one `dsh --profile canvas-e2e --json` process: it answers one task and exits. The first call creates `canvas-e2e` from the `headless` template and links this checkout. Every call writes its own `run.patch.yml` into its run directory with these rows:

- **Auth rows.** `credentials`, `authorization` and `deepseek-account` are set to `disabled: false`. The headless template disables account auth; without these rows the turn ends at once with `ACCOUNT_SIGN_IN_REQUIRED`.
- **Model.** `agent-default-model` uses provider `deepseek-account` with the `--model` value. The default is `deepseek-flash`, which can see images; `deepseek-v4-pro` cannot.
- **`present` tool.** An `insert` row adds `@deepseek-ai/dsh-tool-present`, which the headless template lacks.
- **Stores.** The `session-persistence-jsonl` root, the `storage-json` root, `attachment-local.dshHome` and the `canvas` root all move into `$OUT/<run>/state/`. A run therefore writes nothing under `~/.dsh` except the profile's composed `cordis.yml`, which dsh rewrites on every boot.
- **`--no-browser`.** The `canvas` row also gets `browserPath` pointing at a file that does not exist.

Optional `--patch <path>` arguments are repeatable. The runner resolves them from the invocation directory, passes them to DSH in order **after** its generated `run.patch.yml`, and records the ordered paths in `summary.json` as `extraPatches`. Use overlays scoped to the condition under test; do not override the isolated stores. For the board stale-guard journey, a temporary overlay enables only `fs-observation-policy`; the normal runner and profile defaults stay unchanged.

## Doctor

Run this first, and again whenever anything looks off:

```sh
node $SKILL/scripts/doctor.mjs [--no-live] [--patch <path>]  # --patch is repeatable
```

| Check | OK means | Fix on FAIL |
|---|---|---|
| `dsh` | the CLI exists in the app bundle and reports its version | install DeepSeek Harness.app |
| `build` | `lib/` is newer than every file in `src/` | `pnpm build` |
| `link` | `canvas-dev` and `canvas-e2e` both resolve `dsh-canvas` to this checkout (WARN: the profile is missing and will be created) | `dsh plugin --profile <p> add link:$REPO`, on purpose |
| `fs-observation-policy` | effective policy state is reported for each profile, after supplied overlays; enabled is OK and disabled is WARN, not failure | keep the default off; use a throwaway `--patch` only for the policy-on guard journey |
| `port` | selected `PORT` (default 3996) is free, or a `--profile canvas-dev` server holds it | another project's listener is not ours: leave it untouched and select a free `PORT`; drive only your own canvas-dev |
| `data` | `DEV_DATA` is where canvas-dev keeps its stores; a running canvas-dev listener carries `--patch DEV_DATA/dev.patch.yml` | the listener was started without the patch (an older `dev-server.sh`, or another `CANVAS_DEV_DATA`) and shares `~/.dsh` with the desktop app: its owner stops it and restarts it with `scripts/dev-server.sh` |
| `browser` | the Chrome or Edge that `canvas_check` will use, found by the plugin's own `src/host/browser.ts` | install Chrome; without it only `check-no-browser` and `check-text-only` can run |
| `auth` | a one-line headless turn (`只回复 OK…`) completed through the account | `ACCOUNT_SIGN_IN_REQUIRED`: sign in once in the desktop app |

The doctor ends with `doctor: ready` and exit 0, or `doctor: not ready` and exit 1. A disabled filesystem observation policy alone does not make it unready. Repeatable `--patch <path>` arguments apply in order to each profile's configuration inspection and are forwarded to the optional live auth probe. This reports the supplied configuration, not a live mutation of an already running server. The live probe is an ordinary run whose evidence lands in `$OUT/doctor-<time>/`.

## Drive

### `canvas_check` and `canvas_comment` through headless DSH

```sh
node $SKILL/scripts/run-headless.mjs --name <run> [--model deepseek-v4-pro] [--no-browser] [--cwd <dir>] [--canvas-root <dir>] [--patch <path>] "<prompt>"
```

The runner prints the run directory, the session id, the final reason, every `present` result, each `canvas_check` call and each `canvas_comment` call. For each check it shows the input, the status (`error` or `completed`), the verbatim result text, and the PNG it attached, copied out of the run's attachment store. It exits 0 only when the turn completed. `--cwd` lets a later turn work in an earlier run's `work/`, and `--canvas-root` points the plugin at a comment store the dev server shares; both must be directories inside `$OUT`. Sharing that root does not share a board journal. `--patch` supplies optional ordered overlays as described under Launch. The recipes are in [`features/canvas-check.md`](features/canvas-check.md), [`features/comments.md`](features/comments.md) and [`features/board.md`](features/board.md); board-loss checks require the same-host dev agent, not this separate process.

### The comment route without a page

```sh
node $SKILL/scripts/comments-route.mjs [--anonymous] "<dsh web url>" get <absolute .mmd path>
node $SKILL/scripts/comments-route.mjs "<dsh web url>" post '<json body>'      # {"path": "<abs>", "ops": [...]}
```

It trades the server's whole `dsh web:` URL for the signed cookie, as a browser does, and calls `/api/canvas/comments` on a running canvas-dev; `--anonymous` skips the cookie. It prints `HTTP <status>` and the JSON body, and creates no session.

### The board route without a page

```sh
node $SKILL/scripts/board-route.mjs [--anonymous] "<dsh web url>" get <absolute .canvas path>
node $SKILL/scripts/board-route.mjs [--anonymous] "<dsh web url>" post '<json body>'
node $SKILL/scripts/board-route.mjs "<dsh web url>" post -   # read {"path":"<abs>","ops":[…]} from stdin
```

Like the comment helper, it exchanges the whole server URL for the owner cookie. It calls
`GET|POST /api/canvas/board` and prints `HTTP <status>` plus the response verbatim. POST includes
each operation's `applied`, `unchanged`, `missing` or `conflict` status. A 2xx response exits 0,
any other response exits 1, and missing arguments exit 2. It creates no session.

The owner-only GET returns `{ lost: [{ id, at, ops, count }] }` for retained user-operation intent that would apply again to the current board; the helper supplies the encoded absolute `path` query. Use `--anonymous` to prove GET and POST both reject unauthenticated calls. The host retains only the last 20 active applied-operation batches per canonical board, supersedes older intent with newer successful user operations, and excludes dry-run `unchanged`, `missing` and `conflict` outcomes from loss reports. This is bounded, restart-sensitive detection, not overwrite prevention or durable undo. `canvas_check` in that host warns about losses; the board tab lists exact batches with 重新应用 and 忽略. Route replay alone is not verification of those buttons.

Decline POST uses `{ sessionId?, path, decline: [batchId, ...] }` on that same owner-only route.
It returns `{ declined: [...] }`, including already absent ids, without writing the board. After
the person clicks 忽略, GET and the next same-host `canvas_check` must not report those batches.
The banner uses localized human descriptions; exact operation JSON remains only in the agent check.

### Diagram preview through the omp browser

`scripts/dev-ui.mjs` wraps the omp browser tab with the handles below. It opens the system Chrome headless, never the user's browser, with a scratch profile `ui.chromeProfile(run)` (`/tmp/dsh-canvas-chrome-<run name>-<hash>`). The profile sits outside `$OUT`, so listing the runs never lists scratch:

```js
const SKILL = `${REPO}/.dsh/skills/verify-dsh-canvas`
const ui = await import(`${SKILL}/scripts/dev-ui.mjs`)
const run = `${OUT}/ui-preview`
const tab = await ui.open(browser, { url, run })     // dismisses 预览版说明, records the page's session in sessions.json
await ui.send(tab, `… 写 ${run}/work/order.mmd … 用 present 交付这个文件。`)
await ui.previewFile(tab, `${run}/work/order.mmd`)   // the present card's 在侧边栏预览 button
```

The full journeys are in [`features/diagram-preview.md`](features/diagram-preview.md) and [`features/comments.md`](features/comments.md). These are the handles, checked against `canvas-dev` on DSH 0.2.2-rc.1:

| What | Handle |
|---|---|
| 预览版说明 notice | heading `预览版说明`, button `继续`. It shows once per profile; pressing 继续 stores `welcomeNoticeVersion` in the profile's patch |
| Composer of a blank session | textbox `描述你想要构建的内容, / 调用指令, @ 文件或对话` |
| Composer after the first turn | textbox `发消息或创建任务, / 调用指令, @ 文件或对话` |
| Turn finished | button `已完成，用时 <n>秒` (one per finished turn) |
| Present card | button `在侧边栏预览 <real path>`: click this one. Beside it is button `<file name>` (the reply's markdown covers it, so clicks fail) or `在侧边栏打开 <path>` |
| Sidebar tab | tab `<file name> 关闭` |
| Renderer menu | CSS `[data-slot="sidebar.right.pane.tab"] button[aria-label="打开方式"]`, menu items `图` and `纯文本`. The selected item holds `svg[data-icon*="check"]` (there is no `aria-checked`) |
| Rendered diagram | `[data-canvas-diagram] iframe`. Its `srcdoc` is the full page, labels included |
| Zoom | buttons `缩小`, `原始大小` (labelled with the percentage), `放大`, `适应窗口`. Dragging inside `[data-canvas-diagram]` pans |
| Parse error | `SEL.previewError`: `[data-slot="sidebar.right.pane.tab"] [role="alert"]` outside `[data-canvas-diagram]` (the comment alerts inside it are not the parse error). The text starts with `这个文件画不出来：` |
| Comment mode | button `批注` at the top left of the drawing (`aria-pressed`); `[data-canvas-diagram]` gets `data-canvas-commenting`, and `[role="status"]` shows the hint. The C key works while the drawing has the focus |
| Comment targets | `[data-canvas-node="<id>"]`: one click box per node over the iframe, clickable only in comment mode. The draft is `[data-canvas-draft]`, titled `批注 · <label>`, with a textarea; Enter sends |
| Pins | `[data-canvas-pin="<id>"]`, labelled `<n> 条批注：<label>`; clicking one opens the list on its thread |
| Comment list | button `批注列表` (text `☰ <pending>`) opens `[data-canvas-comments]`: filters `[data-canvas-filter="open\|addressed\|resolved"]` (`aria-pressed`), threads `[data-canvas-thread="<id>"]` with `data-status`, replies `[data-canvas-reply]`, and footer buttons 解决, 重开, 删除 / 确认删除. `ui.comments(tab)` reads all of it |
| Current session row | CSS `[role="treeitem"][aria-selected="true"][data-row-key^="session:"]`. `data-row-key` is `session:<id>`, which is how `ui.currentSession` reads the id. The accessible name is the title plus a relative time (`刚刚`, `1分钟`), and hovering adds action text, so never match rows by name |
| Row menu | right-click the row: `置顶会话`, `重命名`, `分叉会话`, `复制 Session ID`, `在 Finder 中显示`, `归档会话` |
| Blank session | title `新会话`. It has no row menu; Meta+Alt+A archives it |
| Archived | toast `会话已归档，可撤销或筛选已归档会话`. The id joins `global.archivedSessionIds` in `DEV_DATA/storages/workspace.json` |
| Board tab | `[data-canvas-board]`, `data-readonly`; `ui.board` reads visible node bounds, edge paths, operation statuses, diagnostics and lost batches |
| Board gestures | `ui.dragBoardNode`, `finishBoardDrag`, `resizeBoardNode`, `addBoardNote`, `connectBoardNodes`, `deleteBoardNode`, `deleteBoardEdge`; pointer helpers take screen-pixel deltas, note placement takes board coordinates |
| Board editor/recovery | `[data-canvas-board-editor]` contains a textarea or optional edge-label input; `[data-canvas-lost="<id>"]` describes the batch in the person's language with 重新应用 / 忽略 buttons; decline removes its host journal entry |

## Evidence

Everything goes in `$OUT/<run>/`, outside the repo. `CANVAS_VERIFY_OUT` gathers a unit's runs in one place. Evidence holds local paths and session ids, so reference it only from private local notes; never commit it.

Each headless run keeps these files:

- `prompt.txt`
- `events.ndjson`: the `dsh --json` events
- `stderr.log`
- `final.txt`: the agent's last message
- `canvas-check.txt`: every `canvas_check` call, verbatim
- `canvas-comment.txt`: every `canvas_comment` call, verbatim
- `check-<n>.png`: the picture the model got
- `summary.json`: session id, model, final reason, checks and presents
- `work/`: the files the agent wrote
- `state/`: the session store, storage, attachment store and canvas root behind the session id

Each UI journey keeps these files:

- `sessions.json`: every session id the run created, recorded by `ui.open` (the blank session a page load created, which becomes the conversation once you send into it; a load that reopens an existing conversation records nothing).
- `NN-<step>.png`: written by `ui.shot` at the tab's current viewport and device scale. Capture the state after each action, not only the last screen. For responsive-layout comparisons, keep viewport and scale fixed and save measured tab, drawing and drawer dimensions with each screenshot.
- `work/`: the file the agent wrote.
- `journey.log`: you write one line per step, as `<step> | <action> | <observed value, verbatim> | <artifact>`. Include the id `ui.archive` returns.

Proof standards:

- **Real user path.** Open the file from the present card, not through an internal API. Get `canvas_check` results from a real agent turn.
- **Action and result.** Record what you did and the state it produced: the menu items and which one is selected, the `srcdoc` labels, the error text.
- **Side effects.** Check the file on disk, the PNG the model received (look at it), and the archived id in the store. A screen alone is not proof.
- **No fakes.** Stage only the recipe's explicit conditions: for example `--no-browser` points `browserPath` at a missing file, the policy-on journey uses a throwaway configuration overlay, and the stale-write negative control deliberately overwrites a test board. Exercise the real host, tools and route; never substitute mocks or count expected results as observations.
- **Unreachable paths.** When a journey cannot run, record the command you tried and the unmet precondition. Never report it as verified through another path.

## Cleanup

Do these in order after every journey, including failed attempts:

1. **Archive what the run created.** In the UI, `await ui.archive(tab, run)` archives the session on screen and returns its id once canvas-dev's store (`DEV_DATA/storages/workspace.json`) lists it as archived. A conversation goes through its row menu (归档会话); a blank `新会话` goes through Meta+Alt+A. It refuses any session missing from `<run>/sessions.json`, so it cannot archive a session another run created. Log the id in `journey.log`.
2. **Close your browser:** `await browser.close({ name: 'canvas-dev', kill: true })`.
3. **Stop the dev server you started:** `write proc://canvas-dev-3996/kill` (outside omp, `kill <the pid you kept>`).
4. **Clean up:** `node $SKILL/scripts/leftovers.mjs --clean $OUT/<run> …` stops processes whose command line names a run directory or its Chrome profile (they are ours by construction), removes that profile, and reports every UI session in `sessions.json` that is not archived. Once a headless run has exited, it also archives `summary.json`'s session id in that run's own `state/storages/workspace.json`, by atomic replacement; repeating cleanup is harmless. Pass run directories only.
5. **Prove it:** `node $SKILL/scripts/leftovers.mjs $OUT/<run> …` with the same exported `PORT` must exit 0. It shows your selected port free, nothing from the runs running, every new session archived, and the evidence files listed. Other projects' listeners are not this journey's leftovers.

Headless processes need no manual teardown: dsh exits, and the Chrome that `canvas_check` launched closes with it. Still pass every headless run directory through `leftovers.mjs --clean` to archive its session in its isolated store, then run the read-only report. Never delete `$OUT`, never remove the `canvas-dev` or `canvas-e2e` profiles or `DEV_DATA` (later runs reuse them, and journey logs point at the sessions in `DEV_DATA/sessions`), and never kill `DeepSeek Harness` or `Google Chrome` by name: those are the user's apps.

## Helpers

All helpers live in `$SKILL/scripts/` and need Node 22.18 or later: `doctor.mjs` imports the plugin's TypeScript source directly.

| Helper | Invocation | Does | Exit |
|---|---|---|---|
| `doctor.mjs` | `node $SKILL/scripts/doctor.mjs [--no-live] [--patch path]…` | readiness and effective-policy checks, with optional ordered overlays | 0 ready, 1 not |
| `run-headless.mjs` | `node $SKILL/scripts/run-headless.mjs [--model m] [--no-browser] [--name run] [--timeout s] [--cwd dir] [--canvas-root dir] [--patch path]… <prompt \| ->` | one headless turn in `$OUT/<run>`; prints the session id and every `canvas_check` and `canvas_comment` result; records optional overlays | 0 completed, 1 not, 2 usage or setup |
| `comments-route.mjs` | `node $SKILL/scripts/comments-route.mjs [--anonymous] <dsh web url> get <path> \| post <json \| ->` | one call to the comment route of a running canvas-dev | 0 for 2xx, 1 otherwise, 2 usage |
| `board-route.mjs` | `node $SKILL/scripts/board-route.mjs [--anonymous] <dsh web url> get <path> \| post <json \| ->` | one call to the board route; prints lost batches on GET or per-op statuses on POST | 0 for 2xx, 1 otherwise, 2 usage |
| `dev-ui.mjs` | `const ui = await import('$SKILL/scripts/dev-ui.mjs')` in an omp JS eval | `open`, `send`, `previewFile`, `sidebar`, `waitForSidebar`, `rendererMenu`, `chooseRenderer`, `shot`, `currentSession`, `archive`, `runSessions`, `archivedIds`, `chromeProfile`; comments: `comments`, `waitForComments`, `commentMode`, `escape`, `addComment`, `openComments`, `toggleFilter`, `threadAction`; board: `board`, `waitForBoard`, `dragBoardNode`, `finishBoardDrag`, `resizeBoardNode`, `addBoardNote`, `connectBoardNodes`, `deleteBoardNode`, `deleteBoardEdge`; selectors and `DEV_DATA` | throws with the step that timed out |
| `leftovers.mjs` | `node $SKILL/scripts/leftovers.mjs [--clean] <run-dir>…` | the cleanup report, and with `--clean` the cleanup itself | 0 clean, 1 something left |
| `capture-ui.mjs` | `node $SKILL/scripts/capture-ui.mjs <run-dir>` | exports persisted tool calls/results and canvas PNGs for that run's tracked UI sessions; reads canvas-dev's isolated stores without changing them | 0 captured, otherwise throws |
