import type { PlanningEvent } from "../state.js";
import type { Plan } from "../types.js";
import type { LocalPlanPatch } from "./local.js";

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

export interface GlobalReplanMetricObservation {
	readonly kind: "global_replan_triggered";
	readonly reason: GlobalReplanReason;
	readonly production: boolean;
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
