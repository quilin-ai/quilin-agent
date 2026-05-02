# 自进化运行时实现规划 / Self-Evolution Runtime Implementation Plan

> Linear: [QUI-68](https://linear.app/quilin-agent/issue/QUI-68/f1实现自进化-trajectorystorefailureanalyzer-与离线优化-implement-self-evolution). Related: [QUI-58](https://linear.app/quilin-agent/issue/QUI-58/f0self-evolution-轨迹失败分析与-gepa-吸收决策-decide-self-evolution-trajectories), [QUI-12](https://linear.app/quilin-agent/issue/QUI-12/iter-f实现-trajectory-to-patch-自进化闭环-implement-trajectory-to-patch-self), [QUI-67](https://linear.app/quilin-agent/issue/QUI-67), and [QUI-74](https://linear.app/quilin-agent/issue/QUI-74).
>
> Linear：[QUI-68](https://linear.app/quilin-agent/issue/QUI-68/f1实现自进化-trajectorystorefailureanalyzer-与离线优化-implement-self-evolution)。关联：[QUI-58](https://linear.app/quilin-agent/issue/QUI-58/f0self-evolution-轨迹失败分析与-gepa-吸收决策-decide-self-evolution-trajectories)、[QUI-12](https://linear.app/quilin-agent/issue/QUI-12/iter-f实现-trajectory-to-patch-自进化闭环-implement-trajectory-to-patch-self)、[QUI-67](https://linear.app/quilin-agent/issue/QUI-67) 和 [QUI-74](https://linear.app/quilin-agent/issue/QUI-74)。

## 目标 / Goal

English: `QUI-68` should implement the first runtime contract for Self-Evolution（自进化，即系统从运行轨迹、失败诊断和评测证据中提出改进方案的能力）without allowing the system to silently change itself. The target loop is: record trajectories, diagnose failures, run offline optimization, compare candidates against frozen evaluations, generate a patch proposal, and stop for human review.

中文：`QUI-68` 应实现 Self-Evolution（自进化，即系统从运行轨迹、失败诊断和评测证据中提出改进方案的能力）的第一版运行时契约，但不能允许系统静默改变自己。目标闭环是：记录运行轨迹、诊断失败、执行离线优化、用冻结评测对比候选方案、生成补丁提案，然后停在人工审核。

English: Benchmark（基准测试，用来比较完整系统能力的标准化评测）execution is not the first priority here. The first priority is a strong Self-Evolution runtime that produces auditable evidence and reviewable proposals; public benchmark suites can later consume the same trajectory and evaluation artifacts.

中文：benchmark（基准测试，用来比较完整系统能力的标准化评测）执行不是本任务第一优先级。第一优先级是让 Self-Evolution runtime（自进化运行时）产出可审计证据和可审核提案；公共基准后续可以复用同一套轨迹与评测产物。

## 设计结论 / Design Verdict

English: The runtime should use a proposal-only architecture. `TrajectoryStore`（运行轨迹存储，用来持久化输入、模型调用、工具调用、观测、成本和结果的事件仓库） and `FailureAnalyzer`（失败分析器，用来把失败归因到可修复类别的诊断层） may run automatically, and the offline optimizer may generate candidate prompts, skills, or scaffold diffs. None of those components may directly write runtime code, bundled skills, project docs, or provider configuration.

中文：运行时应采用 proposal-only architecture（只提案架构）。`TrajectoryStore`（运行轨迹存储，用来持久化输入、模型调用、工具调用、观测、成本和结果的事件仓库）和 `FailureAnalyzer`（失败分析器，用来把失败归因到可修复类别的诊断层）可以自动运行，离线优化器也可以生成候选提示词、技能或脚手架 diff。但这些组件都不能直接写 runtime code（运行时代码）、内置技能、项目文档或模型供应商配置。

English: The safe product boundary is: automated analysis and automated proposal generation are allowed; automated application to runtime behavior is not allowed. A proposal becomes real only after a reviewer accepts it and a human-reviewed PR（pull request，代码评审合入请求）or equivalent approval path applies it.

中文：安全产品边界是：允许自动分析与自动生成提案；不允许自动应用到运行时行为。一个 proposal（提案）只有在 reviewer（审核者）接受后，并通过人工审核 PR（pull request，代码评审合入请求）或等价审批路径应用，才会真正生效。

## 输入依据 / Inputs

English: This plan synthesizes `docs/10-self-evolution/self-evolution-frontier-assimilation.md`, which decided that Quilin should absorb the loop shape from MiniMax M2.7 while rejecting automatic scaffold writes. It also uses `docs/13-skills/skills-frontier-assimilation.md` for skill lifecycle gates, `docs/01-llm-integration/routing-cache-cost-evidence.md` and `docs/01-llm-integration/llm-frontier-assimilation.md` for model routing and cost evidence, and `docs/08-observability/observability-core-loop-frontier.md` for trace-to-eval and step-event contracts.

中文：本文综合 `docs/10-self-evolution/self-evolution-frontier-assimilation.md`，该文已决策 Quilin 应吸收 MiniMax M2.7 的闭环形态，但拒绝自动脚手架写入。本文也参考 `docs/13-skills/skills-frontier-assimilation.md` 的技能生命周期门禁、`docs/01-llm-integration/routing-cache-cost-evidence.md` 与 `docs/01-llm-integration/llm-frontier-assimilation.md` 的模型路由和成本证据，以及 `docs/08-observability/observability-core-loop-frontier.md` 的 trace-to-eval（轨迹转评测）和步骤事件契约。

English: The repository already has useful foundations: `WriteAuthority`（统一写权限门，用来裁决 Agent 发起写入动作的运行时 gate） exists, Skills has a `skill_manage` path, and the benchmark harness（基准执行骨架，用来统一运行评测并记录结果） already records score, cost, and reasoning traces. `QUI-68` should connect these foundations through typed artifacts（类型化产物，用来让证据可追踪和可复现） rather than create a second uncontrolled evolution path.

中文：仓库已有有用基础：`WriteAuthority`（统一写权限门，用来裁决 Agent 发起写入动作的运行时 gate）已经存在，Skills 有 `skill_manage` 路径，benchmark harness（基准执行骨架，用来统一运行评测并记录结果）已经记录分数、成本和推理轨迹。`QUI-68` 应通过 typed artifacts（类型化产物，用来让证据可追踪和可复现）把这些基础串起来，而不是创建第二条不受控的进化路径。

## 运行闭环 / Runtime Loop

English: The first loop should be intentionally small: `TrajectoryStore -> FailureAnalyzer -> TrajectoryDatasetBuilder -> OfflineOptimizer -> EvalComparator -> ProposalStore -> ReviewerDecision`. Each arrow is an artifact boundary with persisted identifiers, hashes, and evidence references.

中文：第一版闭环应刻意保持小型：`TrajectoryStore -> FailureAnalyzer -> TrajectoryDatasetBuilder -> OfflineOptimizer -> EvalComparator -> ProposalStore -> ReviewerDecision`。每条箭头都是 artifact boundary（产物边界），必须带持久化标识、哈希和证据引用。

English: The loop can run after a failed run, after a cluster of similar failures, or after an explicit user request. Idle evolution（空闲自进化，即无人主动交互时运行的后台分析） may only analyze and propose; it must not apply changes, and `origin:"idle"` remains constrained by `WriteAuthority`.

中文：该闭环可以在单次失败后运行，也可以在一组相似失败聚类后运行，或在用户明确要求后运行。Idle evolution（空闲自进化，即无人主动交互时运行的后台分析）只能分析和提案；不能应用变更，并且 `origin:"idle"` 继续受 `WriteAuthority` 约束。

```text
Run events
  -> TrajectoryStore
  -> FailureAnalyzer
  -> frozen local evaluation dataset
  -> offline prompt or skill optimizer
  -> before/after evaluation comparison
  -> generated patch proposal
  -> reviewer decision state
  -> human-reviewed application path outside Self-Evolution runtime
```

## TrajectoryStore（运行轨迹存储）契约

English: `TrajectoryStore` is an append-only event store. Append-only means existing events are never rewritten; corrections are represented as later events. This matters because failure diagnosis, optimizer inputs, and reviewer evidence must be reproducible.

中文：`TrajectoryStore` 是 append-only event store（只追加事件存储）。只追加意味着既有事件永不被改写；修正通过后续事件表示。这很重要，因为失败诊断、优化器输入和审核证据必须可复现。

English: The first implementation should support SQLite（轻量本地关系数据库，用来保存可查询事件） or JSONL（JSON Lines，一行一个 JSON 事件，用来保存可流式追加日志） behind a small TypeScript（类型化 JavaScript，用于本项目 Agent core） interface. The interface should not leak the storage engine, so later migration to a trace backend or embedded event database does not break the runtime.

中文：第一版实现应支持 SQLite（轻量本地关系数据库，用来保存可查询事件）或 JSONL（JSON Lines，一行一个 JSON 事件，用来保存可流式追加日志），并在小型 TypeScript（类型化 JavaScript，用于本项目 Agent core）接口后隐藏细节。接口不应暴露存储引擎，避免未来迁移到 trace backend（追踪后端）或嵌入式事件数据库时破坏运行时。

English: Every stored event should preserve both replay fields and privacy fields. Replay fields let the system reconstruct what happened. Privacy fields tell downstream optimizers whether raw content may be used, redacted, hashed, or excluded.

中文：每条事件都应同时保存 replay fields（回放字段）和 privacy fields（隐私字段）。回放字段用于重建发生过什么；隐私字段告诉下游优化器原始内容是否可使用、是否已脱敏、是否仅哈希保存，或是否应被排除。

```ts
export type TrajectoryEventKind =
  | "run.started"
  | "context.built"
  | "llm.route_decided"
  | "llm.completed"
  | "tool.started"
  | "tool.completed"
  | "safety.decided"
  | "skill.activated"
  | "checkpoint.saved"
  | "eval.scored"
  | "run.stopped"
  | "human.feedback";

export interface TrajectoryEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly parentRunId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly occurredAt: string;
  readonly actor: "main_agent" | "subagent" | "tool" | "skill" | "optimizer" | "reviewer";
  readonly kind: TrajectoryEventKind;
  readonly payloadRef: {
    readonly storage: "inline_redacted" | "local_blob" | "hash_only" | "external_trace";
    readonly ref: string;
    readonly sha256: string;
  };
  readonly privacy: {
    readonly redactionProfile: "metadata_only" | "redacted_content" | "full_content";
    readonly containsSecret: boolean;
    readonly containsPersonalData: boolean;
    readonly optimizerUsable: boolean;
  };
  readonly metrics?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly costUsd?: number;
    readonly durationMs?: number;
  };
}
```

English: `TrajectoryStore` should expose four read paths: by `runId`, by time range, by failure category, and by dataset selection query. It should also expose a sanitized export that removes raw secrets and private file contents before any offline optimizer sees the data.

中文：`TrajectoryStore` 应暴露四类读取路径：按 `runId`、按时间范围、按失败类别、按数据集选择查询。它还应提供 sanitized export（已脱敏导出），在任何离线优化器读取数据前移除原始密钥和私有文件内容。

## FailureAnalyzer（失败分析器）契约

English: `FailureAnalyzer` converts trajectories into typed diagnostic records. It should not output only prose. A reviewer must be able to inspect the failing event range, evidence references, category, confidence, proposed change target, and the reason no proposal was generated when the analyzer decides to stop.

中文：`FailureAnalyzer` 把轨迹转换为类型化诊断记录。它不应只输出散文。审核者必须能检查失败事件范围、证据引用、类别、置信度、建议修改目标，以及分析器决定停止时没有生成提案的原因。

English: The analyzer should be deterministic-first. Rules should catch obvious failures such as tool error, schema violation, repeated loops, budget exhaustion, and missing bilingual documentation. An LLM judge（大语言模型裁判，用另一个模型按规则判断结果） may add diagnosis, but its output must be stored as evidence rather than treated as ground truth.

中文：分析器应 deterministic-first（确定性优先）。规则应先捕获明显失败，例如工具错误、结构违反、重复循环、预算耗尽和缺失中英双语文档。LLM judge（大语言模型裁判，用另一个模型按规则判断结果）可以补充诊断，但其输出必须作为证据保存，而不是被当成绝对真值。

```ts
export type FailureCategory =
  | "tool_selection_error"
  | "tool_execution_error"
  | "context_gap"
  | "planning_decomposition_error"
  | "strategy_mismatch"
  | "verification_gap"
  | "safety_blocked_or_missing"
  | "skill_trigger_miss"
  | "skill_regression"
  | "provider_routing_or_cost_error"
  | "prompt_cache_regression"
  | "observability_gap"
  | "durable_runtime_gap"
  | "user_requirement_missed"
  | "documentation_language_violation"
  | "unknown_or_insufficient_evidence";

export interface FailureDiagnostic {
  readonly schemaVersion: 1;
  readonly diagnosticId: string;
  readonly runId: string;
  readonly failureCategory: FailureCategory;
  readonly failingEventIds: readonly string[];
  readonly directEvidenceRefs: readonly string[];
  readonly expectedBehavior: string;
  readonly observedBehavior: string;
  readonly proposedChangeTarget:
    | "prompt"
    | "skill"
    | "tool_policy"
    | "context_policy"
    | "provider_route"
    | "safety_policy"
    | "runtime_contract"
    | "docs_only"
    | "no_change";
  readonly confidence: number;
  readonly noProposalReason?: "insufficient_evidence" | "unsafe_target" | "duplicate_pattern" | "outside_scope";
}
```

English: The failure taxonomy should stay small enough to drive action. Categories that cannot map to a component owner, evaluation fixture, or proposal target should be collapsed into `unknown_or_insufficient_evidence` until enough examples justify a new category.

中文：失败分类应保持足够小，便于驱动行动。无法映射到组件负责人、评测夹具或提案目标的类别，应先归入 `unknown_or_insufficient_evidence`，直到积累足够样本证明需要新类别。

## FailurePattern（失败模式）聚合

English: A single failure can be noisy. `FailurePattern`（失败模式，即跨多次运行重复出现、可形成改进提案的失败聚类） should be created only when diagnostics share a category, target, and evidence shape. Pattern aggregation prevents the optimizer from overfitting to one unlucky run.

中文：单次失败可能有噪声。只有多个诊断共享类别、目标和证据形态时，才应创建 `FailurePattern`（失败模式，即跨多次运行重复出现、可形成改进提案的失败聚类）。模式聚合可以避免优化器过拟合一次偶发运行。

```ts
export interface FailurePattern {
  readonly patternId: string;
  readonly category: FailureCategory;
  readonly diagnosticIds: readonly string[];
  readonly affectedComponent:
    | "01-llm-integration"
    | "02-context"
    | "03-memory"
    | "04-planning"
    | "05-tool"
    | "06-multi-agent"
    | "07-safety-guardrails"
    | "08-observability"
    | "09-deployment-runtime"
    | "10-self-evolution"
    | "13-skills";
  readonly minimumSupport: number;
  readonly observedSupport: number;
  readonly summary: string;
  readonly proposalAllowed: boolean;
  readonly proposalBlockReason?: string;
}
```

English: The first thresholds should be conservative: one manually marked critical failure may generate a proposal, but automatic pattern-triggered proposals should require at least three similar diagnostics or one high-confidence deterministic regression fixture.

中文：第一版阈值应保守：一条人工标记的 critical failure（关键失败）可以生成提案，但自动模式触发的提案应至少要求三条相似诊断，或一个高置信确定性回归夹具。

## TrajectoryDatasetBuilder（轨迹数据集构建器）

English: `TrajectoryDatasetBuilder` turns selected trajectories into frozen evaluation datasets. Frozen means the exact input records, expected checks, model route assumptions, tool fixtures, prices when needed, and evaluator versions are hashed and stored before any optimizer run starts.

中文：`TrajectoryDatasetBuilder` 把选中的轨迹转换为冻结评测数据集。冻结意味着在任何优化器运行前，精确输入记录、期望检查、模型路由假设、工具夹具、必要时的价格信息和评测器版本都已哈希并保存。

English: The first dataset should be local and product-fit. It should cover Quilin-specific behaviors such as bilingual documentation, Linear logging, skill lifecycle safety, WriteAuthority decisions, context-cache behavior, tool selection, and proposal-only self-evolution. Public benchmark suites can be attached later as external lanes.

中文：第一批数据集应是本地且贴合产品的。它应覆盖 Quilin 特有行为，例如中英双语文档、Linear 记录、技能生命周期安全、WriteAuthority 决策、上下文缓存行为、工具选择和只提案自进化。公共基准套件后续可以作为外部通道接入。

```ts
export interface TrajectoryDataset {
  readonly datasetId: string;
  readonly sourcePatternId: string;
  readonly createdAt: string;
  readonly frozen: true;
  readonly exampleRefs: readonly string[];
  readonly evaluatorProfile: {
    readonly deterministicChecks: readonly string[];
    readonly rubricChecks: readonly string[];
    readonly llmJudgeAllowed: boolean;
  };
  readonly versionHash: string;
}
```

## OfflineOptimizer（离线优化器）契约

English: `OfflineOptimizer`（离线优化器，即不在用户任务运行路径内执行、只读取冻结数据并输出候选改进产物的后台 worker） should be a worker boundary（工作进程边界，用来隔离可替换优化实现）, not a runtime dependency. The TypeScript runtime should call it through a narrow interface, and Python implementations can host DSPy（Declarative Self-improving Python，一个把大语言模型程序拆成可评测模块并离线优化的框架） or GEPA（Genetic-Pareto，一种用自然语言反思和帕累托搜索优化文本参数的算法） adapters（适配器，用来把外部优化框架转换成 Quilin 统一接口） behind that interface.

中文：`OfflineOptimizer`（离线优化器，即不在用户任务运行路径内执行、只读取冻结数据并输出候选改进产物的后台 worker）应是 worker boundary（工作进程边界，用来隔离可替换优化实现），不是运行时依赖。TypeScript 运行时应通过窄接口调用它；Python 实现可以在接口后托管 DSPy（Declarative Self-improving Python，一个把大语言模型程序拆成可评测模块并离线优化的框架）或 GEPA（Genetic-Pareto，一种用自然语言反思和帕累托搜索优化文本参数的算法） adapters（适配器，用来把外部优化框架转换成 Quilin 统一接口）。

English: GEPA/DSPy-style prompt/skill optimization（GEPA/DSPy 风格提示词/技能优化，即用轨迹、评分反馈和搜索算法生成候选提示词或技能文本） must produce artifacts, not writes. Candidate prompts, skill drafts, and scaffold diffs are serialized into `OptimizationCandidate` records and then evaluated before any proposal is shown.

中文：GEPA/DSPy-style prompt/skill optimization（GEPA/DSPy 风格提示词/技能优化，即用轨迹、评分反馈和搜索算法生成候选提示词或技能文本）必须产生产物，而不是执行写入。候选提示词、技能草稿和脚手架 diff 会序列化为 `OptimizationCandidate` 记录，然后先评测，再展示提案。

```ts
export type OptimizerKind =
  | "static_metaprompt"
  | "dspy_bootstrap_few_shot"
  | "dspy_mipro_v2"
  | "gepa_textual_gradient"
  | "manual_candidate";

export interface OptimizationRun {
  readonly optimizationRunId: string;
  readonly datasetId: string;
  readonly patternId: string;
  readonly optimizerKind: OptimizerKind;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly inputHash: string;
  readonly environment: {
    readonly runtime: "typescript" | "python";
    readonly packageLockHash?: string;
    readonly modelRouteDecisionId?: string;
  };
  readonly candidateIds: readonly string[];
}

export interface OptimizationCandidate {
  readonly candidateId: string;
  readonly optimizationRunId: string;
  readonly target: "prompt" | "skill" | "scaffold" | "policy";
  readonly artifactRef: string;
  readonly artifactHash: string;
  readonly rationale: string;
  readonly safetyNotes: readonly string[];
}
```

English: A cheap deterministic baseline（确定性基线，用来提供最简单可复现的对照结果） should always run beside expensive optimizers. This makes gains attributable: if a static metaprompt beats a GEPA candidate, the system should propose the simpler change or produce no proposal.

中文：昂贵优化器旁边必须始终运行一个便宜的 deterministic baseline（确定性基线，用来提供最简单可复现的对照结果）。这样收益才可归因：如果静态 metaprompt（元提示词）优于 GEPA 候选，系统应提议更简单的变更，或不生成提案。

## EvalComparator（评测对比器）

English: `EvalComparator`（评测对比器，用同一冻结数据集比较旧版本和候选版本的组件） is the evidence gate between optimizer output and proposal generation. It compares baseline and candidate runs on success, regression count, deterministic failures, safety violations, token cost, route behavior, prompt-cache evidence, and reviewer readability.

中文：`EvalComparator`（评测对比器，用同一冻结数据集比较旧版本和候选版本的组件）是优化器输出和提案生成之间的证据门。它比较基线和候选运行的成功率、回归数量、确定性失败、安全违反、token 成本、路由行为、提示缓存证据和审核可读性。

English: The comparator should reuse `QUI-74` vocabulary where model calls are involved: route decision, provider path, effective model, time to first token, cache read/write tokens, normalized cost, output quality, and fallback attempts. This avoids separate cost math inside Self-Evolution.

中文：当涉及模型调用时，对比器应复用 `QUI-74` 的词汇：路由决策、供应商路径、实际模型、首 token 延迟、缓存读写 token、归一化成本、输出质量和回退尝试。这样 Self-Evolution 不需要另起一套成本计算。

```ts
export interface EvalComparison {
  readonly comparisonId: string;
  readonly datasetId: string;
  readonly baselineArtifactRef: string;
  readonly candidateId: string;
  readonly passed: boolean;
  readonly summary: {
    readonly successRateDelta: number;
    readonly regressionCount: number;
    readonly criticalFailureCount: number;
    readonly tokenCostDeltaPct?: number;
    readonly latencyDeltaPct?: number;
    readonly qualityScoreDelta?: number;
  };
  readonly requiredEvidenceRefs: readonly string[];
  readonly blockReason?: "safety_regression" | "quality_regression" | "cost_regression" | "missing_evidence";
}
```

English: The first pass rule should be strict: no critical safety regression, no broken deterministic checks, no missing evidence references, and either a meaningful quality improvement or a meaningful cost reduction without quality loss.

中文：第一版通过规则应严格：不能有 critical safety regression（关键安全回归），不能破坏确定性检查，不能缺失证据引用，并且要么有明确质量提升，要么在不损失质量的情况下降低成本。

## ProposalStore（提案存储）与补丁提案

English: `ProposalStore` stores generated patch proposals. A generated patch proposal（生成补丁提案，即由系统生成、供人审核的 diff、证据和回滚说明组合） is not an applied patch. It is a review artifact with enough evidence for a human to accept, reject, request revision, or defer.

中文：`ProposalStore` 存储生成的补丁提案。generated patch proposal（生成补丁提案，即由系统生成、供人审核的 diff、证据和回滚说明组合）不是已应用补丁。它是 review artifact（审核产物），包含足够证据供人接受、拒绝、要求修改或延期。

English: Proposal artifacts should be stored outside runtime code paths, for example under a local proposal store or `.patches/` when the user explicitly asks for materialized patch files. The default runtime should keep proposals as records and comments, not direct workspace edits.

中文：提案产物应存放在运行时代码路径之外，例如本地 proposal store（提案存储）或在用户明确要求生成补丁文件时放入 `.patches/`。默认运行时应把提案保留为记录和 comment，而不是直接编辑工作区。

```ts
export type ReviewerDecisionState =
  | "pending_review"
  | "needs_revision"
  | "accepted_for_pr"
  | "rejected"
  | "superseded"
  | "expired"
  | "merged_by_human"
  | "rolled_back_by_human";

export interface PatchProposal {
  readonly proposalId: string;
  readonly patternId: string;
  readonly diagnosticIds: readonly string[];
  readonly candidateId: string;
  readonly comparisonId: string;
  readonly target:
    | "prompt_profile"
    | "skill_draft"
    | "skill_update"
    | "tool_policy"
    | "context_policy"
    | "provider_route"
    | "safety_policy"
    | "runtime_scaffold"
    | "documentation";
  readonly generatedDiffRef: string;
  readonly generatedDiffHash: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly writeAuthority: {
    readonly required: true;
    readonly origin: "agent" | "idle";
    readonly expectedDecision: "confirm";
  };
  readonly evidenceRefs: readonly string[];
  readonly rollbackInstructions: string;
  readonly reviewerDecision: ReviewerDecisionState;
  readonly reviewerCommentRefs: readonly string[];
}
```

English: Any proposal that changes prompts, skills, policies, or runtime scaffold should default to `riskLevel:"critical"` until the safety team explicitly downgrades a class of changes. This conservative default prevents silent drift from being normalized as a low-risk convenience.

中文：任何会修改提示词、技能、策略或运行时脚手架的提案，都应默认 `riskLevel:"critical"`，除非安全组件明确把某类变更降级。这个保守默认值可以防止 silent drift（用户无感行为漂移）被合理化为低风险便利功能。

## ReviewerDecision（审核状态）

English: Reviewer decisions are first-class data, not free-form notes only. A rejected proposal should teach the next analyzer run why the idea was unsafe, weakly evidenced, too broad, already covered, or outside current priorities.

中文：Reviewer decision（审核状态）是一等数据，不只是自由文本备注。被拒绝的提案应告诉下一次分析器：该想法为什么不安全、证据不足、范围过大、已被覆盖，或不符合当前优先级。

English: The reviewer state machine should be append-only. Transitions should preserve who made the decision, when it happened, which evidence was reviewed, and whether a follow-up PR or Linear comment exists.

中文：审核状态机也应 append-only（只追加）。状态迁移应保存决策者、决策时间、审核过的证据，以及是否存在后续 PR 或 Linear comment。

```ts
export interface ReviewerDecisionEvent {
  readonly decisionEventId: string;
  readonly proposalId: string;
  readonly from: ReviewerDecisionState;
  readonly to: ReviewerDecisionState;
  readonly decidedBy: "human" | "main_agent" | "subagent";
  readonly decidedAt: string;
  readonly reason: string;
  readonly reviewedEvidenceRefs: readonly string[];
  readonly externalRef?: string;
}
```

English: Only humans should move a proposal to `accepted_for_pr`, `merged_by_human`, or `rolled_back_by_human`. Agents may mark `needs_revision`, `superseded`, or `expired` when evidence changes, but they should not claim human approval.

中文：只有人类可以把提案迁移到 `accepted_for_pr`、`merged_by_human` 或 `rolled_back_by_human`。Agent 可以在证据变化时标记 `needs_revision`、`superseded` 或 `expired`，但不能声称已经获得人工批准。

## 安全边界 / Safety Boundaries

English: The strongest invariant is: Self-Evolution may generate a diff, but it may not apply that diff. The runtime must never call file-write, skill-write, package-update, provider-config-update, or scaffold-patch tools from inside the optimizer path.

中文：最强不变式是：Self-Evolution 可以生成 diff，但不能应用 diff。运行时绝不能在优化器路径内部调用文件写入、技能写入、依赖更新、供应商配置更新或脚手架补丁工具。

English: If a future `scaffold_patch` tool exists, it must receive a `PatchProposal` id, a `WriteAuthority` decision, and a human review reference. It must fail closed when any evidence hash, dataset hash, or reviewer decision is missing.

中文：如果未来存在 `scaffold_patch` 工具，它必须接收 `PatchProposal` id、`WriteAuthority` 决策和人工审核引用。当任何证据哈希、数据集哈希或审核状态缺失时，它必须 fail closed（失败即关闭）。

English: Skill changes must route through `QUI-67` and the Skills runtime. Self-Evolution may produce a `skill_draft`, but `skill_manage` and the skill validation gates remain the only path to persisted `SKILL.md` files.

中文：技能变更必须经过 `QUI-67` 和 Skills runtime。Self-Evolution 可以产出 `skill_draft`（技能草稿），但 `skill_manage` 和技能校验门禁仍然是持久化 `SKILL.md` 文件的唯一路径。

## 最小实现切片 / Minimum Implementation Slices

English: Slice 1 is event capture: add `TrajectoryStore` with append-only events, sanitized export, retention metadata, and a small fixture（固定测试样例，用来复现特定输入、输出和期望结果） that records one failed run and one successful run.

中文：切片 1 是事件采集：增加 `TrajectoryStore`，包含只追加事件、脱敏导出、保留策略元数据，以及一个记录一次失败运行和一次成功运行的小型 fixture（固定测试样例，用来复现特定输入、输出和期望结果）。

English: Slice 2 is failure diagnostics: add deterministic failure rules, a typed `FailureDiagnostic`, and a pattern aggregator that requires evidence before proposing changes.

中文：切片 2 是失败诊断：增加确定性失败规则、类型化 `FailureDiagnostic`，以及要求证据后才提议变更的模式聚合器。

English: Slice 3 is local evaluation: add `TrajectoryDatasetBuilder` and `EvalComparator` using a small local dataset. This should prove before/after comparison without connecting public benchmark suites.

中文：切片 3 是本地评测：增加 `TrajectoryDatasetBuilder` 与 `EvalComparator`，使用小型本地数据集。它应证明优化前后对比能力，而不接入公共 benchmark 套件。

English: Slice 4 is offline optimization: add one cheap `static_metaprompt` optimizer first, then add DSPy or GEPA adapters behind the same interface only after the artifact schema is stable.

中文：切片 4 是离线优化：先增加一个便宜的 `static_metaprompt` 优化器，等产物结构稳定后，再在同一接口后增加 DSPy 或 GEPA 适配器。

English: Slice 5 is proposal review: add `ProposalStore`, `PatchProposal`, `ReviewerDecisionEvent`, Linear comment references, and refusal to apply any proposal automatically.

中文：切片 5 是提案审核：增加 `ProposalStore`、`PatchProposal`、`ReviewerDecisionEvent`、Linear comment 引用，并拒绝自动应用任何提案。

## 验收标准 / Acceptance Criteria

English: A `QUI-68` implementation passes when one controlled failure produces a trajectory, a diagnostic record, a frozen local dataset, an optimizer candidate, an evaluation comparison, and a patch proposal with `pending_review` state. The proposal must include source trajectories, failure category, generated diff, before/after evaluation, risk level, rollback instructions, and reviewer state.

中文：当一个受控失败能产出运行轨迹、诊断记录、冻结本地数据集、优化候选、评测对比，以及状态为 `pending_review` 的补丁提案时，`QUI-68` 实现才算通过。该提案必须包含来源轨迹、失败类别、生成 diff、优化前后评测、风险等级、回滚说明和审核状态。

English: The same run must prove that no runtime-affecting write was applied. The verification should assert that optimizer workers cannot write to `packages/`, `providers/`, `docs/`, skill roots, or provider configuration, and that every proposal-capable path records the Linear issue id.

中文：同一次运行还必须证明没有应用任何影响运行时行为的写入。验证应断言优化 worker 不能写入 `packages/`、`providers/`、`docs/`、skill roots（技能根目录）或供应商配置，并且每条可生成提案的路径都记录 Linear issue id。

English: The first implementation should include fixtures for at least five failure categories: context gap, tool execution error, skill trigger miss, verification gap, and provider routing or cost error. These categories map directly to existing component work and can produce useful proposals without expanding scope.

中文：第一版实现应至少包含五类失败夹具：上下文缺口、工具执行错误、技能触发漏判、验证缺失，以及供应商路由或成本错误。这些类别能直接映射到既有组件工作，并在不扩大范围的情况下产生有用提案。

## Linear 映射 / Linear Mapping

| Issue | Ownership |
|---|---|
| `QUI-68` | Owns this runtime implementation plan and the first proposal-only loop: `TrajectoryStore`, `FailureAnalyzer`, offline optimizer, eval comparison, generated patch proposal, and reviewer decision state. |
| `QUI-58` | Owns the frontier absorption decision and the architectural boundary that generation is allowed but automatic runtime application is not allowed. |
| `QUI-12` | Owns the larger Iter F trajectory-to-patch self-evolution loop after `QUI-68` proves the first runtime slice. |
| `QUI-67` | Owns skill manifest, registry, eval runner, provenance, and `skill_manage` gates used by Self-Evolution skill drafts. |
| `QUI-74` | Owns shared route, cache, cost, latency, and quality metrics reused by Self-Evolution evaluation comparisons. |

| Issue | 权属 |
|---|---|
| `QUI-68` | 负责本运行时实现规划和第一版只提案闭环：`TrajectoryStore`、`FailureAnalyzer`、离线优化器、评测对比、生成补丁提案和审核状态。 |
| `QUI-58` | 负责前沿吸收决策，以及“允许生成、不允许自动应用到运行时”的架构边界。 |
| `QUI-12` | 在 `QUI-68` 证明第一版运行时切片后，承接更大的 Iter F trajectory-to-patch（从轨迹到补丁）自进化闭环。 |
| `QUI-67` | 负责技能 manifest（清单）、registry（注册表）、eval runner（评测运行器）、provenance（来源记录）和 Self-Evolution 技能草稿所需的 `skill_manage` 门禁。 |
| `QUI-74` | 负责 Self-Evolution 评测对比复用的路由、缓存、成本、延迟和质量指标。 |

## 不做事项 / Non-Goals

English: Do not implement public benchmark execution as part of `QUI-68`. Public benchmarks remain useful later, but this task is about strengthening the Self-Evolution component's own runtime contracts first.

中文：不要把公共 benchmark 执行纳入 `QUI-68`。公共基准后续仍然有用，但本任务是先强化 Self-Evolution 组件自身的运行时契约。

English: Do not create new Linear issues for every slice in this plan. The workspace is on Linear's free plan with a 250-issue cap, so implementation notes, review logs, and subagent progress should reuse `QUI-68` comments unless a separate blocker needs independent ownership.

中文：不要为本文每个切片都新建 Linear issue。当前 workspace 使用 Linear 免费版，最多 250 个 issue，因此实现记录、review 日志和 subagent 进展应复用 `QUI-68` comment，除非出现需要独立负责人的 blocker（阻塞项）。

English: Do not let an optimizer choose its own model, provider, or budget silently. Optimizer model calls must go through the same provider routing, cost, cache, and telemetry vocabulary as `QUI-74`.

中文：不要允许优化器静默选择自己的模型、供应商或预算。优化器模型调用必须使用与 `QUI-74` 相同的供应商路由、成本、缓存和遥测词汇。

English: Do not treat LLM-as-judge output as truth. It may help triage failures, but deterministic checks, exact evidence references, reviewer decisions, and rollback instructions are required before a proposal can be trusted.

中文：不要把 LLM-as-judge（用另一个大语言模型按规则打分或判断）输出当成真值。它可以帮助分诊失败，但在信任提案前，必须具备确定性检查、精确证据引用、审核状态和回滚说明。
