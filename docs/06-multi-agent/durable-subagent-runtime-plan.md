# 可恢复子 Agent 运行时实现规划 / Durable Sub-Agent Runtime Implementation Plan

English: This document is the implementation plan for Linear `QUI-61`（the existing Durable Sub-Agent Runtime and typed handoff planning issue）. It synthesizes the Planning durable runtime review in `docs/04-planning/planning-durable-runtime-frontier.md`, the Observability/Core Loop review in `docs/08-observability/observability-core-loop-frontier.md`, and the current Multi-Agent component spec in `docs/06-multi-agent/README.md`.

中文：本文档是 Linear `QUI-61`（现有可恢复子 Agent 运行时与结构化任务移交规划任务）的实现规划。它综合了 `docs/04-planning/planning-durable-runtime-frontier.md` 中的 Planning 可恢复运行时评估、`docs/08-observability/observability-core-loop-frontier.md` 中的可观测性与核心循环评估，以及 `docs/06-multi-agent/README.md` 当前 Multi-Agent 组件规格。

English: The goal is not to start benchmark（benchmark，基准测试）work. The goal is to make the Multi-Agent runtime strong enough that future long-task benchmarks can be resumed, audited, cancelled, and retried without losing parent/child delivery semantics.

中文：目标不是启动 benchmark（基准测试）工作。目标是先把 Multi-Agent runtime（多 Agent 运行时）做强，让后续长任务基准测试可以在不丢失父子交付语义的前提下恢复、审计、取消和重试。

## 一、结论 / Decision

English: Quilin should implement a local-first minimum Durable Sub-Agent Runtime（可恢复子 Agent 运行时，指可以持久化、恢复、取消和重试子任务执行的本机运行层）inside the TypeScript agent core before introducing a cross-machine mesh runtime. Planning emits durable contracts; the runtime executes them; Observability records every transition.

中文：Quilin 应先在 TypeScript agent core（类型化 JavaScript 的 Agent 核心）中实现本机优先的最小 Durable Sub-Agent Runtime（可恢复子 Agent 运行时，指可以持久化、恢复、取消和重试子任务执行的本机运行层），再引入跨机器 mesh runtime（多 Agent 网络运行时）。Planning 产出可恢复契约；runtime 执行契约；Observability 记录每一次状态转换。

English: The minimum runtime must provide typed handoff envelopes（结构化任务移交封包，指带 schema、权限范围、重试策略和追踪信息的任务交接数据）, a durable state machine, parent inbox/outbox delivery, progress events, heartbeat/lease control, resume tokens, retry/idempotency rules, `WriteAuthority`（写权限门，统一裁决 agent 写入是否允许的安全网关）integration, and Observability event mapping.

中文：最小运行时必须提供 typed handoff envelope（结构化任务移交封包，指带 schema、权限范围、重试策略和追踪信息的任务交接数据）、可恢复状态机、父运行收发件箱、进度事件、心跳与租约控制、恢复令牌、重试与幂等规则、`WriteAuthority`（写权限门，统一裁决 agent 写入是否允许的安全网关）集成，以及可观测事件映射。

English: This plan intentionally does not adopt LangGraph（一个图形化 Agent 工作流框架）, Temporal（一个可恢复工作流系统）, or Cloudflare Workflows（Cloudflare 的持久工作流产品）as runtime dependencies. It absorbs their semantics: checkpoint cursor, event history, child handle, signal delivery, cancellation boundary, and idempotent activity records.

中文：本规划刻意不把 LangGraph（一个图形化 Agent 工作流框架）、Temporal（一个可恢复工作流系统）或 Cloudflare Workflows（Cloudflare 的持久工作流产品）作为运行时依赖。它只吸收这些系统的语义：检查点游标、事件历史、子运行句柄、信号投递、取消边界和幂等活动记录。

## 二、边界 / Boundaries

English: Planning owns task decomposition, durable intent, typed handoff construction, retry intent, cancellation policy, and the first resume cursor. Planning must not own queue leases, child process lifecycles, runtime locks, heartbeat timers, or parent/child acknowledgement loops.

