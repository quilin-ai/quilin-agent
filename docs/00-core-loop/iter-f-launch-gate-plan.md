# Iter F 启动门槛规划 / Iter F Launch Gate Plan

Planning record: Linear `QUI-44`（the existing Linear issue that owns the Iter F launch decision）. Snapshot date: 2026-05-02, Asia/Shanghai. This document creates no new Linear issue and does not modify `agent-bridge.md`（the Claude Code and Codex collaboration protocol file）.

规划记录：Linear `QUI-44`（负责 Iter F 启动决策的既有 Linear issue）。快照日期：2026-05-02，Asia/Shanghai。本文不创建新的 Linear issue，也不修改 `agent-bridge.md`（Claude Code 与 Codex 的协作协议文件）。

## 结论 / Decision

Iter F（Scale-Out，规模化迭代，指把当前单机核心回路扩展到多 Agent 深度、跨 Agent 互操作、更深记忆、自进化和对话工程的下一阶段） should not launch merely because the roadmap has named future work. It launches only when the component gates below show that the relevant components are strong enough to scale without hiding failures.

Iter F（Scale-Out，规模化迭代，指把当前单机核心回路扩展到多 Agent 深度、跨 Agent 互操作、更深记忆、自进化和对话工程的下一阶段）不能因为路线图已经命名未来工作就启动。只有当下面的组件门槛证明相关组件足够强、规模化不会掩盖失败时，才启动。

Benchmark（standardized capability evaluation，标准化能力评测，用固定任务和评分比较系统能力） is frozen and the lowest project priority. The first priority is component strength: supervisor control, local mesh semantics, memory depth, safe self-evolution, and conversation style integration must be locally correct, observable, and reviewable; no Iter F work may add or modify Benchmark code unless the user explicitly asks.

Benchmark（standardized capability evaluation，标准化能力评测，用固定任务和评分比较系统能力）已冻结，并且是全项目最低优先级。第一优先级是组件强度：监督控制、本机 Mesh 语义、记忆深度、安全自进化和对话风格集成都必须在本地正确、可观测、可复核；除非用户明确要求，任何 Iter F 工作都不得新增或修改 Benchmark 代码。

`QUI-44` should remain open after this document is complete. This document defines the launch gate; it does not prove that the gate has passed, implement the runtime, or close the broad roadmap decision.

`QUI-44` 在本文完成后仍应保持 open。本文定义启动门槛，但不证明门槛已经通过、不实现运行时，也不关闭这个宽路线图决策。

## 范围 / Scope

This document integrates five Iter F family issues: `QUI-9` for the Multi-Agent supervisor runtime（多 Agent 监督运行时，用于让主 Agent 保持响应并调度子 Agent）, `QUI-10` for Agent Mesh（跨 Agent 互操作层，用于本机和未来远程 Agent 之间交换能力与任务）, `QUI-11` for Memory depth（记忆深度，指 L3a observer、长期评估、归档和更深检索能力）, `QUI-12` for Self-Evolution（自进化，指从运行轨迹生成待人工审核的改进提案）, and `QUI-13` for Conversation Engineering（对话工程，指把语言风格、关系状态和时间连续性工程化为可控上下文输入）.

本文整合五个 Iter F 能力族 issue：`QUI-9` 负责 Multi-Agent supervisor runtime（多 Agent 监督运行时，用于让主 Agent 保持响应并调度子 Agent），`QUI-10` 负责 Agent Mesh（跨 Agent 互操作层，用于本机和未来远程 Agent 之间交换能力与任务），`QUI-11` 负责 Memory depth（记忆深度，指 L3a observer、长期评估、归档和更深检索能力），`QUI-12` 负责 Self-Evolution（自进化，指从运行轨迹生成待人工审核的改进提案），`QUI-13` 负责 Conversation Engineering（对话工程，指把语言风格、关系状态和时间连续性工程化为可控上下文输入）。

The gate answers one question: when is it responsible to promote Iter F from future roadmap into coordinated runtime execution? It does not replace the detailed component plans under `docs/06-multi-agent`, `docs/11-agent-mesh`, `docs/03-memory`, `docs/10-self-evolution`, or `docs/02-context/conversation-engineering`.

这个门槛回答一个问题：什么时候可以负责任地把 Iter F 从未来路线图提升为协调运行时执行？它不替代 `docs/06-multi-agent`、`docs/11-agent-mesh`、`docs/03-memory`、`docs/10-self-evolution` 或 `docs/02-context/conversation-engineering` 下的详细组件规划。

