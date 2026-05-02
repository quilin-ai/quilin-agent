# Context 运行层实现规划 / Context Runtime Implementation Plan

> Scope: Linear `QUI-60`. This document turns the Context frontier decision in `docs/02-context/context-frontier-assimilation.md` and the route/cache/cost evidence in `docs/01-llm-integration/routing-cache-cost-evidence.md` into an implementation plan. Memory integration references `docs/03-memory/memory-frontier-assimilation.md` only at the Context boundary. Benchmark（基准测试，用统一输入和评分比较系统能力）work is frozen unless the user explicitly asks; this plan strengthens the Context runtime（上下文运行层，即负责选择、压缩、缓存和追踪上下文的运行时组件）contract.

> 范围：Linear `QUI-60`。本文把 `docs/02-context/context-frontier-assimilation.md` 的 Context 前沿决策，以及 `docs/01-llm-integration/routing-cache-cost-evidence.md` 的路由、缓存、成本证据，转成实现规划。Memory 集成只在 Context 边界参考 `docs/03-memory/memory-frontier-assimilation.md`。除非用户明确要求，benchmark（基准测试，用统一输入和评分比较系统能力）工作保持冻结；本文目标是把 Context runtime（上下文运行层，即负责选择、压缩、缓存和追踪上下文的运行时组件）契约做强。

## 结论 / Decision

`QUI-60` should implement a measurable Context pipeline rather than another prompt assembly helper. The pipeline is: normalize `ContextSource`（上下文来源，进入提示词候选池的结构化信息单元）, accept Memory block handoff（记忆块交接，Memory 组件把有来源凭据的稳定块交给 Context）, select relevant sources, compress only when useful, emit `CachePlan`（缓存计划，说明哪些前缀可被供应商提示缓存复用）, assemble the prompt, and record trace（结构化执行轨迹，用来还原一次上下文决策过程）artifacts for metrics and review.

`QUI-60` 应实现一个可度量的 Context 流水线，而不是再写一个 prompt assembly（提示词组装）辅助函数。流水线顺序是：标准化 `ContextSource`（上下文来源，进入提示词候选池的结构化信息单元）、接收 Memory block handoff（记忆块交接，Memory 组件把有来源凭据的稳定块交给 Context）、选择相关来源、只在有收益时压缩、输出 `CachePlan`（缓存计划，说明哪些前缀可被供应商提示缓存复用）、组装提示词，并记录 trace（结构化执行轨迹，用来还原一次上下文决策过程）产物供指标和 review 使用。

The implementation must keep three boundaries separate. Context decides what enters the prompt. LLM routing（Large Language Model routing，大语言模型路由，即把任务分配到合适模型或供应商路径）decides which provider（模型供应商或推理服务路径）executes the call. Memory decides which facts exist and how trustworthy they are. Mixing those boundaries makes cache evidence, quality regressions, and memory poisoning failures hard to diagnose.

实现必须把三条边界分开。Context 决定什么进入提示词。LLM routing（Large Language Model routing，大语言模型路由，即把任务分配到合适模型或供应商路径）决定由哪个 provider（模型供应商或推理服务路径）执行调用。Memory 决定哪些事实存在以及它们是否可信。混合这些边界会让缓存证据、质量回归和记忆投毒失败难以定位。

## 输入依据 / Inputs

`docs/02-context/context-frontier-assimilation.md` defines the five-stage target: `ContextSource` normalization, relevance gating（相关性门控，用明确条件过滤不该进入提示词的信息）, evidence ordering（证据排布，把重要信息放到长上下文中更容易被模型利用的位置）, budget-aware compression（预算感知压缩，在 token 预算内保留关键事实）, and cache/delta instrumentation（缓存与增量通道埋点，用结构化数据记录缓存与流恢复状态）.

`docs/02-context/context-frontier-assimilation.md` 定义了五阶段目标：`ContextSource` 标准化、relevance gating（相关性门控，用明确条件过滤不该进入提示词的信息）、evidence ordering（证据排布，把重要信息放到长上下文中更容易被模型利用的位置）、budget-aware compression（预算感知压缩，在 token 预算内保留关键事实），以及 cache/delta instrumentation（缓存与增量通道埋点，用结构化数据记录缓存与流恢复状态）。

