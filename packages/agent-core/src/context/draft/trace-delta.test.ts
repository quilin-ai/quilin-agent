import { describe, expect, it } from "vitest";
import {
	buildContextDeltaStreamTrace,
	diffContextTraceSummaries,
	resumeContextDeltaStreamTrace,
} from "../index.js";
import type {
	ContextCachePlan,
	ContextCompressionTrace,
	ContextSelectionTrace,
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

function makeSelectionTrace(): ContextSelectionTrace {
	const score = {
		relevance: 0.9,
		freshness: 1,
		authority: 0.85,
		contradictionSafety: 1,
		finalScore: 0.86,
	};

	return {
		traceId: "selection:test",
		runId: "session:test",
		promptBuildId: "prompt:test",
		taskIntent: "deep_reasoning",
		budgetTokens: 8,
		candidateSourceIds: ["kept", "rejected"],
		selectedSources: [
			{
				sourceId: "kept",
				placementRegion: "middle",
				score,
				explanation: "selected",
			},
		],
		rejectedSources: [
			{
				sourceId: "rejected",
				reason: "poisoning_risk",
				score,
				explanation: "rejected",
			},
		],
		scoreBreakdown: {
			kept: score,
			rejected: score,
		},
		orderingDecision: {
			strategy: "score_desc_timestamp_desc_input_order",
			orderedSourceIds: ["kept", "rejected"],
		},
		placementRegion: {
			kept: "middle",
			rejected: "middle",
		},
		selectionPolicyVersion: "test-selection-v1",
		determinismKey: "selection-key",
	};
}

function makeCompressionTrace(): ContextCompressionTrace {
	const score = {
		relevance: 0.9,
		authority: 0.85,
		placementPriority: 0.5,
		tokenCost: 4,
		tokenCostEstimated: false,
		tokenEfficiency: 1,
		protectedRetain: false,
		finalScore: 0.86,
	};

	return {
		traceId: "compression:test",
		budgetTokens: 8,
		usedTokens: 4,
		candidateSourceIds: ["kept"],
		decisions: [
			{
				sourceId: "kept",
				decision: "keep",
				reason: "within_budget",
				originalTokens: 4,
				outputTokens: 4,
				tokenCostEstimated: false,
				score,
				explanation: "kept",
			},
		],
		scoreBreakdown: {
			kept: score,
		},
		orderingDecision: {
			strategy:
				"protected_authority_desc_final_score_desc_token_asc_timestamp_desc_input_order",
			orderedSourceIds: ["kept"],
		},
		compressionPolicyVersion: "test-compression-v1",
		determinismKey: "compression-key",
	};
}

function makeCachePlan(): ContextCachePlan {
	return {
		cachePlanId: "cache-plan:test",
		promptBuildId: "prompt:test",
		providerPath: "local",
		modelFamily: "test-model",
		cacheStrategy: "stable-system-prefix",
		stablePrefixHash: "stable-prefix-hash",
		eligiblePrefixTokens: 4,
		dynamicSuffixTokens: 2,
		cacheBoundarySourceIds: ["kept"],
		excludedVolatileSourceIds: ["rejected"],
		retentionPolicy: "session",
		providerOptions: {},
		expectedUsageFields: ["cache_read_tokens"],
		determinismKey: "cache-key",
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

describe("buildContextDeltaStreamTrace", () => {
	it("emits resumable typed events for selection, compression, cache, summary, and delta", () => {
		const previous = makeSummary({
			sourceSummaries: [keptSource("kept")],
			usedTokens: 4,
		});
		const current = makeSummary({
			sourceSummaries: [keptSource("kept"), rejectedSource("rejected")],
			usedTokens: 4,
		});
		const traceDelta = diffContextTraceSummaries(previous, current);
		const trace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:test",
			selectionTrace: makeSelectionTrace(),
			compressionTrace: makeCompressionTrace(),
			cachePlan: makeCachePlan(),
			traceSummary: current,
			traceDelta,
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});

		expect(trace.deltaTraceId).toMatch(/^context-delta-stream:[a-f0-9]{16}$/);
		expect(trace.events.map((event) => event.eventType)).toEqual([
			"context.source_selected",
			"context.source_rejected",
			"context.source_compressed",
			"context.cache_plan_emitted",
			"context.trace_summary_emitted",
			"context.trace_delta_emitted",
		]);
		expect(trace.deliveredEventCount).toBe(6);
		expect(trace.resumeCursor).toBe(trace.events.at(-1)?.resumeCursor);
		expect(trace.events[0]).toMatchObject({
			deltaTraceId: trace.deltaTraceId,
			sessionId: "session:test",
			streamId: "stream:test",
			eventType: "context.source_selected",
			sourceHashes: {
				kept: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});
		expect(trace.events[0]?.payloadBytes).toBeGreaterThan(0);
		expect(trace.events[3]).toMatchObject({
			eventType: "context.cache_plan_emitted",
			cachePlanId: "cache-plan:test",
			stablePrefixHash: "stable-prefix-hash",
		});

		const resumed = resumeContextDeltaStreamTrace(
			trace,
			trace.events[1]?.resumeCursor,
		);

		expect(resumed.status).toBe("resumed");
		expect(resumed.skippedEventIds).toEqual([
			trace.events[0]?.eventId,
			trace.events[1]?.eventId,
		]);
		expect(resumed.events.map((event) => event.eventType)).toEqual([
			"context.source_compressed",
			"context.cache_plan_emitted",
			"context.trace_summary_emitted",
			"context.trace_delta_emitted",
		]);
	});

	it("treats the start cursor as an explicit from-start resume request", () => {
		const trace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:test",
			selectionTrace: makeSelectionTrace(),
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});
		const emptyTrace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:empty",
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});

		expect(resumeContextDeltaStreamTrace(trace)).toMatchObject({
			status: "from_start",
			events: trace.events,
			resumeCursor: trace.resumeCursor,
			skippedEventIds: [],
		});
		expect(
			resumeContextDeltaStreamTrace(trace, "context-delta:start"),
		).toMatchObject({
			status: "from_start",
			events: trace.events,
			resumeCursor: trace.resumeCursor,
			skippedEventIds: [],
		});
		expect(emptyTrace.resumeCursor).toBe("context-delta:start");
		expect(
			resumeContextDeltaStreamTrace(emptyTrace, emptyTrace.resumeCursor),
		).toEqual({
			status: "from_start",
			events: [],
			resumeCursor: "context-delta:start",
			skippedEventIds: [],
		});
	});

	it("keeps existing resume cursors stable when a later delta event is appended", () => {
		const current = makeSummary({
			sourceSummaries: [keptSource("kept"), rejectedSource("rejected")],
			usedTokens: 4,
		});
		const traceDelta = diffContextTraceSummaries(
			makeSummary({ sourceSummaries: [keptSource("kept")], usedTokens: 4 }),
			current,
		);
		const baseTrace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:test",
			selectionTrace: makeSelectionTrace(),
			compressionTrace: makeCompressionTrace(),
			cachePlan: makeCachePlan(),
			traceSummary: current,
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});
		const appendedTrace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:test",
			selectionTrace: makeSelectionTrace(),
			compressionTrace: makeCompressionTrace(),
			cachePlan: makeCachePlan(),
			traceSummary: current,
			traceDelta,
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});

		expect(appendedTrace.deltaTraceId).not.toBe(baseTrace.deltaTraceId);
		expect(
			appendedTrace.events
				.slice(0, baseTrace.events.length)
				.map((event) => event.resumeCursor),
		).toEqual(baseTrace.events.map((event) => event.resumeCursor));
		expect(appendedTrace.events.at(-1)?.eventType).toBe(
			"context.trace_delta_emitted",
		);
	});

	it("keeps the delta stream stable when cache usage fields are reordered", () => {
		const cachePlan = {
			...makeCachePlan(),
			expectedUsageFields: ["cache_write_tokens", "cache_read_tokens"],
		};
		const reorderedCachePlan = {
			...cachePlan,
			expectedUsageFields: [...cachePlan.expectedUsageFields].reverse(),
		};

		const baseTrace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:test",
			selectionTrace: makeSelectionTrace(),
			cachePlan,
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});
		const reorderedTrace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:test",
			selectionTrace: makeSelectionTrace(),
			cachePlan: reorderedCachePlan,
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});

		expect(baseTrace.deltaTraceId).toBe(reorderedTrace.deltaTraceId);
		expect(baseTrace.events.map((event) => event.eventId)).toEqual(
			reorderedTrace.events.map((event) => event.eventId),
		);
		expect(baseTrace.events[2]?.payload).toEqual(
			reorderedTrace.events[2]?.payload,
		);
		expect(baseTrace.events[2]?.payload).toMatchObject({
			cachePlan: {
				expectedUsageFields: ["cache_read_tokens", "cache_write_tokens"],
			},
		});
	});

	it("rejects unknown resume cursors instead of duplicating or skipping events", () => {
		const trace = buildContextDeltaStreamTrace({
			sessionId: "session:test",
			streamId: "stream:test",
			selectionTrace: makeSelectionTrace(),
			deliveredAt: "2026-05-06T00:00:00.000Z",
		});

		expect(resumeContextDeltaStreamTrace(trace, "missing-cursor")).toEqual({
			status: "cursor_not_found",
			events: [],
			resumeCursor: "missing-cursor",
			skippedEventIds: [],
			rejectedReason: "cursor_not_found",
		});
	});
});
