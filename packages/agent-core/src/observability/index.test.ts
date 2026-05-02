import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	adaptSupervisorProgressEventsToDashboardRecords,
	adaptSupervisorProgressEventToDashboardRecord,
	aggregateSpanMetrics,
	buildComponentHealthEventRecord,
	buildToolResultAuditReportHealthBatchEventRecord,
	CompositeSpanExporter,
	createMCPRequestMetadata,
	deserializeSpan,
	getObservabilityContext,
	JsonFileSpanExporter,
	renderPrometheusMetrics,
	runWithObservabilityContext,
	type SerializedSpan,
	type SpanExporter,
	type SpanSnapshot,
	StructuredLogger,
	serializeSpan,
	TraceStore,
} from "./index.js";

const TEST_TIMESTAMP = "2026-05-02T10:00:00.000Z";
const TEST_TRACE_ID = "a".repeat(32);

const TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_SUMMARY = {
	status: "failed",
	byStatus: {
		clean: 2,
		blocked: 1,
		incomplete: 1,
		failed: 1,
	},
	total: 25,
	auditedTotal: 20,
	failedTotal: 3,
	blockedTotal: 4,
	missingTotal: 5,
} as const;

function serializedSpan(
	overrides: Partial<SerializedSpan> = {},
): SerializedSpan {
	return {
		name: "agent.turn",
		trace_id: TEST_TRACE_ID,
		span_id: "b".repeat(16),
		start_time_unix_ms: 100,
		end_time_unix_ms: 125,
		duration_ms: 25,
		status: "ok",
		attributes: { "turn.index": 1 },
		events: [],
		children: [],
		...overrides,
	};
}

