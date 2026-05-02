import type {
	ContextSelectionRejectReason,
	ContextSelectionScore,
	ContextSelectionTrace,
	ContextSource,
	ContextTrustTier,
	MemoryPoisoningStatus,
	PlacementRegion,
	RejectedContextSourceTrace,
	SelectedContextSourceTrace,
} from "./source-types.js";

export interface ContextSelectionOptions {
	readonly taskIntent: string;
	readonly budgetTokens: number;
	readonly enforceBudgetGate?: boolean;
	readonly runId?: string;
	readonly promptBuildId?: string;
	readonly minRelevanceScore?: number;
	readonly minFreshnessScore?: number;
	readonly policyVersion?: string;
	readonly traceId?: string;
}

export interface ContextSelectionResult {
	readonly sources: readonly ContextSource[];
	readonly trace: ContextSelectionTrace;
}

const DEFAULT_MIN_RELEVANCE_SCORE = 0.15;
const DEFAULT_MIN_FRESHNESS_SCORE = 0.05;
const DEFAULT_POLICY_VERSION = "context-selection-v1";

function clamp01(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.min(1, Math.max(0, value));
}

function sourceId(source: ContextSource, index: number): string {
	return source.sourceId ?? `${source.sourceType}:${source.timestamp}:${index}`;
}

function inferTrustTier(source: ContextSource): ContextTrustTier {
	if (source.trustTier != null) {
		return source.trustTier;
	}

	if (source.sourceType === "memory") {
		return "memory";
	}

	return source.isExternal ? "external" : "workspace";
}

function inferAuthority(source: ContextSource): number {
	if (source.sourceAuthority != null) {
		return source.sourceAuthority;
	}

	switch (inferTrustTier(source)) {
		case "system":
			return 1;
		case "workspace":
			return 0.85;
		case "memory":
			return 0.75;
		case "external":
			return 0.45;
		case "untrusted":
			return 0.2;
	}
}

function inferPoisoningStatus(source: ContextSource): MemoryPoisoningStatus {
	if (source.poisoningStatus != null) {
		return source.poisoningStatus;
	}

	const metadataStatus = source.metadata.poisoningStatus;
	if (
		metadataStatus === "clean" ||
		metadataStatus === "suspected" ||
		metadataStatus === "poisoned" ||
		metadataStatus === "unknown"
	) {
		return metadataStatus;
	}

	return "clean";
}

function inferPlacementRegion(source: ContextSource): PlacementRegion {
	if (source.placementHint != null) {
		return source.placementHint;
	}

	switch (source.sourceType) {
		case "mcp-instructions":
			return "front";
		case "session":
		case "tool":
			return "near_user_turn";
		default:
			return "middle";
	}
}

function scoreSource(source: ContextSource): ContextSelectionScore {
	const relevance = clamp01(source.relevanceScore);
	const freshness = clamp01(source.freshnessScore ?? 1);
	const authority = clamp01(inferAuthority(source));
	const contradictionSafety = 1 - clamp01(source.contradictionRisk ?? 0);
	const finalScore =
		relevance * 0.6 +
		freshness * 0.15 +
		authority * 0.2 +
		contradictionSafety * 0.05;

	return {
		relevance,
		freshness,
		authority,
		contradictionSafety,
		finalScore,
	};
}

function preBudgetRejection(
	source: ContextSource,
	score: ContextSelectionScore,
	options: Required<
		Pick<ContextSelectionOptions, "minRelevanceScore" | "minFreshnessScore">
	>,
): ContextSelectionRejectReason | null {
	if (source.content.trim().length === 0) {
		return "below_relevance_threshold";
	}

	if (inferPoisoningStatus(source) === "poisoned") {
		return "poisoning_risk";
	}

	if (score.relevance < options.minRelevanceScore) {
		return "below_relevance_threshold";
	}

	if (score.freshness < options.minFreshnessScore) {
		return "stale_source";
	}

	if (score.contradictionSafety < 0.35) {
		return "contradiction_unresolved";
	}

	return null;
}

