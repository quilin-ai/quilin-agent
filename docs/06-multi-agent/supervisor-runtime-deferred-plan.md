# 多 Agent 监督运行时延后路径 / Multi-Agent Supervisor Runtime Deferred Path

English: Linear record: `QUI-9`（the existing Linear issue for implementing the Multi-Agent supervisor runtime）. This document defines the deferred runtime path for the Multi-Agent supervisor runtime（多 Agent 调度运行时，指让主 Agent 保持响应、把长任务派给子 Agent、聚合进度并处理恢复/取消/复核的运行层）. Snapshot date: 2026-05-02, Asia/Shanghai.

中文：Linear 记录：`QUI-9`（现有 Linear issue，用于实现 Multi-Agent supervisor runtime）。本文定义 Multi-Agent supervisor runtime（多 Agent 调度运行时，指让主 Agent 保持响应、把长任务派给子 Agent、聚合进度并处理恢复/取消/复核的运行层）的延后落地路径。快照日期：2026-05-02，Asia/Shanghai。

English: This is not the same document as `docs/06-multi-agent/durable-subagent-runtime-plan.md`. The durable sub-agent plan owns child-run execution contracts: typed handoff envelopes, child states, leases, checkpoint records, idempotency, and parent inbox/outbox semantics. This document owns the future supervisor control plane: admission, scheduling, resource gates, user-facing progress, Linear task records, cross-review scheduling, and restart behavior.

中文：本文不是 `docs/06-multi-agent/durable-subagent-runtime-plan.md` 的重复版。可恢复子 Agent 文档负责子运行执行契约：结构化任务移交封包、子运行状态、租约、检查点记录、幂等性和父运行收发件箱语义。本文负责未来 supervisor control plane（监督控制面）：准入、调度、资源门控、面向用户的进度、Linear 任务记录、交叉复核调度和重启行为。

## 结论 / Decision

English: `QUI-9` should implement a local-first supervisor runtime only after the durable child-run contract from `QUI-61` is stable enough to execute, recover, and audit child work. Until then, this issue should stay open because a planning document is not the runtime itself.

中文：`QUI-9` 应在 `QUI-61` 的可恢复子运行契约足够稳定、能够执行、恢复和审计子任务后，再实现本机优先的 supervisor runtime。到那之前，该 issue 不应关闭，因为规划文档不等于运行时代码。

English: The runtime target is a non-blocking supervisor（非阻塞监督者，指主 Agent 只做用户输入输出、任务准入、调度、进度聚合和结果汇总，不执行长任务）. Any operation that can exceed the supervisor latency budget must become a sub-agent task, a review task, or a deferred background task with a Linear record.

中文：运行时目标是 non-blocking supervisor（非阻塞监督者，指主 Agent 只做用户输入输出、任务准入、调度、进度聚合和结果汇总，不执行长任务）。任何可能超过 supervisor 延迟预算的操作，都必须变成子 Agent 任务、review 任务，或带 Linear 记录的延后后台任务。

English: The default concurrency target is six active workers（runtime worker，指执行某个子任务或复核任务的运行时执行者） when budget, machine resources, and safety state allow it. Six is a maximum operating target, not an unconditional promise; token caps, `WriteAuthority`（the central write-permission gate for agent-initiated writes）, sandbox capacity, or user pause/cancel requests can lower it.

中文：默认并发目标是在预算、机器资源和安全状态允许时保持 6 个 active worker（runtime worker，指执行某个子任务或复核任务的运行时执行者）。6 是最大运行目标，不是无条件承诺；token 额度、`WriteAuthority`（Agent 发起写入的中央写权限门）、沙箱容量或用户暂停/取消请求都可以降低它。

## 当前边界 / Current Boundary

English: The current repository has a strong specification for supervisor behavior in `docs/06-multi-agent/README.md`, but the same document says the same-process supervisor/sub-agent runtime has not landed. `QUI-9` therefore remains implementation work, not completed documentation work.

中文：当前仓库在 `docs/06-multi-agent/README.md` 中已经有明确的 supervisor 行为规格，但同一文档也说明同进程 supervisor/sub-agent runtime 尚未落地。因此 `QUI-9` 仍是实现工作，而不是已完成的文档工作。

English: `QUI-61` should land before `QUI-9` because a supervisor cannot reliably schedule, cancel, recover, or review child work if child work has no stable durable execution contract. `QUI-9` consumes the child-run contract; it should not redefine it.

