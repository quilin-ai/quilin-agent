import type { ToolCall } from "../tools/types.js";
import type { IntentClassification, Plan } from "./types.js";

export interface BudgetLedger {
	readonly tokenSpent: number;
	readonly tokenBudget: number;
	readonly turnSpent: number;
	readonly turnBudget: number;
	readonly retryTokenSpent: number;
	readonly retryTokenBudget: number;
	readonly stepSpent: number;
	readonly stepBudget: number;
}

export type PlanPhase =
	| "classifying"
	| "decomposing"
	| "executing"
	| "repairing"
	| "replanning"
	| "terminated";

export interface Checkpoint {
	readonly id: string;
	readonly atEventSeq: number;
	readonly stateSnapshot: PlanningState;
	readonly storageRef: string;
}

export interface CheckpointFailedPayload {
	readonly run_id: string;
	readonly phase: PlanPhase;
	readonly task_hash: string;
	readonly error_code: string;
	readonly ts: number;
}

export type PlanningEvent =
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "intent_classified";
			readonly payload: IntentClassification;
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "task_decomposed";
			readonly payload: { readonly plan: Plan };
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "subtask_started" | "subtask_done";
			readonly payload: { readonly leafId: string };
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "tool_called";
			readonly payload: { readonly toolCall: ToolCall; readonly leafId?: string };
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "tool_returned";
			readonly payload: {
				readonly toolCallId: string;
				readonly isError: boolean;
				readonly leafId?: string;
			};
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "local_repair";
			readonly payload: { readonly leafId: string; readonly note?: string };
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "replan";
			readonly payload: {
				readonly plan: Plan;
				readonly currentLeafId?: string | null;
			};
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "checkpoint_saved";
			readonly payload: Checkpoint;
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "checkpoint_failed";
			readonly payload: CheckpointFailedPayload;
	  }
	| {
			readonly seq: number;
			readonly timestamp: number;
			readonly kind: "terminated";
			readonly payload: { readonly reason: string };
	  };

export interface PlanningState {
	readonly runId: string;
	readonly intent: IntentClassification | null;
	readonly plan: Plan | null;
	readonly currentLeafId: string | null;
	readonly phase: PlanPhase;
	readonly budget: BudgetLedger;
	readonly events: ReadonlyArray<PlanningEvent>;
	readonly checkpoints: ReadonlyArray<Checkpoint>;
}

const EMPTY_BUDGET: BudgetLedger = {
	tokenSpent: 0,
	tokenBudget: 0,
	turnSpent: 0,
	turnBudget: 0,
	retryTokenSpent: 0,
	retryTokenBudget: 0,
	stepSpent: 0,
	stepBudget: 0,
};

export function createPlanningState(
	runId: string,
	budget: BudgetLedger = EMPTY_BUDGET,
): PlanningState {
	return {
		runId,
		intent: null,
		plan: null,
		currentLeafId: null,
		phase: "classifying",
		budget,
		events: [],
		checkpoints: [],
	};
}

function phaseForIntent(intent: IntentClassification["intent"]): PlanPhase {
	return intent === "MULTI_STEP" ? "decomposing" : "executing";
}

export function applyEvent(
	state: PlanningState,
	event: PlanningEvent,
): PlanningState {
	const events = [...state.events, event];

	switch (event.kind) {
		case "intent_classified":
			return {
				...state,
				intent: event.payload,
				phase: phaseForIntent(event.payload.intent),
				events,
			};
		case "task_decomposed":
			return {
				...state,
				plan: event.payload.plan,
				phase: "executing",
				events,
			};
		case "subtask_started":
			return {
				...state,
				currentLeafId: event.payload.leafId,
				phase: "executing",
				events,
			};
		case "subtask_done":
			return {
				...state,
				currentLeafId:
					state.currentLeafId === event.payload.leafId
						? null
						: state.currentLeafId,
				phase: "executing",
				events,
			};
		case "tool_called":
		case "tool_returned":
			return { ...state, phase: "executing", events };
		case "local_repair":
			return {
				...state,
				currentLeafId: event.payload.leafId,
				phase: "repairing",
				events,
			};
		case "replan":
			return {
				...state,
				plan: event.payload.plan,
				currentLeafId: event.payload.currentLeafId ?? null,
				phase: "replanning",
				events,
			};
		case "checkpoint_saved":
			return {
				...state,
				checkpoints: [...state.checkpoints, event.payload],
				events,
			};
		case "checkpoint_failed":
			return {
				...state,
				events,
			};
		case "terminated":
			return {
				...state,
				currentLeafId: null,
				phase: "terminated",
				events,
			};
	}
}
