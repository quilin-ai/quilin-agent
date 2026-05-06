import { describe, expect, it } from "vitest";
import {
	buildContextCachePlan,
	type DraftContextSource as ContextSource,
} from "../index.js";
import type { AssembledPrompt } from "../prompt-types.js";
import { estimateTokens } from "../tokens.js";

function makePrompt(overrides: Partial<AssembledPrompt> = {}): AssembledPrompt {
	return {
		segments: overrides.segments ?? [],
		recommendedBreakpoints: overrides.recommendedBreakpoints ?? [],
		staticPrefix: overrides.staticPrefix ?? "stable system prefix",
		dynamicSuffix: overrides.dynamicSuffix ?? "current user turn",
		sectionTokens: overrides.sectionTokens ?? {},
		totalTokens: overrides.totalTokens ?? 0,
	};
}

function makeSource(
	sourceId: string,
	overrides: Partial<ContextSource> = {},
): ContextSource {
	return {
		sourceId,
		sourceType: overrides.sourceType ?? "memory",
		content: overrides.content ?? `content for ${sourceId}`,
		tokenCount: overrides.tokenCount ?? 4,
		relevanceScore: overrides.relevanceScore ?? 0.9,
		timestamp: overrides.timestamp ?? 1,
		metadata: overrides.metadata ?? {},
		isExternal: overrides.isExternal ?? false,
		cacheVolatility: overrides.cacheVolatility,
	};
}