中文：`QUI-61` 应先于 `QUI-9` 落地，因为如果子任务没有稳定的可恢复执行契约，supervisor 就无法可靠地调度、取消、恢复或复核子任务。`QUI-9` 消费子运行契约，不应重新定义它。

English: Agent Mesh（跨 Agent 网络互操作层，当前由 `docs/11-agent-mesh` 负责） is not part of the first `QUI-9` implementation. The first supervisor runtime is local-first and may later delegate across mesh only after `QUI-10` reopens network runtime gates.

中文：Agent Mesh（跨 Agent 网络互操作层，当前由 `docs/11-agent-mesh` 负责）不属于 `QUI-9` 的第一实现切片。第一版 supervisor runtime 是本机优先，只有在 `QUI-10` 重新打开网络运行时门槛后，才可以跨 mesh 委派任务。

## 非阻塞监督者契约 / Non-Blocking Supervisor Contract

English: The supervisor event loop must stay available for user input, status questions, cancellation, reprioritization, and task admission. It may perform short deterministic operations such as routing, quota checks, issue/comment lookup, progress aggregation, and final summary assembly.

中文：supervisor event loop（监督者事件循环）必须持续响应用户输入、状态查询、取消、重新排序和任务准入。它可以执行短时确定性操作，例如路由、额度检查、issue/comment 查询、进度聚合和最终摘要组装。

English: The supervisor must not perform deep code edits, long web research, slow model reasoning, benchmark runs, large filesystem scans, or cross-component audits in its own loop. Those activities must be dispatched to workers and tracked through progress events.

中文：supervisor 不得在自己的循环内执行深度代码修改、长时间网络调研、慢模型推理、benchmark run（基准测试执行）、大规模文件扫描或跨组件审计。这些活动必须派发给 worker，并通过进度事件追踪。

English: A supervisor action is considered blocking if it can exceed the configured latency budget, hold the only user-facing conversation lane, or wait on another worker without a timeout. Blocking actions are defects unless the user explicitly requested a synchronous one-off command.

中文：如果某个 supervisor 动作可能超过配置的延迟预算、占住唯一面向用户的会话通道，或在没有超时的情况下等待另一个 worker，它就属于 blocking action（阻塞动作）。除非用户明确要求同步执行一次性命令，否则阻塞动作应视为缺陷。

English: The supervisor should return immediate acknowledgements for long work: task accepted, Linear record attached, worker admitted or queued, progress channel chosen, and cancellation handle available.

中文：supervisor 对长任务应立即返回确认：任务已接收、Linear 记录已关联、worker 已准入或排队、进度通道已选择、取消句柄可用。

## 运行时控制面 / Runtime Control Plane

English: The future runtime should be split into small control-plane components: `TaskAdmission`, `TaskLedger`, `WorkerPool`, `ProgressAggregator`, `PushFanout`, `ReviewScheduler`, and `ResourceGate`. These names are implementation placeholders, not public API commitments.

中文：未来 runtime 应拆成小型 control-plane component（控制面组件）：`TaskAdmission`、`TaskLedger`、`WorkerPool`、`ProgressAggregator`、`PushFanout`、`ReviewScheduler` 和 `ResourceGate`。这些名称是实现占位，不是公开 API 承诺。

English: `TaskAdmission` decides whether a user request can be answered directly, needs one worker, needs multiple workers, should be queued, or should be rejected because budget or safety gates are closed.

中文：`TaskAdmission` 决定用户请求是可以直接回答、需要一个 worker、需要多个 worker、应排队，还是因为预算或安全门关闭而拒绝。

English: `TaskLedger` is the local runtime ledger（运行台账，指记录任务、worker、Linear comment、progress and terminal result references 的可恢复本地索引）. It links user requests, Linear issue identifiers, child run identifiers, review run identifiers, and output artifacts.

中文：`TaskLedger` 是 local runtime ledger（运行台账，指记录任务、worker、Linear comment、progress 和 terminal result references 的可恢复本地索引）。它关联用户请求、Linear issue 编号、子运行编号、review run 编号和输出产物。

English: `WorkerPool` owns worker admission and lifecycle at the supervisor level. It does not own child-run checkpoint internals; those remain in `QUI-61`.

中文：`WorkerPool` 在 supervisor 层负责 worker 准入和生命周期。它不负责子运行检查点内部细节；这些仍属于 `QUI-61`。

