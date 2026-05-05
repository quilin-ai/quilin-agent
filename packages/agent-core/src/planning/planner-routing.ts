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

export interface PlannerRoutingTracePayload {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly traceId: string;
	readonly route: PlannerRoute;
	readonly strategy: PlannerRoutingStrategy;
	readonly reasonCodes: readonly PlannerRoutingReasonCode[];
	readonly budget: {
		readonly tokenRemaining: number;
		readonly turnRemaining: number;
		readonly spendCapUsd?: number;
	};
	readonly structuralSignals: PlannerRoutingRequest["structuralSignals"];
	readonly riskTier: PlannerRoutingRiskTier;
	readonly capabilitiesRequired: readonly string[];
	readonly capabilityCount: number;
	readonly requiresSupervisor: boolean;
	readonly requiresProviderRoute: boolean;
	readonly requiresHandoffEnvelope: boolean;
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

const PLANNER_ROUTES = new Set<PlannerRoute>([
	"simple_answer",
	"single_tool",
	"multi_step_linear",
	"multi_step_parallel",
	"clarification",
	"supervisor_required",
	"deferred_due_to_budget",
]);

const PLANNER_ROUTING_STRATEGIES = new Set<PlannerRoutingStrategy>([
	"cot",
	"react",
	"plan_and_execute",
]);

const PLANNER_ROUTING_REASON_CODES = new Set<PlannerRoutingReasonCode>([
	"needs_clarification",
	"budget_token_exhausted",
	"budget_turn_exhausted",
	"risk_critical_supervisor",
	"tool_call_count_requires_supervisor",
	"capability_count_requires_supervisor",
	"plan_sketch_present",
	"multiple_capabilities_parallel",
	"multiple_tool_calls_linear",
	"single_tool_call",
	"no_tool_or_plan_simple_answer",
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

function assertPlannerRoute(value: PlannerRoute, name: string): void {
	if (!PLANNER_ROUTES.has(value)) {
		throw new RangeError(`${name} must be a known planner route`);
	}
}

function assertPlannerRoutingStrategy(
	value: PlannerRoutingStrategy,
	name: string,
): void {
	if (!PLANNER_ROUTING_STRATEGIES.has(value)) {
		throw new RangeError(`${name} must be a known planner routing strategy`);
	}
}

function assertPlannerRoutingReasonCode(
	value: PlannerRoutingReasonCode,
	name: string,
): void {
	if (!PLANNER_ROUTING_REASON_CODES.has(value)) {
		throw new RangeError(`${name} must be a known planner routing reason code`);
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

export function validatePlannerRoutingDecision(
	decision: PlannerRoutingDecision,
): void {
	assertRecord(decision, "decision");
	if (decision.schemaVersion !== 1) {
		throw new RangeError("decision.schemaVersion must be 1");
	}
	assertPlannerRoute(decision.route, "decision.route");
	assertPlannerRoutingStrategy(decision.strategy, "decision.strategy");
	assertBoolean(decision.requiresSupervisor, "decision.requiresSupervisor");
	assertBoolean(
		decision.requiresProviderRoute,
		"decision.requiresProviderRoute",
	);
	assertBoolean(
		decision.requiresHandoffEnvelope,
		"decision.requiresHandoffEnvelope",
	);
	if (!Array.isArray(decision.reasonCodes)) {
		throw new TypeError("decision.reasonCodes must be an array");
	}
	if (decision.reasonCodes.length === 0) {
		throw new RangeError("decision.reasonCodes must not be empty");
	}
	for (const [index, reasonCode] of decision.reasonCodes.entries()) {
		assertPlannerRoutingReasonCode(
			reasonCode,
			`decision.reasonCodes[${index}]`,
		);
	}
	assertNonEmptyString(decision.traceId, "decision.traceId");

	const routeRequiresSupervisor = decision.route === "supervisor_required";
	if (decision.requiresSupervisor !== routeRequiresSupervisor) {
		throw new RangeError(
			"decision.requiresSupervisor must match supervisor_required route",
		);
	}
	if (decision.requiresHandoffEnvelope !== decision.requiresSupervisor) {
		throw new RangeError(
			"decision.requiresHandoffEnvelope must match requiresSupervisor",
		);
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

export function buildPlannerRoutingTracePayload(
	request: PlannerRoutingRequest,
	decision: PlannerRoutingDecision,
): PlannerRoutingTracePayload {
	validatePlannerRoutingRequest(request);
	validatePlannerRoutingDecision(decision);
	if (request.traceId !== decision.traceId) {
		throw new RangeError("request.traceId must match decision.traceId");
	}

	return {
		schemaVersion: 1,
		runId: request.runId,
		traceId: decision.traceId,
		route: decision.route,
		strategy: decision.strategy,
		reasonCodes: [...decision.reasonCodes],
		budget: {
			tokenRemaining: request.budget.tokenRemaining,
			turnRemaining: request.budget.turnRemaining,
			...(request.budget.spendCapUsd == null
				? {}
				: { spendCapUsd: request.budget.spendCapUsd }),
		},
		structuralSignals: { ...request.structuralSignals },
		riskTier: request.riskTier,
		capabilitiesRequired: [...request.capabilitiesRequired],
		capabilityCount: request.capabilitiesRequired.length,
		requiresSupervisor: decision.requiresSupervisor,
		requiresProviderRoute: decision.requiresProviderRoute,
		requiresHandoffEnvelope: decision.requiresHandoffEnvelope,
	};
}

export function explainPlannerRoutingDecision(
	decision: PlannerRoutingDecision,
): string {
	validatePlannerRoutingDecision(decision);
	switch (decision.route) {
		case "deferred_due_to_budget":
			return "Routing is deferred because the remaining token or turn budget is exhausted.";
		case "clarification":
			return "Routing asks for clarification because the request is not specific enough to execute safely.";
		case "supervisor_required":
			return "Routing requires a supervisor because the request is broad, risky, or has enough tool work to need managed handoff.";
		case "multi_step_parallel":
			return "Routing uses parallel planning because the request has a plan sketch spanning multiple capabilities.";
		case "multi_step_linear":
			return "Routing uses linear planning because the request needs multiple ordered planning steps.";
		case "single_tool":
			return "Routing uses one tool-backed step because the request has exactly one tool action.";
		case "simple_answer":
			return "Routing stays with a direct answer because no tool, handoff, budget, or clarification gate was triggered.";
		default:
			return assertNever(decision.route);
	}
}
