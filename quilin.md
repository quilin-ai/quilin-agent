# Quilin Agent — 项目指南

> 本文件为 Claude Code (`CLAUDE.md`) 和 Codex (`AGENTS.md`) 的共享指南，通过符号链接统一引用。

## Project Overview

Quilin Agent（麒麟）is a self-evolving Agent framework that tracks **curated upstream projects across 12 capability domains** (~100 total, hand-picked per domain). Upstream changes are detected via `scripts/sync-upstreams.py`, surfaced as AI-assisted diff reports, and merged into Quilin through **human-reviewed fusion PRs** — not automatic scaffold rewrites.

## Architecture

> See [docs/00-core-loop](docs/00-core-loop/README.md) for current core architectural decisions.
> Historical snapshots are available through git history, not docs archive folders.

- **Core Loop**: Custom minimal Agent Loop (< 200 lines TS), no LangGraph or external framework
- **Runtime Languages**: TS (Agent core) + Python (ML providers as MCP servers) are active; Rust has an Iter D `crates/mesh-sdk` stub, with mesh/WASM runtime behavior deferred to Iter F.
- **E-T-C-S-L-V**: Six capabilities exposed as LLM-callable tools, not fixed state graph nodes
- **Layered Memory**: quilin-mem 4-tier (working/episodic/semantic/skill) with auto-reflect + User Profile Store + Departure Context
- **Communication**: MCP stdio (TS↔Python). Agent Mesh (gRPC) and HTTP SSE streaming land in Iter D+.
- **Temporal Awareness**: 3-layer time perception (intra-session gap, absolute time, cross-session timeline)
- **Permission Model**: Default **AUTO** (matches user preference "默认最大权限"). AUTO auto-approves non-CRITICAL operations so the agent flows without prompting on every routine action. **CRITICAL operations always confirm** via the `WriteAuthority` ask gate regardless of trust mode — CRITICAL covers file_write outside the project root, destructive shell_exec (`rm -rf` / `git push --force` / database migrations), self-evolution scaffold patch apply, and skill_create / skill_update with cross-project effects. `origin:"idle"` writes (idle-evolution patches) require explicit `--trust auto` opt-in (cannot run silently even under AUTO default). To opt out per session pass `--trust ask`, or persist `safety.trust_mode: "ask"` in user config. All agent-initiated writes (shell_exec / file_write / scaffold patch / skill_create / idle evolution) route through a single **`WriteAuthority`** gate (07 §2.6.4, Task #90). See 07-safety.
- **CLI-Anything**: GUI tools auto-wrapped as CLI via HKUDS/CLI-Anything for universal tool access
- **WebUI Dashboard**: Independent global visualization panel (tasks, memory, metrics, Agent topology)
- **Benchmark Freeze**: Benchmark is the lowest project priority as of 2026-05-02. Iter E is frozen/canceled, and no Iter may add or modify Benchmark code unless the user explicitly asks for Benchmark work.
- **User Insight Engine**: Pattern mining on user behavior → proactive insights → Aha Moments
- **Non-blocking Supervisor**: Main Agent is always available — all task execution delegated to Sub-Agents; progress reporting via checkpoint + heartbeat (WebUI realtime + IM proactive push)
- **Idle Evolution (opt-in)**: When explicitly enabled, idle-time memory consolidation and browsing can run under a bounded daily token budget. **Default is OFF**; any scaffold write requires human-in-loop review (never auto-apply).
- **LLM SDK**: Vercel AI SDK v6 (630M+ weekly downloads, 25+ providers) — best-in-class TS LLM abstraction
- **Runtime**: Bun (TS) + CPython 3.14 (Python); pnpm/uv package managers; just for cross-language orchestration. Cargo/Rust added in Iter D.
- **Benchmark Scope**: existing benchmark code remains in-tree as historical/current implementation evidence only. Unfinished Benchmark Linear projects/issues are canceled or low priority; do not reopen, replace, or extend them without an explicit user request.

Active scope = **12 engineering domain specs** (01..11 + 13-skills). Domain 12 (Conversation Engineering) is parked as a research note until the core loop and dependent runtime components have local evidence.

> **任务管理不写在本文件，也不写在 docs 里。** 本文件是项目指南(符号链接为 CLAUDE.md / AGENTS.md,每 session 加载到每个 agent 上下文)。Linear 是任务 / backlog / phase tracking 源；`docs/STATUS.md` 和组件 README 只保留当前状态快照与架构事实，经"状态声明实证纪律"(见 Agent Collaboration 节)验证后写入。

> **执行记录硬规则 / Execution Logging Rule**：Before the main agent or any subagent starts a non-trivial task, it must confirm or create a Linear issue / project / comment as the task record. Implementation, research, cross-review, idle component exploration, architecture exploration, performance exploration, and competitor issue absorption must be recorded in Linear, not only in chat. Research tasks must also write results into bilingual docs under the relevant component directory, or update the current-state snapshot in an existing component README / `docs/STATUS.md`.
>
> 主 agent 或任何 subagent 执行非琐碎任务前，必须先确认或创建 Linear issue / project / comment 作为任务记录。实现、调研、交叉 review、空闲组件深挖、架构探索、性能探索、竞品 issue 吸收都必须写入 Linear；不得只在聊天里口头记录。调研类任务还必须把结果写入相关组件目录下的中英双语 docs，或更新现有组件 README / `docs/STATUS.md` 的当前状态快照。

> **Linear 免费额度纪律 / Linear Free Plan Budget Rule**：The workspace is on Linear's free plan with a 250-issue cap. Treat issues as scarce: reuse existing issues and comments for sub-tasks, subagent logs, probes, reviews, and idle exploration. Create a new issue only for work that needs independent ownership, status, blockers, or acceptance criteria. At 200 issues, ask the user before bulk creation; at 225 issues, stop creating new issues unless the user explicitly approves.
>
> 当前 workspace 使用 Linear 免费版，最多 250 个 issue。必须把 issue 当稀缺资源：子任务、subagent 日志、probe（调研记录）、review（审核记录）和空闲探索优先复用已有 issue 的 comment。只有需要独立负责人、状态、阻塞关系或验收条件的工作才新建 issue。达到 200 个 issue 时，批量创建前必须询问用户；达到 225 个 issue 时，除非用户明确批准，否则停止新建 issue。

> **文档语言硬规则 / Documentation Language Rule**：所有新增或重写的项目文档必须中英双语、按段落对照。标题优先中文，并在同一标题补英文（例如 `## 架构 / Architecture`）。正文按"英文段落 → 中文段落"成对排列，方便用户逐段对照阅读。Linear project / issue 描述在承担任务文档作用时也遵守同一规则。除非用户明确要求，否则不要新增英文-only 文档。

> **术语可读性硬规则 / Terminology Readability Rule**：不要裸写黑话、缩写或内部代号。首次出现时必须带括号注释，说明它是什么、为什么重要；中文优先，英文全称可放括号内。例如写 `BFCL（Berkeley Function Calling Leaderboard，一个测试模型函数/工具调用能力的基准）`，不要只写 `BFCL = Berkeley Function Calling Leaderboard`。类似 `R1`、`E3c1b1`、`adapter`、`worker`、`harness` 这类词，也要在首次出现时用自然语言解释。

## Documentation Map

| 文档 | 位置 | 用途 |
|------|------|------|
| docs 索引 | `docs/README.md` | docs/ 各子文件夹说明 + 写入/查阅约定 |
| 任务管理 | Linear `QuiLin Agent` workspace | project / issue / backlog / phase tracking 的唯一入口 |
| 全局状态 | `docs/STATUS.md` | 当前 Iter 与组件状态快照 |
| 协作协议 | `agent-bridge.md` | Claude ↔ Codex 协作**权威源**（任务生命周期、长任务纪律、对称异步 review、commit 权属、降级模式） |
| 核心架构 | `docs/00-core-loop/README.md` | Core Loop、运行时切分、全局架构约束 |
| 术语表 | `docs/00-core-loop/glossary.md` | **规范术语源（CI 强制）** |
| 组件 spec | `docs/<编号-组件>/README.md` | 每个核心组件的当前架构、约束和实现状态 |

## Commands

```bash
# ===== 现有脚本（规划阶段） =====
python scripts/sync-upstreams.py              # 单次上游检查
python scripts/sync-upstreams.py --daemon     # daemon 模式，每 5 分钟
bash scripts/merge-with-claude.sh <submodule-name> [diff-summary]
bash scripts/release.sh --dry-run             # 预览发布
bash scripts/init-all-submodules.sh           # 首次初始化 submodule
bash scripts/setup-cron.sh --status           # 检查 cron 状态

# ===== Phase 0 开发命令（项目骨架落地后可用） =====
just init          # 一键安装全部依赖（pnpm + uv + cargo）
just start         # 一键启动全部服务（agent-core + quilin-mem）
just stop          # 一键停止
just restart       # 一键重启
just test-all      # 一键测试（TS + Python + Rust）
just check         # 一键 lint + format
just clean         # 一键清理构建产物
just dev           # TS 开发模式（前台 + watch）
just dev-memory    # Python quilin-mem 开发模式
just build         # TS 构建
just build-rs      # Rust workspace check（Iter D mesh-sdk stub）
just test-rs       # Rust workspace tests（Iter D mesh-sdk stub）
```

## Directory Structure

```
quilin-agent/
├── packages/                       # TS — pnpm workspace (Iter A+)
│   └── agent-core/                 #   Agent Loop + LLM + Context + Tools
├── providers/                      # Python — uv workspace (Iter A+)
│   └── memory/                     #   quilin-mem MCP Server
├── crates/                         # Rust — cargo workspace (Iter D mesh-sdk stub; runtime deferred to Iter F)
├── upstreams/                      # ~100 git submodules (tracked, --depth 1)
├── docs/
│   ├── README.md                   # docs/ 写入/查阅约定
│   ├── STATUS.md                   # 当前全局状态
│   ├── 00-core-loop/
│   ├── 01-llm-integration/
│   ├── 02-context/
│   │   └── conversation-engineering/  # parked sub-module — Iter F+
│   ├── ...
│   ├── 11-agent-mesh/
│   ├── 13-skills/
│   ├── 14-benchmark-harness/       # frozen — only modify on explicit user ask
│   ├── 15-introspection/           # 元思考 / Introspection (design doc, pre-impl gate)
│   └── 16-soul-import/             # 灵魂导入 / Soul Import (spec; QUI-102 implementation)
├── scripts/                        # 自动化脚本
├── .devcontainer/                  # Dev Container（Bun + Python 3.14 + Rust 1.94）
├── .github/workflows/ci.yml       # CI（三语言矩阵）
├── justfile                        # 跨语言编排
├── quilin.md                       # 本文件（共享指南）
├── CLAUDE.md → quilin.md           # Claude Code 符号链接
├── AGENTS.md → quilin.md           # Codex 符号链接
└── readme.md
```

## 14 Active Engineering Domains

| # | Domain | Key Design | Spec |
|---|--------|-----------|------|
| 01 | LLM Integration | Single model + Vercel AI SDK v6, ThinkingMode, InferenceConfig | [01](docs/01-llm-integration/README.md) |
| 02 | Context | System prompt assembly, token budget, compression, temporal awareness | [02](docs/02-context/README.md) |
| 03 | Memory | quilin-mem 4-tier, vector+KG retrieval, auto-reflect, User Profile Store | [03](docs/03-memory/README.md) |
| 04 | Planning | Intent recognition, task decomposition, strategy switching | [04](docs/04-planning/README.md) |
| 05 | Tools | 4-type hybrid action space, MCP client, browser, CLI-Anything | [05](docs/05-tool/README.md) |
| 06 | Multi-Agent | Homogeneous spawn + heterogeneous mesh, non-blocking supervisor | [06](docs/06-multi-agent/README.md) |
| 07 | Safety | 4-layer verification, AUTO default + CRITICAL always-asks gate, 2-stage classifier | [07](docs/07-safety-guardrails/README.md) |
| 08 | Observability | OTel tracing, metrics, structured logs, WebUI Dashboard | [08](docs/08-observability/README.md) |
| 09 | Deployment | CLI, config management, hot update | [09](docs/09-deployment-runtime/README.md) |
| 10 | Self-Evolution | Trajectory analysis, opt-in idle evolution, human-in-loop scaffold patches, skill creation, User Insight Engine | [10](docs/10-self-evolution/README.md) |
| 11 | Agent Mesh | Mesh connectivity via AgentMesh SDK (Iter D) | [11](docs/11-agent-mesh/README.md) |
| 13 | Skills | SKILL.md + frontmatter, catalog + on-demand load, path/size safety, M0/M1/M2+ phased | [13](docs/13-skills/README.md) |
| 15 | Introspection | Meta-cognition: trace-anchored reflection feeding back into the next plan, with controlled user-facing rhythm | [15](docs/15-introspection/README.md) |
| 16 | Soul Import | Install-time scan of 6 agent frameworks → seed global `~/.quilin/{soul,user}.md` body + per-project `QUILIN.md`; all writes CRITICAL | [16](docs/16-soul-import/README.md) |

### Parked (sub-module)

| # | Domain | Status |
|---|--------|--------|
| 02.x | Conversation Engineering（原 12-） | **Parked sub-module under 02-context** — 6-layer "alive feeling" 研究延后到 Iter F+（core loop 与依赖 runtime 组件有本地实证后再启动）。spec 保留为 research note，见 [02-context/conversation-engineering](docs/02-context/conversation-engineering/README.md)。 |

### Frozen

| # | Domain | Status |
|---|--------|--------|
| 14 | Benchmark Harness | **Frozen since 2026-05-02** — existing code remains as historical/current evidence only; do not add or modify Benchmark code unless the user explicitly asks. See `基准冻结 / Benchmark Freeze` section in [docs/STATUS.md](docs/STATUS.md). |

## Code Style & Conventions

- **TypeScript**: ESNext target, strict mode, Biome for lint/format, immutable interfaces (`readonly`), `.js` extensions in imports
- **Python**: 4-space indent, type annotations, `pathlib.Path`, Ruff for lint/format, structlog for logging
- **Rust**: edition 2024, clippy + rustfmt, workspace dependencies; Iter D only includes the `mesh-sdk` stub and defers runtime mesh behavior to Iter F
- **Markdown**: `docs/` 根目录只保留 `README.md` / `STATUS.md` + 编号组件目录；组件 README 是当前真相源；历史快照通过 git history 追溯；新增或重写项目文档必须中英双语、按段落对照：标题优先中文，可在同一标题中补英文；正文采用"英文段落 → 中文段落"的顺序，便于逐段对照阅读
- **Shell**: 小写 kebab-case, `set -euo pipefail`
- **Logging**: 三种语言统一 JSON schema 输出到 stdout（详见 [08 Observability](docs/08-observability/README.md)）
- **Generated artifacts**: `.logs/`, `.patches/`, `dist/`, `target/`, `__pycache__/` 不纳入版本控制

## Testing

- **TS**: Vitest, 80% coverage threshold, `just test`
- **Python**: pytest + pytest-asyncio, `just test-py`
- **Rust**: `cargo test --workspace` via `just test-rs`; no external crates in the Iter D `mesh-sdk` stub
- **All at once**: `just test-all`（TS + Python + Rust）
- **Before Phase 0 skeleton lands**: 修改脚本时用 `--help` / `--dry-run` 最小验证；修改文档时检查链接和交叉引用

## Commit & PR Conventions

- Conventional Commits: `<type>: <summary>` (feat, fix, refactor, docs, test, chore, perf, ci)
- PR 聚焦单一主题，说明影响范围（文档 / 脚本 / submodule / 代码），链接相关 ADR 或 spec
- 涉及 submodule bump 必须写明原因和范围
- 不提交 `.env`、密钥、cron 日志、patch 产物

## Agent Collaboration

> **权威源**：[`agent-bridge.md`](./agent-bridge.md)（仓库根目录）。本节仅列高频条目；完整协议（任务生命周期、长任务纪律、对称异步 review、Commit 权属、降级模式等）以 `agent-bridge.md` 为准。冲突时以 `agent-bridge.md` 为准。

- **Claude Code** (Planner / Reviewer / Scribe) 和 **Codex** (Implementer / Verifier) 通过 AgentBridge 协作；双方都可起 subagent
- **双在线 + token 充足** → 共同规划。Claude 不当甩手掌柜，开放性 / 时效性问题必须网络搜索（详见 agent-bridge.md §2 / §5.2 / §5.3）
- **协作请求必须回复**：收到对方的协作消息后，必须通过 AgentBridge 回复，不能单方面沉默
- **协作语言使用中文**：Agent 之间通过 AgentBridge 的所有对话使用中文，方便用户同步查看协作内容
- **Linear 先于执行**：主 agent / subagent 做任何非琐碎实现、调研、review、探索前，必须在 Linear 中有 issue、project 或 comment；空闲 subagent 优先从 Linear 队列领取或复用已有 issue comment，只有需要独立验收 / 阻塞关系时才新建 issue
- **调研必须落档**：调研输出不能只留在聊天或 Linear comment；需要写入相关组件 docs，保持中英双语、按段落对照
- **subagent 用于并行**：预期超过 5 分钟且能与其他工作并行的任务用 subagent，让主线程继续推进其他工作。**单任务不派 subagent**：如果只有一个任务在飞、主线程会一直闲等，直接主线程做更快（不绕 worktree → cherry-pick 仪式，少一道 worktree-cwd 误写主仓库的风险）。详见 agent-bridge.md §3.3
- **谁写代码谁 commit**（详见 agent-bridge.md §8.1）
- 每个任务结束双方主动提醒用户开新 session（详见 agent-bridge.md §9）
- 在核心实现落地前，默认先改文档 / 计划 / 脚本，不凭空扩展未批准的运行时代码结构
- 新增 `packages/` / `providers/` 下的代码，必须先对齐 `docs/00-core-loop/README.md` 与对应组件 spec（`crates/` 在 Iter D 引入后才适用）
- 所有日志输出 JSON 到 stdout，确保 Claude Code Monitor 可在 dev / test / prod 三种环境实时监控

### 状态声明实证纪律

任何关于项目进度、契约履行、LOC 约束、代码缺失的声明，在写进任何文档之前**必须先做 git 实证**：

- LOC 声明 → `wc -l <file>` 附数字
- 代码缺失声明 → `Glob` + `Grep` 附结果
- phase ✅ 声明 → 附 commit hash + 测试通过数 + tsc/lint 结果
- 契约违反声明 → 附被违反契约的文档出处（行号）+ 实测值
- 引用非本 session 产出的 review 前，**抽样 2-3 条 finding 当场实证**

结束 phase 或关闭 finding 的 commit，commit message 附实证片段（LOC / 测试通过数 / tsc 退出码）。给其他 agent 下任务书引用 review 条目时，标明"抽查 X 条 / Y 条已过时"。

### Cross Code Review 循环（硬规则 / Hard rule）

**任何新写的代码（无论主 agent 还是 subagent 写）落库前必须走 cross review 循环**。这是 quilin-agent 项目所有代码工作的硬约束，未经此流程不得 commit / push / 更新 Linear 状态。

Any new code (whether written by main agent or subagent) must pass a cross-review loop before landing. This is a hard constraint for all code work in quilin-agent — no `git commit` / `git push` / Linear status change is permitted without this gate.

**流程 / Procedure**:

1. 写完新代码（或 subagent 在 worktree 完成 task）
2. **派 2 个全新独立 subagent** 做 cross code review，角度尽量正交：
   - Reviewer A: 类型 / 逻辑 / 算法 / 测试覆盖
   - Reviewer B: 集成漂移 / 安全 / 边界 / 回归风险 / API 兼容
3. 任一 reviewer 找出**真实 issue**（非 SUSPECT，非 RECOMMEND）→ **写代码的 agent**（主 agent 或原 worktree subagent）针对问题修复
4. 修复完 → **再派 2 个全新 subagent** 做 review（不复用之前的 reviewer，避免 confirmation bias）
5. 循环步骤 2-4，直到**两个新 reviewer 都报告 0 真实 issue**

**只有 2 个 reviewer 都 clean 后**才允许：
- `git commit` / `git push`
- 更新 Linear issue 状态（特别是 In Progress → Done）
- worktree subagent 的 commit cherry-pick 进 master

**Why**: DeepSeek 笨蛋模型时期的虚假完成（Linear 标 Done 实际是 stub）+ 7 轮审计才挖出 13 个真 bug 的教训。单 reviewer 易报 false positive 或漏 bug；2 reviewer 交叉审 + 多轮迭代 = 收敛到真实质量底。"测试通过 + tsc EXIT=0" 不等于 ship-ready，必须有显式 review gate。

**适用 / Applies to**:
- Feature commit / fix commit / refactor / 跨文件修改
- Tier 2 worktree subagent 返回的代码（cherry-pick 前必须先 review）
- 主 agent 自己派 subagent 写的代码

**不适用 / Does not apply**:
- 纯文档修改（无代码逻辑）
- 纯 lint format / 单行 typo
- Memory / Linear 文本更新

**SUSPECT 与 RECOMMEND 的处理**:
- SUSPECT（reviewer 不 100% 确定）→ **主 agent 必须亲自实证（grep / Read / 跑测试）后判决**，不能口头驳回
- RECOMMEND（建议性优化，非 bug）→ 不阻塞 cherry-pick，但应记录到 Linear backlog

**收敛判定 / Convergence**:
- 连续两个**新派**的 reviewer 都报 0 真实 issue（false positive 不算）→ 通过
- 主 agent 反驳 reviewer 报错时，反驳必须附实证（grep 结果 / file:line / 测试通过数），写入对话上下文供后续 reviewer 参考

> Per-language and per-skill cross-review patterns are also recorded in user memory `feedback_cross_review_loop.md`; the canonical source of truth is **this file**.

## Important Constraints

- Do not modify local language environment versions (Go, Python, Node, etc.)
- Never execute SQL scripts directly
- Submodules use `--depth 1` (shallow clone) to save disk space
- Target languages (current): **TypeScript (core)** + **Python (ML providers)** + **Rust stub (mesh-sdk)**. Do not add Rust mesh/WASM runtime code before Iter F.
- **No auto-scaffold-write**: 任何对 `packages/` / `providers/` / spec 的修改都必须走 human-reviewed PR；Idle Evolution / Self-Evolution 只能 propose patch，不能直接 apply。

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
