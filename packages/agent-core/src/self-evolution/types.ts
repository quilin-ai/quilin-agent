export const SELF_EVOLUTION_SCHEMA_VERSION = 1 as const;
export const LOCAL_NOOP_OPTIMIZER_ID = "local-noop" as const;

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
}

export interface OfflineOptimizerResult {
	readonly schemaVersion: typeof SELF_EVOLUTION_SCHEMA_VERSION;
	readonly optimizerId: typeof LOCAL_NOOP_OPTIMIZER_ID;
	readonly mode: "artifact_only";
	readonly createdAt: string;
	readonly proposals: readonly OptimizationProposalDraft[];
	readonly noProposalReasons: readonly NoProposalReason[];
}

export type ProposalStatus =
	| "pending_review"
	| "approved"
	| "rejected"
	| "superseded";
export type ReviewedProposalStatus = Exclude<ProposalStatus, "pending_review">;

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
	| "record_superseded_review";

export type ProposalReviewQueueNextActionReasonCode =
	| "pending_review_stale"
	| "pending_review_waiting_for_human"
	| "approved_review_recorded"
	| "rejected_review_recorded"
	| "superseded_review_recorded";

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
