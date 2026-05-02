import { describe, expect, it, vi } from "vitest";
import {
	aggregateSupervisorProgress,
	applySupervisorProgressProjection,
	applySupervisorProgressProjectionReport,
	applySupervisorProgressProjectionsReport,
	createBufferedSupervisorProgressSink,
	createChildRunStatusRecord,
	flushSupervisorProgressSinkReport,
	projectSupervisorProgressEvents,
	recordChildRunHeartbeat,
	recordSupervisorProgressEvent,
	replaySupervisorProgressEvents,
	replaySupervisorProgressEventsReport,
	type SupervisorProgressEventSink,
	type SupervisorProgressSinkBatchSummary,
	type SupervisorProgressSinkFlushResult,
	summarizeSupervisorProgressSinkBatchAttention,
	summarizeSupervisorProgressSinkFlushReport,
	summarizeSupervisorProgressSinkFlushResults,
} from "./index.js";

const NOW = "2026-05-02T08:00:00.000Z";

function emptySinkFlushResult(): SupervisorProgressSinkFlushResult {
	return {
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
	};
}

describe("multi-agent supervisor progress", () => {
	it("aggregates child status records into a deterministic non-blocking snapshot", () => {
		const snapshot = aggregateSupervisorProgress(
			[
				createChildRunStatusRecord({
					runId: "run-c",
					taskId: "task-1",
					status: "active",
					summary: "implementing runtime primitive",
					currentStep: "writing tests",
					confidence: "medium",
					reviewedArtifactCount: 1,
					lastHeartbeatAt: "2026-05-02T07:59:30.000Z",
					nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-a",
					taskId: "task-2",
					status: "blocked",
					summary: "waiting for capacity",
					blocker: "resource gate closed",
					confidence: "low",
					lastHeartbeatAt: "2026-05-02T07:55:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-b",
					taskId: "task-3",
					status: "completed",
					summary: "review artifact ready",
					confidence: "high",
					reviewedArtifactCount: 2,
					lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);

		expect(snapshot.band).toBe("blocked");
		expect(snapshot.counts).toMatchObject({
			active: 1,
			blocked: 1,
			completed: 1,
		});
		expect(snapshot.activeRunIds).toEqual(["run-a", "run-c"]);
		expect(snapshot.blockedRunIds).toEqual(["run-a"]);
		expect(snapshot.staleRunIds).toEqual(["run-a"]);
		expect(snapshot.terminalRunIds).toEqual(["run-b"]);
		expect(snapshot.boundedPercent).toBeNull();
		expect(snapshot.oldestHeartbeatAgeMs).toBe(300_000);
		expect(snapshot.nextCheckpointAt).toBe("2026-05-02T08:05:00.000Z");
		expect(snapshot.currentSteps).toEqual(["writing tests"]);
		expect(snapshot.blockers).toEqual(["resource gate closed"]);
		expect(snapshot.reviewedArtifactCount).toBe(3);
		expect(snapshot.confidence).toBe("low");
	});

	it("reports bounded percent only when every non-terminal run declares bounded progress", () => {
		const snapshot = aggregateSupervisorProgress(
			[
				createChildRunStatusRecord({
					runId: "run-1",
					taskId: "task-1",
					status: "active",
					progress: { completedSteps: 1, totalSteps: 4 },
					lastHeartbeatAt: NOW,
				}),
				createChildRunStatusRecord({
					runId: "run-2",
					taskId: "task-2",
					status: "waiting_for_review",
					progress: { completedSteps: 3, totalSteps: 4 },
					lastHeartbeatAt: NOW,
				}),
				createChildRunStatusRecord({
					runId: "run-3",
					taskId: "task-3",
					status: "completed",
					lastHeartbeatAt: NOW,
				}),
			],
			{ now: NOW },
		);

		expect(snapshot.band).toBe("reviewing");
		expect(snapshot.boundedPercent).toBe(50);
	});

	it("keeps mixed child state aggregates deterministic across input order", () => {
		const records = [
			createChildRunStatusRecord({
				runId: "run-queued",
				taskId: "task-queued",
				status: "queued",
				confidence: "medium",
				lastHeartbeatAt: "2026-05-02T07:59:30.000Z",
				nextCheckpointAt: "2026-05-02T08:12:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-assigned",
				taskId: "task-assigned",
				status: "assigned",
				confidence: "high",
				lastHeartbeatAt: "2026-05-02T07:59:20.000Z",
				nextCheckpointAt: "2026-05-02T08:06:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-active",
				taskId: "task-active",
				status: "active",
				currentStep: "building adapter",
				confidence: "high",
				lastHeartbeatAt: "2026-05-02T07:59:10.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-blocked",
				taskId: "task-blocked",
				status: "blocked",
				blocker: "review lane unavailable",
				confidence: "low",
				lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-review",
				taskId: "task-review",
				status: "waiting_for_review",
				currentStep: "checking fixture",
				confidence: "medium",
				lastHeartbeatAt: "2026-05-02T07:58:50.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-aggregating",
				taskId: "task-aggregating",
				status: "aggregating",
				confidence: "high",
				reviewedArtifactCount: 1,
				lastHeartbeatAt: "2026-05-02T07:58:40.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-completed",
				taskId: "task-completed",
				status: "completed",
				confidence: "unknown",
				reviewedArtifactCount: 2,
				lastHeartbeatAt: "2026-05-02T07:58:30.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-failed",
				taskId: "task-failed",
				status: "failed",
				confidence: "low",
				lastHeartbeatAt: "2026-05-02T07:58:20.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-cancelled",
				taskId: "task-cancelled",
				status: "cancelled",
				confidence: "high",
				lastHeartbeatAt: "2026-05-02T07:58:10.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-deferred",
				taskId: "task-deferred",
				status: "deferred",
				confidence: "medium",
				lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
			}),
		];

		const snapshot = aggregateSupervisorProgress(records, { now: NOW });
		const reversedSnapshot = aggregateSupervisorProgress(
			[...records].reverse(),
			{
				now: NOW,
			},
		);

		expect(reversedSnapshot).toEqual(snapshot);
		expect(snapshot.counts).toEqual({
			queued: 1,
			assigned: 1,
			active: 1,
			blocked: 1,
			waiting_for_review: 1,
			aggregating: 1,
			completed: 1,
			failed: 1,
			cancelled: 1,
			deferred: 1,
		});
		expect(snapshot.band).toBe("blocked");
		expect(snapshot.activeRunIds).toEqual([
			"run-active",
			"run-aggregating",
			"run-blocked",
			"run-review",
		]);
		expect(snapshot.queuedRunIds).toEqual(["run-assigned", "run-queued"]);
		expect(snapshot.terminalRunIds).toEqual([
			"run-cancelled",
			"run-completed",
			"run-deferred",
			"run-failed",
		]);
		expect(snapshot.nextCheckpointAt).toBe("2026-05-02T08:06:00.000Z");
		expect(snapshot.currentSteps).toEqual([
			"building adapter",
			"checking fixture",
		]);
		expect(snapshot.blockers).toEqual(["review lane unavailable"]);
		expect(snapshot.reviewedArtifactCount).toBe(3);
		expect(snapshot.confidence).toBe("low");
	});

	it("marks stale heartbeats only for non-terminal runs past the threshold", () => {
		const snapshot = aggregateSupervisorProgress(
			[
				createChildRunStatusRecord({
					runId: "run-over",
					taskId: "task-over",
					status: "active",
					lastHeartbeatAt: "2026-05-02T07:57:59.999Z",
				}),
				createChildRunStatusRecord({
					runId: "run-at-boundary",
					taskId: "task-boundary",
					status: "waiting_for_review",
					lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-future",
					taskId: "task-future",
					status: "assigned",
					lastHeartbeatAt: "2026-05-02T08:00:30.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-terminal-old",
					taskId: "task-terminal",
					status: "failed",
					lastHeartbeatAt: "2026-05-02T07:00:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);

		expect(snapshot.band).toBe("reviewing");
		expect(snapshot.staleRunIds).toEqual(["run-over"]);
		expect(snapshot.activeRunIds).toEqual(["run-at-boundary", "run-over"]);
		expect(snapshot.queuedRunIds).toEqual(["run-future"]);
		expect(snapshot.terminalRunIds).toEqual(["run-terminal-old"]);
		expect(snapshot.oldestHeartbeatAgeMs).toBe(3_600_000);
	});

	it("clamps aggregate confidence to the lowest non-terminal confidence", () => {
		const terminalLowConfidence = [
			createChildRunStatusRecord({
				runId: "run-completed",
				taskId: "task-completed",
				status: "completed",
				confidence: "unknown",
				lastHeartbeatAt: NOW,
			}),
			createChildRunStatusRecord({
				runId: "run-failed",
				taskId: "task-failed",
				status: "failed",
				confidence: "low",
				lastHeartbeatAt: NOW,
			}),
		];

		expect(
			aggregateSupervisorProgress(
				[
					...terminalLowConfidence,
					createChildRunStatusRecord({
						runId: "run-active",
						taskId: "task-active",
						status: "active",
						confidence: "high",
						lastHeartbeatAt: NOW,
					}),
					createChildRunStatusRecord({
						runId: "run-review",
						taskId: "task-review",
						status: "waiting_for_review",
						confidence: "medium",
						lastHeartbeatAt: NOW,
					}),
				],
				{ now: NOW },
			).confidence,
		).toBe("medium");

		expect(
			aggregateSupervisorProgress(
				[
					...terminalLowConfidence,
					createChildRunStatusRecord({
						runId: "run-active",
						taskId: "task-active",
						status: "active",
						confidence: "unknown",
						lastHeartbeatAt: NOW,
					}),
				],
				{ now: NOW },
			).confidence,
		).toBe("unknown");

		expect(
			aggregateSupervisorProgress(terminalLowConfidence, { now: NOW })
				.confidence,
		).toBe("unknown");
	});

	it("records immutable heartbeat updates and supports clearing optional fields", () => {
		const original = createChildRunStatusRecord(
			{
				runId: "run-1",
				taskId: "task-1",
				status: "blocked",
				summary: "blocked on review",
				currentStep: "awaiting reviewer",
				blocker: "review slot unavailable",
				progress: { completedSteps: 1, totalSteps: 2 },
				nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
			},
			NOW,
		);

		const updated = recordChildRunHeartbeat(
			original,
			{
				status: "active",
				summary: "review slot admitted",
				currentStep: null,
				blocker: null,
				progress: null,
				confidence: "medium",
				reviewedArtifactCount: 1,
				nextCheckpointAt: null,
			},
			"2026-05-02T08:01:00.000Z",
		);

		expect(original.status).toBe("blocked");
		expect(original.blocker).toBe("review slot unavailable");
		expect(updated).toMatchObject({
			status: "active",
			summary: "review slot admitted",
			confidence: "medium",
			reviewedArtifactCount: 1,
			lastHeartbeatAt: "2026-05-02T08:01:00.000Z",
			updatedAt: "2026-05-02T08:01:00.000Z",
		});
		expect(updated.currentStep).toBeUndefined();
		expect(updated.blocker).toBeUndefined();
		expect(updated.progress).toBeUndefined();
		expect(updated.nextCheckpointAt).toBeUndefined();
	});

	it("validates heartbeat contracts before accepting progress", () => {
		const record = createChildRunStatusRecord({
			runId: "run-1",
			taskId: "task-1",
			lastHeartbeatAt: NOW,
		});

		expect(() =>
			recordChildRunHeartbeat(record, {
				progress: { completedSteps: 3, totalSteps: 2 },
			}),
		).toThrow(RangeError);

		expect(() =>
			recordChildRunHeartbeat(record, {
				status: "unknown-status" as never,
			}),
		).toThrow(/known child run status/u);

		expect(() =>
			recordChildRunHeartbeat(record, {
				confidence: "certain" as never,
			}),
		).toThrow(/known supervisor confidence/u);
	});

	it("rejects invalid runtime enum values at every progress boundary", () => {
		const record = createChildRunStatusRecord({
			runId: "run-1",
			taskId: "task-1",
			lastHeartbeatAt: NOW,
		});

		expect(() =>
			createChildRunStatusRecord({
				runId: "run-2",
				taskId: "task-2",
				status: "running" as never,
				lastHeartbeatAt: NOW,
			}),
		).toThrow(/known child run status/u);

		expect(() =>
			createChildRunStatusRecord({
				runId: "run-3",
				taskId: "task-3",
				confidence: "certain" as never,
				lastHeartbeatAt: NOW,
			}),
		).toThrow(/known supervisor confidence/u);

		expect(() =>
			aggregateSupervisorProgress(
				[
					{
						...record,
						status: "running" as never,
					},
				],
				{ now: NOW },
			),
		).toThrow(/known child run status/u);

		expect(() =>
			aggregateSupervisorProgress(
				[
					{
						...record,
						confidence: "certain" as never,
					},
				],
				{ now: NOW },
			),
		).toThrow(/known supervisor confidence/u);
	});

	it("projects progress events with deterministic ordering across input order", () => {
		const records = [
			createChildRunStatusRecord({
				runId: "run-b",
				taskId: "task-b",
				status: "assigned",
				summary: "queued for worker",
				lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
				nextCheckpointAt: "2026-05-02T08:03:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-a",
				taskId: "task-a",
				status: "active",
				summary: "building projection",
				lastHeartbeatAt: "2026-05-02T07:57:30.000Z",
				nextCheckpointAt: "2026-05-02T07:59:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-c",
				taskId: "task-c",
				status: "completed",
				summary: "done",
				lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
			}),
		];

		const projection = projectSupervisorProgressEvents(records, {
			now: NOW,
			staleAfterMs: 120_000,
		});
		const reversedProjection = projectSupervisorProgressEvents(
			[...records].reverse(),
			{
				now: NOW,
				staleAfterMs: 120_000,
			},
		);

		expect(reversedProjection.events).toEqual(projection.events);
		expect(
			projection.events.map((event) =>
				"runId" in event ? `${event.type}:${event.runId}` : event.type,
			),
		).toEqual([
			"progress_snapshot",
			"child_stale:run-a",
			"child_heartbeat:run-a",
			"child_heartbeat:run-c",
			"child_heartbeat:run-b",
			"child_checkpoint:run-a",
			"child_checkpoint:run-b",
			"terminal_children_summary",
		]);
		expect(projection.events.map((event) => event.type)).toContain(
			"child_heartbeat",
		);
		expect(projection.events.map((event) => event.type)).toContain(
			"child_checkpoint",
		);
	});

	it("projects checkpoint and heartbeat event payloads for child runs", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-active",
					taskId: "task-active",
					workerId: "worker-1",
					status: "active",
					summary: "working through slice",
					currentStep: "write event types",
					progress: { completedSteps: 2, totalSteps: 5 },
					confidence: "medium",
					reviewedArtifactCount: 1,
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				}),
			],
			{ now: NOW },
		);

		expect(
			projection.events.find((event) => event.type === "child_heartbeat"),
		).toMatchObject({
			schemaVersion: 1,
			type: "child_heartbeat",
			severity: "info",
			occurredAt: "2026-05-02T07:59:00.000Z",
			runId: "run-active",
			taskId: "task-active",
			payload: {
				workerId: "worker-1",
				status: "active",
				summary: "working through slice",
				currentStep: "write event types",
				progress: { completedSteps: 2, totalSteps: 5 },
				confidence: "medium",
				reviewedArtifactCount: 1,
				lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
				heartbeatAgeMs: 60_000,
			},
		});
		expect(
			projection.events.find((event) => event.type === "child_checkpoint"),
		).toMatchObject({
			schemaVersion: 1,
			type: "child_checkpoint",
			severity: "info",
			occurredAt: "2026-05-02T08:05:00.000Z",
			runId: "run-active",
			taskId: "task-active",
			payload: {
				workerId: "worker-1",
				status: "active",
				nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				dueInMs: 300_000,
				isDue: false,
			},
		});
	});

	it("projects stale child signals from the snapshot threshold", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-stale",
					taskId: "task-stale",
					status: "active",
					summary: "last update is old",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-terminal-old",
					taskId: "task-terminal-old",
					status: "failed",
					summary: "already terminal",
					lastHeartbeatAt: "2026-05-02T07:00:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);

		expect(projection.snapshot.staleRunIds).toEqual(["run-stale"]);
		expect(
			projection.events.find((event) => event.type === "child_stale"),
		).toMatchObject({
			schemaVersion: 1,
			type: "child_stale",
			severity: "warning",
			occurredAt: NOW,
			runId: "run-stale",
			taskId: "task-stale",
			payload: {
				status: "active",
				summary: "last update is old",
				lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				heartbeatAgeMs: 180_000,
				staleAfterMs: 120_000,
			},
		});
	});

	it("projects stale child-agent events only for non-terminal runs strictly past the threshold", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-stale-z",
					taskId: "task-stale-z",
					status: "active",
					summary: "active heartbeat is just over the limit",
					lastHeartbeatAt: "2026-05-02T07:57:59.999Z",
				}),
				createChildRunStatusRecord({
					runId: "run-at-boundary",
					taskId: "task-at-boundary",
					status: "active",
					summary: "active heartbeat is exactly at the limit",
					lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-future",
					taskId: "task-future",
					status: "blocked",
					summary: "heartbeat timestamp is ahead of the snapshot",
					lastHeartbeatAt: "2026-05-02T08:00:30.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-terminal-old",
					taskId: "task-terminal-old",
					status: "failed",
					summary: "terminal heartbeat is old but already complete",
					lastHeartbeatAt: "2026-05-02T07:00:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-stale-a",
					taskId: "task-stale-a",
					status: "waiting_for_review",
					summary: "review heartbeat is stale",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);
		const staleEvents = projection.events.filter(
			(event) => event.type === "child_stale",
		);

		expect(projection.snapshot.staleRunIds).toEqual([
			"run-stale-a",
			"run-stale-z",
		]);
		expect(staleEvents).toHaveLength(2);
		expect(
			staleEvents.map((event) => {
				if (event.type !== "child_stale") {
					throw new Error("fixture should only contain stale events");
				}
				return `${event.runId}:${event.payload.heartbeatAgeMs}`;
			}),
		).toEqual(["run-stale-a:180000", "run-stale-z:120001"]);
		expect(
			projection.events
				.filter((event) => "runId" in event)
				.map((event) => `${event.type}:${event.runId}`),
		).not.toContain("child_stale:run-terminal-old");
	});

	it("projects a terminal children summary with stable child ordering", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-z",
					taskId: "task-z",
					status: "deferred",
					summary: "moved out of scope",
					lastHeartbeatAt: NOW,
				}),
				createChildRunStatusRecord({
					runId: "run-a",
					taskId: "task-a",
					status: "completed",
					summary: "merged artifact ready",
					lastHeartbeatAt: NOW,
				}),
				createChildRunStatusRecord({
					runId: "run-m",
					taskId: "task-m",
					status: "failed",
					summary: "subtask failed",
					lastHeartbeatAt: NOW,
				}),
				createChildRunStatusRecord({
					runId: "run-active",
					taskId: "task-active",
					status: "active",
					summary: "still running",
					lastHeartbeatAt: NOW,
				}),
			],
			{ now: NOW },
		);

		expect(
			projection.events.find(
				(event) => event.type === "terminal_children_summary",
			),
		).toMatchObject({
			schemaVersion: 1,
			type: "terminal_children_summary",
			severity: "error",
			occurredAt: NOW,
			payload: {
				total: 3,
				counts: {
					completed: 1,
					failed: 1,
					cancelled: 0,
					deferred: 1,
				},
				children: [
					{
						runId: "run-a",
						taskId: "task-a",
						status: "completed",
						summary: "merged artifact ready",
					},
					{
						runId: "run-m",
						taskId: "task-m",
						status: "failed",
						summary: "subtask failed",
					},
					{
						runId: "run-z",
						taskId: "task-z",
						status: "deferred",
						summary: "moved out of scope",
					},
				],
			},
		});
	});

	it("projects terminal child-agent summary severities at success, warning, and error boundaries", () => {
		const successProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-completed",
					taskId: "task-completed",
					status: "completed",
					summary: "completed cleanly",
					lastHeartbeatAt: NOW,
				}),
			],
			{ now: NOW },
		);
		const warningProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-deferred",
					taskId: "task-deferred",
					status: "deferred",
					summary: "moved out of this pass",
					lastHeartbeatAt: NOW,
				}),
			],
			{ now: NOW },
		);
		const errorProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-cancelled",
					taskId: "task-cancelled",
					status: "cancelled",
					summary: "cancelled by supervisor",
					lastHeartbeatAt: NOW,
				}),
				createChildRunStatusRecord({
					runId: "run-deferred",
					taskId: "task-deferred",
					status: "deferred",
					summary: "also moved out of this pass",
					lastHeartbeatAt: NOW,
				}),
			],
			{ now: NOW },
		);
		const terminalSummary = (
			projection: ReturnType<typeof projectSupervisorProgressEvents>,
		) =>
			projection.events.find(
				(event) => event.type === "terminal_children_summary",
			);

		expect(terminalSummary(successProjection)).toMatchObject({
			severity: "success",
			payload: {
				counts: {
					completed: 1,
					failed: 0,
					cancelled: 0,
					deferred: 0,
				},
			},
		});
		expect(terminalSummary(warningProjection)).toMatchObject({
			severity: "warning",
			payload: {
				counts: {
					completed: 0,
					failed: 0,
					cancelled: 0,
					deferred: 1,
				},
			},
		});
		expect(terminalSummary(errorProjection)).toMatchObject({
			severity: "error",
			payload: {
				counts: {
					completed: 0,
					failed: 0,
					cancelled: 1,
					deferred: 1,
				},
			},
		});
	});

	it("flushes mixed sink batches deterministically for downstream adapters", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-stale",
					taskId: "task-stale",
					status: "active",
					summary: "old heartbeat",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
					nextCheckpointAt: "2026-05-02T07:59:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-current",
					taskId: "task-current",
					status: "active",
					summary: "current heartbeat",
					lastHeartbeatAt: "2026-05-02T07:59:30.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-terminal",
					taskId: "task-terminal",
					status: "completed",
					summary: "terminal child done",
					lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);
		const reversedEvents = [...projection.events].reverse();
		const [firstEvent, ...remainingEvents] = reversedEvents;
		if (firstEvent == null) {
			throw new Error("mixed sink fixture must project events");
		}

		const sink = createBufferedSupervisorProgressSink();
		recordSupervisorProgressEvent(sink, firstEvent);
		const result = replaySupervisorProgressEvents(sink, remainingEvents);

		expect(result.events).toEqual(projection.events);
		expect(result.counts).toEqual({
			progress_snapshot: 1,
			child_stale: 1,
			child_heartbeat: 3,
			child_checkpoint: 1,
			terminal_children_summary: 1,
		});
		expect(result.severities).toEqual({
			info: 2,
			warning: 3,
			success: 2,
			error: 0,
		});
		expect(result.cursor).toBe(
			projection.events[projection.events.length - 1]?.id,
		);
		expect(result.latestOccurredAt).toBe(NOW);
		expect(
			applySupervisorProgressProjection(
				createBufferedSupervisorProgressSink(),
				projection,
			),
		).toEqual(result);
		expect(sink.flush()).toEqual(emptySinkFlushResult());
	});

	it("sorts projected child-agent events by type, occurrence time, run id, and event id", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-b",
					taskId: "task-b",
					status: "active",
					summary: "same heartbeat and checkpoint time",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:01:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-a",
					taskId: "task-a",
					status: "active",
					summary: "same heartbeat and checkpoint time",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:01:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-a",
					taskId: "task-z",
					status: "active",
					summary: "same run and time with later event id",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:01:00.000Z",
				}),
			],
			{ now: NOW },
		);

		expect(
			projection.events.map((event) =>
				"runId" in event
					? `${event.type}:${event.occurredAt}:${event.runId}:${event.id}`
					: `${event.type}:${event.occurredAt}:${event.id}`,
			),
		).toEqual([
			"progress_snapshot:2026-05-02T08:00:00.000Z:progress_snapshot:2026-05-02T08:00:00.000Z",
			"child_heartbeat:2026-05-02T07:59:00.000Z:run-a:child_heartbeat:run-a:task-a:2026-05-02T07:59:00.000Z",
			"child_heartbeat:2026-05-02T07:59:00.000Z:run-a:child_heartbeat:run-a:task-z:2026-05-02T07:59:00.000Z",
			"child_heartbeat:2026-05-02T07:59:00.000Z:run-b:child_heartbeat:run-b:task-b:2026-05-02T07:59:00.000Z",
			"child_checkpoint:2026-05-02T08:01:00.000Z:run-a:child_checkpoint:run-a:task-a:2026-05-02T08:01:00.000Z",
			"child_checkpoint:2026-05-02T08:01:00.000Z:run-a:child_checkpoint:run-a:task-z:2026-05-02T08:01:00.000Z",
			"child_checkpoint:2026-05-02T08:01:00.000Z:run-b:child_checkpoint:run-b:task-b:2026-05-02T08:01:00.000Z",
		]);
	});

	it("flushes an empty sink batch deterministically", () => {
		const sink = createBufferedSupervisorProgressSink();

		expect(replaySupervisorProgressEvents(sink, [])).toEqual(
			emptySinkFlushResult(),
		);
		expect(sink.flush()).toEqual(emptySinkFlushResult());
	});

	it("summarizes an empty sink batch list deterministically", () => {
		expect(summarizeSupervisorProgressSinkFlushResults([])).toEqual({
			flushCount: 0,
			totalEvents: 0,
			byType: {
				progress_snapshot: 0,
				child_stale: 0,
				child_heartbeat: 0,
				child_checkpoint: 0,
				terminal_children_summary: 0,
			},
			bySeverity: {
				info: 0,
				warning: 0,
				success: 0,
				error: 0,
			},
			latestOccurredAt: null,
			cursors: [],
			emptyFlushCount: 0,
		});
	});

	it("classifies empty sink batch attention summaries", () => {
		expect(
			summarizeSupervisorProgressSinkBatchAttention(
				summarizeSupervisorProgressSinkFlushResults([]),
			),
		).toEqual({
			status: "empty",
			totalEvents: 0,
			warningCount: 0,
			errorCount: 0,
		});
	});

	it("reports empty sink flush batches with batch and attention summaries", () => {
		expect(summarizeSupervisorProgressSinkFlushReport([])).toEqual({
			batch: {
				flushCount: 0,
				totalEvents: 0,
				byType: {
					progress_snapshot: 0,
					child_stale: 0,
					child_heartbeat: 0,
					child_checkpoint: 0,
					terminal_children_summary: 0,
				},
				bySeverity: {
					info: 0,
					warning: 0,
					success: 0,
					error: 0,
				},
				latestOccurredAt: null,
				cursors: [],
				emptyFlushCount: 0,
			},
			attention: {
				status: "empty",
				totalEvents: 0,
				warningCount: 0,
				errorCount: 0,
			},
		});
	});

	it("summarizes a single sink flush result", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-single",
					taskId: "task-single",
					status: "active",
					summary: "building summary helper",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:03:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const result = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projection,
		);

		expect(summarizeSupervisorProgressSinkFlushResults([result])).toEqual({
			flushCount: 1,
			totalEvents: result.events.length,
			byType: result.counts,
			bySeverity: result.severities,
			latestOccurredAt: result.latestOccurredAt,
			cursors: result.cursor == null ? [] : [result.cursor],
			emptyFlushCount: 0,
		});
	});

	it("classifies healthy sink batch attention summaries without mutating events", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-healthy",
					taskId: "task-healthy",
					status: "active",
					summary: "heartbeat is current",
					lastHeartbeatAt: NOW,
				}),
			],
			{ now: NOW },
		);
		const result = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projection,
		);
		const eventsBefore = result.events;
		const eventIdsBefore = result.events.map((event) => event.id);
		const summary = summarizeSupervisorProgressSinkFlushResults([result]);
		const summaryBefore: SupervisorProgressSinkBatchSummary = {
			...summary,
			byType: { ...summary.byType },
			bySeverity: { ...summary.bySeverity },
			cursors: [...summary.cursors],
		};

		expect(summarizeSupervisorProgressSinkBatchAttention(summary)).toEqual({
			status: "healthy",
			totalEvents: result.events.length,
			warningCount: 0,
			errorCount: 0,
		});
		expect(summary).toEqual(summaryBefore);
		expect(result.events).toBe(eventsBefore);
		expect(result.events.map((event) => event.id)).toEqual(eventIdsBefore);
	});

	it("reports healthy sink flush batches without mutating flush results", () => {
		const result = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projectSupervisorProgressEvents(
				[
					createChildRunStatusRecord({
						runId: "run-report-healthy",
						taskId: "task-report-healthy",
						status: "active",
						summary: "heartbeat is current",
						lastHeartbeatAt: NOW,
					}),
				],
				{ now: NOW },
			),
		);
		const eventsBefore = result.events;
		const resultBefore: SupervisorProgressSinkFlushResult = {
			...result,
			events: result.events,
			counts: { ...result.counts },
			severities: { ...result.severities },
		};
		const batch = summarizeSupervisorProgressSinkFlushResults([result]);

		expect(summarizeSupervisorProgressSinkFlushReport([result])).toEqual({
			batch,
			attention: {
				status: "healthy",
				totalEvents: result.events.length,
				warningCount: 0,
				errorCount: 0,
			},
		});
		expect(result).toEqual(resultBefore);
		expect(result.events).toBe(eventsBefore);
	});

	it("flushes a sink-level report with exactly one sink flush", () => {
		const result = emptySinkFlushResult();
		const sink: SupervisorProgressEventSink = {
			record: vi.fn(),
			flush: vi.fn(() => result),
		};

		expect(flushSupervisorProgressSinkReport(sink)).toEqual(
			summarizeSupervisorProgressSinkFlushReport([result]),
		);
		expect(sink.flush).toHaveBeenCalledTimes(1);
	});

	it("replays event batches into sink reports in input order with exactly one flush", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-report-batch",
					taskId: "task-report-batch",
					status: "active",
					summary: "record batch into report",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:04:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const inputEvents = [...projection.events].reverse();
		const inputEventsBefore = structuredClone(inputEvents);
		const result = emptySinkFlushResult();
		const calls: string[] = [];
		const sink: SupervisorProgressEventSink = {
			record: vi.fn((event) => {
				calls.push(`record:${event.id}`);
			}),
			flush: vi.fn(() => {
				calls.push("flush");
				return result;
			}),
		};

		expect(replaySupervisorProgressEventsReport(sink, inputEvents)).toEqual(
			summarizeSupervisorProgressSinkFlushReport([result]),
		);
		expect(sink.record).toHaveBeenCalledTimes(inputEvents.length);
		expect(sink.flush).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([
			...inputEvents.map((event) => `record:${event.id}`),
			"flush",
		]);
		expect(inputEvents).toEqual(inputEventsBefore);
	});

	it("reports replayed buffered sink event batches", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-buffered-report",
					taskId: "task-buffered-report",
					status: "blocked",
					summary: "blocked event batch",
					blocker: "review gate is occupied",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);
		const expectedResult = replaySupervisorProgressEvents(
			createBufferedSupervisorProgressSink(),
			projection.events,
		);

		expect(
			replaySupervisorProgressEventsReport(
				createBufferedSupervisorProgressSink(),
				projection.events,
			),
		).toEqual(summarizeSupervisorProgressSinkFlushReport([expectedResult]));
	});

	it("reports applied projections with replay report parity", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-projection-report",
					taskId: "task-projection-report",
					status: "blocked",
					summary: "blocked projection report",
					blocker: "review lane is occupied",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);

		expect(
			applySupervisorProgressProjectionReport(
				createBufferedSupervisorProgressSink(),
				projection,
			),
		).toEqual(
			replaySupervisorProgressEventsReport(
				createBufferedSupervisorProgressSink(),
				projection.events,
			),
		);
	});

	it("records projection report events in projection order with exactly one flush", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-projection-order",
					taskId: "task-projection-order",
					status: "active",
					summary: "ordering projection report",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:04:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const inputProjection = {
			...projection,
			events: [...projection.events].reverse(),
		};
		const result = emptySinkFlushResult();
		const calls: string[] = [];
		const sink: SupervisorProgressEventSink = {
			record: vi.fn((event) => {
				calls.push(`record:${event.id}`);
			}),
			flush: vi.fn(() => {
				calls.push("flush");
				return result;
			}),
		};

		expect(
			applySupervisorProgressProjectionReport(sink, inputProjection),
		).toEqual(summarizeSupervisorProgressSinkFlushReport([result]));
		expect(sink.record).toHaveBeenCalledTimes(inputProjection.events.length);
		expect(sink.flush).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([
			...inputProjection.events.map((event) => `record:${event.id}`),
			"flush",
		]);
	});

	it("reports empty applied projections with a single empty flush", () => {
		const emptyProjection = {
			...projectSupervisorProgressEvents([], { now: NOW }),
			events: [],
		};
		const sink: SupervisorProgressEventSink = {
			record: vi.fn(),
			flush: vi.fn(emptySinkFlushResult),
		};

		expect(
			applySupervisorProgressProjectionReport(sink, emptyProjection),
		).toEqual(
			summarizeSupervisorProgressSinkFlushReport([emptySinkFlushResult()]),
		);
		expect(sink.record).not.toHaveBeenCalled();
		expect(sink.flush).toHaveBeenCalledTimes(1);
	});

	it("reports multiple applied projections through one sink flush", () => {
		const firstProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-multi-first",
					taskId: "task-multi-first",
					status: "active",
					summary: "first projection",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const secondProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-multi-second",
					taskId: "task-multi-second",
					status: "completed",
					summary: "second projection",
					lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
				}),
			],
			{ now: "2026-05-02T08:01:00.000Z" },
		);
		const expectedResult = replaySupervisorProgressEvents(
			createBufferedSupervisorProgressSink(),
			[...firstProjection.events, ...secondProjection.events],
		);

		expect(
			applySupervisorProgressProjectionsReport(
				createBufferedSupervisorProgressSink(),
				[firstProjection, secondProjection],
			),
		).toEqual(summarizeSupervisorProgressSinkFlushReport([expectedResult]));
	});

	it("records multiple projection report events in projection order with exactly one flush", () => {
		const firstProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-order-first",
					taskId: "task-order-first",
					status: "active",
					summary: "first projection order",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:04:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const secondProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-order-second",
					taskId: "task-order-second",
					status: "active",
					summary: "second projection order",
					lastHeartbeatAt: "2026-05-02T07:58:30.000Z",
					nextCheckpointAt: "2026-05-02T08:03:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const inputProjections = [
			{ ...firstProjection, events: [...firstProjection.events].reverse() },
			{ ...secondProjection, events: [...secondProjection.events].reverse() },
		];
		const result = emptySinkFlushResult();
		const calls: string[] = [];
		const sink: SupervisorProgressEventSink = {
			record: vi.fn((event) => {
				calls.push(`record:${event.id}`);
			}),
			flush: vi.fn(() => {
				calls.push("flush");
				return result;
			}),
		};

		expect(
			applySupervisorProgressProjectionsReport(sink, inputProjections),
		).toEqual(summarizeSupervisorProgressSinkFlushReport([result]));
		expect(sink.record).toHaveBeenCalledTimes(
			inputProjections.reduce(
				(count, projection) => count + projection.events.length,
				0,
			),
		);
		expect(sink.flush).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([
			...inputProjections.flatMap((projection) =>
				projection.events.map((event) => `record:${event.id}`),
			),
			"flush",
		]);
	});

	it("reports empty projection lists with a single empty flush", () => {
		const sink: SupervisorProgressEventSink = {
			record: vi.fn(),
			flush: vi.fn(emptySinkFlushResult),
		};

		expect(applySupervisorProgressProjectionsReport(sink, [])).toEqual(
			summarizeSupervisorProgressSinkFlushReport([emptySinkFlushResult()]),
		);
		expect(sink.record).not.toHaveBeenCalled();
		expect(sink.flush).toHaveBeenCalledTimes(1);
	});

	it("reports empty sink-level flushes", () => {
		expect(
			flushSupervisorProgressSinkReport(createBufferedSupervisorProgressSink()),
		).toEqual({
			batch: {
				flushCount: 1,
				totalEvents: 0,
				byType: {
					progress_snapshot: 0,
					child_stale: 0,
					child_heartbeat: 0,
					child_checkpoint: 0,
					terminal_children_summary: 0,
				},
				bySeverity: {
					info: 0,
					warning: 0,
					success: 0,
					error: 0,
				},
				latestOccurredAt: null,
				cursors: [],
				emptyFlushCount: 1,
			},
			attention: {
				status: "empty",
				totalEvents: 0,
				warningCount: 0,
				errorCount: 0,
			},
		});
	});

	it("reports healthy sink-level flushes", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-sink-healthy",
					taskId: "task-sink-healthy",
					status: "active",
					summary: "heartbeat is current",
					lastHeartbeatAt: NOW,
				}),
			],
			{ now: NOW },
		);
		const result = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projection,
		);

		expect(
			flushSupervisorProgressSinkReport(
				createBufferedSupervisorProgressSink(projection.events),
			),
		).toEqual(summarizeSupervisorProgressSinkFlushReport([result]));
	});

	it("reports sink-level flushes that need attention", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-sink-warning",
					taskId: "task-sink-warning",
					status: "active",
					summary: "heartbeat is stale",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);
		const result = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projection,
		);

		expect(
			flushSupervisorProgressSinkReport(
				createBufferedSupervisorProgressSink(projection.events),
			),
		).toEqual(summarizeSupervisorProgressSinkFlushReport([result]));
	});

	it("summarizes mixed multi-batch sink flush results", () => {
		const staleResult = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projectSupervisorProgressEvents(
				[
					createChildRunStatusRecord({
						runId: "run-stale",
						taskId: "task-stale",
						status: "active",
						summary: "stale worker",
						lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
						nextCheckpointAt: "2026-05-02T08:02:00.000Z",
					}),
				],
				{ now: NOW, staleAfterMs: 120_000 },
			),
		);
		const terminalResult = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projectSupervisorProgressEvents(
				[
					createChildRunStatusRecord({
						runId: "run-terminal",
						taskId: "task-terminal",
						status: "completed",
						summary: "artifact ready",
						lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					}),
				],
				{ now: "2026-05-02T08:01:00.000Z" },
			),
		);
		const expectedCursors = [staleResult.cursor, terminalResult.cursor]
			.filter((cursor): cursor is string => cursor != null)
			.sort((left, right) => left.localeCompare(right));

		expect(
			summarizeSupervisorProgressSinkFlushResults([
				emptySinkFlushResult(),
				terminalResult,
				staleResult,
			]),
		).toEqual({
			flushCount: 3,
			totalEvents: 7,
			byType: {
				progress_snapshot: 2,
				child_stale: 1,
				child_heartbeat: 2,
				child_checkpoint: 1,
				terminal_children_summary: 1,
			},
			bySeverity: {
				info: 2,
				warning: 2,
				success: 3,
				error: 0,
			},
			latestOccurredAt: "2026-05-02T08:02:00.000Z",
			cursors: expectedCursors,
			emptyFlushCount: 1,
		});
	});

	it("classifies warning sink batch attention summaries as needing attention", () => {
		const warningSummary = summarizeSupervisorProgressSinkFlushResults([
			applySupervisorProgressProjection(
				createBufferedSupervisorProgressSink(),
				projectSupervisorProgressEvents(
					[
						createChildRunStatusRecord({
							runId: "run-warning",
							taskId: "task-warning",
							status: "active",
							summary: "heartbeat is stale",
							lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
						}),
					],
					{ now: NOW, staleAfterMs: 120_000 },
				),
			),
		]);

		expect(
			summarizeSupervisorProgressSinkBatchAttention(warningSummary),
		).toEqual({
			status: "needs_attention",
			totalEvents: 3,
			warningCount: 2,
			errorCount: 0,
		});
	});

	it("classifies error sink batch attention summaries as needing attention", () => {
		const errorSummary = summarizeSupervisorProgressSinkFlushResults([
			applySupervisorProgressProjection(
				createBufferedSupervisorProgressSink(),
				projectSupervisorProgressEvents(
					[
						createChildRunStatusRecord({
							runId: "run-error",
							taskId: "task-error",
							status: "failed",
							summary: "child failed",
							lastHeartbeatAt: NOW,
						}),
					],
					{ now: NOW },
				),
			),
		]);

		expect(summarizeSupervisorProgressSinkBatchAttention(errorSummary)).toEqual(
			{
				status: "needs_attention",
				totalEvents: 3,
				warningCount: 0,
				errorCount: 3,
			},
		);
	});

	it("reports sink flush batches that need attention", () => {
		const warningResult = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projectSupervisorProgressEvents(
				[
					createChildRunStatusRecord({
						runId: "run-report-warning",
						taskId: "task-report-warning",
						status: "active",
						summary: "heartbeat is stale",
						lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
					}),
				],
				{ now: NOW, staleAfterMs: 120_000 },
			),
		);
		const batch = summarizeSupervisorProgressSinkFlushResults([warningResult]);

		expect(summarizeSupervisorProgressSinkFlushReport([warningResult])).toEqual(
			{
				batch,
				attention: {
					status: "needs_attention",
					totalEvents: 3,
					warningCount: 2,
					errorCount: 0,
				},
			},
		);
	});

	it("consumes sink flush report iterables once before composing summaries", () => {
		const firstResult = emptySinkFlushResult();
		const secondResult = applySupervisorProgressProjection(
			createBufferedSupervisorProgressSink(),
			projectSupervisorProgressEvents(
				[
					createChildRunStatusRecord({
						runId: "run-one-shot",
						taskId: "task-one-shot",
						status: "active",
						summary: "one-shot iterable fixture",
						lastHeartbeatAt: NOW,
					}),
				],
				{ now: NOW },
			),
		);
		const results = [firstResult, secondResult];
		let iteratorCalls = 0;
		let yieldedCount = 0;
		const oneShotResults: Iterable<SupervisorProgressSinkFlushResult> = {
			*[Symbol.iterator]() {
				iteratorCalls += 1;
				if (iteratorCalls > 1) {
					throw new Error("source iterable was consumed more than once");
				}
				for (const result of results) {
					yieldedCount += 1;
					yield result;
				}
			},
		};

		const report = summarizeSupervisorProgressSinkFlushReport(oneShotResults);

		expect(iteratorCalls).toBe(1);
		expect(yieldedCount).toBe(results.length);
		expect(report.batch).toEqual(
			summarizeSupervisorProgressSinkFlushResults(results),
		);
		expect(report.attention).toEqual(
			summarizeSupervisorProgressSinkBatchAttention(report.batch),
		);
	});

	it("applies one-shot projection iterables exactly once through one sink flush", () => {
		const firstProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-one-shot-stale",
					taskId: "task-one-shot-stale",
					status: "active",
					summary: "active child heartbeat is stale",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				}),
			],
			{ now: NOW, staleAfterMs: 120_000 },
		);
		const secondProjection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-one-shot-terminal",
					taskId: "task-one-shot-terminal",
					status: "failed",
					summary: "terminal child is complete enough to summarize",
					lastHeartbeatAt: "2026-05-02T07:00:00.000Z",
				}),
			],
			{ now: "2026-05-02T08:01:00.000Z", staleAfterMs: 120_000 },
		);
		const projections = [firstProjection, secondProjection];
		const expectedResult = replaySupervisorProgressEvents(
			createBufferedSupervisorProgressSink(),
			projections.flatMap((projection) => projection.events),
		);
		let iteratorCalls = 0;
		let yieldedCount = 0;
		const oneShotProjections = {
			*[Symbol.iterator]() {
				iteratorCalls += 1;
				if (iteratorCalls > 1) {
					throw new Error("projection iterable was consumed more than once");
				}
				for (const projection of projections) {
					yieldedCount += 1;
					yield projection;
				}
			},
		};

		expect(
			applySupervisorProgressProjectionsReport(
				createBufferedSupervisorProgressSink(),
				oneShotProjections,
			),
		).toEqual(summarizeSupervisorProgressSinkFlushReport([expectedResult]));
		expect(iteratorCalls).toBe(1);
		expect(yieldedCount).toBe(projections.length);
	});

	it("keeps stale detection deterministic for mixed terminal and live children", () => {
		const records = [
			createChildRunStatusRecord({
				runId: "run-terminal-failed-old",
				taskId: "task-terminal-failed-old",
				status: "failed",
				summary: "failed earlier",
				confidence: "low",
				lastHeartbeatAt: "2026-05-02T07:00:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-live-stale",
				taskId: "task-live-stale",
				status: "active",
				summary: "still working but stale",
				confidence: "medium",
				lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-terminal-completed-old",
				taskId: "task-terminal-completed-old",
				status: "completed",
				summary: "completed long ago",
				confidence: "unknown",
				lastHeartbeatAt: "2026-05-02T07:30:00.000Z",
			}),
			createChildRunStatusRecord({
				runId: "run-live-boundary",
				taskId: "task-live-boundary",
				status: "waiting_for_review",
				summary: "exactly at stale boundary",
				confidence: "high",
				lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
			}),
		];
		const recordsBefore = structuredClone(records);
		const reversedRecords = [...records].reverse();

		const projection = projectSupervisorProgressEvents(records, {
			now: NOW,
			staleAfterMs: 120_000,
		});
		const reversedProjection = projectSupervisorProgressEvents(
			reversedRecords,
			{
				now: NOW,
				staleAfterMs: 120_000,
			},
		);

		expect(reversedProjection).toEqual(projection);
		expect(records).toEqual(recordsBefore);
		expect(reversedRecords.map((record) => record.runId)).toEqual([
			"run-live-boundary",
			"run-terminal-completed-old",
			"run-live-stale",
			"run-terminal-failed-old",
		]);
		expect(projection.snapshot.staleRunIds).toEqual(["run-live-stale"]);
		expect(projection.snapshot.terminalRunIds).toEqual([
			"run-terminal-completed-old",
			"run-terminal-failed-old",
		]);
		expect(
			projection.events
				.filter((event) => event.type === "child_stale")
				.map((event) => `${event.runId}:${event.payload.status}`),
		).toEqual(["run-live-stale:active"]);
		expect(
			projection.events.find(
				(event) => event.type === "terminal_children_summary",
			),
		).toMatchObject({
			severity: "error",
			payload: {
				counts: {
					completed: 1,
					failed: 1,
					cancelled: 0,
					deferred: 0,
				},
				children: [
					{
						runId: "run-terminal-completed-old",
						status: "completed",
					},
					{
						runId: "run-terminal-failed-old",
						status: "failed",
					},
				],
			},
		});
	});

	it("does not mutate source event arrays while replaying and summarizing", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-event-source-z",
					taskId: "task-event-source-z",
					status: "active",
					summary: "source event order fixture",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:04:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-event-source-a",
					taskId: "task-event-source-a",
					status: "completed",
					summary: "terminal event fixture",
					lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const sourceEvents = [...projection.events].reverse();
		const sourceEventsBefore = structuredClone(sourceEvents);
		const sourceEventRefs = [...sourceEvents];

		const result = replaySupervisorProgressEvents(
			createBufferedSupervisorProgressSink(),
			sourceEvents,
		);
		const report = summarizeSupervisorProgressSinkFlushReport([result]);

		expect(sourceEvents).toEqual(sourceEventsBefore);
		expect(sourceEvents).toEqual(sourceEventRefs);
		expect(result.events).toEqual(projection.events);
		expect(report.batch.totalEvents).toBe(projection.events.length);
		expect(report.attention).toEqual(
			summarizeSupervisorProgressSinkBatchAttention(report.batch),
		);
	});

	it("keeps batch summary cursor ordering stable across input order", () => {
		const createResult = (
			runId: string,
			occurredAt: string,
		): SupervisorProgressSinkFlushResult =>
			applySupervisorProgressProjection(
				createBufferedSupervisorProgressSink(),
				projectSupervisorProgressEvents(
					[
						createChildRunStatusRecord({
							runId,
							taskId: `task-${runId}`,
							status: "active",
							summary: "worker heartbeat",
							lastHeartbeatAt: occurredAt,
						}),
					],
					{ now: occurredAt },
				),
			);
		const alphaResult = createResult("run-a", "2026-05-02T08:02:00.000Z");
		const zedResult = createResult("run-z", "2026-05-02T08:01:00.000Z");
		const expectedCursors = [alphaResult.cursor, zedResult.cursor]
			.filter((cursor): cursor is string => cursor != null)
			.sort((left, right) => left.localeCompare(right));

		const forwardSummary = summarizeSupervisorProgressSinkFlushResults([
			zedResult,
			emptySinkFlushResult(),
			alphaResult,
		]);
		const reversedSummary = summarizeSupervisorProgressSinkFlushResults([
			alphaResult,
			emptySinkFlushResult(),
			zedResult,
		]);

		expect(reversedSummary).toEqual(forwardSummary);
		expect(forwardSummary.cursors).toEqual(expectedCursors);
		expect(forwardSummary.emptyFlushCount).toBe(1);
	});
});
