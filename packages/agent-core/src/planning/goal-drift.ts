import type {
	GoalDriftDetectedPayload,
	PlanningEvent,
	PlanningState,
} from "./state.js";

export const DEFAULT_GOAL_DRIFT_THRESHOLD = 0.65;
export const DEFAULT_GOAL_DRIFT_CHECK_INTERVAL = 5;
export const DEFAULT_GOAL_DRIFT_WARNING_LIMIT = 3;

export interface GoalDriftOptions {
	readonly threshold?: number;
	readonly checkInterval?: number;
	readonly warningLimit?: number;
}

export interface GoalDriftDecision {
	readonly checked: boolean;
	readonly drifted: boolean;
	readonly shouldReplan: boolean;
	readonly similarity: number;
	readonly threshold: number;
	readonly stepCount: number;
	readonly warningCount: number;
	readonly currentLeafId: string | null;
	readonly reason: string | null;
}

function normalizeProbability(
	value: number | undefined,
	fallback: number,
	field: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
		throw new RangeError(`${field} must be a number between 0 and 1`);
	}
	return resolved;
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

function countStartedSteps(state: PlanningState): number {
	return state.events.filter((event) => event.kind === "subtask_started")
		.length;
}

export function countGoalDriftWarnings(state: PlanningState): number {
	return state.events.filter((event) => event.kind === "goal_drift_detected")
		.length;
}

export function detectGoalDrift(
	state: PlanningState,
	similarity: number,
	options: GoalDriftOptions = {},
): GoalDriftDecision {
	const threshold = normalizeProbability(
		options.threshold,
		DEFAULT_GOAL_DRIFT_THRESHOLD,
		"threshold",
	);
	const checkInterval = normalizePositiveInteger(
		options.checkInterval,
		DEFAULT_GOAL_DRIFT_CHECK_INTERVAL,
		"checkInterval",
	);
	const warningLimit = normalizePositiveInteger(
		options.warningLimit,
		DEFAULT_GOAL_DRIFT_WARNING_LIMIT,
		"warningLimit",
	);
	const normalizedSimilarity = normalizeProbability(
		similarity,
		similarity,
		"similarity",
	);
	const stepCount = countStartedSteps(state);
	const checked = stepCount > 0 && stepCount % checkInterval === 0;
	const priorWarnings = countGoalDriftWarnings(state);

	if (!checked) {
		return {
			checked: false,
			drifted: false,
			shouldReplan: false,
			similarity: normalizedSimilarity,
			threshold,
			stepCount,
			warningCount: priorWarnings,
			currentLeafId: state.currentLeafId,
			reason: null,
		};
	}

	const drifted = normalizedSimilarity < threshold;
	const warningCount = drifted ? priorWarnings + 1 : priorWarnings;
	const shouldReplan = drifted && warningCount >= warningLimit;

	return {
		checked: true,
		drifted,
		shouldReplan,
		similarity: normalizedSimilarity,
		threshold,
		stepCount,
		warningCount,
		currentLeafId: state.currentLeafId,
		reason: !drifted
			? null
			: shouldReplan
				? "warning_limit_reached"
				: "similarity_below_threshold",
	};
}

export function createGoalDriftEvent(
	state: PlanningState,
	decision: GoalDriftDecision,
	now: () => number = Date.now,
): PlanningEvent {
	if (!decision.checked || !decision.drifted) {
		throw new Error("goal drift event requires a checked drift decision");
	}

	const payload: GoalDriftDetectedPayload = {
		run_id: state.runId,
		similarity: decision.similarity,
		threshold: decision.threshold,
		step_count: decision.stepCount,
		warning_count: decision.warningCount,
		current_leaf_id: decision.currentLeafId,
		should_replan: decision.shouldReplan,
		reason: decision.reason ?? "goal_drift_detected",
	};

	return {
		seq: state.events.length + 1,
		timestamp: now(),
		kind: "goal_drift_detected",
		payload,
	};
}
