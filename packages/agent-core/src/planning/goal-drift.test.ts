import { describe, expect, it } from "vitest";
import {
	createGoalDriftEvent,
	DEFAULT_GOAL_DRIFT_THRESHOLD,
	detectGoalDrift,
} from "./goal-drift.js";
import type { PlanningState } from "./index.js";
import { applyEvent, createPlanningState } from "./state.js";

function makeState(stepCount: number, priorWarnings = 0): PlanningState {
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

	it("rejects invalid probabilities and cadence options", () => {
		expect(() => detectGoalDrift(makeState(5), Number.NaN)).toThrow(
			"similarity must be a number between 0 and 1",
		);
		expect(() => detectGoalDrift(makeState(5), 0.5, { threshold: 2 })).toThrow(
			"threshold must be a number between 0 and 1",
		);
		expect(() =>
			detectGoalDrift(makeState(5), 0.5, { checkInterval: 0 }),
		).toThrow("checkInterval must be a positive integer");
		expect(() =>
			detectGoalDrift(makeState(5), 0.5, { warningLimit: 1.5 }),
		).toThrow("warningLimit must be a positive integer");
	});
});

describe("createGoalDriftEvent", () => {
	it("rejects unchecked or non-drift decisions and falls back to a generic reason", () => {
		const state = makeState(5);
		const unchecked = detectGoalDrift(makeState(4), 0.2);
		const stable = detectGoalDrift(state, 0.9);

		expect(() => createGoalDriftEvent(state, unchecked)).toThrow(
			"goal drift event requires a checked drift decision",
		);
		expect(() => createGoalDriftEvent(state, stable)).toThrow(
			"goal drift event requires a checked drift decision",
		);
		const event = createGoalDriftEvent(
			state,
			{
				...detectGoalDrift(state, 0.2),
				reason: null,
			},
			() => 12_345,
		);
		expect(event.kind).toBe("goal_drift_detected");
		if (event.kind === "goal_drift_detected") {
			expect(event.payload.reason).toBe("goal_drift_detected");
		}
	});
});
