# Canvas · dsh-canvas

[English](README.md) · [简体中文](README.zh.md)

File-based diagrams, boards, and static UI mocks for **DeepSeek Harness (DSH)**. The agent edits ordinary workspace files; you open them beside the conversation, comment on diagrams or mocks, and edit boards directly. **Files are the API**: there is no separate drawing database or required plugin-to-plugin import.

This is an **unofficial community plugin**, not an official DeepSeek, Mermaid, Obsidian, or pstack product. A passing check validates the supported format; it does not prove that a diagram is correct or a design is usable.

## What you can open

| File | Right-sidebar surface | What it supports |
| --- | --- | --- |
| `.mmd` / `.mermaid` | **Diagram / 图** document renderer | Mermaid rendered by Pele, pan/zoom, live file refresh, and node comments. Plain text remains available. |
| `.canvas` | Interactive board tab | JSON Canvas 1.0 boards: pan/zoom, drag/resize, Markdown notes, connections with labels, and node/edge deletion. Changes save to the same file. |
| `.mock.html` | **UI mock / 界面稿** document renderer | Static HTML/CSS, desktop/mobile viewport presets, pan/zoom, and element comments. Plain text remains available. This is not a running web application. |

Suffix matching is case-insensitive. Ordinary `.html`, `.md`, and `.svg` files are not taken over by this plugin.

Boards embed local Mermaid, Markdown, and PNG/JPEG/WebP/GIF/SVG files, resolved relative to the **board's directory**. Nested boards, mocks, and unsupported embeds are filename cards with warnings; link nodes display URLs without fetching them. Missing files and invalid embedded diagrams fail `canvas_check` even when the board can still display a placeholder. **Board comment authoring is not available**; open an embedded diagram separately to comment on it.

## Requirements

- **DSH** with its `dsh` CLI available. The declared compatibility range is **`>=0.2.1-rc.5 <0.3.0`**; the verification recipes also cover desktop **0.2.2-rc.1**. This is not a compatibility claim for every release in that range.
- **Node.js 22.18 or newer**; Node 22 LTS or 24 LTS is recommended. Source tests use native TypeScript support, and CI targets **22.18.0 and 24**. DSH itself may require a newer Node version.
- **pnpm** and **Git** for source installation.
- **Optional local Chrome or Edge** for PNGs and mock layout inspection. The plugin discovers standard installations on macOS, Windows, and Linux, or accepts `browserPath`. It does not download a browser. Static validation and sidebar previews do not require a separate browser installation.
- To return images to the agent, DSH must provide an image-capable model and attachment storage. Fonts affect text geometry; install suitable CJK fonts when working with Chinese labels.

## Install from source

Clone, build, and link the local checkout. Replace `<profile>` with your DSH profile:

```sh
git clone https://github.com/xianxianxianyu/dsh-canvas.git
cd dsh-canvas
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile <profile> add link:"$(pwd)"
```

Restart DSH so it loads the host tools, skills, and client renderers. Keep the linked checkout in place. Ask the agent to create a file using one of the skills below, then open its `present` card with **在侧边栏预览** (preview in sidebar).

When updating a live linked checkout, quit the DSH process using it before installing dependencies and rebuilding, then restart after the build succeeds. DSH loads `lib/`, not `src/`; changing source without rebuilding does not update the running plugin.

## Create, check, and discuss

| Skill | Use it for |
| --- | --- |
| `/canvas-diagram` | Mermaid diagrams with stable node IDs, readable labels, and a checked final picture. |
| `/canvas-board` | Boards combining notes, diagrams, and images; small field-level edits to existing boards instead of stale whole-file rewrites. |
| `/canvas-mock` | One-screen static HTML/CSS mockups with viewport metadata and stable element anchors. |

Each skill follows the same loop: write/edit the file → run `canvas_check` with `image: false` → fix diagnostics → check again with the default image request → inspect the returned picture → deliver the file with `present`. If no picture is returned, the agent must report that limitation, not claim to have seen it.