中文：Planning（规划组件）负责任务拆分、可恢复执行意图、结构化任务移交封包构造、重试意图、取消策略和初始恢复游标。Planning 不负责队列租约、子进程生命周期、运行时锁、心跳定时器或父子确认循环。

English: Durable Sub-Agent Runtime owns queueing, dispatch, heartbeat, lease renewal, checkpoint persistence, cancellation delivery, retry execution, final-result delivery, and replayable transition events.

中文：Durable Sub-Agent Runtime（可恢复子 Agent 运行时）负责排队、派发、心跳、租约续期、检查点持久化、取消投递、重试执行、最终结果交付和可回放的状态转换事件。

English: Observability owns trace/span mapping, progress stream export, lifecycle dashboards, and future trace-to-eval data extraction. It should observe runtime state transitions, not decide them.

中文：Observability（可观测性组件）负责 trace/span（追踪与跨度）映射、进度流导出、生命周期仪表盘和未来 trace-to-eval（从执行轨迹生成评测数据）抽取。它应观察运行时状态转换，而不是决定状态转换。

English: `WriteAuthority` owns all write decisions. The runtime can carry write scope and risk metadata, but it cannot bypass the write gate for file writes, shell execution, scaffold patches, skill creation, or idle evolution.

中文：`WriteAuthority`（写权限门）负责所有写入决策。runtime 可以携带写入范围和风险元数据，但不能绕过写权限门执行文件写入、shell 命令、脚手架补丁、技能创建或空闲自进化写入。

## 三、最小数据契约 / Minimum Data Contracts

English: The following TypeScript-shaped contract is intentionally small. It defines the interface between Planning, Durable Runtime, Safety, and Observability without forcing a specific storage backend.

中文：下面的 TypeScript 形态契约刻意保持小型。它定义 Planning、Durable Runtime、Safety（安全组件）与 Observability 之间的接口，但不强制指定具体存储后端。

```ts
type DurableSubAgentState =
  | "queued"
  | "running"
  | "checkpointed"
  | "cancel_requested"
  | "cancelled"
  | "retrying"
  | "failed"
  | "completed";

interface TypedHandoffEnvelope<TInput = unknown, TResult = unknown> {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly receiver: {
    readonly role: string;
    readonly requiredCapabilities: readonly string[];
  };
  readonly inputSchemaRef: string;
  readonly inputPayload: TInput;
  readonly historyFilter: "full" | "summary" | "task_only" | "custom";
  readonly resultSchemaRef: string;
  readonly writeScope: readonly string[];
  readonly writePolicy: {
    readonly authority: "WriteAuthority";
    readonly riskTier: "read_only" | "ask_on_write" | "auto_opt_in" | "critical";
    readonly origin: "user" | "supervisor" | "subagent" | "idle";
  };
  readonly retryPolicy: RetryPolicy;
  readonly cancellation: CancellationPolicy;
  readonly observability: {
    readonly traceId: string;
    readonly parentSpanId?: string;
    readonly redactionPolicy: "metadata_only" | "redacted_content" | "full_content";
  };
  readonly result?: TResult;
}

interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: "none" | "linear" | "exponential";
  readonly retryableErrors: readonly string[];
  readonly idempotencyKey: string;
}

interface CancellationPolicy {
  readonly cancelToken: string;
  readonly cooperative: boolean;
  readonly checkpointRequiredBeforeExit: boolean;
}
```

English: `schemaVersion` is required because typed handoff envelopes will evolve. A child runtime must reject unknown major versions instead of guessing the meaning of fields.

中文：`schemaVersion` 是必需字段，因为结构化任务移交封包会演进。子运行时必须拒绝未知主版本，而不是猜测字段含义。

English: `historyFilter` prevents accidental context flooding. The parent must decide whether the child receives the full conversation, a summary, only task-local context, or a custom filtered packet.

中文：`historyFilter` 用来避免意外灌入过多上下文。父运行必须决定子运行接收完整对话、摘要、仅任务局部上下文，还是自定义过滤后的上下文包。

English: `writePolicy` carries the metadata needed by `WriteAuthority`. It is not an approval; it is the request metadata that allows the write gate to make the approval decision later.

