import type { DelegationHandoff } from "../planning/delegation.js";
import {
	type ChildRunHeartbeat,
	type ChildRunStatus,
	type ChildRunStatusRecord,
	createBufferedSupervisorProgressSink,
	createChildRunStatusRecord,
	createChildRunStatusRecordFromDelegationHandoff,
	flushSupervisorProgressSinkReport,
	projectSupervisorProgressEvents,
	recordChildRunHeartbeat,
	recordSupervisorProgressEvent,
	type SupervisorChildArtifactSummary,
	type SupervisorChildCheckpointSummary,
	type SupervisorChildEvent,
	type SupervisorChildEventType,
	type SupervisorChildHandoffSummary,
	type SupervisorChildPendingInputSummary,
	type SupervisorChildRecordSnapshot,
	type SupervisorChildRecoveryHistoryEntry,
	type SupervisorChildRecoveryPlan,
	type SupervisorChildRecoveryReason,
	type SupervisorConfidence,
	type SupervisorProgressEvent,
	type SupervisorProgressEventProjection,
	type SupervisorProgressEventSeverity,
	type SupervisorProgressEventSink,
	type SupervisorProgressSinkBatchReport,
	type TerminalChildRunStatus,
} from "./index.js";

export interface SupervisorWorkerResult {
	readonly summary?: string;
	readonly confidence?: SupervisorConfidence;
	readonly reviewedArtifactCount?: number;
	readonly status?: Extract<ChildRunStatus, "completed" | "deferred">;
}

export type SupervisorRuntimeInputKind = "append" | "send" | "interrupt";

export type SupervisorRuntimeInputMetadata = Readonly<
	Record<string, string | number | boolean | null>
>;

export interface SupervisorRuntimeInputPayload {
	readonly content: string;
	readonly metadata?: SupervisorRuntimeInputMetadata;
}

export interface SupervisorRuntimeInput {
	readonly id: string;
	readonly runId: string;
	readonly taskId: string;
	readonly kind: SupervisorRuntimeInputKind;
	readonly content: string;
	readonly metadata?: SupervisorRuntimeInputMetadata;
	readonly createdAt: string;
}

export interface SupervisorLifecycleEscalation {
	readonly summary: string;
	readonly blocker?: string;
	readonly currentStep?: string;
	readonly nextCheckpointAt?: string;
	readonly confidence?: SupervisorConfidence;
}

export type SupervisorLifecycleEscalationInput =
	| string
	| SupervisorLifecycleEscalation;

export interface SupervisorRuntimeRunQuery {
	readonly runIds?: string | readonly string[];
	readonly taskIds?: string | readonly string[];
	readonly workerIds?: string | readonly string[];
	readonly statuses?: ChildRunStatus | readonly ChildRunStatus[];
}

export interface SupervisorWorkerContext {
	readonly runId: string;
	readonly taskId: string;
	readonly cancelToken: string;
	readonly signal: AbortSignal;
	readonly heartbeat: (heartbeat: ChildRunHeartbeat) => ChildRunStatusRecord;
	readonly reportBlocked: (
		escalation: SupervisorLifecycleEscalationInput,
	) => ChildRunStatusRecord;
	readonly needsDecision: (
		escalation: SupervisorLifecycleEscalationInput,
	) => ChildRunStatusRecord;
	readonly pendingInput: () => readonly SupervisorRuntimeInput[];
	readonly drainInput: () => readonly SupervisorRuntimeInput[];
	readonly waitForInput: () => Promise<SupervisorRuntimeInput | null>;
	readonly isPaused: () => boolean;
	readonly waitUntilResumed: () => Promise<void>;
}

export interface SupervisorWorker {
	readonly workerId: string;
	readonly role: string;
	readonly capabilities: readonly string[];
	readonly execute: (
		handoff: DelegationHandoff,
		context: SupervisorWorkerContext,
	) => Promise<SupervisorWorkerResult | undefined>;
}

export interface InProcessSupervisorRuntimeOptions {
	readonly workers?: readonly SupervisorWorker[];
	readonly sink?: SupervisorProgressEventSink;
	readonly now?: () => string;
	readonly staleAfterMs?: number;
	readonly maxActiveRuns?: number;
	readonly maxChildEventHistory?: number;
}

export interface SupervisorRuntimeAdmissionResult {
	readonly runId: string;
	readonly taskId: string;
	readonly record: ChildRunStatusRecord;
	readonly projection: SupervisorProgressEventProjection;
}

export interface SupervisorRunHandle {
	readonly runId: string;
	readonly taskId: string;
	readonly completion: Promise<ChildRunStatusRecord>;
}

export interface SupervisorRuntimeSnapshot {
	readonly records: readonly ChildRunStatusRecord[];
	readonly projection: SupervisorProgressEventProjection;
}

export interface SupervisorChildEventQuery {
	readonly runIds?: string | readonly string[];
	readonly taskIds?: string | readonly string[];
	readonly types?:
		| SupervisorChildEventType
		| readonly SupervisorChildEventType[];
	readonly sinceSequence?: number;
	readonly limit?: number;
}

export type SupervisorChildEventListener = (
	event: SupervisorChildEvent,
) => void;

interface ActiveRunState {
	readonly controller: AbortController;
	paused: boolean;
	readonly resumeWaiters: Array<() => void>;
}

interface ChildRunDeferred {
	readonly promise: Promise<ChildRunStatusRecord>;
	readonly resolve: (record: ChildRunStatusRecord) => void;
}

type InputWaiter = (input: SupervisorRuntimeInput | null) => void;

const WORKER_HEARTBEAT_STATUSES = new Set<ChildRunStatusRecord["status"]>([
	"active",
	"blocked",
	"waiting_for_review",
	"aggregating",
]);

const DEFAULT_CHILD_EVENT_HISTORY_LIMIT = 200;
const RECOVERY_HISTORY_LIMIT = 25;
const INPUT_CONTENT_PREVIEW_LIMIT = 160;
const ARTIFACT_ARGUMENT_KEY_PARTS = [
	"artifact",
	"file",
	"output",
	"path",
	"report",
];