## 启动定义 / Launch Definition

Launching Iter F means creating or activating a coordinated execution lane that cuts across the five family issues. It is not the same as closing any of those issues, and it is not the same as starting a benchmark campaign.

启动 Iter F 指创建或激活一个跨越五个能力族 issue 的协调执行通道。它不等于关闭这些 issue，也不等于启动一轮 benchmark 运动。

The first Iter F wave should be a local-first runtime wave. Local-first means the first implementation stays inside the local process or local machine boundary unless a specific gate explicitly allows broader network or background behavior.

第一波 Iter F 应是本机优先的运行时波次。Local-first（本机优先）指第一版实现留在本地进程或本机边界内，除非某个具体门槛明确允许更广的网络或后台行为。

The launch decision must be recorded in Linear（the task and backlog source of truth）. Docs may explain the criteria and evidence, but Linear remains the live source for issue state, ownership, blockers, and execution comments.

启动决策必须记录在 Linear（任务与 backlog 的真相源）中。Docs 可以解释标准和证据，但 Linear 仍是 issue 状态、负责人、阻塞关系和执行 comment 的实时来源。

## 全局硬门槛 / Global Hard Gates

Gate 1 is component readiness. Each participating component must have a current bilingual plan, a clear runtime boundary, local acceptance gates, and evidence that the current smaller slice has either landed or is explicitly insufficient for the next step.

门槛 1 是组件就绪度。每个参与组件必须有当前中英双语规划、清晰运行时边界、本地验收门槛，并有证据证明当前较小切片已经落地，或明确不足以支撑下一步。

Gate 2 is observability readiness. Iter F work must emit machine-joinable events, traces, status records, and Linear comments so failures can be diagnosed without manual raw-log reading.

门槛 2 是可观测就绪度。Iter F 工作必须输出机器可关联的事件、trace（追踪）、状态记录和 Linear comment，使失败诊断不依赖人工阅读 raw log（原始日志）。

Gate 3 is safety readiness. Any path that can change files, persistent memory, tool permissions, prompts, skills, provider configuration, or remote trust must route through Safety and `WriteAuthority`（the central write-permission gate for agent-initiated writes） before it affects runtime behavior.

门槛 3 是安全就绪度。任何可能改变文件、持久记忆、工具权限、提示词、技能、供应商配置或远程信任的路径，都必须在影响运行时行为前经过 Safety 和 `WriteAuthority`（Agent 发起写入的中央写权限门）。

Gate 4 is task-record readiness. Main-agent work, subagent（a delegated child agent that executes or reviews a bounded task） work, cross-review（review by a separate worker instead of the original author）, idle exploration, architecture exploration, performance exploration, and competitor issue absorption must have an existing Linear issue, project, or comment before non-trivial work starts.

门槛 4 是任务记录就绪度。主 agent 工作、subagent（子 Agent，即被委派执行或复核有界任务的子运行者）工作、cross-review（交叉复核，即由非原作者的 worker 复核产物）、空闲探索、架构探索、性能探索和竞品 issue 吸收，在非琐碎工作开始前都必须有既有 Linear issue、project 或 comment 记录。

Gate 5 is issue-budget readiness. The Linear workspace uses the free plan with a 250-issue cap, so Iter F launch must reuse existing issues and comments unless independent ownership, blockers, or acceptance criteria require a new issue.

门槛 5 是 issue 额度就绪度。Linear workspace 使用免费版，最多 250 个 issue，因此 Iter F 启动必须优先复用既有 issue 和 comment；只有需要独立负责人、阻塞关系或验收标准时才新建 issue。

Gate 6 is the Benchmark freeze. Benchmark code, public benchmark expansion, benchmark-specific tests, and benchmark-specific Linear work are disallowed unless the user explicitly asks for Benchmark work.

门槛 6 是 Benchmark 冻结。除非用户明确要求 Benchmark 工作，否则不得编写 Benchmark 代码、扩展公开 benchmark、添加 Benchmark 专用测试，或创建 Benchmark 专用 Linear 工作。

## `QUI-9` 多 Agent 监督门槛 / `QUI-9` Multi-Agent Supervisor Gate

