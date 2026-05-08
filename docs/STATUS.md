# 当前状态 / Quilin Agent Status

This status snapshot was updated on 2026-05-08 / 本状态快照更新于 2026-05-08。

This file is the only global progress entry point under `docs/`. Component-level current facts live in each `docs/<component>/README.md`. Historical snapshots are traced through git history. Task management and backlog tracking live in Linear; this file keeps only current-state snapshots.

本文件是 `docs/` 下唯一的全局进度入口。组件级当前事实写在各 `docs/<component>/README.md`。历史快照通过 git history 追溯。任务管理与 backlog 统一迁移到 Linear；本文件只保留当前状态快照。

## 当前焦点 / Current Focus

Iter E（Benchmark Ascent，基准冲刺）is frozen as of 2026-05-02. Benchmark is now the lowest project priority, and no Iter may add or modify Benchmark code unless the user explicitly asks for Benchmark work.

截至 2026-05-02，Iter E（Benchmark Ascent，基准冲刺）已冻结。Benchmark 现在是全项目最低优先级；除非用户明确要求 Benchmark 工作，任何 Iter 都不得新增或修改 Benchmark 代码。

Existing Benchmark code remains part of the current repository state. It is not active roadmap scope: `benchmarks/` contains 62 tracked TS/Python source and test files under `src/` and `scripts/`, while `providers/memory/benchmarks/` contains the existing offline memory benchmark harness files. These files may be read as historical/current implementation evidence, but they are not a license to continue Benchmark implementation.

已有 Benchmark 代码仍是当前仓库状态的一部分，但不再是活跃路线图范围：`benchmarks/` 在 `src/` 和 `scripts/` 下有 62 个 TS/Python 源码与测试文件，`providers/memory/benchmarks/` 下有既有离线 memory benchmark harness 文件。这些文件可以作为历史/当前实现证据读取，但不能作为继续推进 Benchmark 实现的许可。

Current local evidence from 2026-05-07 commands:

2026-05-07 命令实证如下：

- `list_graph_stats_tool` reports 329 indexed files, 4,641 nodes, and 50,914 edges.
- `list_graph_stats_tool` 报告已索引 329 个文件、4,641 个节点、50,914 条边。
- `wc -l packages/agent-core/src/loop.ts` reports 452 LOC; the core loop has grown beyond the original `<200 LOC` contract, with the full loop system spanning `loop.ts` (452) + `loop-tool-calls.ts` (565) + `loop-types.ts` (85) = 1,102 LOC.
- `wc -l packages/agent-core/src/loop.ts` 报告 452 LOC；核心循环已超出最初 `<200 LOC` 契约，整个 loop 体系横跨 `loop.ts` (452) + `loop-tool-calls.ts` (565) + `loop-types.ts` (85) = 1,102 LOC。
- `rg --files packages/agent-core/src -g '*.ts' | wc -l` reports 258 TypeScript files.
- `rg --files packages/agent-core/src -g '*.ts' | wc -l` 报告 258 个 TypeScript 文件。
- `pnpm --dir packages/agent-core test` reports 129 test files and 1,711 tests, all passing.
- `pnpm --dir packages/agent-core test` 报告 129 个测试文件、1,711 个测试，全部通过。
- `pnpm --dir packages/agent-core exec tsc --noEmit --project tsconfig.json` exits cleanly.
- `pnpm --dir packages/agent-core exec tsc --noEmit --project tsconfig.json` 零错误退出。
- `rg --files providers/memory/src providers/memory/tests -g '*.py' | wc -l` reports 55 Python files.
- `rg --files providers/memory/src providers/memory/tests -g '*.py' | wc -l` 报告 55 个 Python 文件。
- `rg --files crates/mesh-sdk | wc -l` reports 3 Rust files/config entries.
- `rg --files crates/mesh-sdk | wc -l` 报告 3 个 Rust 文件/配置项。
- `rg --files benchmarks/src benchmarks/scripts -g '*.ts' -g '*.py' | wc -l` reports 62 Benchmark TS/Python source and test files.
- `rg --files benchmarks/src benchmarks/scripts -g '*.ts' -g '*.py' | wc -l` 报告 62 个 Benchmark TS/Python 源码与测试文件。
- `rg --files providers/memory/benchmarks | wc -l` reports 4 memory benchmark harness files.
- `rg --files providers/memory/benchmarks | wc -l` 报告 4 个 memory benchmark harness 文件。