`docs/01-llm-integration/routing-cache-cost-evidence.md` defines the metric shape that Context must feed: prompt cache（提示缓存，供应商侧复用重复提示词前缀来降低成本和延迟）native evidence, TTFT（Time To First Token，首 token 延迟，从供应商请求发出到第一个流式语义事件返回的时间）, token cost（token 成本，按输入、缓存读写、输出和供应商价格计算的费用）, and output quality（输出质量，用固定样例和评分规则判断回答是否可用）.

`docs/01-llm-integration/routing-cache-cost-evidence.md` 定义了 Context 必须供给的指标形态：prompt cache（提示缓存，供应商侧复用重复提示词前缀来降低成本和延迟）原生证据、TTFT（Time To First Token，首 token 延迟，从供应商请求发出到第一个流式语义事件返回的时间）、token cost（token 成本，按输入、缓存读写、输出和供应商价格计算的费用），以及 output quality（输出质量，用固定样例和评分规则判断回答是否可用）。

`docs/03-memory/memory-frontier-assimilation.md` defines the handoff requirement: Memory returns stable, source-grounded blocks with provenance receipts（来源凭据，说明事实从哪里来、如何被生成、可信度如何）, while Context chooses, compresses, places, and measures those blocks. Context must never hide memory trust, contradiction, or poisoning status.

`docs/03-memory/memory-frontier-assimilation.md` 定义了交接要求：Memory 返回稳定、有来源支撑的块，并带 provenance receipts（来源凭据，说明事实从哪里来、如何被生成、可信度如何）；Context 负责选择、压缩、放置和度量这些块。Context 绝不能隐藏记忆可信度、矛盾状态或投毒状态。

## 运行流水线 / Runtime Pipeline

Stage 1 normalizes every input into `ContextSource`. Sources include system instructions, user turns, tool results, file snapshots, Memory blocks, current time, active goal state, and safety rules. Each source must have a stable identifier, content hash（内容摘要，用来判断内容是否变化）, token estimate, trust tier（信任等级，用来限制低可信内容的用途）, freshness, and cache volatility（缓存波动性，用来判断内容是否适合放入稳定前缀）.

第一阶段把所有输入标准化成 `ContextSource`。来源包括系统指令、用户轮次、工具结果、文件快照、Memory block、当前时间、活跃目标状态和安全规则。每个来源必须有稳定标识、content hash（内容摘要，用来判断内容是否变化）、token 估算、trust tier（信任等级，用来限制低可信内容的用途）、时效性和 cache volatility（缓存波动性，用来判断内容是否适合放入稳定前缀）。

Stage 2 accepts Memory block handoff. Context receives Memory facts as blocks with provenance, validity windows, contradiction groups, poisoning status, and invalidation keys. Context does not read raw Memory storage directly; it consumes a typed handoff so Memory can evolve independently under `QUI-51` and `QUI-65`.

第二阶段接收 Memory block handoff。Context 收到的 Memory facts（记忆事实）必须是带来源、有效期窗口、矛盾组、投毒状态和失效键的 block。Context 不直接读取原始 Memory 存储；它消费类型化交接，这样 Memory 可以在 `QUI-51` 和 `QUI-65` 下独立演进。

Stage 3 selects relevant sources. The selector first filters by permission, trust, task boundary, and source freshness. It then scores candidates by semantic match（语义匹配，判断内容与当前任务意思是否接近）, keyword overlap, source authority, dependency to current files, user intent match, and contradiction risk. The output is `ContextSelectionTrace`.

第三阶段选择相关来源。选择器先按权限、可信度、任务边界和来源时效性过滤，再按 semantic match（语义匹配，判断内容与当前任务意思是否接近）、关键词重合、来源权威度、与当前文件的依赖关系、用户意图匹配和矛盾风险打分。输出是 `ContextSelectionTrace`。

Stage 4 compresses only under an explicit trigger. Triggers include token budget pressure, cache economics, repeated tool-output bulk, and quality risk from long-context placement. The compressor must choose between no compression, lossless trimming（无损清理，只删除机械噪声）, extractive compression（抽取式压缩，保留原文引用片段）, abstractive summary（摘要式压缩，用新文本概括低风险历史）, and provider context editing（供应商上下文编辑，由模型服务端清理旧内容）.

