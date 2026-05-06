# 可观测性与核心循环前沿复核 / Observability and Core Loop Frontier Review

> 绑定任务 / Bound task: Linear `QUI-55`
>
> 复核时间 / Review time: 2026-05-02 Asia/Shanghai
>
> 结论类型 / Decision type: 契约吸收建议，不创建新 issue / Contract absorption recommendation, no new issue creation

## 结论 / Verdict

EN: Quilin's current direction remains strategically right: keep the Core Loop small, framework-independent, and observable through peripheral capabilities instead of turning the loop into a fixed state graph. However, the current Observability/Core Loop contract is not yet frontier-strong. The strongest current path is to preserve Quilin's minimal loop while adopting OpenTelemetry GenAI semantic conventions as the primary external observability surface, OTLP as the vendor-neutral transport, explicit step and stop-state contracts as the internal replay surface, and trace-to-eval dataset envelopes as the future benchmark bridge.

中文：Quilin 当前方向在战略上仍然正确：Core Loop（核心循环，负责一次任务执行中消息、模型、工具和检查点流转的最小运行循环）保持小型、框架无关，把可观测性作为外围能力接入，而不是把循环改成固定状态图。但当前 Observability/Core Loop（可观测性与核心循环）契约还不是前沿最强形态。最强路径是保留 Quilin 的极简循环，同时把 OpenTelemetry GenAI semantic conventions（OpenTelemetry 生成式 AI 语义规范）作为主要外部观测语义，把 OTLP（OpenTelemetry Protocol，开放遥测协议）作为厂商中立传输，把显式步骤和终止状态契约作为内部可回放表面，并把 trace-to-eval datasets（从执行轨迹生成评测数据集）作为未来 benchmark（基准测试）的桥梁。

EN: This should be absorbed through existing work only: `QUI-55` for the decision record, `QUI-66` for Core Loop and observability implementation, `QUI-75` for evidence and verification fixtures, and `QUI-20` for exporter/backend/dashboard work. No new Linear issue is needed.

中文：这些吸收工作只应映射到现有任务：`QUI-55` 记录决策，`QUI-66` 承接 Core Loop 与可观测性实现，`QUI-75` 承接证据与验证夹具，`QUI-20` 承接 exporter/backend/dashboard（导出器、后端与仪表盘）工作。不需要新建 Linear issue。

## 当前契约基线 / Current Contract Baseline

EN: The documented Core Loop baseline is a custom minimal TypeScript loop under roughly 200 lines, with no LangGraph dependency and with memory, tools, planning, safety, observability, skills, and mesh treated as peripheral capabilities. The implementation already emits loop hooks such as `loop.turn.start`, `loop.llm.chat`, `loop.tool.execute`, and `loop.checkpoint.save`, and it preserves a resume path through checkpoint-backed sessions.

中文：当前文档化的 Core Loop 基线是一个约 200 行以内的自定义 TypeScript（类型化 JavaScript）极简循环，不依赖 LangGraph（一个把 agent 工作流表达为图的开源框架），并把 memory（记忆）、tools（工具）、planning（规划）、safety（安全）、observability（可观测性）、skills（技能）和 mesh（多智能体网络）视作外围能力。实现已经发出 `loop.turn.start`、`loop.llm.chat`、`loop.tool.execute`、`loop.checkpoint.save` 等循环 hook（钩子事件），并通过基于 checkpoint（检查点）的 session（会话）保留恢复路径。

EN: The documented Observability baseline has JSON structured logging, an in-memory span provider, loop span instrumentation, a JSON file exporter, trace/log context propagation, Python quilin-mem traceparent ingestion, retrieval event dual-emit, and existing frozen benchmark cost/result wiring. It explicitly states that OpenTelemetry-compatible schema/exporter foundations have landed, but full OpenTelemetry SDK integration and the WebUI Dashboard are still deferred.

中文：当前文档化的 Observability 基线包括 JSON（结构化文本数据格式）日志、内存 span provider（跨度提供器，用于记录一段操作的开始、结束和属性）、循环跨度埋点、JSON 文件导出器、trace/log context（追踪与日志上下文）传播、Python quilin-mem（项目记忆服务）对 `traceparent` 的接收、检索事件双写，以及既有且已冻结的 benchmark 成本/结果串联。文档也明确说明：兼容 OpenTelemetry 的 schema/exporter（结构与导出器）基础已经落地，但完整 OpenTelemetry SDK（软件开发工具包）集成和 WebUI Dashboard（网页仪表盘）仍未进入当前切片。

