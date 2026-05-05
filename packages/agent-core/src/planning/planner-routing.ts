export type PlannerRoute =
	| "simple_answer"
	| "single_tool"
	| "multi_step_linear"
	| "multi_step_parallel"
	| "clarification"
	| "supervisor_required"
	| "deferred_due_to_budget";

export type PlannerRoutingStrategy = "cot" | "react" | "plan_and_execute";

export type PlannerRoutingRiskTier =
	| "read_only"
	| "ask_on_write"
	| "auto_opt_in"
	| "critical";

export type PlannerRoutingReasonCode =
	| "needs_clarification"
	| "budget_token_exhausted"
	| "budget_turn_exhausted"
	| "risk_critical_supervisor"
	| "tool_call_count_requires_supervisor"
	| "capability_count_requires_supervisor"
	| "plan_sketch_present"
	| "multiple_capabilities_parallel"
	| "multiple_tool_calls_linear"
	| "single_tool_call"
	| "no_tool_or_plan_simple_answer";

export interface PlannerRoutingRequest {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly userGoal: string;
	readonly structuralSignals: {
		readonly hasToolCalls: boolean;
		readonly toolCallCount: number;
		readonly hasPlanSketch: boolean;
		readonly needsClarification: boolean;
	};
	readonly budget: {
		readonly tokenRemaining: number;
		readonly turnRemaining: number;
		readonly spendCapUsd?: number;
	};
	readonly capabilitiesRequired: readonly string[];
	readonly riskTier: PlannerRoutingRiskTier;
	readonly traceId: string;
}

export interface PlannerRoutingDecision {
	readonly schemaVersion: 1;
	readonly route: PlannerRoute;
	readonly strategy: PlannerRoutingStrategy;
	readonly requiresSupervisor: boolean;
	readonly requiresProviderRoute: boolean;
	readonly requiresHandoffEnvelope: boolean;
	readonly reasonCodes: readonly PlannerRoutingReasonCode[];
	readonly traceId: string;
}

export interface PlannerRoutingPolicy {
	readonly supervisorToolCallThreshold?: number;
	readonly supervisorCapabilityThreshold?: number;
}

interface PlannerRouteSelection {
	readonly route: PlannerRoute;
	readonly reasonCodes: readonly PlannerRoutingReasonCode[];
}

const DEFAULT_SUPERVISOR_TOOL_CALL_THRESHOLD = 3;
const DEFAULT_SUPERVISOR_CAPABILITY_THRESHOLD = 3;

const PLANNER_ROUTING_RISK_TIERS = new Set<PlannerRoutingRiskTier>([
	"read_only",
	"ask_on_write",
	"auto_opt_in",
	"critical",
]);

function assertNever(value: never): never {
	throw new Error(`Unexpected planner routing value: ${String(value)}`);
}

function assertNonEmptyString(value: string, name: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new RangeError(`${name} must be a non-empty string`);
	}
}

