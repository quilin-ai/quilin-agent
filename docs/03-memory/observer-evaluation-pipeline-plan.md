# 记忆观察器验证、归档与评估流水线规划 / Memory Observer Validation, Archival, And Evaluation Pipeline Plan

> Linear: `QUI-16`
>
> Scope: planning artifact only. This document does not implement runtime code and does not run public benchmark（基准测试，用统一输入和评分比较系统能力）jobs.
>
> 范围：仅规划产物。本文不实现运行时代码，也不执行公开 benchmark（基准测试，用统一输入和评分比较系统能力）。

## 目标 / Goal

English: `QUI-16` defines the path from Memory observer validation（记忆观察器验证，即检查观察器是否正确提取、隔离和提升可复用事实）to archival（归档，即保留原始证据、压缩冷数据并保证可审计回放）and evaluation pipeline（评估流水线，即把本地样例、实时影子验证和公开评测组织成可重复证据）. It sits after the Memory runtime contract in `QUI-65` and before any public leaderboard（公开排行榜，用标准榜单对外比较系统能力）claim.

中文：`QUI-16` 定义从 Memory observer validation（记忆观察器验证，即检查观察器是否正确提取、隔离和提升可复用事实）到 archival（归档，即保留原始证据、压缩冷数据并保证可审计回放）和 evaluation pipeline（评估流水线，即把本地样例、实时影子验证和公开评测组织成可重复证据）的路径。它位于 `QUI-65` 的 Memory runtime contract（记忆运行时契约）之后，位于任何公开 leaderboard（公开排行榜，用标准榜单对外比较系统能力）声明之前。

English: The main decision is conservative: Quilin should prove local observer quality, safety gates, archival integrity, and public-lane readiness before running full public benchmarks. LongMemEval（长期记忆能力评测，用于评估聊天助手跨多会话保存和使用信息的公开基准）, LoCoMo（Long-term Conversational Memory，一个长对话、多会话和归因评测）, and BEAM（Beyond a Million Tokens，一个把对话扩到百万到千万 token 级别的长期记忆评测）remain verification lanes, not the first implementation driver.

中文：核心决策是保守推进：Quilin 应先证明本地观察器质量、安全门禁、归档完整性和公开通道就绪度，再运行完整公开基准。LongMemEval（长期记忆能力评测，用于评估聊天助手跨多会话保存和使用信息的公开基准）、LoCoMo（Long-term Conversational Memory，一个长对话、多会话和归因评测）和 BEAM（Beyond a Million Tokens，一个把对话扩到百万到千万 token 级别的长期记忆评测）保留为验证通道，而不是第一实现驱动。

## 非目标 / Non-Goals

English: This document does not close `QUI-16`, because the code path is not implemented. It defines required contracts, gates, artifacts, and ownership links so later implementation can close the issue with evidence instead of prose.

中文：本文不关闭 `QUI-16`，因为代码路径尚未实现。它定义必要的契约、门禁、产物和权属链接，让后续实现可以用证据而不是文字说明关闭该 issue。

English: This document does not create a new Linear issue. It reuses `QUI-16` for observer validation and public-lane expansion, `QUI-65` for Memory runtime implementation, `QUI-73` for the long-memory evaluation baseline, `QUI-53` and `QUI-64` for Safety gates, and `QUI-68` for Self-Evolution boundaries.

中文：本文不新建 Linear issue。它复用 `QUI-16` 承接观察器验证和公开通道扩展，`QUI-65` 承接 Memory runtime（记忆运行时）实现，`QUI-73` 承接长期记忆评测基线，`QUI-53` 与 `QUI-64` 承接 Safety（安全）门禁，`QUI-68` 承接 Self-Evolution（自进化）边界。

English: This document does not promote benchmark work ahead of component strength. The first priority is to make the Memory component correct, auditable, private, and safe; public score generation comes only after those properties are locally proven.

中文：本文不把 benchmark 工作提前到组件强化之前。第一优先级是让 Memory 组件正确、可审计、隐私安全、行为安全；公开分数生成只在这些性质被本地证明后发生。

## 当前证据 / Current Evidence

