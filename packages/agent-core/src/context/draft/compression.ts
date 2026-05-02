import type {
	ContextCompressionDecisionTrace,
	ContextCompressionScore,
	ContextCompressionTrace,
	ContextSource,
} from "./source-types.js";

export interface ContextCompressionOptions {
	readonly budgetTokens: number;
	readonly traceId?: string;
	readonly minTruncatedTokens?: number;
	readonly minTruncateRelevanceScore?: number;
	readonly policyVersion?: string;
}

export interface ContextCompressionResult {
	readonly sources: readonly ContextSource[];
	readonly trace: ContextCompressionTrace;
}

const DEFAULT_MIN_TRUNCATED_TOKENS = 1;
const DEFAULT_MIN_TRUNCATE_RELEVANCE_SCORE = 0.15;
const DEFAULT_POLICY_VERSION = "context-compression-v1";
const APPROX_CHARS_PER_TOKEN = 4;
const TRUNCATION_MARKER = "[TRUNCATED]";
const TRUNCATION_MARKER_TOKEN_COST = 1;

interface CompressionCandidate {
	readonly source: ContextSource;
	readonly index: number;
	readonly sourceId: string;
	readonly tokenCost: number;
	readonly tokenCostEstimated: boolean;
	readonly score: ContextCompressionScore;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.min(1, Math.max(0, value));
}

function estimateTokenCount(content: string): number {
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		return 0;
	}

	return Math.max(1, Math.ceil(trimmed.length / APPROX_CHARS_PER_TOKEN));
}

function normalizeTokenCount(source: ContextSource): {
	readonly tokenCost: number;
	readonly estimated: boolean;
} {
	if (Number.isFinite(source.tokenCount) && source.tokenCount > 0) {
		return {
			tokenCost: Math.ceil(source.tokenCount),
			estimated: false,
		};
	}

	return {
		tokenCost: estimateTokenCount(source.content),
		estimated: true,
	};
}

function normalizeBudget(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}

	return Math.floor(value);
}

function sourceId(source: ContextSource, index: number): string {
	return source.sourceId ?? `${source.sourceType}:${source.timestamp}:${index}`;
}

function scoreSource(
	source: ContextSource,
	tokenCost: number,
	tokenCostEstimated: boolean,
	maxTokenCost: number,
): ContextCompressionScore {
	const relevance = clamp01(source.relevanceScore);
	const normalizedCost =
		maxTokenCost <= 0 ? 0 : Math.min(1, tokenCost / maxTokenCost);
	const tokenEfficiency = 1 - normalizedCost;
	const finalScore = relevance * 0.8 + tokenEfficiency * 0.2;

	return {
		relevance,
		tokenCost,
		tokenCostEstimated,
		tokenEfficiency,
		finalScore,
	};
}

function truncateContent(
	content: string,
	originalTokens: number,
	outputTokens: number,
): string {
	if (outputTokens <= 0 || content.length === 0) {
		return "";
	}
	if (outputTokens <= TRUNCATION_MARKER_TOKEN_COST) {
		return TRUNCATION_MARKER;
	}

	const contentTokens = outputTokens - TRUNCATION_MARKER_TOKEN_COST;
	const retainedRatio =
		originalTokens <= 0 ? 1 : Math.min(1, contentTokens / originalTokens);
	const retainedChars = Math.max(1, Math.floor(content.length * retainedRatio));
	const retainedContent = content.slice(0, retainedChars).trimEnd();

	return `${retainedContent}\n${TRUNCATION_MARKER}`;
}

function keepDecision(
	candidate: CompressionCandidate,
	reason: "within_budget" | "estimated_token_cost",
): ContextCompressionDecisionTrace {
	return {
		sourceId: candidate.sourceId,
		decision: "keep",
		reason,
		originalTokens: candidate.tokenCost,
		outputTokens: candidate.tokenCost,
		tokenCostEstimated: candidate.tokenCostEstimated,
		score: candidate.score,
		explanation:
			reason === "estimated_token_cost"
				? "Kept because the source fit after applying a conservative token estimate."
				: "Kept because the full source fits inside the remaining context source budget.",
	};
}

function truncateDecision(
	candidate: CompressionCandidate,
	outputTokens: number,
): ContextCompressionDecisionTrace {
	return {
		sourceId: candidate.sourceId,
		decision: "truncate",
		reason: "budget_truncated",
		originalTokens: candidate.tokenCost,
		outputTokens,
		tokenCostEstimated: candidate.tokenCostEstimated,
		score: candidate.score,
		explanation:
			"Truncated because the source passed relevance gates but only part of it fits inside the remaining context source budget; outputTokens includes the truncation marker.",
	};
}

function dropDecision(
	candidate: CompressionCandidate,
	reason: "budget_exhausted" | "below_truncation_threshold",
): ContextCompressionDecisionTrace {
	return {
		sourceId: candidate.sourceId,
		decision: "drop",
		reason,
		originalTokens: candidate.tokenCost,
		outputTokens: 0,
		tokenCostEstimated: candidate.tokenCostEstimated,
		score: candidate.score,
		explanation:
			reason === "below_truncation_threshold"
				? "Dropped because the source does not meet the minimum relevance or token threshold for partial retention."
				: "Dropped because no context source budget remains.",
	};
}