English: `ProgressAggregator` owns user-facing progress rollups, blocker summaries, confidence labels, and stale-worker detection. It consumes child progress events instead of reading raw logs.

中文：`ProgressAggregator` 负责面向用户的进度汇总、阻塞摘要、置信度标签和 stale-worker detection（停滞 worker 检测）。它消费子任务进度事件，而不是读取 raw logs（原始日志）。

English: `PushFanout` owns delivery to WebUI（web user interface，网页界面）、IM（Instant Messaging，即时通讯） and Linear comments. It must throttle noisy events and preserve terminal updates.

中文：`PushFanout` 负责向 WebUI（web user interface，网页界面）、IM（Instant Messaging，即时通讯）和 Linear comment 投递。它必须限制噪声事件，并保证终态更新不丢失。

English: `ReviewScheduler` owns cross-review（交叉复核，指由另一个 worker 检查前一个 worker 的产物、证据和风险） assignment. Review work should reuse the same issue comment thread unless independent ownership or blockers justify a separate issue.

中文：`ReviewScheduler` 负责 cross-review（交叉复核，指由另一个 worker 检查前一个 worker 的产物、证据和风险）分配。review 工作应复用同一个 issue comment thread，除非独立负责人或阻塞关系需要单独 issue。

English: `ResourceGate` owns token, wall-clock, CPU, memory, disk, sandbox, network, and issue-budget admission. It is allowed to leave workers queued even when the user asked to keep six active workers, because exhausting a shared budget is worse than temporary under-utilization.

中文：`ResourceGate` 负责 token、wall-clock（运行时长）、CPU、内存、磁盘、sandbox（沙箱）、网络和 Linear issue 额度准入。即使用户要求保持 6 个 active worker，它也可以让 worker 排队，因为耗尽共享预算比短时低利用率更严重。

## 子 Agent 生命周期 / Sub-Agent Lifecycle

English: At the supervisor level, a task moves through `requested`, `admitted`, `queued`, `assigned`, `active`, `waiting_for_review`, `aggregating`, `terminal`, and `archived`. These are supervisor lifecycle states, not a replacement for the child-run states in `QUI-61`.

中文：在 supervisor 层，一个任务经过 `requested`、`admitted`、`queued`、`assigned`、`active`、`waiting_for_review`、`aggregating`、`terminal` 和 `archived`。这些是 supervisor lifecycle state（监督者生命周期状态），不是 `QUI-61` 的子运行状态替代品。

English: `requested` starts when the user asks for work. `admitted` means the request has a Linear record and passed basic quota/safety checks. `queued` means the work is valid but waiting for capacity. `assigned` means a worker has been selected. `active` means the worker has started executing.

中文：`requested` 从用户提出任务开始。`admitted` 表示请求已有 Linear 记录，并通过基本额度/安全检查。`queued` 表示工作有效但在等待容量。`assigned` 表示已选择 worker。`active` 表示 worker 已开始执行。

English: `waiting_for_review` means a primary worker has produced an artifact and a separate reviewer should inspect it. `aggregating` means the supervisor is combining results into a user-facing answer. `terminal` means completed, cancelled, failed, or explicitly deferred. `archived` means the local runtime no longer needs hot state.

中文：`waiting_for_review` 表示主 worker 已产生产物，需要独立 reviewer 检查。`aggregating` 表示 supervisor 正在把结果合并为面向用户的答复。`terminal` 表示完成、取消、失败或明确延后。`archived` 表示本地 runtime 不再需要热状态。

English: A worker can be replaced only through a visible supervisor transition: `active -> queued` after lease expiry, `active -> terminal` after cancellation, or `waiting_for_review -> assigned` when review capacity is admitted. Hidden replacement is not allowed because it makes audit and cost accounting unreliable.

中文：worker 只能通过可见的 supervisor transition（监督者状态迁移）被替换：租约过期后 `active -> queued`，取消后 `active -> terminal`，或 review 容量准入后 `waiting_for_review -> assigned`。不允许隐藏替换，因为这会让审计和成本核算不可靠。

## 进度聚合 / Progress Aggregation

English: Progress aggregation means converting many child events into a small, truthful user-facing status. It should report state, current step, blocker, last heartbeat age, reviewed artifact count, confidence, and next expected checkpoint.

中文：progress aggregation（进度聚合）指把大量子任务事件转换成小而真实的用户可读状态。它应报告状态、当前步骤、阻塞项、最近心跳距现在的时间、已复核产物数量、置信度和下一个预期检查点。

