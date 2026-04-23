import type {
	DagPlan,
	LinearPlan,
	MemoryWriteScope,
	SubTask,
} from "./types.js";

export interface DagValidationResult {
	readonly ok: boolean;
	readonly missingStepIds: ReadonlyArray<string>;
	readonly duplicateStepIds: ReadonlyArray<string>;
	readonly cycle: ReadonlyArray<string>;
}

export interface WriteSet {
	readonly scope: MemoryWriteScope;
	readonly resources: ReadonlyArray<string>;
	readonly unknown: boolean;
}

const RESOURCE_ARGUMENT_KEYS = [
	"path",
	"paths",
	"file",
	"files",
	"resource",
	"resources",
	"memory_id",
	"memoryIds",
	"layer",
] as const;

function uniqueSorted(values: Iterable<string>): readonly string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function collectDuplicateStepIds(
	steps: ReadonlyArray<SubTask>,
): readonly string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();

	for (const step of steps) {
		if (seen.has(step.id)) {
			duplicates.add(step.id);
			continue;
		}
		seen.add(step.id);
	}

	return uniqueSorted(duplicates);
}

function buildAdjacency(plan: DagPlan): Map<string, string[]> {
	const adjacency = new Map(
		plan.subtasks.map((step) => [step.id, [] as string[]]),
	);
	const stepIds = new Set(adjacency.keys());

	for (const [from, to] of plan.edges) {
		if (stepIds.has(from) && stepIds.has(to)) {
			adjacency.get(from)?.push(to);
		}
	}

	for (const targets of adjacency.values()) {
		targets.sort((left, right) => left.localeCompare(right));
	}

	return adjacency;
}

function findCycle(plan: DagPlan): readonly string[] {
	const adjacency = buildAdjacency(plan);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: string[] = [];

	const visit = (stepId: string): readonly string[] => {
		if (visiting.has(stepId)) {
			const cycleStart = stack.indexOf(stepId);
			return [...stack.slice(cycleStart), stepId];
		}

		if (visited.has(stepId)) {
			return [];
		}

		visiting.add(stepId);
		stack.push(stepId);

		for (const targetId of adjacency.get(stepId) ?? []) {
			const cycle = visit(targetId);
			if (cycle.length > 0) {
				return cycle;
			}
		}

		stack.pop();
		visiting.delete(stepId);
		visited.add(stepId);
		return [];
	};

	for (const step of plan.subtasks) {
		const cycle = visit(step.id);
		if (cycle.length > 0) {
			return cycle;
		}
	}

	return [];
}

export function linearPlanToDag(plan: LinearPlan): DagPlan {
	return {
		kind: "dag",
		subtasks: plan.subtasks,
		edges: plan.subtasks
			.slice(1)
			.map((step, index) => [plan.subtasks[index]?.id ?? "", step.id]),
	};
}

export function validateDagPlan(plan: DagPlan): DagValidationResult {
	const stepIds = new Set(plan.subtasks.map((step) => step.id));
	const duplicateStepIds = collectDuplicateStepIds(plan.subtasks);
	const missingStepIds = uniqueSorted(
		plan.edges.flatMap(([from, to]) =>
			[from, to].filter((stepId) => !stepIds.has(stepId)),
		),
	);
	const cycle = missingStepIds.length === 0 ? findCycle(plan) : [];

	return {
		ok:
			duplicateStepIds.length === 0 &&
			missingStepIds.length === 0 &&
			cycle.length === 0,
		missingStepIds,
		duplicateStepIds,
		cycle,
	};
}

export function assertAcyclicDag(plan: DagPlan): void {
	const validation = validateDagPlan(plan);
	if (validation.ok) {
		return;
	}

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

function valuesForResourceKey(value: unknown): readonly string[] {
	if (typeof value === "string" && value.trim().length > 0) {
		return [value.trim()];
	}

	if (Array.isArray(value)) {
		return value.flatMap(valuesForResourceKey);
	}

	return [];
}

export function getStepWriteSet(step: SubTask): WriteSet {
	const scope = step.writeScope ?? "none";
	if (scope === "none") {
		return { scope, resources: [], unknown: false };
	}

	const resources = uniqueSorted(
		RESOURCE_ARGUMENT_KEYS.flatMap((key) =>
			valuesForResourceKey(step.arguments?.[key]),
		),
	);

	return {
		scope,
		resources,
		unknown: resources.length === 0,
	};
}

export function haveIndependentWriteSets(
	left: Pick<SubTask, "arguments" | "writeScope">,
	right: Pick<SubTask, "arguments" | "writeScope">,
): boolean {
	const leftSet = getStepWriteSet(left as SubTask);
	const rightSet = getStepWriteSet(right as SubTask);

	if (leftSet.scope === "none" || rightSet.scope === "none") {
		return true;
	}

	if (leftSet.scope !== rightSet.scope) {
		return true;
	}

	if (leftSet.unknown || rightSet.unknown) {
		return false;
	}

	const rightResources = new Set(rightSet.resources);
	return leftSet.resources.every((resource) => !rightResources.has(resource));
}
