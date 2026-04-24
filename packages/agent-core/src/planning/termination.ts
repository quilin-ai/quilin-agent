import { DEFAULT_EXECUTOR_MAX_STEPS } from "./executor.js";
import {
	applyEvent,
	createPlanningState,
	type PlanningEvent,
	type PlanningState,
} from "./state.js";

export const DEFAULT_DEAD_LOOP_REPAIR_THRESHOLD = 3;

export type TerminationReason =
	| "Success"
	| "MaxSteps"
	| "UserInterrupt"
	| "DeadLoop"
	| "InProgress";

export interface DeadLoopSignal {
	readonly detected: boolean;
	readonly leafId: string | null;
	readonly repairs: number;
}

export interface TerminationDecision {
	readonly shouldTerminate: boolean;
	readonly reason: TerminationReason;
	readonly stepCount: number;
	readonly deadLoop: DeadLoopSignal;
}

export interface TerminationOptions {
	readonly maxSteps?: number;
	readonly userInterrupted?: boolean;
	readonly deadLoopRepairThreshold?: number;
}

export function replayPlanningEvents(
	runId: string,
	events: readonly PlanningEvent[],
): PlanningState {
	return events.reduce(applyEvent, createPlanningState(runId));
}

function countStartedSteps(state: PlanningState): number {
	return state.events.filter((event) => event.kind === "subtask_started")
		.length;
}

function lastTerminationReason(state: PlanningState): string | null {
	for (let index = state.events.length - 1; index >= 0; index -= 1) {
		const event = state.events[index];
		if (event?.kind === "terminated") {
			return event.payload.reason;
		}
	}
	return null;
}

function detectDeadLoop(
	state: PlanningState,
	threshold: number,
): DeadLoopSignal {
	const repairCounts = new Map<string, number>();

	for (const event of state.events) {
		if (event.kind === "subtask_done") {
			repairCounts.delete(event.payload.leafId);
			continue;
		}

		if (event.kind !== "local_repair") {
			continue;
		}

		const repairs = (repairCounts.get(event.payload.leafId) ?? 0) + 1;
		repairCounts.set(event.payload.leafId, repairs);

		if (repairs >= threshold) {
			return {
				detected: true,
				leafId: event.payload.leafId,
				repairs,
			};
		}
	}

	return {
		detected: false,
		leafId: null,
		repairs: 0,
	};
}

export function detectTermination(
	state: PlanningState,
	options: TerminationOptions = {},
): TerminationDecision {
	const maxSteps = options.maxSteps ?? DEFAULT_EXECUTOR_MAX_STEPS;
	const deadLoopThreshold =
		options.deadLoopRepairThreshold ?? DEFAULT_DEAD_LOOP_REPAIR_THRESHOLD;
	const stepCount = countStartedSteps(state);
	const deadLoop = detectDeadLoop(state, deadLoopThreshold);
	const explicitReason = lastTerminationReason(state);

	if (options.userInterrupted === true || explicitReason === "UserInterrupt") {
		return {
			shouldTerminate: true,
			reason: "UserInterrupt",
			stepCount,
			deadLoop,
		};
	}

	if (explicitReason === "Success") {
		return {
			shouldTerminate: true,
			reason: "Success",
			stepCount,
			deadLoop,
		};
	}

	if (explicitReason === "MaxSteps" || stepCount >= maxSteps) {
		return {
			shouldTerminate: true,
			reason: "MaxSteps",
			stepCount,
			deadLoop,
		};
	}

	if (deadLoop.detected) {
		return {
			shouldTerminate: true,
			reason: "DeadLoop",
			stepCount,
			deadLoop,
		};
	}

	return {
		shouldTerminate: false,
		reason: "InProgress",
		stepCount,
		deadLoop,
	};
}
