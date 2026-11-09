# Diagram preview

When the agent presents a `.mmd` (or `.mermaid`) file, the user opens it from the present card. The right sidebar then shows the diagram drawn by dsh-canvas's 图 renderer, from the same page `canvas_check` photographs. The user can switch to 纯文本 to read the source and zoom or pan the drawing. The view redraws whenever the file changes on disk; while the file does not parse, it shows the error with its line, column and a caret instead.

## Sub-features

- `preview-open`: 在侧边栏预览 on the present card opens the file in a sidebar tab, drawn by 图.
- `preview-menu`: the sidebar's 打开方式 menu lists 图 (selected) and 纯文本.
- `preview-plain`: 纯文本 shows the source; switching back to 图 redraws it.
- `preview-refresh`: a change to the file on disk redraws the sidebar without any click.
- `preview-error`: a file that does not parse shows `这个文件画不出来：` with `line:column`, the source line and a caret; fixing the file brings the drawing back.
- `preview-zoom`: 放大, 缩小, 原始大小 and 适应窗口 zoom the drawing; dragging pans it.
- `preview-theme`: the drawing follows DSH's color scheme. `canvas-dev` is dark.

## How to get to it (user POV)

- Ask the agent for a diagram. When it presents the file, choose 在侧边栏预览 on the present card.
- In the open sidebar tab, open 打开方式 (the renderer button in the tab's toolbar) to switch between 图 and 纯文本.
- Use the zoom buttons at the bottom right of the drawing, or drag the drawing to pan.

## Driving it with dev-ui.mjs (omp browser)

Preconditions:

- `doctor.mjs` reports `doctor: ready`, with 3996 free before you start the server.
- You started `canvas-dev-3996` in this run and read `url` from its `dsh web:` line.
- `run = $OUT/<run>` is new, and `ui = await import('$SKILL/scripts/dev-ui.mjs')`.
- `file = ${run}/work/order.mmd` and `PROMPT` is this text, verbatim with `${file}` filled in: `这是 dsh-canvas 插件的界面验收。请：1) 加载 canvas-diagram skill；2) 用 write 工具写 ${file}：一个 stateDiagram-v2 订单流程（待支付、支付中、支付失败、已发货），支付失败加 class breaks；3) 按 skill 的流程用 canvas_check 校验并看一次图；4) 用 present 交付这个文件。不要做别的。`

Steps:

- **Open the UI.** Run `tab = await ui.open(browser, { url, run })`. The textbox `描述你想要构建的内容, …` is showing. A `预览版说明` notice, if there was one, is dismissed, and `${run}/sessions.json` holds the id of the blank session the page load created.
- **Ask for the diagram.** Run `await ui.send(tab, PROMPT)`. A button `已完成，用时 <n>秒` appears, the present card shows a button `在侧边栏预览 <real path of file>`, and `file` exists on disk. Next to it the card shows `order.mmd` or `在侧边栏打开 <path>`, depending on how the reply is laid out.
- **preview-open.** Run `await ui.previewFile(tab, file)`, then `s = await ui.sidebar(tab)`. Tab `order.mmd 关闭` is selected, `s.srcdoc` contains `待支付` and `支付失败`, and `s.error` is `null`. Proof: `await ui.shot(tab, \`${run}/01-preview.png\`)`, which shows the rendered chart with 支付失败 outlined in red.
- **preview-menu.** Run `await ui.rendererMenu(tab)`. It returns `[{"name":"图","selected":true},{"name":"纯文本","selected":false}]`. Proof: `02-menu.png`. Then press Escape.
- **preview-plain.** Run `await ui.chooseRenderer(tab, '纯文本')`. `s.srcdoc` is `null`, and `s.text` holds the source starting at `stateDiagram-v2`. Proof: `03-plain.png`. Then run `await ui.chooseRenderer(tab, '图')` and wait until `s.srcdoc` is back.
- **preview-refresh.** Replace `已发货` with `已签收` in `file` on disk (or ask the agent to edit it). `await ui.waitForSidebar(tab, 'redraw', s => s.srcdoc?.includes('已签收'))` resolves with no click. Proof: `04-refreshed.png`.
- **preview-error.** Rewrite one `-->` arrow in `file` as `->`. `await ui.waitForSidebar(tab, 'error', s => s.error)` returns text starting `这个文件画不出来：<line>:<column> 错误 Parse error on line <line>:`, followed by the broken line and a `-----^` caret. Proof: `05-error.png`. Restore the file, then wait for `s => s.srcdoc && !s.error`.
- **preview-zoom.** Click `role/button[name="放大"]` twice. Button `原始大小` then reads `156%`. Click `role/button[name="适应窗口"]` to reset it.
- **preview-theme.** `await tab.evaluate(() => getComputedStyle(document.documentElement).colorScheme)` is `dark`, and `s.srcdoc` contains `color-scheme:dark`.
- **Archive.** `id = await ui.archive(tab, run)` returns the same id `sessions.json` recorded, once `archivedSessionIds` lists it. Write it to `journey.log`, then run the cleanup from `../SKILL.md`.

## Gotchas

- Clicking the card's `order.mmd` button fails: the message's markdown covers it (`blocked: covered by <div._markdown_…>`). Use `在侧边栏预览 <path>`.
- The 在侧边栏预览 button names the real path. On macOS `/tmp` resolves under `/private`. `ui.previewFile` resolves it for you; a hand-written selector has to do the same.
- The chat header can also show an `打开方式` button, whose menu holds 访达, Xcode and 终端. Use the sidebar-scoped `SEL.rendererMenu`.
- Every page load creates a blank persisted `新会话` in the selected workspace. Load pages only through `ui.open`, which records that session; never use `tab.goto` or a reload. Send your prompt into the blank session, or archive it with `ui.archive(tab, run)`.
- After archiving, the composer reads `选择一个工作区开始` until the page reloads, and reloading makes another blank session.
- The tree lists every unarchived session in canvas-dev's own store (`DEV_DATA`), including those of an earlier or concurrent run on this profile. Act only on `SEL.currentRow` after `ui.open`, never on a row found by name. Hovering a row adds its action buttons to its name, and 归档会话 is among them.
- `browser.open`'s `viewport` option was ignored (756×469); `ui.open` sets 1600×1000 with `emulate`. Below roughly 1000 px wide, the left tree collapses.
- The model sometimes adds `s4 --> [*]` or classes of its own. Assert the labels from the prompt, not an exact source.
