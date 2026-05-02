# Context 延后运行时规划 / Context Runtime Deferred Plan

> Scope: Linear `QUI-15`. Evidence checked on 2026-05-02 Asia/Shanghai. This document covers deferred Context runtime（上下文运行时，即负责把来源、预算、压缩、缓存和流恢复组合成可执行提示词的模块）work only: relevance selection（相关性选择，按任务挑选真正该进入提示词的信息）, token-aware compressor（token 感知压缩器，在预算内保留关键事实并记录损耗）, runtime delta channel（运行时增量通道，用事件传递上下文变化而不是反复发送全量状态）, and the parked Conversation Engineering dependency（暂缓的对话工程依赖，用来把语言风格配方接入 Context 但不提前启动）.

> 范围：Linear `QUI-15`。证据在 2026-05-02 Asia/Shanghai 校准。本文只覆盖 Context runtime（上下文运行时，即负责把来源、预算、压缩、缓存和流恢复组合成可执行提示词的模块）的延后工作：relevance selection（相关性选择，按任务挑选真正该进入提示词的信息）、token-aware compressor（token 感知压缩器，在预算内保留关键事实并记录损耗）、runtime delta channel（运行时增量通道，用事件传递上下文变化而不是反复发送全量状态），以及 parked Conversation Engineering dependency（暂缓的对话工程依赖，用来把语言风格配方接入 Context 但不提前启动）。

## 结论 / Decision

`QUI-15` should remain a deferred family issue, not an implementation slice to close with this document. `docs/02-context/context-frontier-assimilation.md` decides what Context should absorb, and `docs/02-context/context-runtime-implementation-plan.md` defines the current `QUI-60` runtime contract. This file defines what stays outside the current slice, when it should be reopened, what it may consume, what it must emit, and how it proves readiness.

`QUI-15` 应继续保留为一个延后能力族 issue，而不是靠本文关闭的实现切片。`docs/02-context/context-frontier-assimilation.md` 决定 Context 应吸收什么，`docs/02-context/context-runtime-implementation-plan.md` 定义当前 `QUI-60` 的 runtime 契约。本文定义哪些内容留在当前切片之外、何时重开、可以消费什么、必须输出什么，以及如何证明可以进入实现。

The boundary is intentionally conservative. `QUI-60` should first land deterministic contracts and local fixtures for `ContextSource`（上下文来源，进入提示词候选池的结构化信息单元）, `ContextSelectionTrace`（上下文选择轨迹，用来说明每个来源为什么被选择或拒绝）, `CompressionTrace`（压缩轨迹，用来说明 token 取舍）, `CachePlan`（缓存计划，用来说明可复用提示词前缀）, and `DeltaStreamTrace`（增量流轨迹，用来说明流恢复状态）. `QUI-15` then governs the next layer: adaptive policies, durable delivery, cross-session behavior, and Conversation Engineering integration.

这个边界刻意保守。`QUI-60` 应先落地 `ContextSource`（上下文来源，进入提示词候选池的结构化信息单元）、`ContextSelectionTrace`（上下文选择轨迹，用来说明每个来源为什么被选择或拒绝）、`CompressionTrace`（压缩轨迹，用来说明 token 取舍）、`CachePlan`（缓存计划，用来说明可复用提示词前缀）和 `DeltaStreamTrace`（增量流轨迹，用来说明流恢复状态）的确定性契约与本地 fixture。`QUI-15` 之后再管理下一层：自适应策略、持久传递、跨 session 行为和 Conversation Engineering 集成。

Benchmark posture: deferred until component gates pass. Public benchmark（基准测试，用统一输入和评分比较系统能力）execution must not drive this issue before Context, Memory, LLM routing（大语言模型路由，把任务分配到合适模型或供应商路径）, Tools, Safety, and Observability expose measurable local gates.

Benchmark 姿态：等组件门槛通过后再做。公开 benchmark（基准测试，用统一输入和评分比较系统能力）执行不得在 Context、Memory、LLM routing（大语言模型路由，把任务分配到合适模型或供应商路径）、Tools、Safety 和 Observability 暴露可测本地门槛之前驱动本 issue。

## 与相邻文档的区别 / Difference From Neighboring Documents

`context-frontier-assimilation.md` is the evidence and decision record. It answers which frontier ideas Quilin should absorb: cache-aware context, staged selection, compression, long-context placement, and resumable deltas.

