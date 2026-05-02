# 记忆运行时实现计划 / Memory Runtime Implementation Plan

Scope: `QUI-65`（Linear 中的 Memory runtime 实现任务，负责把记忆观察、事实流、检索融合和本地评测落成可实现契约）. This plan turns the `QUI-51` frontier decision, the `QUI-73` long-memory evaluation baseline, the `QUI-49` Context boundary, and the `QUI-53` Safety boundary into implementation slices. It intentionally does not start benchmark-first work; benchmark（基准测试，用统一输入和评分比较系统能力）runs stay behind the component-strengthening work.

范围：`QUI-65`（Linear 中的 Memory runtime 实现任务，负责把记忆观察、事实流、检索融合和本地评测落成可实现契约）。本文把 `QUI-51` 前沿决策、`QUI-73` 长期记忆评测基线、`QUI-49` Context（上下文层，负责选择和压缩进入模型提示词的信息）边界，以及 `QUI-53` Safety（安全层，负责动作分类、权限门和审计）边界转成实现切片。本文刻意不启动 benchmark-first（基准测试优先）工作；benchmark（基准测试，用统一输入和评分比较系统能力）运行放在组件强化之后。

## 目标 / Goals

The goal is to make OmniMem（Quilin 的四层记忆系统，包含 working / episodic / semantic / skill memory）write, defend, retrieve, and score memory as a runtime component. The runtime must accept session and tool events, produce auditable `FactEvent` records（事实事件记录，用结构化事件表达可复用事实）, keep the stream append-only, quarantine unsafe candidates, retrieve through multiple signals, and hand stable memory blocks to Context.

目标是把 OmniMem（Quilin 的四层记忆系统，包含 working / episodic / semantic / skill memory）做成能写入、防御、检索和评分的运行时组件。运行时必须接收会话和工具事件，产出可审计的 `FactEvent` records（事实事件记录，用结构化事件表达可复用事实），保持只追加事实流，隔离不安全候选事实，通过多信号检索，并把稳定记忆块交给 Context。

The first close condition is a deterministic local fixture scorer（本地样例评分器，用固定输入和固定规则评估结果）that proves write precision, write recall, provenance coverage, poisoning rejection, contradiction handling, abstention, and retrieval evidence quality. Public lanes such as LongMemEval（长期记忆能力评测，用于评估跨多会话记忆能力）and LoCoMo（长对话记忆评测，用于评估多会话对话记忆和归因）remain follow-up evidence, not the first implementation driver.

第一关闭条件是 deterministic local fixture scorer（本地样例评分器，用固定输入和固定规则评估结果），证明写入精确率、写入召回率、来源凭据覆盖率、投毒拒绝、矛盾处理、拒答和检索证据质量。LongMemEval（长期记忆能力评测，用于评估跨多会话记忆能力）和 LoCoMo（长对话记忆评测，用于评估多会话对话记忆和归因）等公开通道保留为后续证据，不作为第一实现驱动。

## 非目标 / Non-Goals

This plan does not add new Linear issues because the free-plan issue budget makes existing issue reuse the right path. `QUI-65` owns implementation, `QUI-51` owns the Memory architecture decision, `QUI-73` owns the long-memory evaluation baseline, `QUI-49` owns Context integration, and `QUI-53` owns Safety policy and poisoning boundaries.

本文不新增 Linear issue，因为免费版 issue 额度有限，复用既有 issue 是正确路径。`QUI-65` 负责实现，`QUI-51` 负责 Memory 架构决策，`QUI-73` 负责长期记忆评测基线，`QUI-49` 负责 Context 集成，`QUI-53` 负责 Safety 策略和投毒边界。

This plan does not rewrite the old Memory README or change runtime code. It defines the contract that future code should implement, and all runtime changes must still pass the normal human-reviewed implementation path.

本文不重写旧版 Memory README，也不修改运行时代码。它定义后续代码应实现的契约，所有运行时代码变更仍必须经过正常的人类 review 实现路径。

## 总体架构 / Overall Architecture

The runtime is an event pipeline: raw session and tool events enter an asynchronous `MemoryObserver`（记忆观察器，从对话、工具结果和 agent 行为中提取可复用事实）, the observer emits candidate facts, policy gates either promote them to an append-only `FactEvent` stream（只追加事实事件流，用不可破坏的事件记录事实变化）or send them to a quarantine queue（隔离队列，暂存未被信任的候选事实）, retrieval fuses several indexes, and Context receives stable memory blocks.