describe("buildContextCachePlan", () => {
	it("keeps unrendered context source changes out of the stable prefix hash", () => {
		const stable = makeSource("stable-source", {
			cacheVolatility: "stable",
			content: "durable project rule",
			tokenCount: 5,
		});
		const volatile = makeSource("volatile-source", {
			cacheVolatility: "volatile",
			content: "current tool result A",
			tokenCount: 3,
		});
		const unknown = makeSource("unknown-source", {
			content: "source without volatility metadata",
			tokenCount: 4,
		});
		const first = buildContextCachePlan({
			prompt: makePrompt({ dynamicSuffix: "turn A" }),
			contextSources: [stable, volatile, unknown],
			promptBuildId: "prompt-1",
			modelId: "deepseek-chat",
		});
		const second = buildContextCachePlan({
			prompt: makePrompt({ dynamicSuffix: "turn B" }),
			contextSources: [
				stable,
				makeSource("volatile-source", {
					cacheVolatility: "volatile",
					content: "current tool result B",
					tokenCount: 7,
				}),
				unknown,
			],
			promptBuildId: "prompt-1",
			modelId: "deepseek-chat",
		});
		const tokenOnlyChange = buildContextCachePlan({
			prompt: makePrompt({ dynamicSuffix: "turn A" }),
			contextSources: [
				makeSource("stable-source", {
					cacheVolatility: "stable",
					content: "durable project rule",
					tokenCount: 9,
				}),
				volatile,
				unknown,
			],
			promptBuildId: "prompt-1",
			modelId: "deepseek-chat",
		});

		expect(first.stablePrefixHash).toBe(second.stablePrefixHash);
		expect(first.stablePrefixHash).toBe(tokenOnlyChange.stablePrefixHash);
		expect(first.cacheBoundarySourceIds).toEqual([]);
		expect(first.excludedVolatileSourceIds).toEqual([
			"stable-source",
			"volatile-source",
			"unknown-source",
		]);
		expect(first.eligiblePrefixTokens).toBe(
			estimateTokens("stable system prefix"),
		);
		expect(tokenOnlyChange.eligiblePrefixTokens).toBe(
			estimateTokens("stable system prefix"),
		);
		expect(first.dynamicSuffixTokens).toBe(
			estimateTokens("turn A") + 5 + 3 + 4,
		);
		expect(second.dynamicSuffixTokens).toBe(
			estimateTokens("turn B") + 5 + 7 + 4,
		);
		expect(first.cachePlanId).not.toBe(second.cachePlanId);
	});

	it("changes the stable prefix hash when cache-boundary source content changes", () => {
		const first = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [
				makeSource("stable-source", {
					cacheVolatility: "session_stable",
					content: "session policy A",
				}),
			],
			promptBuildId: "prompt-2",
			modelId: "deepseek-chat",
			providerPath: "deepseek",
			modelFamily: "deepseek",
			providerOptions: { retention: "session", z: 1, a: 2 },
			expectedUsageFields: ["cache_read_tokens", "cache_write_tokens"],
			renderedCacheBoundarySourceIds: ["stable-source"],
		});
		const second = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [
				makeSource("stable-source", {
					cacheVolatility: "session_stable",
					content: "session policy B",
				}),
			],
			promptBuildId: "prompt-2",
			modelId: "deepseek-chat",
			providerPath: "deepseek",
			modelFamily: "deepseek",
			providerOptions: { a: 2, z: 1 },
			expectedUsageFields: ["cache_read_tokens", "cache_write_tokens"],
			renderedCacheBoundarySourceIds: ["stable-source"],
		});

		expect(first.providerPath).toBe("deepseek");
		expect(first.modelFamily).toBe("deepseek");
		expect(first.expectedUsageFields).toEqual([
			"cache_read_tokens",
			"cache_write_tokens",
		]);
		expect(first.stablePrefixHash).not.toBe(second.stablePrefixHash);
		expect(first.determinismKey).toContain("providerOptionsHash=");
		expect(first.determinismKey).not.toContain("providerOptions={");
		expect(first.cachePlanId).toMatch(/^cache-plan:[a-f0-9]{16}$/);
	});

	it("keeps dynamic source fields out of the rendered stable prefix hash", () => {
		const first = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [
				makeSource("stable-source", {
					cacheVolatility: "stable",
					content: "rendered stable instructions",
					tokenCount: 4,
					metadata: { lastSeenAt: "2026-05-06T00:00:00.000Z" },
					relevanceScore: 0.7,
				}),
			],
			promptBuildId: "prompt-stable-fields",
			modelId: "deepseek-chat",
			renderedCacheBoundarySourceIds: ["stable-source"],
		});
		const dynamicOnlyChange = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [
				makeSource("stable-source", {
					cacheVolatility: "stable",
					content: "rendered stable instructions",
					tokenCount: 9,
					metadata: { lastSeenAt: "2026-05-06T00:01:00.000Z" },
					relevanceScore: 0.1,
				}),
			],
			promptBuildId: "prompt-stable-fields",
			modelId: "deepseek-chat",
			renderedCacheBoundarySourceIds: ["stable-source"],
		});

		expect(first.cacheBoundarySourceIds).toEqual(["stable-source"]);
		expect(first.stablePrefixHash).toBe(dynamicOnlyChange.stablePrefixHash);
		expect(first.eligiblePrefixTokens).not.toBe(
			dynamicOnlyChange.eligiblePrefixTokens,
		);
		expect(first.cachePlanId).not.toBe(dynamicOnlyChange.cachePlanId);
	});

	it("keeps the cache plan hash stable when expected usage field order changes", () => {
		const first = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [],
			promptBuildId: "prompt-3b",
			modelId: "deepseek-chat",
			expectedUsageFields: ["cache_read_tokens", "cache_write_tokens"],
		});
		const second = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [],
			promptBuildId: "prompt-3b",
			modelId: "deepseek-chat",
			expectedUsageFields: ["cache_write_tokens", "cache_read_tokens"],
		});

		expect(first.expectedUsageFields).toEqual([
			"cache_read_tokens",
			"cache_write_tokens",
		]);
		expect(second.expectedUsageFields).toEqual([
			"cache_write_tokens",
			"cache_read_tokens",
		]);
		expect(first.determinismKey).toBe(second.determinismKey);
		expect(first.cachePlanId).toBe(second.cachePlanId);
	});

	it("snapshots provider options and expected usage fields before returning", () => {
		const providerOptions = {
			z: 1,
			nested: { b: "before", a: ["first"] },
		};
		const expectedUsageFields = ["cache_read_tokens"];
		const plan = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [],
			promptBuildId: "prompt-3",
			modelId: "deepseek-chat",
			providerOptions,
			expectedUsageFields,
		});

		providerOptions.z = 2;
		providerOptions.nested.b = "after";
		providerOptions.nested.a.push("second");
		expectedUsageFields.push("cache_write_tokens");

		expect(plan.providerOptions).toEqual({
			nested: { a: ["first"], b: "before" },
			z: 1,
		});
		expect(plan.expectedUsageFields).toEqual(["cache_read_tokens"]);
		expect(Object.isFrozen(plan.providerOptions)).toBe(true);
		expect(Object.isFrozen(plan.expectedUsageFields)).toBe(true);
		expect(Object.isFrozen(plan.providerOptions.nested as object)).toBe(true);
	});

	it("only marks the contiguous stable source prefix as cacheable", () => {
		const plan = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [
				makeSource("stable-front", {
					cacheVolatility: "stable",
					content: "stable front",
					tokenCount: 2,
				}),
				makeSource("volatile-middle", {
					cacheVolatility: "volatile",
					content: "volatile middle",
					tokenCount: 3,
				}),
				makeSource("stable-after-volatile", {
					cacheVolatility: "stable",
					content: "stable but not prefix",
					tokenCount: 5,
				}),
			],
			promptBuildId: "prompt-4",
			modelId: "deepseek-chat",
			renderedCacheBoundarySourceIds: ["stable-front", "stable-after-volatile"],
		});
		const changedAfterDynamic = buildContextCachePlan({
			prompt: makePrompt(),
			contextSources: [
				makeSource("stable-front", {
					cacheVolatility: "stable",
					content: "stable front",
					tokenCount: 2,
				}),
				makeSource("volatile-middle", {
					cacheVolatility: "volatile",
					content: "volatile middle",
					tokenCount: 3,
				}),
				makeSource("stable-after-volatile", {
					cacheVolatility: "stable",
					content: "changed but still not prefix",
					tokenCount: 7,
				}),
			],
			promptBuildId: "prompt-4",
			modelId: "deepseek-chat",
			renderedCacheBoundarySourceIds: ["stable-front", "stable-after-volatile"],
		});

		expect(plan.cacheBoundarySourceIds).toEqual(["stable-front"]);
		expect(plan.excludedVolatileSourceIds).toEqual([
			"volatile-middle",
			"stable-after-volatile",
		]);
		expect(plan.stablePrefixHash).toBe(changedAfterDynamic.stablePrefixHash);
		expect(plan.eligiblePrefixTokens).toBe(
			estimateTokens("stable system prefix") + 2,
		);
		expect(changedAfterDynamic.dynamicSuffixTokens).toBe(
			estimateTokens("current user turn") + 3 + 7,
		);
	});
});
