import { createHash } from "node:crypto";
import type {
	ContextCachePlan,
	ContextCompressionTrace,
	ContextDeltaStreamEventType,
	ContextDeltaStreamTrace,
	ContextDeltaStreamTraceEvent,
	ContextSelectionTrace,
	ContextTraceSourceSummary,
	ContextTraceSummary,
} from "./source-types.js";

export interface ContextTraceNumericDelta {
	readonly previous: number;
	readonly current: number;
	readonly delta: number;
}

export interface ContextTraceCountDeltas {
	readonly candidateCount: ContextTraceNumericDelta;
	readonly selectedCount: ContextTraceNumericDelta;
	readonly rejectedCount: ContextTraceNumericDelta;
	readonly compressedCount: ContextTraceNumericDelta;
	readonly truncatedCount: ContextTraceNumericDelta;
	readonly droppedCount: ContextTraceNumericDelta;
	readonly sectionCount: ContextTraceNumericDelta;
}

export interface ContextTraceDecisionCountDeltas {
	readonly selected: ContextTraceNumericDelta;
	readonly rejected: ContextTraceNumericDelta;
	readonly keep: ContextTraceNumericDelta;
	readonly truncate: ContextTraceNumericDelta;
	readonly drop: ContextTraceNumericDelta;
}

export interface ContextTraceTokenDeltas {
	readonly usedTokens: ContextTraceNumericDelta;
	readonly budgetTokens: ContextTraceNumericDelta;
}

export interface ContextTraceSourceIdDeltas {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

export interface ContextTraceDelta {
	readonly traceId: string;
	readonly sourceIds: ContextTraceSourceIdDeltas;
	readonly tokenChanges: ContextTraceTokenDeltas;
	readonly countChanges: ContextTraceCountDeltas;
	readonly decisionCountChanges: ContextTraceDecisionCountDeltas;
	readonly hasChanges: boolean;
	readonly determinismKey: string;
}

export interface BuildContextDeltaStreamTraceInput {
	readonly sessionId: string;
	readonly streamId: string;
	readonly selectionTrace?: ContextSelectionTrace;
	readonly compressionTrace?: ContextCompressionTrace;
	readonly cachePlan?: ContextCachePlan;
	readonly traceSummary?: ContextTraceSummary;
	readonly traceDelta?: ContextTraceDelta;
	readonly cancellationReason?: string;
	readonly deliveredAt?: string;
}

export type ContextDeltaStreamResumeStatus =
	| "from_start"
	| "resumed"
	| "cursor_not_found";

export const CONTEXT_DELTA_STREAM_START_CURSOR = "context-delta:start";

export interface ContextDeltaStreamResumeResult {
	readonly status: ContextDeltaStreamResumeStatus;
	readonly events: readonly ContextDeltaStreamTraceEvent[];
	readonly resumeCursor: string;
	readonly skippedEventIds: readonly string[];
	readonly rejectedReason?: "cursor_not_found";
}

interface ContextDeltaStreamEventSpec {
	readonly eventType: ContextDeltaStreamEventType;
	readonly sourceIds: readonly string[];
	readonly stablePrefixHash?: string;
	readonly cachePlanId?: string;
	readonly payload: Readonly<Record<string, unknown>>;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}

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

	return JSON.stringify(value) ?? "undefined";
}

function payloadByteLength(payload: Readonly<Record<string, unknown>>): number {
	return new TextEncoder().encode(stableStringify(payload)).byteLength;
}

function normalizeExpectedUsageFields(
	value: readonly string[],
): readonly string[] {
	return [...new Set(value)].toSorted();
}

function normalizeCachePlanForTrace(
	cachePlan: ContextCachePlan,
): ContextCachePlan {
	return {
		...cachePlan,
		expectedUsageFields: normalizeExpectedUsageFields(
			cachePlan.expectedUsageFields,
		),
	};
}

function numericDelta(
	previous: number,
	current: number,
): ContextTraceNumericDelta {
	return {
		previous,
		current,
		delta: current - previous,
	};
}

function formatNumericDelta(change: ContextTraceNumericDelta): string {
	return `${change.previous}->${change.current}(${change.delta})`;
}