Linear has been updated to match this freeze: the `Iter E 基准冲刺 / Benchmark Ascent` project is `Canceled` and `Low`; unfinished Benchmark issues `QUI-6`, `QUI-7`, `QUI-8`, `QUI-43`, `QUI-47`, and `QUI-70` are `Canceled` and `Low`. The available Linear MCP exposes cancel/update rather than hard-delete, so cancellation is the active-queue removal mechanism used for this session.

Linear 已同步这次冻结：`Iter E 基准冲刺 / Benchmark Ascent` project 已标记为 `Canceled` 与 `Low`；未完成 Benchmark issue `QUI-6`、`QUI-7`、`QUI-8`、`QUI-43`、`QUI-47`、`QUI-70` 已标记为 `Canceled` 与 `Low`。本 session 可用的 Linear MCP 暴露 cancel/update 而不是 hard-delete，因此本次用取消作为移出活跃队列的机制。

## 迭代状态 / Iteration State

| Iter | 状态 | 当前含义 | 证据 |
|---|---:|---|---|
| Phase 0 PoC | closed | Agent Loop + quilin-mem MCP + REPL baseline，v0.0.3。 | `packages/agent-core/src/loop.ts` + `providers/memory/src/quilin_mem/server.py` |
| Iter A Grounded Context | closed | Context assembly、prompt builder、temporal awareness、memory bridge，v0.1.0-iter-a。 | `docs/02-context/README.md` |
| Iter B Tools + Skills + Safety | closed | Tool substrate、READ-ONLY default safety policy、Skills M0/M1 activation。 | `docs/05-tool/README.md` + `docs/13-skills/README.md` + `docs/07-safety-guardrails/README.md` |
| Iter C Planning Core | closed | Planning + inference strategy，与 memory 抽离并行完成。 | `docs/04-planning/README.md` |
| Iter M Memory | closed | quilin-mem 主体切片完成；L3a observer 仍 blocked/deferred。 | `docs/03-memory/README.md` |
| Iter D Operability | closed | Observability、config、scratchpad、Rust `mesh-sdk` stub、CI 和 coverage gate。 | `docs/08-observability/README.md` + `crates/mesh-sdk/Cargo.toml` |
| Iter E Benchmark Ascent | frozen / canceled | Existing code remains in-tree; all unfinished Benchmark planning and implementation work is canceled in Linear. | `docs/14-benchmark-harness/README.md` + `QUI-6` / `QUI-7` / `QUI-8` / `QUI-43` / `QUI-47` / `QUI-70` |
| Iter F Scale-Out | governed by local runtime evidence | Supervisor、Agent Mesh、memory depth、self-evolution、Conversation Engineering must use local component gates first; no Benchmark code without explicit user request. | `docs/06-multi-agent/README.md` + `docs/11-agent-mesh/README.md` |

