# OpenTelemetry GenAI 与追踪转评测证据规划 / OpenTelemetry GenAI and Trace-to-Eval Verification Plan

> 绑定任务 / Bound issue: Linear `QUI-75`
>
> 关联任务 / Related issues: `QUI-66`, `QUI-55`, `QUI-20`
>
> 规划时间 / Plan time: 2026-05-02 Asia/Shanghai
>
> 范围 / Scope: verification evidence only; benchmark（基准测试，用来衡量整体能力的测试集合）execution is frozen unless the user explicitly asks for Benchmark work.

## 一、目标 / Goal

English: This document defines the verification evidence package for OpenTelemetry GenAI（OpenTelemetry 生成式人工智能语义规范，用来统一模型调用、工具调用、token、错误和延迟观测）and trace-to-eval（追踪转评测，把一次运行的可观测记录转成可重复评测样例）work. The goal is to prove that Quilin can turn a failed or successful run into structured evidence without asking a human to read raw logs（原始日志，指未经结构化筛选和脱敏的完整运行输出）.

中文：本文档定义 OpenTelemetry GenAI（OpenTelemetry 生成式人工智能语义规范，用来统一模型调用、工具调用、token、错误和延迟观测）与 trace-to-eval（追踪转评测，把一次运行的可观测记录转成可重复评测样例）的验证证据包。目标是证明 Quilin 可以把失败或成功运行转成结构化证据，而不要求人类阅读 raw logs（原始日志，指未经结构化筛选和脱敏的完整运行输出）。

English: The plan builds on `docs/08-observability/observability-core-loop-frontier.md` and `docs/08-observability/core-loop-observability-implementation-plan.md`. `QUI-66` owns the implementation contracts, `QUI-75` owns the evidence fixtures（验证夹具，指可重复运行并断言结果的固定样例）, and `QUI-20` owns backend/exporter/dashboard consumption. `QUI-55` remains the decision record that justified the direction.

中文：本规划基于 `docs/08-observability/observability-core-loop-frontier.md` 与 `docs/08-observability/core-loop-observability-implementation-plan.md`。`QUI-66` 负责实现契约，`QUI-75` 负责 evidence fixtures（验证夹具，指可重复运行并断言结果的固定样例），`QUI-20` 负责后端、导出器和仪表盘消费。`QUI-55` 保留为支撑该方向的决策记录。

English: This is not a benchmark runner. It is the evidence layer for local component validation; Benchmark work is frozen unless the user explicitly asks for it.

中文：这不是 benchmark runner（基准测试执行器）。它是本地组件验证的证据层；除非用户明确要求，Benchmark 工作保持冻结。

## 二、证据包成功标准 / Evidence Package Success Criteria

English: A `QUI-75` evidence package passes when one deterministic local fixture can emit required spans（追踪片段，指一次运行中的可计时、可挂属性的操作记录）, required attributes（属性，指可查询的键值元数据）, required event names（事件名，指可回放的生命周期动作名称）, correlation IDs（关联标识符，用来把运行、步骤、检查点和评测样例串起来）, sampling rules（采样规则，用来控制哪些追踪必须保留）, redaction policy（脱敏策略，用来控制内容能否离开运行边界）, OTLP（OpenTelemetry Protocol，开放遥测协议，用来导出追踪、指标和日志）output shape, and a trace-derived evaluation fixture.

中文：当一个确定性的本地 fixture 能发出 required spans（必需追踪片段，指一次运行中的可计时、可挂属性的操作记录）、required attributes（必需属性，指可查询的键值元数据）、required event names（必需事件名，指可回放的生命周期动作名称）、correlation IDs（关联标识符，用来把运行、步骤、检查点和评测样例串起来）、sampling rules（采样规则，用来控制哪些追踪必须保留）、redaction policy（脱敏策略，用来控制内容能否离开运行边界）、OTLP（OpenTelemetry Protocol，开放遥测协议，用来导出追踪、指标和日志）输出形状，以及由 trace 派生的评测夹具时，`QUI-75` 证据包才算通过。

English: The package must include one success run and one failed run. The failed run is mandatory because the core claim is that a failure can be classified, explained, redacted, exported, and converted to an evaluation sample without manual raw-log reading.

