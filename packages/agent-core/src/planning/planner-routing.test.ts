import { describe, expect, it } from "vitest";
import {
	decidePlannerRoute,
	type PlannerRoutingDecision,
	type PlannerRoutingRequest,
} from "./index.js";

function makeRequest(
	overrides: Partial<PlannerRoutingRequest> = {},
): PlannerRoutingRequest {
	return {
		schemaVersion: overrides.schemaVersion ?? 1,
		runId: overrides.runId ?? "run-planner-routing",
		userGoal: overrides.userGoal ?? "Plan a deterministic route",
		structuralSignals: {
			hasToolCalls: false,
			toolCallCount: 0,
			hasPlanSketch: false,
			needsClarification: false,
			...overrides.structuralSignals,
		},
		budget: {
			tokenRemaining: 4096,
			turnRemaining: 8,
			...overrides.budget,
		},
		capabilitiesRequired: overrides.capabilitiesRequired ?? [],
		riskTier: overrides.riskTier ?? "read_only",
		traceId: overrides.traceId ?? "trace-planner-routing",
	};
}

describe("decidePlannerRoute", () => {
	it("routes direct requests to simple answers deterministically", () => {
		const request = makeRequest();
		const decision: PlannerRoutingDecision = decidePlannerRoute(request);

		expect(decision).toEqual({
			schemaVersion: 1,
			route: "simple_answer",
			strategy: "react",
			requiresSupervisor: false,
			requiresProviderRoute: false,
			requiresHandoffEnvelope: false,
			reasonCodes: ["no_tool_or_plan_simple_answer"],
			traceId: "trace-planner-routing",
		});
		expect(decidePlannerRoute(JSON.parse(JSON.stringify(request)))).toEqual(
			decision,
		);
	});

	it("distinguishes single-tool and multi-step linear routes", () => {
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 1,
						hasPlanSketch: false,
						needsClarification: false,
					},
				}),
			),
		).toMatchObject({
			route: "single_tool",
			strategy: "react",
			reasonCodes: ["single_tool_call"],
		});
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 2,
						hasPlanSketch: false,
						needsClarification: false,
					},
				}),
			),
		).toMatchObject({
			route: "multi_step_linear",
			strategy: "plan_and_execute",
			reasonCodes: ["multiple_tool_calls_linear"],
		});
	});

	it("routes plan sketches across multiple capabilities to parallel planning", () => {
		const decision = decidePlannerRoute(
			makeRequest({
				structuralSignals: {
					hasToolCalls: false,
					toolCallCount: 0,
					hasPlanSketch: true,
					needsClarification: false,
				},
				capabilitiesRequired: ["research", "summarize"],
			}),
		);

		expect(decision).toMatchObject({
			route: "multi_step_parallel",
			strategy: "plan_and_execute",
			requiresSupervisor: false,
			requiresHandoffEnvelope: false,
			reasonCodes: ["plan_sketch_present", "multiple_capabilities_parallel"],
		});
	});

	it("prioritizes budget deferral and clarification before normal routing", () => {
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 1,
						hasPlanSketch: true,
						needsClarification: true,
					},
					budget: {
						tokenRemaining: 0,
						turnRemaining: 0,
					},
				}),
			),
		).toEqual({
			schemaVersion: 1,
			route: "deferred_due_to_budget",
			strategy: "react",
			requiresSupervisor: false,
			requiresProviderRoute: false,
			requiresHandoffEnvelope: false,
			reasonCodes: ["budget_token_exhausted", "budget_turn_exhausted"],
			traceId: "trace-planner-routing",
		});
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 1,
						hasPlanSketch: true,
						needsClarification: true,
					},
				}),
			),
		).toMatchObject({
			route: "clarification",
			reasonCodes: ["needs_clarification"],
		});
	});

	it("requires supervisor handoff envelopes for critical or broad routes", () => {
		expect(
			decidePlannerRoute(
				makeRequest({
					riskTier: "critical",
					budget: {
						tokenRemaining: 4096,
						turnRemaining: 8,
						spendCapUsd: 0.05,
					},
				}),
			),
		).toEqual({
			schemaVersion: 1,
			route: "supervisor_required",
			strategy: "plan_and_execute",
			requiresSupervisor: true,
			requiresProviderRoute: false,
			requiresHandoffEnvelope: true,
			reasonCodes: ["risk_critical_supervisor"],
			traceId: "trace-planner-routing",
		});
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 3,
						hasPlanSketch: false,
						needsClarification: false,
					},
				}),
			),
		).toMatchObject({
			route: "supervisor_required",
			requiresSupervisor: true,
			reasonCodes: ["tool_call_count_requires_supervisor"],
		});
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: false,
						toolCallCount: 0,
						hasPlanSketch: false,
						needsClarification: false,
					},
					capabilitiesRequired: ["research", "code", "review"],
				}),
			),
		).toMatchObject({
			route: "supervisor_required",
			reasonCodes: ["capability_count_requires_supervisor"],
		});
	});

	it("honors explicit supervisor thresholds", () => {
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 2,
						hasPlanSketch: false,
						needsClarification: false,
					},
				}),
				{ supervisorToolCallThreshold: 2 },
			).route,
		).toBe("supervisor_required");
		expect(
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 2,
						hasPlanSketch: false,
						needsClarification: false,
					},
				}),
				{ supervisorToolCallThreshold: 4 },
			).route,
		).toBe("multi_step_linear");
		expect(
			decidePlannerRoute(
				makeRequest({
					capabilitiesRequired: ["research", "code"],
				}),
				{ supervisorCapabilityThreshold: 2 },
			).route,
		).toBe("supervisor_required");
	});

	it("rejects invalid routing requests and policies", () => {
		expect(() => decidePlannerRoute(null as never)).toThrow(
			"request must be an object",
		);
		expect(() =>
			decidePlannerRoute(makeRequest({ schemaVersion: 2 as never })),
		).toThrow("schemaVersion must be 1");
		expect(() => decidePlannerRoute(makeRequest({ runId: "  " }))).toThrow(
			"runId must be a non-empty string",
		);
		expect(() =>
			decidePlannerRoute({
				...makeRequest(),
				structuralSignals: null as never,
			}),
		).toThrow("structuralSignals must be an object");
		expect(() =>
			decidePlannerRoute({
				...makeRequest(),
				budget: null as never,
			}),
		).toThrow("budget must be an object");
		expect(() =>
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: true,
						toolCallCount: 0,
						hasPlanSketch: false,
						needsClarification: false,
					},
				}),
			),
		).toThrow(
			"structuralSignals.toolCallCount must be positive when hasToolCalls is true",
		);
		expect(() =>
			decidePlannerRoute(
				makeRequest({
					structuralSignals: {
						hasToolCalls: false,
						toolCallCount: 1,
						hasPlanSketch: false,
						needsClarification: false,
					},
				}),
			),
		).toThrow(
			"structuralSignals.toolCallCount must be 0 when hasToolCalls is false",
		);
		expect(() =>
			decidePlannerRoute(
				makeRequest({ budget: { tokenRemaining: -1, turnRemaining: 8 } }),
			),
		).toThrow("budget.tokenRemaining must be a finite non-negative number");
		expect(() =>
			decidePlannerRoute(
				makeRequest({ capabilitiesRequired: ["research", ""] }),
			),
		).toThrow("capabilitiesRequired[1] must be a non-empty string");
		expect(() =>
			decidePlannerRoute({
				...makeRequest(),
				capabilitiesRequired: null as never,
			}),
		).toThrow("capabilitiesRequired must be an array");
		expect(() =>
			decidePlannerRoute(makeRequest({ riskTier: "severe" as never })),
		).toThrow("riskTier must be a known planner routing risk tier");
		expect(() => decidePlannerRoute(makeRequest(), null as never)).toThrow(
			"policy must be an object",
		);
		expect(() =>
			decidePlannerRoute(makeRequest(), { supervisorToolCallThreshold: 0 }),
		).toThrow("supervisorToolCallThreshold must be a positive integer");
	});
});
