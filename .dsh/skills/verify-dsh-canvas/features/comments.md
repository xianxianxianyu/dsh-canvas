# Comments

In the sidebar preview of a `.mmd` file the user turns on comment mode, clicks a node, types and presses Enter. The comment is pinned on the node with a count and a red dashed frame, and listed with status filters. In a tab narrower than 640 px, that list is a bottom drawer and the drawing keeps the full width, fitting above it; wider tabs use a side column. When the user says 看批注 in chat, the agent's `canvas_check` lists every pending comment and frames its node in the picture; the agent fixes the chart and calls `canvas_comment` to reply and mark the comment 已处理 (addressed). Within a few seconds the sidebar shows the new status with the reply under the comment. Only the user resolves, reopens or deletes. The comments live in a store under the plugin's `root`, which the sidebar reaches through the owner-only route `GET|POST /api/canvas/comments`.

## Sub-features

- `comment-route`: the route answers the signed-in page only (HTTP 401 `unauthorized` without the cookie). A `create` op adds an `open` comment, and replaying it changes nothing (same version).
- `comment-check`: after a passing check, `canvas_check` adds `待处理批注 <n> 条（图上红色虚线框标出）：`, one line per thread `<id> 未处理 · 用户 · <node id>「<label>」：<text>`, and `改完后用 canvas_comment 回复，并传 status: "addressed" 标记已处理；只有用户能标记为已解决。` The PNG has a red dashed frame around each commented node.
- `comment-reply`: `canvas_comment { path, id, reply, status: "addressed" }` returns `已回复批注 <id>，并标记为已处理；用户确认后会标记为已解决。` The store then holds the root as `addressed` and a reply by `agent` with `re: <id>`.
- `comment-invocation`: reply IDs hash the session header id, durable `tool/call` sequence, provider call id and thread id. Replaying one invocation is unchanged; reusing `call_0` in another session, turn or step creates another reply. A conflicting replay asks for a new invocation, never a different thread id. `node --test --test-name-pattern F5 test/store.test.mjs` exercises both cases against the disk-backed store.
- `comment-limits`: artifact ids are limited to 200 UTF-16 code units in the shared check and route contracts. The client snapshots at most 500 code units of the visible label; drift compares truncated forms, including relocated labels. Long labels remain renderable and commentable. Run `node --test --test-name-pattern F8 test/contracts.test.mjs test/preview.test.mjs` for the boundary and mounted-Chrome cases.
- `comment-permission`: `canvas_comment` with `status: "resolved"` (or `"open"`) is an error, `只有用户能把批注标记为已解决（resolved）或重新打开；agent 只能回复，或用 status: "addressed" 标记已处理。`, and the store's version does not change.
- `comment-mode`: the 批注 button (top left of the preview) or the C key toggles comment mode: the button turns red, the cursor is a crosshair, and the hint `批注模式（C）：点一个节点写批注，Esc 退出` shows under the button. Esc leaves.
- `comment-create`: in comment mode a click on a node opens a form titled `批注 · <label>`; Enter sends. The node gets a pin (`<n> 条批注：<label>`) and a red dashed frame, ☰ counts one more, and the focus returns to the diagram, so Esc and C keep working.
- `comment-list`: ☰ or a pin opens the list: filters `未处理 <n>`, `已处理 <n>`, `已解决 <n>` (the first two on), then one card per thread with the node label, `● <status>`, the text, `你 · <time>`, the replies indented under it, and 解决 / 重开 / 删除 as the status allows.
- `comment-drawer`: when the preview tab is narrower than 640 px, the list becomes a full-width bottom drawer of height `round(min(tab height × 0.45, 380 px))`. The drawing pane retains full width; automatic fit puts the whole drawing above the drawer, with zoom controls above it too. At 640 px or wider the list is a side column.
- `comment-addressed`: after 看批注 the thread turns `● 已处理` and the agent's reply appears under it with no reload, within one 3 s poll. The list, comment mode, an unsent draft and the zoom survive the agent's edits to the file.
- `comment-drift`: a thread whose node changed carries a warning: `⚠ <id> 的文字已从「<old>」变成「<new>」`, or `⚠ 图里已没有 <id>（批注时是「<label>」）；「<label>」现在是 <new id>`.
- `comment-resolve`: 解决 marks a thread resolved, and the default filters hide it; with 已解决 on it shows with 重开, which makes it 未处理 again.
- `comment-filter`: each filter hides or shows its threads and their pins; with nothing left the list says `没有符合筛选的批注。`
- `comment-delete`: 删除 turns into 确认删除 for 3 s; pressing it removes the user's own comment and its pin.
- `comment-text`: no visible text, `aria-label`, `title` or `placeholder` in the sidebar still holds a `{name}` placeholder.