English: The current L3a observer（第 3a 层观察器，即从会话和工具结果中提取可复用观察事实的派生层）cannot be accepted as-is. The existing v2-r3 spike over 1,039 samples reached 21.4% recall（召回率，应该提取的事实被提取出来的比例）, 96.7% precision（精确率，提取出的事实中正确事实的比例）, 2.8% false-positive rate（误报率，无事实样例被误提取的比例）, 4.19 ms p95 latency（第 95 百分位延迟）, 0.0% Chinese recall, 5.2% mixed-language recall, and only 1.1% Tier 2 escalation（第二层升级，即规则不确定时交给模型或人工路径处理）.

中文：当前 L3a observer（第 3a 层观察器，即从会话和工具结果中提取可复用观察事实的派生层）不能按原样验收。现有 v2-r3 spike 在 1,039 条样本上达到 21.4% recall（召回率，应该提取的事实被提取出来的比例）、96.7% precision（精确率，提取出的事实中正确事实的比例）、2.8% false-positive rate（误报率，无事实样例被误提取的比例）、4.19 ms p95 latency（第 95 百分位延迟）、0.0% 中文召回、5.2% 中英混合召回，以及仅 1.1% Tier 2 escalation（第二层升级，即规则不确定时交给模型或人工路径处理）。

English: The interpretation is not that rule-based extraction is useless. The interpretation is that deterministic rules are a high-precision fast path, while ambiguous, bilingual, noisy, cross-turn, or safety-relevant inputs must escalate instead of being silently dropped.

中文：正确解读不是“规则抽取没有价值”。正确解读是：确定性规则只能作为高精确率快速路径；模糊、双语、噪声、跨轮和安全相关输入必须升级处理，不能静默丢弃。

English: The current Memory runtime plan already requires append-only `FactEvent` records（只追加事实事件，用不可破坏的事件记录事实变化）, provenance receipts（来源凭据，记录事实来自哪个原始事件和策略决策）, quarantine queue（隔离队列，暂存低信任或冲突候选事实）, retrieval fusion（检索融合，把向量、关键词、实体和时序信号合并）, and local fixture scoring. `QUI-16` extends that plan into validation and public evidence.

中文：当前 Memory runtime plan 已要求 append-only `FactEvent` records（只追加事实事件，用不可破坏的事件记录事实变化）、provenance receipts（来源凭据，记录事实来自哪个原始事件和策略决策）、quarantine queue（隔离队列，暂存低信任或冲突候选事实）、retrieval fusion（检索融合，把向量、关键词、实体和时序信号合并）和本地样例评分。`QUI-16` 把该计划延展到验证和公开证据层。

## 总体路径 / Overall Path

English: The pipeline has five stages: raw event capture, observer candidate generation, safety-gated promotion, archival receipt generation, and evaluation packaging. Each stage must write structured artifacts so failures can be diagnosed without reading raw private logs.

中文：流水线分为五段：原始事件捕获、观察器候选生成、安全门禁提升、归档凭据生成和评估打包。每一段都必须写结构化产物，使失败诊断不需要阅读原始私有日志。

```text
RawEvent
  -> L2 Verbatim Archive + L3a Observer
  -> CandidateFact
  -> Safety Policy + WriteAuthority
  -> FactEvent or QuarantineEntry
  -> ArchivalReceipt + StableMemoryBlock
  -> Local Observer Eval
  -> Live Shadow Validation
  -> Public Smoke Lane
  -> Full Leaderboard Package
```

English: The only synchronous requirement is durable raw event capture plus enqueue metadata. Observer extraction, model-assisted escalation, cross-user archival checks, leaderboard formatting, and public benchmark runs remain asynchronous and retryable.

中文：同步路径唯一要求是持久化原始事件并写入队列元数据。观察器抽取、模型辅助升级、跨用户归档检查、排行榜格式化和公开基准运行都保持异步、可重试。

English: The source of truth is the raw archive and append-only fact stream. Derived observations, materialized retrieval indexes, leaderboard sidecars（旁路文件，与官方输出并排保存 Quilin 证据字段）, and dashboards must be rebuildable from those sources.

中文：真相源是原始归档和只追加事实流。派生观察、物化检索索引、leaderboard sidecars（旁路文件，与官方输出并排保存 Quilin 证据字段）和仪表盘都必须能从这些来源重建。

## L3a 观察器验证 / L3a Observer Validation

English: L3a validation checks the write path, not only final answer quality. A system can answer correctly while writing unsafe or wrong memory; that is still a Memory failure. The validation output must therefore include candidate facts, missed facts, quarantined facts, promoted facts, and policy reasons.

