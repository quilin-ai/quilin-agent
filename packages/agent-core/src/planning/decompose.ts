import { validateDagPlan } from "./dag.js";
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

export interface SubtreeReplacementResult {
	readonly plan: LinearPlan;
	readonly replacedStepIds: ReadonlyArray<string>;
	readonly insertedStepIds: ReadonlyArray<string>;
}

const STEP_ID_DELIMITERS = [".", "/", ">"] as const;

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

export function isSameOrNestedStepId(
	rootId: string,
	candidateId: string,
): boolean {
	return (
		candidateId === rootId ||
		STEP_ID_DELIMITERS.some((delimiter) =>
			candidateId.startsWith(`${rootId}${delimiter}`),
		)
	);
}

function prefixSubTaskId(
	parentId: string,
	childId: string,
	index: number,
): string {
	const trimmed = childId.trim();
	if (trimmed.length === 0) {
		return `${parentId}.${index + 1}`;
	}

	if (isSameOrNestedStepId(parentId, trimmed)) {
		return trimmed;
	}

	return `${parentId}.${trimmed.replace(/^[./>]+/u, "")}`;
}

export function normalizeSubTask(step: SubTask): SubTask {
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
	const outgoing = new Map(
		plan.subtasks.map((step) => [step.id, [] as string[]]),
	);

	for (const [from, to] of plan.edges) {
		if (!stepsById.has(from) || !stepsById.has(to)) {
			continue;
		}

		outgoing.get(from)?.push(to);
		incomingCount.set(to, (incomingCount.get(to) ?? 0) + 1);
	}

	const queue = plan.subtasks
		.filter((step) => (incomingCount.get(step.id) ?? 0) === 0)
		.sort(
			(left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
		)
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
	if (plan.kind === "linear") {
		return plan.subtasks;
	}

	const validation = validateDagPlan(plan);
	if (!validation.ok) {
		if (validation.duplicateStepIds.length > 0) {
			throw new Error(
				`DAG contains duplicate step ids: ${validation.duplicateStepIds.join(", ")}`,
			);
		}
		if (validation.missingStepIds.length > 0) {
			throw new Error(
				`DAG edge references missing step ids: ${validation.missingStepIds.join(", ")}`,
			);
		}
		throw new Error(`DAG contains a cycle: ${validation.cycle.join(" -> ")}`);
	}

	return topologicalSort(plan);
}

export function createRedecomposedSubtasks(
	target: SubTask,
	replacements: ReadonlyArray<SubTask>,
): readonly SubTask[] {
	if (replacements.length === 0) {
		throw new Error("replacement subtasks are required for L-Redecompose");
	}

	const targetDepth = inferStepDepth(target);

	return replacements.map((step, index) => {
		const prefixedId = prefixSubTaskId(target.id, step.id, index);
		const fallbackPreconditions = index === 0 ? target.preconditions : [];
		const fallbackEffects =
			index === replacements.length - 1 ? target.effects : [];

		return normalizeSubTask({
			...step,
			id: prefixedId,
			preconditions:
				step.preconditions.length > 0
					? step.preconditions
					: fallbackPreconditions,
			effects: step.effects.length > 0 ? step.effects : fallbackEffects,
			depth:
				step.depth ??
				Math.max(targetDepth + 1, inferStepDepth({ id: prefixedId })),
			writeScope: step.writeScope ?? target.writeScope,
			risk: step.risk ?? target.risk,
		});
	});
}

export function replacePlanSubtree(
	plan: LinearPlan,
	targetLeafId: string,
	replacements: ReadonlyArray<SubTask>,
): SubtreeReplacementResult {
	const targetIndex = plan.subtasks.findIndex(
		(step) => step.id === targetLeafId,
	);
	if (targetIndex === -1) {
		throw new Error(`unknown leafId: ${targetLeafId}`);
	}

	const matchedIndices = plan.subtasks
		.map((step, index) =>
			isSameOrNestedStepId(targetLeafId, step.id) ? index : -1,
		)
		.filter((index) => index >= 0);

	if (matchedIndices.length === 0) {
		throw new Error(`subtree not found for leafId: ${targetLeafId}`);
	}

	for (let index = 1; index < matchedIndices.length; index += 1) {
		const previous = matchedIndices[index - 1];
		const current = matchedIndices[index];
		if (previous == null || current == null || current !== previous + 1) {
			throw new Error(`subtree for ${targetLeafId} must remain contiguous`);
		}
	}

	const target = plan.subtasks[targetIndex];
	if (target == null) {
		throw new Error(`unknown leafId: ${targetLeafId}`);
	}

	const nextSubtasks = createRedecomposedSubtasks(target, replacements);
	const startIndex = matchedIndices[0] ?? targetIndex;
	const endIndex = matchedIndices.at(-1) ?? targetIndex;
	const replacedStepIds = matchedIndices
		.map((index) => plan.subtasks[index])
		.filter((step): step is SubTask => step != null)
		.map((step) => step.id);

	return {
		plan: {
			kind: "linear",
			subtasks: [
				...plan.subtasks.slice(0, startIndex),
				...nextSubtasks,
				...plan.subtasks.slice(endIndex + 1),
			],
		},
		replacedStepIds,
		insertedStepIds: nextSubtasks.map((step) => step.id),
	};
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
