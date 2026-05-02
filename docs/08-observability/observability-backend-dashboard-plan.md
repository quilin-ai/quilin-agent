# 可观测后端与仪表盘实现规划 / Observability Backend and Dashboard Implementation Plan

English: This document is the implementation plan for Linear `QUI-20`（the existing issue for Observability metrics exporter, dashboard, and trace backend work）. It synthesizes `docs/08-observability/observability-core-loop-frontier.md` and `docs/08-observability/core-loop-observability-implementation-plan.md`.

中文：本文档是 Linear `QUI-20`（现有 Observability 指标导出器、仪表盘和追踪后端任务）的实现规划。它综合 `docs/08-observability/observability-core-loop-frontier.md` 与 `docs/08-observability/core-loop-observability-implementation-plan.md`。

English: `docs/08-observability/trace-to-eval-verification-plan.md` was checked during this planning pass and does not exist yet. This plan therefore treats `TraceExampleEnvelope`（轨迹样本信封，用来把一次运行的追踪转成后续评测样本）as an input contract from `QUI-66` and maps verification ownership to `QUI-75`.

中文：本次规划已检查 `docs/08-observability/trace-to-eval-verification-plan.md`，该文件目前不存在。因此本规划把 `TraceExampleEnvelope`（轨迹样本信封，用来把一次运行的追踪转成后续评测样本）视为 `QUI-66` 的输入契约，并把验证责任映射到 `QUI-75`。

English: The scope is implementation planning only. It does not start benchmark（基准测试，用来评估整体能力的测试集合）execution, does not add new Linear issues, and does not modify `agent-bridge.md`.

中文：本文范围仅限实现规划。它不启动 benchmark（基准测试，用来评估整体能力的测试集合）执行，不新增 Linear issue，也不修改 `agent-bridge.md`。

## 一、目标 / Goals

English: `QUI-20` turns Core Loop observability contracts into an operator-facing system. The system must collect the stable events from `QUI-66`, export them through OpenTelemetry SDK（开放遥测软件开发工具包，用来生成、处理和导出 trace/metric/log 遥测信号）, keep a deterministic JSON（JavaScript Object Notation，一种结构化文本数据格式）fallback（本地逐行 JSON 后备，用来在没有遥测后端时保存可审计事件）, store runtime traces for dashboard queries, and explain failed or degraded runs.

中文：`QUI-20` 要把 `QUI-66` 的 Core Loop 可观测性契约转成面向操作者的系统。该系统必须采集 `QUI-66` 的稳定事件，通过 OpenTelemetry SDK（开放遥测软件开发工具包，用来生成、处理和导出 trace/metric/log 遥测信号）导出，保留确定性的 JSON（JavaScript Object Notation，一种结构化文本数据格式）fallback（本地逐行 JSON 后备，用来在没有遥测后端时保存可审计事件），为仪表盘查询保存运行时追踪，并解释失败或降级运行。

English: The implementation should preserve Quilin's minimal Core Loop（核心循环，负责消息、模型、工具和检查点流转的最小执行循环）. The loop emits `LoopStepEvent`（循环步骤事件，用来描述模型、工具、检查点、中断、恢复和停止步骤）and `LoopStopState`（循环终止状态，用来统一成功、暂停、失败和取消结果）; the observability layer performs mapping, export, storage, and dashboard rendering outside the loop.

中文：实现应保持 Quilin 的极简 Core Loop（核心循环，负责消息、模型、工具和检查点流转的最小执行循环）。循环只发出 `LoopStepEvent`（循环步骤事件，用来描述模型、工具、检查点、中断、恢复和停止步骤）与 `LoopStopState`（循环终止状态，用来统一成功、暂停、失败和取消结果）；可观测层在循环之外完成映射、导出、存储和仪表盘渲染。

## 二、输入契约 / Input Contracts

