# ADR-008: Observability Span Schema — Iter D Day 0 契约冻结

> **状态**: Proposed (Iter D Day 0 contract freeze)
> **日期**: 2026-04-25
> **决策者**: Quilin Agent 团队
> **前置**: [ADR-005](./adr-005-memory-contracts.md)（Memory Contracts）

---

## 1. 状态

Iter D 启动前，必须冻结 OpenTelemetry span 与结构化日志的 schema，作为 §08-observability 主轴落地、Iter E1 benchmark harness cost/latency tracking、以及 §03-memory event_log 关联 trace 的统一规范源。

`docs/planning/2026-04-25-01-iter-d-parallel-breakdown.md` 是执行清单；与本文档冲突时，以本文档为准。

本文不规定 exporter 实现细节，只冻结跨进程（TS agent-core ↔ Python providers/memory）必须对齐的 wire schema。

---

## 2. Context

Iter D §08 落地后，五层 span 会同时被 Newton 轨道（agent-core 埋点）与 Boyle 轨道（providers/memory event_log 关联 trace）写入；structured JSON log 也会同时来自 TS 与 Python 进程。任何 span 命名、attribute key、trace 传递格式的漂移都会破坏 exporter 解析与日志关联，且回退成本随写入面扩大。

风险来自三个方向：

1. **命名漂移**：TS 与 Python 在 attribute key 大小写、命名空间（`llm.tokens_input` vs `llm_tokens_input`）上分歧，导致 exporter 后处理需要做 ad-hoc 转换。
2. **Trace 传递断裂**：MCP stdio 是字节流，OTel propagation 默认依赖 HTTP header；不显式约定 metadata 字段就会丢 trace 上下文。
3. **Log 与 Span 解耦**：structured log 不带 `trace_id` / `span_id` 时无法回溯，调试回放与 Iter E1 benchmark trace 都会失效。

本 ADR 不冻结 §03-memory 的 `staleness` / `score` 等 metadata 字段（属 ADR-005 范畴），只冻结 observability 自身字段。

---

## 3. Decision

### 3.1 五层 Span 命名

冻结 span name 与父子关系：

| Span 名 | 父 Span | 生命周期 |
|---|---|---|
| `agent.session` | （root） | 一次 CLI 会话 |
| `agent.turn` | `agent.session` | 一轮用户输入到 Agent 输出 |
| `agent.state_node` | `agent.turn` | Planning state machine 单节点（`build_context` / `plan` / `execute` / `verify` / `reflect` / `decide`） |
| `llm.invoke` | `agent.state_node` | 单次 LLM API 调用 |
| `tool.invoke` | `agent.state_node` | 单次工具执行（含 `memory_*` MCP 调用） |

`state_node` 而非更短的 `node`，因为 Iter F Agent Mesh 会引入 mesh node / host node 概念，避免命名冲突。`llm.invoke` / `tool.invoke` 不加 `agent.` 前缀，因其已挂在 `agent.state_node` 下，重复父级语义无信息增益；后续若对齐 OTel GenAI Development conventions（仍 Development 状态），通过追加 `gen_ai.operation.name` / `gen_ai.tool.name` 等兼容 attribute 实现，不变更内部 span name。

不允许新增第六层 span 直接挂在以上五层之外；子工具执行（如浏览器子动作）作为 `tool.invoke` 的内部事件，不另起 span。

### 3.2 Attribute Key 命名规范

- 命名空间分隔符为 `.`，全小写 snake_case：`llm.tokens_input`、`tool.success`。
- 数值字段必须带单位后缀：`*_ms`（毫秒）、`*_bytes`（字节）、`*_usd`（美元）、`*_tokens`（token 数）。
- 枚举字段（如 `llm.thinking_mode`）必须在本 ADR §3.3 表中显式列出允许值；新增允许值需修订 ADR。
- 敏感字段（参数、Prompt、用户输入）只允许写入到 `*.params_summary` 或 `*.user_input_redacted`，原文必须经 redactor 处理。

### 3.3 必备 Attributes（最小集）

`agent.session`：
`session.id` / `session.user_id` / `session.task_summary` / `session.turn_count` / `session.total_cost_usd` / `session.total_tokens`

`agent.turn`：
`turn.id` / `turn.index` / `turn.user_input_redacted` / `turn.replanning_count` / `turn.cost_usd` / `turn.success`

`agent.state_node`：
`state_node.name`（枚举：`build_context | plan | execute | verify | reflect | decide`）/ `state_node.duration_ms`

`llm.invoke`：
`llm.model` / `llm.provider` / `llm.tokens_input` / `llm.tokens_output` / `llm.tokens_thinking` / `llm.thinking_mode`（枚举：`off | standard | preserved`）/ `llm.cost_usd` / `llm.time_to_first_token_ms` / `llm.total_latency_ms`