第四阶段只在明确触发时压缩。触发条件包括 token 预算压力、缓存经济性、重复工具输出膨胀，以及长上下文排布带来的质量风险。压缩器必须在不压缩、lossless trimming（无损清理，只删除机械噪声）、extractive compression（抽取式压缩，保留原文引用片段）、abstractive summary（摘要式压缩，用新文本概括低风险历史）和 provider context editing（供应商上下文编辑，由模型服务端清理旧内容）之间选择。

Stage 5 emits `CachePlan` before the model call. Stable instructions, stable tool schema（工具结构约定，说明工具参数和返回形态）, and durable project context can enter the cacheable prefix; per-turn user input, current time, volatile Memory recalls, and fresh tool outputs stay in the dynamic suffix（动态后缀，每轮变化且不应污染缓存前缀的内容）.

第五阶段在模型调用前输出 `CachePlan`。稳定指令、稳定工具 schema（工具结构约定，说明工具参数和返回形态）和持久项目上下文可以进入可缓存前缀；每轮用户输入、当前时间、易变 Memory 召回和新鲜工具输出留在 dynamic suffix（动态后缀，每轮变化且不应污染缓存前缀的内容）。

Stage 6 records `DeltaStreamTrace`（增量流轨迹，用来记录哪些上下文事件已经发送、如何从断点恢复）for resumability. Context emits typed events such as `context.source_selected`, `context.source_compressed`, `context.cache_plan_emitted`, and `context.delta_sent`. A reconnecting client resumes from an event cursor（事件游标，表示已消费到哪条事件）, not from a rebuilt full prompt.

第六阶段记录 `DeltaStreamTrace`（增量流轨迹，用来记录哪些上下文事件已经发送、如何从断点恢复）以支持恢复。Context 输出类型化事件，例如 `context.source_selected`、`context.source_compressed`、`context.cache_plan_emitted` 和 `context.delta_sent`。断线重连的客户端从 event cursor（事件游标，表示已消费到哪条事件）恢复，而不是重新构造完整提示词。

## 数据契约：ContextSource / Data Contract: ContextSource

`ContextSource` is the single input unit for selection and compression. Minimum fields: `source_id`, `source_kind`, `content_ref`, `content_hash`, `token_estimate`, `created_at`, `updated_at`, `trust_tier`, `permission_scope`, `source_authority`, `freshness_score`, `cache_volatility`, `placement_hint`, `citation_required`, `provenance_receipt_ids`, and `metadata`.

`ContextSource` 是选择和压缩的唯一输入单元。最小字段包括：`source_id`、`source_kind`、`content_ref`、`content_hash`、`token_estimate`、`created_at`、`updated_at`、`trust_tier`、`permission_scope`、`source_authority`、`freshness_score`、`cache_volatility`、`placement_hint`、`citation_required`、`provenance_receipt_ids` 和 `metadata`。

`source_kind` should start with `system_instruction`, `developer_rule`, `user_turn`, `tool_result`, `file_snapshot`, `memory_block`, `active_goal`, `current_time`, `agent_state`, and `safety_rule`. This list is intentionally explicit so a low-trust web page or tool result cannot masquerade as a system rule.

`source_kind` 初始应包含 `system_instruction`、`developer_rule`、`user_turn`、`tool_result`、`file_snapshot`、`memory_block`、`active_goal`、`current_time`、`agent_state` 和 `safety_rule`。这个列表刻意保持显式，避免低可信网页或工具结果伪装成系统规则。

`cache_volatility` should be one of `stable`, `session_stable`, `turn_stable`, or `volatile`. `stable` means safe for reusable prompt prefix; `session_stable` means reusable only inside one session; `turn_stable` means fixed during one model call; `volatile` means it must stay outside the cacheable prefix.

`cache_volatility` 应是 `stable`、`session_stable`、`turn_stable` 或 `volatile`。`stable` 表示可进入可复用提示词前缀；`session_stable` 表示只在一个 session 内可复用；`turn_stable` 表示只在一次模型调用内固定；`volatile` 表示必须留在可缓存前缀之外。

## 数据契约：Memory Block Handoff / Data Contract: Memory Block Handoff

Memory block handoff is a typed subset of `ContextSource` where `source_kind` is `memory_block`. Required Memory-specific fields: `memory_block_id`, `fact_ids`, `memory_kind`, `entities`, `valid_from`, `valid_to`, `supersedes`, `invalidates`, `contradiction_group_id`, `poisoning_status`, `retrieval_scores`, `stable_block_hash`, `invalidation_key`, and `profile_impact`.

