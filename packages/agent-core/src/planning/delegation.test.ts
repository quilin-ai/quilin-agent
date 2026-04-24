import { describe, expect, it } from "vitest";
import {
	type DelegationCandidate,
	type DelegationTriggerConditions,
	evaluateDelegation,
	RuleBasedDelegationStrategy,
} from "./delegation.js";
import type { DagPlan, SubTask } from "./types.js";

function makeStep(id: string, overrides: Partial<SubTask> = {}): SubTask {
	return {
		id,
		action: overrides.action ?? "tool",
		name: overrides.name ?? `Step ${id}`,
		description: overrides.description ?? `Execute ${id}`,
		estimatedTokens: overrides.estimatedTokens ?? 100,
		estimatedSteps: overrides.estimatedSteps ?? 1,
		preconditions: overrides.preconditions ?? [],
		effects: overrides.effects ?? [`effect:${id}`],
		arguments: overrides.arguments,
		depth: overrides.depth,
		writeScope: overrides.writeScope,
		risk: overrides.risk,
		skillHint: overrides.skillHint,
	};
}

const allTriggers: DelegationTriggerConditions = {
	longRunningTask: true,
	decomposableSubtask: true,
	nonBlockingSupervisorRequired: true,
	subAgentCapabilityAvailable: true,
};

function makeCandidate(
	overrides: Partial<DelegationCandidate> = {},
): DelegationCandidate {
	const mainStep = makeStep("main-write", {
		writeScope: "working",
		arguments: { path: "main.md" },
		risk: "low",
	});
	const delegatedStep = makeStep("delegated-research", {
		action: "research",
		writeScope: "episodic",
		arguments: { path: "research.md" },
		risk: "medium",
		estimatedSteps: 30,
	});
	const plan: DagPlan = {
		kind: "dag",
		subtasks: [mainStep, delegatedStep, makeStep("join")],
		edges: [
			["main-write", "join"],
			["delegated-research", "join"],
		],
	};

	return {
		parentRunId: "run-c3",
		candidateStep: delegatedStep,
		plan,
		mainAgentSteps: [mainStep],
		triggers: allTriggers,
		subAgent: {
			role: "research-worker",
			goal: "Complete delegated research without blocking the supervisor",
		},
		...overrides,
	};
}

describe("evaluateDelegation", () => {
	it("accepts delegation only when all trigger, DAG, write-set, and risk gates pass", () => {
		const decision = evaluateDelegation(makeCandidate());

		expect(decision).toMatchObject({
			delegate: true,
			reason: "accepted",
			assignment: {
				parentRunId: "run-c3",
				childRunId: "run-c3:delegated:delegated-research",
				taskId: "delegated-research",
				writeSet: {
					scope: "episodic",
					resources: ["research.md"],
					unknown: false,
				},
				progressReporting: {
					checkpoint: true,
					heartbeat: true,
				},
			},
		});
	});

	it.each([
		["longRunningTask", "missing_long_running_trigger"],
		["decomposableSubtask", "missing_decomposable_trigger"],
		["nonBlockingSupervisorRequired", "missing_non_blocking_trigger"],
		["subAgentCapabilityAvailable", "missing_sub_agent_capability_trigger"],
	] as const)("rejects delegation when the %s trigger is absent", (triggerName, reason) => {
		expect(
			evaluateDelegation(
				makeCandidate({
					triggers: {
						...allTriggers,
						[triggerName]: false,
					},
				}),
			),
		).toEqual({ delegate: false, reason });
	});

	it("rejects delegated writes that overlap the main agent write set", () => {
		const candidateStep = makeStep("delegated-write", {
			writeScope: "working",
			arguments: { path: "same.md" },
			risk: "medium",
		});

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep,
					plan: {
						kind: "dag",
						subtasks: [candidateStep],
						edges: [],
					},
					mainAgentSteps: [
						makeStep("main-write", {
							writeScope: "working",
							arguments: { path: "same.md" },
							risk: "low",
						}),
					],
				}),
			),
		).toEqual({ delegate: false, reason: "shared_write_set" });
	});

	it("rejects high and critical risk writes conservatively", () => {
		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep: makeStep("dangerous", {
						writeScope: "episodic",
						arguments: { path: "danger.md" },
						risk: "high",
					}),
					plan: {
						kind: "dag",
						subtasks: [
							makeStep("dangerous", {
								writeScope: "episodic",
								arguments: { path: "danger.md" },
								risk: "high",
							}),
						],
						edges: [],
					},
				}),
			),
		).toEqual({ delegate: false, reason: "high_risk_write" });

		expect(
			evaluateDelegation(makeCandidate({ riskOverride: "critical" })),
		).toEqual({ delegate: false, reason: "high_risk_write" });
	});

	it("rejects invalid DAG candidates before producing an assignment", () => {
		const step = makeStep("loop");

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep: step,
					plan: {
						kind: "dag",
						subtasks: [step],
						edges: [["loop", "loop"]],
					},
				}),
			),
		).toEqual({ delegate: false, reason: "invalid_dag" });
	});
});

describe("RuleBasedDelegationStrategy", () => {
	it("wraps the pure delegation evaluator", () => {
		const strategy = new RuleBasedDelegationStrategy();

		expect(strategy.evaluate(makeCandidate()).delegate).toBe(true);
	});
});