`tool.invoke`：
`tool.name` / `tool.params_summary` / `tool.duration_ms` / `tool.success` / `tool.result_size_bytes` / `tool.error_type`（仅失败时）

可选字段允许追加；新增 required 字段必须升级本 ADR。

### 3.4 Trace Context 跨进程传递

MCP stdio 调用必须在 request 与 response envelope 的 `metadata` 字段携带 W3C Trace Context：

| 字段 | 类型 | 说明 |
|---|---|---|
| `metadata.traceparent` | string | W3C `traceparent` header 原值（`00-<trace_id>-<span_id>-<flags>`） |
| `metadata.tracestate` | string? | W3C `tracestate` 可选 |
| `metadata.request_id` | string | Quilin 内部统一 request id，跨整轮调用链 |

`request_id` 由 `agent.turn` 生成，贯穿到本轮所有 LLM/Tool/MCP 调用；`trace_id` 由 OTel SDK 生成，用于追踪关联。`request_id` 不替代 `trace_id`，两者并存：`request_id` 用于业务级关联（成本归属、用户请求溯源），`trace_id` 用于 OTel 标准追踪。

Python providers/memory 在收到 MCP request 时必须从 `metadata.traceparent` 还原 OTel context，写入 event_log 与本侧 span；response 必须回写本侧 span 的 `traceparent`。Python 侧的 span 命名遵循同一规范（必要时用 `tool.invoke` 子 span 包裹本侧操作）。

### 3.5 Structured JSON Log Schema

所有组件写出的 JSON log 必须包含：

| 字段 | 必填 | 说明 |
|---|---|---|
| `timestamp` | 是 | ISO 8601 with milliseconds + `Z` 后缀（UTC） |
| `level` | 是 | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `component` | 是 | 组件名（如 `agent-core.planning.executor`、`omnimem.store`） |
| `event` | 是 | snake_case 事件名（如 `tool_execution`、`checkpoint_saved`） |
| `trace_id` | 是 | 32-char hex（无 trace 时填 `"-"`） |
| `span_id` | 是 | 16-char hex（无 span 时填 `"-"`） |
| `request_id` | 是 | Quilin request id（无时填 `"-"`） |
| `session_id` | 否 | 当前 session（如有） |
| `turn_id` | 否 | 当前 turn（如有） |
| `data` | 否 | 自由 object，承载事件 payload |

输出目标统一为 stdout（`docs/adr/adr-002-project-skeleton.md` §7 既有约定），不得输出到 stderr 或自定义文件路径。

### 3.6 Exporter 最低实现

Iter D 内置必须支持：

- `json_file_exporter`：写 `.logs/traces-*.jsonl`，零配置默认开启。
- `composite_exporter`：组合多个 exporter 同时输出。

Langfuse / Jaeger / Prometheus 等 exporter 留 hook，本 Iter 不强制实现。

---

## 4. Consequences

### 正向后果

- TS / Python / 未来 Rust 进程产生的 span 与 log 可被同一 exporter 解析。
- Iter E1 benchmark harness 可基于 `agent.turn.cost_usd` / `llm.tokens_*` 自动收集 cost/latency 指标。
- §03-memory event_log 可借 `trace_id` 与外部 OTel 追踪关联，不需要单独的 trace store。
- Structured log 与 span 双向 lookup 可行（任一边都能拿到 `trace_id` + `span_id`）。

### 约束

- Span name、attribute key、log schema 字段属于硬契约，破坏性变更必须升级本 ADR。
- 敏感字段写入必须经 redactor；本 ADR 不规定 redactor 实现，只规定 attribute 命名（`*.params_summary` / `*.user_input_redacted`）。
- exporter 不允许在 attribute key 上做 ad-hoc 重命名，必须以本 ADR 为单一源。

### 后续工作

- Newton 轨道：`packages/agent-core` 实现 `OTelSpanProvider`，按 §3.1-3.3 埋点；Python `providers/memory` 增加 trace context ingest。
- Boyle 轨道：providers/memory `event_log` 增加 `trace_id` / `request_id` 列，关联本 ADR。
- Newton 轨道：内置 `json_file_exporter` + `composite_exporter`。
- Iter E1 恢复时，benchmark harness 直接消费本 schema 输出。

---

## 5. References

- [Iter D 并行任务拆分](../planning/2026-04-25-01-iter-d-parallel-breakdown.md) — Day 0 契约冻结、Newton/Kelvin/Boyle/Curie 轨道
- [ADR-002 Project Skeleton](./adr-002-project-skeleton.md) — §7 三语言 stdout JSON 日志统一约定
- [ADR-005 Memory Contracts](./adr-005-memory-contracts.md) — MCP `metadata` 字段已有保留
- [08-observability](../engineering/08-observability/README.md) — §2.2 五层 span 设计、§2.3 metrics、§2.4 JSON 日志格式
- [00-implementation-plan](../planning/00-implementation-plan.md) — Iter D 范围、Iter E1 cost/latency tracking 依赖