`QUI-9` may enter Iter F execution when the durable child-run contract is stable enough for scheduling, cancellation, recovery, cross-review, and progress aggregation. A supervisor（监督者，即保持用户通道响应、准入任务、分派 worker 的运行时角色；worker 指执行具体任务或复核任务的运行时执行者） cannot be strong if child work has no durable state.

当可恢复子运行契约足够支撑调度、取消、恢复、交叉复核和进度聚合时，`QUI-9` 才能进入 Iter F 执行。Supervisor（监督者，即保持用户通道响应、准入任务、分派 worker 的运行时角色；worker 指执行具体任务或复核任务的运行时执行者）如果没有可恢复的子任务状态，就不可能足够强。

The launch evidence must show a non-blocking main lane, worker admission rules, resource gates, Linear task records, artifact completion comments, and a review scheduler. The six-worker target is an operating target under budget and safety constraints, not a promise to keep every slot busy at all costs.

启动证据必须展示非阻塞主通道、worker 准入规则、资源门控、Linear 任务记录、产物完成 comment 和复核调度器。6 个 worker 目标是在预算和安全约束下的运行目标，不是不计代价填满每个槽位的承诺。

`QUI-9` should stay open until runtime code exists, connects to Observability, respects Safety and Linear records, and proves that the main agent can remain responsive while workers run, pause, resume, fail, and finish.

`QUI-9` 应保持 open，直到运行时代码存在、接入 Observability、遵守 Safety 与 Linear 记录，并证明主 agent 能在 worker 运行、暂停、恢复、失败和完成时保持响应。

## `QUI-10` Agent Mesh 门槛 / `QUI-10` Agent Mesh Gate

`QUI-10` may enter Iter F execution only after the local `MeshClient`（本机 Mesh 客户端，用于发布 Agent 能力名片、发现本机同伴、交换请求和记录审计） slice proves local identity, permission grants, inbox semantics, audit records, and fail-closed behavior.

只有当本机 `MeshClient`（本机 Mesh 客户端，用于发布 Agent 能力名片、发现本机同伴、交换请求和记录审计）切片证明本机身份、权限授权、收件箱语义、审计记录和 fail-closed（缺少证明时默认拒绝）行为后，`QUI-10` 才能进入 Iter F 执行。

The first Iter F Mesh wave should not start with LAN/mDNS（Local Area Network plus Multicast DNS，局域网加组播域名发现）, daemon/gateway（后台常驻进程与策略代理）, federation（跨实例信任和路由）, relay（中继投递服务）, public mesh（公网可见 Agent 网络）, or remote trust（远程同伴信任）. Those remain reopened only by explicit trigger conditions.

第一波 Iter F Mesh 不应从 LAN/mDNS（Local Area Network plus Multicast DNS，局域网加组播域名发现）、daemon/gateway（后台常驻进程与策略代理）、federation（跨实例信任和路由）、relay（中继投递服务）、public mesh（公网可见 Agent 网络）或 remote trust（远程同伴信任）开始。这些路径只在明确触发条件满足后重开。

`QUI-10` should stay open until broader network paths have evidence for privacy, authorization, revocation, audit correlation, rate limits, and user-visible consent. A local client plan is not enough to close the remote runtime family.

`QUI-10` 应保持 open，直到更广网络路径具备隐私、授权、撤销、审计关联、限流和用户可见同意的证据。本机客户端规划不足以关闭远程运行时能力族。

## `QUI-11` 记忆深度门槛 / `QUI-11` Memory Depth Gate

`QUI-11` may enter Iter F execution when Memory has proven that deeper memory improves correctness without unsafe persistence. The minimum local evidence is L3a observer（第 3a 层观察器，从事件中提取可复用事实的派生层） quality, provenance receipts（来源凭据）, quarantine behavior, archival replay, and bilingual evaluation coverage.

当 Memory 证明更深记忆能提升正确性且不会产生不安全持久化时，`QUI-11` 才能进入 Iter F 执行。最低本地证据包括 L3a observer（第 3a 层观察器，从事件中提取可复用事实的派生层）质量、provenance receipts（来源凭据）、隔离行为、归档回放和中英双语评估覆盖。

The current observer evidence shows why this gate matters. A high-precision but low-recall observer can silently miss Chinese, mixed-language, noisy, or cross-turn facts; Iter F must not deepen Memory by amplifying a weak observer.

当前观察器证据说明了这个门槛为什么重要。高精确率但低召回的观察器可能静默漏掉中文、中英混合、噪声或跨轮事实；Iter F 不能通过放大薄弱观察器来加深 Memory。

