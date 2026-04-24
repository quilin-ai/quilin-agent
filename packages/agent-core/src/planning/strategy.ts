import type { Intent, Plan } from "./types.js";

// Planning constants trace to docs/engineering/04-planning/README.md.
export const PLAN_AND_EXECUTE_STEP_THRESHOLD = 20;

export type PlanningStrategy = "CoT" | "ReAct" | "PlanAndExecute";

export interface StrategySelectionInput {
	readonly intent: Intent;
	readonly plan?: Plan | null;
	readonly estimatedSteps?: number;
	readonly userOverride?: PlanningStrategy | null;
}

export interface StrategySelection {
	readonly strategy: PlanningStrategy;
	readonly reason:
		| "user_override"
		| "simple_qa"
		| "single_tool"
		| "clarification"
		| "dag_plan"
		| "long_plan"
		| "multi_step_m0";
	readonly planStepCount: number | null;
	readonly threshold: number;
	readonly overridden: boolean;
}

export interface StrategySelectorOptions {
	readonly planAndExecuteStepThreshold?: number;
}

function normalizeThreshold(value: number | undefined): number {
	const resolved = value ?? PLAN_AND_EXECUTE_STEP_THRESHOLD;
	if (!Number.isInteger(resolved) || resolved < 1) {
		throw new RangeError(
			"planAndExecuteStepThreshold must be a positive integer",
		);
	}
	return resolved;
}

function countPlanSteps(plan: Plan | null | undefined): number | null {
	return plan == null ? null : plan.subtasks.length;
}

function resolveEstimatedSteps(input: StrategySelectionInput): number | null {
	const planStepCount = countPlanSteps(input.plan);
	if (planStepCount != null) {
		return planStepCount;
	}

	if (input.estimatedSteps == null) {
		return null;
	}

	if (!Number.isInteger(input.estimatedSteps) || input.estimatedSteps < 0) {
		throw new RangeError("estimatedSteps must be a non-negative integer");
	}

	return input.estimatedSteps;
}

export function selectPlanningStrategy(
	input: StrategySelectionInput,
	options: StrategySelectorOptions = {},
): StrategySelection {
	const threshold = normalizeThreshold(options.planAndExecuteStepThreshold);
	const planStepCount = countPlanSteps(input.plan);
	const estimatedSteps = resolveEstimatedSteps(input);

	if (input.userOverride != null) {
		return {
			strategy: input.userOverride,
			reason: "user_override",
			planStepCount,
			threshold,
			overridden: true,
		};
	}

	if (input.intent === "SIMPLE_QA") {
		return {
			strategy: "CoT",
			reason: "simple_qa",
			planStepCount,
			threshold,
			overridden: false,
		};
	}

	if (input.intent === "SINGLE_TOOL") {
		return {
			strategy: "ReAct",
			reason: "single_tool",
			planStepCount,
			threshold,
			overridden: false,
		};
	}

	if (input.intent === "CLARIFICATION") {
		return {
			strategy: "CoT",
			reason: "clarification",
			planStepCount,
			threshold,
			overridden: false,
		};
	}

	if (input.plan?.kind === "dag") {
		return {
			strategy: "PlanAndExecute",
			reason: "dag_plan",
			planStepCount,
			threshold,
			overridden: false,
		};
	}

	if (estimatedSteps != null && estimatedSteps > threshold) {
		return {
			strategy: "PlanAndExecute",
			reason: "long_plan",
			planStepCount,
			threshold,
			overridden: false,
		};
	}

	return {
		strategy: "ReAct",
		reason: "multi_step_m0",
		planStepCount,
		threshold,
		overridden: false,
	};
}

export class RuleBasedStrategySelector {
	private readonly options: StrategySelectorOptions;

	constructor(options: StrategySelectorOptions = {}) {
		this.options = options;
	}

	select(input: StrategySelectionInput): StrategySelection {
		return selectPlanningStrategy(input, this.options);
	}
}
