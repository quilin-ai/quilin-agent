import { describe, expect, it } from "vitest";
import { selectContextSources } from "./selection.js";
import type { ContextSource } from "./source-types.js";

function makeSource(
	sourceId: string,
	overrides: Partial<ContextSource> = {},
): ContextSource {
	return {
		sourceId,
		sourceType: overrides.sourceType ?? "memory",
		content: overrides.content ?? sourceId,
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

describe("selectContextSources", () => {
	it("records selected and rejected sources with reason codes", () => {
		const result = selectContextSources(
			[
				makeSource("relevant", { relevanceScore: 0.9 }),
				makeSource("irrelevant", { relevanceScore: 0.05 }),
				makeSource("stale", { freshnessScore: 0.01 }),
				makeSource("poisoned", { poisoningStatus: "poisoned" }),
			],
			{ taskIntent: "deep_reasoning", budgetTokens: 100 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"relevant",
		]);
		expect(result.trace.selectedSources).toHaveLength(1);
		expect(result.trace).toMatchObject({
			runId: "unbound-run",
			promptBuildId: "prompt:relevant|irrelevant|stale|poisoned",
			orderingDecision: {
				strategy: "score_desc_timestamp_desc_input_order",
				orderedSourceIds: ["relevant", "poisoned", "stale", "irrelevant"],
			},
			placementRegion: {
				relevant: "middle",
				poisoned: "middle",
			},
		});
		expect(result.trace.scoreBreakdown.relevant?.finalScore).toBeGreaterThan(
			result.trace.scoreBreakdown.irrelevant?.finalScore ?? 0,
		);
		expect(result.trace.rejectedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceId: "irrelevant",
					reason: "below_relevance_threshold",
					explanation: expect.stringContaining("relevance"),
				}),
				expect.objectContaining({
					sourceId: "stale",
					reason: "stale_source",
				}),
				expect.objectContaining({
					sourceId: "poisoned",
					reason: "poisoning_risk",
				}),
			]),
		);
	});

	it("applies budget after deterministic score ordering", () => {
		const result = selectContextSources(
			[
				makeSource("lower", { relevanceScore: 0.5, tokenCount: 15 }),
				makeSource("higher", { relevanceScore: 0.9, tokenCount: 15 }),
			],
			{ taskIntent: "simple_qa", budgetTokens: 15 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual(["higher"]);
		expect(result.trace.rejectedSources).toEqual([
			expect.objectContaining({
				sourceId: "lower",
				reason: "budget_exhausted",
			}),
		]);
	});

	it("preserves placement hints in the trace", () => {
		const result = selectContextSources(
			[
				makeSource("rule", {
					sourceType: "mcp-instructions",
					placementHint: "front",
				}),
			],
			{ taskIntent: "tool_use", budgetTokens: 100 },
		);

		expect(result.trace.selectedSources[0]).toMatchObject({
			sourceId: "rule",
			placementRegion: "front",
		});
	});
});
