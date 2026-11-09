# 画布 · dsh-canvas

[English](README.md) · [简体中文](README.zh.md)

为 **DeepSeek Harness（DSH）**提供基于文件的图表、画板与静态界面稿。智能体编辑普通工作区文件，你在对话旁打开它们，为图表或界面稿添加批注，也可以直接编辑画板。**文件就是 API**：没有另一套绘图数据库，也不要求插件之间导入内部模块。

这是一个**非官方社区插件**，不是 DeepSeek、Mermaid、Obsidian 或 pstack 的官方产品。检查通过表示文件符合支持的格式，**不证明图表正确，也不证明设计好用**。

## 可以打开什么

| 文件 | 右侧栏界面 | 支持的操作 |
| --- | --- | --- |
| `.mmd` / `.mermaid` | **图 / Diagram** 文档渲染器 | 由 Pele 渲染 Mermaid，支持平移、缩放、文件变化后刷新，以及节点批注；仍可切换纯文本。 |
| `.canvas` | 交互式画板标签页 | JSON Canvas 1.0：平移、缩放、拖动、调整尺寸、Markdown 便签、带标签连线，以及删除节点或边；修改保存到同一个文件。 |
| `.mock.html` | **界面稿 / UI mock** 文档渲染器 | 静态 HTML/CSS，桌面/手机视口、平移、缩放和元素批注；仍可切换纯文本。它不是可运行的网页应用。 |

扩展名不区分大小写。插件不接管普通 `.html`、`.md` 或 `.svg` 文件。

画板可嵌入本地 Mermaid、Markdown 及 PNG/JPEG/WebP/GIF/SVG，路径相对**画板所在目录**解析。嵌套画板、界面稿及不支持的嵌入文件显示为带警告的文件名卡片；链接节点只显示 URL，不抓取网页。文件缺失或嵌入图表解析失败会使 `canvas_check` 失败，即使画板仍能显示占位卡片。**目前不能在画板上创建批注**；需要讨论嵌入图表时，请单独打开该图表添加批注。

## 环境要求

- 已安装 **DSH**，且命令行可以使用 `dsh`。声明的兼容范围是 **`>=0.2.1-rc.5 <0.3.0`**，验证流程也覆盖桌面版 **0.2.2-rc.1**；不表示已逐一验证范围内的所有版本。
- **Node.js 22.18 或更新版本**，推荐 Node 22 LTS 或 24 LTS。源码测试使用原生 TypeScript 支持，CI 对应 **22.18.0 和 24**。DSH 自身可能要求更高版本。
- 从源码安装需要 **pnpm** 和 **Git**。
- **可选的本地 Chrome 或 Edge**：用于生成 PNG 和检查界面稿布局。插件会查找 macOS、Windows、Linux 的常见安装位置，也可通过 `browserPath` 指定；插件不会下载浏览器。静态校验及侧栏预览不需要另外安装浏览器。
- 要把图片返回给智能体，DSH 还需提供能看图的模型及附件存储。字体影响文字几何尺寸；使用中文标签时请安装合适的 CJK 字体。

## 从源码安装

克隆、构建，再链接本地目录。将 `<profile>` 替换成你使用的 DSH profile：

```sh
git clone https://github.com/xianxianxianyu/dsh-canvas.git
cd dsh-canvas
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile <profile> add link:"$(pwd)"
```

重启 DSH，加载宿主工具、技能和客户端渲染器。请保留被链接的源码目录。让智能体使用下面的技能创建文件，再点击 `present` 卡片上的**在侧边栏预览**。

更新实时链接的 checkout 前，先退出正在使用它的 DSH 进程，再安装依赖、重新构建，成功后重启。DSH 加载的是 `lib/`，不是 `src/`；只改源码而不构建，不会更新运行中的插件。

## 创建、检查与讨论

| 技能 | 用途 |
| --- | --- |
| `/canvas-diagram` | 编写 Mermaid 图，保持节点 ID 稳定、标签可读，并检查最终图片。 |
| `/canvas-board` | 用便签、图表与图片组织画板；修改已有画板时只编辑目标字段，避免拿旧快照覆盖整个文件。 |
| `/canvas-mock` | 编写单屏静态 HTML/CSS 界面稿，设置视口信息与稳定的元素锚点。 |