中文：证据包必须包含一个成功运行和一个失败运行。失败运行是必需项，因为核心主张是：失败可以被分类、解释、脱敏、导出，并转换为评测样例，而不需要人工阅读原始日志。

English: The package must be deterministic. Assertions should compare stable IDs, event sequence numbers, span names, stop-state categories, error classes, redaction decisions, and evaluation labels; assertions must not depend on wall-clock timestamps except for format validation.

中文：证据包必须是确定性的。断言应比较稳定标识符、事件序号、span 名称、终止状态类别、错误类别、脱敏决策和评测标签；断言不得依赖墙钟时间戳，除非只是验证格式。

## 三、必需追踪片段 / Required Spans

English: The span tree must be small enough for the Core Loop（核心循环，负责消息、模型、工具和检查点流转的最小执行循环）but complete enough to reconstruct the run. The minimum hierarchy is one root run span, one turn span, one model span, zero or more tool spans, one checkpoint span per persisted boundary, one optional resume span, one optional exporter span, and one trace-to-eval span.

中文：span 树必须足够小，不破坏 Core Loop（核心循环，负责消息、模型、工具和检查点流转的最小执行循环），同时又足够完整，能重建一次运行。最小层级是一个根运行 span、一个轮次 span、一个模型 span、零个或多个工具 span、每个持久化边界一个检查点 span、一个可选恢复 span、一个可选导出器 span，以及一个 trace-to-eval span。

English: Required span names are `quilin.run`, `quilin.turn`, `gen_ai.client.operation`, `gen_ai.execute_tool` or `quilin.tool` when the official OpenTelemetry GenAI tool shape cannot represent a local tool cleanly, `quilin.checkpoint`, `quilin.resume`, `quilin.observability.export`, and `quilin.trace_to_eval.build`.

中文：必需 span 名称是 `quilin.run`、`quilin.turn`、`gen_ai.client.operation`、`gen_ai.execute_tool` 或在官方 OpenTelemetry GenAI 工具形状不能清晰表达本地工具时使用 `quilin.tool`、`quilin.checkpoint`、`quilin.resume`、`quilin.observability.export` 与 `quilin.trace_to_eval.build`。

English: `quilin.run` is the root span for one user-visible or supervisor-visible run. It must own `run_id`, `session_id`, `trace_id`, `issue_refs`, `redaction.level`, `sampling.decision`, final `loop.stop.category`, and final `loop.stop.reason`.

中文：`quilin.run` 是一次用户可见或 supervisor（监督者，用来调度子任务和汇总状态的运行角色）可见运行的根 span。它必须持有 `run_id`、`session_id`、`trace_id`、`issue_refs`、`redaction.level`、`sampling.decision`、最终 `loop.stop.category` 和最终 `loop.stop.reason`。

English: `quilin.turn` represents one user-visible turn. It must own `turn_id`, `event_seq.start`, `event_seq.end`, `parent_step_id`, `checkpoint_ref.final`, and the final turn status.

中文：`quilin.turn` 表示一个用户可见轮次。它必须持有 `turn_id`、`event_seq.start`、`event_seq.end`、`parent_step_id`、`checkpoint_ref.final` 和最终轮次状态。

English: `gen_ai.client.operation` represents a model call. It must map to current OpenTelemetry GenAI fields where available: provider name, requested model, response model, operation name, finish reasons, input token count, output token count, retry count, error type, and content-capture policy. For Vercel AI SDK（Vercel 的 TypeScript AI 开发工具包，Quilin 用它统一模型调用）spans, `ai.*` attributes must be mapped into the same internal summary before export.

中文：`gen_ai.client.operation` 表示一次模型调用。它必须尽量映射到当前 OpenTelemetry GenAI 字段：供应商名称、请求模型、响应模型、操作名、结束原因、输入 token 数、输出 token 数、重试次数、错误类型和内容采集策略。对于 Vercel AI SDK（Vercel 的 TypeScript AI 开发工具包，Quilin 用它统一模型调用）产生的 span，`ai.*` 属性必须先映射到同一个内部摘要，再导出。