中文：`writePolicy` 携带 `WriteAuthority` 需要的元数据。它不是批准结果，而是后续写权限门进行审批决策所需的请求元数据。

## 四、状态机 / State Machine

English: The runtime state machine must use exactly these initial states for `QUI-61`: `queued`, `running`, `checkpointed`, `cancel_requested`, `cancelled`, `retrying`, `failed`, and `completed`. Additional states require a later issue comment and evidence because dashboards, recovery, and tests will depend on this vocabulary.

中文：`QUI-61` 的运行时状态机初始版本必须使用这些状态：`queued`（已排队）、`running`（运行中）、`checkpointed`（已写入检查点）、`cancel_requested`（已请求取消）、`cancelled`（已取消）、`retrying`（重试中）、`failed`（失败）和 `completed`（完成）。新增状态需要后续 issue comment 和证据，因为仪表盘、恢复逻辑和测试都会依赖这套词汇。

English: A child run starts in `queued` after the parent outbox persists the handoff envelope. The runtime may move it to `running` only after it acquires a lease and writes a `runtime.subagent.started` event.

中文：子运行在父运行 outbox（发件箱）持久化移交封包后进入 `queued`。runtime 只有在获取租约并写入 `runtime.subagent.started` 事件后，才可以把它转为 `running`。

English: A `running` child moves to `checkpointed` whenever it persists a checkpoint that can resume the active step. It may then return to `running` for the next step without losing the checkpoint reference.

中文：`running` 子运行在持久化一个可恢复当前步骤的检查点后进入 `checkpointed`。随后它可以回到 `running` 执行下一步，但不能丢失检查点引用。

English: Cancellation is cooperative by default. The parent moves the child to `cancel_requested`; the child acknowledges cancellation at the next heartbeat or checkpoint boundary; only then can the runtime mark it `cancelled`.

中文：取消默认是协作式的。父运行先把子运行标记为 `cancel_requested`；子运行在下一次心跳或检查点边界确认取消；只有确认后 runtime 才能标记为 `cancelled`。

English: Retry moves through `retrying`, not directly from `failed` to `running`. This makes retry attempts visible, allows idempotency checks, and lets Observability show whether a task is making progress or looping.

中文：重试必须经过 `retrying`，不能从 `failed` 直接跳到 `running`。这样可以让重试尝试可见，支持幂等检查，也让 Observability 能区分任务是在推进还是在循环失败。

English: `completed`, `failed`, and `cancelled` are terminal states. A terminal child run cannot perform new writes or emit new progress except a final acknowledgement event.

中文：`completed`、`failed` 和 `cancelled` 是终态。终态子运行不能执行新的写入，也不能继续发出进度事件，最多只能发出最终确认事件。

## 五、父运行收发件箱 / Parent Inbox and Outbox

English: The parent outbox is the durable source for child dispatch. It stores the typed handoff envelope, target child run ID, current delivery status, last attempt timestamp, and acknowledgement status.

中文：父运行 outbox（发件箱）是子任务派发的可恢复源。它存储结构化任务移交封包、目标子运行 ID、当前投递状态、最后尝试时间和确认状态。

English: The parent inbox is the durable landing zone for child progress, checkpoint notifications, cancellation acknowledgements, retry notices, and final results. The parent must not mark a delegated task complete until the final child result has been written to the inbox and acknowledged.

中文：父运行 inbox（收件箱）是子运行进度、检查点通知、取消确认、重试通知和最终结果的可恢复落点。父运行不能在最终子结果写入 inbox 并确认前，把委派任务标记为完成。

English: Inbox/outbox delivery prevents dropped completions. If the supervisor process exits after the child completes but before the parent aggregates the result, recovery reads the inbox and continues aggregation.

中文：收发件箱交付可以防止完成通知丢失。如果 supervisor（监督者）进程在子运行完成后、父运行聚合结果前退出，恢复流程会读取 inbox 并继续聚合。

