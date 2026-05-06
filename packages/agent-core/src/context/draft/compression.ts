import { createHash } from "node:crypto";
import type {
	ContextCompressionDecisionTrace,
	ContextCompressionScore,
	ContextCompressionTrace,
	ContextSource,
	ContextTrustTier,
	PlacementRegion,
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
const TRUNCATION_MARKER_TOKEN_COST = Math.max(
	1,
	Math.ceil(TRUNCATION_MARKER.length / APPROX_CHARS_PER_TOKEN),
);
const EXTERNAL_AUTHORITY_CEILING = 0.45;
const PROTECTED_AUTHORITY_THRESHOLD = 0.95;

interface CompressionCandidate {
	readonly source: ContextSource;
	readonly index: number;
	readonly sourceId: string;
	readonly tokenCost: number;
	readonly tokenCostEstimated: boolean;
	readonly score: ContextCompressionScore;
	readonly protectedRetain: boolean;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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

function sourceContentHash(source: ContextSource): string {
	if (source.contentHash != null && source.contentHash.length > 0) {
		return source.contentHash;
	}

	const metadataHash = source.metadata.contentHash;
	if (typeof metadataHash === "string" && metadataHash.length > 0) {
		return metadataHash;
	}

	return sha256(source.content.trim());
}

function stableSourceIds(sources: readonly ContextSource[]): readonly string[] {
	const rawIds = sources.map(sourceId);
	const reservedIds = new Set(rawIds);
	const emitted = new Set<string>();

	return rawIds.map((id) => {
		if (!emitted.has(id)) {
			emitted.add(id);
			return id;
		}

		let suffix = 1;
		let candidate = `${id}#${suffix}`;
		while (emitted.has(candidate) || reservedIds.has(candidate)) {
			suffix += 1;
			candidate = `${id}#${suffix}`;
		}
		emitted.add(candidate);

		return candidate;
	});
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
	const trustTier = inferTrustTier(source);
	const tierAuthority = (() => {
		switch (trustTier) {
			case "system":
				return 1;
			case "workspace":
				return 0.85;
			case "memory":
				return 0.75;
			case "external":
				return EXTERNAL_AUTHORITY_CEILING;
			case "untrusted":
				return 0.2;
		}
	})();
	const claimedAuthority = source.sourceAuthority ?? tierAuthority;

	if (source.isExternal) {
		return Math.min(claimedAuthority, EXTERNAL_AUTHORITY_CEILING);
	}

	return claimedAuthority;
}

function inferPlacementRegion(source: ContextSource): PlacementRegion {
	if (source.isExternal) {
		return source.placementHint === "excluded" ? "excluded" : "middle";
	}

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

function placementPriority(region: PlacementRegion): number {
	switch (region) {
		case "front":
			return 1;
		case "near_user_turn":
			return 0.8;
		case "middle":
			return 0.5;
		case "excluded":
			return 0;
	}
}

function isAuthorityProtected(source: ContextSource): boolean {
	const trustTier = inferTrustTier(source);
	const trustedLocalSource = !source.isExternal;

	return (
		(trustedLocalSource && trustTier === "system") ||
		(source.sourceType === "mcp-instructions" &&
			trustedLocalSource &&
			trustTier !== "external" &&
			trustTier !== "untrusted") ||
		((trustTier === "workspace" || trustTier === "memory") &&
			trustedLocalSource &&
			inferAuthority(source) >= PROTECTED_AUTHORITY_THRESHOLD)
	);
}

function scoreSource(
	source: ContextSource,
	tokenCost: number,
	tokenCostEstimated: boolean,
	maxTokenCost: number,
): ContextCompressionScore {
	const relevance = clamp01(source.relevanceScore);
	const authority = clamp01(inferAuthority(source));
	const placement = placementPriority(inferPlacementRegion(source));
	const protectedRetain = isAuthorityProtected(source);
	const normalizedCost =
		maxTokenCost <= 0 ? 0 : Math.min(1, tokenCost / maxTokenCost);
	const tokenEfficiency = 1 - normalizedCost;
	const finalScore =
		relevance * 0.55 +
		authority * 0.25 +
		placement * 0.1 +
		tokenEfficiency * 0.1;

	return {
		relevance,
		authority,
		placementPriority: placement,
		tokenCost,
		tokenCostEstimated,
		tokenEfficiency,
		protectedRetain,
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
	reason: "within_budget" | "estimated_token_cost" | "protected_authority",
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
			reason === "protected_authority"
				? "Kept because system/tool authority or placement makes this source non-droppable even under tight context budgets."
				: reason === "estimated_token_cost"
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
				`contentHash=${sourceContentHash(candidate.source)}`,
				`tokens=${candidate.tokenCost}`,
				`estimated=${candidate.tokenCostEstimated}`,
				`relevance=${candidate.score.relevance}`,
				`authority=${candidate.score.authority}`,
				`placement=${candidate.score.placementPriority}`,
				`protected=${candidate.protectedRetain}`,
				`final=${candidate.score.finalScore}`,
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
	const stableIds = stableSourceIds(sources);
	const tokenCosts = normalizedTokenCosts.map((entry) => entry.tokenCost);
	const maxTokenCost = Math.max(0, ...tokenCosts);
	const candidates = sources.map((source, index) => {
		const tokenCost = normalizedTokenCosts[index]?.tokenCost ?? 0;
		const tokenCostEstimated = normalizedTokenCosts[index]?.estimated ?? true;
		const score = scoreSource(
			source,
			tokenCost,
			tokenCostEstimated,
			maxTokenCost,
		);

		return {
			source,
			index,
			sourceId: stableIds[index] ?? sourceId(source, index),
			tokenCost,
			tokenCostEstimated,
			score,
			protectedRetain: score.protectedRetain,
		};
	});
	const determinismKey = determinismKeyFor(candidates, {
		budgetTokens,
		minTruncatedTokens,
		minTruncateRelevanceScore,
		policyVersion,
	});
	const orderedCandidates = candidates.toSorted((left, right) => {
		if (left.protectedRetain !== right.protectedRetain) {
			return left.protectedRetain ? -1 : 1;
		}

		if (right.score.authority !== left.score.authority) {
			return right.score.authority - left.score.authority;
		}

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

		if (candidate.protectedRetain || candidate.tokenCost <= remainingTokens) {
			compressedSources.push({
				...candidate.source,
				sourceId: candidate.sourceId,
				tokenCount: candidate.tokenCost,
			});
			usedTokens += candidate.tokenCost;
			decisions.push(
				keepDecision(
					candidate,
					candidate.protectedRetain && candidate.tokenCost > remainingTokens
						? "protected_authority"
						: candidate.tokenCostEstimated
							? "estimated_token_cost"
							: "within_budget",
				),
			);
			continue;
		}

		if (
			remainingTokens >= minTruncatedTokens + TRUNCATION_MARKER_TOKEN_COST &&
			candidate.score.relevance >= minTruncateRelevanceScore
		) {
			compressedSources.push(
				truncateSource(
					{ ...candidate.source, sourceId: candidate.sourceId },
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
				strategy:
					"protected_authority_desc_final_score_desc_token_asc_timestamp_desc_input_order",
				orderedSourceIds: orderedCandidates.map(
					(candidate) => candidate.sourceId,
				),
			},
			compressionPolicyVersion: policyVersion,
			determinismKey,
		},
	};
}
