export type ContextSourceType =
	| "memory"
	| "tool"
	| "session"
	| "temporal"
	| "environment"
	| "user-context-file"
	| "mcp-instructions";

export type ContextTrustTier =
	| "system"
	| "workspace"
	| "memory"
	| "external"
	| "untrusted";

export type CacheVolatility =
	| "stable"
	| "session_stable"
	| "turn_stable"
	| "volatile";

export type PlacementRegion =
	| "front"
	| "middle"
	| "near_user_turn"
	| "excluded";

export type MemoryPoisoningStatus =
	| "clean"
	| "suspected"
	| "poisoned"
	| "unknown";

export type ContextSelectionRejectReason =
	| "permission_denied"
	| "below_relevance_threshold"
	| "stale_source"
	| "lower_authority_duplicate"
	| "poisoning_risk"
	| "contradiction_unresolved"
	| "budget_exhausted"
	| "cache_boundary_violation";

export interface ContextSource {
	readonly sourceId?: string;
	readonly sourceType: ContextSourceType;
	readonly content: string;
	readonly tokenCount: number;
	readonly relevanceScore: number;
	readonly timestamp: number;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly isExternal: boolean;
	readonly trustTier?: ContextTrustTier;
	readonly freshnessScore?: number;
	readonly sourceAuthority?: number;
	readonly cacheVolatility?: CacheVolatility;
	readonly placementHint?: PlacementRegion;
	readonly poisoningStatus?: MemoryPoisoningStatus;
	readonly contradictionRisk?: number;
}

export interface BudgetPolicy {
	readonly taskType: string;
	readonly totalBudget: number;
	readonly systemRatio: number;
	readonly memoryRatio: number;
	readonly toolsRatio: number;
	readonly historyRatio: number;
	readonly outputReserve: number;
}

export interface ContextSelectionScore {
	readonly relevance: number;
	readonly freshness: number;
	readonly authority: number;
	readonly contradictionSafety: number;
	readonly finalScore: number;
}

export interface ContextOrderingDecision {
	readonly strategy: "score_desc_timestamp_desc_input_order";
	readonly orderedSourceIds: readonly string[];
}

export interface SelectedContextSourceTrace {
	readonly sourceId: string;
	readonly placementRegion: PlacementRegion;
	readonly score: ContextSelectionScore;
	readonly explanation: string;
}

export interface RejectedContextSourceTrace {
	readonly sourceId: string;
	readonly reason: ContextSelectionRejectReason;
	readonly score: ContextSelectionScore;
	readonly explanation: string;
}

export interface ContextSelectionTrace {
	readonly traceId: string;
	readonly runId: string;
	readonly promptBuildId: string;
	readonly taskIntent: string;
	readonly budgetTokens: number;
	readonly candidateSourceIds: readonly string[];
	readonly selectedSources: readonly SelectedContextSourceTrace[];
	readonly rejectedSources: readonly RejectedContextSourceTrace[];
	readonly scoreBreakdown: Readonly<Record<string, ContextSelectionScore>>;
	readonly orderingDecision: ContextOrderingDecision;
	readonly placementRegion: Readonly<Record<string, PlacementRegion>>;
	readonly selectionPolicyVersion: string;
	readonly determinismKey: string;
}

export type ContextCompressionDecisionKind = "keep" | "drop" | "truncate";

export type ContextCompressionReason =
	| "within_budget"
	| "estimated_token_cost"
	| "protected_authority"
	| "budget_truncated"
	| "budget_exhausted"
	| "below_truncation_threshold";

export interface ContextCompressionScore {
	readonly relevance: number;
	readonly authority: number;
	readonly placementPriority: number;
	readonly tokenCost: number;
	readonly tokenCostEstimated: boolean;
	readonly tokenEfficiency: number;
	readonly protectedRetain: boolean;
	readonly finalScore: number;
}

