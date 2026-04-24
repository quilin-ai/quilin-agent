import { normalizeSubTask, replacePlanSubtree } from "./decompose.js";
import type { PlanningEvent } from "./state.js";
import type {
	LinearPlan,
	MemoryWriteScope,
	Plan,
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

export type GlobalReplanReason =
	| "goal_drift"
	| "budget_pressure"
	| "repeated_local_repair"
	| "external_context_changed"
	| "manual_request";

export interface GlobalReplanTrigger {
	readonly reason: GlobalReplanReason;
	readonly currentLeafId?: string | null;
	readonly note?: string;
	readonly production?: boolean;
}

export interface GlobalPlanPatch {
	readonly level: "G-Replan";
	readonly reason: GlobalReplanReason;
	readonly note?: string;
	readonly plan: Plan;
	readonly previousPlan: Plan;
	readonly currentLeafId: string | null;
	readonly production: boolean;
	readonly metric: GlobalReplanMetricObservation;
}

export interface GlobalReplanMetricObservation {
	readonly kind: "global_replan_triggered";
	readonly reason: GlobalReplanReason;
	readonly production: boolean;
}

export interface GlobalReplanRateMetrics {
	readonly totalRuns: number;
	readonly globalReplanTriggers: number;
	readonly triggerRate: number;
	readonly productionRuns: number;
	readonly productionGlobalReplanTriggers: number;
	readonly productionTriggerRate: number;
	readonly productionTargetRate: number;
	readonly productionTargetMet: boolean;
}

export interface GlobalReplanRateOptions {
	readonly productionTargetRate?: number;
}

export interface GlobalReplanRunSample {
	readonly hadGlobalReplan: boolean;
	readonly production?: boolean;
}

export const DEFAULT_GLOBAL_REPLAN_PRODUCTION_TARGET_RATE = 0.05;

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
			change.skillHint === null
				? undefined
				: (change.skillHint ?? step.skillHint),
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

function normalizeRate(value: number | undefined): number {
	const resolved = value ?? DEFAULT_GLOBAL_REPLAN_PRODUCTION_TARGET_RATE;
	if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
		throw new RangeError("productionTargetRate must be between 0 and 1");
	}
	return resolved;
}

export function applyGlobalReplan(
	previousPlan: Plan,
	nextPlan: Plan,
	trigger: GlobalReplanTrigger,
): GlobalPlanPatch {
	return {
		level: "G-Replan",
		reason: trigger.reason,
		note: trigger.note,
		plan: nextPlan,
		previousPlan,
		currentLeafId: trigger.currentLeafId ?? null,
		production: trigger.production ?? false,
		metric: {
			kind: "global_replan_triggered",
			reason: trigger.reason,
			production: trigger.production ?? false,
		},
	};
}

export function toReplanEventPayload(
	patch: LocalPlanPatch | GlobalPlanPatch,
): Extract<PlanningEvent, { readonly kind: "replan" }>["payload"] {
	if (patch.level === "G-Replan") {
		return {
			plan: patch.plan,
			currentLeafId: patch.currentLeafId,
			reason: patch.reason,
			note: patch.note,
			production: patch.production,
			metric: patch.metric,
		};
	}

	return {
		plan: patch.plan,
		currentLeafId: patch.currentLeafId,
	};
}

export function computeGlobalReplanRate(
	samples: ReadonlyArray<GlobalReplanRunSample>,
	options: GlobalReplanRateOptions = {},
): GlobalReplanRateMetrics {
	const productionTargetRate = normalizeRate(options.productionTargetRate);
	const globalReplanTriggers = samples.filter(
		(sample) => sample.hadGlobalReplan,
	).length;
	const productionSamples = samples.filter(
		(sample) => sample.production === true,
	);
	const productionGlobalReplanTriggers = productionSamples.filter(
		(sample) => sample.hadGlobalReplan,
	).length;

	return {
		totalRuns: samples.length,
		globalReplanTriggers,
		triggerRate:
			samples.length === 0 ? 0 : globalReplanTriggers / samples.length,
		productionRuns: productionSamples.length,
		productionGlobalReplanTriggers,
		productionTriggerRate:
			productionSamples.length === 0
				? 0
				: productionGlobalReplanTriggers / productionSamples.length,
		productionTargetRate,
		productionTargetMet:
			productionSamples.length === 0
				? true
				: productionGlobalReplanTriggers / productionSamples.length <=
					productionTargetRate,
	};
}
