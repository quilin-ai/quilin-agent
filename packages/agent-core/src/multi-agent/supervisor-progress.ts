export type ChildRunStatus =
	| "queued"
	| "assigned"
	| "active"
	| "blocked"
	| "waiting_for_review"
	| "aggregating"
	| "cancel_requested"
	| "completed"
	| "failed"
	| "cancelled"
	| "deferred";

export type DurableRuntimePlanStatus =
	| "queued"
	| "running"
	| "checkpointed"
	| "cancel_requested"
	| "cancelled"
	| "retrying"
	| "failed"
	| "completed";

export type TerminalChildRunStatus = Extract<
	ChildRunStatus,
	"completed" | "failed" | "cancelled" | "deferred"
>;

export type SupervisorProgressBand =
	| "idle"
	| "starting"
	| "making_progress"
	| "blocked"
	| "reviewing"
	| "wrapping_up"
	| "done"
	| "failed";

export type SupervisorConfidence = "unknown" | "low" | "medium" | "high";

export interface ChildRunProgress {
	readonly completedSteps: number;
	readonly totalSteps: number;
	readonly label?: string;
}

export interface ChildRunStatusRecord {
	readonly runId: string;
	readonly taskId: string;
	readonly workerId?: string;
	readonly status: ChildRunStatus;
	readonly summary: string;
	readonly currentStep?: string;
	readonly progress?: ChildRunProgress;
	readonly blocker?: string;
	readonly confidence: SupervisorConfidence;
	readonly reviewedArtifactCount: number;
	readonly lastHeartbeatAt: string;
	readonly nextCheckpointAt?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface CreateChildRunStatusRecordInput {
	readonly runId: string;
	readonly taskId: string;
	readonly workerId?: string;
	readonly status?: ChildRunStatus;
	readonly summary?: string;
	readonly currentStep?: string;
	readonly progress?: ChildRunProgress;
	readonly blocker?: string;
	readonly confidence?: SupervisorConfidence;
	readonly reviewedArtifactCount?: number;
	readonly lastHeartbeatAt?: string;
	readonly nextCheckpointAt?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}

export interface ChildRunHeartbeat {
	readonly status?: ChildRunStatus;
	readonly summary?: string;
	readonly currentStep?: string | null;
	readonly progress?: ChildRunProgress | null;
	readonly blocker?: string | null;
	readonly confidence?: SupervisorConfidence;
	readonly reviewedArtifactCount?: number;
	readonly nextCheckpointAt?: string | null;
}

export interface AggregateSupervisorProgressOptions {
	readonly now?: string;
	readonly staleAfterMs?: number;
}

export interface SupervisorProgressSnapshot {
	readonly generatedAt: string;
	readonly totalRuns: number;
	readonly counts: Readonly<Record<ChildRunStatus, number>>;
	readonly activeRunIds: readonly string[];
	readonly queuedRunIds: readonly string[];
	readonly blockedRunIds: readonly string[];
	readonly staleRunIds: readonly string[];
	readonly terminalRunIds: readonly string[];
	readonly oldestHeartbeatAgeMs: number | null;
	readonly nextCheckpointAt: string | null;
	readonly band: SupervisorProgressBand;
	readonly boundedPercent: number | null;
	readonly currentSteps: readonly string[];
	readonly blockers: readonly string[];
	readonly reviewedArtifactCount: number;
	readonly confidence: SupervisorConfidence;
}

export type SupervisorProgressEventType =
	| "progress_snapshot"
	| "child_stale"
	| "child_heartbeat"
	| "child_checkpoint"
	| "terminal_children_summary";

export type SupervisorProgressEventSeverity =
	| "info"
	| "warning"
	| "success"
	| "error";

export type SupervisorProgressSinkBatchAttentionStatus =
	| "healthy"
	| "needs_attention"
	| "empty";

export interface SupervisorProgressSnapshotEvent {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly type: "progress_snapshot";
	readonly severity: SupervisorProgressEventSeverity;
	readonly occurredAt: string;
	readonly payload: {
		readonly generatedAt: string;
		readonly band: SupervisorProgressBand;
		readonly totalRuns: number;
		readonly counts: Readonly<Record<ChildRunStatus, number>>;
		readonly activeRunIds: readonly string[];
		readonly queuedRunIds: readonly string[];
		readonly blockedRunIds: readonly string[];
		readonly staleRunIds: readonly string[];
		readonly terminalRunIds: readonly string[];
		readonly boundedPercent: number | null;
		readonly confidence: SupervisorConfidence;
		readonly reviewedArtifactCount: number;
		readonly nextCheckpointAt: string | null;
	};
}

export interface SupervisorChildHeartbeatEvent {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly type: "child_heartbeat";
	readonly severity: SupervisorProgressEventSeverity;
	readonly occurredAt: string;
	readonly runId: string;
	readonly taskId: string;
	readonly payload: {
		readonly workerId?: string;
		readonly status: ChildRunStatus;
		readonly summary: string;
		readonly currentStep?: string;
		readonly progress?: ChildRunProgress;
		readonly blocker?: string;
		readonly confidence: SupervisorConfidence;
		readonly reviewedArtifactCount: number;
		readonly lastHeartbeatAt: string;
		readonly heartbeatAgeMs: number;
	};
}

export interface SupervisorChildCheckpointEvent {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly type: "child_checkpoint";
	readonly severity: SupervisorProgressEventSeverity;
	readonly occurredAt: string;
	readonly runId: string;
	readonly taskId: string;
	readonly payload: {
		readonly workerId?: string;
		readonly status: ChildRunStatus;
		readonly nextCheckpointAt: string;
		readonly dueInMs: number;
		readonly isDue: boolean;
	};
}

export interface SupervisorChildStaleEvent {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly type: "child_stale";
	readonly severity: "warning";
	readonly occurredAt: string;
	readonly runId: string;
	readonly taskId: string;
	readonly payload: {
		readonly workerId?: string;
		readonly status: ChildRunStatus;
		readonly summary: string;
		readonly lastHeartbeatAt: string;
		readonly heartbeatAgeMs: number;
		readonly staleAfterMs: number;
	};
}

export interface TerminalChildSummary {
	readonly runId: string;
	readonly taskId: string;
	readonly status: TerminalChildRunStatus;
	readonly summary: string;
	readonly updatedAt: string;
}

export interface SupervisorTerminalChildrenSummaryEvent {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly type: "terminal_children_summary";
	readonly severity: SupervisorProgressEventSeverity;
	readonly occurredAt: string;
	readonly payload: {
		readonly total: number;
		readonly counts: Readonly<Record<TerminalChildRunStatus, number>>;
		readonly children: readonly TerminalChildSummary[];
	};
}

export type SupervisorProgressEvent =
	| SupervisorProgressSnapshotEvent
	| SupervisorChildStaleEvent
	| SupervisorChildHeartbeatEvent
	| SupervisorChildCheckpointEvent
	| SupervisorTerminalChildrenSummaryEvent;

export type SupervisorChildEventType =
	| "heartbeat"
	| "checkpoint"
	| "completion"
	| "blocked"
	| "stale"
	| "recovery";

export type SupervisorChildRecoveryReason =
	| "stale"
	| "failed"
	| "crashed"
	| "manual";

export interface SupervisorChildRecordSnapshot {
	readonly runId: string;
	readonly taskId: string;
	readonly workerId?: string;
	readonly status: ChildRunStatus;
	readonly summary: string;
	readonly currentStep?: string;
	readonly progress?: ChildRunProgress;
	readonly blocker?: string;
	readonly confidence: SupervisorConfidence;
	readonly reviewedArtifactCount: number;
	readonly lastHeartbeatAt: string;
	readonly nextCheckpointAt?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface SupervisorChildRecoveryHistoryEntry {
	readonly sequence: number;
	readonly type: SupervisorChildEventType;
	readonly occurredAt: string;
	readonly summary: string;
	readonly status?: ChildRunStatus;
	readonly currentStep?: string;
	readonly blocker?: string;
}

export interface SupervisorChildCheckpointSummary {
	readonly sequence: number;
	readonly occurredAt: string;
	readonly nextCheckpointAt: string;
	readonly summary: string;
	readonly currentStep?: string;
	readonly progress?: ChildRunProgress;
}

export interface SupervisorChildArtifactSummary {
	readonly kind: "handoff_argument" | "reviewed_artifacts";
	readonly label: string;
	readonly value?: string;
	readonly count?: number;
}

export interface SupervisorChildPendingInputSummary {
	readonly id: string;
	readonly kind: string;
	readonly contentPreview: string;
	readonly metadataKeys: readonly string[];
	readonly createdAt: string;
}

export interface SupervisorChildHandoffSummary {
	readonly parentRunId: string;
	readonly taskName: string;
	readonly taskDescription: string;
	readonly receiverRole: string;
	readonly receiverGoal: string;
	readonly requiredCapabilities: readonly string[];
	readonly risk: string;
}

export interface SupervisorChildRecoveryContextSnapshot {
	readonly generatedAt: string;
	readonly heartbeatAgeMs: number;
	readonly record: SupervisorChildRecordSnapshot;
	readonly pendingInputs: readonly SupervisorChildPendingInputSummary[];
	readonly history: readonly SupervisorChildRecoveryHistoryEntry[];
	readonly checkpoints: readonly SupervisorChildCheckpointSummary[];
	readonly artifacts: readonly SupervisorChildArtifactSummary[];
	readonly handoff?: SupervisorChildHandoffSummary;
}

export interface SupervisorChildRecoveryPlan {
	readonly id: string;
	readonly reason: SupervisorChildRecoveryReason;
	readonly generatedAt: string;
	readonly runId: string;
	readonly taskId: string;
	readonly status: ChildRunStatus;
	readonly summary: string;
	readonly suggestedAction: string;
	readonly context: SupervisorChildRecoveryContextSnapshot;
}

interface SupervisorChildEventBase {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly sequence: number;
	readonly type: SupervisorChildEventType;
	readonly severity: SupervisorProgressEventSeverity;
	readonly occurredAt: string;
	readonly runId: string;
	readonly taskId: string;
}

export interface SupervisorChildHeartbeatNotification
	extends SupervisorChildEventBase {
	readonly type: "heartbeat";
	readonly payload: {
		readonly record: SupervisorChildRecordSnapshot;
		readonly heartbeatAgeMs: number;
		readonly previousStatus?: ChildRunStatus;
	};
}

export interface SupervisorChildCheckpointNotification
	extends SupervisorChildEventBase {
	readonly type: "checkpoint";
	readonly payload: {
		readonly record: SupervisorChildRecordSnapshot;
		readonly nextCheckpointAt: string;
		readonly dueInMs: number;
	};
}

export interface SupervisorChildCompletionNotification
	extends SupervisorChildEventBase {
	readonly type: "completion";
	readonly severity: SupervisorProgressEventSeverity;
	readonly payload: {
		readonly record: SupervisorChildRecordSnapshot & {
			readonly status: TerminalChildRunStatus;
		};
		readonly previousStatus?: ChildRunStatus;
	};
}

export interface SupervisorChildBlockedNotification
	extends SupervisorChildEventBase {
	readonly type: "blocked";
	readonly severity: "warning";
	readonly payload: {
		readonly record: SupervisorChildRecordSnapshot;
		readonly blocker: string;
		readonly currentStep?: string;
	};
}

export interface SupervisorChildStaleNotification
	extends SupervisorChildEventBase {
	readonly type: "stale";
	readonly severity: "warning";
	readonly payload: {
		readonly record: SupervisorChildRecordSnapshot;
		readonly heartbeatAgeMs: number;
		readonly staleAfterMs: number;
	};
}

export interface SupervisorChildRecoveryNotification
	extends SupervisorChildEventBase {
	readonly type: "recovery";
	readonly severity: "warning";
	readonly payload: {
		readonly plan: SupervisorChildRecoveryPlan;
	};
}

export type SupervisorChildEvent =
	| SupervisorChildHeartbeatNotification
	| SupervisorChildCheckpointNotification
	| SupervisorChildCompletionNotification
	| SupervisorChildBlockedNotification
	| SupervisorChildStaleNotification
	| SupervisorChildRecoveryNotification;

export type SupervisorChildNotification = SupervisorChildEvent;

export interface SupervisorProgressEventProjection {
	readonly snapshot: SupervisorProgressSnapshot;
	readonly events: readonly SupervisorProgressEvent[];
}

export interface SupervisorProgressSinkFlushResult {
	readonly events: readonly SupervisorProgressEvent[];
	readonly counts: Readonly<Record<SupervisorProgressEventType, number>>;
	readonly severities: Readonly<
		Record<SupervisorProgressEventSeverity, number>
	>;
	readonly cursor: string | null;
	readonly latestOccurredAt: string | null;
}

export interface SupervisorProgressSinkBatchSummary {
	readonly flushCount: number;
	readonly totalEvents: number;
	readonly byType: Readonly<Record<SupervisorProgressEventType, number>>;
	readonly bySeverity: Readonly<
		Record<SupervisorProgressEventSeverity, number>
	>;
	readonly latestOccurredAt: string | null;
	readonly cursors: readonly string[];
	readonly emptyFlushCount: number;
}

export interface SupervisorProgressSinkBatchAttentionSummary {
	readonly status: SupervisorProgressSinkBatchAttentionStatus;
	readonly totalEvents: number;
	readonly warningCount: number;
	readonly errorCount: number;
}

export interface SupervisorProgressSinkBatchReport {
	readonly batch: SupervisorProgressSinkBatchSummary;
	readonly attention: SupervisorProgressSinkBatchAttentionSummary;
}

export interface SupervisorProgressEventSink {
	readonly record: (event: SupervisorProgressEvent) => void;
	readonly flush: () => SupervisorProgressSinkFlushResult;
}

const CHILD_RUN_STATUSES = [
	"queued",
	"assigned",
	"active",
	"blocked",
	"waiting_for_review",
	"aggregating",
	"cancel_requested",
	"completed",
	"failed",
	"cancelled",
	"deferred",
] as const satisfies readonly ChildRunStatus[];

const CHILD_RUN_STATUS_SET = new Set<string>(CHILD_RUN_STATUSES);

const SUPERVISOR_CONFIDENCES = [
	"unknown",
	"low",
	"medium",
	"high",
] as const satisfies readonly SupervisorConfidence[];

const SUPERVISOR_CONFIDENCE_SET = new Set<string>(SUPERVISOR_CONFIDENCES);

const TERMINAL_STATUSES = new Set<TerminalChildRunStatus>([
	"completed",
	"failed",
	"cancelled",
	"deferred",
]);

const QUEUED_STATUSES = new Set<ChildRunStatus>(["queued", "assigned"]);
const ACTIVE_STATUSES = new Set<ChildRunStatus>([
	"active",
	"blocked",
	"waiting_for_review",
	"aggregating",
	"cancel_requested",
]);

const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000;

const SUPERVISOR_PROGRESS_EVENT_TYPES = [
	"progress_snapshot",
	"child_stale",
	"child_heartbeat",
	"child_checkpoint",
	"terminal_children_summary",
] as const satisfies readonly SupervisorProgressEventType[];

const SUPERVISOR_PROGRESS_EVENT_TYPE_SET = new Set<string>(
	SUPERVISOR_PROGRESS_EVENT_TYPES,
);

const SUPERVISOR_PROGRESS_EVENT_SEVERITIES = [
	"info",
	"warning",
	"success",
	"error",
] as const satisfies readonly SupervisorProgressEventSeverity[];

const SUPERVISOR_PROGRESS_EVENT_SEVERITY_SET = new Set<string>(
	SUPERVISOR_PROGRESS_EVENT_SEVERITIES,
);

const EVENT_TYPE_ORDER: Readonly<Record<SupervisorProgressEventType, number>> =
	Object.fromEntries(
		SUPERVISOR_PROGRESS_EVENT_TYPES.map((type, index) => [type, index]),
	) as Readonly<Record<SupervisorProgressEventType, number>>;

const CONFIDENCE_RANK: Readonly<Record<SupervisorConfidence, number>> = {
	unknown: 0,
	low: 1,
	medium: 2,
	high: 3,
};

function assertNever(value: never): never {
	throw new Error(`Unexpected supervisor progress value: ${String(value)}`);
}

export function childRunStatusToDurableRuntimePlanStatus(
	status: ChildRunStatus,
): DurableRuntimePlanStatus {
	switch (status) {
		case "queued":
		case "assigned":
			return "queued";
		case "waiting_for_review":
			return "checkpointed";
		case "cancel_requested":
			return "cancel_requested";
		case "cancelled":
		case "deferred":
			return "cancelled";
		case "failed":
		case "completed":
			return status;
		case "active":
		case "blocked":
		case "aggregating":
			return "running";
		default:
			return assertNever(status);
	}
}

function assertNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) {
		throw new RangeError(`${name} must be a non-empty string`);
	}
}

