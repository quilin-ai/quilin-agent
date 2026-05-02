import {
	buildRuntimeReloadAuditEvent,
	type RuntimeReloadAuditEvent,
	type RuntimeReloadAuditEventInput,
} from "../config/runtime.js";
import type {
	ContextCachePlan,
	ContextTraceSummary,
} from "../context/draft/source-types.js";
import type { ContextTraceDelta } from "../context/draft/trace-delta.js";
import { redactJsonLikeValue } from "../safety/redaction.js";
import type {
	ToolInvocationAuditBatchSummary,
	ToolInvocationAuditSummary,
	ToolResultAuditBatchSummary,
	ToolResultAuditReadinessSummary,
	ToolResultAuditReport,
	ToolResultAuditReportHealthBatchSummary,
	ToolResultAuditReportHealthSummary,
} from "../tools/types.js";

export type ObservabilityJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly ObservabilityJsonValue[]
	| { readonly [key: string]: ObservabilityJsonValue };

export type ObservabilityEventPayload = {
	readonly [key: string]: ObservabilityJsonValue;
};

export interface ObservabilityEventRecord<
	TKind extends string = string,
	TPayload extends ObservabilityEventPayload = ObservabilityEventPayload,
> {
	readonly kind: TKind;
	readonly timestamp: string;
	readonly source: string;
	readonly payload: TPayload;
}

export type ObservabilityEventTimestamp = Date | number | string;

export interface BuildObservabilityEventRecordInput<TKind extends string> {
	readonly kind: TKind;
	readonly timestamp: ObservabilityEventTimestamp;
	readonly source: string;
	readonly payload: unknown;
}

export interface ObservabilityEventAdapterOptions {
	readonly timestamp: ObservabilityEventTimestamp;
}

export type RuntimeReloadAuditEventRecordInput =
	| RuntimeReloadAuditEvent
	| RuntimeReloadAuditEventInput;

export type ComponentHealthEventPayload = ObservabilityEventPayload & {
	readonly component: string;
	readonly source: string;
};

export const RUNTIME_RELOAD_AUDIT_EVENT_KIND =
	"user_runtime_reload_audit" as const;
export const RUNTIME_RELOAD_AUDIT_EVENT_SOURCE =
	"agent-core.config.runtime" as const;
export const CONTEXT_TRACE_SUMMARY_EVENT_KIND =
	"context_trace_summary" as const;
export const CONTEXT_TRACE_SUMMARY_EVENT_SOURCE =
	"agent-core.context.draft.context-assembler" as const;
export const CONTEXT_CACHE_PLAN_EVENT_KIND = "context_cache_plan" as const;
export const CONTEXT_CACHE_PLAN_EVENT_SOURCE =
	"agent-core.context.draft.cache-plan" as const;
export const CONTEXT_TRACE_DELTA_EVENT_KIND = "context_trace_delta" as const;
export const CONTEXT_TRACE_DELTA_EVENT_SOURCE =
	"agent-core.context.draft.trace-delta" as const;
export const SUPERVISOR_PROGRESS_FLUSH_EVENT_KIND =
	"supervisor_progress_flush" as const;
export const SUPERVISOR_PROGRESS_FLUSH_EVENT_SOURCE =
	"agent-core.multi-agent.supervisor-progress" as const;
export const TOOL_INVOCATION_AUDIT_EVENT_KIND =
	"tool_invocation_audit" as const;
export const TOOL_INVOCATION_AUDIT_EVENT_SOURCE =
	"agent-core.tools.router" as const;
export const TOOL_INVOCATION_AUDIT_BATCH_EVENT_KIND =
	"tool_invocation_audit_batch_summary" as const;
export const TOOL_INVOCATION_AUDIT_BATCH_EVENT_SOURCE =
	"agent-core.tools.router" as const;
export const TOOL_RESULT_AUDIT_BATCH_EVENT_KIND =
	"tool_result_audit_batch_summary" as const;
export const TOOL_RESULT_AUDIT_BATCH_EVENT_SOURCE =
	"agent-core.tools.router.result-audit" as const;