```ts
interface ParentOutboxItem {
  readonly outboxId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly handoff: TypedHandoffEnvelope;
  readonly deliveryStatus: "pending" | "delivered" | "acknowledged" | "dead_lettered";
  readonly attempt: number;
  readonly lastAttemptAt?: string;
}

interface ParentInboxItem {
  readonly inboxId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly kind: "progress" | "checkpoint" | "cancel_ack" | "retry_notice" | "final_result";
  readonly payload: unknown;
  readonly receivedAt: string;
  readonly acknowledgedAt?: string;
}
```

English: `dead_lettered` means the runtime could not deliver a handoff after all allowed attempts. It is a visible operational state, not silent loss.

中文：`dead_lettered` 表示 runtime 在耗尽允许尝试后仍无法投递移交封包。它是一个可见的运维状态，不是静默丢失。

## 六、进度事件与心跳租约 / Progress Events and Heartbeat Lease

English: A progress event is a user- and dashboard-facing lifecycle record. It must be cheap to emit, safe to redact, and linked to the runtime state machine.

中文：progress event（进度事件）是面向用户和仪表盘的生命周期记录。它必须发出成本低、可安全脱敏，并且关联到运行时状态机。

```ts
interface SubAgentProgressEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly taskId: string;
  readonly state: DurableSubAgentState;
  readonly trigger: "started" | "checkpoint" | "heartbeat" | "retry" | "cancel" | "completed" | "failed";
  readonly progressPct?: number;
  readonly currentStep?: string;
  readonly checkpointRef?: string;
  readonly message?: string;
  readonly traceId: string;
  readonly spanId?: string;
  readonly emittedAt: string;
}
```

English: Heartbeat/lease（心跳/租约） is the liveness contract. A lease gives one runtime worker the right to execute a child run until `leaseExpiresAt`; heartbeat renews that lease and proves the worker is still alive.

中文：heartbeat/lease（心跳/租约）是存活性契约。租约赋予一个 runtime worker（运行时执行者）在 `leaseExpiresAt` 前执行某个子运行的权利；心跳续租并证明该 worker 仍然存活。

English: If the lease expires without a terminal state, recovery may requeue the child run. Before requeueing, the runtime must read the latest checkpoint and idempotency key so it does not repeat unsafe side effects.

中文：如果租约过期且没有终态，恢复流程可以把子运行重新排队。在重新排队前，runtime 必须读取最新检查点和幂等键，避免重复执行不安全副作用。

```ts
interface RuntimeLease {
  readonly leaseId: string;
  readonly childRunId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly heartbeatIntervalMs: number;
  readonly lastHeartbeatAt: string;
}
```

## 七、恢复令牌 / Resume Token

English: A resume token（恢复令牌，指可定位到具体运行、检查点和下一步动作的恢复凭据） must be opaque to the user but structured inside the runtime. It should include run IDs, checkpoint reference, event sequence, and expiry metadata.

中文：resume token（恢复令牌，指可定位到具体运行、检查点和下一步动作的恢复凭据）对用户应是不透明的，但在 runtime 内部必须是结构化的。它应包含运行 ID、检查点引用、事件序号和过期元数据。

```ts
interface ResumeTokenPayload {
  readonly schemaVersion: 1;
  readonly tokenId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly checkpointRef: string;
  readonly eventSeq: number;
  readonly activeStepId?: string;
  readonly expiresAt?: string;
  readonly singleUse: boolean;
}
```

English: Resume must be recorded as an event before execution continues. This prevents hidden continuation and allows a trace to show who resumed the task, from which checkpoint, and with which input.

中文：恢复必须在继续执行前先记录为事件。这样可以避免隐藏续跑，并让 trace（执行追踪）展示是谁恢复了任务、从哪个检查点恢复、带了什么输入。

## 八、重试与幂等 / Retry and Idempotency

English: Retry is allowed only for errors that match the handoff `retryPolicy`. Every side-effecting activity must carry an idempotency key（幂等键，指用于避免重放时重复产生副作用的稳定标识）.

中文：只有匹配移交封包 `retryPolicy` 的错误才允许重试。每个有副作用的 activity（活动记录，指可记录、可重试、可审计的执行单元）都必须携带 idempotency key（幂等键，指用于避免重放时重复产生副作用的稳定标识）。

English: File writes, shell commands, scaffold patch proposals, tool calls, and sub-agent dispatches are all activities. On replay, the runtime must check whether an activity with the same idempotency key already succeeded before executing it again.