English: `QUI-66` owns `LoopStepEvent`, `LoopStopState`, `LoopInterruptPayload`（循环中断载荷，用来描述暂停原因和恢复要求）, `LoopResumePayload`（循环恢复载荷，用来描述从哪个检查点继续）, `RedactionPolicy`（脱敏策略，用来控制可观测数据可保留的内容级别）, and `TraceExampleEnvelope`.

中文：`QUI-66` 负责 `LoopStepEvent`、`LoopStopState`、`LoopInterruptPayload`（循环中断载荷，用来描述暂停原因和恢复要求）、`LoopResumePayload`（循环恢复载荷，用来描述从哪个检查点继续）、`RedactionPolicy`（脱敏策略，用来控制可观测数据可保留的内容级别）和 `TraceExampleEnvelope`。

English: `QUI-20` consumes those contracts but should not redefine them. If dashboard or backend work needs an additional field, the change should be proposed back to `QUI-66` rather than patched only inside the exporter.

中文：`QUI-20` 消费这些契约，但不应重新定义它们。如果仪表盘或后端工作需要新增字段，应把变更提回 `QUI-66`，而不是只在导出器内部临时补丁化。

English: Vercel AI SDK（Vercel 的人工智能软件开发工具包，Quilin 用它抽象模型供应商）telemetry（遥测能力，用来接收模型生成生命周期事件）should feed the same event stream. The AI SDK can provide OpenTelemetry-compatible tracer hooks, lifecycle integrations, token usage, finish reasons, and error context, but Quilin's internal event schema remains the source of truth.

中文：Vercel AI SDK（Vercel 的人工智能软件开发工具包，Quilin 用它抽象模型供应商）telemetry（遥测能力，用来接收模型生成生命周期事件）应汇入同一条事件流。AI SDK 可以提供兼容 OpenTelemetry 的 tracer 钩子、生命周期集成、token 使用、结束原因和错误上下文，但 Quilin 内部事件 schema 仍是真相源。

## 三、总体架构 / Overall Architecture

English: The data path is: Core Loop emits stable events; `ObservabilityRuntime`（可观测运行时，用来接收内部事件并分发到导出器和存储） applies redaction and sampling; `OpenTelemetryMapper`（开放遥测映射器，用来把 Quilin 事件转成 OpenTelemetry 语义） creates spans, metrics, and logs; exporters send data to OTLP exporter（OpenTelemetry Protocol 导出器，用来把遥测数据发送到采集器或后端） and JSON fallback; `TraceBackend`（追踪后端，用来查询和保留运行记录） serves WebUI Dashboard（网页仪表盘，用来展示运行状态和诊断信息） queries.

中文：数据路径是：Core Loop 发出稳定事件；`ObservabilityRuntime`（可观测运行时，用来接收内部事件并分发到导出器和存储）应用脱敏与采样；`OpenTelemetryMapper`（开放遥测映射器，用来把 Quilin 事件转成 OpenTelemetry 语义）创建 span、metric 和 log；导出器把数据发送到 OTLP exporter（OpenTelemetry Protocol 导出器，用来把遥测数据发送到采集器或后端）和 JSON fallback；`TraceBackend`（追踪后端，用来查询和保留运行记录）服务 WebUI Dashboard（网页仪表盘，用来展示运行状态和诊断信息）查询。

English: The runtime should support three operating modes. `local_json` writes only deterministic JSON lines. `otel_collector` writes JSON lines and sends OTLP to an OpenTelemetry Collector（开放遥测采集器，用来接收、处理和转发遥测数据）. `backend_plus_dashboard` writes JSON lines, sends OTLP, and also stores dashboard-friendly summaries in the local trace backend.

中文：运行时应支持三种模式。`local_json` 只写确定性的逐行 JSON。`otel_collector` 写逐行 JSON，并通过 OTLP 发送到 OpenTelemetry Collector（开放遥测采集器，用来接收、处理和转发遥测数据）。`backend_plus_dashboard` 写逐行 JSON、发送 OTLP，并把适合仪表盘查询的摘要保存到本地追踪后端。