export const TOOL_RESULT_AUDIT_READINESS_EVENT_KIND =
	"tool_result_audit_readiness_summary" as const;
export const TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE =
	"agent-core.tools.router.result-audit" as const;
export const TOOL_RESULT_AUDIT_REPORT_EVENT_KIND =
	"tool_result_audit_report" as const;
export const TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE =
	"agent-core.tools.router.result-audit.report" as const;
export const TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND =
	"tool_result_audit_report_health_summary" as const;
export const TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE =
	"agent-core.tools.router.result-audit.report-health" as const;
export const TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND =
	"tool_result_audit_report_health_batch_summary" as const;
export const TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE =
	"agent-core.tools.router.result-audit.report-health-batch" as const;
export const COMPONENT_HEALTH_EVENT_KIND = "component_health" as const;
export const COMPONENT_HEALTH_EVENT_SOURCE =
	"agent-core.observability.component-health" as const;

function normalizeTimestamp(timestamp: ObservabilityEventTimestamp): string {
	const date =
		timestamp instanceof Date
			? timestamp
			: typeof timestamp === "number"
				? new Date(timestamp)
				: new Date(timestamp);

	if (!Number.isFinite(date.getTime())) {
		throw new Error("Invalid observability event timestamp");
	}

	return date.toISOString();
}

function validateKind(kind: string): void {
	if (!/^[a-z][a-z0-9_]*$/.test(kind)) {
		throw new Error(`Invalid observability event kind: ${kind}`);
	}
}

function validateSource(source: string): void {
	if (!/^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/.test(source)) {
		throw new Error(`Invalid observability event source: ${source}`);
	}
}

function isPlainObject(
	value: unknown,
): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function toJsonValue(value: unknown, path: string): ObservabilityJsonValue {
	if (value === null) {
		return null;
	}

	if (typeof value === "string" || typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`Non-finite observability event payload value: ${path}`);
		}
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item, index) => toJsonValue(item, `${path}[${index}]`));
	}

	if (isPlainObject(value)) {
		const record: Record<string, ObservabilityJsonValue> = {};
		for (const [key, item] of Object.entries(value)) {
			record[key] = toJsonValue(item, `${path}.${key}`);
		}
		return record;
	}

	throw new Error(
		`Non-serializable observability event payload value: ${path}`,
	);
}

function toJsonPayload(payload: unknown): ObservabilityEventPayload {
	const jsonValue = toJsonValue(payload, "payload");
	const redactedJsonValue = redactJsonLikeValue(jsonValue);
	if (!isPlainObject(redactedJsonValue)) {
		throw new Error("Observability event payload must be an object");
	}
	return redactedJsonValue as ObservabilityEventPayload;
}

function isRuntimeReloadAuditEvent(
	input: RuntimeReloadAuditEventRecordInput,
): input is RuntimeReloadAuditEvent {
	return "event" in input && input.event === RUNTIME_RELOAD_AUDIT_EVENT_KIND;
}

function validateComponentHealthPayload(
	payload: ObservabilityEventPayload,
): asserts payload is ComponentHealthEventPayload {
	if (typeof payload.component !== "string" || payload.component.length === 0) {
		throw new Error(
			"Component health event payload component must be a non-empty string",
		);
	}

	if (typeof payload.source !== "string" || payload.source.length === 0) {
		throw new Error(
			"Component health event payload source must be a non-empty string",
		);
	}
}

export function buildObservabilityEventRecord<TKind extends string>(
	input: BuildObservabilityEventRecordInput<TKind>,
): ObservabilityEventRecord<TKind> {
	validateKind(input.kind);
	validateSource(input.source);

	return {
		kind: input.kind,
		timestamp: normalizeTimestamp(input.timestamp),
		source: input.source,
		payload: toJsonPayload(input.payload),
	};
}