中文：L3a 验证检查的是写入路径，而不只是最终答案质量。系统可能回答正确，却写入不安全或错误记忆；这仍然是 Memory 失败。因此验证输出必须包含候选事实、漏提事实、隔离事实、提升事实和策略原因。

English: The first local validation lane should reuse the existing `docs/03-memory/l3a-observer/fixtures/` corpus and add bilingual Chinese/English, cross-turn, tool-result, Linear-comment, file-edit, profile-overreach, and poisoning cases. The previous failed spike becomes the regression floor, not a discarded experiment.

中文：第一条本地验证通道应复用现有 `docs/03-memory/l3a-observer/fixtures/` 语料，并增加中英双语、跨轮、工具结果、Linear comment、文件编辑、用户画像越界和投毒样例。之前失败的 spike 成为回归底线，而不是被丢弃的实验。

English: The minimum metrics are observer precision, observer recall, false-positive rate, escalation coverage, quarantine recall, provenance coverage, bilingual recall, Chinese-only recall, p95 extraction latency, and deterministic replay stability.

中文：最小指标包括观察器精确率、观察器召回率、误报率、升级覆盖率、隔离召回率、来源凭据覆盖率、双语召回率、中文-only 召回率、p95 抽取延迟和确定性重放稳定性。

English: The first acceptance target should be higher than the old 40% recall gate because the observed bilingual gap is severe. A practical first gate is: precision at least 0.95, overall recall at least 0.70, Chinese-only recall at least 0.60, mixed-language recall at least 0.65, false-positive rate at most 0.05, escalation coverage at least 0.80 for low-confidence positives, and p95 extraction latency under 50 ms for deterministic extraction only.

中文：第一版验收目标应高于旧的 40% 召回门槛，因为现有双语缺口很严重。一个实际的第一版门槛是：精确率至少 0.95、总体召回至少 0.70、中文-only 召回至少 0.60、中英混合召回至少 0.65、误报率不超过 0.05、低置信正例的升级覆盖率至少 0.80，并且仅确定性抽取路径的 p95 延迟低于 50 ms。

English: Model-assisted extraction does not need the same latency target because it is asynchronous. Its gate is quality and containment: no silent drop, no direct durable promotion without policy, redacted prompt inputs, model and prompt version recorded, and deterministic fallback when the model path is unavailable.

中文：模型辅助抽取不需要同样的延迟目标，因为它是异步路径。它的门槛是质量与约束：不能静默丢弃、不能绕过策略直接持久提升、提示词输入必须脱敏、模型与提示词版本必须记录，并且模型路径不可用时要有确定性降级。

## LongMemEval 与实时影子验证 / LongMemEval And Live Shadow Validation

English: LongMemEval is useful because the official paper and repository define five memory abilities: information extraction, multi-session reasoning, knowledge updates, temporal reasoning, and abstention（拒答，即证据不足时不编造答案）. The current official cleaned dataset exposes oracle, small-cleaned, and medium-cleaned splits, so Quilin must record which split is used before any score is reported.

中文：LongMemEval 有价值，因为其官方论文和仓库定义了五类记忆能力：信息抽取、多会话推理、知识更新、时间推理和 abstention（拒答，即证据不足时不编造答案）。当前官方 cleaned dataset 暴露 oracle、small-cleaned 和 medium-cleaned 三类 split，因此 Quilin 在报告任何分数前必须记录所用 split。

English: `QUI-16` should not start with a full LongMemEval run. The first LongMemEval use should be a smoke lane（小样本冒烟通道，用少量代表 case 验证接线正确）that maps official sessions into `RawEvent`, asks the observer to create `CandidateFact` records, and verifies evidence IDs before final QA scoring.

中文：`QUI-16` 不应从完整 LongMemEval 运行开始。LongMemEval 的第一次使用应是 smoke lane（小样本冒烟通道，用少量代表 case 验证接线正确）：把官方 session 映射成 `RawEvent`，要求观察器创建 `CandidateFact`，并在最终 QA 评分前验证证据 ID。

English: Live observer validation means shadow-mode validation over real Quilin runs or consented synthetic sessions. Shadow mode（影子模式，即产出候选和指标但不改变正式长期记忆）is mandatory until local and public smoke gates pass.

