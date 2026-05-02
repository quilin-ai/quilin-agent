# 核心循环可观测性实现规划 / Core Loop Observability Implementation Plan

English: This document is the implementation plan for Linear `QUI-66`（the existing issue for OpenTelemetry GenAI observability and Core Loop step contracts）. It synthesizes `docs/08-observability/observability-core-loop-frontier.md`, `docs/06-multi-agent/durable-subagent-runtime-plan.md`, and the current Core Loop（核心循环，负责消息、模型、工具和检查点流转的最小执行循环）boundary in `docs/00-core-loop/README.md`.

中文：本文档是 Linear `QUI-66`（现有 OpenTelemetry GenAI 可观测性与核心循环步骤契约任务）的实现规划。它综合 `docs/08-observability/observability-core-loop-frontier.md`、`docs/06-multi-agent/durable-subagent-runtime-plan.md`，以及 `docs/00-core-loop/README.md` 中的 Core Loop（核心循环，负责消息、模型、工具和检查点流转的最小执行循环）边界。

English: The goal is not to start benchmark（基准测试，用来评估整体能力的测试集合）execution. The goal is to make Core Loop observability strong enough that later evaluation, dashboard, replay, and benchmark work can rely on stable traces（追踪，指一次运行中可串联的执行记录）, stop states, checkpoint semantics, and redaction rules.

中文：目标不是启动 benchmark（基准测试，用来评估整体能力的测试集合）执行。目标是先把 Core Loop observability（核心循环可观测性）做强，让后续评测、仪表盘、回放和基准测试可以依赖稳定的 traces（追踪，指一次运行中可串联的执行记录）、终止状态、检查点语义和脱敏规则。

## 一、实现边界 / Implementation Boundary

English: `QUI-66` should add contracts and integration points, not a new workflow framework. Quilin keeps its self-owned minimal TypeScript（类型化 JavaScript）loop and exposes model calls, tool calls, checkpoints, interrupts, resumes, and loop terminal states through stable domain events.

中文：`QUI-66` 应增加契约和集成点，而不是引入新的工作流框架。Quilin 继续保留自研极简 TypeScript（类型化 JavaScript）循环，并通过稳定领域事件暴露模型调用、工具调用、检查点、中断、恢复和循环终止状态。

English: OpenTelemetry GenAI（OpenTelemetry 生成式 AI 语义规范，用来统一模型调用、工具调用、token 和延迟观测）is the external semantic target. Because the GenAI convention is still evolving, Quilin should keep internal event contracts stable and add a versioned mapper from internal events to `gen_ai.*` attributes and events.

中文：OpenTelemetry GenAI（OpenTelemetry 生成式 AI 语义规范，用来统一模型调用、工具调用、token 和延迟观测）是外部语义目标。因为 GenAI 约定仍在演进，Quilin 应保持内部事件契约稳定，并增加一个带版本的映射器，把内部事件转换成 `gen_ai.*` 属性和事件。

English: OTLP（OpenTelemetry Protocol，开放遥测协议，用来把 traces、metrics、logs 发送到采集器）is the transport target for `QUI-20`; `QUI-66` should define the export shape and local fixtures, while the backend, collector recipes, dashboard, retention, and deployment plumbing stay owned by `QUI-20`.

中文：OTLP（OpenTelemetry Protocol，开放遥测协议，用来把 traces、metrics、logs 发送到采集器）是 `QUI-20` 的传输目标；`QUI-66` 应定义导出形态和本地夹具，而后端、采集器配方、仪表盘、保留策略和部署接线仍由 `QUI-20` 负责。

## 二、实现切片 / Implementation Slices

English: Slice 1 freezes TypeScript contracts: `LoopStepEvent`（循环步骤事件，用来记录每个模型、工具、检查点、中断和恢复步骤）, `LoopStopState`（循环终止状态，用来统一成功、暂停、失败和取消的生命周期结果）, `LoopInterruptPayload`（循环中断载荷，用来描述暂停原因和恢复要求）, `LoopResumePayload`（循环恢复载荷，用来描述从哪个检查点继续）, `TraceExampleEnvelope`（轨迹样本信封，用来把执行轨迹转成后续评测输入）, and `RedactionPolicy`（脱敏策略，用来控制可观测数据中允许保留的内容级别）.

