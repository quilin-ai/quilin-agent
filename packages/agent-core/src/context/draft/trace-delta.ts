import type {
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