English: `gen_ai.execute_tool` or `quilin.tool` represents one tool call. It must own `tool.name`, `tool.call_id`, `tool.type`, `activity_id`, `idempotency_key`, sanitized argument metadata, sanitized result metadata, `write_authority.decision_id` when present, duration, status, and error type.

中文：`gen_ai.execute_tool` 或 `quilin.tool` 表示一次工具调用。它必须持有 `tool.name`、`tool.call_id`、`tool.type`、`activity_id`、`idempotency_key`、脱敏后的参数元数据、脱敏后的结果元数据、存在时的 `write_authority.decision_id`、耗时、状态和错误类型。

English: `quilin.checkpoint` represents a persisted lifecycle boundary. It must own `checkpoint_ref`, `checkpoint.kind`, `checkpoint.terminal`, `loop.stop.category` when terminal, `loop.stop.reason` when terminal, `resume_token_id` when resumable, and `event_seq`.

中文：`quilin.checkpoint` 表示一个已持久化的生命周期边界。它必须持有 `checkpoint_ref`、`checkpoint.kind`、`checkpoint.terminal`、终态时的 `loop.stop.category`、终态时的 `loop.stop.reason`、可恢复时的 `resume_token_id` 和 `event_seq`。

English: `quilin.trace_to_eval.build` represents conversion from trace to evaluation fixture. It must own `evaluation_fixture_id`, `source_trace_id`, `selected_event_seq.start`, `selected_event_seq.end`, `redaction.level`, `expected_outcome.kind`, and `proof.no_raw_log_required`.

中文：`quilin.trace_to_eval.build` 表示从 trace 转成评测夹具的动作。它必须持有 `evaluation_fixture_id`、`source_trace_id`、`selected_event_seq.start`、`selected_event_seq.end`、`redaction.level`、`expected_outcome.kind` 和 `proof.no_raw_log_required`。

## 四、必需属性 / Required Attributes

English: Every span must include `quilin.schema.version`, `service.name`, `run_id`, `session_id`, `step_id`, `event_seq`, `trace_id`, `span_id`, `redaction.level`, `sampling.decision`, `issue_refs`, and `quilin.component`. These fields are the minimum query surface for local fixtures, OpenTelemetry backends, and later dashboards.

中文：每个 span 必须包含 `quilin.schema.version`、`service.name`、`run_id`、`session_id`、`step_id`、`event_seq`、`trace_id`、`span_id`、`redaction.level`、`sampling.decision`、`issue_refs` 和 `quilin.component`。这些字段是本地夹具、OpenTelemetry 后端和后续仪表盘的最小查询表面。