中文：第一切片冻结 TypeScript 契约：`LoopStepEvent`（循环步骤事件，用来记录每个模型、工具、检查点、中断和恢复步骤）、`LoopStopState`（循环终止状态，用来统一成功、暂停、失败和取消的生命周期结果）、`LoopInterruptPayload`（循环中断载荷，用来描述暂停原因和恢复要求）、`LoopResumePayload`（循环恢复载荷，用来描述从哪个检查点继续）、`TraceExampleEnvelope`（轨迹样本信封，用来把执行轨迹转成后续评测输入）和 `RedactionPolicy`（脱敏策略，用来控制可观测数据中允许保留的内容级别）。

English: Slice 2 wires Core Loop emission. Every turn start, model call, tool call, checkpoint write, interrupt, resume, and loop stop must emit one `LoopStepEvent` with a stable `eventSeq`（事件序号，用来重放时恢复顺序）and trace/span（追踪/跨度，span 指一段可计时并挂属性的追踪记录）references when available.

中文：第二切片接入 Core Loop 事件发射。每次轮次开始、模型调用、工具调用、检查点写入、中断、恢复和循环停止，都必须发出一个 `LoopStepEvent`，并在可用时携带稳定的 `eventSeq`（事件序号，用来重放时恢复顺序）以及 trace/span（追踪/跨度，span 指一段可计时并挂属性的追踪记录）引用。

English: Slice 3 fixes terminal lifecycle semantics. Assistant final response, paused interruption, user cancellation, guardrail block, max-turn stop, model failure, tool failure, checkpoint failure, and token-budget stop must all produce an explicit `LoopStopState` and must be persisted in the final checkpoint.

中文：第三切片修正终态生命周期语义。助手最终回复、暂停中断、用户取消、安全护栏阻断、最大轮次停止、模型失败、工具失败、检查点失败和 token 预算停止都必须产生明确的 `LoopStopState`，并写入最终检查点。

English: Slice 4 adds the OpenTelemetry mapper and local exporters. Internal events should be collected once, then exported to the current JSON（JavaScript Object Notation，一种结构化文本数据格式）fixture path and to OTLP-compatible trace, metric, and log records through a single mapping boundary.

中文：第四切片增加 OpenTelemetry 映射器和本地导出器。内部事件应只采集一次，然后通过单一映射边界导出到当前 JSON（JavaScript Object Notation，一种结构化文本数据格式）夹具路径，以及兼容 OTLP 的追踪、指标和日志记录。

English: Slice 5 adds trace-to-eval preparation. The system should be able to derive a `TraceExampleEnvelope` from a selected run without running benchmarks. Future `QUI-75` verification can consume stable local samples; Benchmark work is frozen unless the user explicitly asks.

中文：第五切片增加 trace-to-eval（从执行轨迹生成评测样本）准备。系统应能从选定运行中派生 `TraceExampleEnvelope`，但不执行基准测试。后续 `QUI-75` 验证可以消费稳定本地样本；除非用户明确要求，Benchmark 工作保持冻结。

## 三、核心事件契约 / Core Event Contract

English: `LoopStepEvent` is the internal source of truth for lifecycle observation. It should remain compact enough for the minimal loop but complete enough for replay, WebUI（网页仪表盘或网页界面，用来展示运行状态）streaming, OTLP export, durable sub-agent progress, and trace-to-eval extraction.

中文：`LoopStepEvent` 是生命周期观测的内部真相源。它应足够小，不破坏极简循环；同时足够完整，支撑回放、WebUI（网页仪表盘或网页界面，用来展示运行状态）实时流、OTLP 导出、可恢复子 Agent 进度和 trace-to-eval 抽取。