English: The first production-capable slice should use local storage as the primary dashboard query source and OTLP as the integration path. This avoids making the WebUI depend on a specific vendor backend while still allowing Phoenix, Langfuse, Jaeger, Grafana Tempo, or another OpenTelemetry-compatible backend to receive traces.

中文：第一版具备生产能力的切片应把本地存储作为仪表盘主要查询源，把 OTLP 作为集成路径。这样 WebUI 不依赖特定供应商后端，同时仍允许 Phoenix、Langfuse、Jaeger、Grafana Tempo 或其他兼容 OpenTelemetry 的后端接收追踪。

## 四、OpenTelemetry SDK 集成 / OpenTelemetry SDK Integration

English: The TypeScript runtime should initialize OpenTelemetry through a small `createTelemetrySdk` boundary. That boundary configures resource attributes such as `service.name`, `service.version`, `deployment.environment`, and `quilin.component`, then returns tracer, meter, logger, and shutdown handles to the observability layer.

中文：TypeScript 运行时应通过一个小型 `createTelemetrySdk` 边界初始化 OpenTelemetry。该边界配置 `service.name`、`service.version`、`deployment.environment` 和 `quilin.component` 等资源属性，然后把 tracer、meter、logger 和 shutdown 句柄返回给可观测层。

English: The Core Loop must not import OpenTelemetry SDK types directly. It should depend only on a local `ObservabilitySink`（可观测接收接口，用来接收运行事件） interface so tests can run with an in-memory sink and production can use OpenTelemetry-backed exporters.

中文：Core Loop 不得直接 import OpenTelemetry SDK 类型。它只应依赖本地 `ObservabilitySink`（可观测接收接口，用来接收运行事件）接口，这样测试可使用内存接收器，生产可使用 OpenTelemetry 支撑的导出器。

English: The mapper should use OpenTelemetry GenAI semantic conventions（OpenTelemetry 生成式 AI 语义规范，用来统一模型调用、工具调用、token 和延迟字段） where stable enough, but keep a versioned Quilin namespace for fields that are not covered yet. Current official GenAI spans and metrics are marked Development, so the mapper must isolate field changes.

中文：映射器应尽量使用 OpenTelemetry GenAI semantic conventions（OpenTelemetry 生成式 AI 语义规范，用来统一模型调用、工具调用、token 和延迟字段），但对尚未覆盖的字段保留带版本的 Quilin 命名空间。当前官方 GenAI spans 和 metrics 仍标记为 Development，所以映射器必须隔离字段变化。

English: AI SDK telemetry should be integrated by passing Quilin's tracer or a telemetry integration into model calls, then normalizing provider-specific lifecycle data into `LoopStepEvent`. Errors inside telemetry integrations must be captured as observability errors and must not break model generation.

中文：AI SDK 遥测应通过向模型调用传入 Quilin 的 tracer 或 telemetry integration（遥测集成，用来接收生成生命周期事件）接入，然后把供应商特定生命周期数据归一化成 `LoopStepEvent`。遥测集成内部错误必须作为可观测错误记录，不能打断模型生成。

## 五、导出器 / Exporters

English: The exporter interface should receive already-redacted internal events and produce three signal families: traces（追踪，用来串联一次运行的分布式执行路径）, metrics（指标，用来聚合数值化运行状态）, and logs（日志，用来记录结构化事件与错误）。The interface should return structured export results rather than throwing for expected collector or filesystem failures.

中文：导出器接口应接收已经脱敏的内部事件，并产生三类信号：traces（追踪，用来串联一次运行的分布式执行路径）、metrics（指标，用来聚合数值化运行状态）和 logs（日志，用来记录结构化事件与错误）。接口应返回结构化导出结果，而不是对可预期的采集器或文件系统失败直接抛错。

```ts
interface ObservabilityExporter {
  readonly name: string;
  exportBatch(batch: ObservabilityBatch): Promise<ExportBatchResult>;
  shutdown(): Promise<void>;
}

interface ExportBatchResult {
  readonly exporter: string;
  readonly acceptedEventIds: readonly string[];
  readonly rejectedEventIds: readonly string[];
  readonly retryableEventIds: readonly string[];
  readonly droppedEventIds: readonly string[];
  readonly warning?: string;
  readonly errorCode?: string;
}
```