## How to get to it (user POV)

- Open a presented `.mmd` with 在侧边栏预览 (see [diagram-preview.md](diagram-preview.md)). Click 💬 批注 at the top left of the drawing, or click the drawing and press C. Click a node, type, press Enter. Esc or the button leaves comment mode.
- Click ☰ next to 批注, or a pin, to open the list. Use the three status buttons at its top to filter, and the buttons on a card to resolve, reopen or delete.
- In the chat, say 看批注. The agent checks the chart, fixes it, and replies on each comment.
- Other tools reach the same comments through `GET|POST /api/canvas/comments` (owner only) and the agent tools `canvas_check` and `canvas_comment` (public contract in PLAN.md §6).

## Driving it with run-headless.mjs, comments-route.mjs and dev-ui.mjs

Preconditions:

- `doctor.mjs` prints `doctor: ready`, with 3996 free before you start.
- `run=$OUT/<run>` is new. Make `$run/canvas` and write `$run/canvas-root.patch.yml` with the `canvas` row from `../SKILL.md` (Launch), so the server and the headless turns share one comment store inside the evidence.
- You started `canvas-dev-3996` with `sh scripts/dev-server.sh --patch $run/canvas-root.patch.yml` and read `url` from its `dsh web:` line. Quote it in shell commands: it holds `?` and `&`.
- `ui = await import('$SKILL/scripts/dev-ui.mjs')`, and `ROUTE = node $SKILL/scripts/comments-route.mjs`.
- `CHART` is this prompt, verbatim: `这是 dsh-canvas 插件批注功能的验收。请：1) 加载 canvas-diagram skill；2) 用 write 工具在当前目录写 order.mmd：一个 stateDiagram-v2 订单流程（待支付、支付中、支付失败、已发货），支付失败加 class breaks；3) 按 skill 的流程用 canvas_check 校验并看一次图；4) 用 present 交付这个文件。不要做别的。`