function assertTimestamp(value: string, name: string): void {
	if (!Number.isFinite(Date.parse(value))) {
		throw new RangeError(`${name} must be an ISO-compatible timestamp`);
	}
}

function assertChildRunStatus(value: ChildRunStatus, name: string): void {
	if (!CHILD_RUN_STATUS_SET.has(value)) {
		throw new RangeError(`${name} must be a known child run status`);
	}
}

function assertSupervisorConfidence(
	value: SupervisorConfidence,
	name: string,
): void {
	if (!SUPERVISOR_CONFIDENCE_SET.has(value)) {
		throw new RangeError(`${name} must be a known supervisor confidence`);
	}
}

function normalizeProgress(
	progress: ChildRunProgress | undefined,
): ChildRunProgress | undefined {
	if (progress == null) {
		return undefined;
	}

	if (
		!Number.isInteger(progress.completedSteps) ||
		!Number.isInteger(progress.totalSteps) ||
		progress.completedSteps < 0 ||
		progress.totalSteps < 1 ||
		progress.completedSteps > progress.totalSteps
	) {
		throw new RangeError(
			"progress must use integer completedSteps between 0 and totalSteps",
		);
	}

	return progress;
}

function assertNonNegativeInteger(
	value: number | undefined,
	name: string,
): void {
	if (value != null && (!Number.isInteger(value) || value < 0)) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
}

