export const SELF_EVOLUTION_SCHEMA_VERSION = 1 as const;
export const LOCAL_NOOP_OPTIMIZER_ID = "local-noop" as const;
export const PROMPT_REWRITE_OPTIMIZER_ID = "prompt-rewrite" as const;

/**
 * Identifier for a concrete OfflineOptimizer implementation. Free-form string
 * so new optimizers can register without expanding a closed enum.
 *
 * 离线优化器的实现标识。开放字符串，便于新增 optimizer 时无需扩展闭合枚举。
 */
export type OfflineOptimizerId = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };
export type JsonRecord = { readonly [key: string]: JsonValue };

export type TrajectoryOutcome = "success" | "failure" | "cancelled";
export type TrajectoryStepKind =
	| "model"
	| "tool"
	| "checkpoint"
	| "observation";

export interface TokenUsageSummary {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly budgetTokens?: number;
}

export interface TrajectoryStep {
	readonly index: number;
	readonly kind: TrajectoryStepKind;
	readonly label: string;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly input?: JsonValue;
	readonly output?: JsonValue;
	readonly error?: JsonValue;
	readonly evidenceRefs?: readonly string[];
	readonly metadata?: JsonRecord;
}

export interface TrajectoryFailure {
	readonly message: string;
	readonly category?: FailureCategory;
	readonly source?: string;
	readonly evidenceRefs?: readonly string[];
	readonly metadata?: JsonRecord;
}

export interface TrajectoryRecordInput {
	readonly schemaVersion?: typeof SELF_EVOLUTION_SCHEMA_VERSION;
	readonly runId: string;
	readonly taskRef?: string;
	readonly createdAt?: string;
	readonly outcome: TrajectoryOutcome;
	readonly steps: readonly TrajectoryStep[];
	readonly failures?: readonly TrajectoryFailure[];
	readonly tokenUsage?: TokenUsageSummary;
	readonly metadata?: JsonRecord;
}

export interface StoredTrajectoryRecord extends TrajectoryRecordInput {
	readonly schemaVersion: typeof SELF_EVOLUTION_SCHEMA_VERSION;
	readonly trajectoryRef: string;
	readonly contentHash: string;
	readonly createdAt: string;
}

export type FailureCategory =
	| "tool_error"
	| "schema_violation"
	| "budget_exhaustion"
	| "missing_evidence"
	| "unknown";

export type FailureConfidence = "high" | "medium" | "low";

export type NoProposalReasonCode =
	| "no_failure_detected"
	| "missing_evidence_requires_human_context"
	| "missing_task_ref_requires_linear_issue"
	| "budget_policy_requires_human_review"
	| "unknown_failure_not_actionable"
	| "insufficient_signal";

export interface NoProposalReason {
	readonly code: NoProposalReasonCode;
	readonly message: string;
	readonly evidenceRefs: readonly string[];
}

export interface FailureFinding {
	readonly category: FailureCategory;
	readonly confidence: FailureConfidence;
	readonly message: string;
	readonly evidenceRefs: readonly string[];
	readonly proposalAllowed: boolean;
	readonly noProposalReason?: NoProposalReason;
}

export interface FailureAnalysis {
	readonly schemaVersion: typeof SELF_EVOLUTION_SCHEMA_VERSION;
	readonly runId: string;
	readonly trajectoryRef: string;
	readonly findings: readonly FailureFinding[];
	readonly noProposalReasons: readonly NoProposalReason[];
	readonly shouldPropose: boolean;
}

export type CandidateArtifactKind = "markdown" | "json" | "patch";

export interface CandidateArtifact {
	readonly artifactId: string;
	readonly kind: CandidateArtifactKind;
	readonly title: string;
	readonly content: string;
	readonly contentHash: string;
	readonly sourceRefs: readonly string[];
}

export type ProposalRiskLevel = "low" | "medium" | "high" | "critical";

export interface ProposalRiskPreview {
	readonly level: ProposalRiskLevel;
	readonly reasons: readonly string[];
	readonly touchesRuntime: boolean;
	readonly requiresHumanReview: true;
}