English: The aggregator must never pretend that percentage progress is precise. For open-ended engineering work, progress should be a band such as `starting`, `making_progress`, `blocked`, `reviewing`, or `wrapping_up`, with percentages used only when the worker has declared a bounded step plan.

中文：aggregator 不得假装百分比进度是精确值。对开放式工程任务，进度应是 `starting`、`making_progress`、`blocked`、`reviewing` 或 `wrapping_up` 这类区间；只有 worker 已声明有界步骤计划时，才使用百分比。

English: A progress update is eligible for WebUI on every material event, but eligible for IM only on start, checkpoint, blocker, user decision needed, review failure, completion, failure, or cancellation. Heartbeat-only IM pushes should be disabled by default to avoid notification noise.

中文：每个实质事件都可以推送到 WebUI，但只有开始、检查点、阻塞、需要用户决策、review 失败、完成、失败或取消时，才适合推送到 IM。纯 heartbeat（心跳）的 IM 推送应默认关闭，以避免通知噪声。

English: Linear comments should receive durable milestone updates, not every heartbeat. Good Linear updates are start, scope change, blocker, artifact ready, review result, terminal result, and why the issue remains open or moves state.

中文：Linear comment 应接收可长期追溯的里程碑更新，而不是每一次心跳。好的 Linear 更新包括开始、范围变化、阻塞、产物就绪、review 结果、终态结果，以及 issue 为什么保持打开或状态改变。

## 恢复、故障恢复、取消与分叉 / Resume, Recovery, Cancel, And Fork

English: Resume（恢复，指用户或 runtime 从已有检查点继续同一个任务） is a user-visible continuation. The supervisor must show which task, which worker or replacement worker, which checkpoint, and which Linear record are being resumed.

中文：resume（恢复，指用户或 runtime 从已有检查点继续同一个任务）是用户可见的续跑。supervisor 必须展示正在恢复哪个任务、哪个 worker 或替代 worker、哪个检查点，以及哪个 Linear 记录。

English: Recovery（故障恢复，指进程崩溃、租约过期或机器重启后自动恢复可恢复工作） is runtime-initiated. It must read the durable child-run store, rebuild the `TaskLedger`, suppress duplicate terminal pushes, and requeue non-terminal work through `ResourceGate`.

中文：recovery（故障恢复，指进程崩溃、租约过期或机器重启后自动恢复可恢复工作）由 runtime 发起。它必须读取可恢复子运行存储、重建 `TaskLedger`、抑制重复终态推送，并把非终态工作重新送入 `ResourceGate` 排队。

English: Cancel（取消，指用户或 supervisor 要求停止某个任务并阻断后续写入） is cooperative first and forceful only at a sandbox/process boundary. The supervisor records the request, sends cancellation to the child runtime, waits for acknowledgement or timeout, and then reports the terminal state.

中文：cancel（取消，指用户或 supervisor 要求停止某个任务并阻断后续写入）优先采用协作式，只在 sandbox/process boundary（沙箱或进程边界）上强制终止。supervisor 记录请求、向子运行时发送取消、等待确认或超时，然后汇报终态。

English: Fork（分叉，指从同一任务上下文派生一个替代路线或复核路线） is not retry. Fork creates a separate run with explicit parent linkage, separate result, separate review requirement, and separate budget accounting.

中文：fork（分叉，指从同一任务上下文派生一个替代路线或复核路线）不是 retry（重试）。fork 创建一个独立 run，带明确父级关联、独立结果、独立复核要求和独立预算核算。

English: Resume, recovery, cancel, and fork all require Linear-visible audit breadcrumbs when they affect non-trivial work. The breadcrumb can be a comment on the existing issue; it should not create a new issue unless independent ownership, blockers, or acceptance criteria are needed.

中文：当 resume、recovery、cancel 和 fork 影响非琐碎工作时，都需要 Linear 可见的审计 breadcrumb（审计面包屑，指轻量但可追溯的操作记录）。breadcrumb 可以是现有 issue 下的 comment；除非需要独立负责人、阻塞关系或验收标准，否则不应新建 issue。

## WebUI、IM 与 Linear 推送 / WebUI, IM, And Linear Push

English: WebUI is the high-frequency progress surface. It should display active worker count, queued worker count, blocker count, review queue, last heartbeat age, token-budget burn, and resource-gate reason for any queued work.