```ts
type LoopStepKind =
  | "turn"
  | "llm"
  | "tool"
  | "checkpoint"
  | "interrupt"
  | "resume"
  | "subagent"
  | "stop";

type LoopStepStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "paused"
  | "cancelled"
  | "skipped_replay";

interface LoopStepEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventSeq: number;
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly stepId: string;
  readonly parentStepId?: string;
  readonly kind: LoopStepKind;
  readonly status: LoopStepStatus;
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly checkpointRef?: string;
  readonly activityId?: string;
  readonly idempotencyKey?: string;
  readonly model?: ModelCallSummary;
  readonly tool?: ToolCallSummary;
  readonly runtime?: RuntimeStepSummary;
  readonly stopState?: LoopStopState;
  readonly interrupt?: LoopInterruptPayload;
  readonly resume?: LoopResumePayload;
  readonly redactionPolicy: RedactionPolicy;
  readonly emittedAt: string;
}
```

English: `eventSeq` must be monotonic within one run. The runtime may use timestamps for display, but replay and test assertions should use `eventSeq` because timestamps can drift across processes and restored sessions.

中文：`eventSeq` 必须在同一次运行内单调递增。运行时可以用时间戳做展示，但回放和测试断言应使用 `eventSeq`，因为时间戳可能在跨进程和恢复会话中漂移。

English: `activityId` and `idempotencyKey` connect `QUI-66` to the durable runtime plan in `QUI-61`. A replayed file write, shell execution, tool call, model call, checkpoint write, or sub-agent dispatch must be able to prove whether the same activity already succeeded.

中文：`activityId` 和 `idempotencyKey` 把 `QUI-66` 连接到 `QUI-61` 的可恢复运行时规划。重放中的文件写入、shell 命令、工具调用、模型调用、检查点写入或子 Agent 派发，必须能证明同一活动是否已经成功过。

## 四、终止状态契约 / Stop State Contract

English: `LoopStopState` replaces ambiguous combinations of `finishReason`, `loopSucceeded`, and `isTerminal`. It is persisted in checkpoints, attached to final spans, emitted in the final `loop_stopped` event, and included in trace-to-eval envelopes.

中文：`LoopStopState` 取代 `finishReason`、`loopSucceeded` 和 `isTerminal` 的模糊组合。它会写入检查点，附着到最终 span，随最终 `loop_stopped` 事件发出，并进入 trace-to-eval 信封。

```ts
type StopCategory = "success" | "pause" | "failure" | "cancelled";

type StopReason =
  | "assistant_final"
  | "tool_calls_pending"
  | "max_turns_exceeded"
  | "token_budget_exceeded"
  | "awaiting_human"
  | "user_interrupt"
  | "blocked_by_guardrail"
  | "llm_error"
  | "tool_error"
  | "checkpoint_error"
  | "runtime_error"
  | "cancelled";

interface LoopStopState {
  readonly schemaVersion: 1;
  readonly category: StopCategory;
  readonly reason: StopReason;
  readonly terminal: boolean;
  readonly retryable: boolean;
  readonly resumable: boolean;
  readonly finishReason?: string;
  readonly errorCode?: string;
  readonly checkpointRef?: string;
  readonly resumeTokenId?: string;
  readonly stoppedAt: string;
}
```

English: The mapping is strict. `assistant_final` is `success` and terminal; `awaiting_human` and `user_interrupt` are `pause` and non-terminal for the session; `blocked_by_guardrail`, `llm_error`, `tool_error`, `checkpoint_error`, and `runtime_error` are `failure`; `cancelled` is `cancelled`.

中文：映射必须严格。`assistant_final` 是 `success` 且为终态；`awaiting_human` 和 `user_interrupt` 是 `pause` 且对会话而言不是最终关闭；`blocked_by_guardrail`、`llm_error`、`tool_error`、`checkpoint_error` 和 `runtime_error` 是 `failure`；`cancelled` 是 `cancelled`。

