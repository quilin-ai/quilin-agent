# 核心循环 / Core Loop

> Quilin 全局架构、运行时切分和 docs 规则的当前真相源。全局进度见
> [STATUS.md](../STATUS.md)。
>
> **关联 Linear**：[QUI-100](https://linear.app/quilin-agent/issue/QUI-100/main-loop主-agent-实时追加输入与运行中重定向)（main loop 实时追加输入，✅ 已实现）、[QUI-83](https://linear.app/quilin-agent/issue/QUI-83/梳理-quilin-agent-能力边界与热更新记忆mcp-统一规划)（能力边界与统一规划）。

## 当前状态 / Current State

Quilin uses a custom TypeScript Agent Loop instead of LangGraph or another external Agent framework. The loop system spans three files: `loop.ts` (452 LOC) + `loop-tool-calls.ts` (565 LOC) + `loop-types.ts` (85 LOC) = 1,102 LOC, having grown beyond the original `<200 LOC` contract as the system matured.

Quilin 使用自研 TypeScript Agent Loop，不使用 LangGraph 或其他外部 Agent 框架。循环体系横跨三个文件：`loop.ts` (452 行) + `loop-tool-calls.ts` (565 行) + `loop-types.ts` (85 行) = 1,102 行，已随系统成熟超出最初的 `<200 LOC` 契约。

The current runtime split is:

当前运行时切分是：

- **TypeScript**：agent core、loop、context、tools、planning、skills、safety；existing benchmark adapters are frozen code facts, not active roadmap scope.
- **Python**：ML-heavy providers，例如 quilin-mem MCP；existing benchmark worker scripts are frozen code facts, not active roadmap scope.
- **Rust**：仅 Iter D `crates/mesh-sdk` stub；mesh/WASM runtime 延期到 Iter F。

## 架构 / Architecture

The core loop owns message state, LLM streaming, tool dispatch, and checkpoints. Memory, tools, planning, safety, observability, skills, and mesh are exposed as surrounding loop capabilities rather than fixed LangGraph nodes.

Core loop 负责 message state（消息状态）、LLM streaming（模型流式输出）、tool dispatch（工具派发）和 checkpoint（检查点）。Memory、tools、planning、safety、observability、skills、mesh 都作为 loop 周边能力暴露，而不是固定 LangGraph 节点。

Current component README files:

当前组件 README 文件：

- [01 LLM Integration](../01-llm-integration/README.md)
- [02 Context](../02-context/README.md)
- [03 Memory](../03-memory/README.md)
- [04 Planning](../04-planning/README.md)
- [05 Tool](../05-tool/README.md)
- [06 Multi-Agent](../06-multi-agent/README.md)
- [07 Safety Guardrails](../07-safety-guardrails/README.md)
- [08 Observability](../08-observability/README.md)
- [09 Deployment Runtime](../09-deployment-runtime/README.md)
- [10 Self-Evolution](../10-self-evolution/README.md)
- [11 Agent Mesh](../11-agent-mesh/README.md)
- [13 Skills](../13-skills/README.md)
- [14 Benchmark Harness](../14-benchmark-harness/README.md)

## 深入文档 / Deep-Dive Docs

- [intelligence-roadmap.md](./intelligence-roadmap.md) — Master index that maps the **10 puzzle pieces of "Claude-Code-level intelligence"** onto Quilin's domains, current state, gaps, and owning Linear iteration. Start here when planning any harness-engineering work. / 主索引：把"Claude Code 级智能感"的 10 块拼图映射到 Quilin 各领域、当前状态、差距、归属的 Linear iteration。规划任何 harness 工程改动从这里开始。
- [reactive-execution.md](./reactive-execution.md) — Iter L: Core Loop's adaptive-execution model: foreground/background dispatch, observation-driven anomaly detection, fallback ladders, and the boundary between Loop's tactical decisions vs Planner's strategic re-plan. / Core Loop 的自适应执行模型。
- [eval-driven-development.md](./eval-driven-development.md) — Iter L+0: lightweight self-owned trace-eval layer; **prerequisite gate** for all subsequent harness changes. Six core metrics, trace catalog, runner, CI hook. / 轻量自有 trace eval 层；后续所有 harness 改动的合入闸门。
- [`../05-tool/tool-taste.md`](../05-tool/tool-taste.md) — Iter L+1: marketing-style descriptors, lint, subagent capability advertisement, tool selection trace. / 工具品味：卖货式 descriptor、lint、subagent 能力宣传、工具选择 trace。
- [`../02-context/auto-context-curation.md`](../02-context/auto-context-curation.md) — Iter L+2: trigger table for what context to auto-load when, relevance matching, staleness detection. / 上下文自动装配：什么时候 load 哪些 context 的策略表、相关性匹配、失效检测。

## 决策 / Decisions

- 不用 LangGraph；核心循环保持自研、小而可审计。
- AI SDK v6 是 TypeScript LLM 抽象层。
- MCP stdio 是 TS-Python ML provider 桥。
- 仓库是事实源：当前文档写在 `docs/STATUS.md` 和组件 README；历史快照通过 git history 追溯。
- Idle/self-evolution 写入不能自动 apply；scaffold 变更必须 human review。
- 默认 trust 是 READ-ONLY；`AUTO` 必须每 session 显式 opt-in。
- Linear 是任务 / backlog / phase tracking 源；docs 只保留当前状态快照与架构事实。
- Benchmark 是全项目最低优先级；Iter E 已冻结/取消，除非用户明确要求，任何 Iter 都不得新增或修改 Benchmark 代码。

## 文档规则 / Documentation Rules

- 本 README 只保留当前架构，不写 phase 叙事。
- 未来跨组件决策先落到 owning component README；不新增档案目录。
- 不恢复顶层 `planning/`、`iterations/`、`adr/`、`architecture/`、`research/`、`review/` 目录。