Memory block handoff 是 `ContextSource` 的类型化子集，其中 `source_kind` 为 `memory_block`。Memory 专属必需字段包括：`memory_block_id`、`fact_ids`、`memory_kind`、`entities`、`valid_from`、`valid_to`、`supersedes`、`invalidates`、`contradiction_group_id`、`poisoning_status`、`retrieval_scores`、`stable_block_hash`、`invalidation_key` 和 `profile_impact`。

`retrieval_scores` should preserve Memory-side signals rather than flattening them into one number. Minimum fields are `semantic_score`, `keyword_score`, `entity_score`, `temporal_score`, `authority_score`, and `confidence`. Context may combine them, but the trace must retain the original components for later review.

`retrieval_scores` 应保留 Memory 侧信号，而不是压成一个数字。最小字段是 `semantic_score`、`keyword_score`、`entity_score`、`temporal_score`、`authority_score` 和 `confidence`。Context 可以组合这些分数，但 trace 必须保留原始组成，方便后续 review。

If `poisoning_status` is not `clean`, Context may cite the block for factual review but must not turn it into an instruction, permission grant, stable user preference, or procedural rule. This preserves the safety boundary from `QUI-51`, `QUI-53`, and `QUI-65`.

如果 `poisoning_status` 不是 `clean`，Context 可以把该 block 作为事实 review 的引用，但不得把它变成指令、权限授权、稳定用户偏好或流程规则。这保留了 `QUI-51`、`QUI-53` 和 `QUI-65` 的安全边界。

## 数据契约：ContextSelectionTrace / Data Contract: ContextSelectionTrace

`ContextSelectionTrace` records why each source was selected, rejected, or delayed. Minimum fields: `trace_id`, `run_id`, `prompt_build_id`, `task_intent`, `budget_tokens`, `candidate_source_ids`, `rejected_sources`, `selected_sources`, `score_breakdown`, `ordering_decision`, `placement_region`, `selection_policy_version`, and `determinism_key`.

`ContextSelectionTrace` 记录每个 source 为什么被选择、拒绝或延后。最小字段包括：`trace_id`、`run_id`、`prompt_build_id`、`task_intent`、`budget_tokens`、`candidate_source_ids`、`rejected_sources`、`selected_sources`、`score_breakdown`、`ordering_decision`、`placement_region`、`selection_policy_version` 和 `determinism_key`。

`rejected_sources` must include a reason code. Initial reason codes: `permission_denied`, `below_relevance_threshold`, `stale_source`, `lower_authority_duplicate`, `poisoning_risk`, `contradiction_unresolved`, `budget_exhausted`, and `cache_boundary_violation`.

`rejected_sources` 必须包含原因代码。初始原因代码包括：`permission_denied`、`below_relevance_threshold`、`stale_source`、`lower_authority_duplicate`、`poisoning_risk`、`contradiction_unresolved`、`budget_exhausted` 和 `cache_boundary_violation`。

`placement_region` should be `front`, `middle`, `near_user_turn`, or `excluded`. High-priority rules and active goals belong near the front; current user input and high-value evidence belong near the final user turn; bulky low-risk background context belongs in the middle only after selection and compression.

`placement_region` 应是 `front`、`middle`、`near_user_turn` 或 `excluded`。高优先级规则和活跃目标靠前；当前用户输入和高价值证据靠近最后用户轮次；体积大的低风险背景上下文只有经过选择和压缩后才放在中部。

## 数据契约：CompressionTrace / Data Contract: CompressionTrace

`CompressionTrace` records the exact tradeoff made under budget pressure. Minimum fields: `trace_id`, `prompt_build_id`, `trigger_reason`, `target_budget_tokens`, `pre_compression_tokens`, `post_compression_tokens`, `compression_lane`, `source_ids`, `cited_span_ids_preserved`, `dropped_span_ids`, `loss_mode`, `confidence`, `cache_impact`, and `quality_risk`.

`CompressionTrace` 记录预算压力下做出的具体取舍。最小字段包括：`trace_id`、`prompt_build_id`、`trigger_reason`、`target_budget_tokens`、`pre_compression_tokens`、`post_compression_tokens`、`compression_lane`、`source_ids`、`cited_span_ids_preserved`、`dropped_span_ids`、`loss_mode`、`confidence`、`cache_impact` 和 `quality_risk`。