| Iter | Status | Current Meaning | Evidence |
|---|---:|---|---|
| Phase 0 PoC | closed | Agent Loop + quilin-mem MCP + REPL baseline, v0.0.3. | `packages/agent-core/src/loop.ts` + `providers/memory/src/quilin_mem/server.py` |
| Iter A Grounded Context | closed | Context assembly, prompt builder, temporal awareness, memory bridge, v0.1.0-iter-a. | `docs/02-context/README.md` |
| Iter B Tools + Skills + Safety | closed | Tool substrate, READ-ONLY default safety policy, Skills M0/M1 activation. | `docs/05-tool/README.md` + `docs/13-skills/README.md` + `docs/07-safety-guardrails/README.md` |
| Iter C Planning Core | closed | Planning + inference strategy, completed alongside memory decoupling. | `docs/04-planning/README.md` |
| Iter M Memory | closed | Main quilin-mem slices completed; L3a observer remains blocked/deferred. | `docs/03-memory/README.md` |
| Iter D Operability | closed | Observability, config, scratchpad, Rust `mesh-sdk` stub, CI, and coverage gate. | `docs/08-observability/README.md` + `crates/mesh-sdk/Cargo.toml` |
| Iter E Benchmark Ascent | frozen / canceled | Existing code remains in-tree; all unfinished Benchmark planning and implementation work is canceled in Linear. | `docs/14-benchmark-harness/README.md` + `QUI-6` / `QUI-7` / `QUI-8` / `QUI-43` / `QUI-47` / `QUI-70` |
| Iter F Scale-Out | governed by local runtime evidence | Supervisor, Agent Mesh, memory depth, self-evolution, and Conversation Engineering must use local component gates first; no Benchmark code without explicit user request. | `docs/06-multi-agent/README.md` + `docs/11-agent-mesh/README.md` |

## 基准冻结 / Benchmark Freeze

The frozen Benchmark implementation surface is: dataset loading, runner/scorer/submission wiring, DockerSandbox slices, GAIA/BFCL/SWE-bench loaders, and memory-provider offline benchmark scripts. These are preserved as current code facts, not active work items.

已冻结的 Benchmark 实现面包括：数据集加载、runner/scorer/submission wiring、DockerSandbox 切片、GAIA/BFCL/SWE-bench loader，以及 memory provider 的离线 benchmark scripts。它们保留为当前代码事实，不再是活跃工作项。

| Unit | 状态 | 当前处理 | 证据 |
|---|---:|---|---|
| E1 Harness Infra | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E2 SWE-bench Verified + DockerSandbox | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3a GAIA validation loader/scorer | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3b BFCL AST slice | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3c1a BFCL multi-turn fixture | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3c1b1 BFCL stateful worker | `QUI-5` done; `QUI-6` canceled | No R2 or follow-up unless user asks. | `QUI-5` / `QUI-6` |
| E3c1b2 BFCL runner adapter | `QUI-7` canceled | Do not implement unless user asks. | `QUI-7` |
| Coding benchmark target | `QUI-47` / `QUI-70` canceled | Do not choose or implement replacement unless user asks. | `QUI-47` / `QUI-70` |
| E4 aspirational benchmarks | `QUI-8` canceled | Do not reassess unless user asks. | `QUI-8` |

## 2026-05-02 组件规划快照 / 2026-05-02 Component Planning Snapshot

The latest Linear migration and component planning sweep produced bilingual deferred-runtime plans across the main component families. The purpose of these files is to define runtime boundaries, trigger gates, and evidence requirements; they are not proof that every runtime path has landed.

最新一轮 Linear 迁移与组件规划整理，已经为主要组件族产出中英双语 deferred-runtime plans（延后运行时规划）。这些文件的用途是定义运行时边界、触发门槛和证据要求；它们不是所有运行时代码都已落地的证明。

Current planning artifacts include LLM provider production gates, Context relevance/compression gates, Memory observer and depth gates, Planning production routing gates, Tools runtime gates, Multi-Agent supervisor gates, Safety production threat-model gates, Observability trace/evaluation-data gates, Deployment runtime gates, Self-Evolution trajectory-to-patch gates, Agent Mesh deferred runtime gates, Skills runtime/platformization gates, Conversation Engineering restart gates, and the Iter F launch gate.

当前规划产物覆盖 LLM provider（模型供应商）生产门槛、Context（上下文）相关性/压缩门槛、Memory（记忆）观察器与深记忆门槛、Planning（规划）生产路由门槛、Tools（工具）运行时门槛、Multi-Agent（多 Agent）监督者门槛、Safety（安全）生产威胁模型门槛、Observability（可观测性）trace/evaluation-data（追踪/评估数据）门槛、Deployment（部署）运行时门槛、Self-Evolution（自进化）trajectory-to-patch（从运行轨迹生成补丁建议）门槛、Agent Mesh（Agent 互联）延后运行时门槛、Skills（技能）运行时/平台化门槛、Conversation Engineering（对话工程）重启门槛，以及 Iter F 启动门槛。

