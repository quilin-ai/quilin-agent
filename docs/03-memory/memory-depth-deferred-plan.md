# 记忆深度延后运行时计划 / Memory Depth Deferred Runtime Plan

> Linear: `QUI-11`
>
> Scope: planning artifact only. This document does not implement runtime code, does not run public benchmark（基准测试，用统一输入和评分比较系统能力）, and does not close `QUI-11`.
>
> 范围：仅规划产物。本文不实现运行时代码，不运行公开 benchmark（基准测试，用统一输入和评分比较系统能力），也不关闭 `QUI-11`。

## 目标 / Goal

English: `QUI-11` owns the deferred Iter F path for Memory depth（记忆深度能力，即系统跨长时间、多会话、多来源和多次事实更新仍能安全使用记忆的能力）, L3a observer runtime（第 3a 层观察器运行时，即把会话和工具事件转成候选记忆事实的后台执行路径）, and LongMemEval/live observer validation（长期记忆评测与在线观察器验证，即用公开样例和影子运行验证长期记忆行为）. It starts only after the F1 Memory runtime and observer evaluation pipeline have produced local evidence.

中文：`QUI-11` 负责 Memory depth（记忆深度能力，即系统跨长时间、多会话、多来源和多次事实更新仍能安全使用记忆的能力）、L3a observer runtime（第 3a 层观察器运行时，即把会话和工具事件转成候选记忆事实的后台执行路径）以及 LongMemEval/live observer validation（长期记忆评测与在线观察器验证，即用公开样例和影子运行验证长期记忆行为）在 Iter F 的延后路径。它只应在 F1 Memory runtime 和观察器评估流水线已经产出本地证据后启动。

English: This document separates long-term capability depth from `docs/03-memory/observer-evaluation-pipeline-plan.md`. The observer evaluation document defines validation lanes, archival receipts, and evaluation packaging; this document defines when deeper memory should be reopened, what prerequisites must exist, and which runtime boundaries prevent deep memory from becoming unsafe or noisy.

中文：本文把长期能力深度与 `docs/03-memory/observer-evaluation-pipeline-plan.md` 区分开。观察器评估文档定义验证通道、归档凭据和评估打包；本文定义何时重开更深层记忆、必须具备哪些前置条件，以及哪些运行时边界防止深记忆变成不安全或高噪声系统。

## 非目标 / Non-Goals

English: This file does not replace `QUI-65`, which owns the first Memory runtime implementation: `FactEvent`（事实事件，用只追加事件表达可复用记忆事实）, asynchronous observer（异步观察器，后台提取候选事实）, quarantine（隔离队列，暂存低信任候选）, retrieval fusion（检索融合，把多种召回信号合并）, and local fixture scoring（本地样例评分，用固定样例评估行为）.

中文：本文不替代 `QUI-65`，后者负责第一版 Memory runtime（记忆运行时）实现：`FactEvent`（事实事件，用只追加事件表达可复用记忆事实）、asynchronous observer（异步观察器，后台提取候选事实）、quarantine（隔离队列，暂存低信任候选）、retrieval fusion（检索融合，把多种召回信号合并）和 local fixture scoring（本地样例评分，用固定样例评估行为）。

English: This file does not replace `QUI-16`, which owns observer validation, archival integrity, public-lane smoke runs, and evaluation artifact shape. `QUI-11` should consume those outputs and decide whether memory can be deepened safely.

中文：本文不替代 `QUI-16`，后者负责观察器验证、归档完整性、公开通道冒烟运行和评估产物结构。`QUI-11` 应消费这些输出，再判断记忆能力是否可以安全加深。

English: This file does not promote benchmark work ahead of component strength. LongMemEval（长期记忆能力评测，用于评估聊天助手跨多会话保存和使用信息的公开基准）, LoCoMo（Long-term Conversational Memory，一个长对话、多会话和归因评测）, and BEAM-style checks（借鉴百万级上下文记忆评测思想的本地检查）remain verification lenses after local Memory gates are green.