export type GeneratedPatchProposalKind =
	| "regression_fixture_patch"
	| "scaffold_patch";
export type GeneratedPatchReviewState = "pending_human_review";
export type GeneratedPatchApplicationMode = "proposal_only";
export type GeneratedPatchDiffKind = "synthetic_unified_diff";
export type GeneratedPatchChangeKind = "add" | "modify" | "delete";
export type GeneratedPatchWriteOrigin = "agent" | "idle";

export interface GeneratedPatchWriteAuthorityPreview {
	readonly tool: "scaffold_patch";
	readonly riskLevel: "critical";
	readonly origin: GeneratedPatchWriteOrigin;
	readonly summary: string;
	readonly requiresConfirmation: true;
	readonly auditRequired: true;
}

export interface PatchProposalSafetyBoundary {
	readonly applicationMode: GeneratedPatchApplicationMode;
	readonly autoApplyAllowed: false;
	readonly requiresHumanReview: true;
	readonly allowedPathPrefixes: readonly string[];
	readonly forbiddenPathPatterns: readonly string[];
	readonly rationale: string;
}

export interface GeneratedPatchFileChange {
	readonly path: string;
	readonly changeKind: GeneratedPatchChangeKind;
	readonly diffKind: GeneratedPatchDiffKind;
	readonly summary: string;
	readonly unifiedDiff: string;
}

export type EvaluationMode = "static_estimate" | "measured" | "not_run";
export type EvaluationMetricDirection =
	| "increase_is_better"
	| "decrease_is_better"
	| "neutral";
export type EvaluationMetricValue = string | number | boolean;

export interface BeforeAfterEvaluationMetric {
	readonly name: string;
	readonly baselineValue: EvaluationMetricValue;
	readonly candidateValue: EvaluationMetricValue;
	readonly unit?: string;
	readonly direction: EvaluationMetricDirection;
	readonly evidenceRefs: readonly string[];
}

export interface BeforeAfterEvaluation {
	readonly evaluationId: string;
	readonly mode: EvaluationMode;
	readonly baselineLabel: string;
	readonly candidateLabel: string;
	readonly summary: string;
	readonly metrics: readonly BeforeAfterEvaluationMetric[];
	readonly regressionRisk: ProposalRiskLevel;
	readonly evidenceRefs: readonly string[];
	readonly requiresHumanReview: true;
}

export interface GeneratedPatchProposal {
	readonly patchProposalId: string;
	readonly proposalKind: GeneratedPatchProposalKind;
	readonly reviewState: GeneratedPatchReviewState;
	readonly title: string;
	readonly summary: string;
	readonly safetyBoundary: PatchProposalSafetyBoundary;
	readonly fileChanges: readonly GeneratedPatchFileChange[];
	readonly sourceRefs: readonly string[];
	readonly beforeAfterEvaluationId: string;
	readonly writeAuthorityPreview: GeneratedPatchWriteAuthorityPreview;
	readonly rollbackPlan: string;
}

export interface OptimizationProposalDraft {
	readonly title: string;
	readonly summary: string;
	readonly artifacts: readonly CandidateArtifact[];
	readonly evidenceHashes: readonly string[];
	readonly riskPreview: ProposalRiskPreview;
	readonly generatedPatchProposal?: GeneratedPatchProposal;
	readonly beforeAfterEvaluation?: BeforeAfterEvaluation;
	readonly metadata?: JsonRecord;
}

export interface OfflineOptimizerInput {
	readonly trajectories: readonly StoredTrajectoryRecord[];
	readonly analyses?: readonly FailureAnalysis[];
	readonly now?: () => Date;
	/**
	 * When true, the optimizer must build proposals deterministically without
	 * persisting them to a store. Used by callers that want to inspect the
	 * proposed candidates before deciding to write them.
	 *
	 * dryRun=true 表示 optimizer 必须确定性构造 proposal 而不写入 store，
	 * 调用方可以先检查候选 proposal 再决定是否写入。
	 */
	readonly dryRun?: boolean;
}

