# Planning 可恢复运行时前沿评估 / Planning Durable Runtime Frontier Review

Research timestamp: 2026-05-02 Asia/Shanghai workspace time. This review is bound to Linear [QUI-50](https://linear.app/quilin-agent/issue/QUI-50/f0planning-durable-execution-与-typed-handoff-决策-decide-planning) and does not create new Linear issues.

调研时间：2026-05-02（工作区 Asia/Shanghai 时间）。本评估绑定 Linear [QUI-50](https://linear.app/quilin-agent/issue/QUI-50/f0planning-durable-execution-与-typed-handoff-决策-decide-planning)，不新建 Linear issue。

## 结论 / Decision

Quilin's current Planning + Durable Runtime direction is still strong, but only if Planning owns the durable contract and the runtime owns execution. Planning should decide the structured plan, recovery cursor, typed handoff, retry intent, and cancellation policy; the Durable Runtime should own queues, leases, heartbeat, checkpoint persistence, resume, cancellation delivery, retry execution, and parent/child completion delivery.

Quilin 当前 Planning + Durable Runtime 方向仍然成立，但前提是 Planning 只拥有可恢复契约，runtime 拥有实际执行。Planning 应决定结构化计划、恢复游标、结构化任务移交、重试意图和取消策略；Durable Runtime 应拥有队列、租约、心跳、检查点持久化、恢复、取消投递、重试执行，以及父子 Agent 完成交付。

The strongest frontier pattern is not "adopt LangGraph" or "adopt Temporal wholesale." It is a local-first, minimal TypeScript（TS, the project's primary agent-core language）runtime that absorbs five proven ideas: LangGraph-style checkpoint cursors, OpenAI Agents-style typed handoffs and resumable run state, Temporal-style event history and activity boundaries, Cloudflare Agents-style actor identity and plan-as-durability, and OpenHands-style typed append-only event logs plus sandboxed action/observation boundaries.

最强前沿模式不是“整体采用 LangGraph”或“整体采用 Temporal”。更适合 Quilin 的方案是本机优先、最小 TypeScript（TS，本项目 agent-core 的主要语言）runtime，并吸收五类已验证经验：LangGraph 风格的检查点游标、OpenAI Agents 风格的 typed handoff（结构化任务移交，指带 schema 的子 Agent 转交输入/历史过滤/结果边界）和可恢复 RunState（可序列化运行状态）、Temporal 风格的事件历史与 activity boundary（副作用执行边界）、Cloudflare Agents 风格的 actor identity（可寻址长期实体身份）与“计划即恢复机制”，以及 OpenHands 风格的 typed append-only event log（带类型的只追加事件日志）和沙箱 action/observation（动作/观察）边界。

## 现状 / Current State

Quilin already has a PlanningState event log, checkpoint events, retry budget fields, goal-drift events, and a rule-based delegation strategy in `packages/agent-core/src/planning/`. The current spec also says Planning is event-sourced and checkpoints can reconstruct state.

Quilin 已有 `packages/agent-core/src/planning/` 下的 PlanningState 事件日志、checkpoint 事件、retry budget（重试预算）字段、goal drift（目标漂移）事件，以及规则化 delegation（任务下放）策略。现有 spec 也声明 Planning 是 event-sourced（事件溯源，指通过事件回放重建状态），checkpoint 可重建状态。

The gap is that Quilin has planning-time durability, not runtime durability. It can describe events and candidate handoffs, but it does not yet define a durable worker state machine, parent/child inbox-outbox delivery, typed handoff filters, cancellation heartbeats, retryable activity boundaries, or a recovery cursor that can restart a child run without relying on in-memory context.

差距在于 Quilin 目前具备 planning-time durability（规划阶段可恢复性），还没有 runtime durability（执行阶段可恢复性）。它能描述事件和候选 handoff，但尚未定义 durable worker state machine（可恢复 worker 状态机）、父子 inbox-outbox（收件箱/发件箱）交付、typed handoff filters（结构化移交输入过滤）、取消心跳、可重试 activity boundary，以及不依赖内存上下文即可重启子运行的 recovery cursor（恢复游标）。

## 来源矩阵 / Source Matrix

Star counts are approximate observations from GitHub repository pages during this review, because unauthenticated GitHub API access was rate-limited.

星标数是本次调研期间从 GitHub 仓库页面观察到的近似值，因为未认证 GitHub API（Application Programming Interface，应用程序接口）访问遇到 rate limit（速率限制）。

| 来源 / Source | 可信度 / Credibility | 前沿信号 / Frontier signal | Quilin 内化 / Quilin absorption |
|---|---:|---|---|
| [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | High: official docs / 高：官方文档 | Checkpointer + thread_id gives durable execution, replay, interrupts, and time travel.<br>Checkpointer（检查点保存器）+ thread_id（线程标识）提供可恢复执行、重放、中断和时间旅行调试。GitHub: [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph), about 31k stars, latest release observed May 1, 2026. | Keep Quilin's linear-first plan, but add `run_id/thread_id`, `checkpoint_ns`, and explicit resume payloads.<br>保留 Quilin 的 linear-first plan，但补充 `run_id/thread_id`、`checkpoint_ns` 和显式 resume payload（恢复载荷）。 |
| [OpenAI Agents SDK（Software Development Kit，软件开发工具包） overview](https://openai.github.io/openai-agents-python/), [handoffs](https://openai.github.io/openai-agents-python/handoffs/), [results](https://openai.github.io/openai-agents-python/results/), [sessions](https://openai.github.io/openai-agents-python/sessions/) | High: official OpenAI docs / 高：OpenAI 官方文档 | Handoffs are tool-shaped, can carry `input_type`, can filter history, expose `RunState`, interruptions, cancel, sessions, and sandbox-session resume.<br>handoff 以工具形态暴露，可携带 `input_type`、过滤历史、暴露 RunState（可序列化运行状态）、中断、取消、session（会话）和 sandbox session（沙箱会话）恢复。GitHub: [openai/openai-agents-python](https://github.com/openai/openai-agents-python), about 25.7k stars; [openai/openai-agents-js](https://github.com/openai/openai-agents-js), about 2.9k stars. | Make handoff a schema-validated envelope, not prose. Preserve `new_items`-like audit data and `to_state`-like resumable state.<br>把 handoff 做成 schema 校验的 envelope（封包），而不是自然语言摘要；保留类似 `new_items` 的审计数据和类似 `to_state` 的可恢复状态。 |
| [Temporal Workflows](https://docs.temporal.io/workflows), [Event History](https://docs.temporal.io/encyclopedia/event-history), [TypeScript cancellation](https://docs.temporal.io/develop/typescript/workflows/cancellation), [retry/timeouts](https://docs.temporal.io/develop/typescript/workflows/timeouts), [child workflows](https://docs.temporal.io/develop/typescript/workflows/child-workflows), [message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing) | High: official docs / 高：官方文档 | Durable execution comes from event history, deterministic replay, activity retry policy, cancellation heartbeats, child workflow handles, signals, queries, updates, and Continue-As-New.<br>可恢复执行来自 event history（事件历史）、deterministic replay（确定性重放）、activity retry policy（活动重试策略）、取消心跳、child workflow handle（子工作流句柄）、signal/query/update（信号/查询/更新）和 Continue-As-New（以新运行续接旧运行）。GitHub: [temporalio/temporal](https://github.com/temporalio/temporal), about 20k stars; [temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript), about 831 stars. | Do not adopt the service now; copy the semantics: deterministic planner replay, idempotent activity keys, child handles, signals, and heartbeat-gated cancellation.<br>现在不引入 Temporal 服务；只复制语义：确定性 planner 重放、幂等 activity key、子句柄、信号，以及由心跳门控的取消。 |
| [Cloudflare Agents durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/), [long-running agents](https://developers.cloudflare.com/agents/concepts/long-running-agents/), [Agent Workflows](https://developers.cloudflare.com/agents/api-reference/run-workflows/), [Workflows retry/sleep](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) | High: official docs / 高：官方文档 | Durable Objects make agents addressable durable identities; `runFiber()` + `stash()` + `onFiberRecovered()` recover in-agent work; Workflows provide step-level retry, pause/resume, and external events.<br>Durable Objects（Cloudflare 的有状态边缘对象）让 Agent 成为可寻址的持久身份；`runFiber()` + `stash()` + `onFiberRecovered()` 恢复 Agent 内部工作；Workflows 提供步骤级重试、暂停/恢复和外部事件。GitHub: [cloudflare/agents](https://github.com/cloudflare/agents), about 4.9k stars. | Use actor-like `agent_id + run_id` identity, stash continuation summaries, and treat the structured plan as the recovery context.<br>使用类似 actor 的 `agent_id + run_id` 身份，保存 continuation summary（续接摘要），并把结构化计划当作恢复上下文。 |
| [OpenHands SDK architecture](https://docs.openhands.dev/sdk/arch/sdk), [events](https://docs.openhands.dev/sdk/arch/events), [conversation](https://docs.openhands.dev/sdk/arch/conversation), [runtime](https://docs.openhands.dev/openhands/usage/architecture/runtime), [OpenHands SDK paper](https://arxiv.org/abs/2511.03690) | High for docs/repo, Medium-high for preprint / 文档和仓库为高，预印本为中高 | Typed Pydantic events form an immutable append-only log; Conversation manages pause/terminate/persistence; runtime separates actions from observations inside a sandbox.<br>typed Pydantic events（Pydantic 类型模型事件）形成不可变只追加日志；Conversation 管理暂停、终止和持久化；runtime 在沙箱内把 action（动作）和 observation（观察）分开。GitHub: [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands), about 72.5k stars; [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk), about 681 stars. | Split model-visible tool errors from conversation-level runtime errors; keep typed event classes and action/observation records.<br>把模型可见的工具错误与 conversation-level runtime error（会话级运行时错误）拆开；保留类型化事件类和动作/观察记录。 |

## Quilin 当前差距 / Current Quilin Gaps

Gap 1: Checkpoints are not yet recovery cursors. A checkpoint stores a PlanningState snapshot and storage reference, but the runtime still needs a stable `resume_from`, idempotency key, active step, pending tool calls, and child run handle.

差距 1：checkpoint 还不是 recovery cursor。checkpoint 保存 PlanningState 快照和 storage reference，但 runtime 仍需要稳定的 `resume_from`、idempotency key（幂等键，用于避免重放副作用）、active step（当前步骤）、pending tool calls（待完成工具调用）和 child run handle（子运行句柄）。

Gap 2: Delegation is not typed handoff yet. `DelegationAssignment` records parent/child run IDs, task ID, write set, checkpoint, and heartbeat, but it does not yet include schema version, handoff input type, history filter, receiving-agent contract, cancellation token, result schema, or parent inbox acknowledgement.

差距 2：delegation 还不是 typed handoff。`DelegationAssignment` 记录父/子 run ID、task ID、write set、checkpoint 和 heartbeat，但还没有 schema version（契约版本）、handoff input type（移交输入类型）、history filter（历史过滤器）、receiving-agent contract（接收 Agent 契约）、cancellation token（取消令牌）、result schema（结果 schema）或 parent inbox acknowledgement（父运行收件确认）。

Gap 3: Retry and cancel are policy signals, not runtime semantics. Planning has retry budgets and user-interrupt triggers, but it lacks an explicit state transition model for queued, running, checkpointed, cancel_requested, cancelled, retrying, failed, and completed.

差距 3：retry 与 cancel 目前是策略信号，不是 runtime 语义。Planning 有重试预算和用户中断触发器，但还缺少 queued（排队）、running（运行中）、checkpointed（已检查点）、cancel_requested（请求取消）、cancelled（已取消）、retrying（重试中）、failed（失败）和 completed（完成）的显式状态转换模型。

Gap 4: Supervisor runtime is still deferred. The rule-based delegation strategy can accept or reject a candidate, but the durable supervisor has not yet landed: no queue, lease, heartbeat, child lifecycle, progress aggregation, or no-dropped-completion guarantee.

差距 4：supervisor runtime（监督者运行时，指主 Agent 管理子 Agent 生命周期与进度交付的执行层）仍未落地。规则 delegation 策略可以接受或拒绝候选任务，但 durable supervisor 尚未实现：没有队列、租约、心跳、子生命周期、进度聚合或“完成通知不丢失”保证。

Gap 5: The side-effect boundary is under-specified. LangGraph and Temporal both require side effects to be wrapped in task/activity-like units. Quilin should make every tool call, sub-agent call, file write, and shell execution a retry-classified activity with idempotency and compensation metadata.

差距 5：副作用边界定义不足。LangGraph 和 Temporal 都要求副作用放进 task/activity（任务/活动，指可记录、可重试、可避免重复执行的执行单元）边界。Quilin 应把每个 tool call、sub-agent call、file write 和 shell execution 都定义成带重试分类、幂等和补偿元数据的 activity。

## Must / Should / Could 内化建议

| 优先级 / Priority | 建议 / Recommendation | Linear 映射 / Linear mapping |
|---|---|---|
| Must | Freeze a `DurableRunEnvelope` and `TypedHandoffEnvelope` contract: `schema_version`, `parent_run_id`, `child_run_id`, `task_id`, `input_schema`, `input_payload`, `history_filter`, `write_scope`, `risk_tier`, `cancel_token`, `retry_policy`, `result_schema`, `trace_id`.<br>冻结 `DurableRunEnvelope` 与 `TypedHandoffEnvelope` 契约，覆盖 schema 版本、父/子 run ID、任务 ID、输入 schema、输入载荷、历史过滤、写作用域、风险层级、取消令牌、重试策略、结果 schema 和追踪 ID。 | QUI-50, QUI-17, QUI-61 |
| Must | Define a runtime state machine with typed transition events: queued, running, checkpointed, paused, cancel_requested, cancelled, retrying, failed, completed.<br>定义 runtime 状态机和类型化转换事件：排队、运行中、已检查点、已暂停、请求取消、已取消、重试中、失败、完成。 | QUI-61, QUI-9 |
| Must | Make every side-effecting action an activity record with `idempotency_key`, `retry_class`, `timeout`, `heartbeat_required`, `compensation_hint`, and model-visible vs runtime-only error class.<br>把每个有副作用动作做成 activity record（活动记录），包含幂等键、重试分类、超时、是否需要心跳、补偿提示，以及模型可见/仅 runtime 可见的错误分类。 | QUI-61, QUI-17 |
| Must | Add durable parent/child delivery: child progress and final result must land in a parent inbox/outbox with acknowledgement before the parent marks a task complete.<br>增加可恢复父子交付：子 Agent 进度和最终结果必须进入父运行 inbox/outbox 并完成确认后，父运行才能标记任务完成。 | QUI-61, QUI-9 |
| Must | Treat cancellation as a delivered signal, not a local flag: parent requests cancel, child acknowledges at heartbeat/checkpoint boundary, runtime records terminal state.<br>把取消视为已投递信号，而不是本地标志：父运行请求取消，子运行在心跳/检查点边界确认，runtime 记录终态。 | QUI-61 |
| Should | Borrow LangGraph's `thread_id` and `checkpoint_ns` shape for persistent cursors and subgraph/sub-agent checkpoint namespaces.<br>借鉴 LangGraph 的 `thread_id` 和 `checkpoint_ns` 形态，用于持久游标和子图/子 Agent 检查点命名空间。 | QUI-50, QUI-17 |
| Should | Borrow OpenAI Agents' `input_type`, `input_filter`, `new_items`, and `to_state()` surfaces for handoff auditability and resumable approvals.<br>借鉴 OpenAI Agents 的 `input_type`、`input_filter`、`new_items` 和 `to_state()` 表面，支持 handoff 审计和可恢复审批。 | QUI-17, QUI-61 |
| Should | Borrow Temporal's child workflow handle semantics: parent can signal, query, cancel, terminate, or wait for child result.<br>借鉴 Temporal 的 child workflow handle 语义：父运行可 signal（发信号）、query（查询）、cancel（取消）、terminate（终止）或等待子结果。 | QUI-61, QUI-9 |
| Should | Borrow Cloudflare's “plan as durability strategy”: persist current step, continuation summary, and relevant context before waiting on slow jobs.<br>借鉴 Cloudflare 的“计划即恢复机制”：等待慢任务前持久化当前步骤、续接摘要和相关上下文。 | QUI-50, QUI-61 |
| Should | Borrow OpenHands' two error lanes: model-visible tool/agent errors vs runtime-level conversation errors.<br>借鉴 OpenHands 的双错误通道：模型可见的工具/Agent 错误，与 runtime 层会话错误分开。 | QUI-61, QUI-9 |
| Could | Add Continue-As-New-style event log compaction when event history grows too large, preserving a typed summary and fresh run segment.<br>当事件历史过大时，增加 Continue-As-New 风格日志压缩，保留类型化摘要并开启新的 run segment（运行片段）。 | QUI-61 |
| Could | Add time-travel/debug replay to WebUI（web dashboard，网页仪表盘） after durable runtime events are stable.<br>在可恢复 runtime 事件稳定后，为 WebUI 增加时间旅行/调试重放。 | QUI-9 |
| Could | Keep Temporal or Cloudflare Workflows as optional backends later, but do not make them the default Quilin runtime dependency now.<br>后续可把 Temporal 或 Cloudflare Workflows 保留为可选 backend（后端执行引擎），但现在不要把它们变成 Quilin 默认 runtime 依赖。 | QUI-61, QUI-9 |

## 建议契约草案 / Proposed Contract Sketch

This sketch is intentionally a contract, not an implementation. It gives Planning enough structure to hand work to runtime without importing a workflow engine into the planner.

这个草案刻意保持为契约，而不是实现。它让 Planning 能以足够结构把工作交给 runtime，而不把 workflow engine（工作流引擎）塞进 planner。

```typescript
export interface DurableRunEnvelope {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly checkpointNamespace: string;
  readonly resumeFrom?: {
    readonly eventSeq: number;
    readonly checkpointId: string;
    readonly activeStepId: string | null;
  };
  readonly traceId: string;
}

export interface TypedHandoffEnvelope<TInput, TResult> {
  readonly schemaVersion: 1;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly taskId: string;
  readonly receiver: {
    readonly role: string;
    readonly requiredCapabilities: readonly string[];
  };
  readonly inputSchemaRef: string;
  readonly inputPayload: TInput;
  readonly historyFilter: "full" | "summary" | "task_only" | "custom";
  readonly writeScope: readonly string[];
  readonly riskTier: "low" | "medium" | "high";
  readonly retryPolicy: {
    readonly maxAttempts: number;
    readonly backoff: "none" | "linear" | "exponential";
  };
  readonly cancelToken: string;
  readonly resultSchemaRef: string;
  readonly result?: TResult;
}
```

## 实施边界 / Implementation Boundary

Planning should emit durable intent and typed envelopes, then stop. It should not own worker leases, storage garbage collection, runtime locks, process lifecycles, or progress fan-out.

Planning 应产出 durable intent（可恢复执行意图）和 typed envelope（带类型的移交封包），然后停止。它不应拥有 worker lease（worker 租约）、存储清理、runtime lock（运行时锁）、进程生命周期或进度扇出。

Durable Runtime should accept envelopes and provide a small set of commands: `start`, `checkpoint`, `resume`, `signal`, `cancel`, `retry`, `fail`, and `complete`. It should persist every transition before side effects and expose replayable events to Observability and WebUI（web dashboard, the user-facing runtime visualization panel）.

Durable Runtime 应接收 envelope，并提供一组小命令：`start`、`checkpoint`、`resume`、`signal`、`cancel`、`retry`、`fail` 和 `complete`。它应在副作用之前持久化每次转换，并向 Observability（可观测系统）和 WebUI 暴露可回放事件。

Memory should not be the live execution database. quilin-mem（Quilin's four-tier memory system）can receive final plan reviews, failure summaries, and durable lessons after completion, but live run state should live in a runtime store with transactional semantics.

Memory 不应成为实时执行数据库。quilin-mem（Quilin 四层记忆系统）可以在任务完成后接收最终 plan review（计划复盘）、失败摘要和可沉淀经验，但 live run state（实时运行状态）应位于具备事务语义的 runtime store（运行时存储）中。

## 风险 / Risks

The biggest risk is overfitting Quilin to a graph engine. LangGraph is excellent for graph-shaped apps, but Quilin's spec intentionally prefers a minimal TypeScript（TS）core loop and linear-first planning. Absorb checkpoint semantics, not graph-first control flow.

最大风险是把 Quilin 过度绑定到 graph engine（图执行引擎）。LangGraph 很适合图形化流程应用，但 Quilin spec 明确偏向最小 TypeScript（TS）core loop 和 linear-first planning（线性优先规划）。应吸收 checkpoint 语义，而不是吸收 graph-first control flow。

The second risk is pretending typed handoff can be a prompt summary. OpenAI Agents and OpenHands both show that handoff boundaries become reliable only when they carry typed input, typed output, filtered history, trace metadata, and error surfaces.

第二个风险是把 typed handoff 当成 prompt summary（提示词摘要）。OpenAI Agents 和 OpenHands 都表明，handoff 边界只有携带 typed input（类型化输入）、typed output（类型化输出）、filtered history（过滤后的历史）、trace metadata（追踪元数据）和 error surfaces（错误表面）时才可靠。

The third risk is retrying non-idempotent work. Temporal and LangGraph both force developers to identify deterministic replay boundaries. Quilin needs the same discipline for shell commands, file writes, scaffold patches, and sub-agent writes.

第三个风险是重试非幂等工作。Temporal 和 LangGraph 都要求开发者识别 deterministic replay boundary（确定性重放边界）。Quilin 对 shell command、file write、scaffold patch 和 sub-agent write 也需要同等纪律。

## 最终建议 / Final Recommendation

For QUI-50, approve the direction as "Planning emits durable contracts; Durable Runtime executes them." The next implementation issue is already QUI-61, so do not create another issue. Tighten QUI-17 around planner routing and typed handoff schema, and keep QUI-9 focused on supervisor runtime and progress aggregation.

对 QUI-50，建议批准方向为：“Planning 产出可恢复契约；Durable Runtime 执行契约。”下一步实现 issue 已经是 QUI-61，因此不要再新建 issue。QUI-17 应收紧到 planner routing（规划路由）和 typed handoff schema，QUI-9 保持聚焦 supervisor runtime 与 progress aggregation（进度聚合）。

Benchmark work is frozen unless the user explicitly asks for it. Durable execution, typed handoff, and supervisor lifecycle should be validated through local runtime evidence because they determine whether failures can be resumed, audited, cancelled, and safely retried.

除非用户明确要求，benchmark 工作保持冻结。可恢复执行、结构化任务移交和 supervisor 生命周期应通过本地 runtime 实证验证，因为它们决定失败是否能恢复、审计、取消并安全重试。
