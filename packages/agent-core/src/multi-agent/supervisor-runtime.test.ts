import { describe, expect, it, vi } from "vitest";
import {
	type DagPlan,
	type DelegationHandoff,
	evaluateDelegation,
	type SubTask,
} from "../planning/index.js";
import {
	InProcessSupervisorRuntime,
	type SupervisorProgressEvent,
	type SupervisorProgressEventSink,
	type SupervisorWorker,
} from "./index.js";

const NOW = "2026-05-02T08:00:00.000Z";

function createClock(): () => string {
	let tick = 0;
	return () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString();
}

function createDeferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function expectPending<T>(promise: Promise<T>): Promise<void> {
	await expect(
		Promise.race([promise, Promise.resolve("pending")]),
	).resolves.toBe("pending");
}

function createRecordingSink(): {
	readonly events: SupervisorProgressEvent[];
	readonly sink: SupervisorProgressEventSink;
} {
	const events: SupervisorProgressEvent[] = [];
	return {
		events,
		sink: {
			record: (event) => {
				events.push(event);
			},
			flush: () => ({
				events: [],
				counts: {
					progress_snapshot: 0,
					child_stale: 0,
					child_heartbeat: 0,
					child_checkpoint: 0,
					terminal_children_summary: 0,
				},
				severities: {
					info: 0,
					warning: 0,
					success: 0,
					error: 0,
				},
				cursor: null,
				latestOccurredAt: null,
			}),
		},
	};
}

function makeStep(id: string, overrides: Partial<SubTask> = {}): SubTask {
	return {
		id,
		action: overrides.action ?? "research",
		name: overrides.name ?? `Step ${id}`,
		description: overrides.description ?? `Execute ${id}`,
		estimatedTokens: overrides.estimatedTokens ?? 120,
		estimatedSteps: overrides.estimatedSteps ?? 2,
		preconditions: overrides.preconditions ?? [],
		effects: overrides.effects ?? [`effect:${id}`],
		skillHint: overrides.skillHint,
		arguments: overrides.arguments,
		depth: overrides.depth,
		writeScope: overrides.writeScope,
		risk: overrides.risk,
		scratchpad: overrides.scratchpad,
	};
}

function makeHandoff(taskId = "delegated-research"): DelegationHandoff {
	const mainStep = makeStep("main-summary", {
		action: "tool",
		writeScope: "working",
		arguments: { path: "summary.md" },
		risk: "low",
	});
	const delegatedStep = makeStep(taskId, {
		action: "research",
		writeScope: "episodic",
		arguments: { path: `${taskId}.md` },
		estimatedSteps: 4,
		risk: "medium",
	});
	const plan: DagPlan = {
		kind: "dag",
		subtasks: [mainStep, delegatedStep],
		edges: [],
	};
	const decision = evaluateDelegation({
		parentRunId: "run-supervisor-runtime",
		candidateStep: delegatedStep,
		plan,
		mainAgentSteps: [mainStep],
		triggers: {
			longRunningTask: true,
			decomposableSubtask: true,
			nonBlockingSupervisorRequired: true,
			subAgentCapabilityAvailable: true,
		},
		subAgent: {
			role: "research-worker",
			goal: "Complete delegated research and report checkpoints",
		},
	});

	if (!decision.delegate) {
		throw new Error(`Expected delegation handoff, got ${decision.reason}`);
	}

	return decision.assignment.handoff;
}

