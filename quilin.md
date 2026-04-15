# Quilin Agent — 项目指南

> 本文件为 Claude Code (`CLAUDE.md`) 和 Codex (`AGENTS.md`) 的共享指南，通过符号链接统一引用。

## Project Overview

Quilin Agent（麒麟）is a dynamic, self-evolving Agent framework that monitors 12 capability domains x Top 10 open-source projects each (~100 total upstreams). It auto-syncs upstream changes, uses AI agents to intelligently analyze diffs, generates fusion patches, and publishes new versions.

## Architecture

> See [ADR-001](docs/adr/adr-001-core-loop-and-language.md) for core architectural decisions.
> See [ADR-002](docs/adr/adr-002-project-skeleton.md) for project skeleton blueprint (Phase 0).

- **Core Loop**: Custom minimal Agent Loop (< 200 lines TS), no LangGraph or external framework
- **Three-Language Architecture**: TS (Agent core) + Python (ML Providers as MCP Servers) + Rust (Agent Mesh networking, WASM sandbox)
- **E-T-C-S-L-V**: Six capabilities exposed as LLM-callable tools, not fixed state graph nodes
- **Layered Memory**: OmniMem 4-tier (short/mid/long/ultra) with auto-reflect + User Profile Store + Departure Context
- **Agent Mesh**: Built-in capability module — auto-joins AgentMesh network at startup via SDK adapter
- **Communication**: MCP stdio (90%, TS↔Python), gRPC (Agent Mesh), HTTP SSE (frontend streaming)
- **Temporal Awareness**: 3-layer time perception (intra-session gap, absolute time, cross-session timeline)
- **Default AUTO Permission**: Maximum trust by default, only CRITICAL ops require confirmation (ref: Claude Code auto mode)
- **CLI-Anything**: GUI tools auto-wrapped as CLI via HKUDS/CLI-Anything for universal tool access
- **WebUI Dashboard**: Independent global visualization panel (tasks, memory, metrics, Agent topology)
- **Benchmark Participation**: SWE-bench Verified / GAIA / BFCL v4 public leaderboard submissions
- **User Insight Engine**: Pattern mining on user behavior → proactive insights → Aha Moments
- **Non-blocking Supervisor**: Main Agent is always available — all task execution delegated to Sub-Agents; progress reporting via checkpoint + heartbeat (WebUI realtime + IM proactive push)
- **Idle Evolution Budget**: When user is idle, auto self-evolve using spare subscription quota or daily API token budget (memory consolidation, scaffold improvement, skill expansion, web browsing); transparent report-back on next session
- **Conversation Engineering**: 6-layer "alive feeling" architecture (sentence surface, turn structure, opinion/judgment, relationship modeling, temporal continuity, meta layer); 3 style modes (native/custom/alive)
- **LLM SDK**: Vercel AI SDK v6 (630M+ weekly downloads, 25+ providers) — best-in-class TS LLM abstraction
- **Runtime**: Bun (TS) + CPython 3.14 (Python) + Rust 1.94 native; pnpm/uv/cargo package managers; just for cross-language orchestration
- **God Mode**: Founder's Agent instance has unrestricted permissions — auto-build, auto-update, auto-deploy, self-development (dogfooding)
- **Full Benchmark Plan**: 8 categories, 30+ benchmarks (SWE-bench/GAIA/BFCL/WebArena/AgentHarm etc.) — compete on every public leaderboard

## Current Status

**Entering Phase 0** — all 12 engineering domain specs are complete. Project skeleton initialization (ADR-002) is the next step, followed by Phase 0 core implementation.

## Documentation Map

| 文档 | 位置 | 用途 |
|------|------|------|
| 架构决策 | `docs/adr/adr-###-slug.md` | 已定稿的技术决策 |
| 架构总览 | `docs/architecture/overview.md` | 12 领域全景图 + 导航 |
| Harness 工程 | `docs/architecture/harness-engineering.md` | 顶层架构概念 |
| 工程领域 spec | `docs/engineering/<编号-领域>/README.md` | 12 个领域详细设计 |
| 调研材料 | `docs/research/` | Claude Code / Codex / OpenClaw / Hermes 深度调研 |
| 实施计划 | `docs/implementation-plan.md` | 三阶段迁移 + benchmark 竞赛 |