运行时是事件流水线：原始会话和工具事件进入异步 `MemoryObserver`（记忆观察器，从对话、工具结果和 agent 行为中提取可复用事实），观察器产出候选事实，策略门要么把它们提升到 append-only `FactEvent` stream（只追加事实事件流，用不可破坏的事件记录事实变化），要么送入 quarantine queue（隔离队列，暂存未被信任的候选事实），检索层融合多个索引，最后 Context 收到稳定记忆块。

The invariant is that raw evidence is never replaced by derived memory. Every promoted fact must point back to a provenance receipt（来源凭据，记录事实从哪个原始事件、工具、模型和策略决策而来）, and every superseding or invalidating change must be represented as a new event.

核心不变式是：派生记忆永远不能替代原始证据。每条被提升的事实都必须回指 provenance receipt（来源凭据，记录事实从哪个原始事件、工具、模型和策略决策而来），每次替换或废弃旧事实都必须表示为一条新事件。

```text
RawEvent
  -> MemoryObserver
  -> CandidateFact
  -> PolicyGate + PoisoningCheck
  -> FactEvent stream or QuarantineEntry
  -> RetrievalFusion
  -> StableMemoryBlock for Context
  -> LocalFixtureScorer
```

## `FactEvent` Schema / `FactEvent` 结构

`FactEvent` is the durable unit of promoted memory. It should be append-only, versioned, source-grounded, and safe to migrate; new fields should be optional unless the migration backfills them.

`FactEvent` 是被提升记忆的持久单位。它应只追加、带版本、带来源，并且迁移安全；新字段除非已有回填迁移，否则应保持可选。

```json
{
  "schema_version": 1,
  "fact_event_id": "factevt_...",
  "fact_id": "fact_...",
  "event_type": "asserted | superseded | invalidated | quarantined | promoted",
  "memory_kind": "semantic | episodic | procedural | profile | safety_lesson",
  "content": {
    "text": "The user prefers bilingual project documentation.",
    "language": "en | zh | mixed",
    "normalized_claim": "project_docs_language_preference=bilingual"
  },
  "entities": [
    {
      "entity_id": "entity_user_rayson",
      "name": "Rayson",
      "kind": "person",
      "confidence": 0.98
    }
  ],
  "time": {
    "observed_at": "2026-05-02T02:00:00+08:00",
    "valid_from": "2026-05-02T02:00:00+08:00",
    "valid_to": null
  },
  "relations": {
    "supersedes": [],
    "invalidates": [],
    "contradiction_group_id": null
  },
  "trust": {
    "confidence": 0.95,
    "trust_tier": "user_explicit | tool_result | inferred | low_trust_external",
    "promotion_state": "promoted"
  },
  "provenance": {
    "provenance_receipt_id": "prov_...",
    "source_event_id": "turn_...",
    "raw_content_hash": "sha256:...",
    "observer_version": "memory-observer-v1"
  },
  "policy": {
    "write_policy_result_id": "policy_...",
    "poisoning_check_result": "passed",
    "quarantine_reason": null
  }
}
```

`memory_kind` separates what the fact means: semantic facts answer what is true, episodic facts answer what happened, procedural facts answer what rule or skill worked, profile facts answer what stable user preference exists, and safety lessons answer what memory pattern was unsafe.

`memory_kind` 区分事实含义：semantic facts 回答什么是真的，episodic facts 回答发生过什么，procedural facts 回答什么规则或技能有效，profile facts 回答用户有哪些稳定偏好，safety lessons 回答哪类记忆模式不安全。

`event_type` must express changes without destructive mutation. If a user changes a preference, the new event uses `superseded` or `promoted` with `relations.supersedes`; if a poisoning check proves a fact unsafe, a new `invalidated` event points to the old fact and records the reason.

`event_type` 必须用非破坏性方式表达变化。如果用户改变偏好，新事件通过 `relations.supersedes` 表示替换；如果投毒检查证明某条事实不安全，则新增 `invalidated` 事件指向旧事实并记录原因。

## 异步观察器 / Async Observer

