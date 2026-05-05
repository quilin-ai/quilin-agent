import {
	type PlannerRoutingDecision,
	validatePlannerRoutingDecision,
} from "./planner-routing.js";

export const SUPERVISOR_HANDOFF_PLAN_SCHEMA_VERSION = 1;
export const CROSS_PROCESS_ROUTE_DECISION_SCHEMA_VERSION = 1;

export type SupervisorHandoffKind =
	| "in_process"
	| "local_process"
	| "mesh_deferred";

export type SupervisorHandoffHistoryFilter =
	| "full"
	| "summary"
	| "task_only"
	| "custom";

export interface SupervisorHandoffPlan {
	readonly schemaVersion: typeof SUPERVISOR_HANDOFF_PLAN_SCHEMA_VERSION;
	readonly handoffKind: SupervisorHandoffKind;
	readonly receiverCapability: string;
	readonly inputSchemaRef: string;
	readonly inputPayloadRef: string;
	readonly historyFilter: SupervisorHandoffHistoryFilter;
	readonly writeScope: readonly string[];
	readonly retryPolicyRef: string;
	readonly cancellationPolicyRef: string;
	readonly resultSchemaRef: string;
	readonly traceId: string;
}

export interface BuildSupervisorHandoffPlanInput {
	readonly routingDecision: PlannerRoutingDecision;
	readonly handoffKind?: SupervisorHandoffKind;
	readonly receiverCapability: string;
	readonly inputSchemaRef: string;
	readonly inputPayloadRef: string;
	readonly historyFilter?: SupervisorHandoffHistoryFilter;
	readonly writeScope: readonly string[];
	readonly retryPolicyRef: string;
	readonly cancellationPolicyRef: string;
	readonly resultSchemaRef: string;
	readonly traceId?: string;
}

export type CrossProcessRouteMode =
	| "in_process"
	| "local_process"
	| "remote_mesh";

export type CrossProcessDeniedReason =
	| "mesh_deferred"
	| "missing_trust"
	| "missing_observability"
	| "budget_blocked";

export interface CrossProcessRouteRequest {
	readonly mode: CrossProcessRouteMode;
	readonly processTarget?: string;
	readonly timeoutMs: number;
	readonly traceId: string;
	readonly budgetBlocked?: boolean;
	readonly trustReady?: boolean;
	readonly observabilityReady?: boolean;
}

export interface CrossProcessRouteDecision {
	readonly schemaVersion: typeof CROSS_PROCESS_ROUTE_DECISION_SCHEMA_VERSION;
	readonly mode: CrossProcessRouteMode;
	readonly allowed: boolean;
	readonly deniedReason?: CrossProcessDeniedReason;
	readonly processTarget?: string;
	readonly timeoutMs: number;
	readonly traceId: string;
}

const SUPERVISOR_HANDOFF_KINDS = new Set<SupervisorHandoffKind>([
	"in_process",
	"local_process",
	"mesh_deferred",
]);

const SUPERVISOR_HANDOFF_HISTORY_FILTERS =
	new Set<SupervisorHandoffHistoryFilter>([
		"full",
		"summary",
		"task_only",
		"custom",
	]);

const CROSS_PROCESS_ROUTE_MODES = new Set<CrossProcessRouteMode>([
	"in_process",
	"local_process",
	"remote_mesh",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(
	value: unknown,
	name: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) {
		throw new TypeError(`${name} must be an object`);
	}
}

function assertNonEmptyString(value: string, name: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new RangeError(`${name} must be a non-empty string`);
	}
}