中文：本文不把 benchmark 工作提前到组件强化之前。LongMemEval（长期记忆能力评测，用于评估聊天助手跨多会话保存和使用信息的公开基准）、LoCoMo（Long-term Conversational Memory，一个长对话、多会话和归因评测）和 BEAM-style checks（借鉴百万级上下文记忆评测思想的本地检查）继续作为本地 Memory 门禁通过后的验证视角。

## 当前状态 / Current State

English: The current Memory README records that the L3a observer rule-first gate failed over the 1,039-sample dataset: overall recall was 21.4%, Chinese recall was 0.0%, mixed-language recall was 5.2%, and Tier 2 escalation（第二层升级，即规则不确定时交给模型或审核路径处理）was only 1.1%. This means deep memory cannot reopen by simply extending deterministic rules.

中文：当前 Memory README 记录 L3a observer 的 rule-first gate（规则优先门禁）在 1,039 条样本上失败：总体召回率 21.4%、中文召回率 0.0%、中英混合召回率 5.2%，Tier 2 escalation（第二层升级，即规则不确定时交给模型或审核路径处理）只有 1.1%。这意味着深记忆不能靠继续扩展确定性规则直接重开。

English: The current runtime plan already requires raw evidence preservation, append-only fact events, provenance receipts（来源凭据，记录事实从哪个原始事件和策略决策而来）, quarantine, and retrieval fusion. Iter F memory depth should not add a second write path; it must deepen the same event stream and retrieval contract.

中文：当前运行时计划已经要求保留原始证据、只追加事实事件、provenance receipts（来源凭据，记录事实从哪个原始事件和策略决策而来）、隔离队列和检索融合。Iter F 的记忆深度不应新增第二条写入路径；它必须加深同一条事件流和检索契约。

English: The current evaluation baseline treats public benchmark lanes as soft lanes until dataset access, judge-model credentials, cost controls, and local evidence exist. `QUI-11` keeps that ordering: first prove local depth behavior, then use public lanes to verify.

中文：当前评估基线把公开 benchmark 通道视为软性通道，直到数据访问、裁判模型凭证、成本控制和本地证据具备。`QUI-11` 保持这个顺序：先证明本地深度行为，再用公开通道验证。

## 记忆深度定义 / Memory Depth Definition

English: Memory depth is not "store more text." It is the ability to preserve raw evidence, derive useful facts, track changes over time, retrieve the right evidence under budget, and refuse unsafe or unsupported memory influence.

中文：记忆深度不是“存更多文本”。它是保留原始证据、派生有用事实、追踪事实随时间变化、在预算内检索正确证据，并拒绝不安全或无证据记忆影响的能力。

English: Time depth means facts survive across days or months with validity windows, supersession, and rollback. A remembered preference should show when it was observed, whether it is still active, and what later event changed it.

中文：时间深度表示事实可以跨天或跨月存在，并带有效期窗口、替换关系和回滚路径。一条被记住的偏好应说明它何时被观察到、是否仍然有效，以及哪条后续事件改变了它。

English: Source depth means the system can explain the difference between user statements, tool outputs, external pages, peer-agent messages, and inferred facts. Different sources may be evidence, but they do not have equal authority to write durable memory.

中文：来源深度表示系统能区分用户陈述、工具输出、外部网页、同伴 agent 消息和推断事实。不同来源都可以作为证据，但它们没有同等权限写入持久记忆。

English: Reasoning depth means retrieval can combine semantic similarity（语义相似度，用向量表示含义接近度）, keyword search（关键词搜索，用精确词匹配标识符和短语）, entity linking（实体链接，把同一个人、项目或文件归一化）, and lazy temporal graph traversal（按需时序图遍历，仅在时间或关系问题需要时运行）without flooding Context.

