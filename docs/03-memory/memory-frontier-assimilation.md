# Memory 前沿吸收决策 / Memory Frontier Assimilation Decision

Evidence checked on 2026-05-02 Asia/Shanghai. This document records the `QUI-51` decision for OmniMem（Quilin 的四层记忆系统，包含 working / episodic / semantic / skill memory）after reviewing current high-signal memory systems, current project docs, and the existing [long-memory evaluation baseline](long-memory-evaluation-baseline.md).

证据已在 2026-05-02 Asia/Shanghai 校准。本文记录 `QUI-51` 对 OmniMem（Quilin 的四层记忆系统，包含 working / episodic / semantic / skill memory）的决策，输入包括当前高信号记忆系统、项目现有文档，以及已有的 [长期记忆评测基线](long-memory-evaluation-baseline.md)。

Benchmark（基准测试，用统一输入和评分比较系统能力）work is not the first priority here. The decision below is about making the Memory component strong enough first; LongMemEval（长期记忆能力评测）、LoCoMo（长对话记忆评测）and BEAM-style checks（借鉴百万级上下文记忆评测思想的本地检查）remain verification lanes after the component contract is clear.

这里 benchmark（基准测试，用统一输入和评分比较系统能力）不是第一优先级。下面的决策目标是先把 Memory 组件做强；LongMemEval（长期记忆能力评测）、LoCoMo（长对话记忆评测）和 BEAM-style checks（借鉴百万级上下文记忆评测思想的本地检查）保留为组件契约清晰后的验证通道。

## 结论 / Decision

Quilin should keep the OmniMem direction, but update the F1（Linear 中的下一阶段实现迭代，用于把 F0 决策落成 runtime slices；runtime slices 是可独立实现和验收的运行时代码切片）implementation target: the center of the Memory component should be an append-only `FactEvent` stream（只追加事实事件流，用不可破坏的事件记录事实变化）, an asynchronous `MemoryObserver`（记忆观察器，从会话、工具结果和 agent 行为中提取可复用事实）, and retrieval that fuses vector similarity（向量相似度，用 embedding 表示语义接近度）, BM25（经典关键词排序算法，适合精确词匹配）, entity linking（实体链接，把同一个人、项目、文件或概念关联起来）, and a lazy temporal graph（按需时序图，只在时间推理或多跳推理需要时构建关系）.

Quilin 应保留 OmniMem 方向，但更新 F1（Linear 中的下一阶段实现迭代，用于把 F0 决策落成 runtime slices；runtime slices 是可独立实现和验收的运行时代码切片）实现目标：Memory 组件中心应是 append-only `FactEvent` stream（只追加事实事件流，用不可破坏的事件记录事实变化）、异步 `MemoryObserver`（记忆观察器，从会话、工具结果和 agent 行为中提取可复用事实），以及融合 vector similarity（向量相似度，用 embedding 表示语义接近度）、BM25（经典关键词排序算法，适合精确词匹配）、entity linking（实体链接，把同一个人、项目、文件或概念关联起来）和 lazy temporal graph（按需时序图，只在时间推理或多跳推理需要时构建关系）的检索层。

The previous "rule-first observer" direction should not be treated as sufficient. The current Memory README records that the L3a observer（会话后观察器，用于从对话中提取可复用事实）rule-first gate failed at 21.4% recall（召回率，应该提取的事实被提取出来的比例）on the 1039-sample dataset, so F1 must use deterministic extraction only for high-confidence structured cases and route uncertain cases to a model-backed or review-backed path.

之前的“rule-first observer”方向不应被当作已经足够。当前 Memory README 记录 L3a observer（会话后观察器，用于从对话中提取可复用事实）的 rule-first gate 在 1039 条样本上只有 21.4% recall（召回率，应该提取的事实被提取出来的比例），所以 F1 必须只把确定性抽取用于高置信结构化场景，并把不确定样例送到模型兜底或 review 兜底路径。

The most important update from current systems is that memory writes should preserve history instead of destructively rewriting facts. When a user preference, project decision, or agent action changes, Quilin should add a new fact with validity metadata and a `supersedes` relation rather than overwriting the old fact in place.