function sourceSummaryKey(summary: ContextTraceSourceSummary): string {
	return [
		summary.sourceId,
		summary.selection,
		summary.rejectionReason ?? "",
		summary.compressionDecision ?? "",
		summary.compressionReason ?? "",
		summary.originalTokens ?? "",
		summary.outputTokens,
	].join(":");
}

function sourceSummaryMap(
	summary: ContextTraceSummary,
): ReadonlyMap<string, ContextTraceSourceSummary> {
	return new Map(
		summary.sourceSummaries.map((sourceSummary) => [
			sourceSummary.sourceId,
			sourceSummary,
		]),
	);
}

function sortedSourceIds(summary: ContextTraceSummary): readonly string[] {
	return [
		...new Set(summary.sourceSummaries.map(({ sourceId }) => sourceId)),
	].toSorted();
}

function containsAnyChange(
	changes: readonly ContextTraceNumericDelta[],
): boolean {
	return changes.some((change) => change.delta !== 0);
}

function sourceHashesForSpec(
	spec: ContextDeltaStreamEventSpec,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		[...new Set(spec.sourceIds)]
			.toSorted()
			.map((sourceId) => [
				sourceId,
				sha256(stableStringify({ payload: spec.payload, sourceId })),
			]),
	);
}

function eventPayloadHash(spec: ContextDeltaStreamEventSpec): string {
	return sha256(
		stableStringify({
			cachePlanId: spec.cachePlanId,
			eventType: spec.eventType,
			payload: spec.payload,
			sourceIds: [...new Set(spec.sourceIds)].toSorted(),
			stablePrefixHash: spec.stablePrefixHash,
		}),
	);
}

function buildEventSpecs(
	input: BuildContextDeltaStreamTraceInput,
): readonly ContextDeltaStreamEventSpec[] {
	const specs: ContextDeltaStreamEventSpec[] = [];
	const cachePlan =
		input.cachePlan == null
			? undefined
			: normalizeCachePlanForTrace(input.cachePlan);

	for (const selectedSource of input.selectionTrace?.selectedSources ?? []) {
		specs.push({
			eventType: "context.source_selected",
			sourceIds: [selectedSource.sourceId],
			payload: {
				selectionTraceId: input.selectionTrace?.traceId,
				selectedSource,
			},
		});
	}

	for (const rejectedSource of input.selectionTrace?.rejectedSources ?? []) {
		specs.push({
			eventType: "context.source_rejected",
			sourceIds: [rejectedSource.sourceId],
			payload: {
				selectionTraceId: input.selectionTrace?.traceId,
				rejectedSource,
			},
		});
	}

	for (const decision of input.compressionTrace?.decisions ?? []) {
		specs.push({
			eventType: "context.source_compressed",
			sourceIds: [decision.sourceId],
			payload: {
				compressionTraceId: input.compressionTrace?.traceId,
				decision,
			},
		});
	}

	if (cachePlan != null) {
		specs.push({
			eventType: "context.cache_plan_emitted",
			sourceIds: [
				...cachePlan.cacheBoundarySourceIds,
				...cachePlan.excludedVolatileSourceIds,
			],
			stablePrefixHash: cachePlan.stablePrefixHash,
			cachePlanId: cachePlan.cachePlanId,
			payload: {
				cachePlan,
			},
		});
	}

	if (input.traceSummary != null) {
		specs.push({
			eventType: "context.trace_summary_emitted",
			sourceIds: input.traceSummary.sourceSummaries.map(
				(summary) => summary.sourceId,
			),
			stablePrefixHash: input.cachePlan?.stablePrefixHash,
			cachePlanId: input.cachePlan?.cachePlanId,
			payload: {
				traceSummary: input.traceSummary,
			},
		});
	}

	if (input.traceDelta != null) {
		specs.push({
			eventType: "context.trace_delta_emitted",
			sourceIds: [
				...input.traceDelta.sourceIds.added,
				...input.traceDelta.sourceIds.removed,
				...input.traceDelta.sourceIds.changed,
			],
			stablePrefixHash: input.cachePlan?.stablePrefixHash,
			cachePlanId: input.cachePlan?.cachePlanId,
			payload: {
				traceDelta: input.traceDelta,
			},
		});
	}

	if (input.cancellationReason != null) {
		specs.push({
			eventType: "context.cancelled",
			sourceIds: [],
			stablePrefixHash: input.cachePlan?.stablePrefixHash,
			cachePlanId: input.cachePlan?.cachePlanId,
			payload: {
				reason: input.cancellationReason,
			},
		});
	}

	return specs;
}

