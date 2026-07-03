# Quilin Agent — 麒麟

> **📦 项目冻结公告 / Project Freeze Notice** — 2026-07-03
>
> Quilin Agent 已停止活跃开发。它作为一次系统性的 Agent harness 工程研究,沉淀了跨 12 个领域的设计与一套可用的本地记忆系统,这些成果保留在本仓库供参考与复用。当前的推进方向是把其中最成熟的 **quilin-mem**(`providers/memory` —— 一个本地单文件 SQLite 记忆 MCP server)拆分为独立项目继续演进。作者目前的主力项目是 **[agent-bridge](https://github.com/quilin-ai/agent-bridge)**(多 agent 协作框架)。
>
> Quilin Agent is no longer under active development. Built as a systematic study of Agent harness engineering, it leaves behind designs across 12 domains and a working local memory system, preserved here for reference and reuse. The active direction now is spinning out its most mature piece, **quilin-mem** (`providers/memory` — a local single-file SQLite memory MCP server), into a standalone project that continues. The author's current primary project is **[agent-bridge](https://github.com/quilin-ai/agent-bridge)** (a multi-agent collaboration framework).

> **Quilin** = Quilt（拼布）+ Qilin（麒麟）
>
> 一个基于对主流 Agent 框架系统性研究、原生构建的自演进 Agent 平台

**愿景**：把 harness（包裹在 LLM 外面的一切）做到极致，让任何模型都能超水平发挥。我们从 Agent 工程的 **12 个关键维度** 深入研究领先框架的设计取舍，提炼跨方案的共性模式，形成统一的原生实现——每一次架构演进都走人工 review PR 流程，并优先用本地组件实证与交叉 review 验证。

## 一句话定位 / One-Liner

**Quilin = 自研 Agent Loop + 12 领域 harness + 两语言运行时 + 研究驱动的持续演进**

**Quilin = self-built Agent Loop + 12-domain harness + two-language runtime + research-driven continuous evolution**

不是 LangGraph 变体，不是 LangChain 上层封装，而是按 Harness Engineering 原则原生构建的、可被团队主导演进的 Agent 操作系统。

Not a LangGraph variant or LangChain wrapper — a natively built Agent OS following Harness Engineering principles, owned and evolved by the team.

## 当前状态 / Current State (2026-05-21)

### 🎉 完美记忆系统 v2 全 ship!

调研 14 个竞品仓库 + 24 篇论文 + 9 个评测榜 → Claude × Codex 双视角协商 → ship 13 工单 + 4 dogfood follow-up,**~9 小时完成**(原估 25-30 联合日,~25-30x 加速)。详细简报见 [`docs/03-memory/v2-overnight-shipping-brief.md`](docs/03-memory/v2-overnight-shipping-brief.md)。

| 验证维度 | 状态 |
|---|---|
| Plane 工单 Done | 15/16(QUI-22/81/188-200/201/203/208,QUI-202 Codex 收尾)|
| Playwright 真 e2e | **5/5 PASS**(真启 MCP + Web + SQLite 浏览器全链路)|
| Dogfood 验证 | 真打开 Quilin 跑 5 轮对话,记忆 CRUD 全真生效 |
| pytest providers/memory | **860 PASS(2026-07-03 复测)** |
| coverage | 91.38%(2026-07-03 复测) |
| Cross-review | 70+ reviewer subagent × 55+ REAL fix |

### Quilin 已超前业界 3 项(14 竞品都没)

1. **WriteAuthority 全局门禁** — 14 类敏感操作经统一审批
2. **4 客户端共享记忆** — CLI / REPL / Web / Mac App 共享 `~/.quilin/`
3. **灵魂导入** — 6 框架 install 时扫描(反向导出明确不做)

### 代码状态

| 指标 / Metric | 值 / Value |
|---|---|
| TS source files | 260+ |
| Test files / cases | 135+ / 1,800+ (all passing) |
| Python source files (quilin-mem) | 65+(v2 新增 salience/project_scope/prospective/daemon/safety_lesson_store/store_versioning 等)|
| Loop LOC | 1,198(517+565+116)|
| Rust files (mesh-sdk stub) | 3 |
| Active iterations completed | Phase 0, Iter A/B/C/M/D, Iter G1/G2/H/I/J/K + **完美记忆系统 v2** |
| Iter E (Benchmark) | **frozen / canceled** |
| Memory v2 commits | **24 commits 2026-05-21**(从 ab1f758 → a589aba)|

### 接入文档(任何 MCP-compatible agent 都能用)

外部 agent(Claude Code / Codex / Gemini CLI / OpenCode / 等)接 quilin-mem 完整 install 指南:[`docs/03-memory/external-agent-integration.md`](docs/03-memory/external-agent-integration.md)。

详情见 [docs/STATUS.md](docs/STATUS.md)。

## 核心架构 / Core Architecture

- **自研 TypeScript Agent Loop** —— `loop.ts` + `loop-tool-calls.ts` + `loop-types.ts` 共 1,198 LOC（已超出最初 `<200 LOC` 契约），不依赖 LangGraph / LangChain / AutoGen
- **两语言运行时** —— TypeScript（Agent 核心 + 12 领域 harness）+ Python（quilin-mem MCP Server）。Rust `crates/mesh-sdk` 仅是 Iter D stub，runtime mesh 延后到 Iter F
- **Harness Engineering** —— LLM 是发动机，12 领域是整辆车
- **极简 Agent Loop hooks** —— `onTurnComplete` / `onIdle` / `onToolResult` / `onAssistantMessage` / `onMessagesUpdated`
- **LLM 抽象** —— Vercel AI SDK v6（25+ providers）；当前 DeepSeek 全链路完整，Anthropic / OpenAI / Gemini 为 blocked / candidate
- **极简哲学** —— 约束悖论、Build to Delete、最小化然后迭代

详见 [Core Loop](docs/00-core-loop/README.md) 与 [Harness Engineering](docs/00-core-loop/harness-engineering.md)。

## 技术栈 / Tech Stack

| 层 / Layer | 运行时 / Runtime | 包管理 / Package | 测试 / Test | 构建 / Build |
|---|---|---|---|---|
| TS（Agent 核心） | Bun | pnpm | Vitest（80% 覆盖率门槛） | Bun bundler |
| Python（ML Provider） | CPython 3.14 | uv（Astral） | pytest + pytest-asyncio | uv + hatchling |
| Rust（mesh-sdk stub） | Rust 1.94 | cargo | `cargo test --workspace` | cargo |

**跨语言编排 / Orchestration**：`just`（justfile）· **日志 / Logging**：JSON schema 输出到 stdout · **本地开发 / Local Dev**：本地裸机开发，`.devcontainer/` 留给 CI/CD

## 通信 / Communication

- **MCP stdio**（TS↔Python，延迟 ~5ms）—— 跨语言调用主通道，断连自动重连
- **code-review-graph MCP** —— Tree-sitter 增量知识图谱，token 高效的代码审查
- **AgentBridge MCP** —— Claude（规划 / review）↔ Codex（执行 / 实现）双 Agent 协作桥
- **HTTP Control Plane** —— `/dashboard`、`/snapshot`、`/sessions`、`/traces`、`/api/chat`
- gRPC（Agent Mesh）—— 跟随 Rust mesh-sdk 到 Iter F 引入

## 12 个工程领域 / 12 Engineering Domains

| # | 领域 / Domain | 当前能力 / Current Capability | Spec |
|---|---|---|---|
| 01 | LLM 接入 / LLM Integration | AI SDK v6、ThinkingMode、provider live matrix、reasoning/tool stream extraction、cache usage；DeepSeek 完整。 | [01](docs/01-llm-integration/README.md) |
| 02 | 上下文 / Context | Prompt/session assembly、token budgeting、temporal awareness、memory bridge、injection scanner、skills catalog/restore、compression、cache stability、Conversation Engineering 6 层 + 7 种风格预设。 | [02](docs/02-context/README.md) |
| 03 | 记忆 / Memory | quilin-mem MCP（自动重连）、四层 memory、SQLite/FTS5+Bun 内置后端、KG/vector retrieval hooks、profile store、scratchpad、consolidator auto_schedule、L3a observer（flash 驱动）。 | [03](docs/03-memory/README.md) |
| 04 | 规划 / Planning | Main-LLM direct planning + audit/strategy contracts；tiny classifier 不是默认路径。 | [04](docs/04-planning/README.md) |
| 05 | 工具 / Tools | 15 built-in tools（file/web/shell/skill/mcp/multimodal/subagent/config/session）+ tool_search 网关、MCP bridge、DockerSandbox（auto/on/off）。 | [05](docs/05-tool/README.md) |
| 06 | 多 Agent / Multi-Agent | InProcessSupervisorRuntime：子 Agent 生命周期、heartbeat/stale 检测、recovery context、`/agents` 展示；mesh 分布式延后。 | [06](docs/06-multi-agent/README.md) |
| 07 | 安全护栏 / Safety | auto 默认（低中风险自动批）、`--yolo` 全自动、四级 WriteAuthority（auto/ask/yolo/read_only）、ActionVerifier、MetaVerifier、secret redaction、SSRF guard。 | [07](docs/07-safety-guardrails/README.md) |
| 08 | 可观测性 / Observability | Span/Metrics/Logs、Prometheus、JSON file exporter、SQLite 持久化、Web Dashboard（HTML 看板 + Web Chat）、Control Plane API。 | [08](docs/08-observability/README.md) |
| 09 | 部署运行时 / Deployment | CLI（`quilin config show/set/service install`）、TOML config cascade、hot reload、first-run welcome、`/resume` + `/resume latest`、`/mcp`、systemd/launchd 自启、soul.md/user.md。 | [09](docs/09-deployment-runtime/README.md) |
| 10 | 自进化 / Self-Evolution | Trajectory store、failure analyzer、patch proposal、proposal store（approve/reject/apply）、offline optimizer、idle runner（每日配额）；trajectory→patch→proposal 闭环已串联。 | [10](docs/10-self-evolution/README.md) |
| 11 | Agent Mesh | Rust `crates/mesh-sdk` stub + CI wiring；runtime mesh 是 Iter F。 | [11](docs/11-agent-mesh/README.md) |
| 13 | 技能工程 / Skills | SKILL.md catalog、`skill_view`、CRUD + merge、guard、restore、watcher、`skill_search`（本地+远程 skills.sh）、provenance 签名验证；M2 已闭合。 | [13](docs/13-skills/README.md) |
| 14 | Benchmark Harness | **frozen / read-only**；除非用户明确要求 Benchmark 工作，任何 Iter 都不得新增或修改。 | [14](docs/14-benchmark-harness/README.md) |

> **Domain 12（Conversation Engineering / 对话工程）** —— 6 层架构 + 7 种风格预设已实现并集成到 ContextAssembler runtime（不再 parked）。

## Built-in Tools（15 个）

| Tool | Category | 功能 |
|---|---|---|
| `tool_search` | programmatic | 工具发现网关（system prompt 主入口）|
| `skill_search` | programmatic | 技能搜索（本地 + 远程 skills.sh） |
| `mcp_search` | programmatic | MCP 市场搜索（claudemarketplaces.com） |
| `file_read` / `file_write` / `file_list` | programmatic | 文件 IO（敏感检测 + WriteAuthority） |
| `shell_exec` | programmatic | Shell 执行（sandbox auto/on/off） |
| `web_fetch` | programmatic | HTTP 请求（SSRF 防护） |
| `skill_view` / `skill_manage` | interactive | 技能查看 / CRUD + merge |
| `image_describe` / `video_summarize` / `audio_transcribe` | interactive | 多模态 |
| `subagent_spawn` / `subagent_status` | interactive | 后台子 Agent 启动 / 状态查询 |
| `config_view` / `session_list` | programmatic | 运行时配置 / 历史会话 |

System prompt 只暴露三个搜索工具（`tool_search` / `skill_search` / `mcp_search`），其它工具通过搜索发现并直接调用。

## 目录结构 / Directory Structure

```
quilin-agent/
├── packages/
│   └── agent-core/                 # TS — pnpm workspace
│       ├── src/
│       │   ├── loop.ts             # Agent Loop（452 LOC）
│       │   ├── loop-tool-calls.ts  # 工具调用（565 LOC）
│       │   ├── loop-types.ts       # 类型契约（85 LOC）
│       │   ├── repl.ts             # REPL + 命令派发
│       │   ├── context/            # PromptBuilder + ContextManager + 6 层对话风格
│       │   ├── llm/                # AI SDK v6 client + tier router
│       │   ├── memory/             # LocalMemoryBackend + MemoryClient
│       │   ├── multi-agent/        # InProcessSupervisorRuntime
│       │   ├── observability/      # Spans/Metrics/Logs + Web Dashboard
│       │   ├── planning/           # Intent + Plan + Replan + Routing
│       │   ├── safety/             # WriteAuthority + ActionVerifier
│       │   ├── self-evolution/     # Trajectory + Failure + Proposal + Idle Runner
│       │   ├── skills/             # SkillsManager + SkillsGuard + Remote Registry
│       │   ├── tools/              # 15 builtin tools + ToolRouter + MCPRegistry
│       │   ├── tui/                # 终端 UI（panel/table/theme）
│       │   ├── control-plane/      # Web 控制台 HTTP server
│       │   └── ...
│       └── package.json
├── providers/
│   └── memory/                     # Python — uv workspace
│       └── src/quilin_mem/         # quilin-mem MCP Server
├── crates/
│   └── mesh-sdk/                   # Rust stub（Iter F runtime mesh）
├── docs/
│   ├── README.md                   # docs 入口与写入约定
│   ├── STATUS.md                   # 全局状态快照
│   └── <00-14>-<component>/        # 各组件当前架构与状态
├── scripts/                        # 自动化脚本
├── justfile                        # 跨语言编排
├── quilin.md                       # 共享指南（CLAUDE.md / AGENTS.md 符号链接）
└── readme.md                       # 本文件
```

## 快速启动 / Quick Start

```bash
# 一键开发 / One-shot Dev
just init          # 安装依赖（pnpm + uv）
just start         # 启动全部服务（agent-core + quilin-mem MCP）
just dev           # TS 开发模式（前台 + watch）
just dev-yolo      # 全自动模式（永不询问，仅本地实验用）
just dev-ask       # 严格询问模式（每次写入都确认）
just test-all      # 一键测试（TS + Python + Rust）
just check         # lint + format
just build         # TS 构建

# Web Dashboard
QUILIN_DASHBOARD_PORT=9000 just dev   # 浏览器访问 http://127.0.0.1:9000/dashboard

# 上游研究（不自动 apply）
python scripts/sync-upstreams.py              # 单次上游检查
python scripts/sync-upstreams.py --daemon     # daemon，每 5 分钟
bash scripts/release.sh --dry-run             # 预览发布
```

## 安全 / Trust Modes

| 模式 / Mode | 行为 / Behavior |
|---|---|
| `read_only` | 完全只读，任何写入都拒绝 |
| `ask` | 每次写入都询问 |
| `auto`（默认）| 低中风险自动批，高风险询问 |
| `yolo` | 全自动，永不询问（仅本地实验） |

通过 `QUILIN_TRUST_MODE` 环境变量切换，或在 user config 中固化。

## Benchmark 冻结 / Benchmark Freeze

截至 2026-05-02，Benchmark 是全项目最低优先级。Iter E 已冻结并在 Linear 中取消；未完成的 Benchmark project / issue 已从活跃队列移出或降为低优先级。

仓库中已有的 `benchmarks/` 与 `providers/memory/benchmarks/` 代码保留为当前代码事实和历史证据。除非用户明确要求 Benchmark 工作，任何 Iter 都不得新增或修改 Benchmark 代码，也不得重开已取消的 Benchmark 任务。当前口径见 [Benchmark Harness](docs/14-benchmark-harness/README.md)。

## 多 Agent 协作 / Multi-Agent Collaboration

本项目使用 **AgentBridge** 协调两个 AI agent：

| 角色 / Role | 职责 / Responsibility |
|---|---|
| **Claude Code** | Reviewer / Planner / Hypothesis Challenger — 架构设计、代码审查、任务分解 |
| **Codex CLI** | Implementer / Executor / Reproducer — 代码编写、修改、重构、沙箱验证 |

协作语言中文，所有协作消息必须回复。详见 [quilin.md](quilin.md) 的 AgentBridge 章节。

## 当前状态入口 / Status Entry Points

- **全局状态**：[docs/STATUS.md](docs/STATUS.md)
- **Core Loop**：[docs/00-core-loop/README.md](docs/00-core-loop/README.md)
- **任务管理**：[Linear: QuiLin Agent](https://linear.app/quilin-agent)
- **历史**：必要历史通过 git history 追溯，docs 不再保留 ADR / research / review 档案

## 为什么叫 Quilin？/ Why Quilin?

**麒麟**汇聚百兽之灵——鹿角、牛尾、龙鳞、马蹄，集多种灵性于一身，却是一种独立而完整的祥瑞。

我们的 Agent 平台也是如此：工程团队主导研究 Agent 工程的最佳实践，提炼、设计、原生实现，最终构成一个完整统一的体系。名字本身即是这种精神——**Quilt**（拼布）+ **Qilin**（麒麟）= **Quilin**。

The Qilin gathers virtues of many creatures — antlers of a deer, tail of an ox, scales of a dragon, hooves of a horse — yet remains a single, complete creature. Quilin Agent does the same: research the best of the Agent engineering field, distill it, design it, implement it natively, and emerge as one unified platform. The name says it: **Quilt** + **Qilin** = **Quilin**.

---

MIT License