The `MemoryObserver` should be asynchronous so the main agent loop is not blocked by extraction, embedding, or safety review. The synchronous path only records raw events and enqueue metadata; all derived fact work runs through a background queue with retry and idempotency keys.

`MemoryObserver` 应是异步的，避免主 agent loop（主智能体循环，负责处理用户请求和工具调用）被抽取、向量化或安全 review 阻塞。同步路径只记录原始事件并入队元数据；所有派生事实工作都通过后台队列执行，带 retry（重试）和 idempotency keys（幂等键，防止重复写入）。

The observer has two extraction paths. Path A is deterministic extraction for structured cases such as explicit preferences, file edit summaries, test failures, tool results, URLs, timestamps, and Linear identifiers. Path B is model-assisted extraction for ambiguous references, cross-turn synthesis, bilingual Chinese/English turns, conflict detection, and safety lessons.

观察器有两条抽取路径。路径 A 是确定性抽取，用于明确偏好、文件修改摘要、测试失败、工具结果、URL、时间戳和 Linear 编号等结构化场景。路径 B 是模型辅助抽取，用于模糊指代、跨轮综合、中英双语轮次、冲突检测和安全经验。

The previous rule-first spike failed on recall, especially Chinese and mixed-language input, so deterministic extraction must be treated as a high-precision fast path rather than the whole observer. Low-confidence cases must escalate instead of being silently dropped.

之前的 rule-first spike（规则优先实验，用规则抽取记忆事实的验证）在召回率上失败，尤其是中文和混合语言输入，因此确定性抽取只能作为高精确率快速路径，而不是完整观察器。低置信样例必须升级处理，不能静默丢弃。

The minimum observer output is `CandidateFact`. It includes the proposed claim, entities, confidence, evidence references, language, extraction path, and a required `needs_policy_review` flag when the source is low-trust or consequential.

观察器的最小输出是 `CandidateFact`。它包含候选断言、实体、置信度、证据引用、语言、抽取路径，以及在来源低可信或有后果时必须写入的 `needs_policy_review` 标记。

## 只追加事实流 / Append-Only Fact Stream

The fact stream should be implemented as event sourcing（事件溯源，用事件记录状态变化，而不是原地覆盖状态）over memory facts. A read model can materialize the latest active facts for retrieval, but the source of truth remains the ordered event stream.

事实流应实现为 memory facts 上的 event sourcing（事件溯源，用事件记录状态变化，而不是原地覆盖状态）。读取模型可以物化最新有效事实用于检索，但真相源仍是有序事件流。

The write path must reject destructive update and delete semantics. A correction creates a new `FactEvent`, sets `supersedes`, and moves the old fact out of the active read model; a rollback creates a new invalidation event and keeps the historical chain available for audit.

写路径必须拒绝破坏性的 update 和 delete 语义。纠错会创建新的 `FactEvent`，设置 `supersedes`，并把旧事实移出活跃读取模型；回滚会创建新的失效事件，并保留历史链路供审计。

The stream should maintain monotonic sequence numbers per user or workspace plus a global event id. This lets retrieval and Context handoff know whether a block is still fresh, and lets failed async workers replay from a cursor（游标，用来表示已经处理到哪条事件）.

事实流应为每个用户或 workspace 维护单调递增序号，同时保留全局事件编号。这样检索和 Context 交接可以判断某个 block 是否仍新鲜，失败的异步 worker（后台工作单元）也能从 cursor（游标，用来表示已经处理到哪条事件）重放。

## 隔离队列 / Quarantine Queue

The quarantine queue stores facts that may be useful but are not safe enough to promote. It is not an error sink; it is a reviewable state with explicit reasons, source links, and release conditions.

隔离队列保存可能有用但尚不够安全、不能提升的事实。它不是错误垃圾桶，而是一个可 review 的状态，带明确原因、来源链接和释放条件。

Minimum quarantine reasons are `ambiguous_reference`, `conflicting_source`, `low_trust_actor`, `possible_instruction_injection`, `credential_boundary`, `profile_overreach`, `poisoning_suspected`, and `needs_human_review`.

最小隔离原因包括 `ambiguous_reference`、`conflicting_source`、`low_trust_actor`、`possible_instruction_injection`、`credential_boundary`、`profile_overreach`、`poisoning_suspected` 和 `needs_human_review`。

