import { describe, expect, it } from "vitest";
import {
	buildSupervisorHandoffPlan,
	decideCrossProcessRoute,
	decidePlannerRoute,
	type PlannerRoutingRequest,
	parseSupervisorHandoffPlan,
	validateSupervisorHandoffPlan,
} from "./index.js";

function supervisorRequest(): PlannerRoutingRequest {
	return {
		schemaVersion: 1,
		runId: "run-supervisor-plan",
		userGoal: "Delegate a broad implementation plan",
		structuralSignals: {
			hasToolCalls: true,
			toolCallCount: 3,
			hasPlanSketch: true,
			needsClarification: false,
		},
		budget: {
			tokenRemaining: 4096,
			turnRemaining: 8,
		},
		capabilitiesRequired: ["planning", "coding", "review"],
		riskTier: "ask_on_write",
		traceId: "trace-supervisor-plan",
	};
}

describe("buildSupervisorHandoffPlan", () => {
	it("constructs and validates a typed Planning-side supervisor handoff plan", () => {
		const decision = decidePlannerRoute(supervisorRequest());
		const plan = buildSupervisorHandoffPlan({
			routingDecision: decision,
			receiverCapability: "coding",
			inputSchemaRef: "planning.supervisor.input.v1",
			inputPayloadRef: "payload://run-supervisor-plan/task-1",
			writeScope: ["working:packages/agent-core/src/planning"],
			retryPolicyRef: "policy://retry/once",
			cancellationPolicyRef: "policy://cancel/cooperative",
			resultSchemaRef: "planning.supervisor.result.v1",
		});

		expect(plan).toEqual({
			schemaVersion: 1,
			handoffKind: "in_process",
			receiverCapability: "coding",
			inputSchemaRef: "planning.supervisor.input.v1",
			inputPayloadRef: "payload://run-supervisor-plan/task-1",
			historyFilter: "task_only",
			writeScope: ["working:packages/agent-core/src/planning"],
			retryPolicyRef: "policy://retry/once",
			cancellationPolicyRef: "policy://cancel/cooperative",
			resultSchemaRef: "planning.supervisor.result.v1",
			traceId: "trace-supervisor-plan",
		});
		expect(() => validateSupervisorHandoffPlan(plan)).not.toThrow();
		expect(
			parseSupervisorHandoffPlan(JSON.parse(JSON.stringify(plan))),
		).toEqual(plan);
	});

	it("fails closed when a route does not require a supervisor", () => {
		expect(() =>
			buildSupervisorHandoffPlan({
				routingDecision: decidePlannerRoute({
					...supervisorRequest(),
					structuralSignals: {
						hasToolCalls: false,
						toolCallCount: 0,
						hasPlanSketch: false,
						needsClarification: false,
					},
					capabilitiesRequired: [],
				}),
				receiverCapability: "coding",
				inputSchemaRef: "planning.supervisor.input.v1",
				inputPayloadRef: "payload://run-supervisor-plan/task-1",
				writeScope: [],
				retryPolicyRef: "policy://retry/once",
				cancellationPolicyRef: "policy://cancel/cooperative",
				resultSchemaRef: "planning.supervisor.result.v1",
			}),
		).toThrow(
			"routingDecision.requiresSupervisor must be true to build a supervisor handoff plan",
		);
	});

	it("validates schema refs, history filter, write scope, policies, and trace metadata", () => {
		const decision = decidePlannerRoute(supervisorRequest());
		expect(() =>
			buildSupervisorHandoffPlan({
				routingDecision: decision,
				receiverCapability: "coding",
				inputSchemaRef: "planning.supervisor.input.v1",
				inputPayloadRef: "payload://run-supervisor-plan/task-1",
				writeScope: [],
				retryPolicyRef: "policy://retry/once",
				cancellationPolicyRef: "policy://cancel/cooperative",
				resultSchemaRef: "planning.supervisor.result.v1",
				traceId: "trace-mismatch",
			}),
		).toThrow("input.traceId must match routingDecision.traceId");
		expect(() =>
			validateSupervisorHandoffPlan({
				schemaVersion: 2 as never,
				handoffKind: "in_process",
				receiverCapability: "coding",
				inputSchemaRef: "planning.supervisor.input.v1",
				inputPayloadRef: "payload://run-supervisor-plan/task-1",
				historyFilter: "task_only",
				writeScope: [],
				retryPolicyRef: "policy://retry/once",
				cancellationPolicyRef: "policy://cancel/cooperative",
				resultSchemaRef: "planning.supervisor.result.v1",
				traceId: "trace-supervisor-plan",
			}),
		).toThrow("plan.schemaVersion must be 1");
		expect(() =>
			validateSupervisorHandoffPlan({
				schemaVersion: 1,
				handoffKind: "in_process",
				receiverCapability: " ",
				inputSchemaRef: "planning.supervisor.input.v1",
				inputPayloadRef: "payload://run-supervisor-plan/task-1",
				historyFilter: "task_only",
				writeScope: [],
				retryPolicyRef: "policy://retry/once",
				cancellationPolicyRef: "policy://cancel/cooperative",
				resultSchemaRef: "planning.supervisor.result.v1",
				traceId: "trace-supervisor-plan",
			}),
		).toThrow("plan.receiverCapability must be a non-empty string");
		expect(() =>
			buildSupervisorHandoffPlan({
				routingDecision: decision,
				handoffKind: "mesh" as never,
				receiverCapability: "coding",
				inputSchemaRef: "planning.supervisor.input.v1",
				inputPayloadRef: "payload://run-supervisor-plan/task-1",
				writeScope: ["working:src"],
				retryPolicyRef: "policy://retry/once",
				cancellationPolicyRef: "policy://cancel/cooperative",
				resultSchemaRef: "planning.supervisor.result.v1",
			}),
		).toThrow("plan.handoffKind must be a known supervisor handoff kind");
		expect(() =>
			buildSupervisorHandoffPlan({
				routingDecision: decision,
				receiverCapability: "coding",
				inputSchemaRef: "planning.supervisor.input.v1",
				inputPayloadRef: "payload://run-supervisor-plan/task-1",
				historyFilter: "unknown" as never,
				writeScope: ["working:src"],
				retryPolicyRef: "policy://retry/once",
				cancellationPolicyRef: "policy://cancel/cooperative",
				resultSchemaRef: "planning.supervisor.result.v1",
			}),
		).toThrow("plan.historyFilter must be a known handoff history filter");
		expect(() =>
			buildSupervisorHandoffPlan({
				routingDecision: decision,
				receiverCapability: "coding",
				inputSchemaRef: "planning.supervisor.input.v1",
				inputPayloadRef: "payload://run-supervisor-plan/task-1",
				writeScope: ["working:src", ""],
				retryPolicyRef: "policy://retry/once",
				cancellationPolicyRef: "policy://cancel/cooperative",
				resultSchemaRef: "planning.supervisor.result.v1",
			}),
		).toThrow("plan.writeScope[1] must be a non-empty string");
	});
});