function rejectExplanation(reason: ContextSelectionRejectReason): string {
	switch (reason) {
		case "below_relevance_threshold":
			return "Rejected because the source relevance score is below the selection threshold.";
		case "stale_source":
			return "Rejected because the source freshness score is below the freshness threshold.";
		case "poisoning_risk":
			return "Rejected because the source is marked as poisoned.";
		case "contradiction_unresolved":
			return "Rejected because unresolved contradiction risk is too high.";
		case "budget_exhausted":
			return "Rejected because adding this source would exceed the available source budget.";
		case "permission_denied":
			return "Rejected because the current run does not have permission to use this source.";
		case "lower_authority_duplicate":
			return "Rejected because a higher-authority duplicate source was preferred.";
		case "cache_boundary_violation":
			return "Rejected because this source cannot cross the selected cache boundary.";
	}
}

export function selectContextSources(
	sources: readonly ContextSource[],
	options: ContextSelectionOptions,
): ContextSelectionResult {
	const selectionOptions = {
		minRelevanceScore: options.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE_SCORE,
		minFreshnessScore: options.minFreshnessScore ?? DEFAULT_MIN_FRESHNESS_SCORE,
	};
	const enforceBudgetGate = options.enforceBudgetGate ?? true;
	const candidates = sources.map((source, index) => ({
		source,
		index,
		sourceId: sourceId(source, index),
		score: scoreSource(source),
		placementRegion: inferPlacementRegion(source),
	}));
	const determinismKey = candidates
		.map((candidate) => candidate.sourceId)
		.join("|");
	const orderedCandidates = candidates.toSorted((left, right) => {
		if (right.score.finalScore !== left.score.finalScore) {
			return right.score.finalScore - left.score.finalScore;
		}

		return (
			right.source.timestamp - left.source.timestamp || left.index - right.index
		);
	});
	const scoreBreakdown = Object.fromEntries(
		candidates.map((candidate) => [candidate.sourceId, candidate.score]),
	);
	const placementRegion = Object.fromEntries(
		candidates.map((candidate) => [
			candidate.sourceId,
			candidate.placementRegion,
		]),
	);
	const selected: ContextSource[] = [];
	const selectedTrace: SelectedContextSourceTrace[] = [];
	const rejectedTrace: RejectedContextSourceTrace[] = [];
	let usedTokens = 0;

	for (const candidate of orderedCandidates) {
		const rejection = preBudgetRejection(
			candidate.source,
			candidate.score,
			selectionOptions,
		);
		if (rejection != null) {
			rejectedTrace.push({
				sourceId: candidate.sourceId,
				reason: rejection,
				score: candidate.score,
				explanation: rejectExplanation(rejection),
			});
			continue;
		}

		if (
			enforceBudgetGate &&
			usedTokens + candidate.source.tokenCount > options.budgetTokens
		) {
			rejectedTrace.push({
				sourceId: candidate.sourceId,
				reason: "budget_exhausted",
				score: candidate.score,
				explanation: rejectExplanation("budget_exhausted"),
			});
			continue;
		}

		if (enforceBudgetGate) {
			usedTokens += candidate.source.tokenCount;
		}
		selected.push(candidate.source);
		selectedTrace.push({
			sourceId: candidate.sourceId,
			placementRegion: candidate.placementRegion,
			score: candidate.score,
			explanation: enforceBudgetGate
				? "Selected because the source passed relevance, freshness, trust, contradiction, and budget gates."
				: "Selected because the source passed relevance, freshness, trust, and contradiction gates before compression budget enforcement.",
		});
	}

	return {
		sources: selected,
		trace: {
			traceId: options.traceId ?? `selection:${determinismKey || "empty"}`,
			runId: options.runId ?? "unbound-run",
			promptBuildId:
				options.promptBuildId ?? `prompt:${determinismKey || "empty"}`,
			taskIntent: options.taskIntent,
			budgetTokens: options.budgetTokens,
			candidateSourceIds: candidates.map((candidate) => candidate.sourceId),
			selectedSources: selectedTrace,
			rejectedSources: rejectedTrace,
			scoreBreakdown,
			orderingDecision: {
				strategy: "score_desc_timestamp_desc_input_order",
				orderedSourceIds: orderedCandidates.map(
					(candidate) => candidate.sourceId,
				),
			},
			placementRegion,
			selectionPolicyVersion: options.policyVersion ?? DEFAULT_POLICY_VERSION,
			determinismKey,
		},
	};
}
