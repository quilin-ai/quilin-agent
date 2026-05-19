# 能力原语 / Capability Primitives

> SOTA survey, 2026-05-13. Sub-dimensions: (1) builtin tool surface; (2) MCP ecosystem. 调研对象：本仓库 `packages/agent-core/src/tools/builtin/` vs Claude Code / Codex / Hermes / OpenClaw / FastMCP / Goose 等。

> SOTA 调研，2026-05-13。两个子维度：（1）内建工具表面；（2）MCP 生态。对象：本仓库 `packages/agent-core/src/tools/builtin/` 与 Claude Code / Codex / Hermes / OpenClaw / FastMCP / Goose 等业界 SOTA。

---

## 评估目标 / Goal

Quilin's "capability primitives" are the irreducible verbs the LLM can call. They split into two surfaces: the **builtin tool surface** (what we ship in-process, hot-pathed, with sandbox-aware permission gating) and the **MCP ecosystem** (what we federate from third parties). Both surfaces compound: a thin builtin layer plus a strong MCP client/server makes the agent infinitely extensible without scaffold rewrites; a fat builtin layer with no MCP makes Quilin a closed garden. This document scores both surfaces against the 2026 SOTA, identifies the ten highest-leverage gaps, and proposes a path that lets Quilin upgrade incrementally without breaking the current 16-tool core.

Quilin 的"能力原语"是 LLM 能直接调用的最小动词集合。它分两层表面：**内建工具表面**（进程内热路径、走沙箱权限网关）和 **MCP 生态**（联邦第三方）。两层会叠加：薄内建 + 强 MCP 客户端/服务端 = 无须改 scaffold 即可无限扩展；厚内建 + 无 MCP = 封闭花园。本文档把两层对标 2026 SOTA，找出十个最高杠杆的缺口，并给出一条不破坏当前 16 工具核心、可增量演进的路径。

---

## 当前状态 / Current State

Local ground truth from `ls packages/agent-core/src/tools/builtin/`: Quilin ships **16 builtin tools** organized as `file-tools` (read/write/edit), `shell-exec`, `multimodal` (image/audio input), `skill-search` / `skill-view` / `skill-manage`, `subagent-spawn`, `web-fetch` / `web-fetch-cache` / `web-fetch-extract` / `web-browse`, plus `config-session-tools`. The MCP layer is a **client-only** integration (`mcp-client.ts`) that connects out to third-party stdio servers; Quilin neither exposes itself as an MCP server, nor handles MCP Resources, Prompts, Elicitation, or Sampling. There is no Glob, no Grep, no LSP, no Notebook, no Cron / scheduler, no Sleep, no inter-agent messaging, no remote trigger, no team management primitive.

本地实证（`ls packages/agent-core/src/tools/builtin/`）：Quilin 当前内建 **16 个工具**，分组为 `file-tools`（读写编辑）、`shell-exec`、`multimodal`（图/音输入）、`skill-search/view/manage`、`subagent-spawn`、`web-fetch/web-fetch-cache/web-fetch-extract/web-browse`，再加 `config-session-tools`。MCP 层是**纯客户端**集成（`mcp-client.ts`），只外联第三方 stdio 服务器；Quilin 不暴露自己为 MCP server，也不处理 MCP Resources / Prompts / Elicitation / Sampling。没有 Glob、Grep、LSP、Notebook、Cron / 调度器、Sleep、跨 Agent 消息、远程 trigger、Team 管理这些原语。

Competitor baselines (from upstream code reads): **Claude Code** ships ~40+ tools under `~/repo/claude-code/src/tools/`, including `GlobTool`, `GrepTool` (ripgrep-backed), `LSPTool` (9 LSP operations), `NotebookEditTool`, `CronCreateTool/CronDeleteTool/CronListTool` (the "Kairos" scheduler), `SleepTool`, `SendMessageTool` (inter-agent + UDS cross-session), `RemoteTriggerTool` (claude.ai CCR API), `TeamCreateTool/TeamDeleteTool`, plus first-class MCP integration with `MCPTool` + `ListMcpResourcesTool` + `ReadMcpResourceTool` + `McpAuthTool`. **Codex** (read `~/repo/codex/codex-rs/`) ships ~28 tools, embeds `rmcp` with both `client` and `server` features (Cargo.toml line cited), runs a `builtin-mcps` crate (currently shipping the `memories` server), exposes both an `mcp-server` and a richer JSON-RPC `app-server` for IDE integration, and supports OAuth login for outbound MCP via `codex mcp login`. **Hermes** is reported to ship 73 tools with massive `browser_tool` / `mcp_tool` implementations and uses FastMCP under the hood. **OpenClaw** ships 8 tool categories and bridges third-party MCP via `mcporter`. Quilin sits roughly at the OpenClaw tier on tool count, but has a weaker MCP story (client only) and zero IDE/notebook surface.

竞品基线（基于本地 upstream 代码读取）：**Claude Code** 在 `~/repo/claude-code/src/tools/` 下有约 40+ 工具，包括 `GlobTool`、`GrepTool`（基于 ripgrep）、`LSPTool`（9 个 LSP 操作）、`NotebookEditTool`、`CronCreateTool/Delete/List`（即 "Kairos" 调度器）、`SleepTool`、`SendMessageTool`（同机或 UDS 跨 session）、`RemoteTriggerTool`（claude.ai CCR API）、`TeamCreateTool/Delete`，以及一等公民 MCP 集成：`MCPTool` + `ListMcpResourcesTool` + `ReadMcpResourceTool` + `McpAuthTool`。**Codex**（读 `~/repo/codex/codex-rs/`）有约 28 工具，依赖 `rmcp` 并同时启用 `client` 和 `server` features（Cargo.toml 实证），有 `builtin-mcps` crate（当前 ship `memories` server），同时暴露 `mcp-server` 和更丰富的 JSON-RPC `app-server` 给 IDE，并通过 `codex mcp login` 支持出站 MCP OAuth。**Hermes** 据报告有 73 工具，重度自研 `browser_tool` / `mcp_tool`，底层用 FastMCP。**OpenClaw** 有 8 个工具类别，通过 `mcporter` 桥接第三方 MCP。Quilin 在工具数量上和 OpenClaw 一档，但 MCP 故事更弱（仅客户端），且 IDE / Notebook 表面为零。

---

## 业界 SOTA / Industry SOTA

### 1. 工具系统 / Tool Surface

#### 1.1 代码搜索 / Code Search

The 2026 consensus: **ripgrep is the de facto standard for AI coding agents**. VS Code, Cursor, Claude Code (until April 2026), Codex CLI, Aider — all reach for the same Rust binary. The why is latency at scale: agents run 10–30 search ops per task; ripgrep finishes 30 queries in under a second, whereas GNU grep takes 20–90 s. On the Linux kernel tree ripgrep clocks 0.318 s vs grep's 2.94 s (9.2×), and 302× faster on default settings thanks to `.gitignore`-awareness ([codeant.ai benchmark](https://www.codeant.ai/blogs/ripgrep-vs-grep-performance)). The key insight for agents: `.gitignore`-aware default keeps results out of `node_modules/` and pollutes 10× fewer tokens than naive grep. Claude Code's own prompt enforces "ALWAYS use Grep tool, NEVER invoke `grep` or `rg` as a Bash command" (read from `~/repo/claude-code/src/tools/GrepTool/prompt.ts`).