`context-frontier-assimilation.md` 是证据和决策记录。它回答 Quilin 应吸收哪些前沿想法：感知缓存的上下文、分阶段选择、压缩、长上下文排布，以及可恢复增量。

`context-runtime-implementation-plan.md` is the current implementation plan. It defines the data contracts, local fixture gates, trace artifacts, and the first runtime pipeline that should be implemented before this issue is reopened for deeper capability work.

`context-runtime-implementation-plan.md` 是当前实现规划。它定义数据契约、本地 fixture 门槛、trace 产物，以及在本 issue 重开做更深能力之前应先实现的第一条 runtime 流水线。

This document is the deferred backlog boundary. It does not redefine the `QUI-60` contracts; it defines the future promotion rules, additional inputs, output contracts, and acceptance gates needed before Quilin can claim that Context relevance, compression, delta delivery, and Conversation Engineering are mature runtime capabilities.

本文是延后 backlog 边界。它不重新定义 `QUI-60` 契约；它定义未来升级规则、额外输入、输出契约和验收门槛，只有满足这些条件后，Quilin 才能声称 Context 相关性、压缩、增量传递和 Conversation Engineering 已成为成熟运行时能力。

## 当前保留状态 / Current Deferred State

The current repository already has prompt/session assembly, token budgeting, temporal awareness（时间感知，用当前时间、消息间隔和跨 session 时间线调整上下文）, memory bridge（记忆桥接，把 Memory 结果转成 Context 可消费结构）, injection scanning（注入扫描，识别把低可信内容伪装成高优先级指令的风险）, and skills catalog restoration. Those are baseline Context capabilities, not proof that the deferred runtime paths are complete.

当前仓库已具备 prompt/session assembly、token budgeting、temporal awareness（时间感知，用当前时间、消息间隔和跨 session 时间线调整上下文）、memory bridge（记忆桥接，把 Memory 结果转成 Context 可消费结构）、injection scanning（注入扫描，识别把低可信内容伪装成高优先级指令的风险）和 skills catalog restoration。这些是 Context 基线能力，不证明延后 runtime 路径已经完成。

The deferred state is specifically about runtime maturity. Relevance selection must become adaptive and explainable across sessions; compression must become value-aware rather than size-only; the delta channel must become a durable event stream rather than a UI convenience; Conversation Engineering must wait until safety, memory, and observability can prove it is improving interaction quality without hiding policy or evidence.

延后状态专指 runtime 成熟度。相关性选择必须跨 session 自适应且可解释；压缩必须按价值决策，而不是只按长度决策；增量通道必须成为持久事件流，而不是 UI 便利功能；Conversation Engineering 必须等安全、记忆和可观测能力能够证明它在提升交互质量，同时不隐藏策略或证据。

## 重开条件 / Reopen Triggers

Reopen `QUI-15` only after `QUI-60` has landed the first Context runtime contracts and local fixtures. The minimum prerequisite is that a prompt build can emit stable `ContextSelectionTrace`, optional `CompressionTrace`, required `CachePlan`, local latency fields, and `DeltaStreamTrace` when streaming or resume is active.

只有在 `QUI-60` 落地第一批 Context runtime 契约和本地 fixture 后，才应重开 `QUI-15`。最低前置条件是一次 prompt build 能输出稳定的 `ContextSelectionTrace`、可选 `CompressionTrace`、必需 `CachePlan`、本地延迟字段，并在流式或恢复启用时输出 `DeltaStreamTrace`。

Reopen the relevance selection lane when local fixtures reveal quality failures that cannot be solved by fixed scoring. Examples include stale but semantically similar sources outranking current project files, low-authority memory overriding user intent, or multi-agent work needing different source ranking per delegated task.

当本地 fixture 暴露固定打分无法解决的质量失败时，重开相关性选择通道。例如：语义相似但过期的来源排在当前项目文件前面、低权威记忆覆盖用户意图，或多 Agent 工作需要按不同委派任务使用不同来源排序。

Reopen the compressor lane when prompt budgets become a runtime blocker after deterministic selection is correct. Examples include repeated tool-output bulk, long-running coding sessions with many validated findings, high-cost provider routes, and provider-side context editing becoming available on a selected model path.