中文：实时观察器验证指在真实 Quilin 运行或已授权合成 session 上做 shadow-mode validation。Shadow mode（影子模式，即产出候选和指标但不改变正式长期记忆）在本地门禁和公开 smoke gate 通过前是强制要求。

English: A live shadow validation case must store `run_id`, `session_id`, redaction level, source event hashes, observer version, candidate facts, quarantine reasons, policy decisions, and a human or deterministic label. It must not store full private conversation text unless a separate user-approved data policy allows it.

中文：实时影子验证样例必须保存 `run_id`、`session_id`、脱敏级别、来源事件哈希、观察器版本、候选事实、隔离原因、策略决策，以及人工或确定性标签。除非另有用户批准的数据策略，否则不得保存完整私有对话文本。

English: Live validation must measure drift. If the observer starts extracting more profile facts after a prompt or model change, the run report must show whether that is real improvement, profile overreach, or policy regression.

中文：实时验证必须衡量漂移。如果观察器在提示词或模型变更后开始提取更多用户画像事实，运行报告必须说明这是实际改进、用户画像越界，还是策略回归。

## 归档模型 / Archival Model

English: Archival starts with L2 verbatim storage（第二层原文情节存储，用于保留原始对话和工具事件证据）. Every raw event receives a content hash, actor, tenant or user scope, timestamp, source type, redaction profile, retention policy, and replay cursor.

中文：归档从 L2 verbatim storage（第二层原文情节存储，用于保留原始对话和工具事件证据）开始。每条原始事件都获得内容哈希、actor（行动者）、租户或用户范围、时间戳、来源类型、脱敏配置、保留策略和重放游标。

English: Derived memory never replaces raw evidence. A promoted fact points to the raw archive through a provenance receipt, and a correction creates a new event that supersedes or invalidates the prior fact. This is required for temporal reasoning, rollback, and audit.

中文：派生记忆永远不替代原始证据。被提升的事实通过来源凭据指向原始归档；纠错会创建新事件，替换或废弃旧事实。这是时间推理、回滚和审计的必要条件。

English: Cold archival can compress raw private text, but it cannot remove replay metadata. The minimum cold receipt is `archive_receipt_id`, `source_event_id`, `content_hash`, `compression_profile`, `redaction_profile`, `tenant_scope`, `retention_until`, `legal_hold`, `restore_command`, and `policy_decision_id`.

中文：冷归档可以压缩原始私有文本，但不能移除回放元数据。最小冷归档凭据包括 `archive_receipt_id`、`source_event_id`、`content_hash`、`compression_profile`、`redaction_profile`、`tenant_scope`、`retention_until`、`legal_hold`、`restore_command` 和 `policy_decision_id`。

English: Archive restore must be a read path by default. Restoring an event into active retrieval, user profile, procedural memory, or shared evaluation data is a write-capable action and must pass Safety policy plus `WriteAuthority`（统一写权限门，用来裁决 agent 发起写入动作的运行时 gate）.

中文：归档恢复默认必须是读取路径。把归档事件恢复进活跃检索、用户画像、流程记忆或共享评测数据属于具备写入效果的动作，必须通过 Safety 策略和 `WriteAuthority`（统一写权限门，用来裁决 agent 发起写入动作的运行时 gate）。

## 跨用户归档 / Cross-User Archival

English: Cross-user archival（跨用户归档，即把多个用户或租户的记忆证据用于聚合质量分析或评测构建）is high risk and must default to disabled for raw content. Quilin must never let one user's raw memory, profile facts, or procedural preferences become another user's retrievable memory.

中文：Cross-user archival（跨用户归档，即把多个用户或租户的记忆证据用于聚合质量分析或评测构建）风险高，原始内容必须默认关闭。Quilin 绝不能让某个用户的原始记忆、画像事实或流程偏好变成另一个用户可检索的记忆。

English: Allowed cross-user artifacts are limited to aggregate metrics, schema migration evidence, redacted failure patterns, and public benchmark outputs. Even these artifacts require tenant boundary labels, source counts, redaction proof, and an explicit `cross_user_allowed` policy decision.

中文：允许的跨用户产物仅限聚合指标、schema 迁移证据、脱敏失败模式和公开 benchmark 输出。即便这些产物也必须带租户边界标签、来源数量、脱敏证明，以及明确的 `cross_user_allowed` 策略决策。

English: Forbidden cross-user artifacts include shared raw snippets, shared vector indexes over private turns, shared profile memories, shared skill preferences learned from a single user, and leaderboard examples that can be traced back to a private user without consent.