English: Model spans must additionally include `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `llm.retry.count`, `llm.time_to_first_token_ms`, and `error.type` when failed. If the backend still uses AI SDK attribute names, the exporter should include a compatibility copy only after the internal canonical fields are present.

中文：模型 span 还必须包含 `gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.response.finish_reasons`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`llm.retry.count`、`llm.time_to_first_token_ms`，失败时还要包含 `error.type`。如果后端仍使用 AI SDK 属性名，导出器只能在内部规范字段存在后再附加兼容副本。

English: Tool spans must additionally include `tool.name`, `tool.call_id`, `tool.type`, `tool.args.hash`, `tool.args.redaction_reasons`, `tool.result.hash`, `tool.result.redaction_reasons`, `tool.duration_ms`, `tool.success`, `activity_id`, `idempotency_key`, and `error.type` when failed.

中文：工具 span 还必须包含 `tool.name`、`tool.call_id`、`tool.type`、`tool.args.hash`、`tool.args.redaction_reasons`、`tool.result.hash`、`tool.result.redaction_reasons`、`tool.duration_ms`、`tool.success`、`activity_id`、`idempotency_key`，失败时还要包含 `error.type`。

English: Stop-state attributes must appear on `quilin.run`, `quilin.turn`, and the final `quilin.checkpoint`: `loop.stop.category`, `loop.stop.reason`, `loop.stop.terminal`, `loop.stop.retryable`, `loop.stop.resumable`, `loop.stop.error_code`, and `loop.stop.checkpoint_ref`.

中文：终止状态属性必须出现在 `quilin.run`、`quilin.turn` 和最终 `quilin.checkpoint` 上：`loop.stop.category`、`loop.stop.reason`、`loop.stop.terminal`、`loop.stop.retryable`、`loop.stop.resumable`、`loop.stop.error_code` 和 `loop.stop.checkpoint_ref`。

English: Evidence attributes must appear on `quilin.trace_to_eval.build`: `evaluation.fixture_id`, `evaluation.source`, `evaluation.label`, `evaluation.expected_outcome.kind`, `evaluation.assertion.version`, `evaluation.raw_log_required`, and `evaluation.evidence_refs`.

中文：证据属性必须出现在 `quilin.trace_to_eval.build` 上：`evaluation.fixture_id`、`evaluation.source`、`evaluation.label`、`evaluation.expected_outcome.kind`、`evaluation.assertion.version`、`evaluation.raw_log_required` 和 `evaluation.evidence_refs`。

## 五、事件名 / Event Names

English: Event names are the replay surface. The required event names are `turn_started`, `llm_started`, `llm_completed`, `tool_started`, `tool_completed`, `checkpoint_saved`, `interrupt_raised`, `resume_received`, `loop_stopped`, `observability_export_started`, `observability_export_completed`, `observability_export_failed`, and `trace_example_built`.

中文：事件名是回放表面。必需事件名是 `turn_started`、`llm_started`、`llm_completed`、`tool_started`、`tool_completed`、`checkpoint_saved`、`interrupt_raised`、`resume_received`、`loop_stopped`、`observability_export_started`、`observability_export_completed`、`observability_export_failed` 和 `trace_example_built`。

English: Each event must include `event_id`, `event_seq`, `run_id`, `session_id`, `step_id`, `parent_step_id` when available, `trace_id`, `span_id`, `checkpoint_ref` when relevant, and `redaction.level`. `event_seq` is the ordering source of truth; timestamps are display data only.

中文：每个事件必须包含 `event_id`、`event_seq`、`run_id`、`session_id`、`step_id`、可用时的 `parent_step_id`、`trace_id`、`span_id`、相关时的 `checkpoint_ref` 和 `redaction.level`。`event_seq` 是顺序真相源；时间戳只用于展示。

English: Failure events must include `error.type`, `error.code`, `error.retryable`, `error.safe_to_replay`, `loop.stop.category`, `loop.stop.reason`, and `evidence.human_summary`. `evidence.human_summary` is a short redacted explanation, not a copy of raw logs.

中文：失败事件必须包含 `error.type`、`error.code`、`error.retryable`、`error.safe_to_replay`、`loop.stop.category`、`loop.stop.reason` 和 `evidence.human_summary`。`evidence.human_summary` 是简短脱敏解释，不是原始日志副本。

## 六、关联标识符 / Correlation IDs

English: Correlation IDs（关联 ID，指跨组件串联同一运行事实的标识符）must make it possible to move from a Linear issue to a trace, from a trace to a checkpoint, from a checkpoint to a resume token, and from a failed run to an evaluation fixture. The required IDs are `issue_refs`, `run_id`, `session_id`, `turn_id`, `trace_id`, `span_id`, `parent_span_id`, `step_id`, `parent_step_id`, `event_id`, `event_seq`, `checkpoint_ref`, `resume_token_id`, `activity_id`, `idempotency_key`, and `evaluation_fixture_id`.

中文：Correlation IDs（关联 ID，指跨组件串联同一运行事实的标识符）必须支持从 Linear issue 找到 trace、从 trace 找到 checkpoint、从 checkpoint 找到 resume token，以及从失败运行找到评测夹具。必需 ID 包括 `issue_refs`、`run_id`、`session_id`、`turn_id`、`trace_id`、`span_id`、`parent_span_id`、`step_id`、`parent_step_id`、`event_id`、`event_seq`、`checkpoint_ref`、`resume_token_id`、`activity_id`、`idempotency_key` 和 `evaluation_fixture_id`。

English: `issue_refs` must include `QUI-75` for verification fixtures and may include `QUI-66`, `QUI-55`, and `QUI-20` when the trace demonstrates implementation, decision, or backend behavior. This keeps Linear as the task source without creating new issues.

中文：`issue_refs` 对验证夹具必须包含 `QUI-75`，当 trace 展示实现、决策或后端行为时，可以包含 `QUI-66`、`QUI-55` 和 `QUI-20`。这能保持 Linear 是任务源，同时避免新建 issue。

English: `activity_id` and `idempotency_key` are required for tool calls, checkpoint writes, exporter batches, and trace-to-eval conversion. They prove whether a retried operation is a replay of the same activity or a new attempt.

中文：工具调用、检查点写入、导出器批次和 trace-to-eval 转换都必须有 `activity_id` 与 `idempotency_key`。它们用于证明重试操作是同一活动的重放，还是一次新的尝试。

## 七、采样规则 / Sampling Rules

English: Verification fixtures must force sampling to `always_on` so every required span and event is present. The fixture should record `sampling.mode: "verification_always_on"` and `sampling.reason: "QUI-75"` on the root span.

中文：验证夹具必须强制采样为 `always_on`，保证每个必需 span 和事件都存在。夹具应在根 span 上记录 `sampling.mode: "verification_always_on"` 和 `sampling.reason: "QUI-75"`。

English: Production success traces may use deterministic ratio sampling, but production failure, pause, guardrail block, export failure, and evaluation-build failure traces must be retained at 100 percent metadata level. This follows the OpenTelemetry idea that sampling controls trace volume, while Quilin adds a stricter product rule for failures.

中文：生产成功 trace 可以使用确定性比例采样，但生产失败、暂停、安全护栏阻断、导出失败和评测构建失败 trace 必须以 100% 元数据级别保留。这遵循 OpenTelemetry 用采样控制 trace 体量的思路，同时 Quilin 对失败增加更严格的产品规则。

English: Sampling must never happen by inspecting raw prompt text or raw tool output. The decision can use status, stop reason, error type, component, issue reference, and route; content-based sampling is allowed only after redaction has converted content to safe labels or hashes.

中文：采样绝不能通过检查原始 prompt 文本或原始工具输出来决定。采样决策可以使用状态、终止原因、错误类型、组件、issue 引用和路由；只有内容已脱敏成安全标签或哈希后，才允许内容相关采样。

English: If the OTLP exporter（导出器，用来把内部观测记录发送到外部系统的组件）uses head sampling, the local deterministic JSON fixture must still retain all `QUI-75` verification events. Export sampling must not remove local proof.

中文：如果 OTLP exporter（导出器，用来把内部观测记录发送到外部系统的组件）使用 head sampling（头部采样，在 trace 创建时做保留决策），本地确定性 JSON 夹具仍必须保留所有 `QUI-75` 验证事件。导出采样不得删除本地证明。

## 八、脱敏策略 / Redaction Policy

English: `metadata_only` is the default redaction level. It allows IDs, names, token counts, durations, statuses, error classes, checkpoint references, content hashes, and redaction reasons; it forbids raw prompts, raw model output, raw tool arguments, raw tool results, file contents, environment values, credentials, and external account data.

中文：`metadata_only` 是默认脱敏级别。它允许 ID、名称、token 数、耗时、状态、错误类别、检查点引用、内容哈希和脱敏原因；禁止原始 prompt、原始模型输出、原始工具参数、原始工具结果、文件内容、环境变量值、凭证和外部账户数据。

English: `redacted_content` may include sanitized snippets when the fixture needs human-readable context, but every snippet must carry `redaction.applied_rules` and field-level reasons such as `secret_pattern`, `path_policy`, `size_limit`, `credential_like`, `user_private`, or `external_account`.

中文：当夹具需要人类可读上下文时，`redacted_content` 可以包含清理后的片段，但每个片段都必须携带 `redaction.applied_rules`，以及字段级原因，例如 `secret_pattern`、`path_policy`、`size_limit`、`credential_like`、`user_private` 或 `external_account`。

English: `full_content` is disallowed for `QUI-75` verification fixtures unless a later user-approved task explicitly changes the policy. The current verification claim can be proven with metadata, hashes, structured summaries, and synthetic fixture content.

中文：除非后续用户批准的任务明确改变策略，否则 `QUI-75` 验证夹具禁止使用 `full_content`。当前验证主张可以通过元数据、哈希、结构化摘要和合成夹具内容证明。

English: Redaction itself must be observable. The trace must include `redaction.level`, `redaction.policy_version`, `redaction.applied_rules`, `redaction.blocked_fields`, and `redaction.content_hash_algorithm`.

中文：脱敏本身也必须可观测。trace 必须包含 `redaction.level`、`redaction.policy_version`、`redaction.applied_rules`、`redaction.blocked_fields` 和 `redaction.content_hash_algorithm`。

## 九、失败追踪转评测样例 / Failed Trace to Evaluation Fixture

English: The mandatory failed fixture should simulate a safe, deterministic failure: a tool call attempts a write that `WriteAuthority`（写入授权闸门，用来统一审批 shell、文件、脚手架和自进化写入）denies because the run is read-only. The run must stop with `loop.stop.category: "failure"` or `"pause"` depending on whether approval is possible, and `loop.stop.reason` must be `blocked_by_guardrail` or `awaiting_human`.

中文：必需失败夹具应模拟安全、确定性的失败：某个工具调用尝试写入，但 `WriteAuthority`（写入授权闸门，用来统一审批 shell、文件、脚手架和自进化写入）因为当前运行只读而拒绝。该运行必须以 `loop.stop.category: "failure"` 或在可审批时以 `"pause"` 停止，并且 `loop.stop.reason` 必须是 `blocked_by_guardrail` 或 `awaiting_human`。

English: The trace must show this sequence: `turn_started`, `llm_started`, `llm_completed`, `tool_started`, `tool_completed` with denied status, `checkpoint_saved`, `loop_stopped`, `trace_example_built`. The evaluation fixture label should be `unsafe_write_denied` and the expected outcome should be "the agent must not perform the write and must surface the approval or denial reason".

中文：trace 必须展示这个序列：`turn_started`、`llm_started`、`llm_completed`、`tool_started`、拒绝状态的 `tool_completed`、`checkpoint_saved`、`loop_stopped`、`trace_example_built`。评测夹具标签应为 `unsafe_write_denied`，期望结果应是“agent 不得执行写入，并必须暴露审批或拒绝原因”。

English: The fixture must not include raw command output or raw file content. It should include `tool.args.hash`, `tool.result.hash`, `write_authority.decision_id`, `write_authority.decision: "denied"`, `error.type: "permission_denied"`, `redaction.blocked_fields`, and a short `evidence.human_summary`.

中文：夹具不得包含原始命令输出或原始文件内容。它应包含 `tool.args.hash`、`tool.result.hash`、`write_authority.decision_id`、`write_authority.decision: "denied"`、`error.type: "permission_denied"`、`redaction.blocked_fields` 和简短的 `evidence.human_summary`。

English: The evaluation sample must be created from structured trace fields only. The converter should fail closed if it needs to read raw logs to determine expected behavior, failure class, stop state, or redaction outcome.

中文：评测样例必须只从结构化 trace 字段创建。如果转换器需要阅读原始日志才能确定期望行为、失败类别、终止状态或脱敏结果，它必须失败关闭。

## 十、OTLP 导出形状 / OTLP Exporter Output Shape

English: The local exporter may write deterministic JSON lines, but the OTLP-shaped fixture must mirror the OpenTelemetry trace payload structure: `resourceSpans`, `scopeSpans`, `spans`, `attributes`, `events`, and `status`. The exact wire encoding can be Protobuf（Protocol Buffers，一种结构化二进制编码）or JSON, but the field shape must be assertable.

中文：本地导出器可以写确定性 JSON lines（逐行 JSON 记录），但 OTLP 形状的夹具必须镜像 OpenTelemetry trace 载荷结构：`resourceSpans`、`scopeSpans`、`spans`、`attributes`、`events` 和 `status`。实际传输编码可以是 Protobuf（Protocol Buffers，一种结构化二进制编码）或 JSON，但字段形状必须可断言。

English: The minimum OTLP-shaped fixture is:

中文：最小 OTLP 形状夹具如下：

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": {
          "service.name": "quilin-agent",
          "service.version": "local-fixture",
          "deployment.environment.name": "verification"
        }
      },
      "scopeSpans": [
        {
          "scope": {
            "name": "quilin.observability",
            "version": "1"
          },
          "spans": [
            {
              "traceId": "trace_QUI75_unsafe_write_denied",
              "spanId": "span_run",
              "parentSpanId": null,
              "name": "quilin.run",
              "kind": "INTERNAL",
              "attributes": {
                "run_id": "run_QUI75_unsafe_write_denied",
                "session_id": "session_QUI75",
                "issue_refs": ["QUI-75", "QUI-66", "QUI-55", "QUI-20"],
                "loop.stop.category": "pause",
                "loop.stop.reason": "awaiting_human",
                "redaction.level": "metadata_only",
                "sampling.mode": "verification_always_on"
              },
              "events": [
                {
                  "name": "loop_stopped",
                  "attributes": {
                    "event_seq": 7,
                    "checkpoint_ref": "checkpoint_QUI75_final"
                  }
                }
              ],
              "status": {
                "code": "OK"
              }
            }
          ]
        }
      ]
    }
  ]
}
```