中文：文件写入、shell 命令、脚手架补丁提案、工具调用和子 Agent 派发都属于 activity。重放时，runtime 必须先检查同一个幂等键的 activity 是否已经成功，再决定是否重新执行。

```ts
interface RuntimeActivityRecord {
  readonly activityId: string;
  readonly childRunId: string;
  readonly kind: "llm_call" | "tool_call" | "file_write" | "shell_exec" | "subagent_dispatch" | "checkpoint_write";
  readonly idempotencyKey: string;
  readonly retryClass: "never" | "safe" | "guarded" | "manual_review";
  readonly status: "started" | "succeeded" | "failed" | "skipped_replay";
  readonly writeDecisionId?: string;
  readonly checkpointRef?: string;
}
```

English: `retryClass` separates safe transient retries from actions that require manual review. A failed network read can be `safe`; a file write after partial success should normally be `guarded` or `manual_review`.

中文：`retryClass` 用来区分安全的瞬时重试和需要人工复核的动作。失败的网络读取可以是 `safe`；已经部分成功的文件写入通常应是 `guarded` 或 `manual_review`。

## 九、写权限门集成 / WriteAuthority Integration

English: The runtime must call `WriteAuthority` before every write-class activity. The typed handoff envelope supplies requested write scope, origin, risk tier, and trace ID; `WriteAuthority` returns the decision and decision ID.

中文：runtime 必须在每个写入类 activity 前调用 `WriteAuthority`。结构化任务移交封包提供请求的写入范围、来源、风险层级和追踪 ID；`WriteAuthority` 返回裁决结果和裁决 ID。

English: A child run may continue after a denied write only if the activity can degrade to a read-only path. Otherwise the runtime should emit a blocked progress event and move to `failed` or `cancelled` depending on whether the user requested cancellation.

中文：写入被拒后，只有当该 activity 可以降级为只读路径时，子运行才可以继续。否则 runtime 应发出被阻断的进度事件，并根据是否是用户请求取消，进入 `failed` 或 `cancelled`。

```ts
interface WriteAuthorityRuntimeRequest {
  readonly childRunId: string;
  readonly activityId: string;
  readonly origin: "user" | "supervisor" | "subagent" | "idle";
  readonly requestedOperation: "file_write" | "shell_exec" | "scaffold_patch" | "skill_create" | "idle_evolution";
  readonly writeScope: readonly string[];
  readonly riskTier: "read_only" | "ask_on_write" | "auto_opt_in" | "critical";
  readonly traceId: string;
}
```

English: `origin: "idle"` is especially sensitive. It must remain blocked unless the user explicitly opted into automatic idle evolution for the session.

中文：`origin: "idle"` 特别敏感。除非用户在当前 session（会话）明确选择启用自动空闲自进化，否则必须保持阻断。

## 十、可观测事件映射 / Observability Event Mapping

English: Runtime events should map to the `LoopStepEvent` and `LoopStopState` direction from `QUI-55` and the future `QUI-66` implementation. The runtime should keep stable internal events, then export to OpenTelemetry（开放遥测标准，用于统一 traces、metrics 和 logs） through a mapper.

中文：运行时事件应映射到 `QUI-55` 与后续 `QUI-66` 实现方向中的 `LoopStepEvent`（循环步骤事件）和 `LoopStopState`（循环终止状态）。runtime 应保留稳定内部事件，再通过 mapper（映射器）导出到 OpenTelemetry（开放遥测标准，用于统一 traces、metrics 和 logs）。

English: Minimum internal event names are `runtime.subagent.queued`, `runtime.subagent.started`, `runtime.subagent.checkpointed`, `runtime.subagent.heartbeat`, `runtime.subagent.cancel_requested`, `runtime.subagent.cancelled`, `runtime.subagent.retrying`, `runtime.subagent.failed`, and `runtime.subagent.completed`.

中文：最小内部事件名为 `runtime.subagent.queued`、`runtime.subagent.started`、`runtime.subagent.checkpointed`、`runtime.subagent.heartbeat`、`runtime.subagent.cancel_requested`、`runtime.subagent.cancelled`、`runtime.subagent.retrying`、`runtime.subagent.failed` 和 `runtime.subagent.completed`。