当确定性选择已经正确，但 prompt 预算仍成为 runtime 阻塞时，重开压缩器通道。例如：重复工具输出膨胀、长时间编码 session 积累大量已验证 finding、高成本 provider 路径，以及所选模型路径开始支持 provider-side context editing（供应商上下文编辑，由模型服务端清理旧内容）。

Reopen the delta-channel lane when Context must support resumable long-running work across UI reloads, process restarts, or subagent handoffs. The trigger is not “we want streaming”; it is “full-state resend or full prompt rebuild is now measurably wasteful or unsafe.”

当 Context 必须支持跨 UI 刷新、进程重启或 subagent 交接的长任务恢复时，重开增量通道。触发点不是“我们想要 streaming”，而是“重新发送全量状态或重建完整 prompt 已经可测地浪费或不安全”。

Reopen the Conversation Engineering lane only after core-loop stability and safety gates can distinguish useful style adaptation from hidden preference injection. It should also wait until Memory can supply user-profile signals with provenance（来源追踪，说明信息从哪里来、可信度如何）and revocation.

只有在核心回路稳定，并且安全门槛能区分有用风格适配与隐藏偏好注入后，才重开 Conversation Engineering 通道。它还应等待 Memory 能提供带 provenance（来源追踪，说明信息从哪里来、可信度如何）和撤销能力的用户画像信号。

## 相关性选择延后路径 / Deferred Relevance Selection Path

The future selector should become a policy engine, not a single ranker. `QUI-60` can start with deterministic scoring, but `QUI-15` owns adaptive selection policies that can vary by task type, risk tier, source authority, working set, and prior failure traces.

未来选择器应成为策略引擎，而不是单个 ranker（重排器，用来重新排序候选上下文）。`QUI-60` 可以从确定性打分开始，但 `QUI-15` 负责按任务类型、风险等级、来源权威度、工作集和历史失败轨迹变化的自适应选择策略。

Inputs must include normalized `ContextSource` items, Memory block handoff metadata, active goal state, current task intent, file dependency hints, permission scope, safety trust tier, and previous selection failures. The selector may consume embeddings（向量表示，用数值向量表达语义相似度）, keyword features, graph edges, and recency metadata, but the trace must preserve every factor instead of flattening the decision into one opaque score.

输入必须包括标准化 `ContextSource` 项、Memory block handoff 元数据、当前目标状态、当前任务意图、文件依赖提示、权限范围、安全信任等级和历史选择失败。选择器可以消费 embeddings（向量表示，用数值向量表达语义相似度）、关键词特征、图关系和时效元数据，但 trace 必须保留每个因素，不能把决策压成一个不透明分数。

Outputs must include a richer `ContextSelectionTrace` with policy name, policy version, candidate count, rejection reason codes, score breakdown, selected placement region, source authority explanation, and a deterministic replay key. If a future selector uses an LLM judge（大语言模型裁判，用模型辅助判断相关性或质量）, the raw judge prompt, model path, and confidence must be logged as evidence rather than hidden inside the selection result.

输出必须包括更丰富的 `ContextSelectionTrace`，包含策略名、策略版本、候选数量、拒绝原因代码、分数拆解、所选排布区域、来源权威解释和确定性重放键。如果未来选择器使用 LLM judge（大语言模型裁判，用模型辅助判断相关性或质量），必须记录原始裁判提示词、模型路径和置信度作为证据，不能藏在选择结果里。

The first acceptance gate is replay. Given the same sources, task intent, policy version, and random seed, selection order and rejection reasons must be identical. If the policy is intentionally adaptive, the adaptive input must itself be part of the replay record.

第一道验收门槛是重放。给定相同来源、任务意图、策略版本和随机种子，选择顺序和拒绝原因必须一致。如果策略刻意自适应，那么自适应输入本身也必须进入重放记录。

The second acceptance gate is authority preservation. Current local project files, explicit user requirements, safety rules, and high-confidence Memory facts must not be displaced by semantically similar but lower-authority sources unless the trace records a clear reason.

第二道验收门槛是权威保持。当前本地项目文件、明确用户需求、安全规则和高置信 Memory facts（记忆事实）不得被语义相似但权威更低的来源挤掉，除非 trace 记录了明确原因。