function optionalField<T>(
	nextValue: T | null | undefined,
	previousValue: T | undefined,
): T | undefined {
	return nextValue === null ? undefined : (nextValue ?? previousValue);
}

function optionalProgress(
	nextValue: ChildRunProgress | null | undefined,
	previousValue: ChildRunProgress | undefined,
): ChildRunProgress | undefined {
	if (nextValue === null) {
		return undefined;
	}

	return nextValue === undefined ? previousValue : normalizeProgress(nextValue);
}

function withoutLiveOnlyFields(
	record: ChildRunStatusRecord,
): ChildRunStatusRecord {
	if (!isTerminalStatus(record.status)) {
		return record;
	}

	const {
		currentStep: _currentStep,
		progress: _progress,
		blocker: _blocker,
		nextCheckpointAt: _nextCheckpointAt,
		...terminalRecord
	} = record;

	return terminalRecord;
}

function isTerminalStatus(
	status: ChildRunStatus,
): status is TerminalChildRunStatus {
	return (TERMINAL_STATUSES as ReadonlySet<ChildRunStatus>).has(status);
}

function isTerminalRecord(
	record: ChildRunStatusRecord,
): record is ChildRunStatusRecord & {
	readonly status: TerminalChildRunStatus;
} {
	return isTerminalStatus(record.status);
}