English: The JSON fallback exporter writes one record per line with deterministic key order, schema version, event ID, run ID, event sequence, redaction policy, and selected span references. It is the local audit trail and the fixture source for `QUI-75`.

中文：JSON fallback 导出器以确定性键顺序逐行写入记录，包含 schema 版本、事件 ID、运行 ID、事件序号、脱敏策略和被选择的 span 引用。它是本地审计链，也是 `QUI-75` 的夹具来源。

English: The OTLP exporter should support OTLP/HTTP（基于 HTTP 的 OpenTelemetry Protocol 传输，适合本地和容器环境调试） first because it is easier to operate locally and in dev containers. OTLP/gRPC（基于 gRPC 的 OpenTelemetry Protocol 传输，适合高吞吐或特定后端兼容场景） can follow if performance or backend compatibility requires it.

中文：OTLP 导出器应先支持 OTLP/HTTP（基于 HTTP 的 OpenTelemetry Protocol 传输，适合本地和容器环境调试），因为它更容易在本地和 dev container（开发容器）中运行。只有当性能或后端兼容性需要时，再补 OTLP/gRPC（基于 gRPC 的 OpenTelemetry Protocol 传输，适合高吞吐或特定后端兼容场景）。

English: OTLP partial success（部分成功，指采集器只接受一部分数据） handling is mandatory. If a collector rejects some spans, data points, or log records, the exporter must record rejected counts, affected event IDs when known, and the non-retry decision required by the OTLP specification.

中文：OTLP partial success（部分成功，指采集器只接受一部分数据）处理是强制要求。如果采集器拒绝部分 span、data point 或 log record，导出器必须记录拒绝数量、已知时的受影响事件 ID，以及 OTLP 规范要求的不可重试决策。

## 六、追踪后端 / Trace Backend

English: The first `TraceBackend` should be local-first and queryable without a cloud dependency. It should store run summaries, step summaries, stop states, failure explanations, metric rollups, and links to JSON fallback records.

中文：第一版 `TraceBackend` 应本地优先，并且不依赖云服务即可查询。它应保存运行摘要、步骤摘要、终止状态、失败解释、指标汇总，以及指向 JSON fallback 记录的链接。

English: The backend can start as file-backed or SQLite（嵌入式关系型数据库，适合本地可查询存储）-backed storage. File-backed storage is simpler and matches current JSON fixtures; SQLite-backed storage gives better dashboard filtering by run ID, status, tool name, model, error class, and time range. The implementation decision should be made when `QUI-20` enters coding, based on existing repo dependencies and test friction.

中文：后端可以从文件存储或 SQLite（嵌入式关系型数据库，适合本地可查询存储）存储开始。文件存储更简单，并且贴近当前 JSON 夹具；SQLite 存储更适合仪表盘按运行 ID、状态、工具名、模型、错误类别和时间范围过滤。`QUI-20` 进入编码时，应根据仓库已有依赖和测试成本做实现决策。

English: Trace retention must be explicit. The default should keep metadata and summaries longer than content-bearing records, because model prompts, tool results, shell output, and file paths can contain sensitive information.

中文：追踪保留策略必须显式。默认应让元数据和摘要保存时间长于包含内容的记录，因为模型 prompt、工具结果、shell 输出和文件路径可能包含敏感信息。

English: The backend must preserve enough identity to correlate WebUI views, JSON fallback records, OTLP spans, and trace-to-eval examples. Required IDs are `runId`, `sessionId`, `eventId`, `eventSeq`, `traceId`, `spanId`, `checkpointRef`, and Linear issue references where present.

中文：后端必须保留足够身份信息，以关联 WebUI 视图、JSON fallback 记录、OTLP span 和 trace-to-eval 样本。必需 ID 包括 `runId`、`sessionId`、`eventId`、`eventSeq`、`traceId`、`spanId`、`checkpointRef`，以及存在时的 Linear issue 引用。