English: `tool_calls_pending` is not a user-visible success. It means the model has requested tools and the loop must either execute them, checkpoint them for a delegated runtime, or stop with a pause state if execution requires approval.

中文：`tool_calls_pending` 不是面向用户的成功。它表示模型请求了工具，循环必须执行这些工具、把它们检查点化后交给委派运行时，或在执行需要审批时以暂停状态停止。

## 五、检查点终态语义 / Checkpoint Terminal Semantics

English: A checkpoint is terminal when it represents a lifecycle boundary after which the current loop invocation must not continue executing steps. Terminal checkpoints must include `LoopStopState`, final `eventSeq`, trace IDs, redaction policy, and an optional resume token for pause states.

中文：当一个检查点代表生命周期边界，并且当前循环调用不应继续执行步骤时，它就是终态检查点。终态检查点必须包含 `LoopStopState`、最终 `eventSeq`、追踪 ID、脱敏策略，以及暂停状态下可选的恢复令牌。

English: Assistant response terminal state is explicit: when the assistant has produced the final answer and no tool call remains pending, the final assistant-response checkpoint must set `isTerminal: true`, must carry `LoopStopState.category: "success"`, and must use `LoopStopState.reason: "assistant_final"`.

中文：助手回复终态必须显式：当助手已经产出最终回答且没有待执行工具调用时，最终助手回复检查点必须设置 `isTerminal: true`，必须携带 `LoopStopState.category: "success"`，并使用 `LoopStopState.reason: "assistant_final"`。

English: Pause checkpoints are terminal for the current invocation but resumable for the run. They must set `isTerminal: true`, carry a pause-category `LoopStopState`, include a `resumeTokenId`, and record what input or approval is required before the loop can continue.

中文：暂停检查点对当前调用是终态，但对整次运行是可恢复的。它们必须设置 `isTerminal: true`，携带暂停类别的 `LoopStopState`，包含 `resumeTokenId`，并记录循环继续前需要什么输入或审批。

English: Failure checkpoints are terminal and may be retryable. They must include the failed `stepId`, `activityId`, `idempotencyKey` when present, and a structured error code so retry logic can distinguish transient failures from unsafe replay.

中文：失败检查点是终态，并且可能可重试。它们必须包含失败的 `stepId`、`activityId`、存在时的 `idempotencyKey`，以及结构化错误码，让重试逻辑能区分瞬时失败和不安全重放。

## 六、中断与恢复载荷 / Interrupt and Resume Payload

English: Interruption is a pause lifecycle, not an exception-only path. A loop that needs human input, write approval, credential selection, external confirmation, or cooperative cancellation must emit `interrupt_raised` and persist the payload in the checkpoint.

中文：中断是一种暂停生命周期，而不只是异常路径。需要人工输入、写入审批、凭证选择、外部确认或协作式取消的循环，必须发出 `interrupt_raised` 并把载荷写入检查点。

```ts
interface LoopInterruptPayload {
  readonly schemaVersion: 1;
  readonly interruptId: string;
  readonly requestedBy: "user" | "tool" | "guardrail" | "write_authority" | "system";
  readonly reason: "awaiting_human" | "user_interrupt" | "blocked_by_guardrail" | "approval_required";
  readonly requiredInputSchema?: unknown;
  readonly userPrompt?: string;
  readonly checkpointRef: string;
  readonly resumeTokenId: string;
  readonly singleUse: boolean;
  readonly expiresAt?: string;
}

interface LoopResumePayload {
  readonly schemaVersion: 1;
  readonly resumeId: string;
  readonly resumeTokenId: string;
  readonly checkpointRef: string;
  readonly resumedBy: "user" | "supervisor" | "subagent" | "system";
  readonly input?: unknown;
  readonly previousEventSeq: number;
  readonly resumedAt: string;
}
```

English: Resume must be recorded before the loop executes the next step. This makes continuation visible in trace history and gives the durable runtime a place to verify token reuse, checkpoint identity, and required input shape.