2026 业内共识：**ripgrep 是 AI 编码 Agent 的事实标准**。VS Code、Cursor、Claude Code（2026 年 4 月之前）、Codex CLI、Aider 全部直接调这同一个 Rust 二进制。原因是规模化下的延迟：Agent 每个任务 10–30 次 search，ripgrep 跑完 30 次只要 < 1 s，GNU grep 要 20–90 s。Linux kernel 树上 ripgrep 0.318 s vs grep 2.94 s（9.2×），默认设置下因 `.gitignore` 感知快 302× ([codeant.ai 基准](https://www.codeant.ai/blogs/ripgrep-vs-grep-performance))。对 Agent 的关键洞察：默认 `.gitignore` 感知让结果不会污染 `node_modules/`，比裸 grep 少污染 10× token。Claude Code 自己的提示词强制 "ALWAYS use Grep tool, NEVER invoke `grep` or `rg` as a Bash command"（读自 `~/repo/claude-code/src/tools/GrepTool/prompt.ts`）。

Beyond text search, **structural search via tree-sitter / ast-grep** is the rising tier. CodeRLM (2026) and `mcp-server-tree-sitter` expose function/class/caller-level queries that a regex cannot. Aider's `grep-ast` already uses tree-sitter to return matched lines *with their enclosing function* so the LLM gets actual context, not just hits. Cursor's "Instant Grep" (indexed) clocks 0.013 s on monorepos at the cost of index freshness — viable only for >100k-file repos ([Hacker News thread on CodeRLM](https://news.ycombinator.com/item?id=46974515)). For Quilin (current scale far below 100k files), **ripgrep + tree-sitter** is the right two-tier stack; an indexed solution is premature.

文本搜索之外，**基于 tree-sitter / ast-grep 的结构化搜索**是新一层。CodeRLM（2026）和 `mcp-server-tree-sitter` 都暴露了正则做不到的 function/class/caller 级查询。Aider 的 `grep-ast` 已经用 tree-sitter 返回匹配行 + 其所在函数，让 LLM 拿到真实上下文，不止命中。Cursor 的 "Instant Grep"（索引）在 monorepo 上 0.013 s，代价是索引保鲜，只对 > 10 万文件仓库划算（[Hacker News 上 CodeRLM 讨论](https://news.ycombinator.com/item?id=46974515)）。对 Quilin 现阶段（远低于 10 万文件），**ripgrep + tree-sitter** 二层栈最合适，索引方案为时尚早。

Notable 2026 deviation: Anthropic dropped ripgrep on Claude Code's native macOS/Linux builds in v2.1.117 (April 2026) in favor of `ugrep` + `bfs`, citing speed and compressed-file support — but Windows and npm installs kept ripgrep ([buildmvpfast post on 10y of ripgrep](https://www.buildmvpfast.com/blog/ripgrep-10-years-fast-cli-tools-ai-agents-2026)). The takeaway is not "ripgrep is dead" — it remains the safe default — but that a tool-surface team must keep an abstraction layer so the binary can swap without re-prompting.

2026 一个值得注意的偏离：Anthropic 在 Claude Code v2.1.117（2026-04）原生 macOS/Linux 构建里换掉了 ripgrep，改用 `ugrep` + `bfs`，理由是速度和压缩文件支持；Windows 和 npm 安装仍保留 ripgrep（[buildmvpfast 关于 ripgrep 十年的文章](https://www.buildmvpfast.com/blog/ripgrep-10-years-fast-cli-tools-ai-agents-2026)）。要点不是"ripgrep 已死"——它仍是安全默认值——而是工具表面团队必须留一层抽象，让二进制可换且无需重写提示词。

#### 1.2 LSP 集成 / LSP Integration

LSP went from "nice-to-have" to "dividing line" in 2026. Claude Code shipped native LSP in v2.0.74 (December 2025) with 9 operations (`goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls` — read from `LSPTool/prompt.ts`). The token-cost argument is decisive: a grep-based reference search on a 100-file project burns ~2000 tokens of noisy output; LSP returns exact matches in ~500 tokens ([amirteymoori on LSP+AI](https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/)). OpenCode, Cursor, and Windsurf all integrate LSP; Aider does not. The pattern that wins is **LSP for verify + rename + refs, ripgrep for explore, AI for propose**.

LSP 在 2026 年从"加分项"变成"分水岭"。Claude Code 在 v2.0.74（2025-12）原生支持 LSP，包含 9 个操作（`goToDefinition`、`findReferences`、`hover`、`documentSymbol`、`workspaceSymbol`、`goToImplementation`、`prepareCallHierarchy`、`incomingCalls`、`outgoingCalls`——读自 `LSPTool/prompt.ts`）。Token 成本论据决定性：在 100 文件项目上 grep 找引用约烧 2000 token 的噪声输出，LSP 给精确匹配只要 500 token（[amirteymoori 关于 LSP+AI](https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/)）。OpenCode、Cursor、Windsurf 都集成了 LSP，Aider 没有。赢的模式是 **LSP 用于校验 + 重命名 + 找引用，ripgrep 用于探索，AI 用于提议**。

#### 1.3 Notebook 工具 / Notebook Tooling

Jupyter is the dominant data-science surface but the tool layer is thin. The canonical stack is **Papermill** (parameterize + execute + persist metadata) on top of **nbclient** (programmatic cell-level control), both maintained by the Jupyter org. Papermill 2.x uses `nbclient` as default executor, supports inject-parameters, captures partial execution on error, and integrates with Airflow / Kubeflow ([Papermill 2.0 release notes](https://discourse.jupyter.org/t/papermill-2-0-and-nbclient-0-1-releases/3303)). Claude Code's `NotebookEditTool` is small and surgical — it only replaces/inserts/deletes one cell at a time at an absolute path (read from `NotebookEditTool/prompt.ts`) — and leaves whole-notebook execution to the user or a wrapped Papermill call. For Quilin, the right play is **edit primitive in-process, execution via shell-exec calling `papermill` or `jupyter nbconvert --execute`**, not a custom kernel-runner.

Jupyter 是数据科学的主导表面，但工具层很薄。规范栈是 **Papermill**（参数化 + 执行 + 元数据持久化）叠在 **nbclient**（程序化 cell 级控制）之上，两者都由 Jupyter 组织维护。Papermill 2.x 默认用 `nbclient` 执行器，支持注入参数，错误时保留部分执行，可对接 Airflow / Kubeflow（[Papermill 2.0 发布说明](https://discourse.jupyter.org/t/papermill-2-0-and-nbclient-0-1-releases/3303)）。Claude Code 的 `NotebookEditTool` 小而精——只在绝对路径上一次替换 / 插入 / 删除一个 cell（读自 `NotebookEditTool/prompt.ts`），整本执行交给用户或包装好的 Papermill 调用。对 Quilin，正确打法是**编辑原语进程内，执行通过 shell-exec 调 `papermill` 或 `jupyter nbconvert --execute`**，不要自己实现 kernel 运行器。

#### 1.4 Web fetch / scrape

Quilin already has `web-fetch` / `web-fetch-cache` / `web-fetch-extract` / `web-browse` — better than most agents at this layer. The 2026 frontier divides into three tiers: **lightweight markdown extraction** (Firecrawl `/scrape`, Reader API, Crawl4AI — 67% token reduction vs raw HTML according to Firecrawl benchmarks), **structural extraction** (Firecrawl `/extract` with JSON schema, Stagehand `extract()`), and **autonomous browser agents** (Firecrawl `/agent`, Browser Use, Stagehand, Playwright MCP, Anthropic computer-use). Browser Use has 50k+ GitHub stars and wraps Playwright with an LLM observe-think-act loop. The pattern that wins for an agent like Quilin: **prefer markdown-extraction APIs for read-only fetch, escalate to Playwright + accessibility-tree (not screenshot) for interactive flows, reserve computer-use / screenshot grounding only when the DOM is unreachable** ([Firecrawl 2026 comparison](https://www.firecrawl.dev/blog/best-browser-agents)). Anthropic's computer-use API (Opus 4.7 + `computer_20251124` tool) added a `zoom` action for pixel-precise grounding at 2576 px max edge ([Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)), but the cost is 466–499 tokens of system prompt overhead per call — only worth it when accessibility-tree access fails.

Quilin 在 `web-fetch` / `web-fetch-cache` / `web-fetch-extract` / `web-browse` 这层已经比多数 agent 好。2026 前沿分三档：**轻量 markdown 提取**（Firecrawl `/scrape`、Reader API、Crawl4AI——Firecrawl 自己基准说比裸 HTML 减少 67% token）、**结构化提取**（带 JSON schema 的 Firecrawl `/extract`、Stagehand `extract()`）、**自主浏览器 Agent**（Firecrawl `/agent`、Browser Use、Stagehand、Playwright MCP、Anthropic computer-use）。Browser Use 5 万+ GitHub stars，包装 Playwright + LLM 的 observe-think-act 循环。对 Quilin 这种 Agent 的赢家模式：**只读抓取优先用 markdown 提取 API，需要交互升级到 Playwright + accessibility-tree（不是截图），仅在 DOM 不可达时再用 computer-use / 截图定位**（[Firecrawl 2026 对比](https://www.firecrawl.dev/blog/best-browser-agents)）。Anthropic computer-use API（Opus 4.7 + `computer_20251124` 工具）新增 `zoom` 动作，最长边 2576 px 像素级精确定位（[Claude API 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)），但每次调用 466–499 token 系统提示开销，只在 accessibility-tree 拿不到时值得。

#### 1.5 Cron / Schedule

Claude Code's "Kairos" scheduler ships three tools — `CronCreate` / `CronDelete` / `CronList` — with a clever durability split: **session-only by default** (in-memory, dies with REPL), **`durable: true` opt-in** persists to `.claude/scheduled_tasks.json`. Standard 5-field cron in user's local timezone. Two operational details worth stealing: (a) **off-minute jitter** — the prompt explicitly tells the model "avoid `:00` and `:30` because every user asking 'every hour' gets `0 *`, fleet-wide API spike"; pick `7 * * * *` instead; (b) **30-day auto-expire** on recurring jobs to bound session lifetime; (c) **REPL-idle gating** — jobs fire only when not mid-query (read from `ScheduleCronTool/prompt.ts`). For durable-at-scale execution, **Temporal Schedules** are the production answer (event-history replay, multi-region GA April 2026) and **Inngest / BullMQ / Trigger.dev** are lighter alternatives ([Temporal Schedules article](https://temporal.io/blog/temporal-schedules-reliable-scalable-and-more-flexible-than-cron-jobs)). For Quilin Iter D, a Kairos-style in-session scheduler is the right starting point; Temporal is overkill until we have multi-day workflows.

Claude Code 的 "Kairos" 调度器有三个工具——`CronCreate` / `CronDelete` / `CronList`——以及一个巧妙的耐久度切分：**默认 session-only**（内存，REPL 退出即失），**`durable: true` 显式 opt-in** 持久化到 `.claude/scheduled_tasks.json`。标准 5 字段 cron，用户本地时区。有三个运营细节值得抄：（a）**off-minute 抖动**——提示词明说"避开 `:00` 和 `:30`，因为每个说'每小时'的用户都拿到 `0 *`，全舰队 API 峰值"，改用 `7 * * * *`；（b）**循环任务 30 天自动过期**界定 session 生命周期；（c）**REPL idle 门控**——任务仅在非查询中触发（读自 `ScheduleCronTool/prompt.ts`）。生产级耐久执行，**Temporal Schedules** 是答案（事件历史回放，2026-04 多区域 GA），**Inngest / BullMQ / Trigger.dev** 是更轻的替代（[Temporal Schedules 文章](https://temporal.io/blog/temporal-schedules-reliable-scalable-and-more-flexible-than-cron-jobs)）。Quilin Iter D Kairos 风格 session 内调度器起步合适，Temporal 在我们有多日工作流前是过度设计。

#### 1.6 多模态 / Multimodal

Quilin's `multimodal.ts` is input-only (image / audio into the LLM). The 2026 SOTA expands this in two directions: **output generation** (image / chart / video gen via fal.ai, Replicate, Gemini Image, Claude Sonnet 4.5 vision-out) and **OCR / extraction** (tesseract, easyocr, paddleocr for offline; Claude vision and GPT-4V for online). Claude Opus 4.7 supports 2576 px long-edge automatically (3× prior models, 4784 vs 1568 image tokens) ([Anthropic Opus 4.7 launch](https://www.anthropic.com/news/claude-opus-4-7)). For Quilin, the immediate gap is **screenshot grounding** (paired with computer-use) and **chart/diagram OCR** — both reusing the existing multimodal pipeline rather than building separate tools.

Quilin 的 `multimodal.ts` 只做输入（图/音入 LLM）。2026 SOTA 扩展两个方向：**输出生成**（图/图表/视频生成，走 fal.ai、Replicate、Gemini Image、Claude Sonnet 4.5 vision-out）和 **OCR / 提取**（离线用 tesseract、easyocr、paddleocr，在线用 Claude vision 和 GPT-4V）。Claude Opus 4.7 自动支持 2576 px 长边（前代的 3 倍，4784 vs 1568 image tokens）（[Anthropic Opus 4.7 发布](https://www.anthropic.com/news/claude-opus-4-7)）。对 Quilin，立即的缺口是**截图定位**（与 computer-use 配对）和**图表 / 示意图 OCR**——都复用现有多模态管线，不新建独立工具。

#### 1.7 进程间 / 跨 session 通信 / Inter-process & Cross-session Messaging

Claude Code's `SendMessageTool` is a quiet superpower: send a message to a named teammate, broadcast `"*"`, target a Unix-domain socket `"uds:/tmp/cc-socks/1234.sock"` for another local Claude session, or `"bridge:session_..."` for cross-machine peers via the Remote Control bridge (read from `SendMessageTool/prompt.ts`). Pairs with `RemoteTriggerTool` (claude.ai CCR API for scheduled remote agents — list / get / create / update / run) and `TeamCreate` / `TeamDelete` for multi-agent topology. The architectural lesson: a **single "send" verb with a polymorphic `to` field** scales further than separate APIs for in-process / IPC / remote.

Claude Code 的 `SendMessageTool` 是个低调超能力：可向命名队友发消息、`"*"` 广播、`"uds:/tmp/cc-socks/1234.sock"` 指定本机另一个 Claude session、或 `"bridge:session_..."` 通过 Remote Control 桥跨机（读自 `SendMessageTool/prompt.ts`）。和 `RemoteTriggerTool`（claude.ai CCR API 管远程定时 agent——list/get/create/update/run）和 `TeamCreate` / `TeamDelete` 配对成多 Agent 拓扑。架构教训：**单一 "send" 动词 + 多态 `to` 字段**比按进程内 / IPC / 远程拆 API 更可扩展。

#### 1.8 Sleep / 时间感知 / Sleep & Time Awareness

A surprising primitive: `SleepTool` ("Wait for a specified duration"). Claude Code's prompt explicitly says "Prefer this over `Bash(sleep ...)` — it doesn't hold a shell process" and notes "Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly" (read from `SleepTool/prompt.ts`). It is *the* tool used by the `/loop` autonomous workflow to wait between iterations without blocking the harness. Quilin's autonomous loop hard rule (per user memory `feedback_autonomous_loop.md`) makes this a top-priority primitive.

一个意外的原语：`SleepTool`（"等待指定时长"）。Claude Code 的提示词明说 "Prefer this over `Bash(sleep ...)` — it doesn't hold a shell process"，并提醒 "Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly"（读自 `SleepTool/prompt.ts`）。这是 `/loop` 自主工作流在迭代之间等待但不阻塞 harness 的核心工具。Quilin 的自主循环硬规则（用户记忆 `feedback_autonomous_loop.md`）让它成为首批要加的原语。

#### 1.9 Glob / 文件模式匹配 / Glob

Smallest tool with highest ROI: Claude Code's `GlobTool` description is 7 lines — "fast file pattern matching, supports `**/*.js`, returns paths sorted by modification time" (read from `GlobTool/prompt.ts`). Backed by Node's `fast-glob` or Rust's `globset`. Crucial for the LLM to enumerate before grep — "find all `*.ts` files modified this week" without burning tokens listing every dir. Cost: trivial to implement. Benefit: replaces 5–10 shell-exec `find` calls per session.

最小工具最高 ROI：Claude Code 的 `GlobTool` 描述只有 7 行——"快速文件模式匹配，支持 `**/*.js`，按修改时间排序返回路径"（读自 `GlobTool/prompt.ts`）。底层用 Node 的 `fast-glob` 或 Rust 的 `globset`。LLM 在 grep 之前枚举的关键——"找本周改过的所有 `*.ts` 文件"，无需烧 token 列每个目录。成本：trivial。收益：每 session 省 5–10 次 shell-exec `find`。

---

### 2. MCP 生态 / MCP Ecosystem

#### 2.1 协议状态 / Protocol Status

Year 1 numbers (Nov 2024 → Nov 2025): MCP SDK downloads grew ~970× in 18 months, crossed 97M monthly downloads by March 2026, 81k+ GitHub stars, registry crossed 2000 servers by Q1 2026, FastMCP powers ~70% of MCP servers across all languages, downloaded ~1M times daily ([WorkOS MCP 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026), [FastMCP repo](https://github.com/jlowin/fastmcp)). In December 2025 Anthropic donated MCP to the **Agentic AI Foundation** under the Linux Foundation alongside Goose and OpenAI's `AGENTS.md`. Adopted by OpenAI (Mar 2025), Google DeepMind, Microsoft Copilot Studio, JetBrains AI, Cursor, Windsurf, LangGraph, CrewAI, AutoGen. **MCP is no longer optional**.

一周年数据（2024-11 → 2025-11）：MCP SDK 18 个月下载量增长 ~970×，2026-03 月下载 9700 万+，GitHub stars 8.1 万+，注册表 2026-Q1 突破 2000 个 server，FastMCP 占所有语言 MCP server 的 ~70%，每天下载约 100 万次（[WorkOS MCP 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026)、[FastMCP repo](https://github.com/jlowin/fastmcp)）。2025-12 Anthropic 把 MCP 捐给 Linux Foundation 下的 **Agentic AI Foundation**，与 Goose、OpenAI `AGENTS.md` 同一批奠基项目。OpenAI（2025-03）、Google DeepMind、Microsoft Copilot Studio、JetBrains AI、Cursor、Windsurf、LangGraph、CrewAI、AutoGen 全部采用。**MCP 已不是选项**。

#### 2.2 三 (五) 原语 / Three (Five) Primitives

The spec defines **three server primitives** — Tools (model-controlled writes), Resources (app-controlled reads), Prompts (user-controlled templates) — and **two client primitives** — Roots (filesystem boundaries) and Sampling (server asks client for an LLM completion). The 2025-06-18 spec added **Elicitation** (server asks client for structured user input) and the 2025-11-25 spec added the experimental **Tasks** primitive for async work (a request can return a task handle and the client polls for result via `tasks/result`) ([modelcontextprotocol.io/specification/2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)). Quilin currently uses only Tools. The big asymmetry vs SOTA: **Resources** let a server stream live data (Google Drive doc, DB row, dashboard JSON) without baking it into prompts — the read-side that turns MCP from a tool bus into a context bus.

规范定义 **三个 server 原语**——Tools（模型控制的写）、Resources（应用控制的读）、Prompts（用户控制的模板）——和 **两个 client 原语**——Roots（文件系统边界）、Sampling（server 让 client 跑 LLM 补全）。2025-06-18 规范加了 **Elicitation**（server 让 client 收结构化用户输入），2025-11-25 规范加了实验性 **Tasks** 原语用于异步工作（一个请求可返回 task handle，client 通过 `tasks/result` 轮询）（[modelcontextprotocol.io/specification/2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)）。Quilin 现在只用 Tools。和 SOTA 最大的不对称：**Resources** 让 server 把活数据（Google Drive 文档、DB 行、Dashboard JSON）流式给 client，不必塞进 prompt——这是把 MCP 从"工具总线"升级到"上下文总线"的读侧。

#### 2.3 传输 / Transport

`stdio` (local subprocess via stdin/stdout JSON-RPC) and **Streamable HTTP** (replaced legacy SSE in 2025-06-18 spec; SSE is deprecated). Streamable HTTP is stateful, uses HTTP + SSE for streaming, compatible with load balancers and CDNs, wire format is JSON-RPC 2.0. The 2026 roadmap focuses on making Streamable HTTP **stateless across multiple server instances**, defining session migration during scale-out, and standardizing **MCP Server Cards** for metadata discovery without connecting ([2026 MCP roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)). The maintainers are explicit: "we are not adding more official transports this cycle." Quilin should pick stdio for local providers (already done in `mcp-client.ts`) and Streamable HTTP for remote third-party servers — and avoid the dead-end of SSE.

`stdio`（本地子进程经 stdin/stdout 跑 JSON-RPC）和 **Streamable HTTP**（2025-06-18 规范取代旧 SSE，SSE 已废弃）。Streamable HTTP 有状态，用 HTTP + SSE 流式，兼容负载均衡和 CDN，线路格式 JSON-RPC 2.0。2026 路线图聚焦把 Streamable HTTP 做成**多实例无状态**、定义 scale-out 时 session 迁移、标准化 **MCP Server Cards** 元数据发现（不连接也能看）（[2026 MCP 路线图](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)）。维护者明确说"本周期不加新官方传输"。Quilin 本地 provider 用 stdio（`mcp-client.ts` 已经这样），远程第三方 server 用 Streamable HTTP——避开 SSE 这条死路。

#### 2.4 认证 / Authentication

The 2025-06-18 spec classifies MCP servers as **OAuth 2.1 Resource Servers**, requires Resource Indicators (RFC 8707) to prevent token reuse across servers, supports Dynamic Client Registration (RFC 7591) and Protected Resource Metadata (RFC 9728). Bearer token in `Authorization` header. The 2025-11-25 spec adds **URL-mode Elicitation** (SEP-1036) so MCP servers can hand off OAuth flows to the user's browser — credentials never transit the MCP client — and **OAuth client-credentials** (SEP-1046) for machine-to-machine no-user flows like cron jobs and agent-to-agent calls, plus **Cross App Access (XAA)** with token exchange via an IdP for centralized SSO admin ([WorkOS on 2025-11-25 spec](https://workos.com/blog/mcp-2025-11-25-spec-update), [Stack Overflow on MCP auth](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/)). Critical for Quilin: **never pass-through tokens**; always token-exchange at the MCP boundary.

2025-06-18 规范把 MCP server 归类为 **OAuth 2.1 Resource Server**，要求 Resource Indicators（RFC 8707）防止 token 跨 server 重用，支持动态客户端注册（RFC 7591）和受保护资源元数据（RFC 9728）。Bearer token 走 `Authorization` 头。2025-11-25 规范加了 **URL-mode Elicitation**（SEP-1036），让 MCP server 把 OAuth 流程交给用户浏览器——凭证从不经过 MCP client——和 **OAuth client-credentials**（SEP-1046）做机机无用户流程（cron、Agent-to-Agent），以及 **Cross App Access (XAA)** 通过 IdP token exchange 实现集中 SSO 管理（[WorkOS 关于 2025-11-25 规范](https://workos.com/blog/mcp-2025-11-25-spec-update)、[Stack Overflow 关于 MCP 认证](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/)）。对 Quilin 的关键：**绝不 pass-through token**，永远在 MCP 边界做 token-exchange。

#### 2.5 双向客户端 / 服务端 / Bidirectional Client+Server

Single biggest architectural gap for Quilin: **becoming an MCP server**, not just a client. Codex does both: `~/repo/codex/codex-rs/codex-mcp/Cargo.toml` shows `rmcp = { workspace = true, default-features = false, features = ["base64", "macros", "schemars", "server"] }` plus `codex-rmcp-client = { workspace = true }` (read directly). Codex ships `mcp-server` (basic stdio MCP server exposing `codex()` and `codex-reply()` tools — read from DeepWiki) and an `app-server` (JSON-RPC bidirectional protocol mirroring the TUI loop, with endpoints like `mcpServer/oauth/login`, `mcpServer/tool/call`, `mcpServerStatus/list`) for IDE integration. The `builtin-mcps` crate has a `BuiltinMcpServer::Memories` variant with `supports_parallel_tool_calls: true` — product-owned MCP servers Codex bundles without user config (read from `builtin-mcps/src/lib.rs`). **Goose** (Block, now AAIF) is MCP-native by design: its core is the agent loop, its extension system is MCP, every capability is an MCP server — Block ships 70+ documented extensions and the wider ecosystem crossed 3000 in Q1 2026 ([Block blog on Goose](https://block.xyz/inside/block-open-source-introduces-codename-goose)). FastMCP is the easiest way to ship the server side in Python (decorator-based, auto-schema, multi-transport) and now ships an "Apps" feature for rendering interactive UIs inside conversations ([FastMCP repo](https://github.com/jlowin/fastmcp)).

Quilin 最大的架构缺口：**变成 MCP server**，不只是 client。Codex 两边都做：`~/repo/codex/codex-rs/codex-mcp/Cargo.toml` 显示 `rmcp = { workspace = true, default-features = false, features = ["base64", "macros", "schemars", "server"] }` 加上 `codex-rmcp-client = { workspace = true }`（直接读出）。Codex 有 `mcp-server`（基本 stdio MCP server，暴露 `codex()` 和 `codex-reply()` 工具——读自 DeepWiki）和 `app-server`（JSON-RPC 双向协议镜像 TUI 循环，端点如 `mcpServer/oauth/login`、`mcpServer/tool/call`、`mcpServerStatus/list`）供 IDE 集成。`builtin-mcps` crate 有 `BuiltinMcpServer::Memories` 变体且 `supports_parallel_tool_calls: true`——Codex 自带的产品级 MCP server，无需用户配置（读自 `builtin-mcps/src/lib.rs`）。**Goose**（Block，现归 AAIF）天生 MCP-native：核心是 agent loop，扩展系统就是 MCP，每个能力都是 MCP server——Block 自家 70+ 文档化扩展，整个生态 2026-Q1 突破 3000（[Block 关于 Goose 的博客](https://block.xyz/inside/block-open-source-introduces-codename-goose)）。FastMCP 是 Python 端最容易做 server 侧的工具（装饰器、自动 schema、多传输），现在还有 "Apps" 功能在对话内渲染交互式 UI（[FastMCP repo](https://github.com/jlowin/fastmcp)）。

#### 2.6 注册表与市场 / Registries & Marketplaces

The official **MCP Registry** (registry.modelcontextprotocol.io) launched as a **metaregistry** — it holds metadata only, actual code lives on npm/PyPI/Docker Hub. Backed by Anthropic, GitHub, PulseMCP, Microsoft. Around it: **Smithery** (2000+ servers, CLI install, hosted infrastructure, OAuth modal generation), **Glama** (6000+ listings, leader by count), **mcp.so** (5000+), **mcpservers.org** (4000+), **PulseMCP**, **MCP.Directory** (2002 servers across 14 categories), **mcp-awesome.com** (1200+ quality-verified). Multiple GitHub `awesome-mcp-servers` lists (appcypher, tolkonepiu/best-of-mcp-servers ranks 400 by quality score) curate the long tail. A 2026 scan of 8000+ public MCP servers found **36.7% had SSRF, 43% had unsafe command execution, 41% in the official registry had zero auth** ([TrueFoundry on best MCP registries](https://www.truefoundry.com/blog/best-mcp-registries)). For Quilin, the imperative is **publish a Quilin manifest to the metaregistry + Smithery + Glama** (so users discover us) and **consume only allowlisted servers** behind a security scan in WriteAuthority.

官方 **MCP Registry**（registry.modelcontextprotocol.io）作为 **metaregistry** 上线——只放元数据，实际代码在 npm/PyPI/Docker Hub。背靠 Anthropic、GitHub、PulseMCP、Microsoft。周围：**Smithery**（2000+ server，CLI 安装，托管基础设施，OAuth modal 生成）、**Glama**（6000+，数量第一）、**mcp.so**（5000+）、**mcpservers.org**（4000+）、**PulseMCP**、**MCP.Directory**（14 类 2002 server）、**mcp-awesome.com**（1200+ 质量验证）。多个 GitHub `awesome-mcp-servers` 列表（appcypher、tolkonepiu/best-of-mcp-servers 按质量分排 400 个）整理长尾。2026 扫 8000+ 公开 MCP server 发现 **36.7% 有 SSRF、43% 命令注入风险、官方注册表 41% 零认证**（[TrueFoundry 关于 MCP 注册表](https://www.truefoundry.com/blog/best-mcp-registries)）。对 Quilin 来说必做：**把 Quilin 清单发到 metaregistry + Smithery + Glama**（让用户找到我们）和 **只消费白名单 server**，在 WriteAuthority 后挂安全扫描。

#### 2.7 Inspector / 调试 / Debugging

`npx @modelcontextprotocol/inspector` is the Postman-of-MCP — browser UI on :6274, proxy on :6277, supports all primitives (Tools, Resources, Prompts, Tasks, Elicitation, Sampling, OAuth 2.1). Community alternative **MCPJam Inspector** covers protocol versions 03-26, 06-18, 11-25 with guided OAuth conformance checks; **mcp-use Inspector** supports MCP-UI and OpenAI Apps SDK widgets ([MCP debugging docs](https://modelcontextprotocol.io/docs/tools/debugging)). For Quilin, the testing rule should be: **every Quilin-shipped MCP server must pass Inspector smoke (list/call/elicit) before commit**.

`npx @modelcontextprotocol/inspector` 是 MCP 界的 Postman——浏览器 UI 在 :6274，代理在 :6277，支持所有原语（Tools、Resources、Prompts、Tasks、Elicitation、Sampling、OAuth 2.1）。社区替代品 **MCPJam Inspector** 覆盖 03-26、06-18、11-25 协议版本，带 OAuth 一致性检查向导；**mcp-use Inspector** 支持 MCP-UI 和 OpenAI Apps SDK widget（[MCP 调试文档](https://modelcontextprotocol.io/docs/tools/debugging)）。对 Quilin 的测试规则该是：**每个 Quilin 自带的 MCP server 在 commit 前必须过 Inspector 烟测（list/call/elicit）**。

#### 2.8 MCP Apps 与扩展系统 / MCP Apps & Extensions Framework

Launched Jan 26 2026, **MCP Apps** lets tools return rich HTML rendered in sandboxed iframes inside Claude's chat — dashboards, forms, charts, live edits. Launch partners include Amplitude, Asana, Box, Canva, Clay, Figma, Hex, Monday.com, Slack, Salesforce. The 2025-11-25 spec introduces an **extensions framework** so things like MCP Apps (SEP-1865), Authorization Extensions, and Cross App Access live as composable extensions, not core spec additions ([Anniversary post on MCP](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)). For Quilin's WebUI Dashboard, this is the right surface to render: any Quilin MCP server should be able to ship an MCP App view, not just JSON.

2026-01-26 上线的 **MCP Apps** 让 tool 返回富 HTML，在 Claude 对话内沙箱化 iframe 渲染——dashboard、表单、图表、实时编辑。首批伙伴：Amplitude、Asana、Box、Canva、Clay、Figma、Hex、Monday.com、Slack、Salesforce。2025-11-25 规范引入 **扩展框架**，MCP Apps（SEP-1865）、Authorization Extensions、Cross App Access 都作为可组合扩展存在，不进核心规范（[MCP 一周年博文](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)）。对 Quilin 的 WebUI Dashboard，这就是该用的渲染表面：任何 Quilin MCP server 都该能 ship 一个 MCP App 视图，不止 JSON。

#### 2.9 Sampling / Server-side Agent Loops

The 2025-11-25 spec lets servers deploy **internal agents under client tokens** — a research server can spawn its own LLM calls using the user's quota and coordinate multi-step work without the client micromanaging it. The `includeContext` parameter was replaced with explicit capability declarations. Combined with Tasks, a server can accept a tool call, return a task handle, run its internal agent loop, and stream results back — the client meanwhile is free to process other requests. This shifts a chunk of orchestration from client to server when it makes sense. For Quilin, if we expose Quilin-as-MCP-server, server-side sampling becomes the natural way for *other* agents to delegate work to Quilin's strong memory + planner without re-implementing them.

2025-11-25 规范允许 server **用 client 的 token 跑内部 Agent**——研究类 server 可以拿用户额度跑自己的 LLM 调用，自行协调多步工作，无需 client 微管。`includeContext` 参数被换成显式能力声明。和 Tasks 配合，server 可以收 tool call → 返回 task handle → 跑内部 agent loop → 流式回结果，client 同时可处理其他请求。这把一块编排从 client 移到 server。对 Quilin，如果我们 expose Quilin-as-MCP-server，server-side sampling 就是其他 Agent 自然委派给 Quilin 强记忆 + 规划器的方式，无需重写。

---

## 差距分析 / Gap Analysis

| Dimension | Quilin (current) | SOTA reference | Gap severity |
|---|---|---|---|
| Code search | shell-exec to grep/find | Claude Code `Grep` (ripgrep) + tree-sitter | **CRITICAL** |
| Glob | shell-exec to find | Claude Code `Glob` (fast-glob/globset) | HIGH |
| LSP | none | Claude Code 9-op LSPTool, OpenCode, Cursor | **CRITICAL** |
| Notebook | none | Claude Code `NotebookEdit` + Papermill | MEDIUM |
| Web fetch | 4 tools (good) | + Stagehand / Playwright MCP | LOW |
| Cron / schedule | none | Claude Code Kairos (3 tools) | HIGH |
| Sleep | none | Claude Code `SleepTool` (autonomous loop) | HIGH |
| Inter-agent msg | subagent-spawn only | Claude Code `SendMessage` (polymorphic `to`) | HIGH |
| Remote trigger | none | Claude Code `RemoteTrigger` (CCR API) | LOW (Iter F+) |
| Team mgmt | none | Claude Code TeamCreate/Delete | MEDIUM |
| Multimodal output | input only | image/chart/video gen | LOW |
| MCP client | yes (basic) | yes | OK |
| MCP server | **no** | Codex + Goose + every serious agent | **CRITICAL** |
| MCP Resources | no | spec primitive since v1 | **CRITICAL** |
| MCP Prompts | no | spec primitive since v1 | MEDIUM |
| MCP Elicitation | no | spec primitive since 2025-06-18 | HIGH |
| MCP Sampling | no | spec primitive since v1 | MEDIUM |
| MCP Tasks (async) | no | experimental since 2025-11-25 | LOW (still experimental) |
| MCP OAuth 2.1 | no | required for remote servers | HIGH |
| Streamable HTTP | no (stdio only) | required for remote | HIGH |
| MCP Apps | no | launched 2026-01-26 | LOW (Iter F) |
| Registry publish | no | metaregistry + Smithery + Glama | HIGH |
| Inspector smoke test | no | de facto QA | MEDIUM |

The two **CRITICAL** clusters are: (a) code intelligence — Grep + LSP, where every modern AI coding agent now beats Quilin by 5–10× on token efficiency for any cross-file task; (b) MCP bidirectionality — without Quilin-as-MCP-server, Quilin cannot be consumed by Claude Desktop, Cursor, Goose, or other Quilin instances, capping ecosystem reach.

两个 **CRITICAL** 集群：（a）代码情报——Grep + LSP，每个现代 AI 编码 Agent 在跨文件任务上 token 效率都比 Quilin 高 5–10×；（b）MCP 双向性——没有 Quilin-as-MCP-server，Quilin 不可能被 Claude Desktop、Cursor、Goose 或别的 Quilin 实例消费，生态触达受限。

---

## 推荐路径 / Recommended Path

**Ten highest-leverage tools to add, in dependency order** (the order matters — earlier items unblock later ones):

**优先添加的十个高杠杆工具，按依赖序排列**（顺序重要——前面 unblock 后面）：

1. **Glob** — wrap `fast-glob` (TS) or shell out to existing ripgrep; ~50 LOC. Unblocks every other tool that lists files. Cost: 1 day.
2. **Grep** — bundle `@vscode/ripgrep` (the same package Claude Code ships) or detect system ripgrep. Add a single rule in `WriteAuthority` to forbid raw `rg` / `grep` via shell-exec — force agents through the tool. ~150 LOC including UI. Cost: 2 days.
3. **LSP** — start with TypeScript (`typescript-language-server`) only; expose 5 of the 9 Claude Code ops first: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`. Add Python (`pyright`) in a second pass. ~600 LOC. Cost: 1 week (the hardest of the ten — LSP lifecycle, multi-server registry, file-edit invalidation).
4. **Sleep** — trivial wrapper around `setTimeout` that yields the harness; ~30 LOC. Required by autonomous-loop hard rule.
5. **Cron** (`CronCreate` / `CronDelete` / `CronList`) — start session-only in-memory; mirror Claude Code's off-minute jitter heuristic and idle-gating. Defer durable persistence to a follow-up. ~300 LOC. Cost: 3 days.
6. **NotebookEdit** — read + write `.ipynb` JSON, cell-level insert / replace / delete. Execution delegated to shell-exec calling `papermill`. ~200 LOC. Cost: 2 days.
7. **SendMessage** — polymorphic `to`: in-process (subagent name) first, UDS socket second, remote bridge deferred. ~400 LOC. Cost: 4 days.
8. **TreeSitter symbol search** — wrap `tree-sitter` + language grammars for TS / Python / Go; expose `findSymbol` / `enclosingFunction` / `callers`. Pairs with LSP; cheap when LSP unavailable. ~500 LOC. Cost: 1 week. Defer to after items 1–7 ship.
9. **TeamCreate / TeamDelete** — when subagent topology exceeds 3 agents, manual orchestration becomes lossy. Pair with SendMessage. ~300 LOC. Cost: 3 days.
10. **MultimodalOutput** — wrap fal.ai or Replicate for image gen + Claude vision for OCR. ~300 LOC. Cost: 3 days.

The 1–3 cluster (Glob + Grep + LSP) closes the **CRITICAL** code-intelligence gap and is worth doing in a single Iter D milestone — ~10 days net, including tests and prompt tuning. The 4–7 cluster closes the autonomous-loop and notebook gaps and is parallelizable.

1–3 集群（Glob + Grep + LSP）关掉 **CRITICAL** 代码情报缺口，值得作为单个 Iter D 里程碑做——净约 10 天，含测试和提示词调优。4–7 集群关掉自主循环和 Notebook 缺口，可并行。

**MCP evolution to bidirectional**, in stages (Iter D → Iter F):

**MCP 双向演化**，分阶段（Iter D → Iter F）：

- **Stage 1 (Iter D)**: extend `mcp-client.ts` to handle **Resources** (`resources/list`, `resources/read`, `resources/subscribe`) and **Prompts** (`prompts/list`, `prompts/get`). These are pure reads; no protocol-state changes. Forces ~1 week. Immediate win: third-party MCP servers exposing config/docs become first-class context, not opaque tool calls.
- **Stage 2 (Iter D late)**: add **Elicitation** handling on the client side — when a server requests structured user input, Quilin's WriteAuthority gate displays it and returns the response. ~1 week.
- **Stage 3 (Iter E)**: ship **Quilin-as-MCP-server** for `stdio` transport first, exposing `quilin.run` / `quilin.continue` (mirroring Codex's `codex` / `codex-reply` pattern). Tools surfaced: memory search, planner, skill list. Re-use FastMCP for the Python provider side and the official TS SDK for the TS core side. ~3 weeks. Pass MCP Inspector smoke.
- **Stage 4 (Iter E late)**: add **Streamable HTTP** transport for Quilin-as-server, with OAuth 2.1 (URL-mode Elicitation for user-OAuth, client-credentials for machine-to-machine). ~2 weeks.
- **Stage 5 (Iter F)**: **MCP Apps** rendering inside Quilin's WebUI Dashboard, with `Resources` subscription for live data; publish Quilin manifest to the official metaregistry + Smithery + Glama. ~2 weeks.

The **Sampling** primitive and **Tasks** primitive should be evaluated but not implemented until 2026-Q3 — Tasks is still experimental, and server-side agent loops complicate the trust boundary. **Always token-exchange, never pass-through**, per spec.

**Sampling** 原语和 **Tasks** 原语应评估但 2026-Q3 前不实施——Tasks 仍是实验性的，server-side agent loop 会让信任边界复杂化。**永远 token-exchange，绝不 pass-through**，按规范。

---

## 迁移风险 / Migration Risks

**Risk A — Tool prompt drift.** Adding 10 tools at once inflates the system prompt by ~3-5k tokens and risks the LLM picking wrong tools or skipping the new ones. Mitigation: stage rollout, add each tool with an A/B-tested prompt in BFCL-style local tests before merge, and copy Claude Code's pattern of **"ALWAYS use Grep tool, NEVER invoke grep as Bash"** explicit anti-pattern statements.

**风险 A — 工具提示词漂移**。一次加 10 个工具会让系统提示词膨胀 3–5k token，LLM 可能选错或跳过新工具。缓解：分阶段上线，每个工具在合并前用 BFCL 风格本地测试做 A/B 提示词测试，并抄 Claude Code 的 **"ALWAYS use Grep tool, NEVER invoke grep as Bash"** 显式反模式陈述模式。

**Risk B — ripgrep binary pinning.** Claude Code's April 2026 swap from ripgrep to ugrep+bfs is a warning: do NOT hard-code `rg` paths. Wrap in a `CodeSearcher` interface so the binary can swap without re-prompting. Bundle via `@vscode/ripgrep` to avoid asking the user to install.

**风险 B — ripgrep 二进制绑定**。Claude Code 2026-04 从 ripgrep 换到 ugrep+bfs 是警告：**不要**硬编码 `rg` 路径。包一层 `CodeSearcher` 接口让二进制可换且不改提示词。通过 `@vscode/ripgrep` 捆绑避免要求用户安装。

**Risk C — LSP lifecycle.** Language servers are long-lived processes that go zombie. Each new edit must invalidate diagnostics; each project switch must restart servers. Reference Claude Code's `LSPTool/symbolContext.ts` for the request/notification split. Add Quilin's WriteAuthority CRITICAL gate around `workspace/executeCommand` (LSPs can run arbitrary commands).

**风险 C — LSP 生命周期**。Language server 是长期进程，会变僵尸。每次编辑必须失效诊断；每次切项目必须重启 server。参考 Claude Code 的 `LSPTool/symbolContext.ts` 看 request/notification 切分。在 `workspace/executeCommand` 周围加 Quilin 的 WriteAuthority CRITICAL 网关（LSP 可跑任意命令）。

**Risk D — MCP server security exposure.** Once Quilin exposes itself as MCP server, every consumer becomes an attack surface. 36.7% of public MCP servers have SSRF, 43% have unsafe command execution ([TrueFoundry scan](https://www.truefoundry.com/blog/best-mcp-registries)). Mitigation: route every inbound MCP call through `WriteAuthority`, audit-log every `tools/call`, enforce `resourceIndicators` (RFC 8707) on auth, sandbox via existing shell-exec rules. Do an MCPJam OAuth conformance check before publishing to registry.

**风险 D — MCP server 安全暴露**。一旦 Quilin 自身暴露为 MCP server，每个消费者都是攻击面。36.7% 公开 MCP server 有 SSRF，43% 有命令注入风险（[TrueFoundry 扫描](https://www.truefoundry.com/blog/best-mcp-registries)）。缓解：每个入站 MCP 调用走 `WriteAuthority`，每个 `tools/call` 审计日志，在认证上强制 `resourceIndicators`（RFC 8707），通过现有 shell-exec 规则沙箱化。发布到注册表前过 MCPJam OAuth 一致性检查。

**Risk E — Schema evolution lag.** MCP shipped two major spec revisions in 12 months (2025-06-18 and 2025-11-25); the 2026 roadmap promises more. Quilin's client must negotiate protocol version on initialize and downgrade gracefully. Bundle the official `@modelcontextprotocol/sdk` and re-test on every spec bump, do not hand-roll JSON-RPC.

**风险 E — Schema 演化滞后**。MCP 12 个月内发了两次重大版本（2025-06-18 和 2025-11-25），2026 路线图还会有更多。Quilin 客户端必须在 initialize 时协商协议版本并优雅降级。捆绑官方 `@modelcontextprotocol/sdk`，每次规范更新重测，不要手写 JSON-RPC。

**Risk F — Notebook execution sandbox.** Papermill runs arbitrary Python kernels. If invoked from agent prompts, treat as `shell-exec` CRITICAL — same trust mode as `rm -rf`. Default deny in `AUTO` trust, ask in `--trust ask`.

**风险 F — Notebook 执行沙箱**。Papermill 跑任意 Python kernel。如果从 Agent 提示词触发，视同 `shell-exec` CRITICAL——和 `rm -rf` 一样的信任模式。`AUTO` 默认拒绝，`--trust ask` 才问。

---

## 参考 / References

Spec & roadmap / 规范与路线图:
- [Model Context Protocol Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [2026 MCP Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [One Year of MCP (Anniversary Post)](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)
- [Tasks primitive (2025-11-25 spec)](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [WorkOS — MCP 2025-11-25 spec update](https://workos.com/blog/mcp-2025-11-25-spec-update)
- [WorkOS — Everything to know about MCP in 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026)
- [Stack Overflow — MCP Authentication](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/)
- [Cloudflare — MCP Transport docs](https://developers.cloudflare.com/agents/model-context-protocol/transport/)
- [MCP Cheat Sheet 2026 (Webfuse)](https://www.webfuse.com/mcp-cheat-sheet)

Code search / 代码搜索:
- [Andrew Gallant — ripgrep is faster than grep/ag/git-grep/ucg/pt/sift](https://burntsushi.net/ripgrep/)
- [CodeAnt — Ripgrep vs grep 5–13× benchmark](https://www.codeant.ai/blogs/ripgrep-vs-grep-performance)
- [CodeAnt — Why Coding Agents Should Use ripgrep](https://www.codeant.ai/blogs/why-coding-agents-should-use-ripgrep)
- [Buildmvpfast — Ripgrep at 10 Years (Claude Code switch to ugrep)](https://www.buildmvpfast.com/blog/ripgrep-10-years-fast-cli-tools-ai-agents-2026)
- [Codonomics — Beyond Grep: Master ripgrep in Claude Code](https://blog.codonomics.com/2026/04/beyond-grep-master-ripgrep-performance.html)
- [Hacker News — CodeRLM (tree-sitter for LLM agents)](https://news.ycombinator.com/item?id=46974515)
- [Lambda Land — Tree-sitter vs LSP explainer](https://lambdaland.org/posts/2026-01-21_tree-sitter_vs_lsp/)

LSP / IDE integration / LSP 与 IDE 集成:
- [Amir Teymoori — LSP: The Secret Weapon for AI Coding Tools](https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/)
- [Tembo — 2026 Guide to Coding CLI Tools (15 AI agents compared)](https://www.tembo.io/blog/coding-cli-tools-comparison)
- [Cursor 3 launch blog](https://cursor.com/blog/cursor-3)
- [Aider vs OpenCode (NxCode)](http://www.nxcode.io/resources/news/aider-vs-opencode-ai-coding-cli-2026)

Notebook / Papermill:
- [Papermill 2.0 + nbclient 0.1 release notes](https://discourse.jupyter.org/t/papermill-2-0-and-nbclient-0-1-releases/3303)
- [Papermill repo (nteract)](https://github.com/nteract/papermill)
- [Ploomber — Three Tools for Executing Jupyter Notebooks](https://ploomber.io/blog/notebook-execution/)

Web / browser agents / Web 与浏览器 Agent:
- [Browser-use repo (50k+ stars)](https://github.com/browser-use/browser-use)
- [Firecrawl — 11 Best AI Browser Agents in 2026](https://www.firecrawl.dev/blog/best-browser-agents)
- [Firecrawl — Playwright vs Firecrawl](https://www.firecrawl.dev/blog/playwright-vs-firecrawl)
- [Stagehand vs Browser Use vs Playwright 2026](https://www.nxcode.io/resources/news/stagehand-vs-browser-use-vs-playwright-ai-browser-automation-2026)
- [Anthropic — Computer Use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Anthropic — Opus 4.7 launch (vision 2576px)](https://www.anthropic.com/news/claude-opus-4-7)

Cron / scheduling:
- [Temporal Schedules — Reliable & Scalable](https://temporal.io/blog/temporal-schedules-reliable-scalable-and-more-flexible-than-cron-jobs)
- [Inngest vs BullMQ vs Trigger.dev (2026)](https://starterpick.com/guides/inngest-vs-bullmq-vs-triggerdev-boilerplates-2026)

MCP frameworks / MCP 框架:
- [FastMCP (jlowin/fastmcp)](https://github.com/jlowin/fastmcp)
- [FastMCP docs (gofastmcp.com)](https://gofastmcp.com/getting-started/welcome)
- [Anthropic MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [AI SDK Core — MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [Block — codename goose introduction](https://block.xyz/inside/block-open-source-introduces-codename-goose)
- [Goose docs (block-goose)](https://block-goose.mintlify.app/)
- [Codex MCP docs (OpenAI Developers)](https://developers.openai.com/codex/mcp)
- [Codex App Server architecture (OpenAI)](https://openai.com/index/unlocking-the-codex-harness/)
- [DeepWiki — Codex MCP Server Implementation](https://deepwiki.com/openai/codex/7.3-contributing-and-architecture-guidelines)

MCP registries & marketplaces / MCP 注册表与市场:
- [Official MCP Registry](https://registry.modelcontextprotocol.io/)
- [Smithery](https://smithery.ai/) · [Smithery docs](https://smithery.ai/docs)
- [MCP.so](https://mcp.so/) · [MCP Market](https://mcpmarket.com/)
- [appcypher/awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers)
- [tolkonepiu/best-of-mcp-servers](https://github.com/tolkonepiu/best-of-mcp-servers)
- [MCP.Directory awesome list](https://mcp.directory/awesome-mcp-servers)
- [TrueFoundry — Best MCP Registries 2026 (security stats)](https://www.truefoundry.com/blog/best-mcp-registries)
- [MCP Playground — 70+ Best MCP Servers 2026](https://mcpplaygroundonline.com/blog/awesome-mcp-servers)

MCP debugging / tools / MCP 调试与工具:
- [MCP Inspector (modelcontextprotocol/inspector)](https://github.com/modelcontextprotocol/inspector)
- [MCPJam Inspector](https://github.com/MCPJam/inspector)
- [MCP Debugging docs](https://modelcontextprotocol.io/docs/tools/debugging)

Local ground-truth reads / 本地实证读取:
- `~/repo/claude-code/src/tools/{Glob,Grep,LSP,NotebookEdit,ScheduleCron,Sleep,SendMessage,RemoteTrigger,MCP,ListMcpResources,ReadMcpResource,McpAuth}Tool/` — Claude Code tool prompts and structures
- `~/repo/codex/codex-rs/codex-mcp/Cargo.toml` — `rmcp` with `server` feature + `codex-rmcp-client`
- `~/repo/codex/codex-rs/codex-mcp/src/{rmcp_client,connection_manager,elicitation,codex_apps,tools,runtime}.rs` — split after PR #19725
- `~/repo/codex/codex-rs/builtin-mcps/src/lib.rs` — `BuiltinMcpServer::Memories` with `supports_parallel_tool_calls: true`
- `packages/agent-core/src/tools/builtin/` — Quilin's current 16-tool surface