function buildDeltaStreamEvent(
	spec: ContextDeltaStreamEventSpec,
	input: {
		readonly deltaTraceId: string;
		readonly sessionId: string;
		readonly streamId: string;
		readonly index: number;
		readonly deliveredAt: string;
	},
): ContextDeltaStreamTraceEvent {
	const payloadHash = eventPayloadHash(spec);
	const eventId = `context-delta-event:${sha256(
		[
			input.sessionId,
			input.streamId,
			input.index,
			spec.eventType,
			payloadHash,
		].join("|"),
	).slice(0, 16)}`;
	const dedupeKey = sha256(
		[input.sessionId, input.streamId, spec.eventType, payloadHash].join("|"),
	);

	return {
		deltaTraceId: input.deltaTraceId,
		sessionId: input.sessionId,
		streamId: input.streamId,
		eventId,
		eventType: spec.eventType,
		sourceHashes: sourceHashesForSpec(spec),
		...(spec.stablePrefixHash == null
			? {}
			: { stablePrefixHash: spec.stablePrefixHash }),
		...(spec.cachePlanId == null ? {} : { cachePlanId: spec.cachePlanId }),
		resumeCursor: eventId,
		payloadBytes: payloadByteLength(spec.payload),
		dedupeKey,
		deliveredAt: input.deliveredAt,
		payload: spec.payload,
	};
}

export function diffContextTraceSummaries(
	previous: ContextTraceSummary,
	current: ContextTraceSummary,
): ContextTraceDelta {
	const previousBySourceId = sourceSummaryMap(previous);
	const currentBySourceId = sourceSummaryMap(current);
	const previousSourceIds = sortedSourceIds(previous);
	const currentSourceIds = sortedSourceIds(current);
	const previousSourceIdSet = new Set(previousSourceIds);
	const currentSourceIdSet = new Set(currentSourceIds);
	const added = currentSourceIds.filter(
		(sourceId) => !previousSourceIdSet.has(sourceId),
	);
	const removed = previousSourceIds.filter(
		(sourceId) => !currentSourceIdSet.has(sourceId),
	);
	const changed = currentSourceIds.filter((sourceId) => {
		const previousSource = previousBySourceId.get(sourceId);
		const currentSource = currentBySourceId.get(sourceId);

		return (
			previousSource != null &&
			currentSource != null &&
			sourceSummaryKey(previousSource) !== sourceSummaryKey(currentSource)
		);
	});
	const tokenChanges = {
		usedTokens: numericDelta(previous.usedTokens, current.usedTokens),
		budgetTokens: numericDelta(previous.budgetTokens, current.budgetTokens),
	};
	const countChanges = {
		candidateCount: numericDelta(
			previous.candidateCount,
			current.candidateCount,
		),
		selectedCount: numericDelta(previous.selectedCount, current.selectedCount),
		rejectedCount: numericDelta(previous.rejectedCount, current.rejectedCount),
		compressedCount: numericDelta(
			previous.compressedCount,
			current.compressedCount,
		),
		truncatedCount: numericDelta(
			previous.truncatedCount,
			current.truncatedCount,
		),
		droppedCount: numericDelta(previous.droppedCount, current.droppedCount),
		sectionCount: numericDelta(previous.sectionCount, current.sectionCount),
	};
	const decisionCountChanges = {
		selected: numericDelta(
			previous.decisionCounts.selected,
			current.decisionCounts.selected,
		),
		rejected: numericDelta(
			previous.decisionCounts.rejected,
			current.decisionCounts.rejected,
		),
		keep: numericDelta(
			previous.decisionCounts.keep,
			current.decisionCounts.keep,
		),
		truncate: numericDelta(
			previous.decisionCounts.truncate,
			current.decisionCounts.truncate,
		),
		drop: numericDelta(
			previous.decisionCounts.drop,
			current.decisionCounts.drop,
		),
	};
	const numericChanges = [
		...Object.values(tokenChanges),
		...Object.values(countChanges),
		...Object.values(decisionCountChanges),
	];
	const hasChanges =
		added.length > 0 ||
		removed.length > 0 ||
		changed.length > 0 ||
		containsAnyChange(numericChanges);
	const determinismKey = [
		`added=${added.join(",")}`,
		`removed=${removed.join(",")}`,
		`changed=${changed.join(",")}`,
		`tokens=used:${formatNumericDelta(tokenChanges.usedTokens)},budget:${formatNumericDelta(tokenChanges.budgetTokens)}`,
		`counts=candidate:${formatNumericDelta(countChanges.candidateCount)},selected:${formatNumericDelta(countChanges.selectedCount)},rejected:${formatNumericDelta(countChanges.rejectedCount)},compressed:${formatNumericDelta(countChanges.compressedCount)},truncated:${formatNumericDelta(countChanges.truncatedCount)},dropped:${formatNumericDelta(countChanges.droppedCount)},sections:${formatNumericDelta(countChanges.sectionCount)}`,
		`decisions=selected:${formatNumericDelta(decisionCountChanges.selected)},rejected:${formatNumericDelta(decisionCountChanges.rejected)},keep:${formatNumericDelta(decisionCountChanges.keep)},truncate:${formatNumericDelta(decisionCountChanges.truncate)},drop:${formatNumericDelta(decisionCountChanges.drop)}`,
	].join("|");

	return {
		traceId: `trace-delta:${determinismKey}`,
		sourceIds: {
			added,
			removed,
			changed,
		},
		tokenChanges,
		countChanges,
		decisionCountChanges,
		hasChanges,
		determinismKey,
	};
}