`loss_mode` should be `lossless`, `extractive`, `abstractive_low_risk`, or `provider_side`. Exact cited spans, explicit user requirements, safety policy, permission decisions, and source receipts cannot use lossy compression unless the trace records a human-approved exception.

`loss_mode` 应是 `lossless`、`extractive`、`abstractive_low_risk` 或 `provider_side`。精确引用片段、明确用户需求、安全策略、权限决策和来源凭据不得使用有损压缩，除非 trace 记录了人工批准的例外。

`cache_impact` must state whether compression changes `stable_prefix_hash`. If a compression step rewrites cached-prefix content, it starts a new cache lineage（缓存血缘，表示一个可缓存前缀的版本链）and cannot claim a warm-cache improvement from the previous lineage.

`cache_impact` 必须说明压缩是否改变 `stable_prefix_hash`。如果压缩步骤改写了缓存前缀内容，它就开启新的 cache lineage（缓存血缘，表示一个可缓存前缀的版本链），不能再声称沿用了上一条血缘的热缓存收益。

## 数据契约：CachePlan / Data Contract: CachePlan

`CachePlan` is emitted after selection and compression but before the outbound model request. Minimum fields: `cache_plan_id`, `prompt_build_id`, `provider_path`, `model_family`, `cache_strategy`, `stable_prefix_hash`, `eligible_prefix_tokens`, `dynamic_suffix_tokens`, `cache_boundary_source_ids`, `excluded_volatile_source_ids`, `retention_policy`, `provider_options`, and `expected_usage_fields`.

`CachePlan` 在选择和压缩之后、发出模型请求之前输出。最小字段包括：`cache_plan_id`、`prompt_build_id`、`provider_path`、`model_family`、`cache_strategy`、`stable_prefix_hash`、`eligible_prefix_tokens`、`dynamic_suffix_tokens`、`cache_boundary_source_ids`、`excluded_volatile_source_ids`、`retention_policy`、`provider_options` 和 `expected_usage_fields`。

`cache_strategy` should start with `stable-system-prefix`, `provider-explicit-breakpoint`, `conversation-append-only-prefix`, and `route-local-cache-identity`. These names map directly to the strategies in `docs/01-llm-integration/routing-cache-cost-evidence.md`.

`cache_strategy` 初始应包含 `stable-system-prefix`、`provider-explicit-breakpoint`、`conversation-append-only-prefix` 和 `route-local-cache-identity`。这些名称直接映射到 `docs/01-llm-integration/routing-cache-cost-evidence.md` 中的策略。

`provider_options` is provider-specific but must be auditable. OpenAI may include `prompt_cache_key` and retention mode. Anthropic may include `cache_control` breakpoints. Google/Gemini may include `cachedContent` and TTL（Time To Live，缓存存活时间）. DeepSeek relies on byte-stable prefix construction and usage fields such as cache hit and miss tokens.

`provider_options` 与供应商相关，但必须可审计。OpenAI 可包含 `prompt_cache_key` 和保留模式。Anthropic 可包含 `cache_control` 断点。Google/Gemini 可包含 `cachedContent` 和 TTL（Time To Live，缓存存活时间）。DeepSeek 依赖字节稳定前缀构造，以及缓存命中/未命中 token 等用量字段。

## 数据契约：DeltaStreamTrace / Data Contract: DeltaStreamTrace

`DeltaStreamTrace` records resumable context delivery. Minimum fields: `delta_trace_id`, `session_id`, `stream_id`, `event_id`, `event_type`, `source_hashes`, `stable_prefix_hash`, `cache_plan_id`, `resume_cursor`, `payload_bytes`, `dedupe_key`, and `delivered_at`.

`DeltaStreamTrace` 记录可恢复的上下文传递。最小字段包括：`delta_trace_id`、`session_id`、`stream_id`、`event_id`、`event_type`、`source_hashes`、`stable_prefix_hash`、`cache_plan_id`、`resume_cursor`、`payload_bytes`、`dedupe_key` 和 `delivered_at`。