## 七、指标导出 / Metrics Export

English: The metric set should be small, stable, and directly useful for operations. Avoid high-cardinality labels（高基数字段，指取值非常多、会让指标系统膨胀的标签） such as raw prompt text, full file paths, full tool arguments, or per-token values.

中文：指标集合应小、稳定，并且直接服务运行维护。避免高基数字段（高基数字段，指取值非常多、会让指标系统膨胀的标签），例如原始 prompt 文本、完整文件路径、完整工具参数或逐 token 值。

| Metric | Type | Required labels | Purpose |
| --- | --- | --- | --- |
| `quilin_run_total` | Counter | `stop_category`, `stop_reason`, `component` | Count completed, paused, failed, and cancelled runs. |
| `quilin_run_duration_ms` | Histogram | `stop_category`, `component` | Track end-to-end runtime duration. |
| `quilin_loop_step_total` | Counter | `kind`, `status`, `component` | Count model, tool, checkpoint, interrupt, resume, and stop events. |
| `quilin_model_tokens_total` | Counter | `provider`, `model`, `direction` | Track input/output token usage after provider normalization. |
| `quilin_model_latency_ms` | Histogram | `provider`, `model`, `operation` | Track model latency and time-to-first-token. |
| `quilin_tool_duration_ms` | Histogram | `tool_type`, `tool_name_hash`, `status` | Track tool runtime without leaking raw names when policy requires hashing. |
| `quilin_checkpoint_total` | Counter | `status`, `terminal`, `resumable` | Track checkpoint writes and lifecycle boundaries. |
| `quilin_export_total` | Counter | `exporter`, `result` | Track accepted, rejected, retryable, and dropped export records. |
| `quilin_redaction_total` | Counter | `level`, `rule` | Track redaction decisions without exposing redacted content. |

English: The metric exporter should emit OpenTelemetry metrics and also include a JSON fallback summary per run. The JSON summary makes local tests deterministic and lets the dashboard work before a metrics backend is configured.

中文：指标导出器应发出 OpenTelemetry metrics，同时为每次运行写入 JSON fallback 摘要。JSON 摘要让本地测试保持确定性，并使仪表盘在未配置指标后端时也能工作。

## 八、WebUI Dashboard 界面 / WebUI Dashboard Surfaces

English: The first dashboard should be operational, not decorative. It should answer: what is running, what stopped, why it stopped, what is waiting for approval, what failed, how expensive it was, and where to inspect the trace.

中文：第一版仪表盘应服务运行维护，而不是装饰性展示。它应该回答：什么正在运行、什么已停止、为什么停止、什么正在等待审批、什么失败了、成本如何，以及在哪里检查追踪。

English: Required surfaces are `Runs`（运行列表，用来查看所有运行状态）, `Run Detail`（运行详情，用来查看时间线、span、检查点和终止状态）, `Approvals`（审批视图，用来查看等待人工输入或写入许可的暂停点）, `Failures`（失败视图，用来聚合错误类别和复现入口）, `Metrics`（指标视图，用来查看延迟、token、导出失败和 checkpoint 指标）, and `Trace Export`（追踪导出视图，用来打开 JSON fallback 或外部 OTLP 后端链接）.

中文：必需界面包括 `Runs`（运行列表，用来查看所有运行状态）、`Run Detail`（运行详情，用来查看时间线、span、检查点和终止状态）、`Approvals`（审批视图，用来查看等待人工输入或写入许可的暂停点）、`Failures`（失败视图，用来聚合错误类别和复现入口）、`Metrics`（指标视图，用来查看延迟、token、导出失败和 checkpoint 指标）和 `Trace Export`（追踪导出视图，用来打开 JSON fallback 或外部 OTLP 后端链接）。

English: The run detail timeline should render `LoopStepEvent` by event sequence, not by wall-clock order alone. Wall-clock timestamps can drift across resumed sessions, while `eventSeq` preserves replay order.