## Commands

```bash
# ===== 现有脚本（规划阶段） =====
python scripts/sync-upstreams.py              # 单次上游检查
python scripts/sync-upstreams.py --daemon     # daemon 模式，每 5 分钟
bash scripts/merge-with-claude.sh <submodule-name> [diff-summary]
bash scripts/release.sh --dry-run             # 预览发布
bash scripts/init-all-submodules.sh           # 首次初始化 submodule
bash scripts/setup-cron.sh --status           # 检查 cron 状态

# ===== Phase 0 开发命令（ADR-002 落地后可用） =====
just init          # 一键安装全部依赖（pnpm + uv + cargo）
just start         # 一键启动全部服务（agent-core + omnimem）
just stop          # 一键停止
just restart       # 一键重启
just test-all      # 一键测试（TS + Python + Rust）
just check         # 一键 lint + format
just clean         # 一键清理构建产物
just dev           # TS 开发模式（前台 + watch）
just dev-memory    # Python OmniMem 开发模式
just build         # TS 构建
just build-rs      # Rust 构建
```

## Directory Structure

```
quilin-agent/
├── packages/                       # TS — pnpm workspace (Phase 0+)
│   └── agent-core/                 #   Agent Loop + LLM + Context + Tools
├── providers/                      # Python — uv workspace (Phase 0+)
│   └── memory/                     #   OmniMem MCP Server
├── crates/                         # Rust — cargo workspace (Phase 2 骨架)
│   └── mesh-sdk/                   #   Agent Mesh SDK
├── upstreams/                      # ~100 git submodules (auto-synced, --depth 1)
├── docs/
│   ├── adr/                        # 架构决策记录
│   ├── architecture/               # 架构总览 + Harness 工程
│   ├── engineering/                # 12 个工程领域 spec
│   │   ├── 01-llm-integration/
│   │   ├── ...
│   │   └── 12-conversation-engineering/
│   ├── research/                   # 深度调研
│   └── implementation-plan.md
├── scripts/                        # 自动化脚本
├── .devcontainer/                  # Dev Container（Bun + Python 3.14 + Rust 1.94）
├── .github/workflows/ci.yml       # CI（三语言矩阵）
├── justfile                        # 跨语言编排
├── quilin.md                       # 本文件（共享指南）
├── CLAUDE.md → quilin.md           # Claude Code 符号链接
├── AGENTS.md → quilin.md           # Codex 符号链接
└── readme.md
```

## 12 Engineering Domains

| # | Domain | Key Design | Spec |
|---|--------|-----------|------|
| 01 | LLM Integration | Single model + Vercel AI SDK v6, ThinkingMode, InferenceConfig | [01](docs/engineering/01-llm-integration/README.md) |
| 02 | Context | System prompt assembly, token budget, compression, temporal awareness | [02](docs/engineering/02-context/README.md) |
| 03 | Memory | OmniMem 4-tier, vector+KG retrieval, auto-reflect, User Profile Store | [03](docs/engineering/03-memory/README.md) |
| 04 | Planning | Intent recognition, task decomposition, strategy switching | [04](docs/engineering/04-planning/README.md) |
| 05 | Tools | 4-type hybrid action space, MCP client, browser, CLI-Anything | [05](docs/engineering/05-tool/README.md) |
| 06 | Multi-Agent | Homogeneous spawn + heterogeneous mesh, non-blocking supervisor | [06](docs/engineering/06-multi-agent/README.md) |
| 07 | Safety | 4-layer verification, default AUTO permission, 2-stage classifier | [07](docs/engineering/07-safety-guardrails/README.md) |
| 08 | Observability | OTel tracing, metrics, structured logs, WebUI Dashboard | [08](docs/engineering/08-observability/README.md) |
| 09 | Deployment | CLI, config management, hot update | [09](docs/engineering/09-deployment-runtime/README.md) |
| 10 | Self-Evolution | Trajectory analysis, scaffold self-modification, skill creation, User Insight Engine | [10](docs/engineering/10-self-evolution/README.md) |
| 11 | Agent Mesh | Built-in mesh connectivity via AgentMesh SDK | [11](docs/engineering/11-agent-mesh/README.md) |
| 12 | Conversation Engineering | 6-layer alive feeling, 3 style modes, relationship modeling | [12](docs/engineering/12-conversation-engineering/README.md) |