中文：禁止的跨用户产物包括共享原始片段、基于私有轮次的共享向量索引、共享用户画像记忆、从单一用户学到的共享技能偏好，以及未获同意即可追溯到私有用户的排行榜样例。

English: The minimum cross-user gate is: no raw text, no secret-like values, no private file contents, no tenant-mixed retrieval index, k-source aggregation for pattern reports（至少多个来源支撑的聚合，避免单一用户暴露）, explicit retention policy, and human review before any artifact leaves the local ignored output directory.

中文：最低跨用户门禁是：无原始文本、无类似密钥的值、无私有文件内容、无租户混合检索索引、模式报告需要 k-source aggregation（至少多个来源支撑的聚合，避免单一用户暴露）、明确保留策略，并且任何产物离开本地 ignored output 目录前必须人工 review。

## 安全门禁 / Safety Gates

English: Memory writes are consequential actions（有后果动作，即会改变后续系统行为的动作）. Candidate promotion, quarantine release, trust-tier upgrade, profile write, procedural memory write, archive restore into active retrieval, and cross-user export all require an action policy record.

中文：记忆写入是 consequential actions（有后果动作，即会改变后续系统行为的动作）。候选事实提升、隔离释放、信任等级升级、用户画像写入、流程记忆写入、归档恢复到活跃检索，以及跨用户导出都需要动作策略记录。

English: The Safety classifier should label at least `memory_write`, `credential_boundary`, `profile_overreach`, `possible_instruction_injection`, `data_exfiltration`, `permission_bypass`, `low_trust_actor`, and `cross_user_boundary`. These labels decide whether the candidate is allowed, confirmed, blocked, or quarantined.

中文：Safety 分类器至少应标记 `memory_write`、`credential_boundary`、`profile_overreach`、`possible_instruction_injection`、`data_exfiltration`、`permission_bypass`、`low_trust_actor` 和 `cross_user_boundary`。这些标签决定候选事实是允许、确认、阻断还是隔离。

English: External pages, tool output, peer-agent messages, and old memory entries are evidence sources, not instruction sources. They may help answer "what was observed", but they cannot grant permissions, change user preferences, or write procedural rules without user authority.

中文：外部网页、工具输出、同伴 agent 消息和旧记忆条目都是证据来源，不是指令来源。它们可以帮助回答“观察到了什么”，但不能在没有用户授权的情况下授予权限、改变用户偏好或写入流程规则。

English: OWASP Agent Memory Guard is a useful external safety reference because it treats persistent mutable memory as an attack surface and emphasizes hashes, policy checks, snapshots, and rollback. Quilin should implement the same class of controls locally before shared memory or cross-user archival is enabled.

中文：OWASP Agent Memory Guard 是有用的外部安全参考，因为它把持久可变记忆视为攻击面，并强调哈希、策略检查、快照和回滚。Quilin 在启用共享记忆或跨用户归档前，应先在本地实现同类控制。

English: The Agent Observability Standard（Agent Observability Standard，一个用于让 agent 行为、工具调用、记忆读写和安全决策可观测的规范）is useful for event vocabulary. Its memory-store and memory-retrieval events map to Quilin's observer, archive, retrieval, and safety audit records.

中文：Agent Observability Standard（Agent Observability Standard，一个用于让 agent 行为、工具调用、记忆读写和安全决策可观测的规范）对事件词表有参考价值。它的 memory-store 与 memory-retrieval 事件可以映射到 Quilin 的观察器、归档、检索和安全审计记录。

## Idle Evolution 写入边界 / Idle Evolution Write Boundary

English: Idle Evolution（空闲自进化，即无人主动交互时运行的后台分析与提案）is default OFF. When enabled, it may analyze traces, propose memory schema fixes, propose fixture additions, or prepare benchmark manifests. It must not apply runtime code, project docs, memory promotions, archive exports, or shared profile changes by itself.

中文：Idle Evolution（空闲自进化，即无人主动交互时运行的后台分析与提案）默认关闭。启用后，它可以分析 trace、提出记忆 schema 修复、提出 fixture 增补，或准备 benchmark manifest。它不得自行应用运行时代码、项目文档、记忆提升、归档导出或共享画像变更。