中文：推理深度表示检索可以组合 semantic similarity（语义相似度，用向量表示含义接近度）、keyword search（关键词搜索，用精确词匹配标识符和短语）、entity linking（实体链接，把同一个人、项目或文件归一化）和 lazy temporal graph traversal（按需时序图遍历，仅在时间或关系问题需要时运行），同时不淹没 Context（上下文层）。

English: Safety depth means memory is treated as an attack surface. A malicious page, compromised tool output, or stale self-evolution note cannot become a permanent instruction, permission grant, or user profile fact without policy authority.

中文：安全深度表示记忆被视为攻击面。恶意网页、被污染的工具输出或过期自进化笔记，不能在没有策略授权的情况下变成永久指令、权限授予或用户画像事实。

## Iter F 重开门槛 / Iter F Reopen Gates

English: Gate 1 is runtime foundation. `QUI-65` must have implemented `FactEvent`, `CandidateFact`（候选事实，尚未被提升为稳定记忆的观察结果）, provenance receipts, quarantine, retrieval fusion, and a deterministic local scorer with passing evidence.

中文：门槛 1 是运行时基础。`QUI-65` 必须已经实现 `FactEvent`、`CandidateFact`（候选事实，尚未被提升为稳定记忆的观察结果）、来源凭据、隔离队列、检索融合，以及通过验证的确定性本地评分器。

English: Gate 2 is observer validation. `QUI-16` must have local observer validation, live shadow validation（在线影子验证，即只产出候选和指标、不改变正式记忆）, archival receipts, and public smoke lane wiring. The old L3a failed spike must remain a regression floor.

中文：门槛 2 是观察器验证。`QUI-16` 必须具备本地观察器验证、live shadow validation（在线影子验证，即只产出候选和指标、不改变正式记忆）、归档凭据，以及公开冒烟通道接线。旧 L3a 失败 spike 必须继续作为回归底线。

English: Gate 3 is credential and local-model readiness. The team must choose either a remote-credential lane with explicit model, judge, embedding, rate-limit, and cost controls, or a local lane with installed embedding and extraction models. Missing credentials should downgrade the lane, not block local deterministic evidence.

中文：门槛 3 是凭证与本地模型就绪。团队必须选择一条远程凭证通道，并明确模型、裁判、向量、限速和成本控制；或选择一条本地通道，并安装向量与抽取模型。凭证缺失应降级通道，而不是阻断本地确定性证据。

English: Gate 4 is privacy and profile policy. Durable profile writes（持久用户画像写入，即会跨会话影响个性化行为的写入）, cross-session memory sharing, cross-user aggregates, and idle-generated memory proposals must have policy records before Iter F can deepen memory.

中文：门槛 4 是隐私与用户画像策略。Durable profile writes（持久用户画像写入，即会跨会话影响个性化行为的写入）、跨会话记忆共享、跨用户聚合，以及空闲生成的记忆提案，在 Iter F 加深记忆前都必须有策略记录。

English: Gate 5 is observability. Every memory write, quarantine decision, retrieval hit, profile proposal, and public-lane case must carry trace identifiers so failures can be diagnosed without reading raw private logs.

中文：门槛 5 是可观测性。每次记忆写入、隔离决策、检索命中、用户画像提案和公开通道样例都必须带 trace identifiers（追踪标识），让失败诊断不需要阅读原始私有日志。

## 凭证与本地模型前置条件 / Credential And Local-Model Prerequisites

English: A remote-model lane requires four explicit credentials: extraction model credentials, embedding model credentials, optional judge model credentials, and public dataset access where the dataset requires terms or login. Each run must store model name, provider, prompt version, price source, token usage, and retry policy.

中文：远程模型通道需要四类明确凭证：抽取模型凭证、向量模型凭证、可选裁判模型凭证，以及需要条款或登录的数据集访问权限。每次运行都必须保存模型名、供应商、提示词版本、价格来源、token 用量和重试策略。