Quarantine release requires a policy decision, not just a higher model confidence score. A fact can be released because the user confirmed it, multiple trusted sources agreed, a contradiction was resolved by recency and authority, or Safety downgraded the risk after inspecting source trust.

隔离释放需要策略决策，而不只是更高的模型置信度。事实可以因为用户确认、多条可信来源一致、按时效和权威度解决矛盾，或 Safety 检查来源信任后降低风险而被释放。

## 来源凭据 / Provenance Receipts

Every promoted fact must have a provenance receipt. The receipt is the durable explanation of who or what produced the source, how the observer transformed it, which policy decision allowed it, and where the fact was later used.

每条被提升的事实都必须有 provenance receipt（来源凭据）。凭据持久解释来源由谁或什么产生、观察器如何转换、哪个策略决策允许写入，以及这条事实后来在哪里被使用。

The minimum receipt fields are `receipt_id`, `source_event_id`, `raw_content_hash`, `source_uri`, `source_timestamp`, `actor_id`, `tool_call_id`, `run_id`, `trace_id`, `observer_version`, `model_id`, `prompt_version`, `policy_decision_id`, `derived_fact_event_ids`, and `retrieval_use_count`.

最小凭据字段包括 `receipt_id`、`source_event_id`、`raw_content_hash`、`source_uri`、`source_timestamp`、`actor_id`、`tool_call_id`、`run_id`、`trace_id`、`observer_version`、`model_id`、`prompt_version`、`policy_decision_id`、`derived_fact_event_ids` 和 `retrieval_use_count`。

Receipts must be secret-safe by default. They should store hashes, ids, labels, timestamps, and redacted snippets when needed, but must not store raw secrets, full private files, or unnecessary personal data.

凭据默认必须 secret-safe（密钥安全）。它们应保存 hash、编号、标签、时间戳，以及必要时的脱敏片段，但不得保存原始密钥、完整私有文件或不必要的个人数据。

## 检索融合 / Retrieval Fusion

Retrieval should combine vector similarity（向量相似度，用 embedding 表示语义接近度）, keyword ranking（关键词排序，用精确词匹配找标识符和短语）, entity matching（实体匹配，把同一个人、项目、文件或概念关联起来）, and temporal traversal（时序遍历，按时间和关系查找事实变化）. The fusion layer decides which evidence reaches Context, not the storage layer.

检索应融合 vector similarity（向量相似度，用 embedding 表示语义接近度）、keyword ranking（关键词排序，用精确词匹配找标识符和短语）、entity matching（实体匹配，把同一个人、项目、文件或概念关联起来）和 temporal traversal（时序遍历，按时间和关系查找事实变化）。融合层决定哪些证据交给 Context，而不是由存储层直接决定。

The default query path runs vector, keyword, and entity matching in parallel. Temporal traversal is lazy: it runs only when the query asks about change, ordering, supersession, conflict, dependency, or multi-hop reasoning.

默认查询路径并行运行向量、关键词和实体匹配。时序遍历是 lazy（按需执行）的：只有查询涉及变化、顺序、替换、冲突、依赖或多跳推理时才运行。

Each retrieved item must expose `fact_event_id`, `fact_id`, score components, source authority, freshness, trust tier, contradiction group, provenance receipt id, and whether the item is active, superseded, invalidated, or quarantined.

每个召回项必须暴露 `fact_event_id`、`fact_id`、各项分数组成、来源权威度、时效性、信任等级、矛盾组、来源凭据编号，以及该项是 active（有效）、superseded（已被替换）、invalidated（已失效）还是 quarantined（被隔离）。

Fusion should use deterministic weighting for the first implementation. A later learned reranker（学习型重排器，用历史引用反馈调整排序的小模型或规则）can be added only after traces record which retrieved facts were actually cited in successful answers.

第一版融合应使用确定性权重。后续 learned reranker（学习型重排器，用历史引用反馈调整排序的小模型或规则）只能在 trace（结构化执行轨迹）记录哪些召回事实确实被成功回答引用之后再加入。

## 投毒拒绝 / Poisoning Rejection

Memory poisoning（记忆投毒，攻击者写入或诱导写入恶意长期记忆以影响未来行为）must be checked at candidate time, promotion time, retrieval time, and Context handoff time. A fact is not safe just because it is syntactically well formed.

