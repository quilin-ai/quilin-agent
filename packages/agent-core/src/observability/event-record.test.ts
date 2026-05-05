import { describe, expect, it } from "vitest";
import {
	buildRuntimeReloadAuditEvent,
	type UserRuntimeStateSnapshot,
} from "../config/runtime.js";
import { createDefaultContextAssembler } from "../context/draft/context-assembler.js";
import type { ContextSource } from "../context/draft/source-types.js";
import type {
	ToolResultAuditBatchSummary,
	ToolResultAuditReadinessSummary,
	ToolResultAuditReport,
	ToolResultAuditReportHealthBatchSummary,
	ToolResultAuditReportHealthSummary,
} from "../tools/types.js";
import {
	buildComponentHealthEventRecord,
	buildContextCachePlanEventRecord,
	buildContextTraceDeltaEventRecord,
	buildContextTraceSummaryEventRecord,
	buildObservabilityEventRecord,
	buildPlannerRoutingDecisionEventRecord,
	buildRuntimeReloadAuditEventRecord,
	buildSupervisorProgressFlushEventRecord,
	buildToolInvocationAuditBatchEventRecord,
	buildToolInvocationAuditEventRecord,
	buildToolResultAuditBatchEventRecord,
	buildToolResultAuditReadinessEventRecord,
	buildToolResultAuditReportEventRecord,
	buildToolResultAuditReportHealthBatchEventRecord,
	buildToolResultAuditReportHealthEventRecord,
	COMPONENT_HEALTH_EVENT_KIND,
	COMPONENT_HEALTH_EVENT_SOURCE,
	CONTEXT_CACHE_PLAN_EVENT_KIND,
	CONTEXT_CACHE_PLAN_EVENT_SOURCE,
	CONTEXT_TRACE_DELTA_EVENT_KIND,
	CONTEXT_TRACE_DELTA_EVENT_SOURCE,
	CONTEXT_TRACE_SUMMARY_EVENT_KIND,
	CONTEXT_TRACE_SUMMARY_EVENT_SOURCE,
	type ComponentHealthEventPayload,
	type ObservabilityEventPayload,
	PLANNER_ROUTING_DECISION_EVENT_KIND,
	PLANNER_ROUTING_DECISION_EVENT_SOURCE,
	RUNTIME_RELOAD_AUDIT_EVENT_KIND,
	RUNTIME_RELOAD_AUDIT_EVENT_SOURCE,
	SUPERVISOR_PROGRESS_FLUSH_EVENT_KIND,
	SUPERVISOR_PROGRESS_FLUSH_EVENT_SOURCE,
	TOOL_INVOCATION_AUDIT_BATCH_EVENT_KIND,
	TOOL_INVOCATION_AUDIT_BATCH_EVENT_SOURCE,
	TOOL_INVOCATION_AUDIT_EVENT_KIND,
	TOOL_INVOCATION_AUDIT_EVENT_SOURCE,
	TOOL_RESULT_AUDIT_BATCH_EVENT_KIND,
	TOOL_RESULT_AUDIT_BATCH_EVENT_SOURCE,
	TOOL_RESULT_AUDIT_READINESS_EVENT_KIND,
	TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE,
	TOOL_RESULT_AUDIT_REPORT_EVENT_KIND,
	TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE,
	TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND,
	TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE,
	TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND,
	TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE,
} from "./event-record.js";

const TEST_TIMESTAMP = "2026-05-01T12:34:56.789Z";

function serializeRoundTrip<T>(value: T): unknown {
	return JSON.parse(JSON.stringify(value));
}

function runtimeSnapshot(
	overrides: Partial<UserRuntimeStateSnapshot> = {},
): UserRuntimeStateSnapshot {
	return {
		generation: 1,
		booted: true,
		inFlight: false,
		inFlightGenerations: [],
		lastSuccess: null,
		lastFailure: null,
		...overrides,
	};
}

function makeSource(
	content: string,
	overrides: Partial<ContextSource> = {},
): ContextSource {
	return {
		sourceId: overrides.sourceId,
		sourceType: overrides.sourceType ?? "memory",
		content,
		tokenCount: overrides.tokenCount ?? 1,
		relevanceScore: overrides.relevanceScore ?? 0.5,
		timestamp: overrides.timestamp ?? 1,
		metadata: overrides.metadata ?? {},
		isExternal: overrides.isExternal ?? false,
		poisoningStatus: overrides.poisoningStatus,
	};
}