中文：恢复必须在循环执行下一步之前记录。这样续跑会在 trace 历史中可见，也让可恢复运行时可以验证令牌复用、检查点身份和所需输入结构。

English: A resume token is an opaque user-facing handle but a structured runtime record. It should identify run ID, checkpoint reference, event sequence, active step, single-use behavior, and expiration without exposing private context.

中文：恢复令牌对用户应是不透明句柄，但在运行时内部是结构化记录。它应标识运行 ID、检查点引用、事件序号、活跃步骤、是否一次性使用和过期时间，同时不暴露私密上下文。

## 七、OpenTelemetry GenAI 映射 / OpenTelemetry GenAI Mapping

English: The mapper should translate internal `LoopStepEvent` records to OpenTelemetry spans, events, and metrics. It must not make the loop depend directly on OpenTelemetry SDK（软件开发工具包，用来创建和导出遥测数据）types.

中文：映射器应把内部 `LoopStepEvent` 记录转换为 OpenTelemetry span、event 和 metric。它不得让循环直接依赖 OpenTelemetry SDK（软件开发工具包，用来创建和导出遥测数据）类型。

English: The required span hierarchy is `quilin.run` for one run, `quilin.turn` for a user-visible turn, `gen_ai.client.operation` or equivalent mapped span for a model call, `quilin.tool` for a tool call with `gen_ai.*` supplemental fields where valid, `quilin.checkpoint` for checkpoint writes, and `quilin.resume` for resume events.

中文：必要的 span 层级是：`quilin.run` 表示一次运行，`quilin.turn` 表示一个用户可见轮次，`gen_ai.client.operation` 或等价映射 span 表示模型调用，`quilin.tool` 表示工具调用并在合适时补充 `gen_ai.*` 字段，`quilin.checkpoint` 表示检查点写入，`quilin.resume` 表示恢复事件。

English: Model spans must capture provider, model name, operation name, input token（模型文本计量单位，用来估算上下文长度和成本）count, output token count, total token count, finish reason, time-to-first-token, total latency, retry count, and error class after applying the redaction policy.

中文：模型 span 必须在应用脱敏策略后记录供应商、模型名、操作名、输入 token（模型文本计量单位，用来估算上下文长度和成本）数、输出 token 数、总 token 数、结束原因、首 token 延迟、总延迟、重试次数和错误类别。

English: Tool spans must capture tool name, tool type, call ID, sanitized arguments, sanitized result metadata, duration, success flag, error class, write decision ID when applicable, and idempotency key when replay protection applies.

中文：工具 span 必须记录工具名、工具类型、调用 ID、脱敏后的参数、脱敏后的结果元数据、耗时、成功标记、错误类别、适用时的写入裁决 ID，以及需要重放保护时的幂等键。

English: Runtime sub-agent events from `QUI-61` map into `LoopStepEvent.kind: "subagent"` and then to spans/events carrying `parentRunId`, `childRunId`, `taskId`, durable state, heartbeat lease, checkpoint reference, and terminal stop state when present.

中文：`QUI-61` 的可恢复子 Agent 运行时事件映射为 `LoopStepEvent.kind: "subagent"`，再转换成携带 `parentRunId`、`childRunId`、`taskId`、可恢复状态、心跳租约、检查点引用和存在时终止状态的 span/event。

## 八、OTLP 导出器 / OTLP Exporter

English: The exporter path should support two outputs from the same internal events: deterministic JSON fixtures for local tests and OTLP-compatible records for OpenTelemetry Collector（开放遥测采集器，用来接收、处理和转发遥测数据）integration.

中文：导出路径应从同一批内部事件支持两种输出：用于本地测试的确定性 JSON 夹具，以及用于 OpenTelemetry Collector（开放遥测采集器，用来接收、处理和转发遥测数据）集成的 OTLP 兼容记录。

English: The first implementation can use an adapter interface such as `ObservabilityExporter`. One implementation writes JSON lines; one implementation builds OTLP trace, metric, and log payloads. The loop should call only the exporter interface.