English: `origin:"idle"` writes remain denied in default `ask` mode. Even with an explicit auto-trust session, idle writes that affect cross-user artifacts, durable profile memory, procedural memory, scaffold patches, or public leaderboard packages require human review.

中文：`origin:"idle"` 写入在默认 `ask` 模式下继续被拒绝。即便当前 session 明确开启自动信任，影响跨用户产物、持久用户画像记忆、流程记忆、脚手架补丁或公开排行榜包的空闲写入仍然需要人工 review。

English: Idle-generated research output must be recorded in Linear and written to bilingual docs before it is treated as project knowledge. A chat-only note or local-only draft is not enough to change Memory direction.

中文：空闲生成的调研输出必须记录到 Linear，并写入中英双语 docs，才能作为项目知识处理。仅聊天记录或仅本地草稿不足以改变 Memory 方向。

## 评估产物结构 / Evaluation Artifact Shape

English: Every observer evaluation run should produce normalized JSONL（JSON Lines，一行一个 JSON 对象的结构化日志格式）for input events, observer outputs, policy decisions, archive receipts, retrieval hits, answers, and scorer reports. Public benchmark official outputs can keep their native format, but Quilin evidence must be stored in a sidecar.

中文：每次观察器评估运行都应为输入事件、观察器输出、策略决策、归档凭据、检索命中、答案和评分报告产出标准化 JSONL（JSON Lines，一行一个 JSON 对象的结构化日志格式）。公开 benchmark 的官方输出可以保留原生格式，但 Quilin 证据必须写入 sidecar（旁路文件）。

```json
{
  "schema_version": 1,
  "case_id": "observer-profile-zh-001",
  "lane": "local_observer_fixture",
  "source_event_ids": ["turn_001"],
  "expected_facts": ["fact_user_doc_language_preference"],
  "expected_quarantine": [],
  "expected_abstention": false,
  "privacy": {
    "redaction_profile": "metadata_only",
    "raw_text_available_to_scorer": false
  }
}
```

English: The observer output record must expose what the system tried to remember, why, with what source, and under which policy. A final answer alone is insufficient.

中文：观察器输出记录必须暴露系统试图记住什么、为什么记、来源是什么，以及通过了哪条策略。只有最终答案是不够的。

```json
{
  "schema_version": 1,
  "case_id": "observer-profile-zh-001",
  "candidate_facts": [
    {
      "candidate_fact_id": "cand_001",
      "memory_kind": "profile",
      "normalized_claim": "project_docs_language=bilingual",
      "confidence": 0.96,
      "extraction_path": "model_assisted",
      "source_event_ids": ["turn_001"],
      "policy_decision": "promote",
      "provenance_receipt_id": "prov_001"
    }
  ],
  "quarantine_entries": [],
  "missed_expected_fact_ids": []
}
```

English: The leaderboard package manifest should be immutable once published internally. It records source versions, code commit, dirty-worktree note, model and judge configuration, dataset manifest hash, official output path, Quilin sidecar path, costs, metrics, and known blockers.

中文：leaderboard package manifest（排行榜运行包清单）一旦在内部发布，应保持不可变。它记录来源版本、代码 commit、dirty-worktree 说明、模型与裁判配置、数据集清单哈希、官方输出路径、Quilin sidecar 路径、成本、指标和已知阻塞项。

## Leaderboard 流水线 / Leaderboard Pipeline

English: The leaderboard pipeline has four gates: local readiness, public smoke, full private report, and public claim approval. Full public benchmark execution starts only after local readiness is green.

中文：排行榜流水线有四道门：本地就绪、公开 smoke、完整私有报告和公开声明批准。完整公开 benchmark 执行只在本地就绪通过后开始。

English: Local readiness requires the observer local gate, archival restore test, cross-user export denial test, Safety policy fixtures, trace-to-eval proof, and deterministic scorer report. This is the strongest gate because it is cheap and repeatable.

中文：本地就绪要求观察器本地门禁、归档恢复测试、跨用户导出拒绝测试、Safety 策略 fixture、trace-to-eval 证明和确定性评分报告。这是最强门禁，因为它低成本且可重复。

English: Public smoke runs use small selected slices from LongMemEval, LoCoMo, or BEAM. Smoke success proves wiring, manifesting, evidence IDs, and judge configuration; it does not justify a public leaderboard claim.