中文：WebUI 是高频进度表面。它应展示 active worker 数、queued worker 数、阻塞数量、review 队列、最近心跳距现在的时间、token 预算消耗，以及任何排队任务的 resource-gate reason（资源门控原因）。

English: IM is the interruption surface. It should receive sparse, actionable updates: accepted, started, blocked, needs decision, completed, failed, cancelled, resumed after recovery, or concurrency reduced because budget gates are closing.

中文：IM 是打断式通知表面。它应接收稀疏但可行动的更新：已接收、已开始、被阻塞、需要决策、已完成、失败、已取消、故障恢复后续跑，或因为预算门将关闭而降低并发。

English: Linear is the durable task record, not the heartbeat stream. The supervisor should write Linear comments for task start, scope change, blocker, artifact path, verification result, cross-review result, and terminal decision.

中文：Linear 是持久任务记录，不是心跳流。supervisor 应为任务开始、范围变更、阻塞、产物路径、验证结果、交叉复核结果和终态决策写 Linear comment。

English: When a worker creates or updates a doc artifact, the Linear comment must mention the artifact path, validation commands, validation output, line count, and whether the issue should remain open because implementation code is still missing.

中文：当 worker 创建或更新文档产物时，Linear comment 必须说明产物路径、验证命令、验证输出、行数，以及是否因为实现代码仍缺失而让 issue 保持打开。

## Linear 任务记录 / Linear Task Record

English: Before non-trivial work starts, the supervisor must attach it to an existing Linear issue, project, or comment. For the free-plan issue budget, subagent logs, probes, reviews, and idle exploration should prefer comments on existing issues.

中文：非琐碎工作开始前，supervisor 必须把它关联到既有 Linear issue、project 或 comment。受免费版 issue 额度约束，subagent log（子 Agent 日志）、probe（调研记录）、review 和空闲探索应优先写到既有 issue 的 comment。

English: A supervisor task record should include the user request, scope boundary, worker count, expected artifact, verification command, and closure rule. It should not contain every internal thought or noisy heartbeat.

中文：supervisor task record（监督者任务记录）应包含用户请求、范围边界、worker 数、预期产物、验证命令和关闭规则。它不应包含每个内部思路或噪声心跳。

English: A worker completion comment should distinguish "artifact complete" from "issue complete." For `QUI-9`, this document can be complete while the issue remains not Done because the supervisor runtime is not implemented in `packages/` or connected to Observability, Safety, Deployment, and Linear.

中文：worker 完成 comment 应区分“产物完成”和“issue 完成”。对 `QUI-9` 来说，本文档可以完成，但 issue 仍不应标 Done，因为 `packages/` 中还没有实现 supervisor runtime，也没有接入 Observability、Safety、Deployment 和 Linear。

## 交叉复核调度 / Cross-Review Scheduling

English: Cross-review should be scheduled automatically when a worker produces a material artifact, modifies runtime code, changes a contract, closes a blocker, or claims a component is complete. The reviewer should be a separate worker whenever capacity allows.

中文：当 worker 产出实质产物、修改 runtime 代码、改变契约、关闭 blocker，或声称某个组件完成时，应自动调度 cross-review。容量允许时，reviewer 应是独立 worker。

English: Idle workers should not create speculative new issues. If no primary work is available, they should review existing artifacts, deepen component analysis under an existing issue, inspect resource/performance risks, or synthesize competitor issue patterns into existing backlog comments and docs.

中文：空闲 worker 不应创建投机性新 issue。如果没有主任务，它们应 review 既有产物、在既有 issue 下做组件深挖、检查资源/性能风险，或把竞品 issue 模式综合进既有 backlog comment 和 docs。

English: Cross-review output must be actionable: accepted, accepted with follow-up under the same issue, needs revision, blocked, or requires a new issue. The "requires a new issue" result still needs the main supervisor to apply the Linear free-plan rule before creating anything.

中文：cross-review 输出必须可行动：接受、接受但在同一 issue 下后续跟进、需要修订、被阻塞，或需要新 issue。“需要新 issue”结果仍需主 supervisor 先应用 Linear 免费版规则，不能自动创建。

## 最多并发 Worker 的资源门控 / Max-Concurrent Worker Resource Gate

English: The runtime should target up to six active workers because the user wants aggressive parallel progress. The gate must still protect token budgets, machine resources, sandbox availability, API rate limits, Linear issue budget, and write-risk state.