中文：运行详情时间线应按 `LoopStepEvent` 的 event sequence（事件序号）渲染，而不能只按墙钟时间排序。跨恢复会话时墙钟时间可能漂移，而 `eventSeq` 能保留回放顺序。

English: The dashboard must expose operator-facing runtime traces（面向操作者的运行时追踪，用来让人快速理解系统执行了什么和卡在哪里） with safe defaults: metadata-only view first, explicit expansion for redacted snippets, and no full-content display unless the trace policy permits it.

中文：仪表盘必须提供 operator-facing runtime traces（面向操作者的运行时追踪，用来让人快速理解系统执行了什么和卡在哪里），并使用安全默认值：先展示仅元数据视图，脱敏片段需要显式展开，除非追踪策略允许，否则不展示完整内容。

## 九、失败解释能力 / Failure Explanation

English: Failure explanation should be generated from structured facts, not from raw log summarization. The explanation input is `LoopStopState`, failed `LoopStepEvent`, exporter result, checkpoint reference, retry/idempotency metadata, redaction policy, and the last successful parent step.

中文：失败解释应来自结构化事实，而不是对原始日志做自由摘要。解释输入包括 `LoopStopState`、失败的 `LoopStepEvent`、导出器结果、检查点引用、重试/幂等元数据、脱敏策略和最后一个成功的父步骤。

```ts
interface FailureExplanation {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly stopState: LoopStopState;
  readonly failedStepId?: string;
  readonly userFacingSummary: string;
  readonly operatorSummary: string;
  readonly likelyCause: string;
  readonly retrySafety: "safe" | "requires_review" | "unsafe";
  readonly nextActions: readonly string[];
  readonly evidenceRefs: readonly string[];
}
```

English: The first version should use deterministic rules. For example, `checkpoint_error` points to storage health and retry safety; `blocked_by_guardrail` points to the safety policy record; `observability_export_error` points to exporter configuration while preserving the original run result.

中文：第一版应使用确定性规则。例如，`checkpoint_error` 指向存储健康与重试安全；`blocked_by_guardrail` 指向安全策略记录；`observability_export_error` 指向导出器配置，同时保留原始运行结果。

English: LLM-based explanation can be added later as an optional assistant, but it must cite structured evidence references and must not override the deterministic stop state.

中文：后续可以增加基于 LLM（大型语言模型）的可选解释助手，但它必须引用结构化证据，并且不能覆盖确定性的终止状态。

## 十、脱敏与采样 / Redaction and Sampling

English: `metadata_only` is the default redaction level. It records identifiers, timing, token counts, error classes, status, model names, provider names, checkpoint references, and content hashes, but not raw prompts, raw tool output, credentials, environment values, or file contents.

中文：`metadata_only` 是默认脱敏级别。它记录标识符、时间、token 数、错误类别、状态、模型名、供应商名、检查点引用和内容哈希，但不记录原始 prompt、原始工具输出、凭证、环境变量值或文件内容。

English: Sampling（采样，用来控制哪些遥测记录被保留或导出） must preserve all failures, pauses, guardrail blocks, checkpoint errors, export errors, and user-visible final states. Success traces may be sampled by rate, but their metric rollups should still be emitted.

中文：Sampling（采样，用来控制哪些遥测记录被保留或导出）必须保留所有失败、暂停、安全护栏阻断、检查点错误、导出错误和用户可见最终状态。成功 trace 可以按比例采样，但它们的指标汇总仍应发出。

English: The exporter should apply redaction before both JSON fallback and OTLP export. A bug in one exporter must not create an unredacted side channel through the other exporter.

中文：导出器应在 JSON fallback 和 OTLP 导出之前完成脱敏。某个导出器里的 bug 不应通过另一个导出器形成未脱敏旁路。

English: Content-bearing traces need shorter retention and explicit opt-in. Background sub-agent exploration, idle evolution, and competitor issue research should stay metadata-only unless the user explicitly enables richer capture for a bounded session.

