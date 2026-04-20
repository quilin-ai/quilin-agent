import type { CacheUsage, CacheUsageSource } from "./types.js";

export interface TokenUsageLike {
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly inputTokenDetails?: {
		readonly cacheReadTokens?: number;
		readonly cacheWriteTokens?: number;
	};
}

export interface ProviderCacheMetadata {
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly cacheSource?: CacheUsageSource;
}

export interface ProviderMetadataLike {
	readonly deepseek?: ProviderCacheMetadata;
	readonly anthropic?: ProviderCacheMetadata;
	readonly openai?: ProviderCacheMetadata;
	readonly [provider: string]: unknown;
}

export interface NormalizedTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cache?: CacheUsage;
}

function toCacheUsage(
	readTokens: number | undefined,
	writeTokens: number | undefined,
	source: CacheUsageSource,
): CacheUsage | undefined {
	if (readTokens == null && writeTokens == null) {
		return undefined;
	}

	return {
		readTokens,
		writeTokens,
		source,
	};
}

function readProviderCacheMetadata(
	providerMetadata: ProviderMetadataLike | undefined,
): CacheUsage | undefined {
	if (providerMetadata == null) {
		return undefined;
	}

	for (const provider of ["deepseek", "anthropic", "openai"] as const) {
		const metadata = providerMetadata[provider];
		if (
			metadata != null &&
			typeof metadata === "object" &&
			("cacheReadTokens" in metadata ||
				"cacheWriteTokens" in metadata ||
				"cacheSource" in metadata)
		) {
			const cacheMetadata = metadata as ProviderCacheMetadata;
			return toCacheUsage(
				cacheMetadata.cacheReadTokens,
				cacheMetadata.cacheWriteTokens,
				cacheMetadata.cacheSource ?? "unknown",
			);
		}
	}

	return undefined;
}

export function normalizeTokenUsage(
	usage: TokenUsageLike | undefined,
	providerMetadata?: ProviderMetadataLike,
): NormalizedTokenUsage {
	const nativeCacheUsage = toCacheUsage(
		usage?.inputTokenDetails?.cacheReadTokens,
		usage?.inputTokenDetails?.cacheWriteTokens,
		"native",
	);

	return {
		inputTokens: usage?.promptTokens ?? usage?.inputTokens ?? 0,
		outputTokens: usage?.completionTokens ?? usage?.outputTokens ?? 0,
		cache: nativeCacheUsage ?? readProviderCacheMetadata(providerMetadata),
	};
}
