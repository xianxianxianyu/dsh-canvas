# Static UI mock

A presented `*.mock.html` opens as 界面稿 in the right sidebar, while ordinary `.html` remains unclaimed. It is a script-free, offline HTML/CSS document. The person can switch desktop/mobile viewports, zoom and pin feedback on stable element ids. `canvas_check` gives static diagnostics without a browser; with Chrome it also checks the rendered layout and attaches the same page as a PNG when the model can see images.

## Sub-features

- `mock-static`: malformed HTML has line:column diagnostics; scripts/external resources are warned and blocked, duplicate ids and interactive elements without ids are diagnosed.
- `mock-viewport`: `<meta name="canvas-viewport" content="390x844">` selects a mobile page; absent markers use desktop 1280×800. Preview preset changes do not rewrite the file.
- `mock-image`: a 520 px-wide card in a 390 px viewport produces a horizontal-overflow warning and a PNG; fixing its width removes the warning.
- `mock-no-browser`: a missing configured browser returns only static diagnostics and the specific 未出图 reason, with no invented layout verdict or PNG.
- `mock-preview`: the present card opens 界面稿, with desktop/mobile switching and zoom; the iframe sandbox never permits scripts.
- `mock-comments`: click a stable-id button in comment mode, see its pin/outline, say 看批注, inspect the agent's outlined image/reply, and resolve the thread. Renaming/removing an anchor or changing its label is reported as drift.

## How to get to it (user POV)

- Ask the agent to design a one-screen UI with the `canvas-mock` skill, check it, look at the image and `present` its `.mock.html` file.
- Click 在侧边栏预览 on the present card. The document renderer menu offers 界面稿 and 纯文本; ordinary `.html` does not select this plugin.
- Choose 桌面 or 手机, use the zoom buttons, then 批注 and click a button or another labelled element with an id. Tell the agent 看批注; only the person can mark a thread 解决.

## Driving it with run-headless.mjs and omp browser

Preconditions:

- Follow `../SKILL.md` Launch and Doctor with `DSH_HOME` unset. Build this checkout first. Use your configured `$CANVAS_VERIFY_OUT` as `$OUT` and unique `unit5-*` run names.
- For the image/UI journey, doctor must find Chrome and a vision-capable model. For the no-browser journey explicitly use the runner's `--no-browser` option, not an uninstalled system browser.
- Start only your own isolated canvas-dev on the selected `PORT` (default 3996); if another project holds it, follow Launch's `PORT=` procedure. Never touch the desktop app or ports 3997/3998.

- **Headless image, correction and delivery (`mock-image`, `mock-viewport`).** Run:

  ```sh
  node $SKILL/scripts/run-headless.mjs --name unit5-headless "这是 canvas-mock 的实机验收，请加载 canvas-mock skill，严格按顺序执行：1) 在当前目录写 login.mock.html，一个真实文案的手机登录界面，meta canvas-viewport 为 390x844，登录按钮 id=login-submit，其他交互元素也有 id。故意让主要登录卡片 width:520px 导致横向溢出，先不要修。2) canvas_check 只传 path，不传 image，观察横向溢出警告并看附图，描述实际看到的问题。3) 用 edit 将卡片改成适配视口的宽度，保持所有 id，再 canvas_check 不传 image，确认横向溢出警告消失并看图。4) 用 present 交付 login.mock.html。不要声称静态检查证明布局正确。"
  ```

  Keep `canvas-check.txt`, `summary.json`, the file and both PNGs. Open every `check-*.png` yourself: the first image must really clip/overflow horizontally; the second must show the complete card. Verify there are two image-bearing checks, the warning disappears after the edit, and `present` names the file.

- **Missing configured browser (`mock-no-browser`, `mock-static`).** Run sequentially, after the first process exits:

  ```sh
  node $SKILL/scripts/run-headless.mjs --name unit5-no-browser --no-browser "这是静态检查验收。在当前目录写 static.mock.html：合法完整 HTML、meta canvas-viewport=390x844，含一个没有 id 的 button、一个 script 和一个 src=https://example.com/logo.png 的 img。运行一次 canvas_check，只传 path；原样报告所有警告及未出图原因，用 present 交付。不要移除这些故意放入的静态问题，不要伪造图像或布局结论。"
  ```

  Expect line:column warnings for the script, external src and missing button anchor, `未出图：配置的 browserPath 不存在：…`, and no PNG. Archive both headless sessions with `leftovers.mjs --clean`.