中文：runtime 应以最多 6 个 active worker 为目标，因为用户希望高强度并行推进。门控仍必须保护 token 预算、机器资源、沙箱可用性、API 速率限制、Linear issue 额度和写入风险状态。

English: The resource gate should compute four decisions: admit now, queue until capacity, downgrade to review-only/read-only work, or stop assigning new work until the next budget window. These decisions must be visible in WebUI and summarized in IM only when they change user expectations.

中文：resource gate（资源门控）应计算四类决策：立即准入、排队等待容量、降级为 review-only/read-only work（只复核/只读工作），或停止分派新工作直到下一个预算窗口。这些决策必须在 WebUI 可见；只有改变用户预期时，才摘要推送到 IM。

English: The hard-stop behavior for a 5-hour token cycle is part of the gate. When the configured token ceiling is near, the supervisor should stop admitting new primary workers, let active safe workers finish or checkpoint, record the state in Linear, and schedule a later resume.

中文：5 小时 token 周期的 hard-stop（硬停止）行为属于该门控。当配置的 token 上限接近时，supervisor 应停止准入新的主 worker，让安全的 active worker 完成或写检查点，在 Linear 记录状态，并安排稍后恢复。

English: A worker slot should not be filled merely to look busy. If the only available work would violate benchmark deferral, duplicate another worker, bypass review, or exceed safety policy, the correct state is queued or idle-with-recorded-reason.

中文：worker 槽位不应为了看起来忙而填满。如果唯一可用工作会违反 benchmark 后置纪律、重复另一个 worker、绕过 review，或超过安全策略，正确状态是 queued（排队）或 idle-with-recorded-reason（带记录原因的空闲）。

## 集成边界 / Integration Boundaries

English: Planning owns task decomposition, intent, priority, and typed handoff construction. The supervisor runtime owns admission, scheduling, progress aggregation, cancellation routing, and user-visible task status.

中文：Planning 负责任务拆分、意图、优先级和结构化移交封包构造。supervisor runtime 负责准入、调度、进度聚合、取消路由和用户可见任务状态。

English: Durable Sub-Agent Runtime owns child execution, child checkpoints, leases, idempotency, and parent inbox/outbox durability. The supervisor consumes those events and should not inspect private child internals unless the child contract exposes them.

中文：Durable Sub-Agent Runtime（可恢复子 Agent 运行时）负责子任务执行、子任务检查点、租约、幂等性和父运行收发件箱可恢复性。supervisor 消费这些事件，不应检查子运行私有内部状态，除非子运行契约明确暴露。

English: Observability owns trace/span mapping, metrics, logs, WebUI dashboard ingestion, trace-to-eval extraction, and OTLP（OpenTelemetry Protocol，开放遥测协议） export shape. The supervisor emits stable events; Observability stores and visualizes them.

中文：Observability 负责 trace/span（追踪/跨度）映射、metrics、logs、WebUI dashboard 摄取、trace-to-eval（从执行轨迹生成评测样例）抽取和 OTLP（OpenTelemetry Protocol，开放遥测协议）导出形状。supervisor 发出稳定事件；Observability 存储并展示这些事件。

English: Safety owns `WriteAuthority`, policy decisions, risk tiers, and action verification. The supervisor may carry risk metadata and route approval requests, but it cannot grant itself write permission.

中文：Safety 负责 `WriteAuthority`、策略决策、风险层级和动作验证。supervisor 可以携带风险元数据并路由审批请求，但不能给自己授予写权限。

English: Deployment owns process lifecycle, sandbox providers, local daemon decisions, restart hooks, and OS-level resource controls. The supervisor can request capacity, but Deployment decides how process and sandbox capacity is actually provisioned.

中文：Deployment 负责进程生命周期、沙箱提供方、本机 daemon（后台进程）决策、重启 hook（钩子）和操作系统级资源控制。supervisor 可以请求容量，但实际进程与沙箱容量如何供应由 Deployment 决定。

English: Agent Mesh owns remote or peer-agent transport after its deferred gates reopen. The supervisor should keep transport-agnostic task and progress contracts so local workers and future mesh workers can share the same user-facing semantics.

中文：Agent Mesh 在其延后门槛重开后，负责远程或同伴 Agent 传输。supervisor 应保持 transport-agnostic（不绑定具体传输）的任务与进度契约，使本机 worker 和未来 mesh worker 可以共享同一套用户可见语义。