English: Exporter assertions must check span count, parent-child links, required attributes, required event names, status codes, redaction fields, sampling fields, and partial-success handling. If an exporter batch is partly rejected, the fixture must record rejected span IDs and retry decisions without mutating the original `LoopStopState`.

中文：导出器断言必须检查 span 数量、父子链接、必需属性、必需事件名、状态码、脱敏字段、采样字段和 partial success（部分成功，指导出批次中部分记录被接收、部分被拒绝）的处理。如果导出批次被部分拒绝，夹具必须记录被拒 span ID 和重试决策，并且不得改变原始 `LoopStopState`。

## 十一、无需人工读原始日志的证明 / Proof That Raw Logs Are Not Required

English: The proof is a machine assertion, not a reviewer judgment. The fixture passes only if the converter can derive `evaluation_fixture_id`, `evaluation.label`, `expected_outcome.kind`, `loop.stop.category`, `loop.stop.reason`, `error.type`, `redaction.level`, and `evidence_refs` from structured spans and events.

中文：证明方式是机器断言，不是评审者判断。只有转换器能从结构化 spans 和 events 派生出 `evaluation_fixture_id`、`evaluation.label`、`expected_outcome.kind`、`loop.stop.category`、`loop.stop.reason`、`error.type`、`redaction.level` 和 `evidence_refs` 时，夹具才算通过。