`QUI-11` should stay open until local memory evaluation lanes, live shadow validation, archival policy, cross-user boundaries, and safe promotion paths are implemented and verified. Public memory benchmarks are frozen unless the user explicitly asks.

`QUI-11` 应保持 open，直到本地记忆评估通道、实时影子验证、归档策略、跨用户边界和安全提升路径都已实现并验证。除非用户明确要求，公开记忆 benchmark 保持冻结。

## `QUI-12` 自进化门槛 / `QUI-12` Self-Evolution Gate

`QUI-12` may enter Iter F execution only after the proposal-only runtime proves that a controlled failure can produce a complete patch proposal without applying it. Patch proposal（补丁提案，指包含 diff、证据、评测对比、风险和回滚说明的审核包） is allowed; automatic application is not.

只有在只提案运行时证明受控失败能生成完整补丁提案且不会应用该提案后，`QUI-12` 才能进入 Iter F 执行。Patch proposal（补丁提案，指包含 diff、证据、评测对比、风险和回滚说明的审核包）可以生成；自动应用不允许。

The launch evidence must show trajectory capture, failure diagnosis, pattern support, frozen local datasets, optimizer worker isolation, before-and-after comparison, `WriteAuthority` request preview, and human-review handoff. Idle evolution（空闲自进化，即用户未主动交互时进行的后台分析和提案准备） remains default OFF.

启动证据必须展示轨迹采集、失败诊断、模式支撑、冻结本地数据集、优化器 worker 隔离、改进前后对比、`WriteAuthority` 请求预览和人工审核交接。Idle evolution（空闲自进化，即用户未主动交互时进行的后台分析和提案准备）默认仍为 OFF。

`QUI-12` should stay open until the full trajectory-to-patch loop can produce useful proposals, route every write-capable effect through review, preserve privacy, and reject unsafe or under-evidenced changes. A documentation plan or proposal draft does not close the runtime family.

`QUI-12` 应保持 open，直到完整 trajectory-to-patch（从运行轨迹到补丁提案）闭环能产出有用提案、把每个具备写入效果的动作送入审核、保护隐私，并拒绝不安全或证据不足的变更。文档规划或提案草稿不能关闭这个运行时能力族。

## `QUI-13` 对话工程门槛 / `QUI-13` Conversation Engineering Gate

`QUI-13` may enter Iter F execution only after Context, Memory, Safety, and Observability can treat style as an auditable context input. Conversation Engineering must not become a hidden policy channel, hidden memory writer, or hidden permission source.

只有在 Context、Memory、Safety 和 Observability 能把风格当作可审计的上下文输入后，`QUI-13` 才能进入 Iter F 执行。Conversation Engineering 不得变成隐藏策略通道、隐藏记忆写入者或隐藏权限来源。

The first valid runtime shape is a bounded `ConversationStyleSource`（对话风格来源，用来描述语气、节奏和关系状态的低优先级上下文来源） with source, confidence, expiry, and safety classification. Context may place it below safety, user requirements, and task evidence; it must not rewrite the system prompt silently.

第一种有效运行时形态是有边界的 `ConversationStyleSource`（对话风格来源，用来描述语气、节奏和关系状态的低优先级上下文来源），并带有来源、置信度、过期时间和安全分类。Context 可以把它放在安全、用户需求和任务证据之下；它不得静默重写 system prompt（系统提示词）。

`QUI-13` should stay open until paired evaluations show that style adaptation improves interaction quality while preserving factual correctness, policy compliance, tool safety, and provenance. A more human tone is not a pass if it damages correctness.

`QUI-13` 应保持 open，直到成对评估证明风格适配能提升交互质量，同时保持事实正确性、策略合规、工具安全和来源追踪。如果更像真人的语气损害正确性，就不算通过。

## Benchmark 冻结规则 / Benchmark Freeze Rule

Benchmark work is not an Iter F confirmation lane by default. A component should define its local fixture, trace, policy, and review evidence; public benchmark packaging must remain frozen unless the user explicitly asks for Benchmark work.

Benchmark 工作默认不是 Iter F 的确认通道。组件应定义本地 fixture（固定测试样例）、trace、策略和复核证据；除非用户明确要求 Benchmark 工作，公开 benchmark 打包必须保持冻结。