## 分阶段落地 / Phased Runtime Path

English: Phase 1 should implement only a local supervisor ledger and admission gate on top of the durable child runtime. Acceptance requires that a long task can be admitted, attached to Linear, queued, assigned to one worker, and reported without blocking the user loop.

中文：第一阶段只应在可恢复子运行时之上实现本机 supervisor ledger（监督者台账）和准入门。验收要求是一个长任务可以被准入、关联 Linear、排队、分配给一个 worker，并且不阻塞用户循环地汇报状态。

English: Phase 2 should add six-worker scheduling with resource gates. Acceptance requires visible admitted/queued decisions, worker replacement after lease expiry, and concurrency reduction when token or sandbox budget is near the configured ceiling.

中文：第二阶段应加入 6 worker 调度和资源门控。验收要求是准入/排队决策可见、租约过期后可替换 worker，并且当 token 或沙箱预算接近配置上限时能降低并发。

English: Phase 3 should add progress aggregation and push fanout. Acceptance requires WebUI event ingestion, sparse IM pushes, Linear milestone comments, and no need for a human to read raw logs to understand active work.

中文：第三阶段应加入进度聚合和推送分发。验收要求是 WebUI 能摄取事件、IM 推送稀疏、Linear 写里程碑 comment，并且人不需要读取 raw logs 就能理解活跃工作。

English: Phase 4 should add cross-review scheduling and fork handling. Acceptance requires a primary artifact to trigger a separate reviewer, review result aggregation, and explicit fork lineage when an alternative route is created.

中文：第四阶段应加入交叉复核调度和分叉处理。验收要求是主产物能触发独立 reviewer、review 结果能聚合，并且创建替代路线时有明确 fork lineage（分叉血缘）。

English: Phase 5 should add restart recovery. Acceptance requires process restart to rebuild active tasks from durable records, suppress duplicate terminal messages, requeue non-terminal work, and preserve Linear breadcrumbs.

中文：第五阶段应加入重启故障恢复。验收要求是进程重启后能从可恢复记录重建活跃任务、抑制重复终态消息、重新排队非终态工作，并保留 Linear breadcrumb。

## 最小验证 / Minimum Verification

English: Contract tests should prove that supervisor lifecycle transitions are valid and separate from child-run transitions. A supervisor task can be `waiting_for_review` while the child run is already terminal.

中文：契约测试应证明 supervisor 生命周期迁移有效，并且与子运行迁移相互独立。一个 supervisor task 可以处于 `waiting_for_review`，同时其子运行已经进入终态。

English: Non-blocking tests should simulate a long worker and prove the supervisor can still answer status, accept cancel, and admit or queue another task within the configured latency budget.

中文：非阻塞测试应模拟一个长时间 worker，并证明 supervisor 仍能在配置的延迟预算内回答状态、接收取消，以及准入或排队另一个任务。

English: Resource-gate tests should cover six-worker admission, token ceiling, sandbox capacity exhaustion, write-gate block, API rate-limit block, and Linear free-plan issue threshold behavior.

中文：资源门控测试应覆盖 6 worker 准入、token 上限、沙箱容量耗尽、写权限门阻断、API 速率限制阻断，以及 Linear 免费版 issue 阈值行为。

English: Recovery tests should kill and restart the supervisor, rebuild the ledger from durable records, requeue non-terminal work, and avoid duplicate WebUI/IM/Linear terminal updates.

中文：故障恢复测试应杀掉并重启 supervisor，从可恢复记录重建台账，重新排队非终态工作，并避免重复发送 WebUI、IM 和 Linear 终态更新。

English: Cross-review tests should prove that a completed worker artifact can trigger a separate reviewer, that review failures keep the task open, and that review acceptance can move the supervisor task to aggregation.

中文：交叉复核测试应证明已完成的 worker 产物可以触发独立 reviewer，review 失败会让任务保持打开，review 接受后可以把 supervisor task 推进到聚合阶段。

## Linear 映射 / Linear Mapping

English: `QUI-9` owns the supervisor runtime: non-blocking supervisor loop, local task ledger, worker admission, progress aggregation, push fanout, Linear task record integration, cross-review scheduling, resource gates, and restart recovery.

中文：`QUI-9` 负责 supervisor runtime：非阻塞 supervisor 循环、本机任务台账、worker 准入、进度聚合、推送分发、Linear 任务记录集成、交叉复核调度、资源门控和重启故障恢复。