English: The assertion should explicitly fail when any required field is missing and should report the missing field path. It should not fall back to searching logs, reading captured prompts, parsing shell output, or guessing from span names alone.

中文：断言在任何必需字段缺失时应明确失败，并报告缺失字段路径。它不得回退到搜索日志、读取捕获的 prompt、解析 shell 输出，或仅凭 span 名称猜测。

English: The evidence package should include a `proof.no_raw_log_required: true` attribute and a verifier output with three counters: `structured_fields_used`, `raw_log_bytes_read`, and `fallback_parsers_used`. The required passing values are `structured_fields_used > 0`, `raw_log_bytes_read = 0`, and `fallback_parsers_used = 0`.

中文：证据包应包含 `proof.no_raw_log_required: true` 属性，以及带三个计数器的验证器输出：`structured_fields_used`、`raw_log_bytes_read` 和 `fallback_parsers_used`。通过值必须是 `structured_fields_used > 0`、`raw_log_bytes_read = 0` 和 `fallback_parsers_used = 0`。

English: Human review remains useful for design quality, but it is not required to decide whether a run failed safely. The machine-readable stop state, error type, policy decision, redaction metadata, and expected outcome must be enough.

中文：人工 review（审查，用来判断设计质量和边界风险）仍然有价值，但不应被要求用来判断一次运行是否安全失败。机器可读的终止状态、错误类型、策略裁决、脱敏元数据和期望结果必须足够。

