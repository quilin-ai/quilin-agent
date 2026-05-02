import { describe, expect, it } from "vitest";
import { compressContextSources } from "./compression.js";
import type { ContextSource } from "./source-types.js";

function makeSource(
	sourceId: string,
	overrides: Partial<ContextSource> = {},
): ContextSource {
	return {
		sourceId,
		sourceType: overrides.sourceType ?? "memory",
		content:
			overrides.content ??
			`${sourceId} content that is intentionally long enough to truncate`,
		tokenCount: overrides.tokenCount ?? 10,
		relevanceScore: overrides.relevanceScore ?? 0.7,
		timestamp: overrides.timestamp ?? 1,
		metadata: overrides.metadata ?? {},
		isExternal: overrides.isExternal ?? false,
		trustTier: overrides.trustTier,
		freshnessScore: overrides.freshnessScore,
		sourceAuthority: overrides.sourceAuthority,
		cacheVolatility: overrides.cacheVolatility,
		placementHint: overrides.placementHint,
		poisoningStatus: overrides.poisoningStatus,
		contradictionRisk: overrides.contradictionRisk,
	};
}

describe("compressContextSources", () => {
	it("keeps full sources when the token budget is sufficient", () => {
		const result = compressContextSources(
			[
				makeSource("memory-a", { tokenCount: 4, relevanceScore: 0.9 }),
				makeSource("memory-b", { tokenCount: 6, relevanceScore: 0.8 }),
			],
			{ budgetTokens: 10 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"memory-a",
			"memory-b",
		]);
		expect(result.trace.usedTokens).toBe(10);
		expect(result.trace.decisions).toEqual([
			expect.objectContaining({
				sourceId: "memory-a",
				decision: "keep",
				reason: "within_budget",
				outputTokens: 4,
				tokenCostEstimated: false,
			}),
			expect.objectContaining({
				sourceId: "memory-b",
				decision: "keep",
				reason: "within_budget",
				outputTokens: 6,
				tokenCostEstimated: false,
			}),
		]);
	});

	it("truncates relevant sources and drops later sources when budget is exhausted", () => {
		const result = compressContextSources(
			[
				makeSource("important", {
					tokenCount: 30,
					relevanceScore: 0.95,
					content: "important ".repeat(30),
				}),
				makeSource("secondary", { tokenCount: 10, relevanceScore: 0.5 }),
			],
			{ budgetTokens: 20 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"important",
		]);
		expect(result.sources[0]?.tokenCount).toBe(20);
		expect(result.sources[0]?.content).toContain("[TRUNCATED]");
		expect(result.sources[0]?.metadata.compression).toMatchObject({
			outputTokenCount: 20,
			truncationMarkerTokenCount: 1,
		});
		expect(result.trace.usedTokens).toBe(20);
		expect(result.trace.decisions).toEqual([
			expect.objectContaining({
				sourceId: "important",
				decision: "truncate",
				reason: "budget_truncated",
				originalTokens: 30,
				outputTokens: 20,
				tokenCostEstimated: false,
				explanation: expect.stringContaining("Truncated"),
			}),
			expect.objectContaining({
				sourceId: "secondary",
				decision: "drop",
				reason: "budget_exhausted",
				outputTokens: 0,
			}),
		]);
	});

	it("uses stable ordering and produces stable trace decisions", () => {
		const sources = [
			makeSource("tie-large-newer", {
				tokenCount: 8,
				relevanceScore: 0.8,
				timestamp: 3,
			}),
			makeSource("tie-small", {
				tokenCount: 4,
				relevanceScore: 0.8,
				timestamp: 1,
			}),
			makeSource("tie-large-older", {
				tokenCount: 8,
				relevanceScore: 0.8,
				timestamp: 2,
			}),
		];

		const first = compressContextSources(sources, { budgetTokens: 20 });
		const second = compressContextSources(sources, { budgetTokens: 20 });

		expect(first.trace.orderingDecision).toEqual({
			strategy: "final_score_desc_token_asc_timestamp_desc_input_order",
			orderedSourceIds: ["tie-small", "tie-large-newer", "tie-large-older"],
		});
		expect(first.trace.decisions).toEqual(second.trace.decisions);
		expect(first.sources.map((source) => source.sourceId)).toEqual(
			second.sources.map((source) => source.sourceId),
		);
	});

	it("drops partial sources below the truncation relevance threshold", () => {
		const result = compressContextSources(
			[
				makeSource("low-relevance", {
					tokenCount: 10,
					relevanceScore: 0.1,
				}),
			],
			{ budgetTokens: 4, minTruncateRelevanceScore: 0.15 },
		);

		expect(result.sources).toEqual([]);
		expect(result.trace.decisions).toEqual([
			expect.objectContaining({
				sourceId: "low-relevance",
				decision: "drop",
				reason: "below_truncation_threshold",
			}),
		]);
	});

	it("uses conservative estimates for non-empty zero-token sources", () => {
		const result = compressContextSources(
			[
				makeSource("zero-token", {
					content: "non-empty content",
					tokenCount: 0,
					relevanceScore: 0.9,
				}),
			],
			{ budgetTokens: 0 },
		);

		expect(result.sources).toEqual([]);
		expect(result.trace.usedTokens).toBe(0);
		expect(result.trace.scoreBreakdown["zero-token"]).toMatchObject({
			tokenCost: 5,
			tokenCostEstimated: true,
		});
		expect(result.trace.decisions).toEqual([
			expect.objectContaining({
				sourceId: "zero-token",
				decision: "drop",
				reason: "budget_exhausted",
				originalTokens: 5,
				tokenCostEstimated: true,
			}),
		]);
	});

	it("keeps estimated-token sources only when the conservative estimate fits", () => {
		const result = compressContextSources(
			[
				makeSource("estimated", {
					content: "12345678",
					tokenCount: 0,
					relevanceScore: 0.9,
				}),
			],
			{ budgetTokens: 2 },
		);

		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.tokenCount).toBe(2);
		expect(result.trace.usedTokens).toBe(2);
		expect(result.trace.decisions[0]).toMatchObject({
			sourceId: "estimated",
			decision: "keep",
			reason: "estimated_token_cost",
			outputTokens: 2,
			tokenCostEstimated: true,
		});
	});

	it("includes budget and scoring inputs in the default determinism key", () => {
		const sources = [
			makeSource("memory-a", { tokenCount: 4, relevanceScore: 0.9 }),
		];

		const tight = compressContextSources(sources, { budgetTokens: 2 });
		const roomy = compressContextSources(sources, { budgetTokens: 4 });

		expect(tight.trace.determinismKey).not.toBe(roomy.trace.determinismKey);
		expect(tight.trace.traceId).not.toBe(roomy.trace.traceId);
		expect(tight.trace.determinismKey).toContain("budget=2");
		expect(tight.trace.determinismKey).toContain("tokens=4");
		expect(tight.trace.determinismKey).toContain("relevance=0.9");
	});
});