If the user later restarts Benchmark work and a public benchmark reveals a weakness, the fix should map back to the component family issue that owns the cause. It must not create benchmark-driven scope that bypasses Linear issue-budget discipline or the component readiness gates.

如果用户未来重启 Benchmark 工作且公开 benchmark 暴露弱点，修复应映射回拥有原因的组件能力族 issue。它不得创建绕过 Linear issue 额度纪律或组件就绪门槛的 benchmark 驱动范围。

This rule matches the user's priority: Benchmark is the lowest project priority, and no Iter may write Benchmark code unless the user asks.

这条规则匹配用户优先级：Benchmark 是全项目最低优先级；除非用户要求，任何 Iter 都不得编写 Benchmark 代码。

## Linear 执行纪律 / Linear Execution Discipline

Linear remains the source for task state, backlog, phase tracking, owner boundaries, blockers, and execution records. This document may explain launch policy, but any execution work must be attached to a Linear issue, project, or comment before it starts.

Linear 仍然是任务状态、backlog、phase tracking（阶段追踪）、负责人边界、阻塞关系和执行记录的来源。本文可以解释启动策略，但任何执行工作开始前都必须关联到 Linear issue、project 或 comment。

The free-plan issue cap changes default behavior. Subagent logs, probes, reviews, idle exploration, architecture notes, performance notes, and competitor issue findings should reuse existing issue comments unless they need independent ownership, blockers, or acceptance criteria.

免费版 issue 上限会改变默认行为。Subagent log、probe（调研记录）、review、空闲探索、架构备注、性能备注和竞品 issue 发现，应优先复用既有 issue comment，除非它们需要独立负责人、阻塞关系或验收标准。

Every research-like output must land in bilingual docs under the relevant component or update an existing current-state snapshot. A chat-only note or Linear-only comment is not enough to become project knowledge.

每个调研类输出都必须写入相关组件下的中英双语 docs，或更新现有当前状态快照。仅聊天记录或仅 Linear comment 不足以成为项目知识。

## 启动流程 / Launch Flow

Step 1: collect the current component evidence for `QUI-9` through `QUI-13`, including landed code, open blockers, validation commands, line counts for docs evidence, and cross-review findings.

步骤 1：收集 `QUI-9` 到 `QUI-13` 的当前组件证据，包括已落地代码、未解阻塞、验证命令、docs 证据行数和交叉复核发现。

Step 2: decide whether each family is ready for first-wave implementation, ready for review-only exploration, or still blocked. The decision must be written to the existing issue comment thread.

步骤 2：判断每个能力族是可以进入第一波实现、只适合复核型探索，还是仍被阻塞。该决定必须写入既有 issue comment thread（评论串）。

Step 3: start only the lanes whose local gates are green. If one lane is blocked, do not compensate with Benchmark work; assign review, component deep-dive, or missing-evidence work instead.

步骤 3：只启动本地门槛为绿色的通道。如果某条通道被阻塞，不要用 Benchmark 工作补偿；应改派 review、组件深挖或补证据工作。

Step 4: keep `QUI-44` open as the roadmap governance issue until Iter F has actually launched, produced first-wave evidence, and delegated any remaining roadmap decisions to narrower active issues or projects.

步骤 4：保持 `QUI-44` 作为路线图治理 issue 打开，直到 Iter F 真正启动、产出第一波证据，并把剩余路线图决策委派给更窄的活跃 issue 或 project。

## 最小验收 / Minimum Acceptance

This document is acceptable when it defines a launch gate that covers `QUI-9`, `QUI-10`, `QUI-11`, `QUI-12`, and `QUI-13`; preserves the Benchmark freeze; keeps Linear as the task source; respects the free-plan issue cap; and states why `QUI-44` should remain open.

当本文定义了覆盖 `QUI-9`、`QUI-10`、`QUI-11`、`QUI-12` 和 `QUI-13` 的启动门槛，保留 Benchmark 冻结，把 Linear 作为任务源，遵守免费版 issue 上限，并说明 `QUI-44` 为什么应保持 open 时，本文即达到最小验收。

The future runtime launch is acceptable only when component evidence, safety gates, observability joins, Linear execution records, and cross-review results exist. Until then, `QUI-44` is a live governance issue, not a completed task.

未来运行时启动只有在组件证据、安全门槛、可观测关联、Linear 执行记录和交叉复核结果都存在时才可接受。在此之前，`QUI-44` 是活跃治理 issue，不是已完成任务。