The third acceptance gate is contradiction handling. When two sources disagree, the selector must preserve the contradiction group, choose an action-safe placement, and avoid silently collapsing the conflict into one confident statement.

第三道验收门槛是矛盾处理。当两个来源冲突时，选择器必须保留矛盾组，选择对行动安全的排布位置，并避免把冲突静默压成一个自信结论。

## Token 感知压缩延后路径 / Deferred Token-Aware Compression Path

The future compressor should optimize for value under budget, not for the shortest prompt. `QUI-60` can implement lane selection and trace fields; `QUI-15` owns adaptive compression thresholds, quality-risk prediction, cache impact analysis, and provider-side editing integration.

未来压缩器应在预算内优化价值，而不是追求最短 prompt。`QUI-60` 可以实现压缩通道选择和 trace 字段；`QUI-15` 负责自适应压缩阈值、质量风险预测、缓存影响分析和 provider-side editing 集成。

Inputs must include selected sources, token estimates, output reserve, provider context window, cache boundary, citation requirements, loss permissions, safety-critical spans, and observed local latency. If a source is safety policy, explicit user requirement, permission decision, or provenance receipt, it must default to no lossy compression.

输入必须包括已选来源、token 估算、输出预留、provider 上下文窗口、缓存边界、引用要求、损耗权限、安全关键片段和本地延迟观测。如果来源是安全策略、明确用户需求、权限决策或来源凭据，默认不得进行有损压缩。

Outputs must include `CompressionTrace` with trigger reason, selected lane, original token count, compressed token count, preserved span identifiers, dropped span identifiers, quality risk, cache impact, and a fallback plan. A compressor that cannot prove quality preservation must return “do not compress” rather than inventing a shorter but unsafe prompt.

输出必须包括 `CompressionTrace`，记录触发原因、所选通道、原始 token 数、压缩后 token 数、保留片段标识、丢弃片段标识、质量风险、缓存影响和回退计划。无法证明质量保持的压缩器必须返回“不要压缩”，而不是发明一个更短但不安全的 prompt。

Provider-side context editing is allowed only behind a measured adapter（适配层，用统一接口封装供应商差异）. Anthropic’s official context editing documentation reports applied edits such as cleared thinking turns, cleared tool uses, and `cleared_input_tokens`; Quilin must record those provider-native fields and join them to local `CompressionTrace`.

只有通过可度量 adapter（适配层，用统一接口封装供应商差异）时，才允许使用供应商侧上下文编辑。Anthropic 官方 context editing 文档会报告被应用的编辑，例如清理 thinking turns、清理 tool uses 和 `cleared_input_tokens`；Quilin 必须记录这些 provider 原生字段，并把它们关联到本地 `CompressionTrace`。

The first acceptance gate is span preservation. Any answer requiring citation must still be able to point to exact source spans after compression, or the compressed prompt fails.

第一道验收门槛是片段保持。任何需要引用的回答，在压缩后仍必须能指向精确来源片段，否则压缩 prompt 失败。

The second acceptance gate is cache awareness. Compression must not rewrite the stable prefix unless it intentionally starts a new cache lineage（缓存血缘，表示一个可缓存前缀的版本链）. A warm-cache improvement cannot be claimed when the compressor changed the cacheable prefix.

第二道验收门槛是缓存感知。压缩不得改写稳定前缀，除非它刻意开启新的 cache lineage（缓存血缘，表示一个可缓存前缀的版本链）。如果压缩器改变了可缓存前缀，就不能声称获得上一条热缓存收益。

The third acceptance gate is usefulness. Compression must show either lower local/provider latency, lower token cost, or lower context-overflow risk without lowering fixture quality. If compression saves tokens but makes answers worse, it is a regression.

第三道验收门槛是有用性。压缩必须证明降低本地或 provider 延迟、降低 token 成本，或降低上下文溢出风险，同时不降低 fixture 质量。如果压缩节省 token 但让回答变差，就是回归。

## 运行时增量通道延后路径 / Deferred Runtime Delta Channel Path

The future delta channel should be event sourcing for Context, not just streaming text to a browser. Event sourcing（事件溯源，用不可变事件记录状态变化）lets Quilin resume long tasks, replay prompt-build decisions, deduplicate deliveries, and show the user what changed without forcing a full prompt rebuild.