English: A local-model lane should be first-class, not a fallback afterthought. Ollama's official embedding API exposes `/api/embed` and returns normalized vectors for local models; that is enough to define a local embedding contract, provided the model version, vector dimension, and hardware profile are recorded.

中文：本地模型通道应是一等路径，而不是临时降级方案。Ollama 官方 embedding API 暴露 `/api/embed` 并返回归一化向量；只要记录模型版本、向量维度和硬件配置，就足以定义本地向量契约。

English: Local extraction can start with small model-assisted observers only after deterministic extraction emits full candidate records. A local model may classify, summarize, or resolve ambiguity, but it must not promote facts directly without the same policy gate as remote models.

中文：本地抽取应在确定性抽取已经产出完整候选记录后，再引入小模型辅助观察器。本地模型可以分类、总结或消解歧义，但不能绕过与远程模型相同的策略门直接提升事实。

English: The credential gate must support "no paid judge" operation. In that mode, `QUI-11` can run deterministic local fixtures, retrieval evidence checks, and shadow extraction reports, but it cannot report official LongMemEval answer accuracy that depends on a remote judge.

中文：凭证门槛必须支持“无付费裁判”运行模式。在该模式下，`QUI-11` 可以运行确定性本地样例、检索证据检查和影子抽取报告，但不能报告依赖远程裁判的 LongMemEval 官方答案准确率。

English: Cost and privacy budgets are part of readiness. A memory-depth run is not ready if it can silently upload private conversations, replay raw file contents into a model, or spend without a per-run cap and stop condition.

中文：成本与隐私预算也是就绪条件的一部分。如果一次深记忆运行可能静默上传私有对话、把原始文件内容重放进模型，或在没有单次运行上限和停止条件的情况下消费成本，那么它还没有就绪。

## L3a 观察器运行时边界 / L3a Observer Runtime Boundary

English: The L3a observer should be a background worker（后台工作单元，异步处理事件而不阻塞主流程）attached to the raw event stream. The synchronous path records raw events and enqueue metadata; all extraction, model calls, policy review, and retrieval-index updates are retryable async work.

中文：L3a observer 应是接在原始事件流后的 background worker（后台工作单元，异步处理事件而不阻塞主流程）。同步路径只记录原始事件和入队元数据；所有抽取、模型调用、策略审核和检索索引更新都属于可重试异步工作。

English: The worker emits candidate facts, not final memory. A candidate must include source event ids, language, entities, normalized claim, confidence, extraction path, policy labels, and whether it needs human or model-assisted review.

中文：该 worker 产出候选事实，而不是最终记忆。候选事实必须包含来源事件编号、语言、实体、标准化断言、置信度、抽取路径、策略标签，以及是否需要人工或模型辅助 review。

English: Deterministic extraction is a high-precision fast path. It may handle explicit preferences, dates, file edits, tool results, URLs, Linear identifiers, and test outcomes. Ambiguous, bilingual, cross-turn, adversarial, or safety-relevant cases must escalate.

中文：确定性抽取是高精确率快速路径。它可以处理明确偏好、日期、文件修改、工具结果、URL、Linear 编号和测试结果。模糊、双语、跨轮、对抗或安全相关样例必须升级处理。

English: Model-assisted extraction is a recall path, not an authority path. It may propose facts and conflict groups, but promotion still requires source trust, policy decision, provenance receipt, and write authority.

中文：模型辅助抽取是召回路径，不是授权路径。它可以提出事实和冲突组，但提升仍然需要来源信任、策略决策、来源凭据和写入权限。

English: The runtime must preserve idempotency. Replaying the same raw event should either produce the same candidate ids or detect a duplicate through content hash, source event id, observer version, and prompt version.

中文：运行时必须保持幂等。重放同一条原始事件时，应产生相同候选编号，或通过内容哈希、来源事件编号、观察器版本和提示词版本检测重复。

## LongMemEval 与在线观察器验证边界 / LongMemEval And Live Observer Validation Boundary