export interface ContextCompressionOrderingDecision {
	readonly strategy: "protected_authority_desc_final_score_desc_token_asc_timestamp_desc_input_order";
	readonly orderedSourceIds: readonly string[];
}

export interface ContextCompressionDecisionTrace {
	readonly sourceId: string;
	readonly decision: ContextCompressionDecisionKind;
	readonly reason: ContextCompressionReason;
	readonly originalTokens: number;
	readonly outputTokens: number;
	readonly tokenCostEstimated: boolean;
	readonly score: ContextCompressionScore;
	readonly explanation: string;
}

export interface ContextCompressionTrace {
	readonly traceId: string;
	readonly budgetTokens: number;
	readonly usedTokens: number;
	readonly candidateSourceIds: readonly string[];
	readonly decisions: readonly ContextCompressionDecisionTrace[];
	readonly scoreBreakdown: Readonly<Record<string, ContextCompressionScore>>;
	readonly orderingDecision: ContextCompressionOrderingDecision;
	readonly compressionPolicyVersion: string;
	readonly determinismKey: string;
}

export interface ContextSelectionCompressionDecisionLink {
	readonly sourceId: string;
	readonly compressionDecision: ContextCompressionDecisionKind;
	readonly compressionReason: ContextCompressionReason;
	readonly outputTokens: number;
}

export interface ContextSelectionCompressionTraceLink {
	readonly traceId: string;
	readonly selectionTraceId: string;
	readonly compressionTraceId: string;
	readonly selectedToCompression: readonly ContextSelectionCompressionDecisionLink[];
	readonly compressionCandidateSourceIds: readonly string[];
	readonly rejectedSourceIdsExcludedFromCompression: readonly string[];
	readonly missingCompressionDecisionSourceIds: readonly string[];
	readonly determinismKey: string;
}

export interface ContextTraceDecisionCounts {
	readonly selected: number;
	readonly rejected: number;
	readonly keep: number;
	readonly truncate: number;
	readonly drop: number;
}

export type ContextTraceSourceSelection = "selected" | "rejected";

export interface ContextTraceSourceSummary {
	readonly sourceId: string;
	readonly selection: ContextTraceSourceSelection;
	readonly rejectionReason?: ContextSelectionRejectReason;
	readonly compressionDecision?: ContextCompressionDecisionKind;
	readonly compressionReason?: ContextCompressionReason;
	readonly originalTokens?: number;
	readonly outputTokens: number;
}

export interface ContextTraceSummary {
	readonly traceId: string;
	readonly selectionTraceId: string;
	readonly compressionTraceId: string;
	readonly candidateCount: number;
	readonly selectedCount: number;
	readonly rejectedCount: number;
	readonly compressedCount: number;
	readonly truncatedCount: number;
	readonly droppedCount: number;
	readonly usedTokens: number;
	readonly budgetTokens: number;
	readonly sectionCount: number;
	readonly decisionCounts: ContextTraceDecisionCounts;
	readonly sourceSummaries: readonly ContextTraceSourceSummary[];
	readonly determinismKey: string;
}

export type ContextCacheStrategy =
	| "stable-system-prefix"
	| "provider-explicit-breakpoint"
	| "conversation-append-only-prefix"
	| "route-local-cache-identity";

export type ContextCacheRetentionPolicy = "none" | "ephemeral" | "session";

export interface ContextCachePlan {
	readonly cachePlanId: string;
	readonly promptBuildId: string;
	readonly providerPath: string;
	readonly modelFamily: string;
	readonly cacheStrategy: ContextCacheStrategy;
	readonly stablePrefixHash: string;
	readonly eligiblePrefixTokens: number;
	readonly dynamicSuffixTokens: number;
	readonly cacheBoundarySourceIds: readonly string[];
	readonly excludedVolatileSourceIds: readonly string[];
	readonly retentionPolicy: ContextCacheRetentionPolicy;
	readonly providerOptions: Readonly<Record<string, unknown>>;
	readonly expectedUsageFields: readonly string[];
	readonly determinismKey: string;
}