三个技能遵循同一流程：写入/编辑文件 → 用 `image: false` 调用 `canvas_check` → 修复诊断 → 用默认图片请求再检查 → 查看返回图片 → 用 `present` 交付。没有返回图片时，智能体必须说明限制，不能声称看过。

在图表或界面稿预览中进入**批注**模式，选择节点或元素，再让智能体**看批注**。检查结果列出未解决的 open/addressed 批注、已有回复和锚点变化警告；附图会框出待处理锚点。智能体可以回复或标为已处理，**只有用户能解决、重开或删除批注**。请保持 Mermaid ID，以及界面稿的 `data-canvas-id` 或 `id` 稳定；锚点变化或消失会被报告，不会悄悄转移批注。

在画板空白处双击可创建便签，双击便签编辑内容，拖动连接点可连线，选中节点或边可编辑/删除。源文件无效时画板禁用编辑，不会覆盖坏文件。文件变化后会刷新画板；保留的修改被覆盖时，会提供**重新应用**或**忽略**，但受下述日志边界限制。

### 工具

**`canvas_check`** 接受必填 `path` 和可选 `image`（默认 `true`）：

```json
{ "path": "design/flow.mmd", "image": false }
```

相对路径按会话当前工作目录解析。结果包含诊断、警告、可用的尺寸/数量信息、待处理批注、保留的画板丢失信息，以及可选 PNG 附件。`image: false` 只做静态检查，绝不启动 Chrome。默认的界面稿检查即使面对不能接收图片的模型，也可以用浏览器检查布局，报告横向溢出与可检测的文字裁切。界面稿截图只覆盖首屏，使用源文件的视口信息，不采用侧栏临时切换的预设。

缺少浏览器、模型不支持图片或截图失败，会明确报告**未出图**，而不会让原本有效的文件变成无效。不要把静态校验当成布局检查。图表截图使用浅色主题；侧栏可跟随 DSH 主题。

**`canvas_comment`** 回复已有批注，并且/或者将其标为已处理：

```json
{
  "path": "design/flow.mmd",
  "id": "<canvas_check 返回的批注 id>",
  "reply": "已修改重试路径。",
  "status": "addressed"
}
```

`path`、`id` 必填，`reply` 与 `status` 至少提供一个。智能体唯一能设置的状态是 `addressed`；只解释原因、未完成请求时不要传这个状态。回复必须非空，最多 4,000 个 UTF-16 代码单元。当前工具诊断和大部分界面使用中文。

## 配置与本地数据

内置 `cordis.patch.yml` 创建 id 为 **`canvas`** 的插件，配置如下：

| 配置 | 含义 |
| --- | --- |
| `root` | 必填的插件数据绝对路径。默认是 `dshHomePath('canvas')`，通常为 `~/.dsh/canvas/`，随 DSH home 配置变化；不是工作区根目录。 |
| `browserPath` | 可选的 Chrome/Edge 可执行文件绝对路径。指定后只使用这个路径；无效时不会回退到自动发现。 |

例如在 DSH 配置覆盖文件中，将占位符替换为你自己的绝对路径：

```yaml
- id: canvas
  config:
    root: /path/to/private/canvas-data
    browserPath: /path/to/chrome
```

批注以 JSONL 保存在 `<root>/comments/`，按规范化后的文件路径索引。记录可能包含文件绝对路径、批注文字与回复，分享前请自行审查。图表/画板/界面稿留在工作区；批注不是随文件提交的 sidecar。不要让独立 DSH 宿主同时写同一个 `root`：写入串行化仅限单进程，不是跨进程锁。

## 安全与限制

### 离线渲染

文件内容的渲染**不能访问网络**。图表/画板使用沙箱 frame；界面稿 frame 允许同源读取，以便可信父页面检查几何尺寸，但**不允许脚本**。CSP 只允许内联样式和 data 图片等限定内容；界面稿清理器会移除主动元素、事件处理器，以及外部资源/导航属性。截图上下文进一步禁用 JavaScript、启用离线模式并阻断网络请求。被移除的界面稿内容会产生诊断，不会变成能运行的应用。

这个边界针对被渲染的文件，不针对整个 DSH：模型请求、经认证的插件路由、依赖安装和验证工作流各自有网络行为。画板操作和批注路由使用 DSH 的 owner 授权；本地嵌入文件通过 DSH 文件系统服务读取。