EN: The main contract gaps are visible in code shape. Current span names and attributes are Quilin-specific, such as `agent.session`, `agent.turn`, `llm.invoke`, `tool.invoke`, `llm.provider`, and `llm.tokens_input`. The loop records `finishReason` but does not persist a typed stop state. Checkpoint state currently carries `isTerminal`, but assistant-response checkpoints are built with `isTerminal: false`, so terminal success, pause, error, and interrupt are not yet first-class lifecycle states.

中文：主要契约差距可以从代码形态看出。当前 span 名称与属性仍偏 Quilin 自定义，例如 `agent.session`、`agent.turn`、`llm.invoke`、`tool.invoke`、`llm.provider`、`llm.tokens_input`。循环记录了 `finishReason`（模型结束原因），但没有持久化 typed stop state（类型化终止状态）。checkpoint 状态目前包含 `isTerminal`，但 assistant-response（助手回复）检查点仍构造为 `isTerminal: false`，所以成功终止、暂停、错误和中断还不是一等生命周期状态。

## 来源矩阵 / Source Matrix

| 来源 / Source | 可信度 / Credibility | 对 Quilin 的信号 / Signal for Quilin |
| --- | --- | --- |
| [OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) and [GenAI metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/) | EN: Official OpenTelemetry specification pages, high credibility, but GenAI sections are marked Development. 中文：OpenTelemetry 官方规范页面，可信度高，但 GenAI 章节标记为 Development（仍在演进）。 | EN: Use `gen_ai.*` as the primary external semantic target, but isolate it behind a mapper because field names and event bodies can still change. 中文：应以 `gen_ai.*` 作为主要外部语义目标，但要用映射层隔离，因为字段名和事件体仍可能变化。 |
| [OpenTelemetry OTLP](https://opentelemetry.io/docs/specs/otlp/) and [Collector](https://opentelemetry.io/docs/collector/) | EN: Official OpenTelemetry protocol and collector docs, high credibility; OTLP is the stable vendor-neutral transport. 中文：OpenTelemetry 官方协议与 Collector（采集器）文档，可信度高；OTLP 是稳定的厂商中立传输协议。 | EN: Quilin should export traces, metrics, and logs over OTLP, while keeping the JSON exporter as a local fallback. 中文：Quilin 应通过 OTLP 导出 traces（追踪）、metrics（指标）和 logs（日志），同时保留 JSON 导出器作为本地后备。 |
| [Vercel AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) and [stopping conditions](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#stopping-conditions) | EN: First-party docs for the SDK Quilin already chose, high relevance. 中文：Quilin 已选择的 SDK 的一手文档，相关性很高。 | EN: AI SDK already exposes telemetry, tool spans, finish reasons, and multi-step controls such as `stopWhen`; Quilin should align rather than invent incompatible wrappers. 中文：AI SDK 已提供遥测、工具跨度、结束原因和 `stopWhen` 等多步骤控制；Quilin 应对齐而不是发明不兼容包装。 |
| [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), and [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | EN: First-party docs for a widely used open-source agent workflow runtime, high credibility for lifecycle patterns. 中文：广泛使用的开源 agent 工作流运行时一手文档，对生命周期模式有高参考价值。 | EN: Do not adopt the framework, but copy the durable execution vocabulary: checkpoint, thread, next tasks, interrupt payload, and resume command. 中文：不应引入该框架，但应吸收 durable execution（持久执行）的词汇：检查点、线程、下一步任务、中断载荷和恢复命令。 |
| [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/) and [human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) | EN: First-party agent SDK docs, high credibility for agent tracing and interruption contracts. 中文：一手 agent SDK 文档，对 agent 追踪与中断契约可信度高。 | EN: Traces, agent runs, model calls, tool calls, guardrails, serializable interruptions, and resumable run state are now expected primitives. 中文：trace、agent run（智能体运行）、模型调用、工具调用、guardrail（护栏）、可序列化中断和可恢复运行状态已经成为预期基础能力。 |
| [OpenInference semantic conventions](https://arize-ai.github.io/openinference/spec/semantic_conventions.html) and [Phoenix](https://github.com/Arize-ai/phoenix) | EN: Open-source AI observability conventions and platform, medium-high credibility; useful where OpenTelemetry GenAI is not yet complete. 中文：开源 AI 可观测性约定与平台，可信度中高；适合补足 OpenTelemetry GenAI 尚未覆盖的部分。 | EN: Use OpenInference attributes as supplemental labels for `AGENT`, `TOOL`, `RETRIEVER`, `EVALUATOR`, and graph node concepts when official OTel fields are missing. 中文：当 OTel 官方字段缺失时，可用 OpenInference 属性补充 `AGENT`（智能体）、`TOOL`（工具）、`RETRIEVER`（检索器）、`EVALUATOR`（评测器）和图节点概念。 |
| [MLflow GenAI datasets](https://mlflow.org/docs/latest/genai/datasets/) | EN: Official docs from a mature open-source ML platform, high credibility for trace-to-eval workflow. 中文：成熟开源机器学习平台的官方文档，对 trace-to-eval 工作流可信度高。 | EN: Production traces can become evaluation datasets; Quilin should define the trace example envelope now, even if full benchmark execution comes later. 中文：生产轨迹可以转为评测数据集；即使完整 benchmark 后置，Quilin 也应现在定义 trace example（轨迹样本）信封。 |
| [Langfuse OpenTelemetry](https://langfuse.com/docs/observability/sdk/opentelemetry) and [datasets](https://langfuse.com/docs/datasets/overview) | EN: Official docs from a popular open-source LLM observability platform, medium-high credibility with vendor-specific bias. 中文：热门开源 LLM 可观测性平台的一手文档，可信度中高，但带有供应商视角。 | EN: OTel ingestion plus trace-derived datasets and linked evaluation runs are practical integration targets. 中文：OTel 接入、由 trace 生成 dataset（数据集）以及可回链的评测运行，是现实可集成目标。 |
| [OpenHands SDK agent architecture](https://docs.openhands.dev/sdk/arch/agent) | EN: First-party docs from a major open-source coding-agent project, medium-high credibility for event-sourced agent loops. 中文：主流开源 coding agent（一类编程智能体）项目的一手文档，对事件溯源式循环有中高参考价值。 | EN: Append-only event logs make replay, debugging, and later dataset generation easier without forcing a graph runtime. 中文：append-only event log（只追加事件日志）能改善回放、调试和后续数据集生成，同时不强制引入图运行时。 |

## 证据与判断 / Evidence and Decisions

### 生成式 AI 观测与 OTLP / OpenTelemetry GenAI and OTLP

EN: OpenTelemetry GenAI spans and metrics are now the most credible common language for LLM observability, but they are still marked Development. Quilin should therefore keep stable internal domain events, then map them outward to `gen_ai.*` attributes and events through a versioned adapter. This preserves Quilin's own contract while allowing current backends to understand model calls, tool executions, token usage, finish reasons, and latency.

中文：OpenTelemetry GenAI spans 与 metrics 目前是 LLM（大型语言模型）可观测性最可信的通用语言，但仍标记为 Development。Quilin 因此应保留稳定的内部领域事件，再通过带版本的 adapter（适配器，用于把内部结构转换成外部协议）映射到 `gen_ai.*` 属性与事件。这样既保住 Quilin 自身契约，也能让现有后端理解模型调用、工具执行、token（模型文本计量单位）使用、结束原因和延迟。

EN: OTLP is stable and should become the transport boundary. The practical contract is: internal step events and spans are collected once, then exported through OTLP for traces, metrics, and logs, with JSON files retained for local debugging and deterministic fixtures. OTLP partial-success behavior also matters because exporters must not blindly retry records the collector has explicitly rejected.

中文：OTLP 是稳定协议，应成为传输边界。实际契约应是：内部 step events（步骤事件）与 spans 只采集一次，然后通过 OTLP 导出 traces、metrics 与 logs，同时保留 JSON 文件用于本地调试和确定性夹具。OTLP 的 partial success（部分成功）语义也重要，因为导出器不能盲目重试 collector 已明确拒收的记录。

### 轨迹转评测数据集 / Trace-to-Eval Datasets

EN: MLflow, Langfuse, and Phoenix all point in the same direction: useful evaluations increasingly start from real traces, then become curated datasets and repeatable runs. Quilin should not prioritize full benchmark execution before component absorption, but it should shape traces so future evaluation datasets are cheap to build.

中文：MLflow、Langfuse 和 Phoenix 都指向同一个方向：有用评测越来越多地从真实 trace 出发，再转为 curated dataset（人工筛选的数据集）和可重复运行。Quilin 现在不应把完整 benchmark 执行置于组件吸收之前，但应让 trace 结构天然适合未来生成评测数据集。

EN: The minimum useful envelope is a `TraceExample` containing input messages, model output, tool calls, stop state, selected span IDs, redaction policy, optional expected output, optional human or automated scores, and source metadata. This is a data contract, not a benchmark runner.

中文：最小可用信封是 `TraceExample`，包含输入消息、模型输出、工具调用、终止状态、被选中的 span ID、redaction policy（脱敏策略）、可选期望输出、可选人工或自动评分，以及来源元数据。这是数据契约，不是 benchmark runner（基准执行器）。

### 显式终止状态 / Explicit Stop States

EN: A loop that only returns content or throws errors cannot support strong observability, durable pause, or reproducible evaluation. Quilin needs a typed `LoopStopState` with a terminal category and reason. Suggested reasons are `assistant_final`, `tool_calls_pending`, `max_turns_exceeded`, `token_budget_exceeded`, `awaiting_human`, `user_interrupt`, `blocked_by_guardrail`, `llm_error`, `tool_error`, `checkpoint_error`, and `cancelled`.

中文：如果循环只返回内容或抛出错误，就无法支撑强可观测性、持久暂停或可复现实验。Quilin 需要类型化的 `LoopStopState`，包含终止类别和原因。建议原因包括 `assistant_final`（助手完成）、`tool_calls_pending`（等待工具调用）、`max_turns_exceeded`（超过最大轮数）、`token_budget_exceeded`（超过 token 预算）、`awaiting_human`（等待人工）、`user_interrupt`（用户中断）、`blocked_by_guardrail`（被安全护栏阻止）、`llm_error`（模型错误）、`tool_error`（工具错误）、`checkpoint_error`（检查点错误）和 `cancelled`（取消）。

EN: This stop state should be persisted in checkpoints, attached to final spans, exported as an event, and included in trace-to-eval examples. It should replace ambiguous combinations of `finishReason`, `loopSucceeded`, and `isTerminal`.

中文：该终止状态应写入 checkpoint，附着到最终 span，作为事件导出，并进入 trace-to-eval 样本。它应取代 `finishReason`、`loopSucceeded` 和 `isTerminal` 之间含义模糊的组合。

### 步骤事件 / Step Events

EN: The strongest open-source systems expose more than spans: they expose step-level lifecycle events. Quilin already has hooks, but they should become a stable event schema with `run_id`, `session_id`, `turn_id`, `step_id`, `step_index`, `parent_step_id`, `kind`, `status`, `checkpoint_ref`, `trace_id`, `span_id`, and optional `stop_state` or `interrupt` payloads.

中文：最强开源系统不只暴露 spans，还暴露步骤级生命周期事件。Quilin 已有 hooks，但应升级为稳定事件 schema（结构契约），包含 `run_id`（一次执行标识）、`session_id`（会话标识）、`turn_id`（轮次标识）、`step_id`（步骤标识）、`step_index`（步骤序号）、`parent_step_id`（父步骤标识）、`kind`（步骤类型）、`status`（状态）、`checkpoint_ref`（检查点引用）、`trace_id`（追踪标识）、`span_id`（跨度标识），以及可选 `stop_state` 或 `interrupt` 载荷。

EN: The first stable event names should cover `turn_started`, `llm_started`, `llm_completed`, `tool_started`, `tool_completed`, `checkpoint_saved`, `interrupt_raised`, `resume_received`, and `loop_stopped`. This is enough for debugging, WebUI streaming, replay, and future dataset extraction without turning the core loop into a graph engine.

中文：第一批稳定事件名应覆盖 `turn_started`、`llm_started`、`llm_completed`、`tool_started`、`tool_completed`、`checkpoint_saved`、`interrupt_raised`、`resume_received` 和 `loop_stopped`。这足以支撑调试、WebUI streaming（网页实时流）、回放和未来数据集抽取，同时不把核心循环改造成图引擎。

### 中断与恢复 / Interrupt and Resume

EN: Current CLI resume restores a session, but it is not yet a durable interrupt/resume protocol. LangGraph and OpenAI Agents SDK both show the necessary pieces: serializable interrupt payloads, checkpoint references, a resume command or token, and a run state that can continue after human input.

中文：当前 CLI resume（命令行恢复）能够恢复 session，但还不是 durable interrupt/resume（持久中断与恢复）协议。LangGraph 和 OpenAI Agents SDK 都展示了必要元素：可序列化的中断载荷、检查点引用、resume command/token（恢复命令或令牌），以及可以在人工输入后继续的运行状态。

EN: Quilin should model interruption as a pause stop state, not as an error. A paused loop should record who or what requested the pause, what input is required, what checkpoint must be resumed, and whether the resume path is single-use or reusable.

中文：Quilin 应把中断建模为 pause（暂停）终止状态，而不是 error（错误）。暂停的循环应记录谁或什么请求了暂停、需要什么输入、必须从哪个检查点恢复，以及恢复路径是一次性还是可复用。

## Quilin 当前差距 / Current Quilin Gaps

| 差距 / Gap | 证据 / Evidence | 风险 / Risk | 既有 Linear 映射 / Existing Linear Mapping |
| --- | --- | --- | --- |
| EN: Custom observability attributes are not yet aligned to OpenTelemetry GenAI. 中文：自定义可观测性属性尚未对齐 OpenTelemetry GenAI。 | EN: Current attributes include `llm.provider`, `llm.tokens_input`, and `tool.name` rather than canonical `gen_ai.*` mappings. 中文：当前属性包括 `llm.provider`、`llm.tokens_input`、`tool.name`，而不是规范化 `gen_ai.*` 映射。 | EN: Backend fragmentation and hard-to-query traces. 中文：后端割裂，trace 查询困难。 | `QUI-66`, `QUI-75`, `QUI-20` |
| EN: There is no OTLP exporter path yet. 中文：尚无 OTLP 导出路径。 | EN: The current exporter is JSON-file oriented, with OpenTelemetry-compatible foundations but no full SDK/exporter integration. 中文：当前导出偏 JSON 文件，已有 OpenTelemetry 兼容基础，但还没有完整 SDK/exporter 集成。 | EN: Quilin cannot plug cleanly into Collector, Phoenix, Langfuse, Jaeger, or other OTel backends. 中文：Quilin 不能顺畅接入 Collector、Phoenix、Langfuse、Jaeger 或其他 OTel 后端。 | `QUI-20`, `QUI-66` |
| EN: Step events are hooks, not a stable contract. 中文：步骤事件仍是 hook，不是稳定契约。 | EN: Hook names exist, but event IDs, parent/child relation, checkpoint reference, and status semantics are not normalized. 中文：已有 hook 名称，但事件 ID、父子关系、检查点引用和状态语义尚未规范化。 | EN: Replay, WebUI streaming, and trace-to-eval extraction remain brittle. 中文：回放、WebUI 实时流和 trace-to-eval 抽取会比较脆弱。 | `QUI-66`, `QUI-75` |
| EN: Stop states are implicit. 中文：终止状态仍是隐式的。 | EN: `finishReason`, `loopSucceeded`, and `isTerminal` do not describe success, pause, failure, cancellation, and guardrail blocks consistently. 中文：`finishReason`、`loopSucceeded` 与 `isTerminal` 不能一致描述成功、暂停、失败、取消和安全阻断。 | EN: Checkpoints and eval records can disagree about what actually happened. 中文：checkpoint 与评测记录可能对真实结果产生歧义。 | `QUI-66`, `QUI-75` |
| EN: Assistant-response checkpoints are not terminal. 中文：助手回复检查点不是终止态。 | EN: The checkpoint builder currently returns `isTerminal: false` even for assistant response states. 中文：checkpoint 构造器当前即使对助手回复状态也返回 `isTerminal: false`。 | EN: Session resume and lifecycle dashboards may misrepresent completed runs. 中文：会话恢复与生命周期仪表盘可能误报已完成运行。 | `QUI-66` |
| EN: Durable interrupt/resume is missing. 中文：缺少持久中断/恢复。 | EN: CLI resume restores sessions, but there is no interrupt payload, resume token, required input schema, or pause reason. 中文：CLI resume 能恢复会话，但没有中断载荷、恢复令牌、所需输入结构或暂停原因。 | EN: Human-in-the-loop workflows cannot be represented cleanly. 中文：human-in-the-loop（人工参与）工作流无法被清晰表示。 | `QUI-66`, `QUI-75` |
| EN: Trace-to-eval envelope is absent. 中文：缺少 trace-to-eval 信封。 | EN: Benchmark cost/result wiring exists, but there is no reusable trace example contract. 中文：已有 benchmark 成本/结果串联，但没有可复用的轨迹样本契约。 | EN: Future eval datasets may require lossy backfills from raw logs. 中文：未来评测数据集可能需要从原始日志中有损回填。 | `QUI-75`, `QUI-20` |
| EN: Content capture and redaction policy are not explicit. 中文：内容采集与脱敏策略不显式。 | EN: OpenTelemetry GenAI events support message content capture, but the spec warns that this must be controlled because prompts and tool outputs can be sensitive. 中文：OpenTelemetry GenAI 事件支持消息内容采集，但规范提醒必须受控，因为 prompt（提示词）和工具输出可能敏感。 | EN: Observability could leak private user, tool, or credential data. 中文：可观测性可能泄露用户、工具或凭据相关私密数据。 | `QUI-20`, `QUI-66` |

## 内化建议 / Internalization Recommendations

### 必须 / Must

EN: Add an OpenTelemetry GenAI mapping layer that translates Quilin's internal loop, model, tool, and checkpoint events to current `gen_ai.*` spans, events, and metrics. Keep this as a versioned boundary because the GenAI semantic conventions are still in Development.

中文：增加 OpenTelemetry GenAI 映射层，把 Quilin 内部的循环、模型、工具和检查点事件转换为当前 `gen_ai.*` spans、events 和 metrics。因为 GenAI 语义规范仍在 Development，应把该层作为带版本的边界。

EN: Add an OTLP exporter path for traces, metrics, and logs, with OpenTelemetry Collector compatibility as the baseline. Keep the JSON exporter for local fixture generation and offline debugging.

中文：增加 traces、metrics 与 logs 的 OTLP 导出路径，并以兼容 OpenTelemetry Collector 为基线。保留 JSON 导出器用于本地夹具生成和离线调试。

EN: Introduce `LoopStopState` and persist it in checkpoints, final spans, and loop-stop events. Treat pause, interrupt, blocked-by-guardrail, max-turns, model error, tool error, and cancellation as distinct states.

中文：引入 `LoopStopState` 并写入 checkpoints、最终 spans 与 loop-stop events。把暂停、中断、安全护栏阻断、超过最大轮数、模型错误、工具错误和取消视为不同状态。

EN: Promote loop hooks into a stable `LoopStepEvent` schema. Every model call, tool call, checkpoint write, interrupt, resume, and final stop should have a step ID, parent relationship, status, trace/span reference, and checkpoint reference where applicable.

中文：把循环 hook 升级为稳定的 `LoopStepEvent` schema。每次模型调用、工具调用、检查点写入、中断、恢复和最终终止，都应具有步骤 ID、父子关系、状态、trace/span 引用，以及适用时的 checkpoint 引用。

EN: Define a minimal `TraceExample` envelope now, but keep full benchmark execution later. The envelope should include selected trace references, input/output, tool calls, stop state, redaction metadata, optional expectations, and optional scores.

中文：现在定义最小 `TraceExample` 信封，但把完整 benchmark 执行后置。该信封应包含选中的 trace 引用、输入/输出、工具调用、终止状态、脱敏元数据、可选期望值和可选评分。

### 应该 / Should

EN: Supplement official OpenTelemetry fields with OpenInference labels only where OpenTelemetry GenAI is incomplete, especially for `AGENT`, `RETRIEVER`, `EVALUATOR`, graph node, and retrieval document concepts.

中文：仅在 OpenTelemetry GenAI 尚不完整的地方，用 OpenInference 标签补充官方字段，尤其是 `AGENT`、`RETRIEVER`、`EVALUATOR`、graph node（图节点）和检索文档概念。

EN: Align Vercel AI SDK telemetry and multi-step controls with Quilin's loop contract. AI SDK `finishReason`, token usage, tool spans, `stopWhen`, and step completion hooks should feed the same `LoopStepEvent` and `LoopStopState` surfaces.

中文：把 Vercel AI SDK 的遥测与多步骤控制对齐到 Quilin 循环契约。AI SDK 的 `finishReason`、token 使用、工具 span、`stopWhen` 和步骤完成 hook 应汇入同一套 `LoopStepEvent` 与 `LoopStopState` 表面。

EN: Add verification fixtures that simulate LangGraph-style interrupts and OpenAI-style serializable run state without adopting either runtime. The fixture should prove that Quilin can pause, persist, resume, and export the same lifecycle.

中文：增加验证夹具，模拟 LangGraph 风格中断与 OpenAI 风格可序列化运行状态，但不引入任一运行时。夹具应证明 Quilin 能暂停、持久化、恢复并导出同一生命周期。

EN: Provide a developer recipe for sending local OTLP traces to Phoenix or Langfuse through an OpenTelemetry Collector. This belongs to exporter/backend/dashboard work, not to the loop core.

中文：提供开发者配方，把本地 OTLP trace 通过 OpenTelemetry Collector 发送到 Phoenix 或 Langfuse。这属于 exporter/backend/dashboard 工作，不属于循环核心。

### 可以 / Could

EN: Add an append-only event log mode inspired by OpenHands to improve forensic debugging and later dataset curation. This can be a derived sink from `LoopStepEvent`, not a new source of truth.

中文：可以借鉴 OpenHands 增加 append-only event log 模式，以改善事后调试和后续数据集筛选。它可以是从 `LoopStepEvent` 派生的 sink（输出端），而不是新的真相源。

EN: Add evaluator spans and feedback events after the basic trace pipeline is stable. This would let Quilin record human feedback, automatic graders, and regression labels near the traces that produced them.

中文：在基础 trace 管线稳定后，可以增加 evaluator spans（评测器跨度）和 feedback events（反馈事件）。这样 Quilin 可以把人工反馈、自动评分器和回归标签记录在产生它们的 trace 附近。

EN: Add UI dataset curation later in WebUI Dashboard. The contract should come first; the interface can follow once trace export and trace-to-eval envelopes are reliable.

中文：后续可以在 WebUI Dashboard 中增加数据集筛选界面。契约应先行；等 trace 导出与 trace-to-eval 信封可靠后，再做界面。

## 推荐契约草案 / Recommended Contract Sketch

EN: The following sketch is intentionally small. It keeps the core loop minimal while giving observability, checkpointing, resume, and evaluation a shared vocabulary.

中文：下面的草案刻意保持小型。它让核心循环维持极简，同时给可观测性、检查点、恢复和评测提供共享词汇。

```ts
type LoopStepKind =
  | "turn"
  | "llm"
  | "tool"
  | "checkpoint"
  | "interrupt"
  | "resume"
  | "stop";

type LoopStepStatus = "started" | "succeeded" | "failed" | "paused" | "cancelled";

interface LoopStepEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly parentStepId?: string;
  readonly kind: LoopStepKind;
  readonly status: LoopStepStatus;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly checkpointRef?: string;
  readonly stopState?: LoopStopState;
  readonly interrupt?: LoopInterrupt;
}

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
  | "cancelled";

interface LoopStopState {
  readonly category: StopCategory;
  readonly reason: StopReason;
  readonly terminal: boolean;
  readonly retryable: boolean;
  readonly finishReason?: string;
  readonly checkpointRef?: string;
  readonly resumeToken?: string;
}

interface LoopInterrupt {
  readonly interruptId: string;
  readonly requestedBy: "user" | "tool" | "guardrail" | "system";
  readonly requiredInputSchema?: unknown;
  readonly prompt?: string;
  readonly resumeToken: string;
}

interface TraceExample {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly rootSpanId?: string;
  readonly sessionId: string;
  readonly source: "production" | "manual" | "benchmark" | "regression";
  readonly input: unknown;
  readonly output?: unknown;
  readonly toolCalls?: readonly unknown[];
  readonly stopState: LoopStopState;
  readonly redactionPolicy: "metadata_only" | "redacted_content" | "full_content";
  readonly expectedOutput?: unknown;
  readonly scores?: readonly unknown[];
}
```

## 既有 Linear 映射 / Existing Linear Mapping

EN: `QUI-55` should own this frontier review and the final absorption decision. It should not accumulate implementation subtasks beyond links and comments.

中文：`QUI-55` 应负责本次前沿复核与最终吸收决策。它不应继续堆积实现子任务，只保留链接和 comment。

EN: `QUI-66` should own implementation of `LoopStepEvent`, `LoopStopState`, checkpoint lifecycle fixes, AI SDK telemetry alignment, and interrupt/resume contracts.

中文：`QUI-66` 应负责实现 `LoopStepEvent`、`LoopStopState`、checkpoint 生命周期修正、AI SDK 遥测对齐，以及中断/恢复契约。

EN: `QUI-75` should own verification evidence: OpenTelemetry GenAI mapping fixtures, OTLP export fixtures, trace-to-eval envelope fixtures, and interrupt/resume replay fixtures.

中文：`QUI-75` 应负责验证证据：OpenTelemetry GenAI 映射夹具、OTLP 导出夹具、trace-to-eval 信封夹具，以及中断/恢复回放夹具。

EN: `QUI-20` should own exporter/backend/dashboard work: OTLP Collector recipes, Phoenix or Langfuse backend experiments, dashboard rendering, retention, and content redaction policy.

中文：`QUI-20` 应负责 exporter/backend/dashboard 工作：OTLP Collector 配方、Phoenix 或 Langfuse 后端实验、仪表盘渲染、保留策略和内容脱敏策略。

## 参考链接 / References

EN: Primary and first-party sources used for this review:

中文：本次复核使用的一手与官方来源如下：

- [OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) - EN: official specification, high credibility, Development status. 中文：官方规范，可信度高，状态为 Development。
- [OpenTelemetry GenAI metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/) - EN: official specification, high credibility, Development status. 中文：官方规范，可信度高，状态为 Development。
- [OpenTelemetry OTLP specification](https://opentelemetry.io/docs/specs/otlp/) - EN: official protocol specification, high credibility, stable transport boundary. 中文：官方协议规范，可信度高，是稳定传输边界。
- [OpenTelemetry Collector documentation](https://opentelemetry.io/docs/collector/) - EN: official collector documentation, high credibility. 中文：官方采集器文档，可信度高。
- [Vercel AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) - EN: first-party SDK documentation, high relevance because Quilin uses Vercel AI SDK. 中文：SDK 一手文档；因为 Quilin 使用 Vercel AI SDK，相关性很高。
- [Vercel AI SDK stopping conditions](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#stopping-conditions) - EN: first-party SDK documentation for multi-step control. 中文：多步骤控制的一手 SDK 文档。
- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) - EN: first-party open-source runtime documentation. 中文：开源运行时的一手文档。
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) - EN: first-party durable execution documentation. 中文：持久执行的一手文档。
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) - EN: first-party interrupt/resume documentation. 中文：中断与恢复的一手文档。
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/) - EN: first-party tracing documentation. 中文：追踪能力的一手文档。
- [OpenAI Agents SDK human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) - EN: first-party interruption and resume documentation. 中文：中断与恢复能力的一手文档。
- [OpenInference semantic conventions](https://arize-ai.github.io/openinference/spec/semantic_conventions.html) - EN: open-source AI observability conventions. 中文：开源 AI 可观测性约定。
- [Arize Phoenix GitHub repository](https://github.com/Arize-ai/phoenix) - EN: open-source AI observability and evaluation platform. 中文：开源 AI 可观测性与评测平台。
- [MLflow GenAI datasets](https://mlflow.org/docs/latest/genai/datasets/) - EN: official open-source ML platform documentation for trace-derived datasets. 中文：开源机器学习平台的官方文档，覆盖从 trace 生成数据集。
- [Langfuse OpenTelemetry integration](https://langfuse.com/docs/observability/sdk/opentelemetry) - EN: official LLM observability platform documentation. 中文：LLM 可观测性平台的官方文档。
- [Langfuse datasets](https://langfuse.com/docs/datasets/overview) - EN: official trace-to-dataset documentation. 中文：trace 转数据集的官方文档。
- [OpenHands SDK agent architecture](https://docs.openhands.dev/sdk/arch/agent) - EN: first-party open-source coding-agent architecture documentation. 中文：开源 coding agent 架构的一手文档。
