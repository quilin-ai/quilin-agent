import { describe, expect, it } from "vitest";
import {
	RuleBasedStrategySelector,
	selectPlanningStrategy,
} from "./strategy.js";
import type { DagPlan, LinearPlan, SubTask } from "./types.js";

function makeStep(id: string): SubTask {
	return {
		id,
		action: "tool",
		name: `Step ${id}`,
		description: `Execute ${id}`,
		estimatedTokens: 10,
		estimatedSteps: 1,
		preconditions: [],
		effects: [`effect:${id}`],
		writeScope: "none",
		risk: "low",
	};
}

function makeLinearPlan(stepCount: number): LinearPlan {
	return {
		kind: "linear",
		subtasks: Array.from({ length: stepCount }, (_, index) =>
			makeStep(`step-${index + 1}`),
		),
	};
}

describe("selectPlanningStrategy", () => {
	it("automatically candidates PlanAndExecute for plans over 20 steps", () => {
		expect(
			selectPlanningStrategy({
				intent: "MULTI_STEP",
				plan: makeLinearPlan(21),
			}),
		).toMatchObject({
			strategy: "PlanAndExecute",
			reason: "long_plan",
			planStepCount: 21,
			threshold: 20,
			overridden: false,
		});
	});

	it("keeps M0-compatible ReAct for multi-step plans at or below 20 steps", () => {
		expect(
			selectPlanningStrategy({
				intent: "MULTI_STEP",
				plan: makeLinearPlan(20),
			}),
		).toMatchObject({
			strategy: "ReAct",
			reason: "multi_step_m0",
		});
	});

	it("keeps CoT and ReAct behavior for M0 intents", () => {
		expect(selectPlanningStrategy({ intent: "SIMPLE_QA" })).toMatchObject({
			strategy: "CoT",
			reason: "simple_qa",
		});
		expect(selectPlanningStrategy({ intent: "SINGLE_TOOL" })).toMatchObject({
			strategy: "ReAct",
			reason: "single_tool",
		});
		expect(selectPlanningStrategy({ intent: "CLARIFICATION" })).toMatchObject({
			strategy: "CoT",
			reason: "clarification",
		});
	});

	it("honors user override before automatic rules", () => {
		expect(
			selectPlanningStrategy({
				intent: "MULTI_STEP",
				plan: makeLinearPlan(50),
				userOverride: "ReAct",
			}),
		).toMatchObject({
			strategy: "ReAct",
			reason: "user_override",
			overridden: true,
		});
	});

	it("selects PlanAndExecute for DAG plans", () => {
		const dag: DagPlan = {
			kind: "dag",
			subtasks: [makeStep("search"), makeStep("summarize")],
			edges: [["search", "summarize"]],
		};

		expect(
			selectPlanningStrategy({
				intent: "MULTI_STEP",
				plan: dag,
			}),
		).toMatchObject({
			strategy: "PlanAndExecute",
			reason: "dag_plan",
			planStepCount: 2,
		});
	});

	it("uses estimated steps when no plan has been materialized", () => {
		expect(
			selectPlanningStrategy({
				intent: "MULTI_STEP",
				estimatedSteps: 21,
			}),
		).toMatchObject({
			strategy: "PlanAndExecute",
			reason: "long_plan",
			planStepCount: null,
		});
	});

	it("rejects invalid thresholds and estimated step counts", () => {
		expect(() =>
			selectPlanningStrategy(
				{ intent: "MULTI_STEP" },
				{ planAndExecuteStepThreshold: 0 },
			),
		).toThrow("planAndExecuteStepThreshold must be a positive integer");
		expect(() =>
			selectPlanningStrategy({
				intent: "MULTI_STEP",
				estimatedSteps: -1,
			}),
		).toThrow("estimatedSteps must be a non-negative integer");
	});
});

describe("RuleBasedStrategySelector", () => {
	it("applies configured PlanAndExecute threshold", () => {
		const selector = new RuleBasedStrategySelector({
			planAndExecuteStepThreshold: 3,
		});

		expect(
			selector.select({
				intent: "MULTI_STEP",
				plan: makeLinearPlan(4),
			}),
		).toMatchObject({
			strategy: "PlanAndExecute",
			threshold: 3,
		});
	});
});