Memory poisoning（记忆投毒，攻击者写入或诱导写入恶意长期记忆以影响未来行为）必须在候选阶段、提升阶段、检索阶段和 Context 交接阶段都检查。事实不是因为语法结构完整就安全。

Candidate-time checks inspect source trust, instruction-like content, credential claims, permission changes, profile overreach, tool-output origin, and whether the source is allowed to create long-term memory.

候选阶段检查来源信任、类似指令的内容、凭证声明、权限变化、用户画像越界、工具输出来源，以及该来源是否允许创建长期记忆。

Promotion-time checks require consensus or direct authority for durable profile and procedural facts. User-explicit statements can promote profile facts; tool outputs can promote narrow factual observations; untrusted web pages cannot promote instructions, permissions, or user preferences.

提升阶段检查要求 durable profile facts（持久用户画像事实）和 procedural facts（流程或技能事实）具备共识或直接授权。用户明确陈述可以提升用户画像事实；工具输出可以提升范围很窄的事实观察；不可信网页不能提升指令、权限或用户偏好。

Retrieval-time checks label low-trust memories so Context can use them as evidence without treating them as instructions. A low-trust fact may answer "what did this page say", but it cannot become "what the agent should do next".

检索阶段检查会标记低信任记忆，使 Context 可以把它们作为证据使用，而不是把它们当成指令。低信任事实可以回答“这个页面说了什么”，但不能变成“agent 下一步应该做什么”。

When poisoning is rejected, the runtime should create a `safety_lesson` fact only when it helps prevent similar future promotion. The lesson must describe the unsafe pattern, not repeat the malicious instruction as trusted content.

当投毒被拒绝时，运行时只有在能帮助阻止未来类似提升时才应创建 `safety_lesson` 事实。该经验应描述不安全模式，而不是把恶意指令作为可信内容重复保存。

## 本地样例评分器 / Local Fixture Scorer

The local fixture scorer is the hard `QUI-65` gate. It should run without external network or paid judge model and should produce normalized JSONL（JSON Lines，一行一个 JSON 对象的文件格式）outputs for ingest, query, retrieval, writes, policy decisions, and metrics.

本地样例评分器是 `QUI-65` 的硬性 gate（门禁条件）。它应不依赖外部网络或付费 judge model（裁判模型，用模型评估答案是否正确），并为 ingest（写入输入）、query（查询）、retrieval（检索）、writes（写入）、policy decisions（策略决策）和 metrics（指标）产出标准化 JSONL（JSON Lines，一行一个 JSON 对象的文件格式）。

The first fixture set should cover information extraction, multi-hop reasoning, temporal updates, contradiction resolution, abstention, user-profile stability, poisoning attempts, provenance coverage, and bilingual Chinese/English turns.

第一批样例应覆盖信息抽取、多跳推理、时序更新、矛盾解决、拒答、用户画像稳定性、投毒尝试、来源凭据覆盖，以及中英双语轮次。

Minimum metrics are observer write precision, observer write recall, answer accuracy, evidence recall@5（前 5 条检索结果中的证据召回率）, evidence precision@5（前 5 条检索结果中的证据精确率）, contradiction pass rate, abstention pass rate, profile false positives, provenance coverage, poisoning rejection rate, safe promotion rate, and p95 retrieval latency（第 95 百分位检索延迟，用来表示大多数请求的尾部耗时）.

最小指标包括 observer write precision（观察器写入精确率）、observer write recall（观察器写入召回率）、answer accuracy（答案正确率）、evidence recall@5（前 5 条检索结果中的证据召回率）、evidence precision@5（前 5 条检索结果中的证据精确率）、contradiction pass rate（矛盾处理通过率）、abstention pass rate（拒答通过率）、profile false positives（错误画像写入数）、provenance coverage（来源凭据覆盖率）、poisoning rejection rate（投毒拒绝率）、safe promotion rate（安全提升率）和 p95 retrieval latency（第 95 百分位检索延迟，用来表示大多数请求的尾部耗时）。

The minimum pass gate is local answer accuracy at least 0.90, evidence recall@5 at least 0.90, contradiction pass rate 1.00, abstention pass rate 1.00, profile false positives 0, provenance coverage 1.00 for promoted facts, poisoning rejection rate 1.00 on seeded attack fixtures, and unchanged or passing 100K retrieval stress.