中文：第一版实现可以使用 `ObservabilityExporter` 这样的适配器接口。一个实现写入 JSON lines（逐行 JSON 记录），另一个实现构建 OTLP trace、metric 和 log 载荷。循环只应调用导出器接口。

English: OTLP partial-success handling must be explicit. If a collector accepts some records and rejects others, the exporter should record rejected record IDs, rejection reason, and retry decision instead of blindly resending the whole batch.

中文：OTLP 的 partial success（部分成功）处理必须显式。如果采集器接受部分记录并拒绝部分记录，导出器应记录被拒记录 ID、拒绝原因和重试决策，而不是盲目重发整个批次。

English: Export failures must not hide loop completion. A run can finish successfully while observability export fails; in that case the final `LoopStopState` remains success, and the exporter emits a separate `observability_export_error` event for `QUI-20` and operations handling.

中文：导出失败不能掩盖循环完成。一次运行可以成功结束，同时可观测导出失败；这种情况下最终 `LoopStopState` 仍是成功，导出器另外发出 `observability_export_error` 事件，供 `QUI-20` 和运维处理。

## 九、轨迹转评测信封 / Trace-to-Eval Envelope

English: `TraceExampleEnvelope` is a data contract, not a benchmark runner. It should make future evaluation samples cheap to derive after the components are strong, while keeping current work focused on observability.

中文：`TraceExampleEnvelope` 是数据契约，不是 benchmark runner（基准测试执行器）。它应让组件强化完成后的未来评测样本容易派生，同时保持当前工作聚焦在可观测性。

```ts
interface TraceExampleEnvelope {
  readonly schemaVersion: 1;
  readonly exampleId: string;
  readonly traceId: string;
  readonly rootSpanId?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly source: "production" | "manual" | "regression" | "benchmark";
  readonly selectedEventSeqRange: readonly [number, number];
  readonly inputMessages: unknown;
  readonly assistantOutput?: unknown;
  readonly toolCalls: readonly ToolCallSummary[];
  readonly stopState: LoopStopState;
  readonly redactionPolicy: RedactionPolicy;
  readonly expectedOutput?: unknown;
  readonly scores?: readonly TraceScore[];
  readonly sourceMetadata: {
    readonly createdAt: string;
    readonly createdBy: "user" | "system" | "evaluator";
    readonly issueRefs: readonly string[];
  };
}
```

English: The envelope should store selected references rather than raw full traces by default. Full prompt, tool output, and file content should appear only when the redaction policy explicitly permits content capture.

中文：该信封默认应存储被选择的引用，而不是原始完整 trace。只有脱敏策略明确允许内容采集时，才可以包含完整 prompt、工具输出和文件内容。

English: `QUI-75` should verify that a trace with model calls, tool calls, checkpoint save, interrupt, resume, and assistant final state can produce a deterministic `TraceExampleEnvelope`.

中文：`QUI-75` 应验证包含模型调用、工具调用、检查点保存、中断、恢复和助手最终状态的 trace 可以生成确定性的 `TraceExampleEnvelope`。

## 十、脱敏策略 / Redaction Policy

English: `RedactionPolicy` controls what can leave the runtime boundary. It should be attached to each `LoopStepEvent`, inherited by spans and exporters, and preserved in trace-to-eval envelopes.

中文：`RedactionPolicy` 控制哪些数据可以离开运行时边界。它应附着到每个 `LoopStepEvent`，被 span 和导出器继承，并保留在 trace-to-eval 信封中。

```ts
type RedactionLevel = "metadata_only" | "redacted_content" | "full_content";

interface RedactionPolicy {
  readonly schemaVersion: 1;
  readonly level: RedactionLevel;
  readonly allowPromptContent: boolean;
  readonly allowToolArguments: boolean;
  readonly allowToolResultContent: boolean;
  readonly allowFilePaths: boolean;
  readonly allowEnvironmentValues: false;
  readonly secretPatternsVersion: string;
  readonly appliedRules: readonly string[];
}
```