English: LongMemEval is useful because its official paper defines five long-term memory abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention（拒答，即证据不足时不编造答案）. `QUI-11` should map those abilities into local depth gates before running a full public lane.

中文：LongMemEval 有价值，因为其官方论文定义了五类长期记忆能力：信息抽取、多会话推理、时间推理、知识更新和 abstention（拒答，即证据不足时不编造答案）。`QUI-11` 应先把这些能力映射成本地深度门禁，再运行完整公开通道。

English: A LongMemEval smoke lane should ingest official sessions as raw events, require the observer to emit candidate facts, run retrieval with evidence ids, and only then score final answers. If the system answers correctly but writes unsafe or ungrounded memory, the lane still fails.

中文：LongMemEval 冒烟通道应把官方 session 作为原始事件写入，要求观察器产出候选事实，使用 evidence ids（证据编号）运行检索，然后才评分最终答案。如果系统答对但写入不安全或无来源记忆，该通道仍然失败。

English: Live observer validation must run in shadow mode until local gates pass. Shadow mode may measure candidate quality, drift, profile-overreach risk, and quarantine decisions, but it must not change official long-term memory.

中文：在线观察器验证必须保持 shadow mode（影子模式）直到本地门禁通过。影子模式可以衡量候选质量、漂移、用户画像越界风险和隔离决策，但不得改变正式长期记忆。

English: Live cases must avoid raw private log exposure. The minimum case record stores event hashes, redaction profile, observer version, candidate fact ids, quarantine reasons, policy decisions, retrieved evidence ids, and scorer output.

中文：在线样例必须避免暴露原始私有日志。最小样例记录保存事件哈希、脱敏配置、观察器版本、候选事实编号、隔离原因、策略决策、检索证据编号和评分输出。

English: Deep memory validation must include negative cases. The system should prove it can ignore temporary preferences, refuse profile writes from external pages, abstain when evidence is missing, and avoid reviving invalidated facts.

中文：深记忆验证必须包含负例。系统应证明它能忽略临时偏好、拒绝来自外部网页的用户画像写入、在证据缺失时拒答，并避免重新启用已失效事实。

## User Profile Store 关系 / User Profile Store Relationship

English: The User Profile Store（用户画像存储，用来保存跨会话稳定偏好和身份相关事实） is not a dumping ground for all inferred user traits. It should accept only explicit, stable, consent-compatible, and source-grounded profile facts.

中文：User Profile Store（用户画像存储，用来保存跨会话稳定偏好和身份相关事实）不是所有推断用户特征的垃圾桶。它只应接受明确、稳定、符合授权且有来源支撑的用户画像事实。

English: Project preferences and personal preferences must stay separated. "This project requires bilingual docs" is a project memory; "the user personally prefers bilingual docs everywhere" is a profile memory only if the user explicitly says so.

中文：项目偏好和个人偏好必须分离。“这个项目要求中英双语文档”是项目记忆；“用户本人在所有地方都偏好中英双语文档”只有在用户明确这样说时才是用户画像记忆。

English: Temporary task instructions must not become durable profile facts. A demo-specific color, one-off formatting request, or current debugging preference should remain episodic unless the user explicitly asks it to persist.

中文：临时任务指令不得变成持久用户画像事实。某次 demo 的颜色、一次性格式要求或当前 debug 偏好，应保留为情节记忆，除非用户明确要求长期保留。

English: Profile updates require conflict handling. If a later explicit user statement contradicts an older profile fact, the system should add a superseding event, keep provenance for both, and retrieve only the active fact by default.

中文：用户画像更新需要冲突处理。如果后续用户明确陈述与旧画像事实冲突，系统应新增替换事件，保留两者的来源凭据，并默认只检索当前有效事实。

English: Shared profile memory is disabled by default. A profile fact learned in one user or tenant scope must not become retrievable in another scope unless an explicit policy allows aggregate, redacted, non-identifying use.