function sorted(values: readonly string[]): readonly string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

function heartbeatAgeMs(record: ChildRunStatusRecord, nowMs: number): number {
	return Math.max(0, nowMs - Date.parse(record.lastHeartbeatAt));
}

function checkpointDueInMs(nextCheckpointAt: string, nowMs: number): number {
	return Math.max(0, Date.parse(nextCheckpointAt) - nowMs);
}

function createEmptyCounts(): Record<ChildRunStatus, number> {
	return Object.fromEntries(
		CHILD_RUN_STATUSES.map((status) => [status, 0]),
	) as Record<ChildRunStatus, number>;
}

function createEmptyTerminalCounts(): Record<TerminalChildRunStatus, number> {
	return {
		completed: 0,
		failed: 0,
		cancelled: 0,
		deferred: 0,
	};
}

function lowestConfidence(
	records: readonly ChildRunStatusRecord[],
): SupervisorConfidence {
	let current: SupervisorConfidence = "high";

	for (const record of records) {
		if (CONFIDENCE_RANK[record.confidence] < CONFIDENCE_RANK[current]) {
			current = record.confidence;
		}
	}

	return records.length === 0 ? "unknown" : current;
}

function earliestCheckpoint(
	records: readonly ChildRunStatusRecord[],
): string | null {
	const checkpoints = records
		.filter((record) => !isTerminalStatus(record.status))
		.map((record) => record.nextCheckpointAt)
		.filter((value): value is string => value != null)
		.sort((left, right) => Date.parse(left) - Date.parse(right));

	return checkpoints[0] ?? null;
}

function determineBand(
	records: readonly ChildRunStatusRecord[],
	counts: Readonly<Record<ChildRunStatus, number>>,
): SupervisorProgressBand {
	if (records.length === 0) {
		return "idle";
	}

	const nonTerminalCount = records.filter(
		(record) => !isTerminalStatus(record.status),
	).length;

	if (nonTerminalCount === 0) {
		return counts.failed + counts.cancelled > 0 ? "failed" : "done";
	}

	if (records.some((record) => record.status === "blocked" || record.blocker)) {
		return "blocked";
	}

	if (counts.waiting_for_review > 0) {
		return "reviewing";
	}

	if (counts.aggregating + counts.cancel_requested > 0) {
		return "wrapping_up";
	}

	if (counts.active > 0) {
		return "making_progress";
	}

	return "starting";
}