中文：包含内容的 trace 需要更短保留时间和显式 opt-in。后台 sub-agent 探索、空闲自进化和竞品 issue 调研默认应保持 metadata-only，除非用户为有边界的 session 明确启用更丰富的内容采集。

## 十一、实现切片 / Implementation Slices

English: Slice 1 defines interfaces and configuration: `ObservabilitySink`, `ObservabilityRuntime`, `ObservabilityExporter`, `TraceBackend`, dashboard query DTOs（数据传输对象，用来稳定前后端接口）, and runtime config for local JSON, OTLP endpoint, sampling, redaction, and retention.

中文：第一切片定义接口与配置：`ObservabilitySink`、`ObservabilityRuntime`、`ObservabilityExporter`、`TraceBackend`、dashboard query DTOs（数据传输对象，用来稳定前后端接口），以及本地 JSON、OTLP endpoint、采样、脱敏和保留策略的运行时配置。

English: Slice 2 adds OpenTelemetry SDK initialization and mapping. It should create spans and metrics from existing `LoopStepEvent` fixtures before wiring production loop calls, so mapping tests can stabilize first.

中文：第二切片增加 OpenTelemetry SDK 初始化和映射。它应先从现有 `LoopStepEvent` 夹具创建 span 与 metric，再接入生产循环调用，这样映射测试可以先稳定。

English: Slice 3 adds JSON fallback and OTLP exporter implementations. Exporter failure, partial success, shutdown flush, and local filesystem failure must all have deterministic tests.

中文：第三切片增加 JSON fallback 与 OTLP 导出器实现。导出器失败、部分成功、关闭前刷新和本地文件系统失败都必须有确定性测试。

English: Slice 4 adds trace backend storage and query APIs. The first API set should support list runs, get run detail, list failures, list pauses, get metric rollups, and resolve external trace links.

中文：第四切片增加追踪后端存储和查询 API。第一组 API 应支持列出运行、获取运行详情、列出失败、列出暂停、获取指标汇总，以及解析外部追踪链接。

English: Slice 5 adds WebUI Dashboard surfaces backed by the local trace backend. UI implementation should focus on dense operational views, filters, and drill-downs rather than marketing-style visuals.

中文：第五切片增加由本地追踪后端支撑的 WebUI Dashboard 界面。界面实现应聚焦高密度运维视图、过滤和下钻，而不是营销式视觉。

English: Slice 6 adds failure explanation records and links them to dashboard run detail, JSON fallback records, and OTLP trace IDs.

中文：第六切片增加失败解释记录，并把它们链接到仪表盘运行详情、JSON fallback 记录和 OTLP trace ID。

## 十二、验证门槛 / Verification Gates

English: Contract verification must prove that every exported record can be traced back to one `LoopStepEvent` and that every final run has one `LoopStopState`.

中文：契约验证必须证明每条导出记录都能追溯到一个 `LoopStepEvent`，并且每次最终运行都有一个 `LoopStopState`。

English: Exporter verification must cover JSON deterministic output, OTLP payload shape, partial-success handling, retryable collector failures, non-retryable bad data, shutdown flush, and export failure not changing the underlying run result.

中文：导出器验证必须覆盖 JSON 确定性输出、OTLP 载荷形态、部分成功处理、可重试采集器失败、不可重试坏数据、关闭前刷新，以及导出失败不改变底层运行结果。

English: Backend verification must cover retention filtering, run list query, run detail query, failure query, pause query, metric rollup query, and correlation between JSON fallback records and OTLP trace IDs.

中文：后端验证必须覆盖保留策略过滤、运行列表查询、运行详情查询、失败查询、暂停查询、指标汇总查询，以及 JSON fallback 记录与 OTLP trace ID 的关联。

English: Dashboard verification must use representative traces for success, pause, guardrail block, model error, tool error, checkpoint error, exporter error, and resumed run. Screens should be checked for missing data, unsafe content display, and incorrect stop-state labels.

中文：仪表盘验证必须使用代表性追踪，覆盖成功、暂停、安全护栏阻断、模型错误、工具错误、检查点错误、导出器错误和恢复运行。页面应检查缺失数据、不安全内容展示和错误终止状态标签。