最低通过门槛是：本地答案正确率至少 0.90、evidence recall@5 至少 0.90、矛盾处理通过率 1.00、拒答通过率 1.00、错误画像写入数为 0、被提升事实的来源凭据覆盖率 1.00、种子攻击样例上的投毒拒绝率 1.00，并且 100K 检索压力测试保持不变或通过。

## Context 交接 / Context Handoff

Memory should not hand raw database rows to Context. It should hand stable memory blocks（稳定记忆块，可独立失效、可排序、可缓存的上下文输入）with source receipts, trust labels, freshness, contradiction metadata, and cache keys.

Memory 不应把原始数据库行直接交给 Context。它应交出 stable memory blocks（稳定记忆块，可独立失效、可排序、可缓存的上下文输入），其中包含来源凭据、信任标签、时效性、矛盾元数据和缓存键。

```json
{
  "block_id": "memblk_...",
  "block_version": 1,
  "stable_prefix_eligible": true,
  "cache_key": "sha256:...",
  "facts": ["factevt_1", "factevt_2"],
  "summary": "The user requires bilingual project docs.",
  "citations": [
    {
      "provenance_receipt_id": "prov_1",
      "source_event_id": "turn_1",
      "trust_tier": "user_explicit"
    }
  ],
  "constraints": {
    "may_be_used_as_instruction": false,
    "may_be_used_as_profile": true,
    "requires_exact_citation": true
  },
  "freshness": {
    "stream_sequence": 128,
    "valid_from": "2026-05-02T02:00:00+08:00",
    "valid_to": null
  }
}
```

Context owns final selection, compression, and cache placement. Memory owns whether a fact is active, trusted, source-grounded, contradicted, or unsafe to promote. This boundary prevents Context from hiding provenance failure or memory poisoning.

Context 负责最终选择、压缩和缓存放置。Memory 负责判断事实是否有效、可信、有来源、存在矛盾，或不适合提升。这个边界防止 Context 掩盖来源失败或记忆投毒。

## 实现顺序 / Implementation Order

First, define schemas for `FactEvent`, `CandidateFact`, `QuarantineEntry`, `ProvenanceReceipt`, `RetrievalHit`, `StableMemoryBlock`, and `MemoryScorerReport`. This should happen before algorithm tuning so tests can assert stable contracts.

第一步，定义 `FactEvent`、`CandidateFact`、`QuarantineEntry`、`ProvenanceReceipt`、`RetrievalHit`、`StableMemoryBlock` 和 `MemoryScorerReport` 的结构。此步骤应先于算法调优，让测试能断言稳定契约。

Second, implement the async observer queue with deterministic extraction, model-assisted escalation hooks, idempotent replay, and structured failure records. The observer must never drop low-confidence candidates without a quarantine or failure event.

第二步，实现异步观察器队列，包含确定性抽取、模型辅助升级钩子、幂等重放和结构化失败记录。观察器不得在没有隔离或失败事件的情况下丢弃低置信候选事实。

Third, implement append-only fact stream writes plus active read-model materialization. The read model can be rebuilt from the stream, and all supersession, invalidation, and quarantine release decisions must remain auditable.

第三步，实现只追加事实流写入和活跃读取模型物化。读取模型必须能从事实流重建，所有替换、失效和隔离释放决策都必须可审计。

Fourth, implement poisoning rejection and quarantine release using `QUI-53` policy labels. This includes profile-overreach prevention, untrusted-source instruction rejection, and low-trust retrieval labeling.

第四步，使用 `QUI-53` 策略标签实现投毒拒绝和隔离释放。这包括防止用户画像越界、拒绝不可信来源产生的指令，以及给低信任检索结果打标签。

Fifth, implement retrieval fusion and emit structured retrieval traces. The first version should be deterministic and explainable; learned ranking can follow only after successful retrieval-use traces exist.

第五步，实现检索融合并输出结构化检索 trace（结构化执行轨迹）。第一版应确定、可解释；只有在已有成功的检索使用轨迹之后，才加入学习型排序。

Sixth, implement `StableMemoryBlock` handoff to `QUI-49` Context. Blocks must be independently invalidated when stream sequence, trust status, contradiction group, or provenance status changes.

