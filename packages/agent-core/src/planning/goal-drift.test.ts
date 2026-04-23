import { describe, expect, it } from "vitest";
import { applyEvent, createPlanningState } from "./state.js";
import {
	createGoalDriftEvent,
	detectGoalDrift,
	DEFAULT_GOAL_DRIFT_THRESHOLD,
} from "./goal-drift.js";
import type { PlanningEvent, PlanningState } from "./index.js";

function makeState(
	stepCount: number,
	priorWarnings = 0,
): PlanningState {
	let state = createPlanningState("run-drift");
	let seq = 0;

	for (let index = 0; index < stepCount; index += 1) {
		seq += 1;
		state = applyEvent(state, {
			seq,
			timestamp: 1_000 + seq,
			kind: "subtask_started",
			payload: { leafId: `step-${index + 1}` },
		});
	}

	for (let index = 0; index < priorWarnings; index += 1) {
		seq += 1;
		state = applyEvent(state, {
			seq,
			timestamp: 2_000 + seq,
			kind: "goal_drift_detected",
			payload: {
				run_id: "run-drift",
				similarity: 0.4,
				threshold: DEFAULT_GOAL_DRIFT_THRESHOLD,
				step_count: (index + 1) * 5,
				warning_count: index + 1,
				current_leaf_id: `step-${Math.max(1, (index + 1) * 5)}`,
				should_replan: false,
				reason: "similarity_below_threshold",
			},
		});
	}

	return state;
}

describe("detectGoalDrift", () => {
	it("skips evaluation before the default five-step cadence", () => {
		expect(detectGoalDrift(makeState(4), 0.1)).toEqual({
			checked: false,
			drifted: false,
			shouldReplan: false,
			similarity: 0.1,
			threshold: DEFAULT_GOAL_DRIFT_THRESHOLD,
			stepCount: 4,
			warningCount: 0,
			currentLeafId: "step-4",
			reason: null,
		});
	});

	it("does not trigger when the similarity stays above the threshold", () => {
		expect(detectGoalDrift(makeState(5), 0.9)).toEqual({
			checked: true,
			drifted: false,
			shouldReplan: false,
			similarity: 0.9,
			threshold: DEFAULT_GOAL_DRIFT_THRESHOLD,
			stepCount: 5,
			warningCount: 0,
			currentLeafId: "step-5",
			reason: null,
		});
	});

	it("creates an episodic-safe drift event when similarity drops below 0.65", () => {
		const state = makeState(5);
		const decision = detectGoalDrift(state, 0.64);
		const event = createGoalDriftEvent(state, decision, () => 9_999);

		expect(decision).toEqual({
			checked: true,
			drifted: true,
			shouldReplan: false,
			similarity: 0.64,
			threshold: DEFAULT_GOAL_DRIFT_THRESHOLD,
			stepCount: 5,
			warningCount: 1,
			currentLeafId: "step-5",
			reason: "similarity_below_threshold",
		});
		expect(event).toEqual({
			seq: 6,
			timestamp: 9_999,
			kind: "goal_drift_detected",
			payload: {
				run_id: "run-drift",
				similarity: 0.64,
				threshold: DEFAULT_GOAL_DRIFT_THRESHOLD,
				step_count: 5,
				warning_count: 1,
				current_leaf_id: "step-5",
				should_replan: false,
				reason: "similarity_below_threshold",
			},
		});
	});

	it("escalates to replan after the third warning and supports configurable thresholds", () => {
		const state = makeState(10, 2);

		expect(
			detectGoalDrift(state, 0.74, {
				threshold: 0.75,
				checkInterval: 5,
				warningLimit: 3,
			}),
		).toEqual({
			checked: true,
			drifted: true,
			shouldReplan: true,
			similarity: 0.74,
			threshold: 0.75,
			stepCount: 10,
			warningCount: 3,
			currentLeafId: "step-10",
			reason: "warning_limit_reached",
		});
	});
});