## Code Style & Conventions

- **TypeScript**: ESNext target, strict mode, Biome for lint/format, immutable interfaces (`readonly`), `.js` extensions in imports
- **Python**: 4-space indent, type annotations, `pathlib.Path`, Ruff for lint/format, structlog for logging
- **Rust**: edition 2024, clippy + rustfmt, workspace dependencies
- **Markdown**: 保留现有编号目录形式（`01-llm-integration`），ADR 统一 `adr-###-slug.md`
- **Shell**: 小写 kebab-case, `set -euo pipefail`
- **Logging**: 三种语言统一 JSON schema 输出到 stdout（详见 ADR-002 §7）
- **Generated artifacts**: `.logs/`, `.patches/`, `dist/`, `target/`, `__pycache__/` 不纳入版本控制

## Testing

- **TS**: Vitest, 80% coverage threshold, `just test`
- **Python**: pytest + pytest-asyncio, `just test-py`
- **Rust**: cargo test + insta, `just test-rs`
- **All at once**: `just test-all`
- **Before Phase 0 skeleton lands**: 修改脚本时用 `--help` / `--dry-run` 最小验证；修改文档时检查链接和交叉引用

## Commit & PR Conventions

- Conventional Commits: `<type>: <summary>` (feat, fix, refactor, docs, test, chore, perf, ci)
- PR 聚焦单一主题，说明影响范围（文档 / 脚本 / submodule / 代码），链接相关 ADR 或 spec
- 涉及 submodule bump 必须写明原因和范围
- 不提交 `.env`、密钥、cron 日志、patch 产物

## Agent Collaboration

- **Claude Code** (Reviewer / Planner) 和 **Codex** (Implementer / Executor) 通过 AgentBridge 协作
- **Claude Code 只做规划，不写代码**：架构设计、代码审查、任务分解、决策判断由 Claude Code 负责；所有代码编写、修改、重构由 Codex 执行
- **协作请求必须回复**：收到对方的协作消息（review 结果、修改建议、任务完成通知等）后，必须通过 AgentBridge 回复对方，不能单方面沉默
- **协作语言使用中文**：Agent 之间通过 AgentBridge 的所有对话使用中文，方便用户同步查看协作内容
- 在核心实现落地前，默认先改文档 / 计划 / 脚本，不凭空扩展未批准的运行时代码结构
- 新增 `packages/` / `providers/` / `crates/` 下的代码，必须先对齐 `docs/adr/adr-002-project-skeleton.md` 与对应工程 spec
- 所有日志输出 JSON 到 stdout，确保 Claude Code Monitor 可在 dev / test / prod 三种环境实时监控

## Important Constraints

- Do not modify local language environment versions (Go, Python, Node, etc.)
- Never execute SQL scripts directly
- Submodules use `--depth 1` (shallow clone) to save disk space
- Target languages: TypeScript (core), Python (ML providers), Rust (infra)

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

<!-- AgentBridge:start -->
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Claude, by Anthropic) is available in a parallel session on this machine.
Communication happens via AgentBridge MCP tools — Claude has `reply` and `get_messages` tools.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities the other agent has.
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Claude rather than doing everything yourself.

### Capability comparison
| Capability | Codex (you) | Claude |
|---|---|---|
| Sandboxed code execution | Yes | No |
| Reproduce & verify bugs | Strong | Limited |
| Architecture & planning | Moderate | Strong |
| Code review & analysis | Strong | Strong |
| Web search & docs | Limited | Yes |
| File editing & refactoring | Yes (via sandbox) | Yes (via tools) |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor**.
2. State what you'll handle and what you'd like Claude to take on.
3. Ask for Claude's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.
<!-- AgentBridge:end -->