function assertBoolean(value: boolean, name: string): void {
	if (typeof value !== "boolean") {
		throw new TypeError(`${name} must be a boolean`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, name: string): void {
	if (!isRecord(value)) {
		throw new TypeError(`${name} must be an object`);
	}
}

function assertNonNegativeNumber(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a finite non-negative number`);
	}
}

function assertNonNegativeInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
}

function normalizeThreshold(value: number | undefined, name: string): number {
	const threshold =
		value ??
		(name === "supervisorToolCallThreshold"
			? DEFAULT_SUPERVISOR_TOOL_CALL_THRESHOLD
			: DEFAULT_SUPERVISOR_CAPABILITY_THRESHOLD);
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new RangeError(`${name} must be a positive integer`);
	}
	return threshold;
}

function appendReason(
	reasonCodes: PlannerRoutingReasonCode[],
	reasonCode: PlannerRoutingReasonCode,
): void {
	if (!reasonCodes.includes(reasonCode)) {
		reasonCodes.push(reasonCode);
	}
}

function routeStrategy(route: PlannerRoute): PlannerRoutingStrategy {
	switch (route) {
		case "multi_step_linear":
		case "multi_step_parallel":
		case "supervisor_required":
			return "plan_and_execute";
		case "simple_answer":
		case "single_tool":
		case "clarification":
		case "deferred_due_to_budget":
			return "react";
		default:
			return assertNever(route);
	}
}

function validatePlannerRoutingRequest(request: PlannerRoutingRequest): void {
	assertRecord(request, "request");
	if (request.schemaVersion !== 1) {
		throw new RangeError("schemaVersion must be 1");
	}
	assertNonEmptyString(request.runId, "runId");
	assertNonEmptyString(request.userGoal, "userGoal");
	assertNonEmptyString(request.traceId, "traceId");
	assertRecord(request.structuralSignals, "structuralSignals");
	assertRecord(request.budget, "budget");
	assertBoolean(
		request.structuralSignals.hasToolCalls,
		"structuralSignals.hasToolCalls",
	);
	assertBoolean(
		request.structuralSignals.hasPlanSketch,
		"structuralSignals.hasPlanSketch",
	);
	assertBoolean(
		request.structuralSignals.needsClarification,
		"structuralSignals.needsClarification",
	);
	assertNonNegativeInteger(
		request.structuralSignals.toolCallCount,
		"structuralSignals.toolCallCount",
	);
	if (
		request.structuralSignals.hasToolCalls &&
		request.structuralSignals.toolCallCount === 0
	) {
		throw new RangeError(
			"structuralSignals.toolCallCount must be positive when hasToolCalls is true",
		);
	}
	if (
		!request.structuralSignals.hasToolCalls &&
		request.structuralSignals.toolCallCount > 0
	) {
		throw new RangeError(
			"structuralSignals.toolCallCount must be 0 when hasToolCalls is false",
		);
	}
	assertNonNegativeNumber(
		request.budget.tokenRemaining,
		"budget.tokenRemaining",
	);
	assertNonNegativeInteger(
		request.budget.turnRemaining,
		"budget.turnRemaining",
	);
	if (request.budget.spendCapUsd != null) {
		assertNonNegativeNumber(request.budget.spendCapUsd, "budget.spendCapUsd");
	}
	if (!Array.isArray(request.capabilitiesRequired)) {
		throw new TypeError("capabilitiesRequired must be an array");
	}
	for (const [index, capability] of request.capabilitiesRequired.entries()) {
		assertNonEmptyString(capability, `capabilitiesRequired[${index}]`);
	}
	if (!PLANNER_ROUTING_RISK_TIERS.has(request.riskTier)) {
		throw new RangeError("riskTier must be a known planner routing risk tier");
	}
}

function selectPlannerRoute(
	request: PlannerRoutingRequest,
	policy: Required<PlannerRoutingPolicy>,
): PlannerRouteSelection {
	const reasonCodes: PlannerRoutingReasonCode[] = [];
	if (request.budget.tokenRemaining === 0) {
		appendReason(reasonCodes, "budget_token_exhausted");
	}
	if (request.budget.turnRemaining === 0) {
		appendReason(reasonCodes, "budget_turn_exhausted");
	}
	if (reasonCodes.length > 0) {
		return { route: "deferred_due_to_budget", reasonCodes };
	}

	if (request.structuralSignals.needsClarification) {
		return {
			route: "clarification",
			reasonCodes: ["needs_clarification"],
		};
	}

	if (request.riskTier === "critical") {
		return {
			route: "supervisor_required",
			reasonCodes: ["risk_critical_supervisor"],
		};
	}

	if (
		request.capabilitiesRequired.length >= policy.supervisorCapabilityThreshold
	) {
		return {
			route: "supervisor_required",
			reasonCodes: ["capability_count_requires_supervisor"],
		};
	}

	if (
		request.structuralSignals.toolCallCount >=
		policy.supervisorToolCallThreshold
	) {
		return {
			route: "supervisor_required",
			reasonCodes: ["tool_call_count_requires_supervisor"],
		};
	}

	if (
		request.structuralSignals.hasPlanSketch &&
		request.capabilitiesRequired.length > 1
	) {
		return {
			route: "multi_step_parallel",
			reasonCodes: ["plan_sketch_present", "multiple_capabilities_parallel"],
		};
	}

	if (
		request.structuralSignals.hasPlanSketch ||
		request.structuralSignals.toolCallCount > 1
	) {
		const routeReasonCodes: PlannerRoutingReasonCode[] = [];
		if (request.structuralSignals.hasPlanSketch) {
			appendReason(routeReasonCodes, "plan_sketch_present");
		}
		if (request.structuralSignals.toolCallCount > 1) {
			appendReason(routeReasonCodes, "multiple_tool_calls_linear");
		}
		return {
			route: "multi_step_linear",
			reasonCodes: routeReasonCodes,
		};
	}

	if (request.structuralSignals.hasToolCalls) {
		return {
			route: "single_tool",
			reasonCodes: ["single_tool_call"],
		};
	}

	return {
		route: "simple_answer",
		reasonCodes: ["no_tool_or_plan_simple_answer"],
	};
}

export function decidePlannerRoute(
	request: PlannerRoutingRequest,
	policy: PlannerRoutingPolicy = {},
): PlannerRoutingDecision {
	validatePlannerRoutingRequest(request);
	assertRecord(policy, "policy");
	const normalizedPolicy: Required<PlannerRoutingPolicy> = {
		supervisorToolCallThreshold: normalizeThreshold(
			policy.supervisorToolCallThreshold,
			"supervisorToolCallThreshold",
		),
		supervisorCapabilityThreshold: normalizeThreshold(
			policy.supervisorCapabilityThreshold,
			"supervisorCapabilityThreshold",
		),
	};
	const selection = selectPlannerRoute(request, normalizedPolicy);
	const reasonCodes = [...selection.reasonCodes];
	const requiresSupervisor = selection.route === "supervisor_required";

	return {
		schemaVersion: 1,
		route: selection.route,
		strategy: routeStrategy(selection.route),
		requiresSupervisor,
		requiresProviderRoute: false,
		requiresHandoffEnvelope: requiresSupervisor,
		reasonCodes,
		traceId: request.traceId,
	};
}
