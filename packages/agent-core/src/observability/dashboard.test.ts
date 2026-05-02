import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createChildRunStatusRecord,
	projectSupervisorProgressEvents,
} from "../multi-agent/supervisor-progress.js";
import {
	adaptSupervisorProgressEventsToDashboardRecords,
	createObservabilityDashboardHandler,
	type SupervisorProgressDashboardRecord,
	startObservabilityDashboard,
} from "./dashboard.js";
import type { SerializedSpan } from "./exporters/json-file.js";
import type { TraceStore } from "./trace-store.js";

const servers: ReturnType<typeof createServer>[] = [];
const traceId = "a".repeat(32);
const progressNow = "2026-05-02T08:00:00.000Z";

function serializedSpan(
	overrides: Partial<SerializedSpan> = {},
): SerializedSpan {
	return {
		name: "llm.invoke",
		trace_id: traceId,
		span_id: "b".repeat(16),
		start_time_unix_ms: 100,
		end_time_unix_ms: 125,
		duration_ms: 25,
		status: "ok",
		attributes: {
			"llm.provider": "openai",
			"llm.model": "gpt-test",
			"llm.tokens_input": 2,
			"llm.tokens_output": 3,
			"llm.tokens_thinking": 0,
			"llm.cost_usd": 0.01,
			"llm.total_latency_ms": 25,
		},
		events: [],
		children: [],
		...overrides,
	};
}

async function writeTraceFile(logsDir: string): Promise<void> {
	await mkdir(logsDir, { recursive: true });
	await writeFile(
		join(logsDir, "traces-2026-04-25.jsonl"),
		`${JSON.stringify(serializedSpan())}\n${JSON.stringify(
			serializedSpan({
				trace_id: "c".repeat(32),
				span_id: "d".repeat(16),
			}),
		)}\n`,
	);
}

async function startDashboard(logsDir: string): Promise<string> {
	const server = createServer(
		createObservabilityDashboardHandler({
			logsDir,
			defaultTraceLimit: 10,
			durationBucketsMs: [10, 50],
		}),
	);
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

async function startDashboardWithTraceStore(
	traceStore: TraceStore,
): Promise<string> {
	const server = createServer(
		createObservabilityDashboardHandler({
			traceStore,
		}),
	);
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

function findDashboardRecord(
	records: readonly SupervisorProgressDashboardRecord[],
	eventType: SupervisorProgressDashboardRecord["eventType"],
	childRunId?: string,
): SupervisorProgressDashboardRecord {
	const record = records.find(
		(candidate) =>
			candidate.eventType === eventType &&
			(childRunId == null || candidate.childRunId === childRunId),
	);
	if (record == null) {
		throw new Error(`Missing dashboard record for ${eventType}`);
	}

	return record;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error == null ? resolve() : reject(error)));
				}),
		),
	);
});