const SUPERVISOR_PROGRESS_FLUSH_PAYLOAD = {
	events: [
		{
			schemaVersion: 1,
			id: "progress_snapshot:supervisor:2026-05-02T08:00:00.000Z",
			type: "progress_snapshot",
			severity: "warning",
			occurredAt: "2026-05-02T08:00:00.000Z",
			snapshot: {
				band: "blocked",
				activeRunIds: ["run-a", "run-c"],
				blockedRunIds: ["run-a"],
				staleRunIds: ["run-a"],
				terminalRunIds: ["run-b"],
				boundedPercent: null,
				oldestHeartbeatAgeMs: 300000,
				nextCheckpointAt: "2026-05-02T08:05:00.000Z",
			},
		},
	],
	counts: {
		progress_snapshot: 1,
		child_stale: 1,
		child_heartbeat: 3,
		child_checkpoint: 1,
		terminal_children_summary: 1,
	},
	severities: {
		info: 2,
		warning: 3,
		success: 2,
		error: 0,
	},
	cursor: "progress_snapshot:supervisor:2026-05-02T08:00:00.000Z",
	latestOccurredAt: "2026-05-02T08:00:00.000Z",
} as const satisfies ObservabilityEventPayload;

const TOOL_INVOCATION_AUDIT_SUMMARY = {
	tool: "file_write",
	call: "call-audit",
	outcome: "tool_error",
	errorCode: "execution_failed",
	retryable: false,
	summary: "Tool file_write failed with execution_failed.",
	detail:
		"tool=file_write; call=call-audit; outcome=tool_error; code=execution_failed; retryable=false",
} as const satisfies ObservabilityEventPayload;

const TOOL_INVOCATION_AUDIT_BATCH_SUMMARY = {
	total: 3,
	byOutcome: {
		success: 1,
		tool_error: 1,
		sandbox_ask: 1,
		sandbox_deny: 0,
		unknown_error: 0,
	},
	byTool: {
		file_write: 2,
		memory_store: 1,
	},
	reasonCodes: {
		write_operation_requires_approval: 1,
	},
	blockedCallIds: ["call-ask"],
} as const satisfies ObservabilityEventPayload;

const TOOL_RESULT_AUDIT_BATCH_SUMMARY = {
	total: 4,
	byOutcome: {
		success: 2,
		tool_error: 1,
		sandbox_ask: 1,
		sandbox_deny: 0,
		unknown_error: 0,
	},
	byTool: {
		file_write: 2,
		memory_store: 2,
	},
	reasonCodes: {
		write_operation_requires_approval: 1,
	},
	blockedCallIds: ["call-ask"],
	missingAuditResultIds: ["call-missing-a", "call-missing-z"],
} as const satisfies ToolResultAuditBatchSummary;

const TOOL_RESULT_AUDIT_READINESS_SUMMARY = {
	status: "partial",
	total: 6,
	auditedTotal: 4,
	missingTotal: 2,
	missingAuditResultIds: ["call-missing-a", "call-missing-z"],
} as const satisfies ToolResultAuditReadinessSummary;

const TOOL_RESULT_AUDIT_REPORT = {
	audit: TOOL_RESULT_AUDIT_BATCH_SUMMARY,
	readiness: TOOL_RESULT_AUDIT_READINESS_SUMMARY,
} as const satisfies ToolResultAuditReport;

const TOOL_RESULT_AUDIT_REPORT_HEALTH_SUMMARY = {
	status: "blocked",
	total: 6,
	auditedTotal: 4,
	failedTotal: 0,
	blockedTotal: 1,
	missingTotal: 2,
} as const satisfies ToolResultAuditReportHealthSummary;

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
} as const satisfies ToolResultAuditReportHealthBatchSummary;

const PLANNER_ROUTING_TRACE_PAYLOAD = {
	schemaVersion: 1,
	runId: "run-routing-event",
	traceId: "trace-routing-event",
	route: "supervisor_required",
	strategy: "plan_and_execute",
	reasonCodes: ["tool_call_count_requires_supervisor"],
	budget: {
		tokenRemaining: 2048,
		turnRemaining: 4,
	},
	structuralSignals: {
		hasToolCalls: true,
		toolCallCount: 3,
		hasPlanSketch: false,
		needsClarification: false,
	},
	riskTier: "ask_on_write",
	capabilitiesRequired: ["coding"],
	capabilityCount: 1,
	requiresSupervisor: true,
	requiresProviderRoute: false,
	requiresHandoffEnvelope: true,
} as const satisfies ObservabilityEventPayload;

