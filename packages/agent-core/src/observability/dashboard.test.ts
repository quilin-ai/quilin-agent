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
	type DashboardDataProviders,
	type DashboardMemoryData,
	type DashboardSessionsData,
	type DashboardSkillsMcpData,
	type DashboardTasksData,
	type DashboardToolsData,
	type DashboardTopologyData,
	type SupervisorProgressDashboardRecord,
	startObservabilityDashboard,
} from "./dashboard.js";
import type { SerializedSpan } from "./exporters/json-file.js";
import type { TraceQuery, TraceStore } from "./trace-store.js";

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
					summary:
						"still working for alpha@example.com at /Users/alice/.ssh/id_rsa",
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
			summary:
				"still working for [REDACTED:email] at [REDACTED:sensitive_path]",
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

	it("does not apply the list default limit to trace detail routes", async () => {
		const observedQueries: TraceQuery[] = [];
		const traceStore = {
			querySpanSnapshots: async () => ({
				spans: [],
				skippedLines: 0,
				files: [],
			}),
			querySpans: async (query: TraceQuery) => {
				observedQueries.push(query);
				return { spans: [], skippedLines: 0, files: [] };
			},
		} as unknown as TraceStore;
		const baseUrl = await startDashboardWithTraceStore(traceStore);

		await fetch(`${baseUrl}/traces?trace_id=${traceId}`);
		await fetch(`${baseUrl}/traces/${traceId}`);
		await fetch(`${baseUrl}/traces/${traceId}?limit=1`);

		expect(observedQueries).toEqual([
			{ traceId, limit: 100 },
			{ traceId, limit: undefined },
			{ traceId, limit: 1 },
		]);
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

async function startDashboardWithProviders(
	dataProviders: DashboardDataProviders,
): Promise<string> {
	const logsDir = await mkdtemp(join(tmpdir(), "quilin-dashboard-ui-"));
	const server = createServer(
		createObservabilityDashboardHandler({
			logsDir,
			dataProviders,
		}),
	);
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

describe("observability dashboard 7-panel UI", () => {
	it("serves the static dashboard ui index and assets under /ui", async () => {
		const baseUrl = await startDashboardWithProviders({});

		const indexResponse = await fetch(`${baseUrl}/ui/`);
		expect(indexResponse.status).toBe(200);
		expect(indexResponse.headers.get("content-type")).toContain("text/html");
		const indexBody = await indexResponse.text();
		expect(indexBody).toContain("Quilin Observability Dashboard");
		expect(indexBody).toContain('data-panel="tasks"');
		expect(indexBody).toContain('data-panel="memory"');
		expect(indexBody).toContain('data-panel="tools"');
		expect(indexBody).toContain('data-panel="metrics"');
		expect(indexBody).toContain('data-panel="topology"');
		expect(indexBody).toContain('data-panel="sessions"');
		expect(indexBody).toContain('data-panel="skills"');

		const cssResponse = await fetch(`${baseUrl}/ui/app.css`);
		expect(cssResponse.status).toBe(200);
		expect(cssResponse.headers.get("content-type")).toContain("text/css");

		const jsResponse = await fetch(`${baseUrl}/ui/app.js`);
		expect(jsResponse.status).toBe(200);
		expect(jsResponse.headers.get("content-type")).toContain(
			"application/javascript",
		);
	});

	it("returns 404 for unknown ui assets and rejects path traversal", async () => {
		const baseUrl = await startDashboardWithProviders({});

		const missing = await fetch(`${baseUrl}/ui/does-not-exist.html`);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "ui_asset_not_found" });

		const traversal = await fetch(
			`${baseUrl}/ui/${encodeURIComponent("../dashboard.ts")}`,
		);
		expect(traversal.status).toBe(404);
	});

	it("returns empty placeholders for all 7 panels when no providers wired", async () => {
		const baseUrl = await startDashboardWithProviders({});

		const tasks = (await (
			await fetch(`${baseUrl}/api/dashboard/tasks`)
		).json()) as DashboardTasksData;
		expect(tasks).toEqual({ records: [], activeRunCount: 0, staleRunCount: 0 });

		const memory = (await (
			await fetch(`${baseUrl}/api/dashboard/memory`)
		).json()) as DashboardMemoryData;
		expect(memory.tiers.map((tier) => tier.name)).toEqual([
			"working",
			"episodic",
			"semantic",
			"skill",
		]);

		const tools = (await (
			await fetch(`${baseUrl}/api/dashboard/tools`)
		).json()) as DashboardToolsData;
		expect(tools).toEqual({ tools: [], total: 0, byNamespace: {} });

		const topology = (await (
			await fetch(`${baseUrl}/api/dashboard/topology`)
		).json()) as DashboardTopologyData;
		expect(topology).toEqual({
			supervisorStatus: "unknown",
			activeRunCount: 0,
			totalRunCount: 0,
			runs: [],
		});

		const sessions = (await (
			await fetch(`${baseUrl}/api/dashboard/sessions`)
		).json()) as DashboardSessionsData;
		expect(sessions).toEqual({
			sessions: [],
			total: 0,
			activeCount: 0,
			terminalCount: 0,
		});

		const skills = (await (
			await fetch(`${baseUrl}/api/dashboard/skills-mcp`)
		).json()) as DashboardSkillsMcpData;
		expect(skills).toEqual({
			skills: { catalog: [] },
			mcp: { servers: [] },
			config: null,
			providers: [],
		});

		const metrics = await fetch(`${baseUrl}/api/dashboard/metrics`);
		expect(metrics.status).toBe(200);
		const metricsBody = (await metrics.json()) as {
			totals: { spans: number };
		};
		expect(metricsBody.totals.spans).toBe(0);
	});

	it("invokes wired data providers and returns their payloads", async () => {
		const tasksData: DashboardTasksData = {
			records: [
				{
					childRunId: "run-1",
					taskId: "task-1",
					eventType: "child_heartbeat",
					severity: "info",
					title: "Child heartbeat",
					summary: "running",
					timestamp: "2026-05-09T00:00:00.000Z",
				},
			],
			activeRunCount: 1,
			staleRunCount: 0,
		};
		const toolsData: DashboardToolsData = {
			tools: [
				{
					name: "shell_exec",
					namespace: "builtin",
					category: "shell",
					riskLevel: "high",
				},
			],
			total: 1,
			byNamespace: { builtin: 1 },
		};
		const sessionsData: DashboardSessionsData = {
			sessions: [
				{
					sessionId: "abc",
					status: "active",
					source: "checkpoint",
					turnCount: 3,
					messageCount: 6,
					lastActiveAt: "2026-05-09T00:00:00.000Z",
				},
			],
			total: 1,
			activeCount: 1,
			terminalCount: 0,
		};
		const baseUrl = await startDashboardWithProviders({
			tasks: () => tasksData,
			tools: async () => toolsData,
			sessions: () => sessionsData,
		});

		expect(
			await (await fetch(`${baseUrl}/api/dashboard/tasks`)).json(),
		).toEqual(tasksData);
		expect(
			await (await fetch(`${baseUrl}/api/dashboard/tools`)).json(),
		).toEqual(toolsData);
		expect(
			await (await fetch(`${baseUrl}/api/dashboard/sessions`)).json(),
		).toEqual(sessionsData);
	});

	it("returns 404 for unknown panel route", async () => {
		const baseUrl = await startDashboardWithProviders({});

		const response = await fetch(`${baseUrl}/api/dashboard/unknown-panel`);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "panel_not_found" });
	});

	it("aggregates metrics totals from trace store spans", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "quilin-dashboard-metrics-"));
		await mkdir(logsDir, { recursive: true });
		const today = new Date().toISOString().slice(0, 10);
		await writeFile(
			join(logsDir, `traces-${today}.jsonl`),
			[
				JSON.stringify(
					serializedSpan({
						name: "llm.invoke",
						attributes: {
							"llm.tokens_input": 100,
							"llm.tokens_output": 50,
							"llm.total_latency_ms": 200,
						},
					}),
				),
				JSON.stringify(
					serializedSpan({
						name: "tool.invoke",
						span_id: "f".repeat(16),
						trace_id: "e".repeat(32),
						status: "error",
						duration_ms: 30,
						attributes: { "tool.name": "shell_exec" },
					}),
				),
			].join("\n") + "\n",
		);
		const server = createServer(
			createObservabilityDashboardHandler({ logsDir }),
		);
		servers.push(server);
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const response = await fetch(`${baseUrl}/api/dashboard/metrics`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			totals: {
				spans: number;
				llmCalls: number;
				tokensIn: number;
				tokensOut: number;
				errors: number;
			};
			byTool: ReadonlyArray<{ tool: string; calls: number; errors: number }>;
		};
		expect(body.totals.spans).toBe(2);
		expect(body.totals.llmCalls).toBe(1);
		expect(body.totals.tokensIn).toBe(100);
		expect(body.totals.tokensOut).toBe(50);
		expect(body.totals.errors).toBe(1);
		expect(body.byTool).toEqual([
			{
				tool: "shell_exec",
				calls: 1,
				errors: 1,
				p50LatencyMs: 30,
				p95LatencyMs: 30,
			},
		]);
	});

	it("computes nearest-rank percentiles for n=10 samples (QUI-105 round-1 #4)", async () => {
		const logsDir = await mkdtemp(
			join(tmpdir(), "quilin-dashboard-percentile-"),
		);
		await mkdir(logsDir, { recursive: true });
		const today = new Date().toISOString().slice(0, 10);
		// 10 latency samples: 10, 20, ..., 100. Nearest-rank dictates:
		//   p50 -> ceil(0.5 * 10) - 1 = idx 4 -> 50
		//   p95 -> ceil(0.95 * 10) - 1 = idx 9 -> 100
		// The previous Math.floor formula returned idx 5 (60) and idx 9 (100),
		// which silently underweighted small-sample p50.
		const lines: string[] = [];
		for (let i = 1; i <= 10; i += 1) {
			lines.push(
				JSON.stringify(
					serializedSpan({
						name: "tool.invoke",
						span_id: i.toString().padStart(16, "0"),
						trace_id: i.toString().padStart(32, "0"),
						duration_ms: i * 10,
						attributes: { "tool.name": "shell_exec" },
					}),
				),
			);
		}
		await writeFile(
			join(logsDir, `traces-${today}.jsonl`),
			`${lines.join("\n")}\n`,
		);
		const server = createServer(
			createObservabilityDashboardHandler({ logsDir }),
		);
		servers.push(server);
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address() as AddressInfo;

		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/dashboard/metrics`,
		);
		const body = (await response.json()) as {
			byTool: ReadonlyArray<{
				tool: string;
				p50LatencyMs?: number;
				p95LatencyMs?: number;
			}>;
		};
		expect(body.byTool).toHaveLength(1);
		expect(body.byTool[0]?.tool).toBe("shell_exec");
		expect(body.byTool[0]?.p50LatencyMs).toBe(50);
		expect(body.byTool[0]?.p95LatencyMs).toBe(100);
	});

	it("forwards query params to /api/dashboard/metrics (QUI-105 round-1 #5)", async () => {
		const observedQueries: TraceQuery[] = [];
		const traceStore = {
			querySpanSnapshots: async () => ({
				spans: [],
				skippedLines: 0,
				files: [],
			}),
			querySpans: async (query: TraceQuery) => {
				observedQueries.push(query);
				return { spans: [], skippedLines: 0, files: [] };
			},
		} as unknown as TraceStore;
		const baseUrl = await startDashboardWithTraceStore(traceStore);

		await fetch(`${baseUrl}/api/dashboard/metrics?date=2026-04-25&limit=7`);

		expect(observedQueries).toHaveLength(1);
		expect(observedQueries[0]).toEqual({ date: "2026-04-25", limit: 7 });
	});
});