The resume invariant is strict: reconnecting from `resume_cursor` must not duplicate already delivered context events, must not silently skip selected sources, and must not infer cancellation from a transport disconnect. Cancellation needs its own explicit event.

恢复不变量必须严格：从 `resume_cursor` 重连时不得重复已传递的上下文事件，不得静默跳过已选来源，也不得从传输断开推断取消。取消需要独立的显式事件。

## 指标：提示缓存与 TTFT / Metrics: Prompt Cache And TTFT

Prompt cache metrics must join the planned cache boundary with provider-native evidence. Each model call should store `eligible_prefix_tokens`, `stable_prefix_hash`, `cache_strategy`, `provider_path`, `cache_read_tokens`, `cache_write_tokens`, provider raw usage, `cache_hit_ratio`, and `cache_unit_cost_usd`.

提示缓存指标必须把计划中的缓存边界与供应商原生证据关联起来。每次模型调用应保存 `eligible_prefix_tokens`、`stable_prefix_hash`、`cache_strategy`、`provider_path`、`cache_read_tokens`、`cache_write_tokens`、供应商原始 usage、`cache_hit_ratio` 和 `cache_unit_cost_usd`。

TTFT（Time To First Token，首 token 延迟） measurement starts after local prompt assembly finishes and immediately before the outbound provider request begins. It stops at the first streamed semantic event: text delta, reasoning delta, tool-call-start, or tool-call-args-delta. Final response latency is a separate metric and cannot substitute for TTFT.

TTFT（Time To First Token，首 token 延迟）测量从本地提示词组装完成、即将发出供应商请求时开始。它在第一个流式语义事件到达时结束：text delta、reasoning delta、tool-call-start 或 tool-call-args-delta。最终响应延迟是独立指标，不能替代 TTFT。

Context should also record local latency before the provider request: `source_collection_ms`, `selection_ms`, `compression_ms`, `cache_plan_ms`, and `prompt_assembly_ms`. Without these fields, a TTFT regression cannot be separated from a slow selector or compressor.

Context 还应记录供应商请求前的本地延迟：`source_collection_ms`、`selection_ms`、`compression_ms`、`cache_plan_ms` 和 `prompt_assembly_ms`。没有这些字段时，无法区分 TTFT 回归来自供应商、选择器变慢还是压缩器变慢。

## 质量评估 / Quality Evaluation

The first quality gate is local and deterministic. Fixed fixtures（固定测试样例，用来重复验证同一行为）should cover relevant-source retention, irrelevant-source rejection, stale-source rejection, contradiction preservation, memory poisoning containment, citation stability, and abstention when evidence is missing.

第一道质量门槛是本地且确定性的。固定 fixtures（固定测试样例，用来重复验证同一行为）应覆盖相关来源保留、无关来源拒绝、陈旧来源拒绝、矛盾保留、记忆投毒隔离、引用稳定性，以及证据缺失时拒答。

The second quality gate checks compression. A compressed prompt passes only if exact cited spans remain available, explicit user requirements are not summarized away, safety rules are intact, and the answer quality matches the uncompressed reference within the fixture rubric（评分量表，用固定标准判断答案是否可接受）.

第二道质量门槛检查压缩。压缩后的提示词只有在精确引用片段仍可用、明确用户需求没有被摘要抹掉、安全规则完整，并且回答质量按 fixture rubric（评分量表，用固定标准判断答案是否可接受）不低于未压缩参考时才通过。

The third quality gate checks cache behavior. Changing current time, volatile Memory recall, or a user suffix must not change the stable prefix hash. Changing system rules, tool schema, safety policy, or durable project context must change the stable prefix hash and force a new `CachePlan`.

第三道质量门槛检查缓存行为。改变当前时间、易变 Memory 召回或用户后缀，不得改变稳定前缀 hash。改变系统规则、工具 schema、安全策略或持久项目上下文，必须改变稳定前缀 hash 并强制生成新的 `CachePlan`。

The fourth quality gate checks delta stream recovery. A resumed stream must continue from the last event, preserve selected source hashes, keep the same `CachePlan` when the prefix is unchanged, and reject incompatible cursors with an explicit error.

第四道质量门槛检查增量流恢复。恢复后的流必须从最后事件继续，保留已选 source hash，在前缀未变时保持同一个 `CachePlan`，并对不兼容 cursor 输出显式错误。

## 失败案例 / Failure Cases