English: Each event must include `parentRunId`, `childRunId`, `taskId`, `state`, `eventSeq`, `traceId`, optional `spanId`, optional `checkpointRef`, and optional `resumeTokenId`. This is enough for WebUI Dashboard（网页仪表盘）, local JSON logs, and future OTLP（OpenTelemetry Protocol，开放遥测协议）export.

中文：每个事件必须包含 `parentRunId`、`childRunId`、`taskId`、`state`、`eventSeq`、`traceId`、可选 `spanId`、可选 `checkpointRef` 和可选 `resumeTokenId`。这些字段足以支撑 WebUI Dashboard（网页仪表盘）、本地 JSON 日志和未来 OTLP（OpenTelemetry Protocol，开放遥测协议）导出。

```ts
interface RuntimeObservabilityEvent {
  readonly schemaVersion: 1;
  readonly eventName: string;
  readonly eventSeq: number;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly taskId: string;
  readonly state: DurableSubAgentState;
  readonly traceId: string;
  readonly spanId?: string;
  readonly checkpointRef?: string;
  readonly resumeTokenId?: string;
  readonly emittedAt: string;
}
```

English: Terminal events should also map to a `LoopStopState`. `completed` maps to success, `failed` maps to failure, and `cancelled` maps to cancelled. `cancel_requested` is not terminal.

中文：终态事件还应映射到 `LoopStopState`。`completed` 映射为成功，`failed` 映射为失败，`cancelled` 映射为已取消。`cancel_requested` 不是终态。

## 十一、实现切片 / Implementation Slices

English: Slice 1 for `QUI-61` should freeze contracts only: typed handoff envelope, runtime state enum, progress event, lease, resume token, parent inbox/outbox items, activity record, and observability event. This can be implemented without starting mesh networking.

中文：`QUI-61` 的第一切片应只冻结契约：结构化任务移交封包、运行时状态枚举、进度事件、租约、恢复令牌、父运行收发件箱、活动记录和可观测事件。这个切片不需要启动 mesh networking（多 Agent 网络通信）。

English: Slice 2 should implement an in-process runtime store with append-only event history. The initial backend can be local JSON or SQLite（轻量嵌入式数据库）as long as it preserves ordering, idempotency keys, and recovery reads.

中文：第二切片应实现同进程 runtime store（运行时存储）和只追加事件历史。初始后端可以是本地 JSON 或 SQLite（轻量嵌入式数据库），前提是保留顺序、幂等键和恢复读取能力。

English: Slice 3 should implement dispatch and recovery: parent outbox write, child queue claim, lease acquire, heartbeat renewal, checkpoint write, terminal inbox delivery, and acknowledgement.

中文：第三切片应实现派发与恢复：父 outbox 写入、子队列领取、租约获取、心跳续租、检查点写入、终态 inbox 交付和确认。

English: Slice 4 should integrate cancellation, retry, idempotency, and `WriteAuthority`. This slice should include fixtures for cancellation at heartbeat boundary, retry after transient failure, denied write, and replay after lease expiry.

中文：第四切片应集成取消、重试、幂等和 `WriteAuthority`。该切片应包含心跳边界取消、瞬时失败后重试、写入被拒和租约过期后重放的夹具。

English: Slice 5 should wire Observability: emit runtime events, map terminal events to `LoopStopState`, attach trace/span references, and expose progress to WebUI or local JSON logs.

中文：第五切片应接入 Observability：发出 runtime event（运行时事件）、把终态事件映射到 `LoopStopState`、附带 trace/span 引用，并把进度暴露给 WebUI 或本地 JSON 日志。

## 十二、验证计划 / Verification Plan

English: Contract tests should assert allowed state transitions. Invalid transitions such as `queued -> completed`, `cancelled -> running`, or `completed -> retrying` must fail.

中文：契约测试应验证允许的状态转换。`queued -> completed`、`cancelled -> running` 或 `completed -> retrying` 这类非法转换必须失败。