describe("observability dashboard", () => {
	it("adapts supervisor progress events into dashboard notification records", () => {
		const projection = projectSupervisorProgressEvents(
			[
				createChildRunStatusRecord({
					runId: "run-stale",
					taskId: "task-stale",
					status: "active",
					summary: "still working",
					currentStep: "checking progress",
					lastHeartbeatAt: "2026-05-02T07:57:00.000Z",
					nextCheckpointAt: "2026-05-02T07:59:30.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-completed",
					taskId: "task-completed",
					status: "completed",
					summary: "artifact ready",
					lastHeartbeatAt: "2026-05-02T07:59:00.000Z",
				}),
				createChildRunStatusRecord({
					runId: "run-failed",
					taskId: "task-failed",
					status: "failed",
					summary: "worker failed",
					lastHeartbeatAt: "2026-05-02T07:59:10.000Z",
				}),
			],
			{ now: progressNow, staleAfterMs: 120_000 },
		);

		const records = adaptSupervisorProgressEventsToDashboardRecords(
			projection.events,
		);

		expect(findDashboardRecord(records, "progress_snapshot")).toEqual({
			sourceEventId: `progress_snapshot:${progressNow}`,
			eventType: "progress_snapshot",
			severity: "warning",
			title: "Supervisor progress: making_progress",
			summary: "3 child runs, unknown confidence, 0 reviewed artifacts.",
			timestamp: progressNow,
			generatedAt: progressNow,
		});
		expect(findDashboardRecord(records, "child_stale", "run-stale")).toEqual({
			sourceEventId: `child_stale:run-stale:task-stale:${progressNow}`,
			eventType: "child_stale",
			severity: "warning",
			title: "Child run stale",
			summary:
				"run-stale last heartbeat is 180000ms old; stale threshold is 120000ms.",
			childRunId: "run-stale",
			taskId: "task-stale",
			timestamp: progressNow,
		});
		expect(
			findDashboardRecord(records, "child_heartbeat", "run-stale"),
		).toEqual({
			sourceEventId:
				"child_heartbeat:run-stale:task-stale:2026-05-02T07:57:00.000Z",
			eventType: "child_heartbeat",
			severity: "info",
			title: "Child heartbeat: active",
			summary: "still working",
			childRunId: "run-stale",
			taskId: "task-stale",
			timestamp: "2026-05-02T07:57:00.000Z",
		});
		expect(
			findDashboardRecord(records, "child_checkpoint", "run-stale"),
		).toEqual({
			sourceEventId:
				"child_checkpoint:run-stale:task-stale:2026-05-02T07:59:30.000Z",
			eventType: "child_checkpoint",
			severity: "warning",
			title: "Child checkpoint due",
			summary: "run-stale checkpoint is due now.",
			childRunId: "run-stale",
			taskId: "task-stale",
			timestamp: "2026-05-02T07:59:30.000Z",
		});
		expect(findDashboardRecord(records, "terminal_children_summary")).toEqual({
			sourceEventId: `terminal_children_summary:${progressNow}`,
			eventType: "terminal_children_summary",
			severity: "error",
			title: "Terminal children summary",
			summary:
				"2 terminal child runs: 1 completed, 1 failed, 0 cancelled, 0 deferred.",
			timestamp: progressNow,
		});
	});

	it("serves metrics, traces, trace details, and dashboard html", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "quilin-dashboard-"));
		await writeTraceFile(logsDir);
		const baseUrl = await startDashboard(logsDir);

		const metrics = await fetch(`${baseUrl}/metrics?date=2026-04-25`);
		const traces = await fetch(`${baseUrl}/traces?date=2026-04-25&limit=1`);
		const trace = await fetch(`${baseUrl}/traces/${traceId}?date=2026-04-25`);
		const dashboard = await fetch(`${baseUrl}/`);

		expect(metrics.headers.get("content-type")).toContain("text/plain");
		expect(await metrics.text()).toContain(
			'quilin_llm_invocations_total{model="gpt-test",provider="openai",status="ok"} 2',
		);
		expect(await traces.json()).toEqual({
			spans: [serializedSpan()],
			skipped_lines: 0,
			files: ["traces-2026-04-25.jsonl"],
		});
		expect(await trace.json()).toEqual({
			trace_id: traceId,
			spans: [serializedSpan()],
			skipped_lines: 0,
			files: ["traces-2026-04-25.jsonl"],
		});
		expect(await dashboard.text()).toContain("Quilin Observability");
	});

	it("returns deterministic errors for unsupported requests", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "quilin-dashboard-"));
		const baseUrl = await startDashboard(logsDir);

		const missing = await fetch(`${baseUrl}/missing`);
		const badQuery = await fetch(`${baseUrl}/traces?limit=oops`);

		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "not_found" });
		expect(badQuery.status).toBe(400);
		expect(await badQuery.json()).toEqual({
			error: "bad_request",
			message: "Invalid numeric query parameter: oops",
		});
	});

	it("returns non-leaky internal errors for trace storage failures", async () => {
		const traceStore = {
			querySpanSnapshots: async () => {
				throw new Error("secret trace snapshot path");
			},
			querySpans: async () => {
				throw new Error("secret trace json path");
			},
		} as unknown as TraceStore;
		const baseUrl = await startDashboardWithTraceStore(traceStore);

		const metrics = await fetch(`${baseUrl}/metrics`);
		const traces = await fetch(`${baseUrl}/traces`);

		expect(metrics.status).toBe(500);
		expect(traces.status).toBe(500);
		expect(await metrics.json()).toEqual({
			error: "internal_error",
			message: "Observability dashboard failed to read data",
		});
		expect(await traces.text()).not.toContain("secret");
	});

	it("rejects startup when the requested port is already in use", async () => {
		const blocker = createServer();
		servers.push(blocker);
		await new Promise<void>((resolve) => {
			blocker.listen(0, "127.0.0.1", resolve);
		});
		const address = blocker.address() as AddressInfo;

		await expect(
			startObservabilityDashboard({
				host: "127.0.0.1",
				port: address.port,
			}),
		).rejects.toMatchObject({ code: "EADDRINUSE" });
	});
});
