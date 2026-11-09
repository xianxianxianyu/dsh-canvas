# canvas_check

`canvas_check({ path, image? })` is the agent's tool for checking a canvas file. Its contract: `isError` is false exactly when the file is valid. A broken file fails with every problem's `line:column` and the source line with a caret under it. A valid file passes. On a model that can see images, and with Chrome or Edge on the machine, the result also carries a PNG of the very page the right sidebar shows. When there is no picture, the text says 未出图 and gives the reason. The user meets the feature through the `canvas-diagram` skill: the agent validates while it edits, looks once before presenting, and presents the file.

## Sub-features

- `check-error`: a file that does not parse returns `isError` with `✗ 图 <path>：<n> 个错误`, then `<line>:<col> 错误 …`, the source line, a `-----^` caret, and `改好文件后再运行 canvas_check。`.
- `check-validate`: `image: false` returns `✓ 图 <path>：校验通过（<kind>，<w>×<h> px）` and `未出图：本次只校验（image: false）`.
- `check-image`: with `image` left out, on `deepseek-flash` with a browser, the result adds `已出图：<w>×<h> PNG，按 2× 截取，与右侧栏预览同一页面。` and an image block.
- `check-text-only`: on `deepseek-v4-pro` the check passes with `未出图：当前模型 deepseek-v4-pro 不支持看图`.
- `check-no-browser`: with `browserPath` pointing at a missing file, the check still passes with `未出图：配置的 browserPath 不存在：<path>`.

## How to get to it (user POV)

- Ask the agent for a diagram. The `canvas-diagram` skill makes it run `canvas_check` with `image: false` until the file passes, run it once more without `image` to look at the picture, and then call `present`.
- Other plugins and agents call the tool by name with `{ path, image? }`, following the public contract in PLAN.md §6.

## Driving it with run-headless.mjs

Preconditions:

- `doctor.mjs` reports `doctor: ready`. `check-image` needs the `browser` check OK; the other sub-features do not.
- Nothing else is needed: each call starts and ends its own headless dsh in a new `$OUT/<run>`.

The prompts below are verbatim.

- **`check-error`, `check-validate` and `check-image`, on `deepseek-flash`.** Run:

  ```sh
  node $SKILL/scripts/run-headless.mjs --name check-image "这是一次插件验收测试，请严格按步骤做：1) 加载 canvas-diagram skill。2) 在当前目录写 pay.mmd：一个 stateDiagram-v2 支付流程（购物车、支付中、支付失败、已支付，支付失败的状态加 class breaks），但故意在第 4 行写错箭头 \`s2 -> s3\`（单横线）。3) 调用 canvas_check（image: false），应当报错并给出 行:列。4) 按报错修好，再调用 canvas_check（image: false）直到通过。5) 调用一次 canvas_check（不传 image）看图，描述你在图里看到了什么颜色。6) 用 present 交付 pay.mmd。"
  ```

  Expected result:

  - `canvas-check.txt` has three calls. #1 is `error`, with `4:6 错误 Parse error on line 4:`, the line `s2 -> s3…` and a caret under column 6. #2 is `completed`, with `校验通过（stateDiagram，258×344 px）` and `未出图：本次只校验（image: false）`. #3 is `completed`, with `已出图：580×752 PNG，按 2× 截取…` and `[image 580×752 → …/check-3.png]`.
  - The output has a `present  Presented …/work/pay.mmd` line, and the final reason is `{"kind":"completed"}`.
  - Proof: look at `check-3.png`. 支付失败 has a light pink fill, a red border and red text. `final.txt` names the same colors.

- **`check-text-only`, on `deepseek-v4-pro`.** Run:

  ```sh
  node $SKILL/scripts/run-headless.mjs --name check-text-only --model deepseek-v4-pro "这是一次插件验收测试：在当前目录写一个合法的 Mermaid 流程图 flow.mmd（flowchart LR，3 个节点：下单 → 支付 → 发货），然后调用一次 canvas_check（只传 path，不传 image），把返回原文一字不改地贴出来，然后用 present 交付 flow.mmd。不要做别的。"
  ```

  Expected result: one `completed` call with `校验通过（flowchart-v2，316×64 px）` and `未出图：当前模型 deepseek-v4-pro 不支持看图`, and no PNG in the run directory.

- **`check-no-browser`.** Run the same command as `check-text-only`, but with `--name check-no-browser --no-browser` and without `--model`.

  Expected result: one `completed` call with `未出图：配置的 browserPath 不存在：<run>/state/no-such-chrome`, and no PNG.

- **Proof for every run.** Record the session id the runner prints, and keep `canvas-check.txt`, `summary.json` and the PNGs. The session's own log is `state/sessions/*/<session id>/session.v4.jsonl.zstd`.

## Gotchas

- The model decides where its broken arrow goes. Check that `<line>:<col>` points at the arrow in `work/pay.mmd`; do not assume `4:6`. (Both recorded runs gave `4:6`.)
- The `tool_result` events in `events.ndjson` carry text only. The PNG is an image block in the session store, which the runner copies into the run directory. When a check reports `已出图` but no `check-<n>.png` appears, the attachment store moved: look at `run.patch.yml`'s `attachment-local` row.
- Without the three auth rows the turn fails at once with `ACCOUNT_SIGN_IN_REQUIRED`. When the stores are not patched, that empty session also lands in `~/.dsh/sessions`, which happened once in unit 1.
- `deepseek-v4-pro` cannot see images. Never use it to prove `check-image`.
- `canvas_check` starts its own headless Chrome through playwright, with a temporary `playwright_chromiumdev_profile-*` profile. It closes after 60 s idle or when dsh exits. Tests and other runs use the same kind of process, so never kill those by name.
- A missing browser is not a failure. The check passes and says why there is no picture.
- Empty or unknown diagram headers report 1:1; unlocated limit errors use the header line. Preserve Pele's precise source positions where available. A valid-but-unsupported screenshot size remains a passing check with a specific no-image reason, not an unlocated parser error.
- A diagram id over the shared 200 UTF-16-unit bound fails with a location. Long visible labels remain valid; commenting snapshots only the first 500 units.