English: Recovery tests should start a child run, emit a checkpoint, simulate lease expiry, and resume from the checkpoint without repeating an already succeeded activity with the same idempotency key.

中文：恢复测试应启动子运行、发出检查点、模拟租约过期，并从检查点恢复，同时不得重复执行已经以同一幂等键成功过的 activity。

English: Cancellation tests should request cancellation while a child is running, wait for heartbeat acknowledgement, and verify the terminal state is `cancelled` with no later write activity.

中文：取消测试应在子运行运行中请求取消，等待心跳确认，并验证终态是 `cancelled`，且之后没有新的写入 activity。

English: Write-gate tests should verify that every file write, shell execution, scaffold patch, skill creation, and idle-evolution request passes through `WriteAuthority` before execution.

中文：写权限门测试应验证每次文件写入、shell 命令、脚手架补丁、技能创建和空闲自进化请求都在执行前经过 `WriteAuthority`。

English: Observability tests should verify that each runtime state transition emits one internal event, and terminal events produce a compatible `LoopStopState`.

中文：可观测性测试应验证每次 runtime 状态转换都会发出一个内部事件，且终态事件会产生兼容的 `LoopStopState`。

## 十三、Linear 映射 / Linear Mapping

English: `QUI-61`（Durable Sub-Agent Runtime and typed handoff implementation） owns the runtime contracts, in-process durable execution, state machine, parent inbox/outbox, heartbeat/lease, resume token, retry/idempotency, and `WriteAuthority` runtime integration.

中文：`QUI-61`（可恢复子 Agent 运行时与结构化任务移交实现）负责运行时契约、同进程可恢复执行、状态机、父运行收发件箱、心跳/租约、恢复令牌、重试/幂等，以及 `WriteAuthority` 运行时集成。

English: `QUI-50`（Planning durable execution and typed handoff decision） owns the Planning-side durable intent and typed handoff envelope construction. It should not own worker leases or runtime lifecycle execution.

中文：`QUI-50`（Planning 可恢复执行与结构化任务移交决策）负责 Planning 侧的可恢复执行意图和结构化移交封包构造。它不应负责 worker 租约或运行时生命周期执行。

English: `QUI-55`（Observability and Core Loop frontier review） owns the event vocabulary decision that this runtime maps into: step events, stop states, and trace-to-eval preparation.

中文：`QUI-55`（可观测性与核心循环前沿复核）负责本文 runtime 映射所依赖的事件词汇决策：步骤事件、终止状态和 trace-to-eval 准备。

English: `QUI-66`（Core Loop and Observability implementation） should receive the concrete event mapping work: `LoopStepEvent`, `LoopStopState`, trace/span references, and exporter compatibility.

中文：`QUI-66`（Core Loop 与可观测性实现）应承接具体事件映射工作：`LoopStepEvent`、`LoopStopState`、trace/span 引用和导出器兼容。

English: `QUI-20`（WebUI Dashboard and observability backend work） should consume progress events, runtime lifecycle events, terminal states, and future OTLP export recipes.

中文：`QUI-20`（WebUI Dashboard 与可观测后端工作）应消费进度事件、运行时生命周期事件、终态和未来 OTLP 导出配方。

## 十四、非目标 / Non-Goals

English: This task does not implement cross-machine Agent Mesh（跨机器 Agent 网络） behavior. Local durable sub-agent execution comes first; mesh transport can later carry the same envelopes.

中文：本任务不实现跨机器 Agent Mesh（跨机器 Agent 网络）行为。本机可恢复子 Agent 执行优先；后续 mesh transport（网络传输层）可以承载同一套封包。

English: This task does not implement benchmark runners. It only makes runtime traces, state transitions, and recovery semantics strong enough to support meaningful benchmarks later.

中文：本任务不实现 benchmark runner（基准测试执行器）。它只把运行时 trace、状态转换和恢复语义做强，为后续有意义的 benchmark 提供基础。

English: This task does not change `agent-bridge.md`. AgentBridge is the cross-agent collaboration protocol file, not the place for this runtime implementation plan.

中文：本任务不修改 `agent-bridge.md`。AgentBridge 是跨 Agent 协作协议文件，不是本文运行时实现规划的落点。