### 尺寸与渲染预算

| 边界 | 限制与行为 |
| --- | --- |
| PNG 截图 | 总计不超过 **1,695,204 像素（1302²）**，任一边不超过 **4096 px**，最多放大 **2 倍**。缩到 0.01 倍仍无法满足预算的画板，会明确说明未出图原因。 |
| 单个嵌入图片文件 | **8 MiB**。 |
| 画板图片页面 | **24 MiB 的 data-URI 文本**，包括编码开销和重复图片节点；超出剩余预算的图片显示为警告卡片。 |
| 画板 JSON | 最多 **128 层嵌套容器**，包括未知元数据；数值必须有限。这不是文件总字节数或节点总数上限。 |
| 界面稿 | 最多 **256 层树深度**；视口每边 **1–4096 px**。默认桌面 **1280×800**，手机 **390×844**。 |
| Mermaid/Pele | 输入 **1,000,000**、SVG 输出 **8,000,000** 个 JavaScript 字符串单元，配置的边数上限 **10,000**。不是字节上限，也不保证能完整截图。 |
| 文本/操作 | ID 最多 **200** 个 UTF-16 单元，便签文字 **20,000**，批注/回复 **4,000**。单次画板写请求最多 **200 个操作**，不是整张画板只能有 200 个节点。 |
| 浏览器工作 | 启动浏览器与一次完整渲染分别有独立的 **15 秒截止时间**；不表示整个工具调用最多 15 秒。取消会关闭渲染上下文。 |

`.canvas` 与 `.mock.html` 没有统一的文件总字节上限，画板也没有固定节点总数上限。这些局部预算不是针对任意文件的资源隔离保证。不支持的嵌入、过大的分布范围、重叠、估算的便签裁切，以及缩得过小的嵌入图表会产生警告；警告本身不会把有效文件变成无效。

### 并发编辑与默认关闭的策略

**DSH 0.2.2-rc.1 默认禁用 `fs-observation-policy`。** Canvas 不会全局启用它。智能体拿旧快照重写整个文件，或者编辑范围过大，都可能覆盖用户修改。独立的小 `edit` hunk 在当前文本上执行，但不保证重叠修改安全。

画板 UI 写入使用文件版本条件，读到过期版本时最多尝试三轮，再报告 busy。宿主的**内存日志检测覆盖，而不是阻止覆盖**：它把保留的修改意图与当前有效画板比较。每个宿主进程、每个规范化画板路径最多保留 **20 个活跃的已写入批次**，只对仍能恢复的保留操作提供重新应用。目标已删除或操作冲突时，不会报告为可恢复丢失。重启、淘汰和崩溃都会限制覆盖范围；这不是持久撤销，也不承诺检测所有丢失。

重新应用是用户的明确选择，不是自动合并。忽略只移除选中的日志批次，不修改画板。重要工作请使用版本控制，避免并发重写整个文件。

## 与像素小镇配合