English: `metadata_only` is the default. It records IDs, names, token counts, durations, statuses, error classes, checkpoint references, and content hashes, but never records raw prompts, tool outputs, environment values, credentials, or file contents.

中文：`metadata_only` 是默认策略。它记录 ID、名称、token 数、耗时、状态、错误类别、检查点引用和内容哈希，但绝不记录原始 prompt、工具输出、环境变量值、凭证或文件内容。

English: `redacted_content` may include sanitized snippets after removing secrets, private user data, credential-like values, large file content, and shell output that contains environment data. Each redacted field should include a reason such as `secret_pattern`, `path_policy`, `size_limit`, or `user_private`.

中文：`redacted_content` 可以包含脱敏后的片段，但必须移除密钥、用户私密数据、疑似凭证值、大文件内容，以及包含环境数据的 shell 输出。每个被脱敏字段都应包含原因，例如 `secret_pattern`、`path_policy`、`size_limit` 或 `user_private`。

English: `full_content` is opt-in only and should be blocked for idle evolution, sub-agent background exploration, and any trace that includes credentials, private documents, or external account data.

中文：`full_content` 只能显式启用，并且应对空闲自进化、子 Agent 后台探索，以及任何包含凭证、私密文档或外部账户数据的 trace 保持阻断。

## 十一、测试门槛 / Test Gates

English: Contract tests must prove that every emitted event has schema version, run ID, session ID, step ID, monotonic event sequence, kind, status, redaction policy, and trace/span linkage when a span exists.

中文：契约测试必须证明每个发出的事件都有 schema 版本、运行 ID、会话 ID、步骤 ID、单调事件序号、类型、状态、脱敏策略，以及在 span 存在时的 trace/span 关联。

English: Stop-state tests must cover assistant final response, pending tool call, max-turn stop, token-budget stop, awaiting-human pause, user interrupt, guardrail block, model error, tool error, checkpoint error, runtime error, and cancellation.

中文：终止状态测试必须覆盖助手最终回复、待执行工具调用、最大轮次停止、token 预算停止、等待人工暂停、用户中断、安全护栏阻断、模型错误、工具错误、检查点错误、运行时错误和取消。

English: Checkpoint tests must assert that assistant final checkpoints are terminal success, pause checkpoints are terminal for the current invocation and resumable for the run, failure checkpoints carry structured error details, and no terminal checkpoint is followed by additional step execution in the same invocation.

中文：检查点测试必须断言助手最终检查点是成功终态，暂停检查点对当前调用是终态且对运行可恢复，失败检查点携带结构化错误详情，并且同一次调用中终态检查点之后不会继续执行步骤。

English: Interrupt/resume tests must persist an interrupt payload, stop with a pause state, resume from the recorded checkpoint using a resume payload, emit `resume_received`, continue with the next event sequence, and reject stale or duplicate single-use tokens.

中文：中断/恢复测试必须持久化中断载荷，以暂停状态停止，使用恢复载荷从记录的检查点继续，发出 `resume_received`，用下一个事件序号继续，并拒绝过期或重复使用的一次性令牌。

English: OpenTelemetry mapping tests must verify span names, required `gen_ai.*` model attributes, token usage mapping, finish reason mapping, tool-call attributes, checkpoint events, runtime sub-agent events, and redaction behavior for all three redaction levels.

中文：OpenTelemetry 映射测试必须验证 span 名称、必需的 `gen_ai.*` 模型属性、token 用量映射、结束原因映射、工具调用属性、检查点事件、可恢复子 Agent 运行时事件，以及三种脱敏级别的行为。

English: OTLP exporter tests must verify deterministic JSON fixture output, OTLP payload shape, batch failure recording, partial-success handling, and that export failure does not mutate the underlying `LoopStopState`.

中文：OTLP 导出器测试必须验证确定性 JSON 夹具输出、OTLP 载荷形态、批量失败记录、部分成功处理，以及导出失败不会改变底层 `LoopStopState`。