- **Real UI delivery (`mock-preview`).** Start canvas-dev using the skill Launch command, with a journey-scoped canvas root patch. In JS eval import `scripts/dev-ui.mjs`, call `ui.open(browser, { url, run: OUT + '/unit5-ui' })`, then `ui.send` asking the agent to write and check a mobile login at that run's `work/login.mock.html` with stable `login-submit` and present it. Open it through `ui.previewFile`, not an internal sidebar API. Save `00-present.png` and `ui.sidebar(tab)` to the run. Inspect the renderer menu: 界面稿 is selected and 纯文本 remains available.

- **Viewport and zoom (`mock-viewport`).** Read `[data-canvas-mock] iframe` dimensions and `sandbox`; save them. Click 桌面, observe 1280×800; click 手机, observe 390×844. Use 放大 and 适应窗口, saving screenshots and dimensions at each step. Read the file after switching and prove its viewport marker was not rewritten. The sandbox may include `allow-same-origin` solely for trusted-parent geometry reads, but must not include `allow-scripts`.

- **Comment/reply/resolve (`mock-comments`).** With 手机 selected, call `ui.commentMode(tab, true)`, then `ui.addComment(tab, 'login-submit', '请把按钮文案改为安全登录，并保留按钮 id')`. Save the draft result, pin and outline screenshot. Open the list using `ui.openComments`; record the created thread id. `ui.send(tab, '看批注：请 canvas_check 检查这个文件并看有红框的图，保持 id=login-submit，修改按钮文案为安全登录，再检查，用 canvas_comment 回复并标记 addressed，最后 present。')`. Wait with `ui.waitForComments` for that same thread to become addressed and have an agent reply; inspect the file and the actual attached outlined PNG. Save screenshots and tool outputs. Resolve with `ui.threadAction(tab, id, '解决')`; turn on the 已解决 filter and verify the thread is resolved and the pending outline is gone.

- **Capture the real UI tool output.** After each agent turn, run `node $SKILL/scripts/capture-ui.mjs "$OUT/unit5-ui"`. It reads only the sessions listed by this run's `sessions.json`, writes `tool-events.json`, `tool-summary.json`, `canvas-check.txt` and `canvas-comment.txt`, and copies actual attachments to `check-<n>.png`. Look at every PNG, especially the pre-edit comment outline and the changed button. Repeating capture replaces the exported evidence with the current persisted records, without mutating DSH.

- **Evidence and cleanup.** Log each sub-feature, exact result and artifact in `journey.log`. Record every created session id (`ui.open` tracks UI sessions). Archive the UI conversation with `ui.archive`, close the owned browser, stop the owned server, then run `leftovers.mjs --clean` followed by read-only `leftovers.mjs` on every unit5 run directory; require exit 0. Preserve all evidence.

## Gotchas

- `image: false` is static-only and deliberately does not prove overflow absence. A no-browser run must not claim the screen fits; static validity and layout validity are different evidence.
- The viewport switcher changes only the preview. To change the agent's PNG, edit the viewport marker in the source.
- Never enable `allow-scripts` with `allow-same-origin`. Mock HTML must not execute in DSH's origin; CSS/data images are the only active rendering resources.
- The attachment PNG lives in the real session's attachment store, not in text-only tool events. Use `capture-ui.mjs` for UI runs and look at the copied images; an agent's description is not evidence.
- A changed visible label can intentionally cause a drift warning even if its id remains stable. The user can resolve the addressed comment after checking the changed copy.
- Keep the mock to one screen. Vertical scrolling or a responsive desktop redesign is not silently substituted for the mobile check.
- Sanitization accepts only a re-parsed/re-sanitized fixed point (at most four rounds). Test mutation-XSS with a real TCP listener plus a positive control, not only HTTP requests; both preview and capture must make zero connections, contain no live iframe/refresh/handler, warn, and still attach a PNG.
- Mock trees may be at most 256 levels deep, including wrappers/templates. Excess nesting is a located refusal rather than a stack overflow. Anchors use the shared 200-unit id limit; long labels remain visible and only comment snapshots are truncated to 500 UTF-16 units.
- Authored `id`/`name` values such as `defaultView`, `body` and `elementFromPoint` remain intact. Parent inspection/picking must use unclobberable native DOM access; prove both actual element picking and the check's PNG.
- Mock controls and the element-specific comment hint occupy a row above the viewport, unlike the diagram overlay. Measure toolbar bottom against frame top and inspect a screenshot. Comment helpers locate the toolbar in the sidebar, not inside the mock's drawing pane.
- `capture-ui.mjs` replaces its own previous read-only PNG exports on reruns; it never modifies the attachment store. Repeated capture must work after additional turns.