未来增量通道应是 Context 的 event sourcing（事件溯源，用不可变事件记录状态变化），而不只是把文本流给浏览器。事件溯源让 Quilin 能恢复长任务、重放 prompt-build 决策、去重传递，并向用户展示发生了什么变化，而不必强制重建完整 prompt。

Inputs must include session identity, stream identity, last delivered event, selected source hashes, cache plan identity, active agent or subagent identity, and cancellation state. A transport disconnect must not be treated as cancellation; cancellation needs an explicit event.

输入必须包括 session 标识、stream 标识、最后已传递事件、已选来源 hash、缓存计划标识、当前 agent 或 subagent 标识，以及取消状态。传输断开不得被视为取消；取消需要显式事件。

Outputs must include typed events such as `context.source_added`, `context.source_selected`, `context.source_compressed`, `context.cache_plan_emitted`, `context.delta_sent`, `context.resume_cursor_saved`, `context.resume_rejected`, and `context.cancelled`. Every event should carry `run_id`, `prompt_build_id`, source hashes, policy versions, payload size, and redaction state.

输出必须包括类型化事件，例如 `context.source_added`、`context.source_selected`、`context.source_compressed`、`context.cache_plan_emitted`、`context.delta_sent`、`context.resume_cursor_saved`、`context.resume_rejected` 和 `context.cancelled`。每个事件都应携带 `run_id`、`prompt_build_id`、来源 hash、策略版本、payload 大小和脱敏状态。

The MCP（Model Context Protocol，模型上下文协议，用于 Agent 与工具服务之间传输结构化消息）Streamable HTTP transport provides the transport baseline: one endpoint can support POST and GET, optional SSE（Server-Sent Events，服务器向客户端持续推送事件的 HTTP 流式机制）, session identifiers, and resume through event identifiers plus `Last-Event-ID`. Quilin should copy the resumability invariant, not necessarily the exact transport.

MCP（Model Context Protocol，模型上下文协议，用于 Agent 与工具服务之间传输结构化消息）Streamable HTTP transport 提供传输基线：一个 endpoint 可支持 POST 和 GET、可选 SSE（Server-Sent Events，服务器向客户端持续推送事件的 HTTP 流式机制）、session 标识，以及通过事件标识和 `Last-Event-ID` 恢复。Quilin 应吸收可恢复不变量，不一定照搬具体传输。

Vercel AI SDK（Vercel AI Software Development Kit，Quilin 当前 TypeScript LLM 抽象层）shows the application responsibility clearly: stream resumption requires persisted messages, active stream identifiers, stream data, and resume endpoints. Quilin should therefore store the Context-side cursor before relying on UI-level resume behavior.

Vercel AI SDK（Vercel AI Software Development Kit，Quilin 当前 TypeScript LLM 抽象层）清楚说明了应用责任：流恢复需要持久化 messages、活跃 stream 标识、stream data 和恢复 endpoint。因此 Quilin 必须先存储 Context 侧 cursor，再依赖 UI 层恢复行为。

The first acceptance gate is exactly-once delivery within a stream. Replaying from a cursor must not duplicate already consumed Context events and must not skip selected sources.

第一道验收门槛是单条流内 exactly-once delivery（精确一次传递，即恢复时不重复也不漏传）。从 cursor 重放时不得重复已消费 Context 事件，也不得跳过已选来源。

The second acceptance gate is restart recovery. After process restart, the runtime must be able to reconstruct the active `CachePlan`, selected source hashes, and last event cursor without rebuilding from untrusted raw chat text alone.

第二道验收门槛是重启恢复。进程重启后，runtime 必须能重建活跃 `CachePlan`、已选来源 hash 和最后事件 cursor，而不能只依赖不可信的原始聊天文本重新构造。

The third acceptance gate is observability. `docs/08-observability` must be able to join delta events to traces, logs, and evaluation samples. If a failed answer came from a bad resume, the trace should show the missing or duplicated Context event without manual raw-log reading.

第三道验收门槛是可观测性。`docs/08-observability` 必须能把增量事件关联到 trace、日志和评测样例。如果失败回答来自错误恢复，trace 应能展示缺失或重复的 Context 事件，而不需要人工读 raw log。

## 暂缓的对话工程依赖 / Parked Conversation Engineering Dependency