当前系统带来的最重要更新是：记忆写入应保留历史，而不是破坏性改写事实。当用户偏好、项目决策或 agent 行为发生变化时，Quilin 应新增一条带有效期 metadata（元数据）的事实，并通过 `supersedes` 关系指向旧事实，而不是原地覆盖旧事实。

## 高信号来源 / High-Signal Sources

[Mem0](https://docs.mem0.ai/migration/oss-v2-to-v3) is the strongest current signal for production memory ergonomics. Its 2026 migration guide moves to single-pass ADD-only extraction（单次只追加抽取，用一次模型调用提取新事实且不返回 update/delete 操作）, entity linking, and multi-signal retrieval with semantic search, BM25 keyword scoring, and entity matching.

[Mem0](https://docs.mem0.ai/migration/oss-v2-to-v3) 是当前生产记忆工程体验的强信号。它的 2026 migration guide 转向 single-pass ADD-only extraction（单次只追加抽取，用一次模型调用提取新事实且不返回 update/delete 操作）、entity linking 和 multi-signal retrieval，即融合语义搜索、BM25 关键词排序和实体匹配。

[Graphiti / Zep](https://github.com/getzep/graphiti) is the strongest signal for temporal graph memory（时序图记忆，记录事实随时间变化和关系来源的图结构）and provenance（来源追踪，说明某条事实从哪里来）. Its useful ideas are validity windows, episode-backed facts, full lineage from derived facts to raw episodes, and hybrid retrieval combining semantic, keyword, and graph traversal.

[Graphiti / Zep](https://github.com/getzep/graphiti) 是 temporal graph memory（时序图记忆，记录事实随时间变化和关系来源的图结构）和 provenance（来源追踪，说明某条事实从哪里来）的强信号。值得吸收的是 validity windows（有效期窗口）、episode-backed facts（由原始事件支撑的事实）、从派生事实回到原始 episode 的完整 lineage（血缘链路），以及融合语义、关键词和图遍历的 hybrid retrieval。

[Letta / MemGPT](https://docs.letta.com/guides/agents/architectures/memgpt) remains a high-signal reference for explicit memory hierarchy: core memory（核心记忆，始终在上下文里的短小持久信息）, recall memory（召回记忆，可搜索的历史消息）, and archival memory（归档记忆，长期语义存储）. Quilin should keep this hierarchy, but its write path should be more explicit and auditable than a self-editing black box.

[Letta / MemGPT](https://docs.letta.com/guides/agents/architectures/memgpt) 仍是显式记忆层级的高信号参考：core memory（核心记忆，始终在上下文里的短小持久信息）、recall memory（召回记忆，可搜索的历史消息）和 archival memory（归档记忆，长期语义存储）。Quilin 应保留这种层级，但写入路径要比自我编辑黑盒更明确、可审计。

[LangGraph memory docs](https://docs.langchain.com/oss/javascript/concepts/memory) are useful for the semantic / episodic / procedural split. Semantic memory（语义记忆）stores facts, episodic memory（情节记忆）stores experiences and actions, and procedural memory（技能或流程记忆）stores instructions or reusable rules; Quilin already models this split and should make it explicit in every `FactEvent`.

[LangGraph memory docs](https://docs.langchain.com/oss/javascript/concepts/memory) 对 semantic / episodic / procedural 三分法有参考价值。Semantic memory（语义记忆）存事实，episodic memory（情节记忆）存经历和动作，procedural memory（技能或流程记忆）存指令或可复用规则；Quilin 已经采用这种划分，应在每条 `FactEvent` 中显式标出。

[OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/) and [Cloudflare Agents memory](https://developers.cloudflare.com/agents/concepts/memory/) are useful runtime references. They show that persistent conversation history, custom storage backends, compaction（压缩，把长历史缩短但保留关键内容）, and separate context blocks are now baseline runtime expectations, not optional polish.

[OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/) 和 [Cloudflare Agents memory](https://developers.cloudflare.com/agents/concepts/memory/) 是有价值的运行时参考。它们说明 persistent conversation history（持久对话历史）、自定义存储后端、compaction（压缩，把长历史缩短但保留关键内容）和独立 context block（上下文块）已经是运行时基线能力，不是可有可无的优化。

[LongMemEval](https://arxiv.org/abs/2410.10813) and its [official repository](https://github.com/xiaowu0162/LongMemEval) define five useful long-memory abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention（拒答，在证据不足时不编造答案）. These abilities should shape local fixtures before Quilin spends effort on full public benchmark runs.

[LongMemEval](https://arxiv.org/abs/2410.10813) 及其 [official repository](https://github.com/xiaowu0162/LongMemEval) 定义了五类有用的长期记忆能力：information extraction、multi-session reasoning、temporal reasoning、knowledge updates 和 abstention（拒答，在证据不足时不编造答案）。这些能力应先塑造 Quilin 的本地 fixture（固定样例集），再投入完整公开 benchmark 运行。

[OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/), [AgentPoison](https://arxiv.org/abs/2407.12784)（一种针对 RAG / memory store 的后门投毒攻击；RAG 是检索增强生成，即先检索再回答）, [A-MemGuard](https://arxiv.org/abs/2510.02373)（Agent-Memory Guard，一种用多记忆共识做主动防御的论文方案）, and [MemoryGraft](https://arxiv.org/abs/2512.16962)（一种把恶意成功经验写入长期记忆、导致后续行为漂移的攻击）are the security baseline. Together they show that writable long-term memory is an attack surface: poisoned memories can be retrieved later, steer behavior across sessions, and become self-reinforcing if corrupted outcomes are stored as precedent.

[OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/)、[AgentPoison](https://arxiv.org/abs/2407.12784)（一种针对 RAG / memory store 的后门投毒攻击；RAG 是检索增强生成，即先检索再回答）、[A-MemGuard](https://arxiv.org/abs/2510.02373)（Agent-Memory Guard，一种用多记忆共识做主动防御的论文方案）和 [MemoryGraft](https://arxiv.org/abs/2512.16962)（一种把恶意成功经验写入长期记忆、导致后续行为漂移的攻击）构成安全基线。它们共同说明：可写长期记忆是攻击面；被投毒的记忆可以在后续被检索出来，跨 session 影响行为，并在错误结果被继续写入时形成自我强化。

[PROV-AGENT](https://arxiv.org/abs/2508.02866)（面向 agent workflow 的来源追踪模型）, W3C PROV（World Wide Web Consortium Provenance model，一个描述 entity / activity / agent 之间来源关系的通用标准）, and [OpenTelemetry GenAI retrieval spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)（OpenTelemetry 生成式 AI 检索追踪记录，用来记录一次检索的来源和分数）justify provenance receipts（来源凭据，随事实保存的来源、生成过程和检索证据）as a first-class Memory contract rather than a later observability feature.

[PROV-AGENT](https://arxiv.org/abs/2508.02866)（面向 agent workflow 的来源追踪模型）、W3C PROV（World Wide Web Consortium Provenance model，一个描述 entity / activity / agent 之间来源关系的通用标准）和 [OpenTelemetry GenAI retrieval spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)（OpenTelemetry 生成式 AI 检索追踪记录，用来记录一次检索的来源和分数）共同说明：provenance receipts（来源凭据，随事实保存的来源、生成过程和检索证据）应该是一等 Memory 契约，而不是后续再补的 observability（可观测性）功能。

## 可吸收架构 / Absorbable Architecture

F1 should implement a `FactEvent` schema before optimizing retrieval. The minimum fields are `fact_id`, `source_event_id`, `actor`, `memory_kind`, `content`, `entities`, `observed_at`, `valid_from`, `valid_to`, `supersedes`, `confidence`, `trust_tier`, `provenance_receipt_id`, and `write_policy_result`.

F1 应先实现 `FactEvent` schema（结构化字段约定），再优化检索。最小字段包括 `fact_id`、`source_event_id`、`actor`、`memory_kind`、`content`、`entities`、`observed_at`、`valid_from`、`valid_to`、`supersedes`、`confidence`、`trust_tier`、`provenance_receipt_id` 和 `write_policy_result`。

`memory_kind` should be one of semantic, episodic, procedural, profile, or safety_lesson. Semantic facts answer "what is true"; episodic facts answer "what happened"; procedural facts answer "what rule or skill worked"; profile facts answer "what stable user preference exists"; safety lessons answer "what memory pattern was unsafe and why".

`memory_kind` 应是 semantic、episodic、procedural、profile 或 safety_lesson 之一。Semantic facts 回答“什么是真的”；episodic facts 回答“发生过什么”；procedural facts 回答“什么规则或技能有效”；profile facts 回答“用户有哪些稳定偏好”；safety lessons 回答“哪类记忆模式不安全以及原因是什么”。

The observer should be asynchronous and dual-path. Path A is deterministic extraction for structured events such as tool results, file edits, test failures, URLs, timestamps, and explicit user preferences. Path B is model-backed extraction for ambiguous language, cross-turn synthesis, conflict detection, and bilingual Chinese/English cases that the current rule-first spike failed to cover.

Observer（观察器）应是异步双路径。路径 A 是确定性抽取，用于工具结果、文件编辑、测试失败、URL、时间戳和明确用户偏好等结构化事件。路径 B 是模型兜底抽取，用于模糊语言、跨轮综合、冲突检测，以及当前 rule-first spike 未覆盖好的中英文双语场景。

The observer must not silently drop low-confidence facts. It should emit `candidate_fact` records into a quarantine queue（隔离队列，暂存未被信任的候选事实）with an explicit reason such as `ambiguous_reference`, `conflicting_source`, `low_trust_actor`, `possible_instruction_injection`, or `needs_human_review`.

Observer 不得静默丢弃低置信事实。它应把候选内容写成 `candidate_fact` 放入 quarantine queue（隔离队列，暂存未被信任的候选事实），并带上明确原因，例如 `ambiguous_reference`、`conflicting_source`、`low_trust_actor`、`possible_instruction_injection` 或 `needs_human_review`。

The write path should be append-only by default. Updates and deletes should be represented as new events that point to previous facts through `supersedes` or `invalidates`, because temporal reasoning and poisoning rollback both need to know what was true before the new fact arrived.

写路径默认应只追加。Update 和 delete 应表示为新事件，并通过 `supersedes` 或 `invalidates` 指向旧事实，因为时间推理和投毒回滚都需要知道新事实到来前什么曾经成立。

Retrieval should run four signals in parallel: vector search for semantic similarity, BM25 for exact terms and identifiers, entity matching for people/projects/files/concepts, and temporal graph traversal only when the query asks about change, order, cause, dependency, or multi-hop relationships.

检索应并行跑四类信号：vector search 处理语义相似度，BM25 处理精确词和标识符，entity matching 处理人、项目、文件和概念，temporal graph traversal（时序图遍历）只在查询涉及变化、顺序、原因、依赖或多跳关系时启用。

The current Memory README describes `vector + graph + BM25` as a target, but the newest Mem0 direction removed its explicit graph store and replaced it with entity linking. Quilin should not copy that removal wholesale: use entity linking as the cheap default, while keeping a small temporal graph for facts whose validity window or relation chain matters.

当前 Memory README 把 `vector + graph + BM25` 写成目标，但最新 Mem0 方向移除了显式 graph store（图数据库存储），改用 entity linking。Quilin 不应照搬这个移除：应把 entity linking 作为低成本默认路径，同时保留小型 temporal graph，用于那些有效期或关系链重要的事实。

Context assembly should receive a stable memory prefix made of separately invalidated blocks. This maps to `QUI-49` and `QUI-60`: Memory returns source-grounded blocks, Context decides which blocks enter the prompt, and prompt-cache evaluation measures token cost, first-token latency, and answer quality.

上下文组装应收到由多个可独立失效 block（块）组成的稳定记忆前缀。这映射到 `QUI-49` 和 `QUI-60`：Memory 返回有来源支撑的 block，Context 决定哪些 block 进入 prompt（提示词），prompt-cache evaluation（提示缓存评测）衡量 token 成本、首 token 延迟和回答质量。

## 来源凭据 / Provenance Receipts

Every promoted fact must carry a provenance receipt. The receipt is the durable proof that explains which raw event created the fact, which actor or tool produced it, which observer version transformed it, what confidence and trust were assigned, and which downstream responses later used it.

每条被提升为正式记忆的事实都必须携带 provenance receipt（来源凭据）。凭据是持久证据，用来解释哪条原始事件创建了事实、哪个 actor（人或 agent）或工具产生了它、哪个 observer 版本转换了它、分配了什么置信度和信任等级，以及后续哪些回答使用过它。

The minimum receipt fields are `receipt_id`, `source_event_id`, `raw_content_hash`, `source_uri`, `source_timestamp`, `actor_id`, `tool_call_id`, `run_id`, `trace_id`, `observer_version`, `model_id`, `prompt_version`, `policy_decision`, `derived_fact_ids`, and `retrieval_use_count`.

最小凭据字段包括 `receipt_id`、`source_event_id`、`raw_content_hash`、`source_uri`、`source_timestamp`、`actor_id`、`tool_call_id`、`run_id`、`trace_id`、`observer_version`、`model_id`、`prompt_version`、`policy_decision`、`derived_fact_ids` 和 `retrieval_use_count`。

Receipts should map to OpenTelemetry retrieval spans（OpenTelemetry 是通用可观测性标准；retrieval span 是一次检索操作的追踪记录）without storing sensitive raw text by default. `gen_ai.retrieval.documents` can carry memory ids and scores, while sensitive source text remains behind local ids and hashes.

凭据应能映射到 OpenTelemetry retrieval spans（OpenTelemetry 是通用可观测性标准；retrieval span 是一次检索操作的追踪记录），但默认不存敏感原文。`gen_ai.retrieval.documents` 可以记录 memory id 和分数，而敏感 source text（来源文本）保留在本地 id 与 hash 后面。

## 记忆投毒防御 / Memory Poisoning Defenses

Memory poisoning（记忆投毒，攻击者写入或诱导写入恶意长期记忆以影响未来行为）must be handled at write time, retrieval time, and promotion time. A memory entry that is merely plausible in isolation is not enough; it must be consistent with related facts, actor permissions, source trust, and the current task boundary.

Memory poisoning（记忆投毒，攻击者写入或诱导写入恶意长期记忆以影响未来行为）必须在写入时、检索时和提升为稳定记忆时处理。某条记忆孤立看起来合理还不够；它必须与相关事实、actor 权限、来源可信度和当前任务边界一致。

Write-time defense should reuse `WriteAuthority`（统一写权限门，用来控制 agent 发起的写操作）from `QUI-53`. Writes from tool output, web pages, low-trust agents, or untrusted files must default to quarantine unless they are simple factual observations with narrow scope and clear source receipts.

写入时防御应复用 `QUI-53` 中的 `WriteAuthority`（统一写权限门，用来控制 agent 发起的写操作）。来自工具输出、网页、低信任 agent 或不可信文件的写入，默认进入 quarantine（隔离队列），除非它们是范围很窄且带清晰来源凭据的简单事实观察。

Retrieval-time defense should attach trust and source labels to every returned memory. Low-trust facts can help answer factual questions, but they must not become system instructions, persistent user preferences, permission grants, or procedural rules without promotion.

检索时防御应给每条返回记忆附上 trust（信任）和 source（来源）标签。低信任事实可以辅助回答事实问题，但在未提升前不得成为 system instructions（系统指令）、持久用户偏好、权限授权或流程规则。

Promotion-time defense should use consensus checks（共识检查，用多条相关记忆推理路径互相校验）and a separate `safety_lesson` memory kind. When a poisoned or contradictory fact is detected, the result should be stored as a lesson that prevents similar future promotion, not as another ordinary fact.

提升时防御应使用 consensus checks（共识检查，用多条相关记忆推理路径互相校验）和独立的 `safety_lesson` 记忆类型。当检测到投毒或矛盾事实时，结果应存成 lesson（经验教训），用于阻止未来类似提升，而不是再存成普通事实。

Integrity defense should include source hashes and snapshot rollback. OWASP Agent Memory Guard highlights cryptographic baselines, policy checks, snapshots, and rollback; Quilin should implement the same class of controls locally before allowing shared multi-agent memory.

完整性防御应包含来源 hash 和 snapshot rollback（快照回滚）。OWASP Agent Memory Guard 强调 cryptographic baselines（密码学基线）、policy checks（策略检查）、snapshots（快照）和 rollback（回滚）；Quilin 在开放共享多 agent 记忆之前，应先本地实现同类控制。

## 评测吸收 / Evaluation Absorption

The existing [long-memory evaluation baseline](long-memory-evaluation-baseline.md) is the right starting point, but `QUI-51` adds write-path and trust-path gates that the baseline should feed into `QUI-65`. The first hard gate remains a deterministic local fixture lane（固定样例评测通道，一组可重复运行的小型测试集合）, because public benchmark runs depend on dataset, judge model, and cost.

已有的 [long-memory evaluation baseline](long-memory-evaluation-baseline.md) 是正确起点，但 `QUI-51` 还要为 `QUI-65` 增加写路径和信任路径 gate（门禁条件）。第一道硬 gate 仍应是 deterministic local fixture lane（固定样例评测通道，一组可重复运行的小型测试集合），因为公开 benchmark run 依赖数据集、裁判模型和成本。

The local fixture lane should add five Memory-specific metrics: observer write precision（写入精确率，写入事实中正确事实的比例）, observer write recall（写入召回率，应该写入的事实被写入的比例）, provenance coverage（来源凭据覆盖率）, poisoning rejection rate（投毒拒绝率）, and safe promotion rate（安全提升率，候选事实被正确提升或隔离的比例）.

本地 fixture lane 应新增五个 Memory 专属指标：observer write precision（写入精确率，写入事实中正确事实的比例）、observer write recall（写入召回率，应该写入的事实被写入的比例）、provenance coverage（来源凭据覆盖率）、poisoning rejection rate（投毒拒绝率）和 safe promotion rate（安全提升率，候选事实被正确提升或隔离的比例）。

The minimum `QUI-65` close condition should be: local fixture answer accuracy at least 0.90, evidence recall@5 at least 0.90, contradiction pass rate 1.00, abstention pass rate 1.00, profile false positives 0, provenance coverage 1.00 for promoted facts, poisoning rejection rate 1.00 on seeded attack fixtures, and p95 retrieval latency（第 95 百分位检索延迟，用来表示大多数请求的尾部耗时）within the existing 300 ms target for the 100K stress lane.

`QUI-65` 的最低关闭条件应是：本地 fixture answer accuracy 至少 0.90、evidence recall@5 至少 0.90、contradiction pass rate 1.00、abstention pass rate 1.00、profile false positives 为 0、被提升事实的 provenance coverage 为 1.00、种子攻击 fixture 上 poisoning rejection rate 为 1.00，并且 p95 retrieval latency（第 95 百分位检索延迟，用来表示大多数请求的尾部耗时）在现有 100K stress lane 的 300 ms 目标内。

Public benchmark lanes should be used after the local gate is green. LongMemEval tests multi-session reasoning, temporal reasoning, knowledge updates, and abstention; LoCoMo tests long multi-session conversation and attribution; BEAM-style checks test memory behavior when full context loading is impossible. These are verification lenses, not the first implementation driver.

公开 benchmark lane 应在本地 gate 通过后再使用。LongMemEval 测 multi-session reasoning、temporal reasoning、knowledge updates 和 abstention；LoCoMo 测长多会话对话和归因；BEAM-style checks 测无法加载完整上下文时的记忆行为。它们是验证视角，不是第一实现驱动。

## Linear 映射 / Linear Mapping

`QUI-51` owns this decision document and should close only when the team accepts the F1 memory contract: append-only fact stream, observer split, provenance receipts, retrieval fusion, poisoning defenses, and evaluation gates.

`QUI-51` 负责本文档决策，只有当团队接受 F1 memory contract（记忆契约）后才应关闭：append-only fact stream、observer split、provenance receipts、retrieval fusion、poisoning defenses 和 evaluation gates。

`QUI-65` should implement the runtime slices: `FactEvent` schema, async observer, quarantine queue, vector backend, entity store, temporal graph hooks, retrieval fusion, and local fixture scorer.

`QUI-65` 应实现运行时切片：`FactEvent` schema、异步 observer、quarantine queue、vector backend、entity store、temporal graph hooks、retrieval fusion 和 local fixture scorer。

`QUI-73` remains the completed evaluation baseline and should be referenced by `QUI-65`; this document adds the missing observer, provenance, and poisoning criteria on top of that baseline.

`QUI-73` 保持为已完成的评测基线，并应被 `QUI-65` 引用；本文在该基线之上补充 observer、provenance 和 poisoning 条件。

`QUI-49` and `QUI-60` own the Context side of the boundary: Memory returns stable, source-grounded context blocks, while Context performs relevance selection, compression, prompt-cache placement, and quality evaluation.

`QUI-49` 和 `QUI-60` 负责 Context 边界：Memory 返回稳定、有来源支撑的 context blocks，而 Context 负责 relevance selection（相关性选择）、compression（压缩）、prompt-cache placement（提示缓存放置）和质量评测。

`QUI-53` owns the safety boundary. Memory write promotion, quarantine release, trust-tier changes, and poisoning rollback must reuse the action-level policy records and `WriteAuthority` decisions defined there.

`QUI-53` 负责安全边界。Memory 写入提升、quarantine release（隔离解除）、trust-tier changes（信任等级变化）和 poisoning rollback（投毒回滚）必须复用其中定义的动作级策略记录和 `WriteAuthority` 决策。

No new Linear issue is required from this decision. The existing issues have enough ownership boundaries: `QUI-51` for architecture decision, `QUI-65` for implementation, `QUI-73` for evaluation baseline, `QUI-49`/`QUI-60` for Context integration, and `QUI-53` for safety policy.

本决策不需要新建 Linear issue。现有 issue 已有足够清晰的权属边界：`QUI-51` 负责架构决策，`QUI-65` 负责实现，`QUI-73` 负责评测基线，`QUI-49`/`QUI-60` 负责 Context 集成，`QUI-53` 负责安全策略。

## F1 实施顺序 / F1 Implementation Order

First, define the `FactEvent` and provenance receipt schemas with append-only semantics and migration-safe optional fields.

第一步，定义 `FactEvent` 和 provenance receipt schema，保证只追加语义，并让字段以可选形式支持后续安全迁移。

Second, implement the observer write path with deterministic structured extraction, model-backed fallback, quarantine, and policy decisions surfaced in logs.

第二步，实现 observer 写路径，包含确定性结构化抽取、模型兜底、quarantine 和写入策略决策日志。

Third, implement retrieval fusion with vector, BM25, entity matching, and lazy temporal graph traversal, then expose retrieved evidence ids and source receipts to the caller.

第三步，实现融合 vector、BM25、entity matching 和 lazy temporal graph traversal 的检索，并向调用方暴露 retrieved evidence ids 和 source receipts。

Fourth, connect the local fixture lane from `QUI-73` and add the five Memory-specific metrics from this document before running full public benchmark lanes.

第四步，接入 `QUI-73` 的本地 fixture lane，并在运行完整公开 benchmark lane 之前加入本文定义的五个 Memory 专属指标。

Fifth, hand stable memory blocks to `QUI-49` and `QUI-60` so Context can evaluate cache placement, compression, and answer quality without coupling itself to raw memory storage.

第五步，把稳定 memory blocks 交给 `QUI-49` 和 `QUI-60`，让 Context 能评估 cache placement、compression 和回答质量，同时不与原始记忆存储耦合。