function isTerminalStatus(
	status: ChildRunStatusRecord["status"],
): status is TerminalChildRunStatus {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "deferred"
	);
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive integer`);
	}
}

function assertNonNegativeInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
}

function isControlLockedStatus(
	status: ChildRunStatusRecord["status"],
): boolean {
	return status === "cancel_requested" || isTerminalStatus(status);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeInputPayload(
	input: string | SupervisorRuntimeInputPayload,
): SupervisorRuntimeInputPayload {
	return typeof input === "string" ? { content: input } : input;
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength
		? value
		: `${value.slice(0, maxLength - 3)}...`;
}

function summarizeValue(value: unknown): string {
	if (typeof value === "string") {
		return truncate(value, INPUT_CONTENT_PREVIEW_LIMIT);
	}

	const serialized = JSON.stringify(value);
	return truncate(serialized ?? String(value), INPUT_CONTENT_PREVIEW_LIMIT);
}

function childEventSeverityForRecord(
	record: ChildRunStatusRecord,
): SupervisorProgressEventSeverity {
	if (record.status === "failed" || record.status === "cancelled") {
		return "error";
	}
	if (
		record.status === "blocked" ||
		record.status === "cancel_requested" ||
		record.status === "deferred" ||
		record.blocker != null
	) {
		return "warning";
	}
	if (record.status === "completed") {
		return "success";
	}
	return "info";
}

function heartbeatAgeMs(record: ChildRunStatusRecord, now: string): number {
	return Math.max(0, Date.parse(now) - Date.parse(record.lastHeartbeatAt));
}

function checkpointDueInMs(nextCheckpointAt: string, now: string): number {
	return Math.max(0, Date.parse(nextCheckpointAt) - Date.parse(now));
}

function snapshotChildRecord(
	record: ChildRunStatusRecord,
): SupervisorChildRecordSnapshot {
	return { ...record };
}

function normalizeLifecycleEscalation(
	input: SupervisorLifecycleEscalationInput,
	defaultCurrentStep: string,
): ChildRunHeartbeat {
	const payload = typeof input === "string" ? { summary: input } : input;
	const summary = payload.summary.trim();
	if (summary.length === 0) {
		throw new RangeError("lifecycle escalation summary must be non-empty");
	}

	const blocker = payload.blocker?.trim() || summary;
	const currentStep = payload.currentStep?.trim() || defaultCurrentStep;
	return {
		status: "blocked",
		summary,
		currentStep,
		blocker,
		nextCheckpointAt: payload.nextCheckpointAt,
		confidence: payload.confidence ?? "low",
	};
}

function normalizeQueryValues<T>(
	value: T | readonly T[] | undefined,
): ReadonlySet<T> | null {
	if (value == null) {
		return null;
	}

	return new Set(Array.isArray(value) ? value : [value]);
}

function assertNever(value: never): never {
	throw new Error(`Unexpected supervisor runtime value: ${String(value)}`);
}

function assertWorkerHeartbeatTransition(
	record: ChildRunStatusRecord,
	heartbeat: ChildRunHeartbeat,
	isActive: boolean,
): void {
	if (heartbeat.status == null) {
		return;
	}
	if (isTerminalStatus(heartbeat.status)) {
		throw new RangeError(
			"heartbeat cannot transition a child run to a terminal status",
		);
	}

	if (record.status === "queued") {
		if (heartbeat.status !== "queued") {
			throw new RangeError(
				"queued child run cannot receive a running heartbeat before dispatch",
			);
		}
		return;
	}
	if (record.status === "assigned") {
		if (
			heartbeat.status !== "assigned" &&
			(!isActive || !WORKER_HEARTBEAT_STATUSES.has(heartbeat.status))
		) {
			throw new RangeError(
				"assigned child run cannot receive a running heartbeat before worker start",
			);
		}
		return;
	}
	if (record.status === "cancel_requested") {
		if (heartbeat.status !== "cancel_requested") {
			throw new RangeError(
				"cancel-requested child run cannot be moved by heartbeat",
			);
		}
		return;
	}
	if (!isActive || !WORKER_HEARTBEAT_STATUSES.has(heartbeat.status)) {
		throw new RangeError(
			"worker heartbeat status must stay within running child run states",
		);
	}
}

function cancellationReason(
	runId: string,
	controller: AbortController,
	record: ChildRunStatusRecord | undefined,
): string {
	return String(
		controller.signal.reason ?? record?.summary ?? `${runId} cancelled`,
	);
}

function recordFromChildEvent(
	event: SupervisorChildEvent,
): SupervisorChildRecordSnapshot | undefined {
	switch (event.type) {
		case "heartbeat":
		case "checkpoint":
		case "completion":
		case "blocked":
		case "stale":
			return event.payload.record;
		case "recovery":
			return event.payload.plan.context.record;
		default:
			return assertNever(event);
	}
}

function summaryFromChildEvent(event: SupervisorChildEvent): string {
	switch (event.type) {
		case "checkpoint":
			return `checkpoint due at ${event.payload.nextCheckpointAt}`;
		case "stale":
			return `${event.payload.record.summary} (stale ${event.payload.heartbeatAgeMs}ms)`;
		case "recovery":
			return event.payload.plan.summary;
		case "heartbeat":
		case "completion":
		case "blocked":
			return event.payload.record.summary;
		default:
			return assertNever(event);
	}
}

function supervisorProgressEventEmissionKey(
	event: SupervisorProgressEvent,
): string {
	switch (event.type) {
		case "progress_snapshot":
			return [
				event.type,
				event.payload.generatedAt,
				event.payload.band,
				JSON.stringify(event.payload.counts),
				event.payload.activeRunIds.join(","),
				event.payload.queuedRunIds.join(","),
				event.payload.blockedRunIds.join(","),
				event.payload.staleRunIds.join(","),
				event.payload.terminalRunIds.join(","),
				String(event.payload.boundedPercent),
				event.payload.confidence,
				String(event.payload.reviewedArtifactCount),
				event.payload.nextCheckpointAt ?? "",
			].join("|");
		case "child_stale":
			return [
				event.type,
				event.runId,
				event.taskId,
				event.payload.workerId ?? "",
				event.payload.status,
				event.payload.summary,
				event.payload.lastHeartbeatAt,
				String(event.payload.staleAfterMs),
			].join("|");
		case "terminal_children_summary":
			return [
				event.type,
				JSON.stringify(event.payload.counts),
				event.payload.children
					.map(
						(child) =>
							`${child.runId}:${child.taskId}:${child.status}:${child.updatedAt}`,
					)
					.join(","),
			].join("|");
		case "child_checkpoint":
			return [
				event.type,
				event.runId,
				event.taskId,
				event.payload.workerId ?? "",
				event.payload.status,
				event.payload.nextCheckpointAt,
			].join("|");
		case "child_heartbeat":
			return [
				event.type,
				event.runId,
				event.taskId,
				event.payload.workerId ?? "",
				event.payload.status,
				event.payload.summary,
				event.payload.currentStep ?? "",
				event.payload.blocker ?? "",
				JSON.stringify(event.payload.progress ?? null),
				event.payload.confidence,
				String(event.payload.reviewedArtifactCount),
				event.payload.lastHeartbeatAt,
			].join("|");
		default:
			return assertNever(event);
	}
}

function workerCanHandle(
	worker: SupervisorWorker,
	handoff: DelegationHandoff,
): boolean {
	const capabilities = new Set(worker.capabilities);
	return (
		worker.role === handoff.receiver.role &&
		handoff.receiver.requiredCapabilities.every((capability) =>
			capabilities.has(capability),
		)
	);
}

export class InProcessSupervisorRuntime {
	private readonly workers: readonly SupervisorWorker[];
	private readonly sink: SupervisorProgressEventSink;
	private readonly now: () => string;
	private readonly staleAfterMs?: number;
	private readonly maxActiveRuns: number;
	private readonly maxChildEventHistory: number;
	private readonly records = new Map<string, ChildRunStatusRecord>();
	private readonly handoffs = new Map<string, DelegationHandoff>();
	private readonly completions = new Map<string, ChildRunDeferred>();
	private readonly activeRuns = new Map<string, ActiveRunState>();
	private readonly pendingInputs = new Map<string, SupervisorRuntimeInput[]>();
	private readonly inputWaiters = new Map<string, InputWaiter[]>();
	private readonly emittedEventKeys = new Set<string>();
	private readonly childEvents: SupervisorChildEvent[] = [];
	private readonly pendingChildEvents: SupervisorChildEvent[] = [];
	private readonly childEventListeners =
		new Set<SupervisorChildEventListener>();
	private readonly staleNotificationKeys = new Set<string>();
	private readonly crashedRunIds = new Set<string>();
	private nextInputSequence = 0;
	private nextChildEventSequence = 0;

	constructor(options: InProcessSupervisorRuntimeOptions = {}) {
		this.workers = options.workers ?? [];
		this.sink = options.sink ?? createBufferedSupervisorProgressSink();
		this.now = options.now ?? (() => new Date().toISOString());
		this.staleAfterMs = options.staleAfterMs;
		this.maxActiveRuns = options.maxActiveRuns ?? Number.POSITIVE_INFINITY;
		this.maxChildEventHistory =
			options.maxChildEventHistory ?? DEFAULT_CHILD_EVENT_HISTORY_LIMIT;
		if (
			!Number.isFinite(this.maxActiveRuns) &&
			this.maxActiveRuns !== Number.POSITIVE_INFINITY
		) {
			throw new RangeError("maxActiveRuns must be a positive number");
		}
		if (this.maxActiveRuns < 1) {
			throw new RangeError("maxActiveRuns must be a positive number");
		}
		assertPositiveInteger(this.maxChildEventHistory, "maxChildEventHistory");
	}

	admitHandoff(handoff: DelegationHandoff): SupervisorRuntimeAdmissionResult {
		const existingRecord = this.records.get(handoff.childRunId);
		if (existingRecord != null) {
			return {
				runId: existingRecord.runId,
				taskId: existingRecord.taskId,
				record: { ...existingRecord },
				projection: this.snapshot().projection,
			};
		}

		const queuedRecord = createChildRunStatusRecordFromDelegationHandoff(
			handoff,
			this.now(),
		);
		this.handoffs.set(handoff.childRunId, handoff);
		this.completions.set(handoff.childRunId, createChildRunDeferred());
		this.setRecord(queuedRecord);

		return {
			runId: queuedRecord.runId,
			taskId: queuedRecord.taskId,
			record: { ...queuedRecord },
			projection: this.snapshot().projection,
		};
	}

	dispatch(handoff: DelegationHandoff): SupervisorRunHandle {
		const admission = this.admitHandoff(handoff);
		this.startQueuedRuns();

		return {
			runId: admission.runId,
			taskId: admission.taskId,
			completion: this.requireCompletion(admission.runId).promise,
		};
	}

	startQueuedRuns(): readonly SupervisorRunHandle[] {
		const handles: SupervisorRunHandle[] = [];

		for (const record of this.sortedRecords()) {
			if (this.activeRuns.size >= this.maxActiveRuns) {
				break;
			}
			if (record.status !== "queued" && record.status !== "assigned") {
				continue;
			}
			const handle = this.startRun(record.runId);
			if (handle != null) {
				handles.push(handle);
			}
		}

		return handles;
	}

	cancel(runId: string, reason: string): ChildRunStatusRecord {
		const currentRecord = this.requireRecord(runId);
		if (isTerminalStatus(currentRecord.status)) {
			return currentRecord;
		}

		const state = this.activeRuns.get(runId);
		if (state == null) {
			const record = this.writeTerminalRecord(runId, {
				status: "cancelled",
				summary: reason,
				confidence: "low",
			});
			this.resolveCompletion(runId, record);
			this.closeInputPort(runId);
			this.startQueuedRuns();
			return record;
		}

		state.controller.abort(reason);
		this.releasePauseWaiters(state);
		this.closeInputPort(runId);
		return this.updateRuntimeRecord(runId, {
			status: "cancel_requested",
			summary: reason,
			currentStep: "cancelling",
			confidence: "low",
		});
	}

	interrupt(runId: string, reason: string): ChildRunStatusRecord {
		this.enqueueInput(runId, "interrupt", reason);
		return this.pause(runId, reason, "interrupted");
	}

	pause(
		runId: string,
		reason = "child run paused",
		currentStep = "paused",
	): ChildRunStatusRecord {
		const currentRecord = this.requireRecord(runId);
		if (isControlLockedStatus(currentRecord.status)) {
			return currentRecord;
		}

		const state = this.activeRuns.get(runId);
		if (state != null) {
			state.paused = true;
		}

		return this.updateRuntimeRecord(runId, {
			status: "blocked",
			summary: reason,
			currentStep,
			blocker: reason,
			confidence: "low",
		});
	}

	resume(runId: string, summary = "child run resumed"): ChildRunStatusRecord {
		const currentRecord = this.requireRecord(runId);
		if (isControlLockedStatus(currentRecord.status)) {
			return currentRecord;
		}

		const state = this.activeRuns.get(runId);
		if (state != null) {
			if (!state.paused && currentRecord.status !== "blocked") {
				return currentRecord;
			}
			this.releasePauseWaiters(state);
			return this.updateRuntimeRecord(runId, {
				status: "active",
				summary,
				currentStep: "resuming",
				blocker: null,
				confidence: "medium",
			});
		}

		const record = this.updateRuntimeRecord(runId, {
			status: "queued",
			summary,
			currentStep: null,
			blocker: null,
			confidence: "medium",
		});
		this.startQueuedRuns();
		return this.requireRecord(record.runId);
	}

	wake(runId: string, summary = "child run woken"): ChildRunStatusRecord {
		const currentRecord = this.requireRecord(runId);
		if (isControlLockedStatus(currentRecord.status)) {
			return currentRecord;
		}
		if (currentRecord.status === "blocked") {
			return this.resume(runId, summary);
		}

		this.startQueuedRuns();
		return this.requireRecord(runId);
	}

	defer(runId: string, reason: string): ChildRunStatusRecord {
		const currentRecord = this.requireRecord(runId);
		if (isControlLockedStatus(currentRecord.status)) {
			return currentRecord;
		}

		const state = this.activeRuns.get(runId);
		if (state != null) {
			state.controller.abort(reason);
			this.releasePauseWaiters(state);
			this.activeRuns.delete(runId);
		}

		const record = this.writeTerminalRecord(runId, {
			status: "deferred",
			summary: reason,
			confidence: "low",
		});
		this.resolveCompletion(runId, record);
		this.closeInputPort(runId);
		this.startQueuedRuns();
		return record;
	}

	appendInput(
		runId: string,
		input: string | SupervisorRuntimeInputPayload,
	): SupervisorRuntimeInput {
		return this.enqueueInput(runId, "append", input);
	}

	sendInput(
		runId: string,
		input: string | SupervisorRuntimeInputPayload,
	): SupervisorRuntimeInput {
		return this.enqueueInput(runId, "send", input);
	}

	heartbeat(runId: string, heartbeat: ChildRunHeartbeat): ChildRunStatusRecord {
		return this.updateLiveRecord(runId, heartbeat);
	}

	getRecord(runId: string): ChildRunStatusRecord | undefined {
		const record = this.records.get(runId);
		return record == null ? undefined : { ...record };
	}

	listRecords(): readonly ChildRunStatusRecord[] {
		return this.sortedRecords();
	}

	listRuns(
		query: SupervisorRuntimeRunQuery = {},
	): readonly ChildRunStatusRecord[] {
		return this.filterRecords(this.sortedRecords(), query);
	}

	queryRuns(query: SupervisorRuntimeRunQuery = {}): SupervisorRuntimeSnapshot {
		const records = this.listRuns(query);
		return {
			records,
			projection: projectSupervisorProgressEvents(records, {
				now: this.now(),
				staleAfterMs: this.staleAfterMs,
			}),
		};
	}

	snapshot(): SupervisorRuntimeSnapshot {
		const records = this.sortedRecords();
		return {
			records,
			projection: projectSupervisorProgressEvents(records, {
				now: this.now(),
				staleAfterMs: this.staleAfterMs,
			}),
		};
	}

	flush(): SupervisorProgressSinkBatchReport {
		return flushSupervisorProgressSinkReport(this.sink);
	}

	subscribeChildEvents(listener: SupervisorChildEventListener): () => void {
		this.childEventListeners.add(listener);
		return () => {
			this.childEventListeners.delete(listener);
		};
	}

	listChildEvents(
		query: SupervisorChildEventQuery = {},
	): readonly SupervisorChildEvent[] {
		return this.filterChildEvents(this.childEvents, query);
	}

	recentChildEvents(
		limit = 20,
		query: Omit<SupervisorChildEventQuery, "limit"> = {},
	): readonly SupervisorChildEvent[] {
		return this.listChildEvents({ ...query, limit });
	}

	drainChildEvents(
		query: SupervisorChildEventQuery = {},
	): readonly SupervisorChildEvent[] {
		const limit = query.limit;
		if (limit != null) {
			assertNonNegativeInteger(limit, "query.limit");
		}

		const matchingIndexes = this.pendingChildEvents
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => this.childEventMatches(event, query));
		const selectedIndexes = new Set(
			(limit == null ? matchingIndexes : matchingIndexes.slice(-limit)).map(
				({ index }) => index,
			),
		);
		const selectedEvents = this.pendingChildEvents.filter((_, index) =>
			selectedIndexes.has(index),
		);
		this.pendingChildEvents.splice(
			0,
			this.pendingChildEvents.length,
			...this.pendingChildEvents.filter(
				(_, index) => !selectedIndexes.has(index),
			),
		);

		return selectedEvents;
	}

	detectStaleRuns(): readonly SupervisorChildRecoveryPlan[] {
		const staleEvents = this.snapshot().projection.events.filter(
			(
				event,
			): event is Extract<
				SupervisorProgressEvent,
				{ readonly type: "child_stale" }
			> => event.type === "child_stale",
		);
		const plans: SupervisorChildRecoveryPlan[] = [];

		for (const staleEvent of staleEvents) {
			const record = this.requireRecord(staleEvent.runId);
			const staleKey = `${record.runId}:${record.lastHeartbeatAt}`;
			let plan: SupervisorChildRecoveryPlan;

			if (!this.staleNotificationKeys.has(staleKey)) {
				this.staleNotificationKeys.add(staleKey);
				this.emitChildEvent({
					type: "stale",
					severity: "warning",
					occurredAt: staleEvent.occurredAt,
					runId: record.runId,
					taskId: record.taskId,
					payload: {
						record: snapshotChildRecord(record),
						heartbeatAgeMs: staleEvent.payload.heartbeatAgeMs,
						staleAfterMs: staleEvent.payload.staleAfterMs,
					},
				});
				plan = this.createRecoveryPlan(
					record.runId,
					"stale",
					staleEvent.occurredAt,
				);
				this.emitRecoveryEvent(plan);
			} else {
				plan = this.createRecoveryPlan(
					record.runId,
					"stale",
					staleEvent.occurredAt,
				);
			}

			plans.push(plan);
		}

		return plans;
	}

	buildRecoveryPlan(
		runId: string,
		reason: SupervisorChildRecoveryReason = "manual",
	): SupervisorChildRecoveryPlan {
		return this.createRecoveryPlan(runId, reason, this.now());
	}

	private startRun(runId: string): SupervisorRunHandle | null {
		const handoff = this.handoffs.get(runId);
		if (handoff == null || this.activeRuns.has(runId)) {
			return null;
		}

		const worker = this.workers.find((candidate) =>
			workerCanHandle(candidate, handoff),
		);
		if (worker == null) {
			const failedRecord = this.writeTerminalRecord(handoff.childRunId, {
				status: "failed",
				summary: `No supervisor worker available for ${handoff.receiver.role}`,
				confidence: "low",
			});
			this.resolveCompletion(runId, failedRecord);
			this.closeInputPort(runId);
			return {
				runId: failedRecord.runId,
				taskId: failedRecord.taskId,
				completion: this.requireCompletion(runId).promise,
			};
		}

		this.assignWorker(runId, worker);
		this.updateRuntimeRecord(runId, {
			status: "active",
			summary: `Worker ${worker.workerId} started ${handoff.task.name}`,
			currentStep: "starting",
			confidence: "medium",
		});

		const controller = new AbortController();
		this.activeRuns.set(runId, {
			controller,
			paused: false,
			resumeWaiters: [],
		});
		void this.runWorker(handoff, worker, controller);

		return {
			runId,
			taskId: handoff.task.id,
			completion: this.requireCompletion(runId).promise,
		};
	}

	private async runWorker(
		handoff: DelegationHandoff,
		worker: SupervisorWorker,
		controller: AbortController,
	): Promise<ChildRunStatusRecord> {
		try {
			const result = await worker.execute(handoff, {
				runId: handoff.childRunId,
				taskId: handoff.task.id,
				cancelToken: handoff.cancelToken,
				signal: controller.signal,
				heartbeat: (heartbeat) => this.heartbeat(handoff.childRunId, heartbeat),
				reportBlocked: (escalation) =>
					this.reportLifecycleEscalation(
						handoff.childRunId,
						"blocked",
						escalation,
					),
				needsDecision: (escalation) =>
					this.reportLifecycleEscalation(
						handoff.childRunId,
						"needs_decision",
						escalation,
					),
				pendingInput: () => this.pendingInput(handoff.childRunId),
				drainInput: () => this.drainInput(handoff.childRunId),
				waitForInput: () => this.waitForInput(handoff.childRunId),
				isPaused: () => this.isPaused(handoff.childRunId),
				waitUntilResumed: () => this.waitUntilResumed(handoff.childRunId),
			});

			const currentRecord = this.records.get(handoff.childRunId);
			if (currentRecord != null && isTerminalStatus(currentRecord.status)) {
				return currentRecord;
			}

			if (
				controller.signal.aborted ||
				currentRecord?.status === "cancel_requested"
			) {
				return this.writeTerminalRecord(handoff.childRunId, {
					status: "cancelled",
					summary: cancellationReason(
						handoff.childRunId,
						controller,
						currentRecord,
					),
					confidence: "low",
				});
			}

			return this.writeTerminalRecord(handoff.childRunId, {
				status: result?.status ?? "completed",
				summary: result?.summary ?? `Worker ${worker.workerId} completed`,
				confidence: result?.confidence ?? "high",
				reviewedArtifactCount: result?.reviewedArtifactCount,
			});
		} catch (error) {
			const currentRecord = this.records.get(handoff.childRunId);
			if (currentRecord != null && isTerminalStatus(currentRecord.status)) {
				return currentRecord;
			}

			const shouldCancel =
				controller.signal.aborted ||
				currentRecord?.status === "cancel_requested";
			if (!shouldCancel) {
				this.crashedRunIds.add(handoff.childRunId);
			}
			return this.writeTerminalRecord(handoff.childRunId, {
				status: shouldCancel ? "cancelled" : "failed",
				summary: shouldCancel
					? cancellationReason(handoff.childRunId, controller, currentRecord)
					: errorMessage(error),
				confidence: "low",
			});
		} finally {
			const state = this.activeRuns.get(handoff.childRunId);
			if (state != null) {
				this.releasePauseWaiters(state);
			}
			this.activeRuns.delete(handoff.childRunId);
			const record = this.requireRecord(handoff.childRunId);
			if (isTerminalStatus(record.status)) {
				this.resolveCompletion(handoff.childRunId, record);
				this.closeInputPort(handoff.childRunId);
				this.startQueuedRuns();
			}
		}
	}

	private assignWorker(runId: string, worker: SupervisorWorker): void {
		const record = this.requireRecord(runId);
		const now = this.now();
		this.setRecord(
			createChildRunStatusRecord(
				{
					...record,
					workerId: worker.workerId,
					status: "assigned",
					summary: `Assigned to ${worker.workerId}`,
					updatedAt: now,
					lastHeartbeatAt: now,
				},
				now,
			),
		);
	}

	private updateLiveRecord(
		runId: string,
		heartbeat: ChildRunHeartbeat,
	): ChildRunStatusRecord {
		const currentRecord = this.requireRecord(runId);
		if (isTerminalStatus(currentRecord.status)) {
			throw new RangeError("terminal child run cannot be updated");
		}
		const state = this.activeRuns.get(runId);
		if (
			state?.paused === true &&
			heartbeat.status != null &&
			heartbeat.status !== "blocked"
		) {
			throw new RangeError(
				"paused child run cannot receive a running heartbeat before resume",
			);
		}
		assertWorkerHeartbeatTransition(currentRecord, heartbeat, state != null);
		return this.writeRecord(runId, heartbeat);
	}

	private reportLifecycleEscalation(
		runId: string,
		defaultCurrentStep: string,
		escalation: SupervisorLifecycleEscalationInput,
	): ChildRunStatusRecord {
		const currentRecord = this.requireRecord(runId);
		if (isControlLockedStatus(currentRecord.status)) {
			return currentRecord;
		}

		const state = this.activeRuns.get(runId);
		if (state != null) {
			state.paused = true;
		}

		return this.updateRuntimeRecord(
			runId,
			normalizeLifecycleEscalation(escalation, defaultCurrentStep),
		);
	}

	private updateRuntimeRecord(
		runId: string,
		heartbeat: ChildRunHeartbeat,
	): ChildRunStatusRecord {
		if (isTerminalStatus(this.requireRecord(runId).status)) {
			throw new RangeError("terminal child run cannot be updated");
		}
		if (heartbeat.status != null && isTerminalStatus(heartbeat.status)) {
			throw new RangeError(
				"runtime live writer requires a non-terminal status",
			);
		}
		return this.writeRecord(runId, heartbeat);
	}

	private writeTerminalRecord(
		runId: string,
		heartbeat: ChildRunHeartbeat,
	): ChildRunStatusRecord {
		if (heartbeat.status == null || !isTerminalStatus(heartbeat.status)) {
			throw new RangeError("terminal writer requires a terminal status");
		}
		return this.writeRecord(runId, heartbeat);
	}

	private writeRecord(
		runId: string,
		heartbeat: ChildRunHeartbeat,
	): ChildRunStatusRecord {
		if (isTerminalStatus(this.requireRecord(runId).status)) {
			throw new RangeError("terminal child run cannot be updated");
		}
		const record = recordChildRunHeartbeat(
			this.requireRecord(runId),
			heartbeat,
			this.now(),
		);
		this.setRecord(record);
		return record;
	}

	private setRecord(record: ChildRunStatusRecord): void {
		const previousRecord = this.records.get(record.runId);
		this.records.set(record.runId, record);
		this.recordChildRuntimeEvents(previousRecord, record);
		for (const event of this.snapshot().projection.events) {
			const key = supervisorProgressEventEmissionKey(event);
			if (this.emittedEventKeys.has(key)) {
				continue;
			}
			this.emittedEventKeys.add(key);
			recordSupervisorProgressEvent(this.sink, event);
		}
	}

	private recordChildRuntimeEvents(
		previousRecord: ChildRunStatusRecord | undefined,
		record: ChildRunStatusRecord,
	): void {
		const occurredAt = record.updatedAt;

		if (isTerminalStatus(record.status)) {
			this.emitChildEvent({
				type: "completion",
				severity: childEventSeverityForRecord(record),
				occurredAt,
				runId: record.runId,
				taskId: record.taskId,
				payload: {
					record: snapshotChildRecord(
						record,
					) as SupervisorChildRecordSnapshot & {
						readonly status: TerminalChildRunStatus;
					},
					previousStatus: previousRecord?.status,
				},
			});

			if (record.status === "failed") {
				this.emitRecoveryEvent(
					this.createRecoveryPlan(
						record.runId,
						this.crashedRunIds.has(record.runId) ? "crashed" : "failed",
						occurredAt,
					),
				);
			}
			return;
		}

		if (record.status !== "queued" && record.status !== "assigned") {
			this.emitChildEvent({
				type: "heartbeat",
				severity: childEventSeverityForRecord(record),
				occurredAt,
				runId: record.runId,
				taskId: record.taskId,
				payload: {
					record: snapshotChildRecord(record),
					heartbeatAgeMs: heartbeatAgeMs(record, occurredAt),
					previousStatus: previousRecord?.status,
				},
			});
		}

		const blocker = record.blocker?.trim();
		if (
			record.status === "blocked" ||
			(blocker != null && blocker.length > 0)
		) {
			this.emitChildEvent({
				type: "blocked",
				severity: "warning",
				occurredAt,
				runId: record.runId,
				taskId: record.taskId,
				payload: {
					record: snapshotChildRecord(record),
					blocker: blocker ?? record.summary,
					currentStep: record.currentStep,
				},
			});
		}

		if (
			record.nextCheckpointAt != null &&
			record.nextCheckpointAt !== previousRecord?.nextCheckpointAt
		) {
			this.emitChildEvent({
				type: "checkpoint",
				severity:
					checkpointDueInMs(record.nextCheckpointAt, occurredAt) === 0
						? "warning"
						: "info",
				occurredAt: record.nextCheckpointAt,
				runId: record.runId,
				taskId: record.taskId,
				payload: {
					record: snapshotChildRecord(record),
					nextCheckpointAt: record.nextCheckpointAt,
					dueInMs: checkpointDueInMs(record.nextCheckpointAt, occurredAt),
				},
			});
		}
	}

	private emitRecoveryEvent(
		plan: SupervisorChildRecoveryPlan,
	): SupervisorChildEvent {
		return this.emitChildEvent({
			type: "recovery",
			severity: "warning",
			occurredAt: plan.generatedAt,
			runId: plan.runId,
			taskId: plan.taskId,
			payload: { plan },
		});
	}

	private emitChildEvent(
		event: Omit<SupervisorChildEvent, "schemaVersion" | "id" | "sequence">,
	): SupervisorChildEvent {
		this.nextChildEventSequence += 1;
		const notification = {
			...event,
			schemaVersion: 1 as const,
			id: `child_event:${this.nextChildEventSequence}`,
			sequence: this.nextChildEventSequence,
		} as SupervisorChildEvent;

		this.childEvents.push(notification);
		if (this.childEvents.length > this.maxChildEventHistory) {
			this.childEvents.splice(
				0,
				this.childEvents.length - this.maxChildEventHistory,
			);
		}
		this.pendingChildEvents.push(notification);
		if (this.pendingChildEvents.length > this.maxChildEventHistory) {
			this.pendingChildEvents.splice(
				0,
				this.pendingChildEvents.length - this.maxChildEventHistory,
			);
		}

		for (const listener of this.childEventListeners) {
			try {
				listener(notification);
			} catch {
				// One broken listener must not block others
			}
		}

		return notification;
	}

	private childEventMatches(
		event: SupervisorChildEvent,
		query: SupervisorChildEventQuery,
	): boolean {
		const runIds = normalizeQueryValues(query.runIds);
		const taskIds = normalizeQueryValues(query.taskIds);
		const types = normalizeQueryValues(query.types);

		return (
			(runIds == null || runIds.has(event.runId)) &&
			(taskIds == null || taskIds.has(event.taskId)) &&
			(types == null || types.has(event.type)) &&
			(query.sinceSequence == null || event.sequence > query.sinceSequence)
		);
	}

	private filterChildEvents(
		events: readonly SupervisorChildEvent[],
		query: SupervisorChildEventQuery,
	): readonly SupervisorChildEvent[] {
		if (query.limit != null) {
			assertNonNegativeInteger(query.limit, "query.limit");
		}

		const filteredEvents = events.filter((event) =>
			this.childEventMatches(event, query),
		);
		return query.limit == null
			? [...filteredEvents]
			: filteredEvents.slice(-query.limit);
	}

	private createRecoveryPlan(
		runId: string,
		reason: SupervisorChildRecoveryReason,
		generatedAt: string,
	): SupervisorChildRecoveryPlan {
		const record = this.requireRecord(runId);
		const context = this.createRecoveryContextSnapshot(record, generatedAt);

		return {
			id: `recovery:${reason}:${runId}:${generatedAt}`,
			reason,
			generatedAt,
			runId: record.runId,
			taskId: record.taskId,
			status: record.status,
			summary: record.summary,
			suggestedAction: this.recoverySuggestedAction(reason, record),
			context,
		};
	}

	private createRecoveryContextSnapshot(
		record: ChildRunStatusRecord,
		generatedAt: string,
	): SupervisorChildRecoveryPlan["context"] {
		const historyEvents = this.childEvents
			.filter(
				(event) => event.runId === record.runId && event.type !== "recovery",
			)
			.slice(-RECOVERY_HISTORY_LIMIT);

		return {
			generatedAt,
			heartbeatAgeMs: heartbeatAgeMs(record, generatedAt),
			record: snapshotChildRecord(record),
			pendingInputs: this.summarizePendingInputs(record.runId),
			history: historyEvents.map((event) => this.summarizeHistoryEvent(event)),
			checkpoints: historyEvents
				.filter(
					(
						event,
					): event is Extract<
						SupervisorChildEvent,
						{ readonly type: "checkpoint" }
					> => event.type === "checkpoint",
				)
				.map((event) => this.summarizeCheckpointEvent(event)),
			artifacts: this.summarizeArtifacts(record),
			handoff: this.summarizeHandoff(record.runId),
		};
	}

	private summarizeHistoryEvent(
		event: SupervisorChildEvent,
	): SupervisorChildRecoveryHistoryEntry {
		const record = recordFromChildEvent(event);
		return {
			sequence: event.sequence,
			type: event.type,
			occurredAt: event.occurredAt,
			summary: summaryFromChildEvent(event),
			status: record?.status,
			currentStep: record?.currentStep,
			blocker: record?.blocker,
		};
	}

	private summarizeCheckpointEvent(
		event: Extract<SupervisorChildEvent, { readonly type: "checkpoint" }>,
	): SupervisorChildCheckpointSummary {
		return {
			sequence: event.sequence,
			occurredAt: event.occurredAt,
			nextCheckpointAt: event.payload.nextCheckpointAt,
			summary: event.payload.record.summary,
			currentStep: event.payload.record.currentStep,
			progress: event.payload.record.progress,
		};
	}

	private summarizePendingInputs(
		runId: string,
	): readonly SupervisorChildPendingInputSummary[] {
		return (this.pendingInputs.get(runId) ?? []).map((input) => ({
			id: input.id,
			kind: input.kind,
			contentPreview: truncate(input.content, INPUT_CONTENT_PREVIEW_LIMIT),
			metadataKeys: Object.keys(input.metadata ?? {}).sort(),
			createdAt: input.createdAt,
		}));
	}

	private summarizeHandoff(
		runId: string,
	): SupervisorChildHandoffSummary | undefined {
		const handoff = this.handoffs.get(runId);
		if (handoff == null) {
			return undefined;
		}

		return {
			parentRunId: handoff.parentRunId,
			taskName: handoff.task.name,
			taskDescription: handoff.task.description,
			receiverRole: handoff.receiver.role,
			receiverGoal: handoff.agent.goal,
			requiredCapabilities: [...handoff.receiver.requiredCapabilities],
			risk: handoff.risk,
		};
	}

	private summarizeArtifacts(
		record: ChildRunStatusRecord,
	): readonly SupervisorChildArtifactSummary[] {
		const artifacts: SupervisorChildArtifactSummary[] = [];
		if (record.reviewedArtifactCount > 0) {
			artifacts.push({
				kind: "reviewed_artifacts",
				label: "reviewedArtifactCount",
				count: record.reviewedArtifactCount,
			});
		}

		const handoff = this.handoffs.get(record.runId);
		const args = handoff?.task.arguments ?? {};
		for (const [key, value] of Object.entries(args).sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			const normalizedKey = key.toLowerCase();
			if (
				!ARTIFACT_ARGUMENT_KEY_PARTS.some((part) =>
					normalizedKey.includes(part),
				)
			) {
				continue;
			}
			artifacts.push({
				kind: "handoff_argument",
				label: key,
				value: summarizeValue(value),
			});
		}

		return artifacts;
	}

	private recoverySuggestedAction(
		reason: SupervisorChildRecoveryReason,
		record: ChildRunStatusRecord,
	): string {
		switch (reason) {
			case "stale":
				return "Inspect the latest checkpoint and pending inputs, then resume or restart from the captured context.";
			case "crashed":
				return "Restart the child worker with the recovery context and preserve the prior history as read-only input.";
			case "failed":
				return "Review the terminal failure summary and decide whether to retry, defer, or replace the child run.";
			case "manual":
				return `Use the captured context to continue ${record.taskId} from its latest known state.`;
			default:
				return assertNever(reason);
		}
	}

	private requireRecord(runId: string): ChildRunStatusRecord {
		const record = this.records.get(runId);
		if (record == null) {
			throw new RangeError(`Unknown child run: ${runId}`);
		}
		return record;
	}

	private sortedRecords(): readonly ChildRunStatusRecord[] {
		return [...this.records.values()]
			.map((record) => ({ ...record }))
			.sort((left, right) => left.runId.localeCompare(right.runId));
	}

	private requireCompletion(runId: string): ChildRunDeferred {
		const completion = this.completions.get(runId);
		if (completion == null) {
			throw new RangeError(`Unknown child run completion: ${runId}`);
		}
		return completion;
	}

	private resolveCompletion(runId: string, record: ChildRunStatusRecord): void {
		this.requireCompletion(runId).resolve(record);
	}

	private filterRecords(
		records: readonly ChildRunStatusRecord[],
		query: SupervisorRuntimeRunQuery,
	): readonly ChildRunStatusRecord[] {
		const runIds = normalizeQueryValues(query.runIds);
		const taskIds = normalizeQueryValues(query.taskIds);
		const workerIds = normalizeQueryValues(query.workerIds);
		const statuses = normalizeQueryValues(query.statuses);

		return records.filter(
			(record) =>
				(runIds == null || runIds.has(record.runId)) &&
				(taskIds == null || taskIds.has(record.taskId)) &&
				(workerIds == null ||
					(record.workerId != null && workerIds.has(record.workerId))) &&
				(statuses == null || statuses.has(record.status)),
		);
	}

	private enqueueInput(
		runId: string,
		kind: SupervisorRuntimeInputKind,
		input: string | SupervisorRuntimeInputPayload,
	): SupervisorRuntimeInput {
		const record = this.requireRecord(runId);
		if (isTerminalStatus(record.status)) {
			throw new RangeError("terminal child run cannot receive input");
		}
		if (record.status === "cancel_requested") {
			throw new RangeError("cancel-requested child run cannot receive input");
		}

		const payload = normalizeInputPayload(input);
		if (payload.content.trim().length === 0) {
			throw new RangeError("input content must be a non-empty string");
		}

		this.nextInputSequence += 1;
		const queuedInput: SupervisorRuntimeInput = {
			id: `${runId}:input:${this.nextInputSequence}`,
			runId,
			taskId: record.taskId,
			kind,
			content: payload.content,
			metadata: payload.metadata,
			createdAt: this.now(),
		};

		const waiters = this.inputWaiters.get(runId);
		const waiter = waiters?.shift();
		if (waiter != null) {
			waiter(queuedInput);
			return queuedInput;
		}

		const inputs = this.pendingInputs.get(runId) ?? [];
		inputs.push(queuedInput);
		this.pendingInputs.set(runId, inputs);
		return queuedInput;
	}

	private pendingInput(runId: string): readonly SupervisorRuntimeInput[] {
		this.requireRecord(runId);
		return [...(this.pendingInputs.get(runId) ?? [])];
	}

	private drainInput(runId: string): readonly SupervisorRuntimeInput[] {
		this.requireRecord(runId);
		const inputs = this.pendingInputs.get(runId) ?? [];
		this.pendingInputs.delete(runId);
		return [...inputs];
	}

	private waitForInput(runId: string): Promise<SupervisorRuntimeInput | null> {
		const record = this.requireRecord(runId);
		if (
			record.status === "cancel_requested" ||
			isTerminalStatus(record.status)
		) {
			return Promise.resolve(null);
		}

		const inputs = this.pendingInputs.get(runId) ?? [];
		const input = inputs.shift();
		if (input != null) {
			if (inputs.length === 0) {
				this.pendingInputs.delete(runId);
			}
			return Promise.resolve(input);
		}

		return new Promise((resolve) => {
			const waiters = this.inputWaiters.get(runId) ?? [];
			waiters.push(resolve);
			this.inputWaiters.set(runId, waiters);
		});
	}

	private resolveInputWaiters(
		runId: string,
		input: SupervisorRuntimeInput | null,
	): void {
		const waiters = this.inputWaiters.get(runId) ?? [];
		this.inputWaiters.delete(runId);
		for (const waiter of waiters) {
			waiter(input);
		}
	}

	private closeInputPort(runId: string): void {
		this.pendingInputs.delete(runId);
		this.resolveInputWaiters(runId, null);
	}

	private isPaused(runId: string): boolean {
		return this.activeRuns.get(runId)?.paused === true;
	}

	private waitUntilResumed(runId: string): Promise<void> {
		const state = this.activeRuns.get(runId);
		if (state == null || !state.paused) {
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			state.resumeWaiters.push(resolve);
		});
	}

	private releasePauseWaiters(state: ActiveRunState): void {
		state.paused = false;
		const waiters = state.resumeWaiters.splice(0);
		for (const waiter of waiters) {
			waiter();
		}
	}
}

function createChildRunDeferred(): ChildRunDeferred {
	let resolve!: (record: ChildRunStatusRecord) => void;
	const promise = new Promise<ChildRunStatusRecord>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
}