## 十二、验证门槛 / Verification Gates

English: `QUI-75` should accept the document-level plan only after markdown and terminology checks pass. Later implementation should add fixture tests that validate span hierarchy, attribute completeness, event ordering, redaction, sampling, OTLP shape, and trace-to-eval conversion.

中文：`QUI-75` 对本文档级规划的验收，应先通过 Markdown 与术语检查。后续实现应增加夹具测试，验证 span 层级、属性完整性、事件顺序、脱敏、采样、OTLP 形状和 trace-to-eval 转换。

English: The minimum future test names should be `trace_to_eval_success_run_fixture`, `trace_to_eval_unsafe_write_denied_fixture`, `otlp_export_shape_fixture`, `redaction_metadata_only_fixture`, and `sampling_failure_retention_fixture`.

中文：后续最小测试名应为 `trace_to_eval_success_run_fixture`、`trace_to_eval_unsafe_write_denied_fixture`、`otlp_export_shape_fixture`、`redaction_metadata_only_fixture` 和 `sampling_failure_retention_fixture`。

English: The first implementation pass should keep fixtures local and synthetic. Real production traces, external observability backends, and benchmark datasets should wait until `QUI-66` and the relevant component-strengthening work are stable.

中文：第一轮实现应保持夹具本地化和合成化。真实生产 trace、外部可观测性后端和基准测试数据集应等待 `QUI-66` 与相关组件强化工作稳定后再接入。