function boundedPercent(
	records: readonly ChildRunStatusRecord[],
): number | null {
	const nonTerminal = records.filter(
		(record) => !isTerminalStatus(record.status),
	);
	if (nonTerminal.length === 0) {
		return null;
	}

	if (nonTerminal.some((record) => record.progress == null)) {
		return null;
	}

	const totals = nonTerminal.reduce(
		(acc, record) => {
			const progress = record.progress as ChildRunProgress;
			return {
				completedSteps: acc.completedSteps + progress.completedSteps,
				totalSteps: acc.totalSteps + progress.totalSteps,
			};
		},
		{ completedSteps: 0, totalSteps: 0 },
	);

	return Math.round((totals.completedSteps / totals.totalSteps) * 1000) / 10;
}

function compareChildRecords(
	left: ChildRunStatusRecord,
	right: ChildRunStatusRecord,
): number {
	return (
		left.runId.localeCompare(right.runId) ||
		left.taskId.localeCompare(right.taskId)
	);
}

function compareTerminalChildren(
	left: TerminalChildSummary,
	right: TerminalChildSummary,
): number {
	return (
		left.runId.localeCompare(right.runId) ||
		left.taskId.localeCompare(right.taskId)
	);
}

function eventRunId(event: SupervisorProgressEvent): string {
	return "runId" in event ? event.runId : "";
}

function compareEvents(
	left: SupervisorProgressEvent,
	right: SupervisorProgressEvent,
): number {
	return (
		EVENT_TYPE_ORDER[left.type] - EVENT_TYPE_ORDER[right.type] ||
		left.occurredAt.localeCompare(right.occurredAt) ||
		eventRunId(left).localeCompare(eventRunId(right)) ||
		left.id.localeCompare(right.id)
	);
}

function createEmptyEventCounts(): Record<SupervisorProgressEventType, number> {
	return Object.fromEntries(
		SUPERVISOR_PROGRESS_EVENT_TYPES.map((type) => [type, 0]),
	) as Record<SupervisorProgressEventType, number>;
}

function createEmptySeverityCounts(): Record<
	SupervisorProgressEventSeverity,
	number
> {
	return Object.fromEntries(
		SUPERVISOR_PROGRESS_EVENT_SEVERITIES.map((severity) => [severity, 0]),
	) as Record<SupervisorProgressEventSeverity, number>;
}

function assertSupervisorProgressEvent(event: SupervisorProgressEvent): void {
	if (event.schemaVersion !== 1) {
		throw new RangeError("event.schemaVersion must be 1");
	}
	assertNonEmpty(event.id, "event.id");
	assertTimestamp(event.occurredAt, "event.occurredAt");
	if (!SUPERVISOR_PROGRESS_EVENT_TYPE_SET.has(event.type)) {
		throw new RangeError("event.type must be a known progress event type");
	}
	if (!SUPERVISOR_PROGRESS_EVENT_SEVERITY_SET.has(event.severity)) {
		throw new RangeError(
			"event.severity must be a known progress event severity",
		);
	}
}

function createSupervisorProgressSinkFlushResult(
	events: readonly SupervisorProgressEvent[],
): SupervisorProgressSinkFlushResult {
	const sortedEvents = [...events].sort(compareEvents);
	const counts = createEmptyEventCounts();
	const severities = createEmptySeverityCounts();
	let latestOccurredAt: string | null = null;
	let latestOccurredAtMs = Number.NEGATIVE_INFINITY;

	for (const event of sortedEvents) {
		assertSupervisorProgressEvent(event);
		counts[event.type] += 1;
		severities[event.severity] += 1;

		const occurredAtMs = Date.parse(event.occurredAt);
		if (occurredAtMs > latestOccurredAtMs) {
			latestOccurredAt = event.occurredAt;
			latestOccurredAtMs = occurredAtMs;
		}
	}

	return {
		events: sortedEvents,
		counts,
		severities,
		cursor:
			sortedEvents.length === 0
				? null
				: sortedEvents[sortedEvents.length - 1].id,
		latestOccurredAt,
	};
}

export function summarizeSupervisorProgressSinkFlushResults(
	results: Iterable<SupervisorProgressSinkFlushResult>,
): SupervisorProgressSinkBatchSummary {
	const byType = createEmptyEventCounts();
	const bySeverity = createEmptySeverityCounts();
	const cursors: string[] = [];
	let flushCount = 0;
	let totalEvents = 0;
	let emptyFlushCount = 0;
	let latestOccurredAt: string | null = null;
	let latestOccurredAtMs = Number.NEGATIVE_INFINITY;

	for (const result of results) {
		flushCount += 1;
		totalEvents += result.events.length;

		if (result.events.length === 0) {
			emptyFlushCount += 1;
		}
		if (result.cursor != null) {
			cursors.push(result.cursor);
		}
		if (result.latestOccurredAt != null) {
			assertTimestamp(result.latestOccurredAt, "result.latestOccurredAt");
			const occurredAtMs = Date.parse(result.latestOccurredAt);
			if (occurredAtMs > latestOccurredAtMs) {
				latestOccurredAt = result.latestOccurredAt;
				latestOccurredAtMs = occurredAtMs;
			}
		}

		for (const type of SUPERVISOR_PROGRESS_EVENT_TYPES) {
			byType[type] += result.counts[type];
		}
		for (const severity of SUPERVISOR_PROGRESS_EVENT_SEVERITIES) {
			bySeverity[severity] += result.severities[severity];
		}
	}

	return {
		flushCount,
		totalEvents,
		byType,
		bySeverity,
		latestOccurredAt,
		cursors: sorted(cursors),
		emptyFlushCount,
	};
}