function assertBoolean(value: boolean | undefined, name: string): void {
	if (value != null && typeof value !== "boolean") {
		throw new TypeError(`${name} must be a boolean`);
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive integer`);
	}
}

function assertKnownHandoffKind(value: unknown, name: string): void {
	if (!SUPERVISOR_HANDOFF_KINDS.has(value as SupervisorHandoffKind)) {
		throw new RangeError(`${name} must be a known supervisor handoff kind`);
	}
}

function assertKnownHistoryFilter(value: unknown, name: string): void {
	if (
		!SUPERVISOR_HANDOFF_HISTORY_FILTERS.has(
			value as SupervisorHandoffHistoryFilter,
		)
	) {
		throw new RangeError(`${name} must be a known handoff history filter`);
	}
}

function assertKnownCrossProcessMode(value: unknown, name: string): void {
	if (!CROSS_PROCESS_ROUTE_MODES.has(value as CrossProcessRouteMode)) {
		throw new RangeError(`${name} must be a known cross-process route mode`);
	}
}

function assertStringArray(value: unknown, name: string): void {
	if (!Array.isArray(value)) {
		throw new TypeError(`${name} must be an array`);
	}
	for (const [index, item] of value.entries()) {
		assertNonEmptyString(item, `${name}[${index}]`);
	}
}

export function validateSupervisorHandoffPlan(
	plan: unknown,
): asserts plan is SupervisorHandoffPlan {
	assertRecord(plan, "plan");
	if (plan.schemaVersion !== SUPERVISOR_HANDOFF_PLAN_SCHEMA_VERSION) {
		throw new RangeError(
			`plan.schemaVersion must be ${SUPERVISOR_HANDOFF_PLAN_SCHEMA_VERSION}`,
		);
	}
	assertKnownHandoffKind(plan.handoffKind, "plan.handoffKind");
	assertNonEmptyString(
		plan.receiverCapability as string,
		"plan.receiverCapability",
	);
	assertNonEmptyString(plan.inputSchemaRef as string, "plan.inputSchemaRef");
	assertNonEmptyString(plan.inputPayloadRef as string, "plan.inputPayloadRef");
	assertKnownHistoryFilter(plan.historyFilter, "plan.historyFilter");
	assertStringArray(plan.writeScope, "plan.writeScope");
	assertNonEmptyString(plan.retryPolicyRef as string, "plan.retryPolicyRef");
	assertNonEmptyString(
		plan.cancellationPolicyRef as string,
		"plan.cancellationPolicyRef",
	);
	assertNonEmptyString(plan.resultSchemaRef as string, "plan.resultSchemaRef");
	assertNonEmptyString(plan.traceId as string, "plan.traceId");
}

export function parseSupervisorHandoffPlan(
	input: unknown,
): SupervisorHandoffPlan {
	validateSupervisorHandoffPlan(input);
	return input;
}

export function buildSupervisorHandoffPlan(
	input: BuildSupervisorHandoffPlanInput,
): SupervisorHandoffPlan {
	assertRecord(input, "input");
	validatePlannerRoutingDecision(input.routingDecision);
	if (!input.routingDecision.requiresSupervisor) {
		throw new RangeError(
			"routingDecision.requiresSupervisor must be true to build a supervisor handoff plan",
		);
	}
	if (
		input.traceId != null &&
		input.traceId !== input.routingDecision.traceId
	) {
		throw new RangeError("input.traceId must match routingDecision.traceId");
	}

	const plan: SupervisorHandoffPlan = {
		schemaVersion: SUPERVISOR_HANDOFF_PLAN_SCHEMA_VERSION,
		handoffKind: input.handoffKind ?? "in_process",
		receiverCapability: input.receiverCapability,
		inputSchemaRef: input.inputSchemaRef,
		inputPayloadRef: input.inputPayloadRef,
		historyFilter: input.historyFilter ?? "task_only",
		writeScope: [...input.writeScope],
		retryPolicyRef: input.retryPolicyRef,
		cancellationPolicyRef: input.cancellationPolicyRef,
		resultSchemaRef: input.resultSchemaRef,
		traceId: input.traceId ?? input.routingDecision.traceId,
	};
	return parseSupervisorHandoffPlan(plan);
}

export function decideCrossProcessRoute(
	request: CrossProcessRouteRequest,
): CrossProcessRouteDecision {
	assertRecord(request, "request");
	assertKnownCrossProcessMode(request.mode, "request.mode");
	assertPositiveInteger(request.timeoutMs, "request.timeoutMs");
	assertNonEmptyString(request.traceId, "request.traceId");
	assertBoolean(request.budgetBlocked, "request.budgetBlocked");
	assertBoolean(request.trustReady, "request.trustReady");
	assertBoolean(request.observabilityReady, "request.observabilityReady");

	if (request.mode === "remote_mesh") {
		return {
			schemaVersion: CROSS_PROCESS_ROUTE_DECISION_SCHEMA_VERSION,
			mode: "remote_mesh",
			allowed: false,
			deniedReason: "mesh_deferred",
			...(request.processTarget == null
				? {}
				: { processTarget: request.processTarget }),
			timeoutMs: request.timeoutMs,
			traceId: request.traceId,
		};
	}

	if (request.budgetBlocked === true) {
		return {
			schemaVersion: CROSS_PROCESS_ROUTE_DECISION_SCHEMA_VERSION,
			mode: request.mode,
			allowed: false,
			deniedReason: "budget_blocked",
			...(request.processTarget == null
				? {}
				: { processTarget: request.processTarget }),
			timeoutMs: request.timeoutMs,
			traceId: request.traceId,
		};
	}

	if (request.mode === "local_process") {
		assertNonEmptyString(request.processTarget ?? "", "request.processTarget");
	}

	return {
		schemaVersion: CROSS_PROCESS_ROUTE_DECISION_SCHEMA_VERSION,
		mode: request.mode,
		allowed: true,
		...(request.processTarget == null
			? {}
			: { processTarget: request.processTarget }),
		timeoutMs: request.timeoutMs,
		traceId: request.traceId,
	};
}