describe("decideCrossProcessRoute", () => {
	it("allows in-process and local-process routes with explicit local targets", () => {
		expect(
			decideCrossProcessRoute({
				mode: "in_process",
				timeoutMs: 5_000,
				traceId: "trace-local",
			}),
		).toEqual({
			schemaVersion: 1,
			mode: "in_process",
			allowed: true,
			timeoutMs: 5_000,
			traceId: "trace-local",
		});
		expect(
			decideCrossProcessRoute({
				mode: "local_process",
				processTarget: "worker:planning-local",
				timeoutMs: 10_000,
				traceId: "trace-local-process",
			}),
		).toMatchObject({
			mode: "local_process",
			allowed: true,
			processTarget: "worker:planning-local",
		});
	});

	it("fails remote mesh closed and blocks local routes on budget gates", () => {
		expect(
			decideCrossProcessRoute({
				mode: "remote_mesh",
				processTarget: "mesh://remote-agent",
				timeoutMs: 10_000,
				traceId: "trace-remote",
			}),
		).toEqual({
			schemaVersion: 1,
			mode: "remote_mesh",
			allowed: false,
			deniedReason: "mesh_deferred",
			processTarget: "mesh://remote-agent",
			timeoutMs: 10_000,
			traceId: "trace-remote",
		});
		expect(
			decideCrossProcessRoute({
				mode: "in_process",
				timeoutMs: 5_000,
				traceId: "trace-budget",
				budgetBlocked: true,
			}),
		).toMatchObject({
			allowed: false,
			deniedReason: "budget_blocked",
		});
		expect(() =>
			decideCrossProcessRoute({
				mode: "local_process",
				timeoutMs: 1_000,
				traceId: "trace-missing-target",
			}),
		).toThrow("request.processTarget must be a non-empty string");
	});
});
