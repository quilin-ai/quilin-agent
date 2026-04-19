export interface TokenUsageLike {
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly inputTokenDetails?: {
		readonly cacheReadTokens?: number;
	};
}

export interface NormalizedTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheHitTokens?: number;
}

export function normalizeTokenUsage(
	usage: TokenUsageLike | undefined,
): NormalizedTokenUsage {
	return {
		inputTokens: usage?.promptTokens ?? usage?.inputTokens ?? 0,
		outputTokens: usage?.completionTokens ?? usage?.outputTokens ?? 0,
		cacheHitTokens: usage?.inputTokenDetails?.cacheReadTokens,
	};
}