In a diagram or mock preview, enter **批注** (comment) mode and select a node or element. Tell the agent **看批注** (review comments). Checks include pending open/addressed threads, earlier replies, and anchor-drift warnings; attached pictures outline pending anchors. The agent can reply or mark a thread addressed. **Only the user resolves, reopens, or deletes comments.** Use stable Mermaid IDs and mock `data-canvas-id` or `id` attributes; changed or missing anchors are reported rather than silently reassigned.

On a board, double-click blank space to create a note, double-click a note to edit it, drag connection handles to add an edge, and select nodes or edges to edit/delete them. Invalid board source disables editing rather than overwriting the invalid file. File changes refresh the board. Lost retained edits offer explicit **重新应用** (reapply) or **忽略** (ignore), subject to the journal limits below.

### Tools

**`canvas_check`** accepts a required `path` and optional `image` (default `true`):

```json
{ "path": "design/flow.mmd", "image": false }
```

Relative paths use the session's current working directory. The result contains diagnostics, warnings, available size/count information, pending comments, retained board-loss information, and an optional PNG attachment. `image: false` is static-only and never starts Chrome. A default mock check can perform browser layout inspection even when the model cannot receive an image; it warns about horizontal overflow and detectable clipped text. Mock screenshots show only the first viewport screen, using source viewport metadata, not a temporary sidebar preset.

A missing browser, unsupported image modality, or failed screenshot is reported as **未出图** (no image) without making an otherwise valid file invalid. Do not mistake static-only validation for a layout check. Diagram captures use a light theme; the sidebar can follow DSH's theme.

**`canvas_comment`** replies to an existing comment and/or marks it addressed:

```json
{
  "path": "design/flow.mmd",
  "id": "<comment id from canvas_check>",
  "reply": "Changed the retry path.",
  "status": "addressed"
}
```

`path` and `id` are required, with at least one of `reply` or `status`. The only agent-writable status is `addressed`; omit it when replying without claiming the requested change is complete. Replies must be nonblank and at most 4,000 UTF-16 code units. Tool diagnostics and much of the current interface are in Chinese.

## Configuration and local data

The bundled `cordis.patch.yml` creates plugin id **`canvas`**. Its configuration is:

| Setting | Meaning |
| --- | --- |
| `root` | Required absolute plugin-data directory. The bundled default is `dshHomePath('canvas')`, normally `~/.dsh/canvas/`, under the configured DSH home. This is not the workspace root. |
| `browserPath` | Optional absolute Chrome/Edge executable path. When supplied, only that path is used; an invalid path does not fall back to discovery. |

For example, in a DSH configuration overlay, replace these placeholders with your own absolute paths:

```yaml
- id: canvas
  config:
    root: /path/to/private/canvas-data
    browserPath: /path/to/chrome
```

Comments are JSONL records under `<root>/comments/`, keyed by the canonical artifact path. Records can contain the artifact's absolute path, comment text, and replies. Keep this directory private unless deliberately reviewed for sharing. Files remain in your workspace; comments are not sidecars committed next to them. Do not let independent DSH hosts write the same `root`: serialization is within one process, not a cross-process lock.

## Safety and limits

### Offline rendering

Artifact rendering has **no network access**. Diagram/board content uses sandboxed frames; mock frames allow same-origin reads for trusted-parent geometry inspection but **do not allow scripts**. CSP restricts content to inline styling and data images; the mock sanitizer removes active elements, event handlers, and external resource/navigation attributes. Screenshot contexts additionally disable JavaScript, run offline, and abort network requests. Removed mock content produces diagnostics rather than becoming a working application.

This boundary applies to the rendered artifact, not all of DSH: model calls, authenticated plugin routes, dependency installation, and verification workflows have their own network behavior. Board operations and comment routes use DSH's owner authorization. Local embedded files are read through DSH's filesystem service.