中文：共享用户画像记忆默认关闭。在一个用户或租户范围学到的画像事实，不得在另一个范围可检索，除非明确策略允许聚合、脱敏、不可识别的使用方式。

## Idle Evolution 关系 / Idle Evolution Relationship

English: Idle Evolution（空闲自进化，即无人主动交互时运行的后台分析与提案） may inspect memory metrics, propose fixture additions, cluster observer failures, and draft schema improvements. It must not promote memory, release quarantine entries, write profile facts, or export raw memory.

中文：Idle Evolution（空闲自进化，即无人主动交互时运行的后台分析与提案）可以检查记忆指标、提出样例增补、聚类观察器失败并草拟 schema 改进。它不得提升记忆、释放隔离项、写入用户画像事实或导出原始记忆。

English: Idle-generated proposals must be recorded in Linear and written to bilingual docs before they affect project direction. A local-only note from an idle worker is not durable project knowledge.

中文：空闲生成的提案必须记录到 Linear，并写入中英双语文档后，才能影响项目方向。空闲 worker 的本地笔记不属于持久项目知识。

English: Idle evolution can strengthen memory depth by discovering failure clusters, not by silently editing memory. Its safe output is a proposal with evidence ids, not a changed user profile or runtime behavior.

中文：空闲自进化可以通过发现失败聚类来增强记忆深度，而不是静默编辑记忆。它的安全输出是带证据编号的提案，而不是被改变的用户画像或运行时行为。

English: `origin:"idle"` remains a high-risk write origin. Even in an auto-trust session, memory-depth changes that affect durable profile facts, cross-user artifacts, public benchmark packages, or runtime code require human review.

中文：`origin:"idle"` 仍是高风险写入来源。即便处于自动信任 session，影响持久画像事实、跨用户产物、公开 benchmark 包或运行时代码的深记忆变更仍需要人工 review。

## 最小运行时产物 / Minimum Runtime Artifacts

English: A memory-depth run must produce a manifest（清单文件，记录运行输入、版本和证据路径） before it starts. The manifest records Linear issue, code commit or dirty-worktree note, dataset source, model route, credential mode, privacy policy, and stop conditions.

中文：一次深记忆运行开始前必须产出 manifest（清单文件，记录运行输入、版本和证据路径）。该 manifest 记录 Linear issue、代码 commit 或 dirty-worktree 说明、数据集来源、模型路由、凭证模式、隐私策略和停止条件。

```json
{
  "schema_version": 1,
  "linear_issue": "QUI-11",
  "lane": "local_memory_depth_shadow",
  "credential_mode": "local_model | remote_model | deterministic_only",
  "privacy_mode": "metadata_only | redacted_content",
  "observer_version": "l3a-observer-v1",
  "embedding_model": "embeddinggemma",
  "judge_model": null,
  "stop_conditions": {
    "max_cases": 100,
    "max_cost_usd": 0,
    "max_private_raw_uploads": 0
  }
}
```

English: Candidate fact output must show what the observer tried to remember and why. It is not enough to store final answers or summary text.

中文：候选事实输出必须展示观察器试图记住什么以及为什么记。只保存最终答案或摘要文本是不够的。

```json
{
  "schema_version": 1,
  "candidate_fact_id": "cand_memory_depth_001",
  "source_event_ids": ["event_001"],
  "memory_kind": "profile",
  "normalized_claim": "project_docs_language_rule=bilingual",
  "extraction_path": "deterministic",
  "confidence": 0.98,
  "policy_labels": ["memory_write", "profile_boundary"],
  "promotion_state": "quarantined",
  "quarantine_reason": "project_preference_not_personal_profile"
}
```

English: Retrieval output must show evidence, trust, and freshness. A deep memory answer is not accepted unless the supporting facts are active, source-grounded, and allowed for the current scope.