Conversation Engineering is parked under `docs/02-context/conversation-engineering/README.md` until the core loop is stable. It should not bypass Context selection, Memory provenance, Safety policy, or Observability traces. Style is a Context input, not a secret second policy channel.

Conversation Engineering 已暂缓在 `docs/02-context/conversation-engineering/README.md` 下，直到核心回路稳定。它不得绕过 Context 选择、Memory 来源追踪、Safety 策略或 Observability trace。风格是 Context 输入，不是秘密的第二策略通道。

The first future input is `ConversationStyleSource`（对话风格来源，描述语气、节奏和关系状态的低优先级上下文来源）. It may include surface style, turn structure, opinion stance, relationship hints, temporal continuity, and session mood. Each field must carry source, confidence, expiry, and safety classification.

第一个未来输入是 `ConversationStyleSource`（对话风格来源，描述语气、节奏和关系状态的低优先级上下文来源）。它可以包含表层风格、话轮结构、观点立场、关系提示、时间连续性和 session mood。每个字段必须携带来源、置信度、过期时间和安全分类。

The first future output is a style placement decision, not a rewritten system prompt. Context may place style guidance in a bounded section with lower priority than safety, user instructions, and task evidence. It must never turn style hints into permission grants, factual claims, or hidden manipulation.

第一个未来输出是风格排布决策，而不是重写后的系统提示。Context 可以把风格指导放进一个有边界的小节，优先级低于安全、用户指令和任务证据。它绝不能把风格提示变成权限授权、事实声明或隐藏操控。

The first acceptance gate is safety precedence. If a style instruction conflicts with safety, tool permissions, project rules, or explicit user requirements, Context must drop or weaken the style instruction and record the reason.

第一道验收门槛是安全优先。如果风格指令与安全、工具权限、项目规则或明确用户需求冲突，Context 必须丢弃或弱化风格指令，并记录原因。

The second acceptance gate is provenance. A user-profile style signal must come from Memory with source receipts and revocation support. A style choice inferred from one message must not become a durable user preference without Memory approval.

第二道验收门槛是来源追踪。用户画像风格信号必须来自 Memory，并带来源凭据和撤销支持。从一条消息推断的风格选择，不能在未经 Memory 批准时变成持久用户偏好。

The third acceptance gate is evaluation. Conversation Engineering should pass paired tests: the same task should preserve factual answer quality and policy compliance while changing only allowed style dimensions. A style improvement that damages correctness is not a pass.

第三道验收门槛是评估。同一任务应通过成对测试：只改变允许的风格维度，同时保持事实回答质量和策略合规。损害正确性的风格提升不算通过。

## 跨组件边界 / Cross-Component Boundaries

Memory owns durable facts, profile updates, contradiction groups, poisoning status, and provenance receipts. Context may rank and place Memory outputs, but it must not rewrite Memory storage or silently promote uncertain Memory into policy.

Memory 负责持久事实、用户画像更新、矛盾组、投毒状态和来源凭据。Context 可以排序和排布 Memory 输出，但不得改写 Memory 存储，也不得静默把不确定 Memory 提升为策略。

Safety owns trust classification, permission gates, injection findings, and unsafe-promotion decisions. Context must consume those results and preserve them in traces rather than duplicating a separate safety classifier.

Safety 负责信任分类、权限门槛、注入发现和不安全提升判断。Context 必须消费这些结果并把它们保留在 trace 中，而不是重复实现一套独立安全分类器。

LLM integration owns provider selection, provider options, model calls, native cache evidence, cost normalization, and first-token latency measurement after the outbound request starts. Context owns the prompt build and local pre-provider latency fields.

LLM integration 负责 provider 选择、provider options、模型调用、原生缓存证据、成本归一化，以及发出请求后的首 token 延迟测量。Context 负责 prompt build 和 provider 请求前的本地延迟字段。

Observability owns trace export, dashboards, alert rules, and failure-to-evaluation conversion. Context must emit machine-joinable events and traces; it should not require human operators to infer decisions from raw text logs.

Observability 负责 trace 导出、dashboard、告警规则和失败转评测样例。Context 必须输出机器可关联的事件和 trace；不应要求人工操作员从原始文本日志里推断决策。

Agent Mesh owns remote handoff and transport beyond the local runtime. Context owns the local meaning of selected sources, compressed spans, cache plans, and resume cursors before any mesh transport carries them.