### Size and rendering budgets

| Boundary | Limit / behavior |
| --- | --- |
| PNG capture | At most **1,695,204 pixels (1302²)** and **4096 px** on either side; at most **2×** upscaling. A board that cannot fit even at 0.01× gets an explicit no-image explanation. |
| Embedded image file | **8 MiB** per file. |
| Board image page | **24 MiB of data-URI text**, including encoding overhead and repeated image nodes. Images exceeding the remaining budget become warning cards. |
| Board JSON | At most **128 nested containers**, including unknown metadata; finite numbers required. This is not a total file-byte or node-count cap. |
| Mock document | At most **256 tree levels**; viewport dimensions **1–4096 px** per side. Defaults: desktop **1280×800**, mobile **390×844**. |
| Mermaid/Pele | Input **1,000,000** and SVG output **8,000,000** JavaScript string units; configured edge limit **10,000**. These are not byte caps or a promise to fit a screenshot. |
| Text / operations | IDs up to **200** UTF-16 units; board note text **20,000**; comment/reply text **4,000**. A board write request contains at most **200 operations**, not 200 total board nodes. |
| Browser work | Browser launch and a complete render each have a separate **15-second deadline**. This is not a 15-second bound on the whole tool call. Cancellation closes the render context. |

There is no general total-byte cap for `.canvas` or `.mock.html`, nor a fixed board-node cap. These local budgets are not a resource-isolation guarantee for arbitrary files. Unsupported embeds, excessive spread, overlaps, approximate note clipping, and very small embedded diagrams produce warnings; warnings do not automatically invalidate an otherwise valid file.

### Concurrent edits and the policy-off caveat

**DSH 0.2.2-rc.1 ships with `fs-observation-policy` disabled.** Canvas does not enable it globally. A stale whole-file agent write, or an overly broad edit, can overwrite user changes. Small independent `edit` hunks operate on current text, but they are not a guarantee against overlapping edits.

Board UI writes use a file-version guard and retry stale reads for at most three rounds before reporting busy. The host's **in-memory journal detects, rather than prevents, overwrites** by checking retained intent against the current valid board. It retains at most **20 active written batches per canonical board in that host process**, and only recoverable retained operations can be offered for reapply. Missing/conflicting targets are not reported as recoverable loss. Restart, eviction, and crashes limit coverage; this is not durable undo or a promise that every loss is detected.

Reapply is a user's explicit decision, not automatic merging. Ignore removes selected journal batches without editing the board. Use version control and avoid concurrent whole-file rewrites for important work.

## Works with Pixel Town