Headless steps (the agent's side):

- **Chart.** `node $SKILL/scripts/run-headless.mjs --name <run>-chart --canvas-root $run/canvas "$CHART"` exits 0 with a `present` line. `file=$OUT/<run>-chart/work/order.mmd`. Read the id of 支付失败 in it (`s3` in every recorded run).
- **comment-route.** `$ROUTE --anonymous "$url" get $file` prints `HTTP 401` and `unauthorized`, exit 1. `$ROUTE "$url" get $file` prints `HTTP 200` with `"version": "empty"` and `"comments": []`. Then post one comment, twice: `$ROUTE "$url" post '{"path":"<file>","ops":[{"op":"create","id":"u-verify-1","text":"支付失败后应该能直接重试支付，不要退回待支付","anchor":{"target":"s3","label":"支付失败"}}]}'`. Both print `HTTP 200`, the same `version`, and one comment with `"status": "open"`. Save each output as `$run/route-<n>-<step>.txt`.
- **comment-check, comment-reply.** `node $SKILL/scripts/run-headless.mjs --name <run>-review --cwd $OUT/<run>-chart/work --canvas-root $run/canvas "看批注"`. The prompt is just 看批注. In `canvas-check.txt`, call #1 lists `u-verify-1 未处理 · 用户 · s3「支付失败」：…` under `待处理批注 1 条（图上红色虚线框标出）：`. Look at `check-1.png`: 支付失败 has a red dashed frame. `work/order.mmd` changed; check that it answers the comment. `canvas-comment.txt` holds one `completed` call with `"status":"addressed"` and the reply text `已回复批注 u-verify-1，并标记为已处理；用户确认后会标记为已解决。` Then `$ROUTE "$url" get $file` shows the root `"status": "addressed"` and a second entry with `"author": "agent"` and `"re": "u-verify-1"`.
- **comment-permission.** `node $SKILL/scripts/run-headless.mjs --name <run>-resolve --cwd $OUT/<run>-chart/work --canvas-root $run/canvas '这是一次权限验收测试：直接调用一次 canvas_comment，参数是 {"path":"order.mmd","id":"u-verify-1","status":"resolved"}，然后把工具返回的原文一字不改地贴出来。只调用这一次，不要调用别的工具，不要重试。'` In `canvas-comment.txt`, call #1 is `error` with the `只有用户能把批注标记为已解决（resolved）…` text. A following `get` shows the same `version` as before and the root still `addressed`.

Dev UI steps (the person's side). Run each step in its own eval and write one `journey.log` line per step with the returned values:

- **Open.** `tab = await ui.open(browser, { url, run })`. Send the diagram-preview `PROMPT` with `file = ${run}/work/order.mmd`, then `await ui.previewFile(tab, file)`. `await ui.comments(tab)` returns `pending: 0`, no pins, `list: null` and `braces: false`.
- **comment-mode.** `await ui.commentMode(tab, true)` returns `commenting: true` and the hint `批注模式（C）：点一个节点写批注，Esc 退出`. `await ui.commentMode(tab, false, { via: 'key' })`, then `await ui.commentMode(tab, true, { via: 'key' })`, toggle it through the C key. Proof: `01-mode.png`.
- **comment-create.** `const { draft, after } = await ui.addComment(tab, 's3', '支付失败后应该能直接重试，再给一个「取消订单」的出口')`. `draft.title` is `批注 · 支付失败`, and `after.pins` holds `{ node: 's3', label: '1 条批注：支付失败', count: 1 }` with `after.pending` 1. `(await ui.sidebar(tab)).srcdoc` contains `outline:2.5px dashed`. Then `(await ui.escape(tab)).commenting` is `false`. Proof: `02-pinned.png`.
- **comment-list.** `await ui.openComments(tab)`. Its `list.filters` read `未处理 1` (on), `已处理 0` (on), `已解决 0` (off). The one thread has `badge: '● 未处理'`, `by: '你 · <hh:mm>'` and `buttons: ['解决', '删除']`. Proof: `03-list.png`.
- **comment-drawer.** Keep this same small chart and thread. Set a fixed viewport, for example `await tab.emulate({ viewport: { width: 1200, height: 900 } })`, and resize the sidebar if necessary until its measured preview-tab width is **below 640 px**. Browser width alone is not the breakpoint. Close the list by clicking its toggle through the page, then press 适应窗口 to clear any manual zoom. Save `03a-narrow-closed.png` and the measurements below. Reopen with `await ui.openComments(tab)`, press 适应窗口 again, and save `03b-narrow-drawer.png` with another measurement at the **same** viewport and device scale:

  ```js
  const measureComments = () => tab.evaluate(() => {
    const pane = document.querySelector('[data-canvas-diagram]');
    const container = pane.parentElement;
    const list = container.querySelector('[data-canvas-comments]');
    const rect = element => element ? element.getBoundingClientRect().toJSON() : null;
    return {
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      tab: { width: container.clientWidth, height: container.clientHeight, rect: rect(container) },
      pane: rect(pane),
      drawing: rect(pane.querySelector('iframe')),
      list: rect(list),
      drawer: list?.hasAttribute('data-canvas-drawer') ?? false,
      zoom: pane.querySelector('button[aria-label="原始大小"]').textContent,
    };
  });
  // Close only when open; call before the closed screenshot.
  await tab.evaluate(() => {
    if (document.querySelector('[data-canvas-comments]'))
      document.querySelector('[data-canvas-diagram] button[aria-label="批注列表"]').click();
    document.querySelector('[data-canvas-diagram] button[aria-label="适应窗口"]').click();
  });
  const closed = await measureComments();
  await ui.shot(tab, `${run}/03a-narrow-closed.png`);
  await ui.openComments(tab);
  await tab.evaluate(() =>
    document.querySelector('[data-canvas-diagram] button[aria-label="适应窗口"]').click());
  const opened = await measureComments();
  await ui.shot(tab, `${run}/03b-narrow-drawer.png`);
  ```

  Save `closed` and `opened` beside the PNGs. Compare actual dimensions with at most 2 CSS px tolerance for borders/rounding: `opened.drawer` is true; the list spans the tab width, its bottom meets the tab bottom, and its height is `round(min(opened.tab.height * 0.45, 380))`. The drawing **pane** width is unchanged from `closed.pane.width` and matches the tab width; the transformed iframe bounds lie inside that width and entirely above `opened.list.top`. Inspect both PNGs for readable chart, unobscured controls and usable thread actions rather than treating a zoom percentage as proof. Repeat at a shorter tab height (to exercise the 45% branch) and a taller one (to exercise the 380 px cap), using measured tab heights, and capture the corresponding pairs. Widen the tab to at least 640 px: `drawer` becomes false and the list sits beside the drawing. Return to the narrow layout before continuing.
- **comment-addressed.** Tag the drawing with `await tab.evaluate(() => { document.querySelector('[data-canvas-diagram]').__probe = 1 })`. Run `await ui.send(tab, '看批注')`, then `await ui.waitForComments(tab, 'addressed', s => s.list?.threads.every(t => t.status === 'addressed' && t.replies.length))`. It resolves within about 3 s of the turn finishing, with the list still open. Check that the agent changed the file. `document.querySelector('[data-canvas-diagram]').__probe` is now `undefined`: DSH remounted the preview for the new bytes, and the list survived it. Proof: `04-addressed.png`.
- **comment-drift.** Keep the file's text, write it back with `s3` renamed to `s9` everywhere, and wait with `ui.waitForComments` for the thread's `drift` to read `⚠ 图里已没有 s3（批注时是「支付失败」）；「支付失败」现在是 s9`. Proof: `05-drift.png`. Write the original back and wait until `drift` is `null`. When the agent renamed a label while it handled the comment, that thread already shows the `的文字已从` form.
- **comment-resolve.** `await ui.threadAction(tab, id, '解决')`. The thread leaves the list, and the 已解决 filter reads `已解决 1`. `await ui.toggleFilter(tab, 'resolved')` shows the thread again as `● 已解决` with `['重开', '删除']`. `await ui.threadAction(tab, id, '重开')` turns it back to `open` and `pending` up by one, and `await ui.threadAction(tab, id, '解决')` resolves it again. Proof: `06-resolved.png`, `07-reopened.png`, `08-resolved-again.png`. `$ROUTE "$url" get $file` agrees.
- **comment-filter.** Toggle `addressed` and `resolved` off with `ui.toggleFilter`. `list.threads` is empty, `list.empty` is `没有符合筛选的批注。`, and `pins` is empty. Proof: `09-filter-none.png`. Toggle them back.
- **comment-delete.** In comment mode, run `ui.addComment(tab, 's4', '临时批注，马上删除')`, then `ui.escape(tab)` and `ui.threadAction(tab, id, '删除')`. The card's buttons now hold `确认删除`; pressing it with `ui.threadAction(tab, id, '确认删除')` removes the thread and its pin. Proof: `10-deleted.png`.
- **comment-text.** Every `ui.comments` result above had `braces: false`. The pin labels, the draft title and the drift warnings are the strings with parameters, so their rendered values above are the proof.
- **Archive.** `await ui.archive(tab, run)`. Then follow the cleanup in `../SKILL.md`, passing `$run` and the three headless run directories to `leftovers.mjs`.

## Gotchas

- DSH unmounts the preview while it re-reads a changed file (the tab shows `文档渲染中...` for a moment) and mounts a new one. The comment list, comment mode, the draft and the zoom are kept per file address in the page (since 0384f45). A new page load starts them fresh.
- The server and the headless turns must share one comment root (`--patch` on the server, `--canvas-root` on each run). Never run them at the same moment: two DSH processes writing one root can lose an update (PLAN appendix B).
- `comments-route.mjs` needs the whole `dsh web:` URL, query included, because the query is what signs the browser in. It trades the URL for the cookie. Never commit the URL.
- `deepseek-flash` sends `status: "resolved"` when told to, even though the schema only allows `addressed`. The tool's own check is what refuses it, so `comment-permission` tests the real guard.
- The agent decides how to answer a comment, and it sometimes renames a label or adds a state. Assert the status, the reply and that the file changed, not an exact source.
- After an omp `tab.click` in the preview, the next `tab.click` or `tab.press` often failed with `Tab "canvas-dev" is busy` even though the click had landed. The comment helpers click and type through the page itself (`tab.run`); use them rather than raw `tab.click` on comment controls.
- A page load reopens the last conversation when there is one, instead of a blank session. `ui.open` handles both cases and records only a blank session.
- The drawer breakpoint uses the preview tab's measured width, not the browser viewport. Manual zoom/pan is retained, so press 适应窗口 before asserting that the full drawing fits above an open drawer. Do not hide the list to make a cramped screenshot pass; compare its open/closed dimensions and screenshots at the same viewport.
- In an omp JS eval, end statements with `;`. A line that starts with an assignment is otherwise joined to the line before it as a call, and the step runs twice.
- Not driven live: `批注没有保存：…` (a refused save) and `读不到批注：…` (the route unreachable). Unit tests cover the route's errors.