export type OfflineOptimizerMode = "artifact_only" | "prompt_rewrite";

export interface OfflineOptimizerResult {
	readonly schemaVersion: typeof SELF_EVOLUTION_SCHEMA_VERSION;
	readonly optimizerId: OfflineOptimizerId;
	readonly mode: OfflineOptimizerMode;
	readonly createdAt: string;
	readonly proposals: readonly OptimizationProposalDraft[];
	readonly noProposalReasons: readonly NoProposalReason[];
}

/**
 * Public contract every offline optimizer must implement. Concrete impls may
 * be sync or async; we expose `optimize` as a Promise so future optimizers can
 * call out to LLMs without changing the interface.
 *
 * 所有离线优化器必须实现的公共契约。具体实现可以同步或异步；optimize 返回
 * Promise，便于未来 optimizer 调用 LLM 而不修改接口。
 */
export interface OfflineOptimizer {
	readonly optimizerId: OfflineOptimizerId;
	optimize(input: OfflineOptimizerInput): Promise<OfflineOptimizerResult>;
}

export type ProposalStatus =
	| "pending_review"
	| "approved"
	| "rejected"
	| "superseded"
	| "applied";
export type ReviewedProposalStatus = Exclude<
	ProposalStatus,
	"pending_review" | "applied"
>;
export type AppliedProposalStatus = "applied";

export interface ProposalCreatedAtQueryRange {
	readonly from?: string;
	readonly to?: string;
}

export interface ProposalQueryFilters {
	readonly reviewState?: ProposalStatus | readonly ProposalStatus[];
	readonly createdAt?: ProposalCreatedAtQueryRange;
}

export interface ProposalReviewMetadata {
	readonly reviewer: string;
	readonly reason: string;
	readonly reviewedAt: string;
	readonly metadata?: JsonRecord;
}

export interface ProposalRecordInput extends OptimizationProposalDraft {
	readonly schemaVersion?: typeof SELF_EVOLUTION_SCHEMA_VERSION;
	readonly proposalId?: string;
	readonly createdAt?: string;
}

export interface StoredProposalRecord extends ProposalRecordInput {
	readonly schemaVersion: typeof SELF_EVOLUTION_SCHEMA_VERSION;
	readonly proposalId: string;
	readonly status: ProposalStatus;
	readonly review?: ProposalReviewMetadata;
	readonly createdAt: string;
	readonly contentHash: string;
}

export interface ProposalReviewQueueItem {
	readonly proposalId: string;
	readonly title: string;
	readonly createdAt: string;
}

export type ProposalReviewQueueNextActionKind =
	| "review_stale_pending"
	| "review_pending"
	| "record_approved_review"
	| "record_rejected_review"
	| "record_superseded_review"
	| "record_applied_review";

export type ProposalReviewQueueNextActionReasonCode =
	| "pending_review_stale"
	| "pending_review_waiting_for_human"
	| "approved_review_recorded"
	| "rejected_review_recorded"
	| "superseded_review_recorded"
	| "applied_review_recorded";

export interface ProposalReviewQueueNextAction {
	readonly kind: ProposalReviewQueueNextActionKind;
	readonly priority: number;
	readonly reasonCode: ProposalReviewQueueNextActionReasonCode;
	readonly reviewState: ProposalStatus;
	readonly proposalIds: readonly string[];
}

export type ProposalReviewQueueCounts = Readonly<
	Record<ProposalStatus, number>
>;

export type ProposalReviewQueueGroups = Readonly<
	Record<ProposalStatus, readonly ProposalReviewQueueItem[]>
>;

export interface ProposalReviewQueueViewOptions {
	readonly now?: string;
	readonly stalePendingAfterMs?: number;
}

export interface ProposalReviewQueueView {
	readonly totalCount: number;
	readonly counts: ProposalReviewQueueCounts;
	readonly byReviewState: ProposalReviewQueueGroups;
	readonly nextActions: readonly ProposalReviewQueueNextAction[];
}
