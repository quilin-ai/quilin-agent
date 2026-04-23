import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTOR_MAX_STEPS } from "./executor.js";
import {
	DEAD_LOOP_FIXTURE,
	detectTermination,
	replayPlanningEvents,
} from "./termination.js";
import {
	applyEvent,
	createPlanningState,
	type PlanningEvent,
	type PlanningState,
} from "./state.js";
import type { LinearPlan, SubTask } from "./types.js";

function makeStep(id: string): SubTask {
	return {
		id,
		action: "web_search",
		name: `Step ${id}`,
		description: `Execute ${id}`,
		estimatedTokens: 120,
		estimatedSteps: 1,
		preconditions: [],
		effects: [`done:${id}`],
		writeScope: "working",
		risk: "low",
	};
}

function makePlan(count: number): LinearPlan {
	return {
		kind: "linear",
		subtasks: Array.from({ length: count }, (_, index) =>
			makeStep(`step-${index + 1}`),
		),
	};
}

function replay(runId: string, events: readonly PlanningEvent[]): PlanningState {
	return events.reduce(applyEvent, createPlanningState(runId));
}

describe("detectTermination", () => {
	it("detects Success from a completed state", () => {
		const plan = makePlan(2);
		const state = replay("run-success", [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan },
			},
			{
				seq: 2,
				timestamp: 1_010,
				kind: "subtask_started",
				payload: { leafId: "step-1" },
			},
			{
				seq: 3,
				timestamp: 1_020,
				kind: "subtask_done",
				payload: { leafId: "step-1" },
			},
			{
				seq: 4,
				timestamp: 1_030,
				kind: "subtask_started",
				payload: { leafId: "step-2" },
			},
			{
				seq: 5,
				timestamp: 1_040,
				kind: "subtask_done",
				payload: { leafId: "step-2" },
			},
			{
				seq: 6,
				timestamp: 1_050,
				kind: "terminated",
				payload: { reason: "Success" },
			},
		]);

		expect(detectTermination(state)).toEqual({
			shouldTerminate: true,
			reason: "Success",
			stepCount: 2,
			deadLoop: {
				detected: false,
				leafId: null,
				repairs: 0,
			},
		});
	});

	it("detects MaxSteps once the started-step count reaches the M0 cap", () => {
		const events: PlanningEvent[] = [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan: makePlan(DEFAULT_EXECUTOR_MAX_STEPS + 1) },
			},
		];

		for (let index = 0; index < DEFAULT_EXECUTOR_MAX_STEPS; index += 1) {
			events.push({
				seq: index + 2,
				timestamp: 1_010 + index,
				kind: "subtask_started",
				payload: { leafId: `step-${index + 1}` },
			});
		}

		const state = replay("run-max", events);

		expect(detectTermination(state)).toMatchObject({
			shouldTerminate: true,
			reason: "MaxSteps",
			stepCount: DEFAULT_EXECUTOR_MAX_STEPS,
		});
	});

	it("detects UserInterrupt from an explicit external signal", () => {
		const state = replay("run-user-interrupt", [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan: makePlan(1) },
			},
			{
				seq: 2,
				timestamp: 1_010,
				kind: "subtask_started",
				payload: { leafId: "step-1" },
			},
		]);

		expect(detectTermination(state, { userInterrupted: true })).toMatchObject({
			shouldTerminate: true,
			reason: "UserInterrupt",
			stepCount: 1,
		});
	});

	it("hits the dead-loop fixture once repairs repeat on the same leaf", () => {
		const state = replayPlanningEvents("run-dead-loop", DEAD_LOOP_FIXTURE);
		const decision = detectTermination(state);

		expect(decision).toEqual({
			shouldTerminate: true,
			reason: "DeadLoop",
			stepCount: 3,
			deadLoop: {
				detected: true,
				leafId: "step-loop",
				repairs: 3,
			},
		});
	});
});
