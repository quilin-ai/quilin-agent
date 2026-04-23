import type {
	DagPlan,
	LinearPlan,
	LLMPlannerResponse,
	SubTask,
} from "./types.js";

export const DEFAULT_MAX_DECOMPOSE_STEPS = 10;
export const DEFAULT_MAX_DECOMPOSE_DEPTH = 2;

export interface DecomposeOptions {
	readonly maxSteps?: number;
	readonly maxDepth?: number;
}

export interface DecomposeResult {
	readonly plan: LinearPlan;
	readonly truncated: boolean;
	readonly omittedSteps: number;
	readonly maxStepsApplied: number;
	readonly maxDepthApplied: number;
}

function normalizePositiveInteger(
	value: number | undefined,
	fallback: number,
	field: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) {
		throw new RangeError(`${field} must be a positive integer`);
	}
	return resolved;
}

export function inferStepDepth(step: Pick<SubTask, "id" | "depth">): number {
	if (step.depth != null) {
		return step.depth;
	}

	const segments = step.id
		.split(/[/.>]/u)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);

	return Math.max(1, segments.length);
}

function normalizeSubTask(step: SubTask): SubTask {
	return {
		...step,
		arguments: step.arguments ?? {},
		depth: inferStepDepth(step),
		writeScope: step.writeScope ?? "none",
		risk: step.risk ?? "low",
	};
}

function topologicalSort(plan: DagPlan): readonly SubTask[] {
	const order = new Map(plan.subtasks.map((step, index) => [step.id, index]));
	const stepsById = new Map(plan.subtasks.map((step) => [step.id, step]));
	const incomingCount = new Map(plan.subtasks.map((step) => [step.id, 0]));
	const outgoing = new Map(plan.subtasks.map((step) => [step.id, [] as string[]]));

	for (const [from, to] of plan.edges) {
		if (!stepsById.has(from) || !stepsById.has(to)) {
			continue;
		}

		outgoing.get(from)?.push(to);
		incomingCount.set(to, (incomingCount.get(to) ?? 0) + 1);
	}

	const queue = plan.subtasks
		.filter((step) => (incomingCount.get(step.id) ?? 0) === 0)
		.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
		.map((step) => step.id);
	const sorted: SubTask[] = [];

	while (queue.length > 0) {
		const nextId = queue.shift();
		if (nextId == null) {
			break;
		}

		const step = stepsById.get(nextId);
		if (step == null) {
			continue;
		}
		sorted.push(step);

		for (const targetId of outgoing.get(nextId) ?? []) {
			const remaining = (incomingCount.get(targetId) ?? 1) - 1;
			incomingCount.set(targetId, remaining);
			if (remaining === 0) {
				queue.push(targetId);
				queue.sort(
					(left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
				);
			}
		}
	}

	return sorted.length === plan.subtasks.length ? sorted : plan.subtasks;
}

function getPlanSketch(
	input: LLMPlannerResponse | LinearPlan | DagPlan,
): LinearPlan | DagPlan | undefined {
	if ("kind" in input) {
		return input;
	}

	return input.planSketch;
}

function toLinearSteps(plan: LinearPlan | DagPlan): readonly SubTask[] {
	return plan.kind === "linear" ? plan.subtasks : topologicalSort(plan);
}

export function decomposePlan(
	input: LLMPlannerResponse | LinearPlan | DagPlan,
	options: DecomposeOptions = {},
): DecomposeResult {
	const planSketch = getPlanSketch(input);
	if (planSketch == null) {
		throw new Error("planSketch is required for linear decomposition");
	}

	const maxSteps = normalizePositiveInteger(
		options.maxSteps,
		DEFAULT_MAX_DECOMPOSE_STEPS,
		"maxSteps",
	);
	const maxDepth = normalizePositiveInteger(
		options.maxDepth,
		DEFAULT_MAX_DECOMPOSE_DEPTH,
		"maxDepth",
	);
	const normalizedSteps = toLinearSteps(planSketch).map(normalizeSubTask);
	const eligibleSteps = normalizedSteps.filter(
		(step) => (step.depth ?? inferStepDepth(step)) <= maxDepth,
	);
	const subtasks = eligibleSteps.slice(0, maxSteps);
	const omittedSteps = normalizedSteps.length - subtasks.length;

	return {
		plan: {
			kind: "linear",
			subtasks,
		},
		truncated: omittedSteps > 0,
		omittedSteps,
		maxStepsApplied: maxSteps,
		maxDepthApplied: maxDepth,
	};
}
