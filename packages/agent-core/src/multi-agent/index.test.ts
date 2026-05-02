import { describe, expect, it } from "vitest";
import {
	applySupervisorProgressProjectionReport,
	applySupervisorProgressProjectionsReport,
	createBufferedSupervisorProgressSink,
	createChildRunStatusRecord,
	flushSupervisorProgressSinkReport,
	projectSupervisorProgressEvents,
	recordSupervisorProgressEvent,
	replaySupervisorProgressEventsReport,
	type SupervisorChildCheckpointEvent,
	type SupervisorProgressEventProjection,
	type SupervisorProgressSinkBatchReport,
	type SupervisorProgressSinkFlushResult,
	type SupervisorTerminalChildrenSummaryEvent,
	summarizeSupervisorProgressSinkBatchAttention,
	summarizeSupervisorProgressSinkFlushReport,
	summarizeSupervisorProgressSinkFlushResults,
} from "./index.js";

const NOW = "2026-05-02T08:00:00.000Z";

describe("multi-agent barrel exports", () => {
	it("exposes child run status records for supervisor progress snapshots", () => {
		const record = createChildRunStatusRecord(
			{
				runId: "run-status-record-contract",
				taskId: "task-status-record-contract",
				summary: "queued through public multi-agent entrypoint",
			},
			NOW,
		);
		const projection = projectSupervisorProgressEvents([record], { now: NOW });

		expect(record).toMatchObject({
			runId: "run-status-record-contract",
			taskId: "task-status-record-contract",
			status: "queued",
			summary: "queued through public multi-agent entrypoint",
			confidence: "unknown",
			reviewedArtifactCount: 0,
			lastHeartbeatAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
		expect(projection.snapshot).toMatchObject({
			generatedAt: NOW,
			totalRuns: 1,
			band: "starting",
			queuedRunIds: ["run-status-record-contract"],
		});
		expect(projection.events.map((event) => event.type)).toEqual([
			"progress_snapshot",
			"child_heartbeat",
		]);
	});

	it("exposes supervisor progress projection and report helpers", () => {
		const projection: SupervisorProgressEventProjection =
			projectSupervisorProgressEvents(
				[
					createChildRunStatusRecord({
						runId: "run-barrel-contract",
						taskId: "task-barrel-contract",
						status: "blocked",
						summary: "waiting on reviewer handoff",
						blocker: "review lane is occupied",
						lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
					}),
				],
				{ now: NOW, staleAfterMs: 120_000 },
			);
		const report: SupervisorProgressSinkBatchReport =
			applySupervisorProgressProjectionReport(
				createBufferedSupervisorProgressSink(),
				projection,
			);

		expect(projection.snapshot).toMatchObject({
			generatedAt: NOW,
			band: "blocked",
			blockedRunIds: ["run-barrel-contract"],
			staleRunIds: ["run-barrel-contract"],
		});
		expect(projection.events.map((event) => event.type)).toEqual([
			"progress_snapshot",
			"child_stale",
			"child_heartbeat",
		]);
		expect(report).toEqual(
			replaySupervisorProgressEventsReport(
				createBufferedSupervisorProgressSink(),
				projection.events,
			),
		);
		expect(report).toEqual(
			applySupervisorProgressProjectionsReport(
				createBufferedSupervisorProgressSink(),
				[projection],
			),
		);
		expect(report.attention).toEqual(
			summarizeSupervisorProgressSinkBatchAttention(report.batch),
		);
		expect(report.attention.status).toBe("needs_attention");
	});

	it("exposes buffered sink and flush summary helpers", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-buffered-barrel-contract",
					taskId: "task-buffered-barrel-contract",
					status: "active",
					summary: "streaming buffered progress",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
					nextCheckpointAt: "2026-05-02T08:03:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const bufferedSink = createBufferedSupervisorProgressSink();

		for (const event of [...projection.events].reverse()) {
			recordSupervisorProgressEvent(bufferedSink, event);
		}

		const flushResult: SupervisorProgressSinkFlushResult = bufferedSink.flush();
		const flushSummary = summarizeSupervisorProgressSinkFlushResults([
			flushResult,
		]);
		const flushReport: SupervisorProgressSinkBatchReport =
			summarizeSupervisorProgressSinkFlushReport([flushResult]);

		expect(flushResult.events).toEqual(projection.events);
		expect(flushSummary).toEqual({
			flushCount: 1,
			totalEvents: projection.events.length,
			byType: flushResult.counts,
			bySeverity: flushResult.severities,
			latestOccurredAt: "2026-05-02T08:03:00.000Z",
			cursors: flushResult.cursor == null ? [] : [flushResult.cursor],
			emptyFlushCount: 0,
		});
		expect(flushReport).toEqual({
			batch: flushSummary,
			attention: summarizeSupervisorProgressSinkBatchAttention(flushSummary),
		});
		expect(flushReport.attention.status).toBe("healthy");
		expect(bufferedSink.flush().events).toEqual([]);
		expect(
			flushSupervisorProgressSinkReport(
				createBufferedSupervisorProgressSink(projection.events),
			),
		).toEqual(flushReport);
		expect(
			summarizeSupervisorProgressSinkBatchAttention(flushReport.batch),
		).toEqual(flushReport.attention);
	});

	it("exposes due and scheduled checkpoint events", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-checkpoint-due",
					taskId: "task-checkpoint-due",
					workerId: "worker-due",
					status: "active",
					summary: "checkpoint should be requested now",
					lastHeartbeatAt: "2026-05-02T07:59:30.000Z",
					nextCheckpointAt: "2026-05-02T07:59:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-checkpoint-scheduled",
					taskId: "task-checkpoint-scheduled",
					workerId: "worker-scheduled",
					status: "assigned",
					summary: "checkpoint remains scheduled",
					lastHeartbeatAt: "2026-05-02T07:59:45.000Z",
					nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const checkpointEvents = projection.events.filter(
			(event): event is SupervisorChildCheckpointEvent =>
				event.type === "child_checkpoint",
		);

		expect(checkpointEvents).toEqual([
			{
				schemaVersion: 1,
				id: "child_checkpoint:run-checkpoint-due:task-checkpoint-due:2026-05-02T07:59:00.000Z",
				type: "child_checkpoint",
				severity: "warning",
				occurredAt: "2026-05-02T07:59:00.000Z",
				runId: "run-checkpoint-due",
				taskId: "task-checkpoint-due",
				payload: {
					workerId: "worker-due",
					status: "active",
					nextCheckpointAt: "2026-05-02T07:59:00.000Z",
					dueInMs: 0,
					isDue: true,
				},
			},
			{
				schemaVersion: 1,
				id: "child_checkpoint:run-checkpoint-scheduled:task-checkpoint-scheduled:2026-05-02T08:05:00.000Z",
				type: "child_checkpoint",
				severity: "info",
				occurredAt: "2026-05-02T08:05:00.000Z",
				runId: "run-checkpoint-scheduled",
				taskId: "task-checkpoint-scheduled",
				payload: {
					workerId: "worker-scheduled",
					status: "assigned",
					nextCheckpointAt: "2026-05-02T08:05:00.000Z",
					dueInMs: 300_000,
					isDue: false,
				},
			},
		]);
		expect(
			flushSupervisorProgressSinkReport(
				createBufferedSupervisorProgressSink(checkpointEvents),
			),
		).toMatchObject({
			batch: {
				totalEvents: 2,
				byType: { child_checkpoint: 2 },
				bySeverity: { info: 1, warning: 1 },
				latestOccurredAt: "2026-05-02T08:05:00.000Z",
			},
			attention: {
				status: "needs_attention",
				totalEvents: 2,
				warningCount: 1,
				errorCount: 0,
			},
		});
	});

	it("exposes terminal child summary events", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-terminal-z",
					taskId: "task-terminal-z",
					status: "deferred",
					summary: "deferred for later batch",
					lastHeartbeatAt: "2026-05-02T07:58:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-active",
					taskId: "task-active",
					status: "active",
					summary: "still producing updates",
					lastHeartbeatAt: "2026-05-02T07:59:30.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-terminal-a",
					taskId: "task-terminal-a",
					status: "completed",
					summary: "artifact ready for parent",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
				}),
			],
			{ now: NOW },
		);
		const terminalSummary = projection.events.find(
			(event): event is SupervisorTerminalChildrenSummaryEvent =>
				event.type === "terminal_children_summary",
		);

		expect(terminalSummary).toEqual({
			schemaVersion: 1,
			id: `terminal_children_summary:${NOW}`,
			type: "terminal_children_summary",
			severity: "warning",
			occurredAt: NOW,
			payload: {
				total: 2,
				counts: {
					completed: 1,
					failed: 0,
					cancelled: 0,
					deferred: 1,
				},
				children: [
					{
						runId: "run-terminal-a",
						taskId: "task-terminal-a",
						status: "completed",
						summary: "artifact ready for parent",
						updatedAt: "2026-05-02T07:57:00.000Z",
					},
					{
						runId: "run-terminal-z",
						taskId: "task-terminal-z",
						status: "deferred",
						summary: "deferred for later batch",
						updatedAt: "2026-05-02T07:58:00.000Z",
					},
				],
			},
		});
		expect(
			replaySupervisorProgressEventsReport(
				createBufferedSupervisorProgressSink(),
				projection.events,
			),
		).toMatchObject({
			batch: {
				byType: {
					progress_snapshot: 1,
					child_heartbeat: 1,
					terminal_children_summary: 1,
				},
				bySeverity: {
					info: 2,
					warning: 1,
					success: 0,
					error: 0,
				},
			},
			attention: {
				status: "needs_attention",
				warningCount: 1,
				errorCount: 0,
			},
		});
	});
});