中文：公开 smoke run 使用 LongMemEval、LoCoMo 或 BEAM 中少量代表切片。Smoke 成功只能证明接线、清单、证据 ID 和裁判配置正确；它不支撑公开排行榜声明。

English: A full private report may run the full selected split, but it remains internal until the report package has raw outputs, sidecars, source hashes, costs, failures, and reviewer sign-off. The report must say if a score is not comparable because of dataset cleanup, prompt differences, judge differences, or retrieval visibility differences.

中文：完整私有报告可以运行选定 split 的全量样例，但在报告包具备原始输出、sidecar、来源哈希、成本、失败样例和 reviewer 签字前，它仍是内部证据。报告必须说明分数是否因数据清理、提示词差异、裁判差异或检索可见性差异而不可直接比较。

English: Public claim approval requires a human-reviewed statement. The statement must include exact dataset version, split, code commit, model route, judge route, prompt version, sampling settings, cost, failed categories, and whether the run used memory-only retrieval or full-context prompting.

中文：公开声明批准需要人工 review 的声明。声明必须包含精确数据集版本、split、代码 commit、模型路由、裁判路由、提示词版本、采样设置、成本、失败类别，以及运行使用的是 memory-only retrieval（仅记忆检索）还是 full-context prompting（完整上下文提示）。

## 门禁清单 / Gate Checklist

English: Gate 0 is schema readiness. `RawEvent`, `CandidateFact`, `FactEvent`, `QuarantineEntry`, `ProvenanceReceipt`, `ArchivalReceipt`, `RetrievalHit`, `StableMemoryBlock`, and `MemoryScorerReport` have stable versioned schemas.

中文：Gate 0 是 schema 就绪。`RawEvent`、`CandidateFact`、`FactEvent`、`QuarantineEntry`、`ProvenanceReceipt`、`ArchivalReceipt`、`RetrievalHit`、`StableMemoryBlock` 和 `MemoryScorerReport` 都有稳定版本化 schema。

English: Gate 1 is observer quality. The local observer lane passes precision, recall, bilingual recall, false-positive, escalation, provenance, quarantine, latency, and replay thresholds.

中文：Gate 1 是观察器质量。本地观察器通道通过精确率、召回率、双语召回率、误报率、升级覆盖、来源凭据、隔离、延迟和重放阈值。

English: Gate 2 is archival integrity. Raw events can be restored by receipt, active facts can be rebuilt from the append-only stream, cold storage keeps replay metadata, and restore into active memory is gated as a write-capable action.

中文：Gate 2 是归档完整性。原始事件可以通过凭据恢复，活跃事实可以从只追加事实流重建，冷存储保留回放元数据，并且恢复到活跃记忆被视为具备写入效果的动作并进入门禁。

English: Gate 3 is safety containment. Memory promotion, profile writes, procedural writes, cross-user export, archive restore, and idle-generated writes all produce policy records and respect `WriteAuthority`.

中文：Gate 3 是安全约束。记忆提升、画像写入、流程写入、跨用户导出、归档恢复和空闲生成写入都产出策略记录，并遵守 `WriteAuthority`。

English: Gate 4 is live shadow validation. Real or consented synthetic runs can produce shadow candidates, labels, metrics, and drift reports without changing durable memory.

中文：Gate 4 是实时影子验证。真实或已授权合成运行可以产出影子候选、标签、指标和漂移报告，但不改变持久记忆。

English: Gate 5 is public smoke readiness. At least one LongMemEval or LoCoMo smoke lane and one BEAM-style scale lane can run with manifests, sidecars, evidence IDs, and blocked-lane reporting.

中文：Gate 5 是公开 smoke 就绪。至少一条 LongMemEval 或 LoCoMo smoke lane，以及一条 BEAM-style scale lane，可以带清单、sidecar、证据 ID 和阻塞通道报告运行。

English: Gate 6 is full leaderboard readiness. The team has a reviewed run package, exact reproducibility metadata, cost record, failure taxonomy, and explicit approval to publish or compare externally.

中文：Gate 6 是完整排行榜就绪。团队已有经过 review 的运行包、精确可复现元数据、成本记录、失败分类，以及公开发布或外部比较的明确批准。

## Linear 映射 / Linear Mapping

English: `QUI-16` owns this validation, archival, and public-lane expansion plan. It should remain open until at least the local observer gate, archive gate, safety gate, and one public smoke lane are implemented and verified.

