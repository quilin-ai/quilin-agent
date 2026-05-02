import type { DelegationHandoff } from "../planning/delegation.js";
import {
	type ChildRunHeartbeat,
	type ChildRunStatusRecord,
	createBufferedSupervisorProgressSink,
	createChildRunStatusRecord,
	createChildRunStatusRecordFromDelegationHandoff,
	flushSupervisorProgressSinkReport,
	projectSupervisorProgressEvents,
	recordChildRunHeartbeat,
	recordSupervisorProgressEvent,
	type SupervisorConfidence,
	type SupervisorProgressEvent,
	type SupervisorProgressEventProjection,
	type SupervisorProgressEventSink,
	type SupervisorProgressSinkBatchReport,
} from "./index.js";

export interface SupervisorWorkerResult {
	readonly summary?: string;
	readonly confidence?: SupervisorConfidence;
	readonly reviewedArtifactCount?: number;
}

export interface SupervisorWorkerContext {
	readonly runId: string;
	readonly taskId: string;
	readonly cancelToken: string;
	readonly signal: AbortSignal;
	readonly heartbeat: (heartbeat: ChildRunHeartbeat) => ChildRunStatusRecord;
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

interface ActiveRunState {
	readonly controller: AbortController;
}

interface ChildRunDeferred {
	readonly promise: Promise<ChildRunStatusRecord>;
	readonly resolve: (record: ChildRunStatusRecord) => void;
}

const WORKER_HEARTBEAT_STATUSES = new Set<ChildRunStatusRecord["status"]>([
	"active",
	"blocked",
	"waiting_for_review",
	"aggregating",
]);

function isTerminalStatus(status: ChildRunStatusRecord["status"]): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "deferred"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	private readonly records = new Map<string, ChildRunStatusRecord>();
	private readonly handoffs = new Map<string, DelegationHandoff>();
	private readonly completions = new Map<string, ChildRunDeferred>();
	private readonly activeRuns = new Map<string, ActiveRunState>();
	private readonly emittedEventKeys = new Set<string>();

	constructor(options: InProcessSupervisorRuntimeOptions = {}) {
		this.workers = options.workers ?? [];
		this.sink = options.sink ?? createBufferedSupervisorProgressSink();
		this.now = options.now ?? (() => new Date().toISOString());
		this.staleAfterMs = options.staleAfterMs;
		this.maxActiveRuns = options.maxActiveRuns ?? Number.POSITIVE_INFINITY;
		if (
			!Number.isFinite(this.maxActiveRuns) &&
			this.maxActiveRuns !== Number.POSITIVE_INFINITY
		) {
			throw new RangeError("maxActiveRuns must be a positive number");
		}
		if (this.maxActiveRuns < 1) {
			throw new RangeError("maxActiveRuns must be a positive number");
		}
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
			this.startQueuedRuns();
			return record;
		}

		state.controller.abort(reason);
		return this.updateRuntimeRecord(runId, {
			status: "cancel_requested",
			summary: reason,
			currentStep: "cancelling",
			confidence: "low",
		});
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
		this.activeRuns.set(runId, { controller });
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
				status: "completed",
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
			return this.writeTerminalRecord(handoff.childRunId, {
				status: shouldCancel ? "cancelled" : "failed",
				summary: shouldCancel
					? cancellationReason(handoff.childRunId, controller, currentRecord)
					: errorMessage(error),
				confidence: "low",
			});
		} finally {
			this.activeRuns.delete(handoff.childRunId);
			const record = this.requireRecord(handoff.childRunId);
			if (isTerminalStatus(record.status)) {
				this.resolveCompletion(handoff.childRunId, record);
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
		assertWorkerHeartbeatTransition(
			currentRecord,
			heartbeat,
			this.activeRuns.has(runId),
		);
		return this.writeRecord(runId, heartbeat);
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
		this.records.set(record.runId, record);
		for (const event of this.snapshot().projection.events) {
			const key = supervisorProgressEventEmissionKey(event);
			if (this.emittedEventKeys.has(key)) {
				continue;
			}
			this.emittedEventKeys.add(key);
			recordSupervisorProgressEvent(this.sink, event);
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
}

function createChildRunDeferred(): ChildRunDeferred {
	let resolve!: (record: ChildRunStatusRecord) => void;
	const promise = new Promise<ChildRunStatusRecord>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
}