describe("InProcessSupervisorRuntime", () => {
	it("admits typed delegation handoffs idempotently without starting workers", () => {
		const handoff = makeHandoff();
		const worker = {
			workerId: "worker-1",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const firstAdmission = runtime.admitHandoff(handoff);
		const secondAdmission = runtime.admitHandoff(handoff);

		expect(worker.execute).not.toHaveBeenCalled();
		expect(runtime.listRecords()).toHaveLength(1);
		expect(firstAdmission.record).toMatchObject({
			runId: "run-supervisor-runtime:delegated:delegated-research",
			taskId: "delegated-research",
			status: "queued",
			summary: "Queued handoff to research-worker: Step delegated-research",
		});
		expect(secondAdmission.record).toEqual(firstAdmission.record);
		expect(runtime.snapshot().projection.snapshot).toMatchObject({
			band: "starting",
			queuedRunIds: ["run-supervisor-runtime:delegated:delegated-research"],
		});
	});

	it("dispatches matching workers and records heartbeat progress to completion", async () => {
		const handoff = makeHandoff();
		const release = createDeferred();
		const worker = {
			workerId: "worker-1",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "reading local context",
					currentStep: "reading sources",
					progress: { completedSteps: 1, totalSteps: 4 },
					nextCheckpointAt: "2026-05-02T08:05:00.000Z",
					confidence: "medium",
				});
				await release.promise;
				return {
					summary: "research complete",
					confidence: "high" as const,
					reviewedArtifactCount: 2,
				};
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const handle = runtime.dispatch(handoff);

		expect(worker.execute).toHaveBeenCalledOnce();
		expect(runtime.getRecord(handle.runId)).toMatchObject({
			status: "active",
			workerId: "worker-1",
			currentStep: "reading sources",
			progress: { completedSteps: 1, totalSteps: 4 },
		});
		expect(runtime.snapshot().projection.snapshot).toMatchObject({
			band: "making_progress",
			activeRunIds: [handle.runId],
			currentSteps: ["reading sources"],
			boundedPercent: 25,
		});
		expect(
			runtime
				.snapshot()
				.projection.events.some(
					(event) =>
						event.type === "child_checkpoint" && event.runId === handle.runId,
				),
		).toBe(true);

		release.resolve();
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "research complete",
			reviewedArtifactCount: 2,
		});
		expect(runtime.getRecord(handle.runId)).toMatchObject({
			status: "completed",
			summary: "research complete",
		});
		expect(runtime.getRecord(handle.runId)?.currentStep).toBeUndefined();
		expect(runtime.getRecord(handle.runId)?.progress).toBeUndefined();
		expect(runtime.snapshot().projection.snapshot).toMatchObject({
			band: "done",
			terminalRunIds: [handle.runId],
			reviewedArtifactCount: 2,
		});
		expect(runtime.flush().attention.status).toBe("healthy");
	});

	it("keeps excess handoffs queued until active capacity frees", async () => {
		const releases = [createDeferred(), createDeferred()];
		const worker = {
			workerId: "worker-1",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: `running ${context.taskId}`,
					currentStep: `working ${context.taskId}`,
					progress: { completedSteps: 1, totalSteps: 2 },
				});
				await releases[vi.mocked(worker.execute).mock.calls.length - 1]
					?.promise;
				return { summary: `done ${context.taskId}` };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			maxActiveRuns: 1,
			now: createClock(),
		});
		const first = runtime.dispatch(makeHandoff("delegated-a"));
		const second = runtime.dispatch(makeHandoff("delegated-b"));

		expect(runtime.getRecord(first.runId)?.status).toBe("active");
		expect(runtime.getRecord(second.runId)?.status).toBe("queued");
		expect(worker.execute).toHaveBeenCalledTimes(1);

		releases[0]?.resolve();
		await first.completion;

		expect(worker.execute).toHaveBeenCalledTimes(2);
		expect(runtime.getRecord(second.runId)).toMatchObject({
			status: "active",
			currentStep: "working delegated-b",
		});

		releases[1]?.resolve();
		await expect(second.completion).resolves.toMatchObject({
			status: "completed",
			summary: "done delegated-b",
		});
		expect(runtime.snapshot().projection.snapshot).toMatchObject({
			band: "done",
			terminalRunIds: [first.runId, second.runId],
		});
	});

	it("records failed workers and unavailable workers as terminal child runs", async () => {
		const failingWorker = {
			workerId: "worker-fail",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async () => {
				throw new Error("worker exploded");
			}),
		} satisfies SupervisorWorker;
		const failingRuntime = new InProcessSupervisorRuntime({
			workers: [failingWorker],
			now: createClock(),
		});
		const failingHandle = failingRuntime.dispatch(
			makeHandoff("delegated-fail"),
		);

		await expect(failingHandle.completion).resolves.toMatchObject({
			status: "failed",
			summary: "worker exploded",
			confidence: "low",
		});

		const unavailableRuntime = new InProcessSupervisorRuntime({
			workers: [],
			now: createClock(),
		});
		const unavailableHandle = unavailableRuntime.dispatch(
			makeHandoff("delegated-unavailable"),
		);

		await expect(unavailableHandle.completion).resolves.toMatchObject({
			status: "failed",
			summary: "No supervisor worker available for research-worker",
		});
	});

	it("rejects public heartbeat attempts to force terminal states", async () => {
		const release = createDeferred();
		const worker = {
			workerId: "worker-guarded",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "working",
					currentStep: "working",
				});
				await release.promise;
				return { summary: "done" };
			}),
		} satisfies SupervisorWorker;
		const queuedRuntime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});
		const activeRuntime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});
		const admission = queuedRuntime.admitHandoff(
			makeHandoff("delegated-queued"),
		);

		expect(() =>
			queuedRuntime.heartbeat(admission.runId, {
				status: "completed",
				summary: "forced completion",
			}),
		).toThrow("heartbeat cannot transition a child run to a terminal status");
		expect(() =>
			queuedRuntime.heartbeat(admission.runId, {
				status: "active",
				summary: "forced start",
			}),
		).toThrow(
			"queued child run cannot receive a running heartbeat before dispatch",
		);
		expect(queuedRuntime.getRecord(admission.runId)?.status).toBe("queued");

		const handle = activeRuntime.dispatch(makeHandoff("delegated-active"));
		expect(() =>
			activeRuntime.heartbeat(handle.runId, {
				status: "failed",
				summary: "forced failure",
			}),
		).toThrow("heartbeat cannot transition a child run to a terminal status");
		expect(activeRuntime.getRecord(handle.runId)).toMatchObject({
			status: "active",
			currentStep: "working",
		});
		await expectPending(handle.completion);

		release.resolve();
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "done",
		});
	});

	it("does not replay unchanged projected child events into the sink", async () => {
		const releases = [createDeferred(), createDeferred()];
		const { events: recordedEvents, sink } = createRecordingSink();
		const worker = {
			workerId: "worker-events",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: `working ${context.taskId}`,
					currentStep: `working ${context.taskId}`,
				});
				await releases[vi.mocked(worker.execute).mock.calls.length - 1]
					?.promise;
				return { summary: `done ${context.taskId}` };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			maxActiveRuns: 1,
			now: createClock(),
			sink,
		});
		const childHeartbeatCount = (runId: string) =>
			recordedEvents.filter(
				(event) => event.type === "child_heartbeat" && event.runId === runId,
			).length;
		const terminalSummaryCount = (runId: string) =>
			recordedEvents.filter(
				(event) =>
					event.type === "terminal_children_summary" &&
					event.payload.children.some((child) => child.runId === runId),
			).length;

		const first = runtime.dispatch(makeHandoff("delegated-events-a"));
		const firstHeartbeatCount = childHeartbeatCount(first.runId);
		const second = runtime.dispatch(makeHandoff("delegated-events-b"));

		expect(runtime.getRecord(second.runId)?.status).toBe("queued");
		expect(childHeartbeatCount(first.runId)).toBe(firstHeartbeatCount);

		releases[0]?.resolve();
		await expect(first.completion).resolves.toMatchObject({
			status: "completed",
			summary: "done delegated-events-a",
		});
		expect(terminalSummaryCount(first.runId)).toBe(1);

		runtime.heartbeat(second.runId, {
			status: "active",
			summary: "second explicit checkpoint",
			currentStep: "second explicit checkpoint",
		});

		expect(terminalSummaryCount(first.runId)).toBe(1);
		releases[1]?.resolve();
		await expect(second.completion).resolves.toMatchObject({
			status: "completed",
			summary: "done delegated-events-b",
		});
	});

	it("emits same-tick child heartbeat payload changes into the sink", async () => {
		const release = createDeferred();
		const { events: recordedEvents, sink } = createRecordingSink();
		const worker = {
			workerId: "worker-same-tick",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "same-tick active heartbeat",
					currentStep: "same-tick active heartbeat",
					nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				});
				await release.promise;
				return { summary: "done same tick" };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: () => NOW,
			sink,
		});

		const handle = runtime.dispatch(makeHandoff("delegated-same-tick"));
		const childHeartbeats = recordedEvents.filter(
			(
				event,
			): event is Extract<
				SupervisorProgressEvent,
				{ readonly type: "child_heartbeat" }
			> => event.type === "child_heartbeat" && event.runId === handle.runId,
		);

		expect(childHeartbeats.map((event) => event.payload.status)).toContain(
			"active",
		);
		expect(
			childHeartbeats.some(
				(event) => event.payload.summary === "same-tick active heartbeat",
			),
		).toBe(true);
		expect(
			recordedEvents.some(
				(event) =>
					event.type === "child_checkpoint" && event.runId === handle.runId,
			),
		).toBe(true);

		release.resolve();
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "done same tick",
		});
	});

	it("cancels active child runs only after worker acknowledgement", async () => {
		const releases = [createDeferred(), createDeferred()];
		const worker = {
			workerId: "worker-cancel",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: `working ${context.taskId}`,
					currentStep: `working ${context.taskId}`,
					progress: { completedSteps: 1, totalSteps: 2 },
				});
				await releases[vi.mocked(worker.execute).mock.calls.length - 1]
					?.promise;
				return { summary: `done ${context.taskId}` };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			maxActiveRuns: 1,
			now: createClock(),
		});
		const first = runtime.dispatch(makeHandoff("delegated-cancel"));
		const second = runtime.dispatch(makeHandoff("delegated-after-cancel"));

		const cancelRequested = runtime.cancel(
			first.runId,
			"user requested cancel",
		);

		expect(cancelRequested).toMatchObject({
			status: "cancel_requested",
			summary: "user requested cancel",
			currentStep: "cancelling",
		});
		expect(worker.execute).toHaveBeenCalledTimes(1);
		expect(runtime.getRecord(second.runId)?.status).toBe("queued");
		expect(runtime.snapshot().projection.snapshot).toMatchObject({
			band: "wrapping_up",
			activeRunIds: [first.runId],
			queuedRunIds: [second.runId],
		});
		expect(() =>
			runtime.heartbeat(first.runId, {
				status: "active",
				summary: "still running after cancel",
			}),
		).toThrow("cancel-requested child run cannot be moved by heartbeat");
		expect(runtime.getRecord(first.runId)).toMatchObject({
			status: "cancel_requested",
			summary: "user requested cancel",
		});
		await expectPending(first.completion);

		releases[0]?.resolve();
		await expect(first.completion).resolves.toMatchObject({
			status: "cancelled",
			summary: "user requested cancel",
		});
		expect(worker.execute).toHaveBeenCalledTimes(2);
		expect(runtime.getRecord(second.runId)).toMatchObject({
			status: "active",
			currentStep: "working delegated-after-cancel",
		});
		expect(() =>
			runtime.heartbeat(first.runId, {
				status: "active",
				summary: "late heartbeat",
			}),
		).toThrow("terminal child run cannot be updated");

		releases[1]?.resolve();
		await expect(second.completion).resolves.toMatchObject({
			status: "completed",
			summary: "done delegated-after-cancel",
		});
		const finalSnapshot = runtime.snapshot().projection.snapshot;
		expect(finalSnapshot.band).toBe("failed");
		expect(finalSnapshot.terminalRunIds).toEqual(
			[first.runId, second.runId].sort(),
		);
	});
});