export function buildContextDeltaStreamTrace(
	input: BuildContextDeltaStreamTraceInput,
): ContextDeltaStreamTrace {
	const specs = buildEventSpecs(input);
	const deliveredAt = input.deliveredAt ?? new Date().toISOString();
	const determinismKey = [
		`session=${input.sessionId}`,
		`stream=${input.streamId}`,
		`selection=${input.selectionTrace?.traceId ?? ""}`,
		`compression=${input.compressionTrace?.traceId ?? ""}`,
		`cache=${input.cachePlan?.cachePlanId ?? ""}`,
		`summary=${input.traceSummary?.traceId ?? ""}`,
		`delta=${input.traceDelta?.traceId ?? ""}`,
		`cancelled=${input.cancellationReason ?? ""}`,
		`events=${specs
			.map((spec) => `${spec.eventType}:${eventPayloadHash(spec)}`)
			.join(",")}`,
	].join("|");
	const deltaTraceId = `context-delta-stream:${sha256(determinismKey).slice(
		0,
		16,
	)}`;
	const events = specs.map((spec, index) =>
		buildDeltaStreamEvent(spec, {
			deltaTraceId,
			sessionId: input.sessionId,
			streamId: input.streamId,
			index,
			deliveredAt,
		}),
	);
	const resumeCursor =
		events.at(-1)?.resumeCursor ?? CONTEXT_DELTA_STREAM_START_CURSOR;

	return {
		deltaTraceId,
		sessionId: input.sessionId,
		streamId: input.streamId,
		events,
		resumeCursor,
		deliveredEventCount: events.length,
		determinismKey,
	};
}

export function resumeContextDeltaStreamTrace(
	trace: ContextDeltaStreamTrace,
	resumeCursor?: string,
): ContextDeltaStreamResumeResult {
	if (
		resumeCursor == null ||
		resumeCursor.length === 0 ||
		resumeCursor === CONTEXT_DELTA_STREAM_START_CURSOR
	) {
		return {
			status: "from_start",
			events: trace.events,
			resumeCursor: trace.resumeCursor,
			skippedEventIds: [],
		};
	}

	const cursorIndex = trace.events.findIndex(
		(event) =>
			event.resumeCursor === resumeCursor || event.eventId === resumeCursor,
	);
	if (cursorIndex < 0) {
		return {
			status: "cursor_not_found",
			events: [],
			resumeCursor,
			skippedEventIds: [],
			rejectedReason: "cursor_not_found",
		};
	}

	const events = trace.events.slice(cursorIndex + 1);

	return {
		status: "resumed",
		events,
		resumeCursor: events.at(-1)?.resumeCursor ?? resumeCursor,
		skippedEventIds: trace.events
			.slice(0, cursorIndex + 1)
			.map((event) => event.eventId),
	};
}