English: Trace-to-eval tests must derive one envelope from a completed run and one envelope from an interrupted-then-resumed run. Both envelopes must include source issue references, selected event range, stop state, redaction policy, and stable trace/span IDs.

中文：trace-to-eval 测试必须从一次完成运行和一次中断后恢复运行各派生一个信封。两个信封都必须包含来源 issue 引用、选定事件范围、终止状态、脱敏策略，以及稳定 trace/span ID。

## 十二、Linear 映射 / Linear Mapping

English: `QUI-66` owns this implementation plan and the concrete implementation of `LoopStepEvent`, `LoopStopState`, checkpoint terminal semantics, assistant response terminal state, interrupt/resume payloads, OpenTelemetry GenAI mapping, local exporter fixtures, and trace-to-eval envelope generation.

中文：`QUI-66` 负责本实现规划，以及 `LoopStepEvent`、`LoopStopState`、检查点终态语义、助手回复终态、中断/恢复载荷、OpenTelemetry GenAI 映射、本地导出夹具和 trace-to-eval 信封生成的具体实现。

English: `QUI-55` owns the frontier decision that justified this plan. It should link to this document as the implementation follow-through, but should not become the implementation work queue.

中文：`QUI-55` 负责支撑本规划的前沿决策。它应链接到本文作为实现承接，但不应变成实现工作队列。

English: `QUI-61` owns durable sub-agent runtime state, typed handoff, heartbeat/lease, parent inbox/outbox, resume tokens, retry/idempotency, and `WriteAuthority` runtime integration. `QUI-66` consumes those events through `LoopStepEvent.kind: "subagent"`.

中文：`QUI-61` 负责可恢复子 Agent 运行时状态、结构化移交、心跳/租约、父运行收发件箱、恢复令牌、重试/幂等，以及 `WriteAuthority` 运行时集成。`QUI-66` 通过 `LoopStepEvent.kind: "subagent"` 消费这些事件。

English: `QUI-75` owns verification evidence: OpenTelemetry mapping fixtures, OTLP export fixtures, trace-to-eval envelope fixtures, and interrupt/resume replay fixtures. Its outputs should prove that this contract works before broader benchmark work starts.

中文：`QUI-75` 负责验证证据：OpenTelemetry 映射夹具、OTLP 导出夹具、trace-to-eval 信封夹具，以及中断/恢复回放夹具。它的输出应在更大范围基准测试启动前证明本契约可用。

English: `QUI-20` owns backend consumption: OTLP Collector recipes, trace backend experiments, WebUI Dashboard rendering, retention policy, and operational handling for exporter failures.

中文：`QUI-20` 负责后端消费：OTLP Collector 配方、trace 后端实验、WebUI Dashboard 渲染、保留策略，以及导出失败的运维处理。

## 十三、非目标 / Non-Goals

English: This plan does not add a graph workflow runtime. LangGraph-style durable vocabulary is absorbed as checkpoint, interrupt, resume, and event history semantics, while Quilin keeps its minimal loop.

中文：本规划不增加图工作流运行时。它只吸收 LangGraph 风格的可恢复词汇，即检查点、中断、恢复和事件历史语义，同时 Quilin 继续保留极简循环。

English: This plan does not implement cross-machine Agent Mesh（跨机器多 Agent 网络） transport. Mesh events can later use the same event and stop-state contracts, but local Core Loop and sub-agent runtime observability come first.

中文：本规划不实现跨机器 Agent Mesh（跨机器多 Agent 网络）传输。Mesh 事件后续可以复用同一套事件和终止状态契约，但本机 Core Loop 与子 Agent 运行时可观测性优先。

English: This plan does not promote benchmark execution to first priority. It only creates the trace and envelope foundation needed for meaningful benchmarks after component strengthening is complete.

中文：本规划不把基准测试执行提升为第一优先级。它只建立 trace 和信封基础，让组件强化完成后的基准测试有可靠数据来源。