export function summarizeSupervisorProgressSinkBatchAttention(
	summary: SupervisorProgressSinkBatchSummary,
): SupervisorProgressSinkBatchAttentionSummary {
	const warningCount = summary.bySeverity.warning;
	const errorCount = summary.bySeverity.error;

	return {
		status:
			summary.totalEvents === 0
				? "empty"
				: warningCount + errorCount > 0
					? "needs_attention"
					: "healthy",
		totalEvents: summary.totalEvents,
		warningCount,
		errorCount,
	};
}

export function summarizeSupervisorProgressSinkFlushReport(
	results: Iterable<SupervisorProgressSinkFlushResult>,
): SupervisorProgressSinkBatchReport {
	const materializedResults = [...results];
	const batch =
		summarizeSupervisorProgressSinkFlushResults(materializedResults);

	return {
		batch,
		attention: summarizeSupervisorProgressSinkBatchAttention(batch),
	};
}

export function flushSupervisorProgressSinkReport(
	sink: SupervisorProgressEventSink,
): SupervisorProgressSinkBatchReport {
	return summarizeSupervisorProgressSinkFlushReport([sink.flush()]);
}

function progressSnapshotSeverity(
	snapshot: SupervisorProgressSnapshot,
): SupervisorProgressEventSeverity {
	if (snapshot.band === "failed") {
		return "error";
	}
	if (snapshot.band === "blocked" || snapshot.staleRunIds.length > 0) {
		return "warning";
	}
	if (snapshot.band === "done") {
		return "success";
	}
	return "info";
}

function terminalSummarySeverity(
	counts: Readonly<Record<TerminalChildRunStatus, number>>,
): SupervisorProgressEventSeverity {
	if (counts.failed + counts.cancelled > 0) {
		return "error";
	}
	if (counts.deferred > 0) {
		return "warning";
	}
	return "success";
}

function childHeartbeatSeverity(
	record: ChildRunStatusRecord,
): SupervisorProgressEventSeverity {
	if (record.status === "failed" || record.status === "cancelled") {
		return "error";
	}
	if (
		record.status === "blocked" ||
		record.status === "cancel_requested" ||
		record.blocker != null
	) {
		return "warning";
	}
	if (record.status === "completed") {
		return "success";
	}
	return "info";
}

function createSnapshotEvent(
	snapshot: SupervisorProgressSnapshot,
): SupervisorProgressSnapshotEvent {
	return {
		schemaVersion: 1,
		id: `progress_snapshot:${snapshot.generatedAt}`,
		type: "progress_snapshot",
		severity: progressSnapshotSeverity(snapshot),
		occurredAt: snapshot.generatedAt,
		payload: {
			generatedAt: snapshot.generatedAt,
			band: snapshot.band,
			totalRuns: snapshot.totalRuns,
			counts: { ...snapshot.counts },
			activeRunIds: [...snapshot.activeRunIds],
			queuedRunIds: [...snapshot.queuedRunIds],
			blockedRunIds: [...snapshot.blockedRunIds],
			staleRunIds: [...snapshot.staleRunIds],
			terminalRunIds: [...snapshot.terminalRunIds],
			boundedPercent: snapshot.boundedPercent,
			confidence: snapshot.confidence,
			reviewedArtifactCount: snapshot.reviewedArtifactCount,
			nextCheckpointAt: snapshot.nextCheckpointAt,
		},
	};
}

function createChildHeartbeatEvent(
	record: ChildRunStatusRecord,
	nowMs: number,
): SupervisorChildHeartbeatEvent {
	return {
		schemaVersion: 1,
		id: `child_heartbeat:${record.runId}:${record.taskId}:${record.lastHeartbeatAt}`,
		type: "child_heartbeat",
		severity: childHeartbeatSeverity(record),
		occurredAt: record.lastHeartbeatAt,
		runId: record.runId,
		taskId: record.taskId,
		payload: {
			workerId: record.workerId,
			status: record.status,
			summary: record.summary,
			currentStep: record.currentStep,
			progress: record.progress,
			blocker: record.blocker,
			confidence: record.confidence,
			reviewedArtifactCount: record.reviewedArtifactCount,
			lastHeartbeatAt: record.lastHeartbeatAt,
			heartbeatAgeMs: heartbeatAgeMs(record, nowMs),
		},
	};
}

function createChildCheckpointEvent(
	record: ChildRunStatusRecord,
	nextCheckpointAt: string,
	nowMs: number,
): SupervisorChildCheckpointEvent {
	const dueInMs = checkpointDueInMs(nextCheckpointAt, nowMs);

	return {
		schemaVersion: 1,
		id: `child_checkpoint:${record.runId}:${record.taskId}:${nextCheckpointAt}`,
		type: "child_checkpoint",
		severity: dueInMs === 0 ? "warning" : "info",
		occurredAt: nextCheckpointAt,
		runId: record.runId,
		taskId: record.taskId,
		payload: {
			workerId: record.workerId,
			status: record.status,
			nextCheckpointAt,
			dueInMs,
			isDue: dueInMs === 0,
		},
	};
}

function createChildStaleEvent(
	record: ChildRunStatusRecord,
	snapshot: SupervisorProgressSnapshot,
	staleAfterMs: number,
	nowMs: number,
): SupervisorChildStaleEvent {
	return {
		schemaVersion: 1,
		id: `child_stale:${record.runId}:${record.taskId}:${snapshot.generatedAt}`,
		type: "child_stale",
		severity: "warning",
		occurredAt: snapshot.generatedAt,
		runId: record.runId,
		taskId: record.taskId,
		payload: {
			workerId: record.workerId,
			status: record.status,
			summary: record.summary,
			lastHeartbeatAt: record.lastHeartbeatAt,
			heartbeatAgeMs: heartbeatAgeMs(record, nowMs),
			staleAfterMs,
		},
	};
}