第六步，实现 `StableMemoryBlock` 到 `QUI-49` Context 的交接。当事实流序号、信任状态、矛盾组或来源状态变化时，block 必须能独立失效。

Seventh, implement the local fixture scorer from `QUI-73` with the extra observer, provenance, and poisoning gates from `QUI-51`. Public benchmark smoke plans can be selected after the local scorer passes.

第七步，实现来自 `QUI-73` 的本地样例评分器，并加入 `QUI-51` 补充的观察器、来源凭据和投毒门槛。本地评分器通过后，再选择公开 benchmark 的 smoke plan（小样本冒烟验证计划）。

## Linear 映射 / Linear Mapping

`QUI-65` owns this implementation plan and should close only when the runtime contract, local fixture scorer, and Context handoff are implemented and verified. This document is the planning artifact, not the close evidence.

`QUI-65` 负责本文实现计划，只有在运行时契约、本地样例评分器和 Context 交接被实现并验证后才应关闭。本文是计划产物，不是关闭证据。

`QUI-51` owns the Memory frontier decision that this plan implements: append-only fact stream, observer split, provenance receipts, retrieval fusion, poisoning defenses, and evaluation gates.

`QUI-51` 负责本文所实现的 Memory 前沿决策：只追加事实流、观察器双路径、来源凭据、检索融合、投毒防御和评测门槛。

`QUI-73` owns the long-memory evaluation baseline. `QUI-65` should reuse its deterministic local fixture lane first, then record any blocked public benchmark lane as a comment rather than opening a new issue.

`QUI-73` 负责长期记忆评测基线。`QUI-65` 应优先复用其中的确定性本地样例通道，再把任何 blocked（受阻）的公开 benchmark 通道记录为 comment，而不是新开 issue。

`QUI-49` owns the Context side. Memory returns source-grounded stable memory blocks; Context chooses placement, compression, prompt-cache strategy, and quality measurement.

`QUI-49` 负责 Context 一侧。Memory 返回有来源支撑的稳定记忆块；Context 负责排布、压缩、prompt cache（提示缓存）策略和质量评估。

`QUI-53` owns Safety. Memory promotion, quarantine release, poisoning rejection, source-trust labels, and profile-write protection must reuse Safety policy records instead of creating a separate memory-only authority plane.

`QUI-53` 负责 Safety。Memory 提升、隔离释放、投毒拒绝、来源信任标签和用户画像写入保护都必须复用 Safety 策略记录，而不是创建一套只属于 Memory 的权限平面。

## 验收门槛 / Acceptance Gates

The first gate is schema coverage: every promoted fact has a `FactEvent`, a provenance receipt, a policy result, and a traceable source event. Any promoted fact without those fields is a failing case.

第一道门槛是 schema 覆盖：每条被提升的事实都有 `FactEvent`、来源凭据、策略结果和可追踪来源事件。任何缺少这些字段的被提升事实都算失败。

The second gate is write-path safety: low-confidence, conflicting, low-trust, instruction-like, credential-related, or profile-overreaching candidates go to quarantine unless a policy decision explicitly promotes them.

第二道门槛是写路径安全：低置信、冲突、低信任、类似指令、涉及凭证或用户画像越界的候选事实必须进入隔离，除非策略决策明确提升它们。

The third gate is retrieval quality: the local fixture scorer meets the `QUI-73` thresholds and the extra `QUI-51` thresholds for provenance coverage, poisoning rejection, and safe promotion.

第三道门槛是检索质量：本地样例评分器达到 `QUI-73` 阈值，并达到 `QUI-51` 补充的来源凭据覆盖、投毒拒绝和安全提升阈值。

The fourth gate is Context integrity: every stable memory block includes trust labels, source receipts, contradiction status, and invalidation keys, and Context can reject or compress blocks without losing source traceability.

第四道门槛是 Context 完整性：每个稳定记忆块都包含信任标签、来源凭据、矛盾状态和失效键，并且 Context 可以拒绝或压缩 block 而不丢失来源可追踪性。

The fifth gate is operational repeatability: the async observer can replay from a cursor, rebuild the active read model from the append-only stream, and produce the same scorer report for the same fixture inputs.

第五道门槛是运行可重复性：异步观察器可以从 cursor 重放，可以从只追加事实流重建活跃读取模型，并且对相同样例输入产出相同评分报告。