English: `QUI-61` owns durable child execution and typed handoff runtime contracts. `QUI-9` should reference those contracts instead of duplicating state machines, inbox/outbox shapes, and checkpoint details.

中文：`QUI-61` 负责可恢复子任务执行和结构化移交运行时契约。`QUI-9` 应引用这些契约，而不是复制状态机、收发件箱形状和检查点细节。

English: `QUI-20`, `QUI-66`, and `QUI-75` own dashboard, observability backend, core loop event mapping, and trace-to-eval verification. `QUI-9` emits supervisor events that those issues consume.

中文：`QUI-20`、`QUI-66` 和 `QUI-75` 负责 dashboard、可观测后端、核心循环事件映射和 trace-to-eval 验证。`QUI-9` 发出这些 issue 消费的 supervisor 事件。

English: `QUI-10` owns mesh runtime deferral. `QUI-9` must stay local-first until mesh trust, transport, and network runtime gates reopen.

中文：`QUI-10` 负责 mesh runtime 延后路径。`QUI-9` 必须保持本机优先，直到 mesh 信任、传输和网络运行时门槛重新打开。

## 非目标 / Non-Goals

English: This document does not implement code, spawn workers, update `agent-bridge.md`, create new Linear issues, or move task management back into docs.

中文：本文不实现代码、不启动 worker、不更新 `agent-bridge.md`、不创建新的 Linear issue，也不把任务管理搬回 docs。

English: This document does not authorize benchmark execution. Benchmark work is frozen unless the user explicitly asks for it; supervisor work should rely on stable local child runtime, observability, safety, and deployment gates.

中文：本文不授权执行 benchmark。除非用户明确要求，benchmark 工作保持冻结；supervisor 工作应依赖稳定的本地子运行时、可观测性、安全和部署门槛。

English: This document does not make six active workers mandatory under every condition. It defines six as the desired maximum under a resource gate.

中文：本文不规定任何条件下都必须有 6 个 active worker。它把 6 定义为资源门控下的期望上限。

## 参考 / References

English: Internal references: `docs/06-multi-agent/README.md`, `docs/06-multi-agent/durable-subagent-runtime-plan.md`, `docs/08-observability/observability-backend-dashboard-plan.md`, `docs/08-observability/trace-to-eval-verification-plan.md`, `docs/11-agent-mesh/deferred-mesh-runtime-plan.md`, and `docs/00-core-loop/frontier-assimilation-cross-review.md`.

中文：内部参考：`docs/06-multi-agent/README.md`、`docs/06-multi-agent/durable-subagent-runtime-plan.md`、`docs/08-observability/observability-backend-dashboard-plan.md`、`docs/08-observability/trace-to-eval-verification-plan.md`、`docs/11-agent-mesh/deferred-mesh-runtime-plan.md` 和 `docs/00-core-loop/frontier-assimilation-cross-review.md`。

English: External primary references: OpenAI Agents SDK Handoffs documentation（delegation and input filtering）, OpenAI Agents SDK platform guide（agents can hand off work, stream partial results, and keep traces）, A2A latest specification（Agent Cards, task status, streaming task updates）, Model Context Protocol 2025-11-25 specification（lifecycle and HTTP authorization boundaries）, and Linear comments documentation（issue comments as durable task discussion records).

中文：外部一手参考：OpenAI Agents SDK Handoffs 文档（委派与输入过滤）、OpenAI Agents SDK 平台指南（Agent 可以移交工作、流式返回部分结果并保留 trace）、A2A latest specification（Agent Card、任务状态和流式任务更新）、Model Context Protocol 2025-11-25 specification（生命周期与 HTTP 授权边界），以及 Linear comments 文档（issue comment 作为持久任务讨论记录）。

English: Source URLs: `https://openai.github.io/openai-agents-js/guides/handoffs/`, `https://platform.openai.com/docs/guides/agents-sdk/`, `https://a2aproject.github.io/A2A/latest/specification/`, `https://modelcontextprotocol.io/specification/2025-11-25/basic`, and `https://linear.app/docs/comment-on-issues`.

中文：来源链接：`https://openai.github.io/openai-agents-js/guides/handoffs/`、`https://platform.openai.com/docs/guides/agents-sdk/`、`https://a2aproject.github.io/A2A/latest/specification/`、`https://modelcontextprotocol.io/specification/2025-11-25/basic` 和 `https://linear.app/docs/comment-on-issues`。