Failure case 1: an irrelevant but semantically similar document outranks a high-authority current project document. Expected behavior: the selector rejects or demotes the irrelevant document and records `lower_authority_duplicate` or `below_relevance_threshold`.

失败案例 1：一个语义相似但无关的文档排在高权威当前项目文档前面。预期行为：选择器拒绝或降级无关文档，并记录 `lower_authority_duplicate` 或 `below_relevance_threshold`。

Failure case 2: a low-trust Memory block says to change permissions or user preferences. Expected behavior: Context may surface it as a questionable fact, but it cannot place it in the stable instruction prefix or promote it into a policy rule.

失败案例 2：低可信 Memory block 声称要改变权限或用户偏好。预期行为：Context 可以把它作为可疑事实暴露，但不能把它放入稳定指令前缀，也不能提升为策略规则。

Failure case 3: compression removes a cited span that is required to justify the answer. Expected behavior: the compressed output fails the fixture and `CompressionTrace` records `quality_risk` instead of silently passing.

失败案例 3：压缩移除了支撑答案所必需的引用片段。预期行为：压缩产物无法通过 fixture，并且 `CompressionTrace` 记录 `quality_risk`，不得静默通过。

Failure case 4: a fresh timestamp or per-turn Memory recall changes the stable prefix hash. Expected behavior: the cache fixture fails because volatile data crossed the cache boundary.

失败案例 4：新时间戳或每轮 Memory 召回改变了稳定前缀 hash。预期行为：缓存 fixture 失败，因为易变数据越过了缓存边界。

Failure case 5: the provider response lacks native cache evidence even though the chosen provider path exposes it. Expected behavior: the cache metric is `fail` or `blocked_with_raw_error`, never inferred only from wall-clock speed.

失败案例 5：所选供应商路径本应暴露原生缓存证据，但供应商响应缺失该证据。预期行为：缓存指标是 `fail` 或 `blocked_with_raw_error`，绝不能只靠墙钟速度推断。

Failure case 6: stream resume duplicates a previous context delta. Expected behavior: `DeltaStreamTrace` detects the duplicate `dedupe_key`, skips duplicate delivery, and records the recovery decision.

失败案例 6：流恢复重复发送了上一条上下文增量。预期行为：`DeltaStreamTrace` 检测重复 `dedupe_key`，跳过重复传递，并记录恢复决策。

## 实施顺序 / Implementation Order

Step 1 defines the TypeScript data contracts（TypeScript 数据契约，用类型明确模块之间传递的数据形状）for `ContextSource`, Memory block handoff, `ContextSelectionTrace`, `CompressionTrace`, `CachePlan`, and `DeltaStreamTrace`. This step should not include provider live calls.

第一步定义 TypeScript data contracts（TypeScript 数据契约，用类型明确模块之间传递的数据形状），覆盖 `ContextSource`、Memory block handoff、`ContextSelectionTrace`、`CompressionTrace`、`CachePlan` 和 `DeltaStreamTrace`。这一步不应包含供应商真实调用。

Step 2 builds deterministic local fixtures for selection, compression, cache boundary stability, and delta resume. These fixtures should run without network access and should produce stable JSON（JavaScript Object Notation，一种结构化数据格式）trace snapshots.

第二步构建用于选择、压缩、缓存边界稳定性和增量恢复的确定性本地 fixture。这些 fixture 应在无网络环境下运行，并输出稳定的 JSON（JavaScript Object Notation，一种结构化数据格式）trace snapshot（轨迹快照）。

Step 3 connects Memory block handoff from `QUI-51` and `QUI-65` fixtures. Until the Memory runtime is complete, Context can use typed fixture blocks with the same fields and provenance shape.

第三步接入 `QUI-51` 和 `QUI-65` 的 Memory block handoff fixture。在 Memory runtime 完成前，Context 可以使用字段和来源形态一致的类型化 fixture block。

Step 4 wires Context traces into `QUI-74` metrics. `QUI-74` remains the owner of provider cache thresholds, cost normalization, and live provider matrix; `QUI-60` supplies the Context-side trace inputs that make those metrics explainable.

第四步把 Context trace 接入 `QUI-74` 指标。`QUI-74` 仍负责供应商缓存阈值、成本归一化和真实供应商矩阵；`QUI-60` 提供 Context 侧 trace 输入，让这些指标可以解释。