The cross-review posture is now: benchmark（standardized capability evaluation，标准化能力评测）is frozen for code work unless the user asks, and component readiness must be proven with local evidence first.

交叉复核口径现在是：除非用户明确要求，Benchmark 代码工作已冻结；组件就绪必须先用本地实证证明。

## 组件状态 / Component State

| 组件 | 状态 |
|---|---|
| [00 Core Loop](00-core-loop/README.md) | 自研 TS loop 体系 1,102 LOC；实时追加输入、`/resume` + `/resume latest` 会话恢复、auto-checkpoint recovery 已实现；hook 体系（onTurnComplete/onIdle/onToolResult/onAssistantMessage）完善。 |
| [01 LLM Integration](01-llm-integration/README.md) | AI SDK v6 client、`ThinkingMode`、provider-aware options、reasoning/tool stream extraction、cache usage basics 已实现；DeepSeek 全链路完整；Provider live matrix 已实现（API Key/OAuth 凭证状态，脱敏）；Anthropic/OpenAI/Gemini provider 均为 blocked/candidate。 |
| [02 Context](02-context/README.md) | Prompt/session assembly、token budgeting、temporal awareness、memory bridge、injection scanner、skills catalog/restore wiring、compression、cache stability、Conversation Engineering 6 层架构 + 7 种预设风格已实现。 |
| [03 Memory](03-memory/README.md) | quilin-mem MCP（断连自动重连）、四层 memory、SQLite/FTS5+Bun 内置后端、KG/vector retrieval hooks、profile store、scratchpad、consolidator auto_schedule、L3a observer（flash 驱动）激活、user.md 自动同步。 |
| [04 Planning](04-planning/README.md) | Main-LLM direct planning + audit/strategy contracts 已实现；tiny classifier 不是默认路径。 |
| [05 Tool](05-tool/README.md) | 10 built-in tools（file_read/write/list、shell_exec（sandbox auto/on/off）、web_fetch、skill_search（remote）、skill_view、skill_manage（merge）、image_describe、video_summarize、audio_transcribe、mcp_search）、MCP bridge、DockerSandbox（auto-detect + executeAuto）。 |
| [06 Multi-Agent](06-multi-agent/README.md) | InProcessSupervisorRuntime 已实现：子 Agent 生命周期（append/send/interrupt/pause/resume/cancel）、heartbeat/stale 检测、recovery context 保留、`/agents` REPL 展示；mesh 分布式是后续。 |
| [07 Safety Guardrails](07-safety-guardrails/README.md) | auto 默认模式（低中风险自动批）、`--yolo` 全自动、四级 WriteAuthority（auto/ask/yolo/read_only）、ActionVerifier、MetaVerifier、secret redaction、SSRF guard。 |
| [08 Observability](08-observability/README.md) | Span/Metrics/Logs、Prometheus、JSON file exporter、SQLite 持久化 observability DB、Web Dashboard（/dashboard HTML 看板 + Web Chat）、Control Plane API（/snapshot、/sessions、/traces）。 |
| [09 Deployment Runtime](09-deployment-runtime/README.md) | CLI（`quilin config show/set/service install`）、TOML config cascade、hot reload、first-run welcome、`/resume` + `/resume latest`、`/mcp`、systemd/launchd 开机自启、soul.md/user.md 配置文件。 |
| [10 Self-Evolution](10-self-evolution/README.md) | Trajectory store、failure analyzer、patch proposal、proposal store（approve/reject/apply）、offline optimizer（runOptimizationCycle）、idle runner（每日配额控制）、content hash 等已实现；完整 trajectory→patch→proposal 闭环已串联到 main loop。 |
| [11 Agent Mesh](11-agent-mesh/README.md) | Rust `crates/mesh-sdk` stub + CI wiring 已实现；runtime mesh 是 Iter F。 |
| [13 Skills](13-skills/README.md) | SKILL.md catalog、`skill_view`、CRUD + merge、guard、restore、watcher、`skill_search`（本地+远程 skills.sh）、provenance 签名验证已闭合到 M2。 |
| [14 Benchmark Harness](14-benchmark-harness/README.md) | Existing harness code remains in-tree; component is frozen/read-only for future implementation unless the user asks. |