中文：检索输出必须展示证据、信任等级和新鲜度。深记忆答案只有在支持事实有效、有来源支撑且允许用于当前范围时，才可被验收。

```json
{
  "schema_version": 1,
  "query_id": "q_memory_depth_001",
  "retrieved_fact_ids": ["fact_project_docs_language_rule"],
  "evidence_ids": ["event_001"],
  "trust_tiers": ["user_explicit"],
  "active_only": true,
  "scope": "project",
  "profile_fact_used": false
}
```

## 验收门槛 / Acceptance Gates

English: The first Iter F acceptance gate is local. It should require observer write precision at least 0.95, observer write recall at least 0.75, Chinese-only recall at least 0.70, mixed-language recall at least 0.70, provenance coverage 1.00 for promoted facts, and profile false positives equal to 0.

中文：Iter F 的第一道验收门槛是本地门槛。它应要求观察器写入精确率至少 0.95、观察器写入召回率至少 0.75、中文-only 召回至少 0.70、中英混合召回至少 0.70、被提升事实的来源凭据覆盖率为 1.00，以及用户画像误写为 0。

English: The safety gate should require poisoning rejection rate 1.00 on seeded attack fixtures, quarantine recall at least 0.95 for low-trust writes, no profile writes from untrusted external content, and no durable writes from idle origin without review.

中文：安全门槛应要求种子攻击样例上的投毒拒绝率为 1.00、低信任写入的隔离召回率至少 0.95、不从不可信外部内容写入用户画像，并且没有未经 review 的空闲来源持久写入。

English: The retrieval gate should require evidence recall@5 at least 0.90, active-fact accuracy at least 0.95, stale-fact rejection at least 0.95, contradiction pass rate 1.00, and p95 retrieval latency within the target already accepted by `QUI-65`.

中文：检索门槛应要求 evidence recall@5 至少 0.90、有效事实准确率至少 0.95、过期事实拒绝率至少 0.95、矛盾处理通过率 1.00，并且 p95 检索延迟在 `QUI-65` 已接受的目标内。

English: The public-lane gate should start with smoke runs only. A full LongMemEval report is allowed only after local gates pass, credential mode is declared, judge configuration is recorded, and per-case evidence sidecars are stored.

中文：公开通道门槛应先从冒烟运行开始。只有本地门禁通过、凭证模式已声明、裁判配置已记录，并且逐 case 证据 sidecar（旁路文件）已保存后，才允许发布完整 LongMemEval 报告。

English: `QUI-11` should remain open until runtime code and validation evidence exist. This document is a reopen and boundary plan, not the implementation itself.

中文：`QUI-11` 应保持 open，直到运行时代码和验证证据存在。本文是重开门槛与边界计划，不是实现本身。

## Linear 映射 / Linear Mapping

English: `QUI-11` owns Iter F memory depth, including L3a observer runtime maturity, local-model and credential gates, deep-memory validation, User Profile Store boundaries, and Idle Evolution boundaries.

中文：`QUI-11` 负责 Iter F 记忆深度，包括 L3a 观察器运行时成熟度、本地模型与凭证门槛、深记忆验证、User Profile Store 边界和 Idle Evolution 边界。

English: `QUI-65` owns the first runtime implementation. `QUI-16` owns the observer validation and evaluation pipeline. `QUI-73` owns the long-memory evaluation baseline. `QUI-53` and `QUI-64` own safety and action-level verification. `QUI-68` and `QUI-12` own Self-Evolution proposal boundaries.

中文：`QUI-65` 负责第一版运行时实现。`QUI-16` 负责观察器验证与评估流水线。`QUI-73` 负责长期记忆评测基线。`QUI-53` 和 `QUI-64` 负责安全与动作级验证。`QUI-68` 和 `QUI-12` 负责自进化提案边界。

English: No new Linear issue is required for this document. Subtasks, subagent logs, review notes, and future probes should reuse `QUI-11` comments unless they need independent ownership, blockers, or acceptance criteria.