Step 5 runs provider live checks only after local component gates are green. This keeps benchmark-first work out of the critical path while still preserving a route to real cache, TTFT, cost, and quality validation.

第五步只在本地组件门槛通过后运行供应商真实检查。这样不会让 benchmark-first 工作进入关键路径，同时保留通向真实缓存、TTFT、成本和质量验证的路线。

## Linear 映射 / Linear Mapping

`QUI-60` owns this implementation plan and the Context runtime contract. Its close condition should require the data contracts, deterministic fixtures, trace snapshots, cache boundary tests, compression tests, and delta resume tests.

`QUI-60` 负责本文实现规划和 Context runtime 契约。它的关闭条件应要求完成数据契约、确定性 fixture、trace snapshot、缓存边界测试、压缩测试和增量恢复测试。

`QUI-49` remains the frontier decision record. If this plan changes the decision, update `QUI-49` by comment rather than creating a new issue.

`QUI-49` 保持为前沿决策记录。如果本文改变了决策，应通过 comment 更新 `QUI-49`，而不是创建新 issue。

`QUI-74` owns provider cache, route, cost, TTFT, and quality thresholds. `QUI-60` must emit `CachePlan`, prompt build traces, and local latency fields so `QUI-74` can explain provider-level results.

`QUI-74` 负责供应商缓存、路由、成本、TTFT 和质量阈值。`QUI-60` 必须输出 `CachePlan`、提示词构建 trace 和本地延迟字段，让 `QUI-74` 能解释供应商层结果。

`QUI-51` owns Memory architecture and `QUI-65` owns Memory runtime implementation. `QUI-60` consumes Memory block handoff and must not duplicate Memory storage, observer, or poisoning-promotion logic.

`QUI-51` 负责 Memory 架构，`QUI-65` 负责 Memory runtime 实现。`QUI-60` 消费 Memory block handoff，不得重复实现 Memory 存储、观察器或投毒提升逻辑。

No new Linear issue is required. The existing issues `QUI-60`, `QUI-49`, `QUI-74`, `QUI-51`, and `QUI-65` are sufficient under the 250-issue free-plan constraint.

不需要新建 Linear issue。在 250 issue 免费版限制下，现有 `QUI-60`、`QUI-49`、`QUI-74`、`QUI-51` 和 `QUI-65` 已足够承接这项工作。

## 最小验收 / Minimum Acceptance

The first acceptance gate is contract completeness: all six artifacts exist and every artifact carries `run_id`, `prompt_build_id` or equivalent correlation keys, source hashes, policy versions, and enough raw evidence for later review.

第一道验收门槛是契约完整性：六类产物全部存在，并且每类产物都携带 `run_id`、`prompt_build_id` 或等价关联键、source hash、策略版本，以及足够供后续 review 的原始证据。

The second acceptance gate is deterministic replay: with the same fixture inputs, source ordering, compression output, stable prefix hash, cache plan, and delta event sequence must be identical.

第二道验收门槛是确定性重放：在相同 fixture 输入下，source 排序、压缩输出、稳定前缀 hash、缓存计划和增量事件序列必须一致。

The third acceptance gate is safety preservation: low-trust, poisoned, contradictory, or permission-denied content must not enter stable instruction prefix, permission state, user profile, or procedural memory.

第三道验收门槛是安全保持：低可信、被投毒、存在矛盾或权限拒绝的内容，不得进入稳定指令前缀、权限状态、用户画像或流程记忆。

The fourth acceptance gate is observability: every prompt build emits `ContextSelectionTrace`, optional `CompressionTrace`, required `CachePlan`, local latency fields, and `DeltaStreamTrace` when streaming or resume is active.

第四道验收门槛是可观测性：每次提示词构建都输出 `ContextSelectionTrace`、可选 `CompressionTrace`、必需 `CachePlan`、本地延迟字段，并在流式或恢复启用时输出 `DeltaStreamTrace`。

The fifth acceptance gate is benchmark deferral discipline: public benchmark execution is blocked until the local Context runtime gates pass. Benchmark planning can reference this document, but it must not replace the component contract work.

第五道验收门槛是 benchmark 后置纪律：公开 benchmark 执行必须等本地 Context runtime 门槛通过。benchmark 规划可以引用本文，但不得替代组件契约工作。
