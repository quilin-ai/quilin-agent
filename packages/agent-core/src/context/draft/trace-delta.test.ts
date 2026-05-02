import { describe, expect, it } from "vitest";
import { diffContextTraceSummaries } from "../index.js";
import type {
	ContextTraceDecisionCounts,
	ContextTraceSourceSummary,
	ContextTraceSummary,
} from "./source-types.js";

function keptSource(
	sourceId: string,
	outputTokens = 4,
): ContextTraceSourceSummary {
	return {
		sourceId,
		selection: "selected",
		compressionDecision: "keep",
		compressionReason: "within_budget",
		originalTokens: outputTokens,
		outputTokens,
	};
}

function truncatedSource(
	sourceId: string,
	originalTokens = 4,
	outputTokens = 2,
): ContextTraceSourceSummary {
	return {
		sourceId,
		selection: "selected",
		compressionDecision: "truncate",
		compressionReason: "budget_truncated",
		originalTokens,
		outputTokens,
	};
}

function rejectedSource(sourceId: string): ContextTraceSourceSummary {
	return {
		sourceId,
		selection: "rejected",
		rejectionReason: "poisoning_risk",
		outputTokens: 0,
	};
}

function decisionCountsFor(
	sourceSummaries: readonly ContextTraceSourceSummary[],
): ContextTraceDecisionCounts {
	return {
		selected: sourceSummaries.filter(
			(sourceSummary) => sourceSummary.selection === "selected",
		).length,
		rejected: sourceSummaries.filter(
			(sourceSummary) => sourceSummary.selection === "rejected",
		).length,
		keep: sourceSummaries.filter(
			(sourceSummary) => sourceSummary.compressionDecision === "keep",
		).length,
		truncate: sourceSummaries.filter(
			(sourceSummary) => sourceSummary.compressionDecision === "truncate",
		).length,
		drop: sourceSummaries.filter(
			(sourceSummary) => sourceSummary.compressionDecision === "drop",
		).length,
	};
}

function makeSummary(
	overrides: {
		readonly sourceSummaries?: readonly ContextTraceSourceSummary[];
		readonly budgetTokens?: number;
		readonly usedTokens?: number;
		readonly sectionCount?: number;
	} = {},
): ContextTraceSummary {
	const sourceSummaries = overrides.sourceSummaries ?? [keptSource("source-a")];
	const decisionCounts = decisionCountsFor(sourceSummaries);
	const usedTokens =
		overrides.usedTokens ??
		sourceSummaries.reduce(
			(sum, sourceSummary) => sum + sourceSummary.outputTokens,
			0,
		);
	const determinismKey = sourceSummaries
		.map((sourceSummary) => sourceSummary.sourceId)
		.toSorted()
		.join(",");

	return {
		traceId: `trace-summary:${determinismKey}`,
		selectionTraceId: `selection:${determinismKey}`,
		compressionTraceId: `compression:${determinismKey}`,
		candidateCount: sourceSummaries.length,
		selectedCount: decisionCounts.selected,
		rejectedCount: decisionCounts.rejected,
		compressedCount: decisionCounts.keep + decisionCounts.truncate,
		truncatedCount: decisionCounts.truncate,
		droppedCount: decisionCounts.drop,
		usedTokens,
		budgetTokens: overrides.budgetTokens ?? 8,
		sectionCount: overrides.sectionCount ?? 2,
		decisionCounts,
		sourceSummaries,
		determinismKey,
	};
}

describe("diffContextTraceSummaries", () => {
	it("emits a deterministic no-op delta for unchanged summaries", () => {
		const previous = makeSummary({
			sourceSummaries: [keptSource("source-b"), rejectedSource("source-a")],
		});
		const current = makeSummary({
			sourceSummaries: [rejectedSource("source-a"), keptSource("source-b")],
		});

		const delta = diffContextTraceSummaries(previous, current);

		expect(delta.sourceIds).toEqual({
			added: [],
			removed: [],
			changed: [],
		});
		expect(delta.hasChanges).toBe(false);
		expect(delta.tokenChanges.usedTokens).toEqual({
			previous: 4,
			current: 4,
			delta: 0,
		});
		expect(delta.determinismKey).toContain("added=|removed=|changed=");
	});

	it("reports added source ids in deterministic order", () => {
		const previous = makeSummary({
			sourceSummaries: [keptSource("source-b")],
		});
		const current = makeSummary({
			sourceSummaries: [
				keptSource("source-c", 2),
				keptSource("source-b"),
				rejectedSource("source-a"),
			],
			usedTokens: 6,
		});

		const delta = diffContextTraceSummaries(previous, current);

		expect(delta.sourceIds).toEqual({
			added: ["source-a", "source-c"],
			removed: [],
			changed: [],
		});
		expect(delta.countChanges.candidateCount).toEqual({
			previous: 1,
			current: 3,
			delta: 2,
		});
		expect(delta.tokenChanges.usedTokens).toEqual({
			previous: 4,
			current: 6,
			delta: 2,
		});
		expect(delta.hasChanges).toBe(true);
	});

	it("reports removed source ids in deterministic order", () => {
		const previous = makeSummary({
			sourceSummaries: [
				keptSource("source-c", 2),
				keptSource("source-b"),
				rejectedSource("source-a"),
			],
			usedTokens: 6,
		});
		const current = makeSummary({
			sourceSummaries: [keptSource("source-b")],
		});

		const delta = diffContextTraceSummaries(previous, current);

		expect(delta.sourceIds).toEqual({
			added: [],
			removed: ["source-a", "source-c"],
			changed: [],
		});
		expect(delta.countChanges.candidateCount).toEqual({
			previous: 3,
			current: 1,
			delta: -2,
		});
		expect(delta.tokenChanges.usedTokens).toEqual({
			previous: 6,
			current: 4,
			delta: -2,
		});
		expect(delta.hasChanges).toBe(true);
	});

	it("reports changed source ids with budget, token, and section deltas", () => {
		const previous = makeSummary({
			sourceSummaries: [keptSource("source-a", 3), keptSource("source-b", 4)],
			budgetTokens: 8,
			sectionCount: 2,
		});
		const current = makeSummary({
			sourceSummaries: [
				truncatedSource("source-b", 4, 2),
				keptSource("source-a", 3),
			],
			budgetTokens: 5,
			sectionCount: 3,
		});

		const delta = diffContextTraceSummaries(previous, current);

		expect(delta.sourceIds).toEqual({
			added: [],
			removed: [],
			changed: ["source-b"],
		});
		expect(delta.tokenChanges).toEqual({
			usedTokens: { previous: 7, current: 5, delta: -2 },
			budgetTokens: { previous: 8, current: 5, delta: -3 },
		});
		expect(delta.countChanges.sectionCount).toEqual({
			previous: 2,
			current: 3,
			delta: 1,
		});
		expect(delta.decisionCountChanges.keep).toEqual({
			previous: 2,
			current: 1,
			delta: -1,
		});
		expect(delta.decisionCountChanges.truncate).toEqual({
			previous: 0,
			current: 1,
			delta: 1,
		});
		expect(delta.hasChanges).toBe(true);
	});
});