export function buildRuntimeReloadAuditEventRecord(
	input: RuntimeReloadAuditEventRecordInput,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof RUNTIME_RELOAD_AUDIT_EVENT_KIND> {
	const payload = isRuntimeReloadAuditEvent(input)
		? input
		: buildRuntimeReloadAuditEvent(input);
	return buildObservabilityEventRecord({
		kind: RUNTIME_RELOAD_AUDIT_EVENT_KIND,
		source: RUNTIME_RELOAD_AUDIT_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildContextTraceSummaryEventRecord(
	payload: ContextTraceSummary,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof CONTEXT_TRACE_SUMMARY_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: CONTEXT_TRACE_SUMMARY_EVENT_KIND,
		source: CONTEXT_TRACE_SUMMARY_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildContextCachePlanEventRecord(
	payload: ContextCachePlan,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof CONTEXT_CACHE_PLAN_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: CONTEXT_CACHE_PLAN_EVENT_KIND,
		source: CONTEXT_CACHE_PLAN_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildContextTraceDeltaEventRecord(
	payload: ContextTraceDelta,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof CONTEXT_TRACE_DELTA_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: CONTEXT_TRACE_DELTA_EVENT_KIND,
		source: CONTEXT_TRACE_DELTA_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildSupervisorProgressFlushEventRecord(
	payload: unknown,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof SUPERVISOR_PROGRESS_FLUSH_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: SUPERVISOR_PROGRESS_FLUSH_EVENT_KIND,
		source: SUPERVISOR_PROGRESS_FLUSH_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildToolInvocationAuditEventRecord(
	payload: ToolInvocationAuditSummary,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof TOOL_INVOCATION_AUDIT_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: TOOL_INVOCATION_AUDIT_EVENT_KIND,
		source: TOOL_INVOCATION_AUDIT_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildToolInvocationAuditBatchEventRecord(
	payload: ToolInvocationAuditBatchSummary,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof TOOL_INVOCATION_AUDIT_BATCH_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: TOOL_INVOCATION_AUDIT_BATCH_EVENT_KIND,
		source: TOOL_INVOCATION_AUDIT_BATCH_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildToolResultAuditBatchEventRecord(
	payload: ToolResultAuditBatchSummary,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof TOOL_RESULT_AUDIT_BATCH_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: TOOL_RESULT_AUDIT_BATCH_EVENT_KIND,
		source: TOOL_RESULT_AUDIT_BATCH_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildToolResultAuditReadinessEventRecord(
	payload: ToolResultAuditReadinessSummary,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof TOOL_RESULT_AUDIT_READINESS_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: TOOL_RESULT_AUDIT_READINESS_EVENT_KIND,
		source: TOOL_RESULT_AUDIT_READINESS_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildToolResultAuditReportEventRecord(
	payload: ToolResultAuditReport,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof TOOL_RESULT_AUDIT_REPORT_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: TOOL_RESULT_AUDIT_REPORT_EVENT_KIND,
		source: TOOL_RESULT_AUDIT_REPORT_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildToolResultAuditReportHealthEventRecord(
	payload: ToolResultAuditReportHealthSummary,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<typeof TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND> {
	return buildObservabilityEventRecord({
		kind: TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_KIND,
		source: TOOL_RESULT_AUDIT_REPORT_HEALTH_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildToolResultAuditReportHealthBatchEventRecord(
	payload: ToolResultAuditReportHealthBatchSummary,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<
	typeof TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND
> {
	return buildObservabilityEventRecord({
		kind: TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_KIND,
		source: TOOL_RESULT_AUDIT_REPORT_HEALTH_BATCH_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
}

export function buildComponentHealthEventRecord(
	payload: unknown,
	options: ObservabilityEventAdapterOptions,
): ObservabilityEventRecord<
	typeof COMPONENT_HEALTH_EVENT_KIND,
	ComponentHealthEventPayload
> {
	const record = buildObservabilityEventRecord({
		kind: COMPONENT_HEALTH_EVENT_KIND,
		source: COMPONENT_HEALTH_EVENT_SOURCE,
		timestamp: options.timestamp,
		payload,
	});
	const componentPayload = record.payload;
	validateComponentHealthPayload(componentPayload);

	return {
		kind: record.kind,
		timestamp: record.timestamp,
		source: record.source,
		payload: componentPayload,
	};
}
