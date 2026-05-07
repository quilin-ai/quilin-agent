import { describe, expect, it, vi } from "vitest";
import {
	type DagPlan,
	type DelegationHandoff,
	evaluateDelegation,
	type SubTask,
} from "../planning/index.js";
import {
	InProcessSupervisorRuntime,
	type SupervisorChildEvent,
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

function createManualClock(initial = NOW): {
	readonly now: () => string;
	readonly set: (next: string) => void;
} {
	let current = initial;
	return {
		now: () => current,
		set: (next) => {
			current = next;
		},
	};
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

	it("keeps recovery context when child workers crash", async () => {
		const worker = {
			workerId: "worker-crash",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "captured before crash",
					currentStep: "writing crash context",
					nextCheckpointAt: "2026-05-02T08:05:00.000Z",
					reviewedArtifactCount: 1,
				});
				throw new Error("worker crashed mid-run");
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const handle = runtime.dispatch(makeHandoff("delegated-crash"));

		await expect(handle.completion).resolves.toMatchObject({
			status: "failed",
			summary: "worker crashed mid-run",
		});
		const recovery = runtime
			.drainChildEvents({ types: "recovery" })
			.find(
				(
					event,
				): event is Extract<
					SupervisorChildEvent,
					{ readonly type: "recovery" }
				> => event.type === "recovery",
			);

		expect(recovery?.payload.plan).toMatchObject({
			reason: "crashed",
			runId: handle.runId,
			taskId: handle.taskId,
			status: "failed",
			summary: "worker crashed mid-run",
			context: {
				record: {
					status: "failed",
					summary: "worker crashed mid-run",
				},
				handoff: {
					taskName: "Step delegated-crash",
					receiverRole: "research-worker",
				},
			},
		});
		expect(
			recovery?.payload.plan.context.history.map((entry) => entry.type),
		).toEqual(["heartbeat", "heartbeat", "checkpoint", "completion"]);
		expect(recovery?.payload.plan.context.artifacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "handoff_argument",
					label: "path",
					value: "delegated-crash.md",
				}),
				expect.objectContaining({
					kind: "reviewed_artifacts",
					count: 1,
				}),
			]),
		);
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

	it("publishes subscribed and drainable child lifecycle notifications", async () => {
		const received: SupervisorChildEvent[] = [];
		const worker = {
			workerId: "worker-notify",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "collecting evidence",
					currentStep: "collecting evidence",
					progress: { completedSteps: 1, totalSteps: 3 },
					nextCheckpointAt: "2026-05-02T08:03:00.000Z",
				});
				context.reportBlocked({
					summary: "Need reviewer to confirm merge order",
					blocker: "merge order decision required",
					currentStep: "blocked on review",
				});
				return { summary: "notification run finished" };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});
		const unsubscribe = runtime.subscribeChildEvents((event) => {
			received.push(event);
		});

		const handle = runtime.dispatch(makeHandoff("delegated-notify"));
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "notification run finished",
		});

		expect(received.map((event) => event.type)).toEqual([
			"heartbeat",
			"heartbeat",
			"checkpoint",
			"heartbeat",
			"blocked",
			"completion",
		]);
		expect(runtime.recentChildEvents(2).map((event) => event.type)).toEqual([
			"blocked",
			"completion",
		]);
		expect(
			runtime
				.drainChildEvents({ types: ["checkpoint", "blocked"] })
				.map((event) => event.type),
		).toEqual(["checkpoint", "blocked"]);
		expect(
			runtime
				.drainChildEvents({ types: ["checkpoint", "blocked"] })
				.map((event) => event.type),
		).toEqual([]);

		unsubscribe();
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
		expect(runtime.pause(first.runId, "pause after cancel")).toMatchObject({
			status: "cancel_requested",
			summary: "user requested cancel",
		});
		expect(runtime.resume(first.runId, "resume after cancel")).toMatchObject({
			status: "cancel_requested",
			summary: "user requested cancel",
		});
		expect(runtime.wake(first.runId, "wake after cancel")).toMatchObject({
			status: "cancel_requested",
			summary: "user requested cancel",
		});
		expect(() => runtime.sendInput(first.runId, "input after cancel")).toThrow(
			"cancel-requested child run cannot receive input",
		);
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

	it("releases workers blocked on input waiters when cancellation is requested", async () => {
		const started = createDeferred();
		let observedInput: unknown = "unset";
		const worker = {
			workerId: "worker-cancel-waiting-input",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "waiting for main-agent input",
					currentStep: "waiting for input",
				});
				started.resolve();

				observedInput = await context.waitForInput();
				return { summary: "worker returned after input port closed" };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const handle = runtime.dispatch(makeHandoff("delegated-cancel-waiter"));
		await started.promise;
		await expectPending(handle.completion);

		const cancelRequested = runtime.cancel(
			handle.runId,
			"user cancelled waiting worker",
		);

		expect(cancelRequested).toMatchObject({
			status: "cancel_requested",
			summary: "user cancelled waiting worker",
		});
		await expect(handle.completion).resolves.toMatchObject({
			status: "cancelled",
			summary: "user cancelled waiting worker",
		});
		expect(observedInput).toBeNull();
		expect(() => runtime.sendInput(handle.runId, "late input")).toThrow(
			"terminal child run cannot receive input",
		);
	});

	it("lets workers report needs-decision lifecycle escalation and get reclaimed", async () => {
		const decisionRelease = createDeferred();
		const secondRelease = createDeferred();
		const { events: recordedEvents, sink } = createRecordingSink();
		const worker = {
			workerId: "worker-decision",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				if (context.taskId === "delegated-needs-decision") {
					const escalation = context.needsDecision({
						summary: "Need main agent to choose source policy",
						blocker: "source policy decision required",
						nextCheckpointAt: "2026-05-02T08:05:00.000Z",
					});
					expect(escalation).toMatchObject({
						status: "blocked",
						currentStep: "needs_decision",
						blocker: "source policy decision required",
					});
					await context.waitUntilResumed();
					await decisionRelease.promise;
					return { summary: "decision handled" };
				}

				context.heartbeat({
					status: "active",
					summary: `running ${context.taskId}`,
					currentStep: `running ${context.taskId}`,
				});
				await secondRelease.promise;
				return { summary: `done ${context.taskId}` };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			maxActiveRuns: 1,
			now: createClock(),
			sink,
		});

		const first = runtime.dispatch(makeHandoff("delegated-needs-decision"));
		const second = runtime.dispatch(makeHandoff("delegated-after-decision"));

		expect(runtime.getRecord(first.runId)).toMatchObject({
			status: "blocked",
			currentStep: "needs_decision",
			blocker: "source policy decision required",
		});
		expect(runtime.getRecord(second.runId)?.status).toBe("queued");
		expect(
			recordedEvents.some(
				(event) =>
					event.type === "child_heartbeat" &&
					event.runId === first.runId &&
					event.payload.status === "blocked" &&
					event.payload.currentStep === "needs_decision" &&
					event.payload.blocker === "source policy decision required",
			),
		).toBe(true);
		await expectPending(first.completion);

		runtime.resume(first.runId, "main agent selected source policy");
		decisionRelease.resolve();
		await expect(first.completion).resolves.toMatchObject({
			status: "completed",
			summary: "decision handled",
		});
		expect(worker.execute).toHaveBeenCalledTimes(2);
		expect(runtime.getRecord(second.runId)).toMatchObject({
			status: "active",
			currentStep: "running delegated-after-decision",
		});

		secondRelease.resolve();
		await expect(second.completion).resolves.toMatchObject({
			status: "completed",
			summary: "done delegated-after-decision",
		});
	});

	it("delivers appended and sent input to running workers in order", async () => {
		const started = createDeferred();
		const receivedInputs: string[] = [];
		const worker = {
			workerId: "worker-input",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "waiting for control input",
					currentStep: "waiting for control input",
				});
				started.resolve();

				const firstInput = await context.waitForInput();
				const secondInput = await context.waitForInput();
				for (const input of [firstInput, secondInput]) {
					if (input != null) {
						receivedInputs.push(`${input.kind}:${input.content}`);
					}
				}

				return { summary: "handled control input" };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const handle = runtime.dispatch(makeHandoff("delegated-input"));
		await started.promise;

		const appended = runtime.appendInput(handle.runId, "extra context");
		const sent = runtime.sendInput(handle.runId, {
			content: "correct course",
			metadata: { priority: "high" },
		});

		expect(appended).toMatchObject({
			runId: handle.runId,
			taskId: handle.taskId,
			kind: "append",
			content: "extra context",
		});
		expect(sent).toMatchObject({
			kind: "send",
			content: "correct course",
			metadata: { priority: "high" },
		});
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "handled control input",
		});
		expect(receivedInputs).toEqual([
			"append:extra context",
			"send:correct course",
		]);
	});

	it("pauses active workers cooperatively and resumes them through wake", async () => {
		const started = createDeferred();
		const pauseObserved = createDeferred();
		const release = createDeferred();
		const worker = {
			workerId: "worker-pause",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "running before pause",
					currentStep: "running before pause",
				});
				started.resolve();
				await pauseObserved.promise;

				expect(context.isPaused()).toBe(true);
				await context.waitUntilResumed();
				expect(context.isPaused()).toBe(false);
				context.heartbeat({
					status: "active",
					summary: "running after wake",
					currentStep: "running after wake",
				});
				await release.promise;
				return { summary: "pause flow complete" };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const handle = runtime.dispatch(makeHandoff("delegated-pause"));
		await started.promise;

		const paused = runtime.pause(handle.runId, "user paused run");
		expect(paused).toMatchObject({
			status: "blocked",
			summary: "user paused run",
			currentStep: "paused",
			blocker: "user paused run",
		});
		expect(runtime.listRuns({ statuses: "blocked" })).toHaveLength(1);
		expect(
			runtime.queryRuns({ statuses: ["blocked"] }).projection.snapshot,
		).toMatchObject({
			band: "blocked",
			blockedRunIds: [handle.runId],
		});

		pauseObserved.resolve();
		await expectPending(handle.completion);

		const woken = runtime.wake(handle.runId, "user resumed run");
		expect(woken).toMatchObject({
			status: "active",
			summary: "user resumed run",
			currentStep: "resuming",
		});

		release.resolve();
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "pause flow complete",
		});
	});

	it("interrupts active workers with control input without cancelling them", async () => {
		const started = createDeferred();
		const interruptObserved = createDeferred();
		const worker = {
			workerId: "worker-interrupt",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "running before interrupt",
					currentStep: "running before interrupt",
				});
				started.resolve();

				const input = await context.waitForInput();
				expect(input).toMatchObject({
					kind: "interrupt",
					content: "review correction needed",
				});
				interruptObserved.resolve();
				await context.waitUntilResumed();
				return { summary: "interrupt handled" };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const handle = runtime.dispatch(makeHandoff("delegated-interrupt"));
		await started.promise;

		const interrupted = runtime.interrupt(
			handle.runId,
			"review correction needed",
		);
		expect(interrupted).toMatchObject({
			status: "blocked",
			summary: "review correction needed",
			currentStep: "interrupted",
			blocker: "review correction needed",
		});
		await interruptObserved.promise;
		await expectPending(handle.completion);

		runtime.resume(handle.runId, "correction accepted");
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "interrupt handled",
		});
	});

	it("wakes paused queued runs and reports filtered status projections", async () => {
		const release = createDeferred();
		const worker = {
			workerId: "worker-wake-queued",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: `running ${context.taskId}`,
					currentStep: `running ${context.taskId}`,
				});
				await release.promise;
				return { summary: `done ${context.taskId}` };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});
		const admission = runtime.admitHandoff(makeHandoff("delegated-wake"));

		runtime.pause(admission.runId, "hold until operator wakes run");
		expect(worker.execute).not.toHaveBeenCalled();
		expect(runtime.listRuns({ statuses: ["blocked"] })).toHaveLength(1);
		expect(runtime.listRuns({ taskIds: "delegated-wake" })).toHaveLength(1);

		const woken = runtime.wake(admission.runId, "operator woke run");
		expect(woken).toMatchObject({
			status: "active",
			currentStep: "running delegated-wake",
		});
		expect(worker.execute).toHaveBeenCalledOnce();
		expect(
			runtime.queryRuns({ workerIds: "worker-wake-queued" }).records,
		).toHaveLength(1);

		release.resolve();
		await expect(
			runtime.dispatch(makeHandoff("delegated-wake")).completion,
		).resolves.toMatchObject({
			status: "completed",
			summary: "done delegated-wake",
		});
	});

	it("detects stale children and emits recovery plans with resumable context", async () => {
		const clock = createManualClock();
		const release = createDeferred();
		const worker = {
			workerId: "worker-stale",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async (_handoff, context) => {
				context.heartbeat({
					status: "active",
					summary: "halfway through stale task",
					currentStep: "collecting stale context",
					progress: { completedSteps: 2, totalSteps: 4 },
					nextCheckpointAt: "2026-05-02T08:01:00.000Z",
					confidence: "medium",
				});
				await release.promise;
				return {
					summary: "stale worker eventually completed",
					confidence: "high" as const,
				};
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: clock.now,
			staleAfterMs: 120_000,
		});

		const handle = runtime.dispatch(makeHandoff("delegated-stale"));
		runtime.drainChildEvents();
		runtime.appendInput(handle.runId, {
			content: "main-agent correction to preserve",
			metadata: { source: "operator", priority: "high" },
		});
		clock.set("2026-05-02T08:05:00.000Z");

		const plans = runtime.detectStaleRuns();
		const drained = runtime.drainChildEvents();
		const recovery = drained.find(
			(
				event,
			): event is Extract<
				SupervisorChildEvent,
				{ readonly type: "recovery" }
			> => event.type === "recovery",
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			reason: "stale",
			runId: handle.runId,
			taskId: handle.taskId,
			status: "active",
			summary: "halfway through stale task",
			context: {
				heartbeatAgeMs: 300_000,
				record: {
					currentStep: "collecting stale context",
					progress: { completedSteps: 2, totalSteps: 4 },
				},
				pendingInputs: [
					{
						kind: "append",
						contentPreview: "main-agent correction to preserve",
						metadataKeys: ["priority", "source"],
					},
				],
				checkpoints: [
					{
						nextCheckpointAt: "2026-05-02T08:01:00.000Z",
						summary: "halfway through stale task",
					},
				],
			},
		});
		expect(drained.map((event) => event.type)).toEqual(["stale", "recovery"]);
		expect(recovery?.payload.plan.context.artifacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "handoff_argument",
					label: "path",
					value: "delegated-stale.md",
				}),
			]),
		);
		expect(runtime.detectStaleRuns().map((plan) => plan.reason)).toEqual([
			"stale",
		]);
		expect(runtime.drainChildEvents({ types: ["stale", "recovery"] })).toEqual(
			[],
		);

		release.resolve();
		await expect(handle.completion).resolves.toMatchObject({
			status: "completed",
			summary: "stale worker eventually completed",
		});
	});

	it("can defer child runs as terminal lifecycle records", async () => {
		const release = createDeferred();
		const worker = {
			workerId: "worker-defer",
			role: "research-worker",
			capabilities: ["research"],
			execute: vi.fn(async () => {
				await release.promise;
				return { summary: "unexpected completion" };
			}),
		} satisfies SupervisorWorker;
		const runtime = new InProcessSupervisorRuntime({
			workers: [worker],
			now: createClock(),
		});

		const handle = runtime.dispatch(makeHandoff("delegated-defer"));
		const deferred = runtime.defer(handle.runId, "waiting for later batch");

		expect(deferred).toMatchObject({
			status: "deferred",
			summary: "waiting for later batch",
		});
		await expect(handle.completion).resolves.toMatchObject({
			status: "deferred",
			summary: "waiting for later batch",
		});
		expect(
			runtime.queryRuns({ statuses: "deferred" }).projection.snapshot,
		).toMatchObject({
			band: "done",
			terminalRunIds: [handle.runId],
		});

		release.resolve();
	});
});