[**pixel-town-pstack**](https://github.com/xianxianxianyu/pixel-town-pstack) 是独立、可选的插件。智能体用 `canvas_check` 检查图表后，小镇的**最新图表**按钮可以在对应对话旁打开该文件；没有 Canvas 时，DSH 仍可把它作为文本打开。

小镇的 **`/pstack-statechart`** 技能把有界 TLA+ 检查转为 `chart.mmd` 和 `report.md`。安装 `canvas-diagram` 后，智能体可以检查图表并在侧栏交付。Canvas 是查看器/文件检查器，不是模型检查器；请阅读报告、假设和反例，不要只看图片。

## 开发

在没有链接到运行中 DSH 的 checkout 中执行完整关卡：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
node scripts/check-public.mjs
```

CI 使用 `ubuntu-latest`、Node **22.18.0 / 24**、pnpm 10、系统 Chrome 以及 `fonts-noto-cjk`。浏览器测试使用独立的无头浏览器、临时 profile 和随机回环端口，不需要 DSH。本地缺少 Chrome/Edge 时，相关测试会明确说明跳过原因；CI 会安装浏览器并强制检查发现成功。跳过不等于浏览器检查通过。

隐私检查扫描 Git 列出的工作区和暂存区文件，包括文件名、二进制元数据与符号链接目标；只报告位置，不回显敏感值。可在被忽略的 `check-public.local.txt` 中填入仅供本地检查的字面子串，每行一项、不区分大小写。这个工作树检查**不扫描 Git 历史**。`PLAN.md`、`.audit/` 和本地证据有意不公开。

### 真实应用验证

- [**verify-dsh-canvas**](.dsh/skills/verify-dsh-canvas/SKILL.md)：真实侧栏/工具流程、截图与文件修改、批注、画板编辑/恢复，以及界面稿布局检查。[功能地图](.dsh/skills/verify-dsh-canvas/features/README.md)列出各项配方。
- [**verify-canvas-writes**](.dsh/skills/verify-canvas-writes/SKILL.md)：模型与代码映射、并发假设、负向对照及日志恢复。

实机辅助工具目前针对 **macOS 桌面安装**，需要已登录的 DSH 账户。它们使用隔离的 `canvas-dev` / `canvas-e2e` profile 和私有证据目录，不使用用户的 desktop profile。先读技能并运行 doctor；只启动自己的开发服务器、选择空闲 `PORT`、归档自己创建的会话，并只停止自己拥有的进程。这些流程独立于可移植 CI，需要真实 DSH/模型能力。不要并发运行 headless 流程，也不要让不同宿主共写批注存储；日志流程要求工具和路由位于同一个宿主。

### 画板写入的形式化模型

[`formal/board-write/`](formal/board-write/) 包含 TLA+ 模型、配置、代码探针、图表和已脱敏的历史结果，检查两种 observation-policy 模式下的有界写入交错、重放、丢失检测、恢复、忽略，以及保留字段的批次身份。策略关闭时，已确认修改被覆盖是**预期反例**，不是被掩盖的通过结果。模型不覆盖整个应用、重启或日志淘汰。

使用像素小镇提供的 statechart runner，或兼容的已安装 statechart 技能。它通过 **`mise` 使用 TLC 1.7.4 和 Temurin 25**，也可用 `TLA2TOOLS` 指向已有 jar、`JAVA` 指向 Java 可执行文件（否则使用 `PATH` 上的 `java`）。先运行只读 doctor；工具缺失时，必须先取得同意，再允许 runner 通过 mise 安装/下载。

```sh
export STATECHART="/path/to/pixel-town-pstack/skills/pstack-statechart/scripts/statechart"
node "$(dirname "$STATECHART")/doctor.mjs"
# 确认前置工具就绪后再继续；显式 TLA2TOOLS/JAVA 可绕过自动安装。
OUT="$(mktemp -d)"
node formal/board-write/run.mjs "$OUT"
node formal/board-write/render.mjs "$OUT"
```

运行器会核对 11 个配置各自应通过/应失败的性质，并执行真实代码的变异对照。渲染还需要本地 Chrome/Edge，可用 `CANVAS_BROWSER` 指定；请实际查看 `$OUT/chart.png`。只有打算替换已提交的脱敏结果与图表时，才给 run 命令加 `--record`。边界和同步规则见验证技能；已存结果是某次运行的证据，不是对你当前修改的新验证。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供宿主、文件系统、工具、会话和 UI API。
- [Pele](https://github.com/obsidianmd/pele) 渲染 Mermaid；[React Flow](https://github.com/xyflow/xyflow) 提供画板交互。
- [parse5](https://github.com/inikulin/parse5)、[marked](https://github.com/markedjs/marked) 和 [Playwright](https://github.com/microsoft/playwright) 支持静态文档解析和浏览器渲染。
- Lauren Tan 的 [pstack](https://github.com/cursor/plugins/tree/main/pstack) 提供了技能中采用的工程与验证方法。

上游声明、打包依赖及其许可保留于[第三方声明](THIRD_PARTY_NOTICES.md)。本社区改编不代表这些项目的认可或背书。

## 许可

**AGPL-3.0-or-later** — Copyright (C) 2026 xianxianxianyu。[LICENSE](LICENSE) 提供 GNU Affero General Public License 第 3 版全文；本项目允许采用该版本或任意后续版本。上游组件保留原始声明与许可。

如果分发修改后的版本，须按 AGPL 提供对应源码，包括修改内容以及许可要求的构建、安装脚本。如果用户通过网络与你修改后的版本交互，须按 AGPL 向这些用户免费提供该版本的对应源码。