中文：`QUI-16` 负责本文的验证、归档和公开通道扩展计划。它应保持 open，直到至少本地观察器门禁、归档门禁、安全门禁和一条公开 smoke lane 被实现并验证。

English: `QUI-65` owns the runtime implementation that makes this plan executable: observer queue, fact stream, quarantine queue, retrieval fusion, provenance receipts, and local scorer.

中文：`QUI-65` 负责让本文可执行的运行时实现：观察器队列、事实流、隔离队列、检索融合、来源凭据和本地评分器。

English: `QUI-73` remains the baseline for long-memory evaluation lanes. `QUI-16` should extend it with observer-write metrics, archival receipts, live shadow validation, cross-user policy checks, and leaderboard packaging.

中文：`QUI-73` 继续作为长期记忆评测通道的基线。`QUI-16` 应在其基础上扩展观察器写入指标、归档凭据、实时影子验证、跨用户策略检查和排行榜打包。

English: `QUI-53` and `QUI-64` own the safety policy layer. `QUI-16` consumes their action policy records and must not create a memory-only permission plane.

中文：`QUI-53` 和 `QUI-64` 负责安全策略层。`QUI-16` 消费它们的动作策略记录，不得创建一套只属于 Memory 的权限平面。

English: `QUI-68` owns Self-Evolution. `QUI-16` may consume idle-generated analysis only as proposal evidence, never as automatically applied memory or documentation changes.

中文：`QUI-68` 负责 Self-Evolution。`QUI-16` 可以把空闲生成分析作为提案证据消费，但绝不能把它当作自动应用的记忆或文档变更。

## 参考 / References

English: Evidence was checked on 2026-05-02 Asia/Shanghai. The sources below are first-party or official sources used for benchmark shape, event shape, and memory safety framing.

中文：证据已在 2026-05-02 Asia/Shanghai 校准。以下来源是一手或官方来源，用于确定基准形态、事件形态和记忆安全边界。

| Source | Use |
|---|---|
| [LongMemEval paper](https://arxiv.org/abs/2410.10813) and [official repository](https://github.com/xiaowu0162/LongMemEval) | Five long-memory abilities, official evaluation path, official data download instructions |
| [LongMemEval cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | Current cleaned splits and dataset packaging note |
| [LoCoMo paper](https://aclanthology.org/2024.acl-long.747.pdf), [project page](https://snap-research.github.io/locomo/), and [official repository](https://github.com/snap-research/locomo) | Long conversation QA, event summarization, multimodal dialogue generation, and `data/locomo10.json` schema |
| [BEAM paper](https://arxiv.org/abs/2510.27246) and [official repository](https://github.com/mohammadtavakoli78/BEAM) | Million-token memory scale, ten memory abilities, dataset sizes, evaluation packaging |
| [OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/) | Memory poisoning, hashing, policy checks, snapshots, rollback, and persistent-memory attack framing |
| [Agent Observability Standard events](https://aos.owasp.org/spec/trace/events/) and [specification](https://aos.owasp.org/spec/instrument/specification/) | Memory-store and memory-retrieval event vocabulary, tool request/result correlation, audit-oriented event shape |

| 来源 | 用途 |
|---|---|
| [LongMemEval 论文](https://arxiv.org/abs/2410.10813) 与 [官方仓库](https://github.com/xiaowu0162/LongMemEval) | 五类长期记忆能力、官方评估路径、官方数据下载说明 |
| [LongMemEval cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | 当前 cleaned split 与数据包说明 |
| [LoCoMo 论文](https://aclanthology.org/2024.acl-long.747.pdf)、[项目页](https://snap-research.github.io/locomo/) 与 [官方仓库](https://github.com/snap-research/locomo) | 长对话 QA、事件总结、多模态对话生成和 `data/locomo10.json` schema |
| [BEAM 论文](https://arxiv.org/abs/2510.27246) 与 [官方仓库](https://github.com/mohammadtavakoli78/BEAM) | 百万 token 级记忆规模、十类记忆能力、数据集规模和评估打包 |
| [OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/) | 记忆投毒、哈希、策略检查、快照、回滚和持久记忆攻击面定义 |
| [Agent Observability Standard events](https://aos.owasp.org/spec/trace/events/) 与 [specification](https://aos.owasp.org/spec/instrument/specification/) | memory-store 与 memory-retrieval 事件词表、工具请求和结果关联、审计导向事件结构 |