describe("observability barrel exports", () => {
	it("exposes representative event-record helpers", () => {
		const componentHealth = buildComponentHealthEventRecord(
			{
				component: "observability",
				source: "agent-core.observability.index",
				status: "clean",
			},
			{ timestamp: TEST_TIMESTAMP },
		);
		const batchHealth = buildToolResultAuditReportHealthBatchEventRecord(
			TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_SUMMARY,
			{ timestamp: TEST_TIMESTAMP },
		);

		expect(componentHealth).toEqual({
			kind: "component_health",
			timestamp: TEST_TIMESTAMP,
			source: "agent-core.observability.component-health",
			payload: {
				component: "observability",
				source: "agent-core.observability.index",
				status: "clean",
			},
		});
		expect(batchHealth).toEqual({
			kind: "tool_result_audit_report_health_batch_summary",
			timestamp: TEST_TIMESTAMP,
			source: "agent-core.tools.router.result-audit.report-health-batch",
			payload: TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_SUMMARY,
		});
	});

	it("exposes TraceStore and deserializeSpan helpers", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "quilin-index-traces-"));
		const storedSpan = serializedSpan({
			parent_span_id: "p".repeat(16),
			events: [
				{
					name: "checkpoint",
					timestamp_unix_ms: 110,
					attributes: { step: "barrel" },
				},
			],
			children: ["child-span"],
		});
		try {
			await writeFile(
				join(logsDir, "traces-2026-05-02.jsonl"),
				`${JSON.stringify({ trace_id: TEST_TRACE_ID })}\n${JSON.stringify(
					storedSpan,
				)}\n`,
			);

			const result = await new TraceStore({ logsDir }).querySpanSnapshots({
				date: "2026-05-02",
				traceId: TEST_TRACE_ID,
			});

			expect(result).toEqual({
				spans: [deserializeSpan(storedSpan)],
				skippedLines: 1,
				files: ["traces-2026-05-02.jsonl"],
			});
		} finally {
			await rm(logsDir, { recursive: true, force: true });
		}
	});

	it("exposes dashboard record adapters", () => {
		const event: Parameters<
			typeof adaptSupervisorProgressEventToDashboardRecord
		>[0] = {
			schemaVersion: 1,
			id: "child_checkpoint:run-1:task-1:2026-05-02T10:00:03.000Z",
			type: "child_checkpoint",
			severity: "warning",
			occurredAt: TEST_TIMESTAMP,
			runId: "run-1",
			taskId: "task-1",
			payload: {
				status: "active",
				nextCheckpointAt: "2026-05-02T10:00:03.000Z",
				dueInMs: 3_000,
				isDue: false,
			},
		};
		const record = {
			sourceEventId: "child_checkpoint:run-1:task-1:2026-05-02T10:00:03.000Z",
			eventType: "child_checkpoint",
			severity: "warning",
			title: "Child checkpoint scheduled",
			summary: "run-1 checkpoint is due in 3000ms.",
			childRunId: "run-1",
			taskId: "task-1",
			timestamp: TEST_TIMESTAMP,
		};

		expect(adaptSupervisorProgressEventToDashboardRecord(event)).toEqual(
			record,
		);
		expect(adaptSupervisorProgressEventsToDashboardRecords([event])).toEqual([
			record,
		]);
	});

	it("keeps dashboard batch adapter boundaries visible through the barrel", () => {
		const generatedAt = "2026-05-02T10:00:05.000Z";
		const snapshot: Parameters<
			typeof adaptSupervisorProgressEventToDashboardRecord
		>[0] = {
			schemaVersion: 1,
			id: "progress_snapshot:run-1:2026-05-02T10:00:00.000Z",
			type: "progress_snapshot",
			severity: "info",
			occurredAt: TEST_TIMESTAMP,
			payload: {
				band: "making_progress",
				confidence: "high",
				totalRuns: 0,
				counts: {
					queued: 0,
					assigned: 0,
					active: 0,
					blocked: 0,
					waiting_for_review: 0,
					aggregating: 0,
					completed: 0,
					failed: 0,
					cancelled: 0,
					deferred: 0,
				},
				activeRunIds: [],
				queuedRunIds: [],
				blockedRunIds: [],
				staleRunIds: [],
				terminalRunIds: [],
				boundedPercent: null,
				reviewedArtifactCount: 0,
				nextCheckpointAt: null,
				generatedAt,
			},
		};

		expect(adaptSupervisorProgressEventsToDashboardRecords([])).toEqual([]);
		expect(adaptSupervisorProgressEventToDashboardRecord(snapshot)).toEqual({
			sourceEventId: "progress_snapshot:run-1:2026-05-02T10:00:00.000Z",
			eventType: "progress_snapshot",
			severity: "info",
			title: "Supervisor progress: making_progress",
			summary: "0 child runs, high confidence, 0 reviewed artifacts.",
			timestamp: TEST_TIMESTAMP,
			generatedAt,
		});
	});

	it("exposes StructuredLogger through the barrel", () => {
		const lines: string[] = [];
		const logger = new StructuredLogger({
			level: "WARN",
			now: () => new Date(TEST_TIMESTAMP),
			write: (line) => lines.push(line),
		});

		logger.info("agent-core.observability", "barrel_event");
		runWithObservabilityContext(
			{
				traceId: TEST_TRACE_ID,
				spanId: "b".repeat(16),
				requestId: "request-1",
				sessionId: "session-1",
				turnId: "turn-1",
			},
			() =>
				logger.error("agent-core.observability", "barrel_event", {
					covered: true,
				}),
		);

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			timestamp: TEST_TIMESTAMP,
			level: "ERROR",
			component: "agent-core.observability",
			event: "barrel_event",
			trace_id: TEST_TRACE_ID,
			span_id: "b".repeat(16),
			request_id: "request-1",
			session_id: "session-1",
			turn_id: "turn-1",
			data: { covered: true },
		});
	});

	it("exposes a metrics helper", () => {
		const span = {
			name: "agent.turn",
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			startTimeUnixMs: 10,
			endTimeUnixMs: 20,
			durationMs: 10,
			status: "ok",
			attributes: {},
			events: [],
			children: [],
		} as const satisfies SpanSnapshot;

		expect(aggregateSpanMetrics([span]).counters).toContainEqual({
			name: "quilin_spans_total",
			labels: { span_name: "agent.turn", status: "ok" },
			value: 1,
		});
	});

	it("exposes metrics aggregation boundaries through the barrel", () => {
		const metrics = aggregateSpanMetrics(
			[
				{
					name: "tool.invoke",
					traceId: "trace-one",
					spanId: "b".repeat(16),
					startTimeUnixMs: 10,
					endTimeUnixMs: 8,
					durationMs: -2,
					status: "error",
					attributes: {
						"tool.name": "",
						"tool.success": false,
						"tool.duration_ms": Number.NaN,
					},
					events: [],
					children: [],
				},
			],
			{ durationBucketsMs: [50, 10, 10, Number.NaN, -1] },
		);

		expect(metrics.counters).toContainEqual({
			name: "quilin_traces_total",
			labels: {},
			value: 1,
		});
		expect(metrics.counters).toContainEqual({
			name: "quilin_tool_invocations_total",
			labels: { tool_name: "unknown", status: "error", success: "false" },
			value: 1,
		});
		expect(metrics.histograms).toEqual([]);
	});

	it("renders Prometheus edge cases through the barrel", () => {
		expect(renderPrometheusMetrics({ counters: [], histograms: [] })).toBe(
			"\n",
		);
		expect(
			renderPrometheusMetrics({
				counters: [
					{
						name: "1 invalid.metric",
						labels: {
							" weird.label ": 'line\n"quoted"\\value',
						},
						value: Number.POSITIVE_INFINITY,
					},
				],
				histograms: [
					{
						name: "latency.ms",
						labels: { le: "caller-supplied", status: "ok" },
						buckets: [{ le: 10, count: 2 }],
						count: 3,
						sum: 12.5,
					},
				],
			}),
		).toBe(
			[
				"# TYPE _1_invalid_metric counter",
				'_1_invalid_metric{weird_label="line\\n\\"quoted\\"\\\\value"} 0',
				"# TYPE latency_ms histogram",
				'latency_ms_bucket{label_le="caller-supplied",le="10",status="ok"} 2',
				'latency_ms_bucket{label_le="caller-supplied",le="+Inf",status="ok"} 3',
				'latency_ms_sum{label_le="caller-supplied",status="ok"} 12.5',
				'latency_ms_count{label_le="caller-supplied",status="ok"} 3',
				"",
			].join("\n"),
		);
		expect(() =>
			renderPrometheusMetrics({
				counters: [
					{ name: "metric", labels: { "a-b": "one", "a b": "two" }, value: 1 },
				],
				histograms: [],
			}),
		).toThrow("Prometheus label key collision after canonicalization");
	});

	it("exposes representative exporter classes and helpers", async () => {
		const span = {
			name: "agent.turn",
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			startTimeUnixMs: 10,
			endTimeUnixMs: 20,
			durationMs: 10,
			status: "ok",
			attributes: {},
			events: [],
			children: [],
		} as const satisfies SpanSnapshot;
		const exported: SpanSnapshot[] = [];
		const collectingExporter: SpanExporter = {
			exportSpan: (input) => {
				exported.push(input);
			},
		};

		const compositeExporter = new CompositeSpanExporter([collectingExporter]);
		await expect(compositeExporter.exportSpan(span)).resolves.toBeUndefined();

		expect(exported).toEqual([span]);
		expect(new JsonFileSpanExporter()).toBeInstanceOf(JsonFileSpanExporter);
		expect(serializeSpan(span)).toMatchObject({
			name: "agent.turn",
			trace_id: "a".repeat(32),
			span_id: "b".repeat(16),
			status: "ok",
		});
		expect(renderPrometheusMetrics(aggregateSpanMetrics([span]))).toContain(
			'quilin_spans_total{span_name="agent.turn",status="ok"} 1',
		);
	});

	it("exposes exporter helper boundaries through the barrel", async () => {
		const span = {
			name: "agent.turn",
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			startTimeUnixMs: 10,
			endTimeUnixMs: 20,
			durationMs: 10,
			status: "ok",
			attributes: {},
			events: [],
			children: [],
		} as const satisfies SpanSnapshot;
		const failure = new Error("export failed");
		const exportedBatches: readonly SpanSnapshot[][] = [];
		const compositeExporter = new CompositeSpanExporter([
			{
				exportSpans: async () => {
					throw failure;
				},
			},
			{
				exportSpans: (spans) => {
					(exportedBatches as SpanSnapshot[][]).push([...spans]);
				},
			},
		]);

		await expect(
			compositeExporter.exportSpans([span]),
		).resolves.toBeUndefined();

		expect(exportedBatches).toEqual([[span]]);
		expect(compositeExporter.lastFailures).toEqual([
			{ exporterIndex: 0, error: failure },
		]);
		expect(
			serializeSpan({ ...span, durationMs: undefined }),
		).not.toHaveProperty("duration_ms");
	});

	it("exposes context helpers", () => {
		expect(
			runWithObservabilityContext(
				{
					requestId: "req-1",
					traceId: "a".repeat(32),
					spanId: "b".repeat(16),
				},
				() => ({
					context: getObservabilityContext(),
					metadata: createMCPRequestMetadata(),
				}),
			),
		).toEqual({
			context: {
				requestId: "req-1",
				traceId: "a".repeat(32),
				spanId: "b".repeat(16),
			},
			metadata: {
				request_id: "req-1",
				traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
			},
		});
	});
});