function truncateSource(
	source: ContextSource,
	originalTokens: number,
	outputTokens: number,
	policyVersion: string,
): ContextSource {
	return {
		...source,
		content: truncateContent(source.content, originalTokens, outputTokens),
		tokenCount: outputTokens,
		metadata: {
			...source.metadata,
			compression: {
				policyVersion,
				originalTokenCount: originalTokens,
				outputTokenCount: outputTokens,
				truncationMarkerTokenCount: TRUNCATION_MARKER_TOKEN_COST,
			},
		},
	};
}

function determinismKeyFor(
	candidates: readonly CompressionCandidate[],
	options: {
		readonly budgetTokens: number;
		readonly minTruncatedTokens: number;
		readonly minTruncateRelevanceScore: number;
		readonly policyVersion: string;
	},
): string {
	return [
		`policy=${options.policyVersion}`,
		`budget=${options.budgetTokens}`,
		`minTruncated=${options.minTruncatedTokens}`,
		`minRelevance=${options.minTruncateRelevanceScore}`,
		...candidates.map((candidate) =>
			[
				candidate.sourceId,
				`tokens=${candidate.tokenCost}`,
				`estimated=${candidate.tokenCostEstimated}`,
				`relevance=${candidate.score.relevance}`,
				`timestamp=${candidate.source.timestamp}`,
				`index=${candidate.index}`,
			].join(":"),
		),
	].join("|");
}

export function compressContextSources(
	sources: readonly ContextSource[],
	options: ContextCompressionOptions,
): ContextCompressionResult {
	const budgetTokens = normalizeBudget(options.budgetTokens);
	const minTruncatedTokens = normalizeBudget(
		options.minTruncatedTokens ?? DEFAULT_MIN_TRUNCATED_TOKENS,
	);
	const minTruncateRelevanceScore =
		options.minTruncateRelevanceScore ?? DEFAULT_MIN_TRUNCATE_RELEVANCE_SCORE;
	const policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
	const normalizedTokenCosts = sources.map((source) =>
		normalizeTokenCount(source),
	);
	const tokenCosts = normalizedTokenCosts.map((entry) => entry.tokenCost);
	const maxTokenCost = Math.max(0, ...tokenCosts);
	const candidates = sources.map((source, index) => {
		const tokenCost = normalizedTokenCosts[index]?.tokenCost ?? 0;
		const tokenCostEstimated = normalizedTokenCosts[index]?.estimated ?? true;

		return {
			source,
			index,
			sourceId: sourceId(source, index),
			tokenCost,
			tokenCostEstimated,
			score: scoreSource(source, tokenCost, tokenCostEstimated, maxTokenCost),
		};
	});
	const determinismKey = determinismKeyFor(candidates, {
		budgetTokens,
		minTruncatedTokens,
		minTruncateRelevanceScore,
		policyVersion,
	});
	const orderedCandidates = candidates.toSorted((left, right) => {
		if (right.score.finalScore !== left.score.finalScore) {
			return right.score.finalScore - left.score.finalScore;
		}

		return (
			left.tokenCost - right.tokenCost ||
			right.source.timestamp - left.source.timestamp ||
			left.index - right.index
		);
	});
	const scoreBreakdown = Object.fromEntries(
		candidates.map((candidate) => [candidate.sourceId, candidate.score]),
	);
	const compressedSources: ContextSource[] = [];
	const decisions: ContextCompressionDecisionTrace[] = [];
	let usedTokens = 0;

	for (const candidate of orderedCandidates) {
		const remainingTokens = Math.max(0, budgetTokens - usedTokens);

		if (candidate.tokenCost <= remainingTokens) {
			compressedSources.push({
				...candidate.source,
				tokenCount: candidate.tokenCost,
			});
			usedTokens += candidate.tokenCost;
			decisions.push(
				keepDecision(
					candidate,
					candidate.tokenCostEstimated
						? "estimated_token_cost"
						: "within_budget",
				),
			);
			continue;
		}

		if (
			remainingTokens >= minTruncatedTokens &&
			candidate.score.relevance >= minTruncateRelevanceScore
		) {
			compressedSources.push(
				truncateSource(
					candidate.source,
					candidate.tokenCost,
					remainingTokens,
					policyVersion,
				),
			);
			usedTokens += remainingTokens;
			decisions.push(truncateDecision(candidate, remainingTokens));
			continue;
		}

		decisions.push(
			dropDecision(
				candidate,
				remainingTokens === 0
					? "budget_exhausted"
					: "below_truncation_threshold",
			),
		);
	}

	return {
		sources: compressedSources,
		trace: {
			traceId: options.traceId ?? `compression:${determinismKey || "empty"}`,
			budgetTokens,
			usedTokens,
			candidateSourceIds: candidates.map((candidate) => candidate.sourceId),
			decisions,
			scoreBreakdown,
			orderingDecision: {
				strategy: "final_score_desc_token_asc_timestamp_desc_input_order",
				orderedSourceIds: orderedCandidates.map(
					(candidate) => candidate.sourceId,
				),
			},
			compressionPolicyVersion: policyVersion,
			determinismKey,
		},
	};
}
