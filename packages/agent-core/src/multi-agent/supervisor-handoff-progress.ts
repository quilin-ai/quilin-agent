import type { DelegationHandoff } from "../planning/delegation.js";
import {
	type AggregateSupervisorProgressOptions,
	applySupervisorProgressProjectionReport,
	type ChildRunStatusRecord,
	createChildRunStatusRecord,
	projectSupervisorProgressEvents,
	type SupervisorProgressEventProjection,
	type SupervisorProgressEventSink,
	type SupervisorProgressSinkBatchReport,
} from "./supervisor-progress.js";

export interface SupervisorProgressStateFromDelegationHandoffs {
	readonly kind: "delegation_handoff_supervisor_progress_state";
	readonly schemaVersion: 1;
	readonly records: ReadonlyArray<ChildRunStatusRecord>;
	readonly projection: SupervisorProgressEventProjection;
}

function handoffSummary(handoff: DelegationHandoff): string {
	return `Queued handoff to ${handoff.receiver.role}: ${handoff.task.name}`;
}

export function createChildRunStatusRecordFromDelegationHandoff(
	handoff: DelegationHandoff,
	now = new Date().toISOString(),
): ChildRunStatusRecord {
	return createChildRunStatusRecord(
		{
			runId: handoff.childRunId,
			taskId: handoff.task.id,
			status: "queued",
			summary: handoffSummary(handoff),
			confidence: "unknown",
			reviewedArtifactCount: 0,
			lastHeartbeatAt: now,
			createdAt: now,
			updatedAt: now,
		},
		now,
	);
}

export function createSupervisorProgressStateFromDelegationHandoffs(
	handoffs: Iterable<DelegationHandoff>,
	options: AggregateSupervisorProgressOptions = {},
): SupervisorProgressStateFromDelegationHandoffs {
	const now = options.now ?? new Date().toISOString();
	const records = [...handoffs].map((handoff) =>
		createChildRunStatusRecordFromDelegationHandoff(handoff, now),
	);
	const projection = projectSupervisorProgressEvents(records, {
		...options,
		now,
	});

	return {
		kind: "delegation_handoff_supervisor_progress_state",
		schemaVersion: 1,
		records,
		projection,
	};
}

export function applyDelegationHandoffsToSupervisorProgressSink(
	sink: SupervisorProgressEventSink,
	handoffs: Iterable<DelegationHandoff>,
	options: AggregateSupervisorProgressOptions = {},
): SupervisorProgressSinkBatchReport {
	return applySupervisorProgressProjectionReport(
		sink,
		createSupervisorProgressStateFromDelegationHandoffs(handoffs, options)
			.projection,
	);
}