function createTerminalSummaryEvent(
	records: readonly ChildRunStatusRecord[],
	snapshot: SupervisorProgressSnapshot,
): SupervisorTerminalChildrenSummaryEvent | null {
	const terminalRecords = records
		.filter(isTerminalRecord)
		.sort(compareChildRecords);

	if (terminalRecords.length === 0) {
		return null;
	}

	const counts = createEmptyTerminalCounts();
	const children = terminalRecords
		.map((record) => {
			counts[record.status] += 1;
			return {
				runId: record.runId,
				taskId: record.taskId,
				status: record.status,
				summary: record.summary,
				updatedAt: record.updatedAt,
			};
		})
		.sort(compareTerminalChildren);

	return {
		schemaVersion: 1,
		id: `terminal_children_summary:${snapshot.generatedAt}`,
		type: "terminal_children_summary",
		severity: terminalSummarySeverity(counts),
		occurredAt: snapshot.generatedAt,
		payload: {
			total: terminalRecords.length,
			counts,
			children,
		},
	};
}

export function createBufferedSupervisorProgressSink(
	initialEvents: Iterable<SupervisorProgressEvent> = [],
): SupervisorProgressEventSink {
	let pendingEvents: SupervisorProgressEvent[] = [];
	const sink: SupervisorProgressEventSink = {
		record: (event) => {
			assertSupervisorProgressEvent(event);
			pendingEvents.push(event);
		},
		flush: () => {
			const result = createSupervisorProgressSinkFlushResult(pendingEvents);
			pendingEvents = [];
			return result;
		},
	};

	for (const event of initialEvents) {
		sink.record(event);
	}

	return sink;
}

export function recordSupervisorProgressEvent(
	sink: SupervisorProgressEventSink,
	event: SupervisorProgressEvent,
): void {
	sink.record(event);
}

export function replaySupervisorProgressEvents(
	sink: SupervisorProgressEventSink,
	events: Iterable<SupervisorProgressEvent>,
): SupervisorProgressSinkFlushResult {
	for (const event of events) {
		recordSupervisorProgressEvent(sink, event);
	}

	return sink.flush();
}

export function replaySupervisorProgressEventsReport(
	sink: SupervisorProgressEventSink,
	events: Iterable<SupervisorProgressEvent>,
): SupervisorProgressSinkBatchReport {
	for (const event of events) {
		recordSupervisorProgressEvent(sink, event);
	}

	return flushSupervisorProgressSinkReport(sink);
}

export function applySupervisorProgressProjection(
	sink: SupervisorProgressEventSink,
	projection: SupervisorProgressEventProjection,
): SupervisorProgressSinkFlushResult {
	return replaySupervisorProgressEvents(sink, projection.events);
}

export function applySupervisorProgressProjectionReport(
	sink: SupervisorProgressEventSink,
	projection: SupervisorProgressEventProjection,
): SupervisorProgressSinkBatchReport {
	return replaySupervisorProgressEventsReport(sink, projection.events);
}

export function applySupervisorProgressProjectionsReport(
	sink: SupervisorProgressEventSink,
	projections: Iterable<SupervisorProgressEventProjection>,
): SupervisorProgressSinkBatchReport {
	for (const projection of projections) {
		for (const event of projection.events) {
			recordSupervisorProgressEvent(sink, event);
		}
	}

	return flushSupervisorProgressSinkReport(sink);
}

export function createChildRunStatusRecord(
	input: CreateChildRunStatusRecordInput,
	now = new Date().toISOString(),
): ChildRunStatusRecord {
	assertNonEmpty(input.runId, "runId");
	assertNonEmpty(input.taskId, "taskId");
	assertTimestamp(now, "now");

	const status = input.status ?? "queued";
	const confidence = input.confidence ?? "unknown";
	const lastHeartbeatAt = input.lastHeartbeatAt ?? now;
	const createdAt = input.createdAt ?? now;
	const updatedAt = input.updatedAt ?? lastHeartbeatAt;

	assertChildRunStatus(status, "status");
	assertSupervisorConfidence(confidence, "confidence");
	assertTimestamp(lastHeartbeatAt, "lastHeartbeatAt");
	assertTimestamp(createdAt, "createdAt");
	assertTimestamp(updatedAt, "updatedAt");
	if (input.nextCheckpointAt != null) {
		assertTimestamp(input.nextCheckpointAt, "nextCheckpointAt");
	}
	assertNonNegativeInteger(
		input.reviewedArtifactCount,
		"reviewedArtifactCount",
	);

	return withoutLiveOnlyFields({
		runId: input.runId,
		taskId: input.taskId,
		workerId: input.workerId,
		status,
		summary: input.summary ?? "",
		currentStep: input.currentStep,
		progress: normalizeProgress(input.progress),
		blocker: input.blocker,
		confidence,
		reviewedArtifactCount: input.reviewedArtifactCount ?? 0,
		lastHeartbeatAt,
		nextCheckpointAt: input.nextCheckpointAt,
		createdAt,
		updatedAt,
	});
}