## 任务追踪 / Task Tracking

Linear is the task-management source. Docs only keep current-state snapshots and architecture facts.

Linear 是任务管理源；docs 只保留状态快照与架构事实。

- Frozen Iter E: Linear project [Iter E 基准冲刺 / Benchmark Ascent](https://linear.app/quilin-agent/project/iter-e-benchmark-ascent-110aa1c9aae3) is canceled and low priority.
- 已冻结 Iter E：Linear project [Iter E 基准冲刺 / Benchmark Ascent](https://linear.app/quilin-agent/project/iter-e-benchmark-ascent-110aa1c9aae3) 已取消并降为低优先级。
- Runtime scale-out governance: Linear project [Iter F 规模化 / Scale-Out](https://linear.app/quilin-agent/project/iter-f-scale-out-8731e6ced529) remains the broad future lane, with Benchmark code frozen unless requested.
- Runtime scale-out 治理：Linear project [Iter F 规模化 / Scale-Out](https://linear.app/quilin-agent/project/iter-f-scale-out-8731e6ced529) 仍是宽泛后续通道；除非用户要求，Benchmark 代码冻结。
- Verification baseline: Linear project [验证基线：前沿证据包 / Verification Baseline: Frontier Evidence Pack](https://linear.app/quilin-agent/project/验证基线前沿证据包-verification-baseline-frontier-evidence-pack-6babd4eb3b39) is low priority while Benchmark lanes are frozen.
- 验证基线：Linear project [验证基线：前沿证据包 / Verification Baseline: Frontier Evidence Pack](https://linear.app/quilin-agent/project/验证基线前沿证据包-verification-baseline-frontier-evidence-pack-6babd4eb3b39) 在 Benchmark lane 冻结期间为低优先级。
- Execution logging discipline: Linear [QUI-78](https://linear.app/quilin-agent/issue/QUI-78/流程所有执行空闲探索与交叉-review-必须记录到-linear-require-linear-records-for-execution) requires main-agent and subagent implementation, research, review, and exploration work to be recorded in Linear first; research results must also land in relevant component docs.
- 执行记录纪律：Linear [QUI-78](https://linear.app/quilin-agent/issue/QUI-78/流程所有执行空闲探索与交叉-review-必须记录到-linear-require-linear-records-for-execution) 要求主 agent / subagent 的实现、调研、review、探索都先记录到 Linear；调研结果还要落到相关组件 docs。
- Linear free-plan budget discipline: the current Linear free plan allows at most 250 issues; follow-up sub-tasks, subagent logs, probes, and reviews should use comments on existing issues first. Do not bulk-create near 200 issues, and do not create new issues after 225 without explicit user approval.
- Linear 免费额度纪律：当前 Linear 免费版最多 250 个 issue；后续子任务、subagent 日志、调研记录和 review 优先写到已有 issue 的 comment，达到 200 个 issue 前不做批量新建，达到 225 个 issue 后未经用户明确批准不再新建。
- Component-level deferred work: Linear project [组件延后工作 / Component Deferred Work](https://linear.app/quilin-agent/project/component-deferred-work-922b3c51ce07)
- 组件级 deferred work：Linear project [组件延后工作 / Component Deferred Work](https://linear.app/quilin-agent/project/component-deferred-work-922b3c51ce07)
- Global future roadmap: Linear project [未来规划总览 / Global Roadmap](https://linear.app/quilin-agent/project/未来规划总览-global-roadmap-58896094ed5c)
- 全局未来规划：Linear project [未来规划总览 / Global Roadmap](https://linear.app/quilin-agent/project/未来规划总览-global-roadmap-58896094ed5c)