Agent Mesh 负责本地 runtime 之外的远程交接和传输。Context 负责已选来源、压缩片段、缓存计划和恢复 cursor 的本地语义，然后才由 mesh 传输承载。

## 输入输出契约摘要 / Input And Output Contract Summary

The deferred relevance selector consumes `ContextSource[]`, task intent, active goal, permission state, safety trust state, Memory handoff metadata, file dependency hints, and prior failure traces. It emits an enriched `ContextSelectionTrace`, selected source list, rejected source list, and placement plan.

延后相关性选择器消费 `ContextSource[]`、任务意图、活跃目标、权限状态、安全信任状态、Memory 交接元数据、文件依赖提示和历史失败 trace。它输出增强版 `ContextSelectionTrace`、已选来源列表、拒绝来源列表和排布计划。

The deferred compressor consumes selected sources, token budget, output reserve, cache boundary, loss permissions, citation requirements, and provider capability metadata. It emits `CompressionTrace`, compressed source references, preserved span references, cache impact, and fallback decision.

延后压缩器消费已选来源、token 预算、输出预留、缓存边界、损耗权限、引用要求和 provider 能力元数据。它输出 `CompressionTrace`、压缩后的来源引用、保留片段引用、缓存影响和回退决策。

The deferred delta channel consumes Context events, stream identity, session identity, cache plan identity, last event cursor, cancellation event, and subagent identity. It emits durable event records, resume cursors, dedupe keys, rejection reasons, and observability joins.

延后增量通道消费 Context 事件、stream 标识、session 标识、缓存计划标识、最后事件 cursor、取消事件和 subagent 标识。它输出持久事件记录、恢复 cursor、去重键、拒绝原因和可观测关联键。

The deferred Conversation Engineering integration consumes bounded `ConversationStyleSource` objects, Memory-approved profile signals, temporal continuity inputs, and safety classifications. It emits style placement decisions and trace reasons, not hidden policy rewrites.

延后 Conversation Engineering 集成消费有边界的 `ConversationStyleSource` 对象、经 Memory 批准的用户画像信号、时间连续性输入和安全分类。它输出风格排布决策和 trace 原因，而不是隐藏策略重写。

## 最小验收门槛 / Minimum Acceptance Gates

Gate 1 is prerequisite proof. `QUI-60` must be implemented enough to produce deterministic local traces before `QUI-15` can start runtime work. This prevents the deferred issue from swallowing the current implementation plan.

门槛 1 是前置证明。`QUI-60` 必须实现到能够输出确定性本地 trace 后，`QUI-15` 才能开始 runtime 工作。这能防止延后 issue 吞掉当前实现规划。

Gate 2 is replayability. Every deferred lane must support deterministic replay for local fixtures or preserve enough adaptive inputs to explain why a replay changed.

门槛 2 是可重放。每条延后通道都必须支持本地 fixture 的确定性重放，或保留足够自适应输入来解释为什么重放发生变化。

Gate 3 is safety precedence. Safety rules, permission decisions, explicit user requirements, and provenance receipts outrank selection convenience, compression savings, delta transport convenience, and style adaptation.

门槛 3 是安全优先。安全规则、权限决策、明确用户需求和来源凭据的优先级高于选择便利、压缩节省、增量传输便利和风格适配。

Gate 4 is measurable value. Deferred work must show measurable quality, cost, latency, recovery, or user-experience benefit against a local fixture. A capability that only adds complexity should remain deferred.

门槛 4 是可测价值。延后工作必须在本地 fixture 上证明质量、成本、延迟、恢复或用户体验收益。只增加复杂度的能力应继续延后。

Gate 5 is no benchmark-first execution. Benchmark planning may cite this document, but public benchmark runs should wait until the Context lanes expose stable component metrics and failure samples.

门槛 5 是不做 benchmark-first 执行。Benchmark 规划可以引用本文，但公开 benchmark 运行应等待 Context 各通道暴露稳定组件指标和失败样例。

## Linear 映射 / Linear Mapping

`QUI-15` should stay open after this document. This file documents deferred runtime boundaries; it does not implement relevance selection, adaptive compression, durable delta delivery, or Conversation Engineering integration in code.

`QUI-15` 在本文之后应保持 open。本文记录延后 runtime 边界；它没有在代码中实现相关性选择、自适应压缩、持久增量传递或 Conversation Engineering 集成。