export function recordChildRunHeartbeat(
	record: ChildRunStatusRecord,
	heartbeat: ChildRunHeartbeat,
	now = new Date().toISOString(),
): ChildRunStatusRecord {
	assertTimestamp(now, "now");
	const status = heartbeat.status ?? record.status;
	const confidence = heartbeat.confidence ?? record.confidence;
	assertChildRunStatus(status, "status");
	assertSupervisorConfidence(confidence, "confidence");
	if (heartbeat.nextCheckpointAt != null) {
		assertTimestamp(heartbeat.nextCheckpointAt, "nextCheckpointAt");
	}
	assertNonNegativeInteger(
		heartbeat.reviewedArtifactCount,
		"reviewedArtifactCount",
	);

	return withoutLiveOnlyFields({
		...record,
		status,
		summary: heartbeat.summary ?? record.summary,
		currentStep: optionalField(heartbeat.currentStep, record.currentStep),
		progress: optionalProgress(heartbeat.progress, record.progress),
		blocker: optionalField(heartbeat.blocker, record.blocker),
		confidence,
		reviewedArtifactCount:
			heartbeat.reviewedArtifactCount ?? record.reviewedArtifactCount,
		lastHeartbeatAt: now,
		nextCheckpointAt: optionalField(
			heartbeat.nextCheckpointAt,
			record.nextCheckpointAt,
		),
		updatedAt: now,
	});
}

export function aggregateSupervisorProgress(
	records: readonly ChildRunStatusRecord[],
	options: AggregateSupervisorProgressOptions = {},
): SupervisorProgressSnapshot {
	const generatedAt = options.now ?? new Date().toISOString();
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

	assertTimestamp(generatedAt, "now");
	if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
		throw new RangeError("staleAfterMs must be a non-negative number");
	}

	const nowMs = Date.parse(generatedAt);
	const counts = createEmptyCounts();
	const activeRunIds: string[] = [];
	const queuedRunIds: string[] = [];
	const blockedRunIds: string[] = [];
	const staleRunIds: string[] = [];
	const terminalRunIds: string[] = [];
	const heartbeatAges: number[] = [];
	const currentSteps: string[] = [];
	const blockers: string[] = [];

	for (const record of records) {
		assertChildRunStatus(record.status, "record.status");
		assertSupervisorConfidence(record.confidence, "record.confidence");
		assertTimestamp(record.lastHeartbeatAt, "record.lastHeartbeatAt");
		if (record.nextCheckpointAt != null) {
			assertTimestamp(record.nextCheckpointAt, "record.nextCheckpointAt");
		}
		counts[record.status] += 1;
		const ageMs = heartbeatAgeMs(record, nowMs);
		heartbeatAges.push(ageMs);

		if (ACTIVE_STATUSES.has(record.status)) {
			activeRunIds.push(record.runId);
		}
		if (QUEUED_STATUSES.has(record.status)) {
			queuedRunIds.push(record.runId);
		}
		if (isTerminalStatus(record.status)) {
			terminalRunIds.push(record.runId);
		}
		if (
			!isTerminalStatus(record.status) &&
			(record.status === "blocked" || record.blocker != null)
		) {
			blockedRunIds.push(record.runId);
		}
		if (!isTerminalStatus(record.status) && ageMs > staleAfterMs) {
			staleRunIds.push(record.runId);
		}
		if (
			!isTerminalStatus(record.status) &&
			record.currentStep != null &&
			record.currentStep.length > 0
		) {
			currentSteps.push(record.currentStep);
		}
		if (
			!isTerminalStatus(record.status) &&
			record.blocker != null &&
			record.blocker.length > 0
		) {
			blockers.push(record.blocker);
		}
	}

	return {
		generatedAt,
		totalRuns: records.length,
		counts,
		activeRunIds: sorted(activeRunIds),
		queuedRunIds: sorted(queuedRunIds),
		blockedRunIds: sorted(blockedRunIds),
		staleRunIds: sorted(staleRunIds),
		terminalRunIds: sorted(terminalRunIds),
		oldestHeartbeatAgeMs:
			heartbeatAges.length === 0 ? null : Math.max(...heartbeatAges),
		nextCheckpointAt: earliestCheckpoint(records),
		band: determineBand(records, counts),
		boundedPercent: boundedPercent(records),
		currentSteps: sorted(currentSteps),
		blockers: sorted(blockers),
		reviewedArtifactCount: records.reduce(
			(total, record) => total + record.reviewedArtifactCount,
			0,
		),
		confidence: lowestConfidence(
			records.filter((record) => !isTerminalStatus(record.status)),
		),
	};
}

export function projectSupervisorProgressEvents(
	records: readonly ChildRunStatusRecord[],
	options: AggregateSupervisorProgressOptions = {},
): SupervisorProgressEventProjection {
	const snapshot = aggregateSupervisorProgress(records, options);
	const nowMs = Date.parse(snapshot.generatedAt);
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
	const sortedRecords = [...records].sort(compareChildRecords);
	const staleRunIds = new Set(snapshot.staleRunIds);
	const events: SupervisorProgressEvent[] = [createSnapshotEvent(snapshot)];

	for (const record of sortedRecords) {
		if (staleRunIds.has(record.runId)) {
			events.push(createChildStaleEvent(record, snapshot, staleAfterMs, nowMs));
		}
	}

	for (const record of sortedRecords) {
		if (isTerminalStatus(record.status)) {
			continue;
		}

		events.push(createChildHeartbeatEvent(record, nowMs));
		if (record.nextCheckpointAt != null) {
			events.push(
				createChildCheckpointEvent(record, record.nextCheckpointAt, nowMs),
			);
		}
	}

	const terminalSummaryEvent = createTerminalSummaryEvent(records, snapshot);
	if (terminalSummaryEvent != null) {
		events.push(terminalSummaryEvent);
	}

	return {
		snapshot,
		events: events.sort(compareEvents),
	};
}
