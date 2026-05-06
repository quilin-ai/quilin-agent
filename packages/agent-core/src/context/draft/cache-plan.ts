import { createHash } from "node:crypto";
import type { AssembledPrompt } from "../prompt-types.js";
import { estimateTokens } from "../tokens.js";
import type {
	CacheVolatility,
	ContextCachePlan,
	ContextCacheRetentionPolicy,
	ContextCacheStrategy,
	ContextSource,
} from "./source-types.js";

export interface BuildContextCachePlanInput {
	readonly prompt: AssembledPrompt;
	readonly contextSources: readonly ContextSource[];
	readonly promptBuildId: string;
	readonly modelId: string;
	readonly renderedCacheBoundarySourceIds?: readonly string[];
	readonly providerPath?: string;
	readonly modelFamily?: string;
	readonly cacheStrategy?: ContextCacheStrategy;
	readonly retentionPolicy?: ContextCacheRetentionPolicy;
	readonly providerOptions?: Readonly<Record<string, unknown>>;
	readonly expectedUsageFields?: readonly string[];
}

const DEFAULT_EXPECTED_USAGE_FIELDS = [
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
] as const;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sourceId(source: ContextSource, index: number): string {
	return source.sourceId ?? `${source.sourceType}:${source.timestamp}:${index}`;
}

function isCacheBoundaryVolatility(
	volatility: CacheVolatility | undefined,
): boolean {
	return volatility === "stable" || volatility === "session_stable";
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}

	if (value != null && typeof value === "object") {
		return `{${Object.entries(value as Readonly<Record<string, unknown>>)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(
				([key, nestedValue]) =>
					`${JSON.stringify(key)}:${stableStringify(nestedValue)}`,
			)
			.join(",")}}`;
	}

	return JSON.stringify(value);
}

function stableSnapshot(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(stableSnapshot));
	}

	if (value != null && typeof value === "object") {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value as Readonly<Record<string, unknown>>)
					.toSorted(([left], [right]) => left.localeCompare(right))
					.map(([key, nestedValue]) => [key, stableSnapshot(nestedValue)]),
			),
		);
	}

	return value;
}

function stableRecordSnapshot(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return stableSnapshot(value) as Readonly<Record<string, unknown>>;
}

function normalizeExpectedUsageFields(
	value: readonly string[],
): readonly string[] {
	return [...new Set(value)].toSorted();
}

function sourceDigest(source: ContextSource, sourceIdValue: string): string {
	return sha256(
		stableStringify({
			cacheVolatility: source.cacheVolatility ?? "unset",
			content: source.content,
			sourceId: sourceIdValue,
			sourceType: source.sourceType,
		}),
	);
}

export function buildContextCachePlan(
	input: BuildContextCachePlanInput,
): ContextCachePlan {
	const providerPath = input.providerPath ?? "local-context";
	const modelFamily = input.modelFamily ?? input.modelId;
	const cacheStrategy = input.cacheStrategy ?? "stable-system-prefix";
	const retentionPolicy = input.retentionPolicy ?? "session";
	const providerOptions = stableRecordSnapshot(input.providerOptions ?? {});
	const expectedUsageFields = Object.freeze([
		...(input.expectedUsageFields ?? DEFAULT_EXPECTED_USAGE_FIELDS),
	]);
	const normalizedExpectedUsageFields =
		normalizeExpectedUsageFields(expectedUsageFields);
	const sourcesWithIds = input.contextSources.map((source, index) => ({
		source,
		sourceId: sourceId(source, index),
	}));
	const renderedCacheBoundarySourceIds = new Set(
		input.renderedCacheBoundarySourceIds ?? [],
	);
	let cacheBoundarySourceCount = 0;
	for (const { source, sourceId: id } of sourcesWithIds) {
		if (
			!renderedCacheBoundarySourceIds.has(id) ||
			!isCacheBoundaryVolatility(source.cacheVolatility)
		) {
			break;
		}
		cacheBoundarySourceCount += 1;
	}
	const cacheBoundarySources = sourcesWithIds.slice(
		0,
		cacheBoundarySourceCount,
	);
	const excludedVolatileSources = sourcesWithIds.filter(
		(_sourceWithId, index) => index >= cacheBoundarySourceCount,
	);
	const cacheBoundarySourceIds = cacheBoundarySources.map(
		({ sourceId: id }) => id,
	);
	const excludedVolatileSourceIds = excludedVolatileSources.map(
		({ sourceId: id }) => id,
	);
	const stablePrefixPayload = stableStringify({
		staticPrefix: input.prompt.staticPrefix,
		sources: cacheBoundarySources.map(({ source, sourceId: id }) => ({
			sourceId: id,
			digest: sourceDigest(source, id),
		})),
	});
	const stablePrefixHash = sha256(stablePrefixPayload);
	const eligiblePrefixTokens =
		estimateTokens(input.prompt.staticPrefix) +
		cacheBoundarySources.reduce(
			(sum, { source }) => sum + Math.max(0, source.tokenCount),
			0,
		);
	const dynamicSuffixTokens =
		estimateTokens(input.prompt.dynamicSuffix) +
		excludedVolatileSources.reduce(
			(sum, { source }) => sum + Math.max(0, source.tokenCount),
			0,
		);
	const determinismKey = [
		`prompt=${input.promptBuildId}`,
		`providerPath=${providerPath}`,
		`modelFamily=${modelFamily}`,
		`strategy=${cacheStrategy}`,
		`retention=${retentionPolicy}`,
		`stablePrefixHash=${stablePrefixHash}`,
		`eligiblePrefixTokens=${eligiblePrefixTokens}`,
		`dynamicSuffixTokens=${dynamicSuffixTokens}`,
		`cacheBoundarySourceIds=${cacheBoundarySourceIds.join(",")}`,
		`excludedVolatileSourceIds=${excludedVolatileSourceIds.join(",")}`,
		`providerOptionsHash=${sha256(stableStringify(providerOptions))}`,
		`expectedUsageFields=${normalizedExpectedUsageFields.join(",")}`,
	].join("|");

	return {
		cachePlanId: `cache-plan:${sha256(determinismKey).slice(0, 16)}`,
		promptBuildId: input.promptBuildId,
		providerPath,
		modelFamily,
		cacheStrategy,
		stablePrefixHash,
		eligiblePrefixTokens,
		dynamicSuffixTokens,
		cacheBoundarySourceIds,
		excludedVolatileSourceIds,
		retentionPolicy,
		providerOptions,
		expectedUsageFields,
		determinismKey,
	};
}