`QUI-60` remains the active implementation slice for first Context runtime contracts. When `QUI-60` lands, use comments on `QUI-15` to decide which deferred lane is ready to reopen, rather than creating new issues under the free-plan issue cap.

`QUI-60` 仍是第一批 Context runtime 契约的活跃实现切片。`QUI-60` 落地后，应在 `QUI-15` comment 中决定哪条延后通道可以重开，而不是在免费版 issue 限额下新建 issue。

`QUI-13` remains the parked Conversation Engineering issue. `QUI-15` should reference `QUI-13` only for the Context-side dependency boundary: how style sources enter Context, how they are placed, and how they are prevented from overriding evidence or safety.

`QUI-13` 仍是暂缓的 Conversation Engineering issue。`QUI-15` 只应从 Context 侧依赖边界引用 `QUI-13`：风格来源如何进入 Context、如何排布，以及如何防止它覆盖证据或安全。

`QUI-45` can absorb process-level deferred triage refinements. It should not absorb the component-specific runtime findings from `QUI-15` unless the question is about issue reuse, closure policy, or backlog routing.

`QUI-45` 可以承接流程级 deferred triage 优化。除非问题涉及 issue 复用、关闭策略或 backlog 路由，否则它不应吸收 `QUI-15` 的组件专属 runtime finding。

## 参考 / References

Local source: `docs/02-context/context-frontier-assimilation.md` defines the Context frontier decision and the first mapping to `QUI-49`, `QUI-60`, `QUI-51`, `QUI-65`, `QUI-73`, and `QUI-74`.

本地来源：`docs/02-context/context-frontier-assimilation.md` 定义 Context 前沿决策，以及到 `QUI-49`、`QUI-60`、`QUI-51`、`QUI-65`、`QUI-73` 和 `QUI-74` 的第一层映射。

Local source: `docs/02-context/context-runtime-implementation-plan.md` defines the current `QUI-60` implementation contract and is the prerequisite for reopening `QUI-15`.

本地来源：`docs/02-context/context-runtime-implementation-plan.md` 定义当前 `QUI-60` 实现契约，也是重开 `QUI-15` 的前置条件。

Local source: `docs/02-context/conversation-engineering/README.md` defines the parked Conversation Engineering scope and states that 02 Context remains the owner of prompt assembly.

本地来源：`docs/02-context/conversation-engineering/README.md` 定义暂缓的 Conversation Engineering 范围，并说明 02 Context 仍然负责 prompt 组装。

External source: MCP Streamable HTTP specification version 2025-06-18 documents POST/GET transport, optional server-sent events, session identifiers, event identifiers, `Last-Event-ID`, and the rule that disconnect should not be treated as cancellation. Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

外部来源：MCP Streamable HTTP specification 2025-06-18 版本记录了 POST/GET transport、可选 server-sent events、session 标识、event 标识、`Last-Event-ID`，以及断开连接不应被视为取消的规则。来源：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

External source: Vercel AI SDK 6.x Chatbot Resume Streams documents that stream resumption requires application persistence for messages, active stream identifiers, stream data, and resume endpoints. Source: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams

外部来源：Vercel AI SDK 6.x Chatbot Resume Streams 文档说明，流恢复需要应用持久化 messages、活跃 stream 标识、stream data 和 resume endpoint。来源：https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams

External source: Anthropic context editing documentation records provider-side clearing of thinking/tool-use content, `cleared_input_tokens`, and token-count previews after context management. Source: https://platform.claude.com/docs/en/build-with-claude/context-editing

外部来源：Anthropic context editing 文档记录了供应商侧清理 thinking/tool-use 内容、`cleared_input_tokens`，以及 context management 后的 token-count 预览。来源：https://platform.claude.com/docs/en/build-with-claude/context-editing

External source: OpenAI conversation state documentation describes durable conversation objects that persist messages, tool calls, tool outputs, and related items across sessions, devices, or jobs. Source: https://developers.openai.com/api/docs/guides/conversation-state

外部来源：OpenAI conversation state 文档说明了持久 conversation object，可以跨 session、设备或 job 保存 messages、tool calls、tool outputs 和相关 items。来源：https://developers.openai.com/api/docs/guides/conversation-state