const COMPONENT_HEALTH_PAYLOAD = {
	component: "skills.manifest",
	source: "agent-core.skills.manifest",
	status: "warning",
	checkedAt: "2026-05-02T08:10:00.000Z",
	summary: {
		total: 3,
		healthy: 2,
		warning: 1,
		critical: 0,
	},
	signals: [
		{
			code: "missing-description",
			severity: "warning",
			count: 1,
		},
	],
} as const satisfies ComponentHealthEventPayload;

describe("observability event records", () => {
	it("wraps runtime reload audit events with stable record fields and serializable payload", () => {
		const auditEvent = buildRuntimeReloadAuditEvent({
			before: runtimeSnapshot({
				generation: 4,
				lastSuccess: {
					generation: 4,
					operation: "reload",
					completedAtEpochMs: 1000,
					configPath: "/tmp/quilin.toml",
				},
			}),
			after: runtimeSnapshot({
				generation: 5,
				lastSuccess: {
					generation: 4,
					operation: "reload",
					completedAtEpochMs: 1000,
					configPath: "/tmp/quilin.toml",
				},
				lastFailure: {
					generation: 5,
					operation: "reload",
					completedAtEpochMs: 2000,
					errorName: "UserConfigError",
					errorMessage: "invalid log level",
					errorCode: "SCHEMA_VALIDATION",
				},
			}),
		});

		const record = buildRuntimeReloadAuditEventRecord(auditEvent, {
			timestamp: TEST_TIMESTAMP,
		});

		expect(record).toEqual({
			kind: RUNTIME_RELOAD_AUDIT_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: RUNTIME_RELOAD_AUDIT_EVENT_SOURCE,
			payload: auditEvent,
		});
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("builds runtime reload audit records directly from snapshots with injected timestamps", () => {
		const before = runtimeSnapshot({
			generation: 7,
			inFlight: true,
			inFlightGenerations: [7, 8],
			lastFailure: {
				generation: 7,
				operation: "reload",
				completedAtEpochMs: 7000,
				errorName: "UserConfigError",
				errorMessage: "invalid prior config",
				errorCode: "SCHEMA_VALIDATION",
			},
		});
		const after = runtimeSnapshot({
			generation: 8,
			inFlight: false,
			inFlightGenerations: [],
			lastSuccess: {
				generation: 8,
				operation: "reload",
				completedAtEpochMs: 8000,
				configPath: "/tmp/quilin.toml",
			},
			lastFailure: before.lastFailure,
		});

		const firstRecord = buildRuntimeReloadAuditEventRecord(
			{ before, after },
			{ timestamp: new Date(TEST_TIMESTAMP) },
		);
		const secondRecord = buildRuntimeReloadAuditEventRecord(
			{ before, after },
			{ timestamp: Date.parse(TEST_TIMESTAMP) },
		);

		expect(firstRecord).toEqual(secondRecord);
		expect(firstRecord).toEqual({
			kind: RUNTIME_RELOAD_AUDIT_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: RUNTIME_RELOAD_AUDIT_EVENT_SOURCE,
			payload: {
				event: "user_runtime_reload_audit",
				generationDelta: 1,
				changedFields: [
					"generation",
					"inFlight",
					"inFlightGenerations",
					"lastSuccess",
				],
				transitionKind: "failure-to-success",
				inFlight: {
					addedGenerations: [],
					removedGenerations: [7, 8],
					countDelta: -2,
				},
				successPresent: true,
				failurePresent: true,
			},
		});
		expect(serializeRoundTrip(firstRecord)).toEqual(firstRecord);
	});

	it("wraps context trace summaries with stable record fields and serializable payload", () => {
		const assembler = createDefaultContextAssembler({ modelWindow: 12 });
		const result = assembler.assembleContext(
			"test",
			{},
			[],
			[
				makeSource("poisoned high-score source", {
					sourceId: "poisoned",
					tokenCount: 6,
					relevanceScore: 1,
					poisoningStatus: "poisoned",
				}),
				makeSource("high relevance source", {
					sourceId: "high",
					tokenCount: 6,
					relevanceScore: 0.95,
				}),
				makeSource("partially retained source", {
					sourceId: "partial",
					tokenCount: 6,
					relevanceScore: 0.9,
				}),
				makeSource("dropped source", {
					sourceId: "dropped",
					tokenCount: 6,
					relevanceScore: 0.8,
				}),
			],
		);

		const firstRecord = buildContextTraceSummaryEventRecord(
			result.traceSummary,
			{
				timestamp: TEST_TIMESTAMP,
			},
		);
		const secondRecord = buildContextTraceSummaryEventRecord(
			result.traceSummary,
			{
				timestamp: TEST_TIMESTAMP,
			},
		);

		expect(firstRecord).toEqual(secondRecord);
		expect(firstRecord).toEqual({
			kind: CONTEXT_TRACE_SUMMARY_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: CONTEXT_TRACE_SUMMARY_EVENT_SOURCE,
			payload: result.traceSummary,
		});
		expect(serializeRoundTrip(firstRecord)).toEqual(firstRecord);
	});

	it("wraps context cache plans with stable record fields and serializable payload", () => {
		const rawApiKey = "sk-abcdefghijklmnopqrstuvwxyz012345";
		const assembler = createDefaultContextAssembler({
			modelWindow: 12,
			providerPath: "anthropic",
			modelFamily: "claude",
			cacheProviderOptions: {
				apiKey: rawApiKey,
				safeName: "visible",
			},
			cacheExpectedUsageFields: ["cache_read_tokens", "cache_write_tokens"],
		});
		const result = assembler.assembleContext(
			"test",
			{},
			[],
			[
				makeSource("high relevance source", {
					sourceId: "high",
					tokenCount: 6,
					relevanceScore: 0.95,
				}),
			],
		);
		if (result.cachePlan == null) {
			throw new Error("expected cache plan");
		}

		const firstRecord = buildContextCachePlanEventRecord(result.cachePlan, {
			timestamp: TEST_TIMESTAMP,
		});
		const secondRecord = buildContextCachePlanEventRecord(result.cachePlan, {
			timestamp: TEST_TIMESTAMP,
		});

		expect(firstRecord).toEqual(secondRecord);
		expect(firstRecord).toEqual({
			kind: CONTEXT_CACHE_PLAN_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: CONTEXT_CACHE_PLAN_EVENT_SOURCE,
			payload: {
				...result.cachePlan,
				providerOptions: {
					apiKey: "[REDACTED]",
					safeName: "visible",
				},
			},
		});
		expect(result.cachePlan.providerOptions).toEqual({
			apiKey: rawApiKey,
			safeName: "visible",
		});
		expect(JSON.stringify(firstRecord)).not.toContain(rawApiKey);
		expect(serializeRoundTrip(firstRecord)).toEqual(firstRecord);
	});

	it("wraps context trace deltas with stable record fields and serializable payload", () => {
		const assembler = createDefaultContextAssembler({ modelWindow: 12 });
		const previous = assembler.assembleContext(
			"test",
			{},
			[],
			[
				makeSource("high relevance source", {
					sourceId: "high",
					tokenCount: 6,
					relevanceScore: 0.95,
				}),
			],
		);
		const current = assembler.assembleContext(
			"test",
			{},
			[],
			[
				makeSource("high relevance source", {
					sourceId: "high",
					tokenCount: 6,
					relevanceScore: 0.95,
				}),
				makeSource("new source under pressure", {
					sourceId: "new",
					tokenCount: 6,
					relevanceScore: 0.9,
				}),
			],
			{ previousTraceSummary: previous.traceSummary },
		);
		if (current.traceDelta == null) {
			throw new Error("expected trace delta");
		}

		const record = buildContextTraceDeltaEventRecord(current.traceDelta, {
			timestamp: TEST_TIMESTAMP,
		});

		expect(record).toEqual({
			kind: CONTEXT_TRACE_DELTA_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: CONTEXT_TRACE_DELTA_EVENT_SOURCE,
			payload: current.traceDelta,
		});
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps supervisor progress flush results with stable record fields and serializable payload", () => {
		const record = buildSupervisorProgressFlushEventRecord(
			SUPERVISOR_PROGRESS_FLUSH_PAYLOAD,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: SUPERVISOR_PROGRESS_FLUSH_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: SUPERVISOR_PROGRESS_FLUSH_EVENT_SOURCE,
			payload: SUPERVISOR_PROGRESS_FLUSH_PAYLOAD,
		});
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps planner routing trace payloads with stable record fields", () => {
		const record = buildPlannerRoutingDecisionEventRecord(
			PLANNER_ROUTING_TRACE_PAYLOAD,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: PLANNER_ROUTING_DECISION_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: PLANNER_ROUTING_DECISION_EVENT_SOURCE,
			payload: PLANNER_ROUTING_TRACE_PAYLOAD,
		});
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps sanitized tool invocation audit summaries with stable record fields and serializable payload", () => {
		const record = buildToolInvocationAuditEventRecord(
			TOOL_INVOCATION_AUDIT_SUMMARY,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: TOOL_INVOCATION_AUDIT_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: TOOL_INVOCATION_AUDIT_EVENT_SOURCE,
			payload: TOOL_INVOCATION_AUDIT_SUMMARY,
		});
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps tool invocation audit batch summaries with stable record fields and serializable payload", () => {
		const record = buildToolInvocationAuditBatchEventRecord(
			TOOL_INVOCATION_AUDIT_BATCH_SUMMARY,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: TOOL_INVOCATION_AUDIT_BATCH_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: TOOL_INVOCATION_AUDIT_BATCH_EVENT_SOURCE,
			payload: TOOL_INVOCATION_AUDIT_BATCH_SUMMARY,
		});
		expect(TOOL_INVOCATION_AUDIT_BATCH_EVENT_KIND).toBe(
			"tool_invocation_audit_batch_summary",
		);
		expect(TOOL_INVOCATION_AUDIT_BATCH_EVENT_SOURCE).toBe(
			"agent-core.tools.router",
		);
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps tool result audit batch summaries with stable record fields and preserved missing audit result identifiers", () => {
		const record = buildToolResultAuditBatchEventRecord(
			TOOL_RESULT_AUDIT_BATCH_SUMMARY,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: TOOL_RESULT_AUDIT_BATCH_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: TOOL_RESULT_AUDIT_BATCH_EVENT_SOURCE,
			payload: TOOL_RESULT_AUDIT_BATCH_SUMMARY,
		});
		expect(TOOL_RESULT_AUDIT_BATCH_EVENT_KIND).toBe(
			"tool_result_audit_batch_summary",
		);
		expect(TOOL_RESULT_AUDIT_BATCH_EVENT_SOURCE).toBe(
			"agent-core.tools.router.result-audit",
		);
		expect(TOOL_RESULT_AUDIT_BATCH_EVENT_KIND).not.toBe(
			TOOL_INVOCATION_AUDIT_BATCH_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_BATCH_EVENT_SOURCE).not.toBe(
			TOOL_INVOCATION_AUDIT_BATCH_EVENT_SOURCE,
		);
		expect(record.payload.missingAuditResultIds).toEqual([
			"call-missing-a",
			"call-missing-z",
		]);
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps tool result audit readiness summaries with stable record fields and preserved status", () => {
		const record = buildToolResultAuditReadinessEventRecord(
			TOOL_RESULT_AUDIT_READINESS_SUMMARY,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: TOOL_RESULT_AUDIT_READINESS_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE,
			payload: TOOL_RESULT_AUDIT_READINESS_SUMMARY,
		});
		expect(TOOL_RESULT_AUDIT_READINESS_EVENT_KIND).toBe(
			"tool_result_audit_readiness_summary",
		);
		expect(TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE).toBe(
			"agent-core.tools.router.result-audit",
		);
		expect(record.payload.status).toBe("partial");
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps full tool result audit reports with stable record fields and preserved sections", () => {
		const record = buildToolResultAuditReportEventRecord(
			TOOL_RESULT_AUDIT_REPORT,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: TOOL_RESULT_AUDIT_REPORT_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE,
			payload: TOOL_RESULT_AUDIT_REPORT,
		});
		expect(TOOL_RESULT_AUDIT_REPORT_EVENT_KIND).toBe(
			"tool_result_audit_report",
		);
		expect(TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE).toBe(
			"agent-core.tools.router.result-audit.report",
		);
		expect(TOOL_RESULT_AUDIT_REPORT_EVENT_KIND).not.toBe(
			TOOL_RESULT_AUDIT_BATCH_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_EVENT_KIND).not.toBe(
			TOOL_RESULT_AUDIT_READINESS_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE).not.toBe(
			TOOL_RESULT_AUDIT_BATCH_EVENT_SOURCE,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE).not.toBe(
			TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE,
		);
		expect(record.payload.audit).toEqual(TOOL_RESULT_AUDIT_BATCH_SUMMARY);
		expect(record.payload.readiness).toEqual(
			TOOL_RESULT_AUDIT_READINESS_SUMMARY,
		);
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps tool result audit report health summaries with distinct record fields and preserved status", () => {
		const record = buildToolResultAuditReportHealthEventRecord(
			TOOL_RESULT_AUDIT_REPORT_HEALTH_SUMMARY,
			{
				timestamp: new Date(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE,
			payload: TOOL_RESULT_AUDIT_REPORT_HEALTH_SUMMARY,
		});
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND).toBe(
			"tool_result_audit_report_health_summary",
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE).toBe(
			"agent-core.tools.router.result-audit.report-health",
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND).not.toBe(
			TOOL_RESULT_AUDIT_REPORT_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND).not.toBe(
			TOOL_RESULT_AUDIT_READINESS_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE).not.toBe(
			TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE).not.toBe(
			TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE,
		);
		expect(record.payload.status).toBe("blocked");
		expect(record.payload.missingTotal).toBe(2);
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps tool result audit report health batch summaries with distinct record fields and preserved counters", () => {
		const record = buildToolResultAuditReportHealthBatchEventRecord(
			TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_SUMMARY,
			{
				timestamp: Date.parse(TEST_TIMESTAMP),
			},
		);

		expect(record).toEqual({
			kind: TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE,
			payload: TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_SUMMARY,
		});
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND).toBe(
			"tool_result_audit_report_health_batch_summary",
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE).toBe(
			"agent-core.tools.router.result-audit.report-health-batch",
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND).not.toBe(
			TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND).not.toBe(
			TOOL_RESULT_AUDIT_REPORT_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND).not.toBe(
			TOOL_RESULT_AUDIT_READINESS_EVENT_KIND,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE).not.toBe(
			TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE).not.toBe(
			TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE,
		);
		expect(TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE).not.toBe(
			TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE,
		);
		expect(record.payload.status).toBe("failed");
		expect(record.payload.byStatus).toEqual({
			clean: 2,
			blocked: 1,
			incomplete: 1,
			failed: 1,
		});
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("wraps component health payloads with stable record and payload identity fields", () => {
		const record = buildComponentHealthEventRecord(COMPONENT_HEALTH_PAYLOAD, {
			timestamp: new Date(TEST_TIMESTAMP),
		});

		expect(record).toEqual({
			kind: COMPONENT_HEALTH_EVENT_KIND,
			timestamp: TEST_TIMESTAMP,
			source: COMPONENT_HEALTH_EVENT_SOURCE,
			payload: COMPONENT_HEALTH_PAYLOAD,
		});
		expect(record.payload.component).toBe("skills.manifest");
		expect(record.payload.source).toBe("agent-core.skills.manifest");
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("does not require raw or parsed tool arguments for tool invocation audit records", () => {
		const record = buildToolInvocationAuditEventRecord(
			{
				tool: "memory_store",
				call: "call-safe-summary",
				outcome: "success",
				summary: "Tool memory_store completed successfully.",
				detail: "tool=memory_store; call=call-safe-summary; outcome=success",
			},
			{ timestamp: TEST_TIMESTAMP },
		);

		expect(record.payload).toEqual({
			tool: "memory_store",
			call: "call-safe-summary",
			outcome: "success",
			summary: "Tool memory_store completed successfully.",
			detail: "tool=memory_store; call=call-safe-summary; outcome=success",
		});
		expect(JSON.stringify(record)).not.toContain("rawArguments");
		expect(JSON.stringify(record)).not.toContain("parsedArguments");
	});

	it("normalizes unknown event kinds with nested payloads into deterministic JSON records", () => {
		const payload = {
			message: "custom probe",
			nested: {
				flags: [true, false, null],
				counts: [1, 2, 3],
				metadata: {
					route: "observability.event-record",
					retryable: false,
				},
			},
		};

		const firstRecord = buildObservabilityEventRecord({
			kind: "custom_probe",
			source: "agent-core.test",
			timestamp: new Date(TEST_TIMESTAMP),
			payload,
		});
		const secondRecord = buildObservabilityEventRecord({
			kind: "custom_probe",
			source: "agent-core.test",
			timestamp: Date.parse(TEST_TIMESTAMP),
			payload,
		});

		expect(firstRecord).toEqual(secondRecord);
		expect(firstRecord).toEqual({
			kind: "custom_probe",
			timestamp: TEST_TIMESTAMP,
			source: "agent-core.test",
			payload,
		});
		expect(serializeRoundTrip(firstRecord)).toEqual(firstRecord);
	});

	it("redacts secret-like strings in observability event payloads", () => {
		const record = buildObservabilityEventRecord({
			kind: "custom_probe",
			source: "agent-core.test",
			timestamp: TEST_TIMESTAMP,
			payload: {
				summary:
					"email alpha@example.com token AKIAIOSFODNN7EXAMPLE path /Users/alice/.config/gcloud/application_default_credentials.json",
				nested: {
					authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345",
					currentStep:
						"JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
				},
			},
		});
		const serialized = JSON.stringify(record);

		expect(record.payload).toEqual({
			summary:
				"email [REDACTED:email] token [REDACTED:aws_access_key] path [REDACTED:sensitive_path]",
			nested: {
				authorization: "[REDACTED]",
				currentStep: "JWT [REDACTED:jwt]",
			},
		});
		expect(serialized).not.toContain("alpha@example.com");
		expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(serialized).not.toContain("application_default_credentials");
		expect(serialized).not.toContain("abcdefghijklmnop");
	});

	it("clones nested objects and arrays instead of exposing raw payload references", () => {
		const payload = {
			nested: {
				values: ["original"],
				child: {
					status: "clean",
				},
			},
		};

		const record = buildObservabilityEventRecord({
			kind: "reference_probe",
			source: "agent-core.test",
			timestamp: TEST_TIMESTAMP,
			payload,
		});

		payload.nested.values.push("mutated");
		payload.nested.child.status = "mutated";

		expect(record.payload).toEqual({
			nested: {
				values: ["original"],
				child: {
					status: "clean",
				},
			},
		});
		expect(serializeRoundTrip(record)).toEqual(record);
	});

	it("rejects invalid timestamps and malformed event kinds before record emission", () => {
		expect(() =>
			buildObservabilityEventRecord({
				kind: "invalid_timestamp",
				source: "agent-core.test",
				timestamp: "not-a-timestamp",
				payload: {},
			}),
		).toThrow("Invalid observability event timestamp");

		expect(() =>
			buildObservabilityEventRecord({
				kind: "invalid_timestamp",
				source: "agent-core.test",
				timestamp: Number.NaN,
				payload: {},
			}),
		).toThrow("Invalid observability event timestamp");

		expect(() =>
			buildObservabilityEventRecord({
				kind: "CustomProbe",
				source: "agent-core.test",
				timestamp: TEST_TIMESTAMP,
				payload: {},
			}),
		).toThrow("Invalid observability event kind");
	});

	it("rejects non-JSON event payload values before exporter handoff", () => {
		expect(() =>
			buildObservabilityEventRecord({
				kind: "bad_payload",
				source: "agent-core.test",
				timestamp: TEST_TIMESTAMP,
				payload: { invalid: Number.NaN },
			}),
		).toThrow("Non-finite observability event payload value");

		expect(() =>
			buildObservabilityEventRecord({
				kind: "bad_payload",
				source: "agent-core.test",
				timestamp: TEST_TIMESTAMP,
				payload: { invalid: [Number.POSITIVE_INFINITY] },
			}),
		).toThrow("Non-finite observability event payload value");

		expect(() =>
			buildObservabilityEventRecord({
				kind: "bad_payload",
				source: "agent-core.test",
				timestamp: TEST_TIMESTAMP,
				payload: { invalid: undefined },
			}),
		).toThrow("Non-serializable observability event payload value");
	});

	it("rejects invalid supervisor progress flush payloads before exporter handoff", () => {
		expect(() =>
			buildSupervisorProgressFlushEventRecord(["not", "an", "object"], {
				timestamp: TEST_TIMESTAMP,
			}),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildSupervisorProgressFlushEventRecord(
				{
					events: [
						{
							id: "event-with-date",
							occurredAt: new Date(TEST_TIMESTAMP),
						},
					],
				},
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-serializable observability event payload value");
	});

	it("rejects invalid tool invocation audit payloads before exporter handoff", () => {
		expect(() =>
			buildToolInvocationAuditEventRecord(["not", "an", "object"] as never, {
				timestamp: TEST_TIMESTAMP,
			}),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildToolInvocationAuditEventRecord(
				{
					...TOOL_INVOCATION_AUDIT_SUMMARY,
					detail: Number.POSITIVE_INFINITY,
				} as never,
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});

	it("rejects invalid tool invocation audit batch payloads before exporter handoff", () => {
		expect(() =>
			buildToolInvocationAuditBatchEventRecord(
				["not", "an", "object"] as never,
				{
					timestamp: TEST_TIMESTAMP,
				},
			),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildToolInvocationAuditBatchEventRecord(
				{
					...TOOL_INVOCATION_AUDIT_BATCH_SUMMARY,
					byOutcome: {
						...TOOL_INVOCATION_AUDIT_BATCH_SUMMARY.byOutcome,
						success: Number.POSITIVE_INFINITY,
					},
				} as never,
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});

	it("rejects invalid tool result audit batch payloads before exporter handoff", () => {
		expect(() =>
			buildToolResultAuditBatchEventRecord(["not", "an", "object"] as never, {
				timestamp: TEST_TIMESTAMP,
			}),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildToolResultAuditBatchEventRecord(
				{
					...TOOL_RESULT_AUDIT_BATCH_SUMMARY,
					missingAuditResultIds: [Number.POSITIVE_INFINITY],
				} as never,
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});

	it("rejects invalid tool result audit readiness payloads before exporter handoff", () => {
		expect(() =>
			buildToolResultAuditReadinessEventRecord(
				["not", "an", "object"] as never,
				{
					timestamp: TEST_TIMESTAMP,
				},
			),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildToolResultAuditReadinessEventRecord(
				{
					...TOOL_RESULT_AUDIT_READINESS_SUMMARY,
					missingTotal: Number.NaN,
				} as never,
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});

	it("rejects invalid full tool result audit report payloads before exporter handoff", () => {
		expect(() =>
			buildToolResultAuditReportEventRecord(["not", "an", "object"] as never, {
				timestamp: TEST_TIMESTAMP,
			}),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildToolResultAuditReportEventRecord(
				{
					...TOOL_RESULT_AUDIT_REPORT,
					readiness: {
						...TOOL_RESULT_AUDIT_REPORT.readiness,
						total: Number.POSITIVE_INFINITY,
					},
				} as never,
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});

	it("rejects invalid tool result audit report health payloads before exporter handoff", () => {
		expect(() =>
			buildToolResultAuditReportHealthEventRecord(
				["not", "an", "object"] as never,
				{
					timestamp: TEST_TIMESTAMP,
				},
			),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildToolResultAuditReportHealthEventRecord(
				{
					...TOOL_RESULT_AUDIT_REPORT_HEALTH_SUMMARY,
					failedTotal: Number.NaN,
				} as never,
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});

	it("rejects invalid tool result audit report health batch payloads before exporter handoff", () => {
		expect(() =>
			buildToolResultAuditReportHealthBatchEventRecord(
				["not", "an", "object"] as never,
				{
					timestamp: TEST_TIMESTAMP,
				},
			),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildToolResultAuditReportHealthBatchEventRecord(
				{
					...TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_SUMMARY,
					byStatus: {
						...TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_SUMMARY.byStatus,
						failed: Number.NaN,
					},
				} as never,
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});

	it("rejects invalid component health payloads before exporter handoff", () => {
		expect(() =>
			buildComponentHealthEventRecord(["not", "an", "object"], {
				timestamp: TEST_TIMESTAMP,
			}),
		).toThrow("Observability event payload must be an object");

		expect(() =>
			buildComponentHealthEventRecord(
				{
					...COMPONENT_HEALTH_PAYLOAD,
					component: "",
				},
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow(
			"Component health event payload component must be a non-empty string",
		);

		expect(() =>
			buildComponentHealthEventRecord(
				{
					...COMPONENT_HEALTH_PAYLOAD,
					source: "",
				},
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow(
			"Component health event payload source must be a non-empty string",
		);

		expect(() =>
			buildComponentHealthEventRecord(
				{
					...COMPONENT_HEALTH_PAYLOAD,
					summary: {
						total: Number.NaN,
					},
				},
				{ timestamp: TEST_TIMESTAMP },
			),
		).toThrow("Non-finite observability event payload value");
	});
});