English: Redaction verification must prove that prompts, tool outputs, environment values, credentials, and file contents are absent in `metadata_only`; sanitized and reason-tagged in `redacted_content`; and still blocked for disallowed background or idle-origin runs.

中文：脱敏验证必须证明在 `metadata_only` 中没有 prompt、工具输出、环境变量值、凭证和文件内容；在 `redacted_content` 中经过清洗并带原因标签；并且对不允许的后台或 idle-origin 运行仍保持阻断。

## 十三、Linear 映射 / Linear Mapping

English: `QUI-20` owns this plan and the implementation of OpenTelemetry SDK integration, OTLP exporter, JSON fallback exporter, trace backend, metrics exporter, WebUI Dashboard surfaces, operator-facing runtime traces, redaction/sampling behavior, and deterministic failure explanation.

中文：`QUI-20` 负责本规划，以及 OpenTelemetry SDK 集成、OTLP 导出器、JSON fallback 导出器、追踪后端、指标导出器、WebUI Dashboard 界面、面向操作者的运行时追踪、脱敏/采样行为和确定性失败解释的实现。

English: `QUI-55` owns the frontier decision that selected OpenTelemetry GenAI, OTLP, stable step events, explicit stop states, and trace-to-eval readiness as the right direction.

中文：`QUI-55` 负责前沿决策，即选择 OpenTelemetry GenAI、OTLP、稳定步骤事件、显式终止状态和 trace-to-eval 准备作为正确方向。

English: `QUI-66` owns the Core Loop contracts that `QUI-20` consumes: `LoopStepEvent`, `LoopStopState`, checkpoint terminal semantics, interrupt/resume payloads, OpenTelemetry mapping fixtures, and trace-to-eval envelope generation.

中文：`QUI-66` 负责 `QUI-20` 消费的 Core Loop 契约：`LoopStepEvent`、`LoopStopState`、检查点终态语义、中断/恢复载荷、OpenTelemetry 映射夹具和 trace-to-eval 信封生成。

English: `QUI-75` owns verification evidence for OpenTelemetry GenAI mapping, OTLP export fixtures, trace-to-eval envelope fixtures, interrupt/resume replay fixtures, and redaction correctness.

中文：`QUI-75` 负责 OpenTelemetry GenAI 映射、OTLP 导出夹具、trace-to-eval 信封夹具、中断/恢复回放夹具和脱敏正确性的验证证据。

## 十四、非目标 / Non-Goals

English: This plan does not choose a hosted observability vendor. OTLP support keeps the path open for multiple backends while the local trace backend keeps Quilin usable without external infrastructure.

中文：本规划不选择托管可观测供应商。OTLP 支持保留多后端路径，本地追踪后端则保证 Quilin 在没有外部基础设施时也可用。

English: This plan does not replace the Core Loop with a graph workflow runtime. It consumes step events and stop states from the minimal loop and keeps backend/dashboard concerns outside that loop.

中文：本规划不把 Core Loop 替换成图工作流运行时。它消费极简循环发出的步骤事件与终止状态，并把后端/仪表盘关注点留在循环之外。

English: This plan does not run benchmarks early or later by default. Benchmark work is frozen unless the user explicitly asks for it; the active goal is reliable local runtime trace evidence.

中文：本规划默认现在和后续都不运行基准测试。除非用户明确要求，Benchmark 工作保持冻结；活跃目标是可靠的本地 runtime trace 实证。

## 十五、参考链接 / References

English: Primary sources checked for this plan: [OpenTelemetry JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/), [OpenTelemetry OTLP specification](https://opentelemetry.io/docs/specs/otlp/), [OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/), [OpenTelemetry GenAI metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/), and [Vercel AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry).

中文：本规划核查的一手来源包括：[OpenTelemetry JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)、[OpenTelemetry OTLP specification](https://opentelemetry.io/docs/specs/otlp/)、[OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)、[OpenTelemetry GenAI metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/) 和 [Vercel AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)。
