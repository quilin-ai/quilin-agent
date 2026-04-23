import {
	normalizeSubTask,
	replacePlanSubtree,
} from "./decompose.js";
import type {
	LinearPlan,
	MemoryWriteScope,
	RiskLevel,
	SubTask,
} from "./types.js";

export interface LeafChange {
	readonly action?: string;
	readonly name?: string;
	readonly description?: string;
	readonly estimatedTokens?: number;
	readonly estimatedSteps?: number;
	readonly preconditions?: ReadonlyArray<string>;
	readonly effects?: ReadonlyArray<string>;
	readonly skillHint?: string | null;
	readonly arguments?: Readonly<Record<string, unknown>>;
	readonly writeScope?: MemoryWriteScope;
	readonly risk?: RiskLevel;
}

export type LocalReplanTrigger =
	| {
			readonly kind: "tool_failed";
			readonly leafId: string;
			readonly errorCode: string;
			readonly changes: LeafChange;
	  }
	| {
			readonly kind: "precondition_missing";
			readonly leafId: string;
			readonly missing: ReadonlyArray<string>;
			readonly providerLeafId: string;
	  }
	| {
			readonly kind: "retry_exhausted";
			readonly leafId: string;
			readonly retries: number;
			readonly changes: LeafChange;
	  };

export type LocalPlanOperation =
	| {
			readonly kind: "replace_leaf";
			readonly leafId: string;
			readonly nextLeaf: SubTask;
	  }
	| {
			readonly kind: "move_before";
			readonly movedLeafId: string;
			readonly beforeLeafId: string;
	  }
	| {
			readonly kind: "replace_subtree";
			readonly leafId: string;
			readonly nextSubtasks: ReadonlyArray<SubTask>;
	  };

export interface LocalPlanPatch {
	readonly level: "L-Rearrange" | "L-Redecompose";
	readonly leafId: string;
	readonly reason: string;
	readonly operations: ReadonlyArray<LocalPlanOperation>;
	readonly plan: LinearPlan;
	readonly currentLeafId: string | null;
}

function findStepIndex(plan: LinearPlan, leafId: string): number {
	const index = plan.subtasks.findIndex((step) => step.id === leafId);
	if (index === -1) {
		throw new Error(`unknown leafId: ${leafId}`);
	}
	return index;
}

function applyLeafChange(step: SubTask, change: LeafChange): SubTask {
	return normalizeSubTask({
		...step,
		action: change.action ?? step.action,
		name: change.name ?? step.name,
		description: change.description ?? step.description,
		estimatedTokens: change.estimatedTokens ?? step.estimatedTokens,
		estimatedSteps: change.estimatedSteps ?? step.estimatedSteps,
		preconditions: change.preconditions ?? step.preconditions,
		effects: change.effects ?? step.effects,
		skillHint:
			change.skillHint === null ? undefined : (change.skillHint ?? step.skillHint),
		arguments: change.arguments ?? step.arguments,
		writeScope: change.writeScope ?? step.writeScope,
		risk: change.risk ?? step.risk,
	});
}

function replaceLeaf(
	plan: LinearPlan,
	leafId: string,
	nextLeaf: SubTask,
): LinearPlan {
	const index = findStepIndex(plan, leafId);

	return {
		kind: "linear",
		subtasks: plan.subtasks.map((step, stepIndex) =>
			stepIndex === index ? nextLeaf : step,
		),
	};
}

function moveLeafBefore(
	plan: LinearPlan,
	movedLeafId: string,
	beforeLeafId: string,
): LinearPlan {
	const movedIndex = findStepIndex(plan, movedLeafId);
	const beforeIndex = findStepIndex(plan, beforeLeafId);
	if (movedIndex === beforeIndex) {
		throw new Error("cannot move a leaf before itself");
	}

	const mutable = [...plan.subtasks];
	const [movedLeaf] = mutable.splice(movedIndex, 1);
	if (movedLeaf == null) {
		throw new Error(`unknown leafId: ${movedLeafId}`);
	}

	const anchorIndex = mutable.findIndex((step) => step.id === beforeLeafId);
	if (anchorIndex === -1) {
		throw new Error(`unknown leafId: ${beforeLeafId}`);
	}

	mutable.splice(anchorIndex, 0, movedLeaf);

	return {
		kind: "linear",
		subtasks: mutable,
	};
}

export function applyLocalRearrange(
	plan: LinearPlan,
	trigger: LocalReplanTrigger,
): LocalPlanPatch {
	switch (trigger.kind) {
		case "tool_failed": {
			const currentLeaf = plan.subtasks[findStepIndex(plan, trigger.leafId)];
			if (currentLeaf == null) {
				throw new Error(`unknown leafId: ${trigger.leafId}`);
			}

			const nextLeaf = applyLeafChange(currentLeaf, trigger.changes);
			return {
				level: "L-Rearrange",
				leafId: trigger.leafId,
				reason: `tool_failed:${trigger.errorCode}`,
				operations: [
					{
						kind: "replace_leaf",
						leafId: trigger.leafId,
						nextLeaf,
					},
				],
				plan: replaceLeaf(plan, trigger.leafId, nextLeaf),
				currentLeafId: trigger.leafId,
			};
		}
		case "precondition_missing":
			return {
				level: "L-Rearrange",
				leafId: trigger.leafId,
				reason: `missing_precondition:${trigger.missing.join(",")}`,
				operations: [
					{
						kind: "move_before",
						movedLeafId: trigger.providerLeafId,
						beforeLeafId: trigger.leafId,
					},
				],
				plan: moveLeafBefore(plan, trigger.providerLeafId, trigger.leafId),
				currentLeafId: trigger.providerLeafId,
			};
		case "retry_exhausted": {
			const currentLeaf = plan.subtasks[findStepIndex(plan, trigger.leafId)];
			if (currentLeaf == null) {
				throw new Error(`unknown leafId: ${trigger.leafId}`);
			}

			const nextLeaf = applyLeafChange(currentLeaf, trigger.changes);
			return {
				level: "L-Rearrange",
				leafId: trigger.leafId,
				reason: `retry_exhausted:${trigger.retries}`,
				operations: [
					{
						kind: "replace_leaf",
						leafId: trigger.leafId,
						nextLeaf,
					},
				],
				plan: replaceLeaf(plan, trigger.leafId, nextLeaf),
				currentLeafId: trigger.leafId,
			};
		}
	}
}

export function applyLocalRedecompose(
	plan: LinearPlan,
	leafId: string,
	newSubtasks: ReadonlyArray<SubTask>,
): LocalPlanPatch {
	const result = replacePlanSubtree(plan, leafId, newSubtasks);

	return {
		level: "L-Redecompose",
		leafId,
		reason: `redecompose:${leafId}`,
		operations: [
			{
				kind: "replace_subtree",
				leafId,
				nextSubtasks: result.plan.subtasks.filter((step) =>
					result.insertedStepIds.includes(step.id),
				),
			},
		],
		plan: result.plan,
		currentLeafId: result.insertedStepIds[0] ?? null,
	};
}