## 十三、Linear 映射 / Linear Mapping

English: `QUI-75` owns this verification evidence plan, fixture shapes, trace-to-eval proof rules, and the eventual local verifier output. It should collect comments and links, not create additional issues under the free-plan issue cap.

中文：`QUI-75` 负责本验证证据规划、夹具形状、trace-to-eval 证明规则和后续本地验证器输出。它应收集评论和链接，不应在免费版 issue 限额下继续创建额外 issue。

English: `QUI-66` owns implementation of `LoopStepEvent`, `LoopStopState`, checkpoint terminal semantics, AI SDK telemetry mapping, OpenTelemetry GenAI mapping, and local exporter hooks consumed by this plan.

中文：`QUI-66` 负责实现 `LoopStepEvent`（循环步骤事件，用来记录每个模型、工具、检查点、中断和恢复步骤）、`LoopStopState`（循环终止状态，用来统一成功、暂停、失败和取消）、检查点终态语义、AI SDK 遥测映射、OpenTelemetry GenAI 映射，以及本文消费的本地导出钩子。

English: `QUI-55` owns the frontier review decision that selected OpenTelemetry GenAI, OTLP, explicit step events, typed stop states, durable resume, and trace-to-eval as the right observability direction.

中文：`QUI-55` 负责前沿复核决策，即选择 OpenTelemetry GenAI、OTLP、显式步骤事件、类型化终止状态、可恢复运行和 trace-to-eval 作为正确可观测性方向。

English: `QUI-20` owns OTLP Collector（OpenTelemetry 采集器，用来接收、处理和转发遥测数据）recipes, backend experiments, WebUI Dashboard（网页仪表盘，用来展示任务、记忆、指标和拓扑状态）rendering, retention policy, and operational handling for exporter failures.

中文：`QUI-20` 负责 OTLP Collector（OpenTelemetry 采集器，用来接收、处理和转发遥测数据）配方、后端实验、WebUI Dashboard（网页仪表盘，用来展示任务、记忆、指标和拓扑状态）渲染、保留策略，以及导出失败的运维处理。

## 十四、参考来源 / References

English: Primary sources used for this verification plan:

中文：本验证规划使用的一手来源如下：

- [OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) - English: official semantic convention source for model, tool, retrieval, token, content, and error attributes. 中文：模型、工具、检索、token、内容和错误属性的官方语义规范来源。
- [OpenTelemetry OTLP specification](https://opentelemetry.io/docs/specs/otlp/) - English: official transport shape for trace, metric, and log export. 中文：追踪、指标和日志导出的官方传输形状。
- [OpenTelemetry OTLP exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) - English: official exporter configuration and retry-behavior source. 中文：导出器配置与重试行为的官方来源。
- [OpenTelemetry JavaScript sampling](https://opentelemetry.io/docs/languages/js/sampling/) - English: official sampling behavior reference for local TypeScript/JavaScript implementation. 中文：本地 TypeScript/JavaScript 实现可参考的官方采样行为说明。
- [Vercel AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) - English: first-party telemetry source for the SDK Quilin uses for model calls and tool-call spans. 中文：Quilin 用于模型调用和工具调用 span 的 SDK 一手遥测资料。
- [Vercel tracing](https://vercel.com/docs/tracing) - English: first-party reference for exporting traces to third-party observability providers. 中文：把 trace 导出到第三方可观测性后端的一手参考。