[**pixel-town-pstack**](https://github.com/xianxianxianyu/pixel-town-pstack) is a separate, optional plugin. After an agent checks a diagram with `canvas_check`, the town's **最新图表** (latest chart) button can open that file beside its conversation. Without Canvas, DSH can still open the file as text.

The town's **`/pstack-statechart`** skill turns bounded TLA+ checks into `chart.mmd` and `report.md`. With `canvas-diagram` available, the agent can check and present the chart in this sidebar. Canvas is the viewer/checker, not the model checker; read the report, assumptions, and counterexample, not just the picture.

## Development

Run the repository gate in a checkout that is not linked to a running DSH process:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
node scripts/check-public.mjs
```

CI uses `ubuntu-latest`, Node **22.18.0 / 24**, pnpm 10, system Chrome, and `fonts-noto-cjk`. Browser tests launch a separate headless browser with temporary profiles and ephemeral loopback servers; they do not need DSH. Local tests explicitly skip browser-dependent cases when Chrome/Edge is absent; CI installs it and requires discovery to succeed. A skip is not a passed browser check.

The privacy check scans Git-listed working-tree and staged-index files, including filenames, binary metadata, and symlink targets. It reports locations without echoing sensitive values. Optionally put local-only case-insensitive literal substrings in ignored `check-public.local.txt`, one per line. This tree check **does not scan Git history**. `PLAN.md`, `.audit/`, and local evidence are intentionally not published.

### Real-app verification

- [**verify-dsh-canvas**](.dsh/skills/verify-dsh-canvas/SKILL.md): real sidebar/tool journeys, screenshots and file changes, comments, board edits/recovery, and mock layout checks. Its [feature map](.dsh/skills/verify-dsh-canvas/features/README.md) lists the recipes.
- [**verify-canvas-writes**](.dsh/skills/verify-canvas-writes/SKILL.md): model/code correspondence, concurrency assumptions, negative controls, and journal recovery.

The live helpers currently target the **macOS desktop installation** and a signed-in DSH account. They use isolated `canvas-dev` / `canvas-e2e` profiles and private evidence directories, not the user's desktop profile. Read the skill and run its doctor first; start only your own dev server, choose a free `PORT`, archive sessions you created, and stop only processes you own. These workflows are separate from portable CI and require real DSH/model capabilities. Do not run headless journeys concurrently or share comment storage between hosts; journal journeys need the tool and route in the same host.

### Formal board-write model

[`formal/board-write/`](formal/board-write/) contains the TLA+ model, configurations, code probes, charts, and sanitized recorded results. It checks bounded write interleavings in both observation-policy modes, replay, loss detection, recovery, decline, and retained-field identity. Policy-off loss of an acknowledged change is an **expected counterexample**, not a hidden passing result. The model does not cover every application behavior, restart, or journal eviction.

Use the statechart runner shipped by Pixel Town (or a compatible installed statechart skill). It uses **TLC 1.7.4 and Temurin 25 through `mise`**, or existing tools selected by `TLA2TOOLS` (jar path) and `JAVA` (executable; `java` on `PATH` otherwise). Start with the read-only doctor; if tools are missing, obtain agreement before allowing the runner to install/download them with mise.

```sh
export STATECHART="/path/to/pixel-town-pstack/skills/pstack-statechart/scripts/statechart"
node "$(dirname "$STATECHART")/doctor.mjs"
# Proceed only after prerequisites are ready; explicit TLA2TOOLS/JAVA bypass provisioning.
OUT="$(mktemp -d)"
node formal/board-write/run.mjs "$OUT"
node formal/board-write/render.mjs "$OUT" "$OUT/chart/chart.mmd"
```

The run checks exact expected holds/failures across 11 configurations and executes real-code mutation controls. Rendering additionally needs local Chrome/Edge (`CANVAS_BROWSER` can select it); inspect `$OUT/chart.png`. Add `--record` to the run command only when intentionally replacing the committed sanitized results and chart. See the verification skill for bounds and synchronization rules; stored results are evidence from a particular run, not a new verification of your changes.

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) provides the host, filesystem, tools, sessions, and UI APIs.
- [Pele](https://github.com/obsidianmd/pele) renders Mermaid; [React Flow](https://github.com/xyflow/xyflow) supplies board interaction.
- [parse5](https://github.com/inikulin/parse5), [marked](https://github.com/markedjs/marked), and [Playwright](https://github.com/microsoft/playwright) support static document parsing and browser rendering.
- [pstack](https://github.com/cursor/plugins/tree/main/pstack), by Lauren Tan, supplies engineering/verification methodology adapted into the skills.

Upstream notices, bundled dependencies, and their licenses are preserved in [Third-party notices](THIRD_PARTY_NOTICES.md). This community adaptation is not endorsed by those projects.

## License

**AGPL-3.0-or-later** — Copyright (C) 2026 xianxianxianyu. See [LICENSE](LICENSE) for GNU Affero General Public License version 3; you may use this project under that version or any later version. Upstream components retain their original notices and licenses.

If you distribute a modified version, provide its corresponding source under the AGPL, including the changes and build/install scripts required by the license. If users interact with your modified version over a network, offer those users its corresponding source at no charge as required by the AGPL.
