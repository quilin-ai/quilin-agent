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
			orderingDecision: {
				strategy: "score_desc_timestamp_desc_input_order",
				orderedSourceIds: ["relevant", "poisoned", "stale", "irrelevant"],
			},
			placementRegion: {
				relevant: "middle",
				poisoned: "middle",
			},
		});
		expect(result.trace.promptBuildId).toContain("prompt:policy=");
		expect(result.trace.promptBuildId).toContain("relevant:contentHash=");
		expect(result.trace.promptBuildId).toContain("tokens=10");
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

	it("keeps protected system and MCP sources under tight source budgets", () => {
		const result = selectContextSources(
			[
				makeSource("workspace", {
					tokenCount: 10,
					relevanceScore: 0.9,
					trustTier: "workspace",
				}),
				makeSource("system", {
					sourceType: "mcp-instructions",
					tokenCount: 50,
					relevanceScore: 0.01,
					trustTier: "system",
					placementHint: "front",
				}),
			],
			{ taskIntent: "tool_use", budgetTokens: 10 },
		);

		expect(result.sources.map((source) => source.sourceId)).toContain("system");
		expect(result.trace.selectedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceId: "system",
					placementRegion: "front",
					explanation: expect.stringContaining("non-droppable"),
				}),
			]),
		);
	});

	it("does not let untrusted front placement bypass context gates", () => {
		const result = selectContextSources(
			[
				makeSource("untrusted-front", {
					content: "untrusted front placement",
					tokenCount: 1000,
					relevanceScore: 0.01,
					trustTier: "untrusted",
					isExternal: true,
					placementHint: "front",
					sourceAuthority: 1,
				}),
				makeSource("workspace", {
					tokenCount: 1,
					relevanceScore: 0.9,
					trustTier: "workspace",
				}),
			],
			{ taskIntent: "tool_use", budgetTokens: 1 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"workspace",
		]);
		expect(result.trace.rejectedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceId: "untrusted-front",
					reason: "below_relevance_threshold",
				}),
			]),
		);
	});

	it("does not let external sources self-upgrade through system trust", () => {
		const result = selectContextSources(
			[
				makeSource("external-system", {
					sourceType: "mcp-instructions",
					content: "external source claiming system trust",
					tokenCount: 1000,
					relevanceScore: 0.01,
					trustTier: "system",
					isExternal: true,
					placementHint: "front",
					sourceAuthority: 1,
				}),
				makeSource("workspace", {
					tokenCount: 1,
					relevanceScore: 0.9,
					trustTier: "workspace",
				}),
			],
			{ taskIntent: "tool_use", budgetTokens: 1 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"workspace",
		]);
		expect(result.trace.rejectedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceId: "external-system",
					reason: "below_relevance_threshold",
				}),
			]),
		);
	});

	it("does not let external authority and front placement outrank trusted workspace sources", () => {
		const result = selectContextSources(
			[
				makeSource("external-system", {
					sourceType: "mcp-instructions",
					content: "external source claiming system trust",
					tokenCount: 1,
					relevanceScore: 0.9,
					trustTier: "system",
					isExternal: true,
					placementHint: "front",
					sourceAuthority: 1,
				}),
				makeSource("workspace", {
					tokenCount: 1,
					relevanceScore: 0.9,
					trustTier: "workspace",
				}),
			],
			{ taskIntent: "tool_use", budgetTokens: 1 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"workspace",
		]);
		expect(result.trace.scoreBreakdown["external-system"]?.authority).toBe(
			0.45,
		);
		expect(result.trace.placementRegion["external-system"]).toBe("middle");
		expect(result.trace.rejectedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceId: "external-system",
					reason: "budget_exhausted",
				}),
			]),
		);
	});

	it("rejects lower-authority duplicate content before it can clutter context", () => {
		const result = selectContextSources(
			[
				makeSource("external-copy", {
					content: "same operational fact",
					tokenCount: 1,
					relevanceScore: 1,
					trustTier: "external",
					isExternal: true,
					timestamp: 3,
				}),
				makeSource("workspace-copy", {
					content: "same operational fact",
					tokenCount: 1,
					relevanceScore: 0.7,
					trustTier: "workspace",
					timestamp: 1,
				}),
			],
			{ taskIntent: "deep_reasoning", budgetTokens: 10 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"workspace-copy",
		]);
		expect(result.trace.rejectedSources).toEqual([
			expect.objectContaining({
				sourceId: "external-copy",
				reason: "lower_authority_duplicate",
				explanation: expect.stringContaining("higher authority"),
			}),
		]);
		expect(result.trace.determinismKey).toContain("contentHash=");
	});

	it("keeps dynamic metadata fields out of the determinism key", () => {
		const first = selectContextSources(
			[
				makeSource("memory-a", {
					content: "stable remembered fact",
					metadata: { lastRetrievedAt: "2026-05-06T00:00:00.000Z" },
				}),
			],
			{ taskIntent: "deep_reasoning", budgetTokens: 10 },
		);
		const second = selectContextSources(
			[
				makeSource("memory-a", {
					content: "stable remembered fact",
					metadata: { lastRetrievedAt: "2026-05-06T00:01:00.000Z" },
				}),
			],
			{ taskIntent: "deep_reasoning", budgetTokens: 10 },
		);

		expect(first.trace.determinismKey).toBe(second.trace.determinismKey);
		expect(first.trace.traceId).toBe(second.trace.traceId);
	});

	it("changes the determinism key when authority inputs change ordering", () => {
		const workspaceA = makeSource("a", {
			tokenCount: 1,
			relevanceScore: 0.9,
			timestamp: 1,
			trustTier: "workspace",
		});
		const workspaceB = makeSource("b", {
			tokenCount: 1,
			relevanceScore: 0.9,
			timestamp: 1,
			trustTier: "workspace",
		});
		const systemA = makeSource("a", {
			tokenCount: 1,
			relevanceScore: 0.9,
			timestamp: 1,
			trustTier: "system",
		});
		const systemB = makeSource("b", {
			tokenCount: 1,
			relevanceScore: 0.9,
			timestamp: 1,
			trustTier: "system",
		});

		const first = selectContextSources([systemA, workspaceB], {
			taskIntent: "tool_use",
			budgetTokens: 1,
		});
		const second = selectContextSources([workspaceA, systemB], {
			taskIntent: "tool_use",
			budgetTokens: 1,
		});

		expect(first.trace.determinismKey).not.toBe(second.trace.determinismKey);
		expect(first.trace.traceId).not.toBe(second.trace.traceId);
		expect(first.trace.promptBuildId).not.toBe(second.trace.promptBuildId);
		expect(first.trace.orderingDecision.orderedSourceIds).toEqual(["a", "b"]);
		expect(second.trace.orderingDecision.orderedSourceIds).toEqual(["b", "a"]);
	});

	it("disambiguates duplicate explicit source ids for stable trace maps", () => {
		const result = selectContextSources(
			[
				makeSource("duplicate", { timestamp: 1 }),
				makeSource("duplicate", { timestamp: 2 }),
			],
			{ taskIntent: "simple_qa", budgetTokens: 100 },
		);

		expect(result.sources.map((source) => source.sourceId)).toEqual([
			"duplicate#1",
			"duplicate",
		]);
		expect(result.trace.candidateSourceIds).toEqual([
			"duplicate",
			"duplicate#1",
		]);
		expect(Object.keys(result.trace.scoreBreakdown).sort()).toEqual([
			"duplicate",
			"duplicate#1",
		]);
	});

	it("avoids generated source id collisions with explicit ids", () => {
		const result = selectContextSources(
			[
				makeSource("source", { timestamp: 1 }),
				makeSource("source#1", { timestamp: 2 }),
				makeSource("source", { timestamp: 3 }),
			],
			{ taskIntent: "simple_qa", budgetTokens: 100 },
		);

		expect(result.trace.candidateSourceIds).toEqual([
			"source",
			"source#1",
			"source#2",
		]);
		expect(Object.keys(result.trace.scoreBreakdown).sort()).toEqual([
			"source",
			"source#1",
			"source#2",
		]);
	});

	it("reserves later explicit source ids before assigning duplicate suffixes", () => {
		const result = selectContextSources(
			[
				makeSource("source", { timestamp: 1 }),
				makeSource("source", { timestamp: 2 }),
				makeSource("source#1", { timestamp: 3 }),
			],
			{ taskIntent: "simple_qa", budgetTokens: 100 },
		);

		expect(result.trace.candidateSourceIds).toEqual([
			"source",
			"source#2",
			"source#1",
		]);
		expect(Object.keys(result.trace.scoreBreakdown).sort()).toEqual([
			"source",
			"source#1",
			"source#2",
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