中文：本文不需要新建 Linear issue。子任务、subagent 日志、review 记录和后续 probe（调研记录）应复用 `QUI-11` comment，除非它们需要独立负责人、阻塞关系或验收条件。

## 一手参考 / Primary References

English: OpenAI Agents SDK sessions show that sessions provide persistent memory, can use custom storage, and support history inspection, editing, compaction, and resumable human-in-the-loop flows. Reference: <https://openai.github.io/openai-agents-js/guides/sessions/>

中文：OpenAI Agents SDK sessions 说明 session 提供持久记忆层，可使用自定义存储，并支持历史检查、编辑、压缩和可恢复的人类审批流程。参考：<https://openai.github.io/openai-agents-js/guides/sessions/>

English: OpenAI Agents SDK sandbox memory documents separate read/generate memory controls and memory isolation by layout, which supports Quilin's separation between profile, project, subagent, and checker memory. Reference: <https://openai.github.io/openai-agents-python/sandbox/memory/>

中文：OpenAI Agents SDK sandbox memory 说明可分离 read/generate memory 控制，并按 layout 隔离记忆，这支持 Quilin 对用户画像、项目、subagent 和 checker 记忆的隔离。参考：<https://openai.github.io/openai-agents-python/sandbox/memory/>

English: Letta memory blocks are useful as a current reference for always-visible, agent-managed, shareable memory blocks, while Quilin should keep stronger write authority and provenance gates. Reference: <https://docs.letta.com/guides/core-concepts/memory/memory-blocks>

中文：Letta memory blocks 是当前 always-visible（始终可见）、agent-managed（由 agent 管理）、shareable（可共享）记忆块的参考；Quilin 应在此基础上保持更强写权限和来源凭据门禁。参考：<https://docs.letta.com/guides/core-concepts/memory/memory-blocks>

English: Mem0's platform documentation is useful as a production memory-layer reference, especially for continuity and managed memory ergonomics, but Quilin keeps local-first and policy-gated behavior. Reference: <https://docs.mem0.ai/platform/overview>

中文：Mem0 平台文档可作为生产记忆层参考，尤其是连续性与托管记忆体验；但 Quilin 继续保持本地优先和策略门禁。参考：<https://docs.mem0.ai/platform/overview>

English: Graphiti is a current temporal context graph reference for agent memory and governed retrieval, but Quilin keeps lazy temporal traversal instead of eagerly graphing all facts. Reference: <https://github.com/getzep/graphiti>

中文：Graphiti 是当前面向 agent memory 的 temporal context graph（时序上下文图）与受治理检索参考；但 Quilin 保持按需时序遍历，而不是急切地把所有事实图化。参考：<https://github.com/getzep/graphiti>

English: LongMemEval defines the five long-term memory abilities used in this document: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. Reference: <https://arxiv.org/abs/2410.10813>

中文：LongMemEval 定义了本文使用的五类长期记忆能力：信息抽取、多会话推理、时间推理、知识更新和拒答。参考：<https://arxiv.org/abs/2410.10813>

English: Ollama embeddings documentation defines the local `/api/embed` route and normalized vector output, which supports Quilin's local embedding gate. Reference: <https://docs.ollama.com/capabilities/embeddings>

中文：Ollama embeddings 文档定义了本地 `/api/embed` 路由和归一化向量输出，支持 Quilin 的本地向量门槛。参考：<https://docs.ollama.com/capabilities/embeddings>

English: OWASP Agent Memory Guard treats persistent mutable memory as an attack surface and is the security reference for memory poisoning, cross-session persistence risk, and runtime defense. Reference: <https://owasp.org/www-project-agent-memory-guard/>

中文：OWASP Agent Memory Guard 把持久可变记忆视为攻击面，是记忆投毒、跨会话持久化风险和运行时防御的安全参考。参考：<https://owasp.org/www-project-agent-memory-guard/>
