import { describe, expect, expectTypeOf, it } from "vitest";
import {
	applyEvent,
	createPlanningState,
	type CheckpointFailedPayload,
	type PlanningEvent,
	type PlanningState,
} from "./state.js";
import type { LinearPlan } from "./types.js";

function makePlan(): LinearPlan {
	return {
		kind: "linear",
		subtasks: [
			{
				id: "step-1",
				action: "read_context",
				name: "Collect context",
				description: "Read the task inputs",
				estimatedTokens: 120,
				estimatedSteps: 1,
				preconditions: [],
				effects: ["context_collected"],
				writeScope: "none",
				risk: "low",
			},
		],
	};
}

describe("applyEvent", () => {
	it("replays events as a pure reducer", () => {
		const plan = makePlan();
		const events: readonly PlanningEvent[] = [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "intent_classified",
				payload: {
					intent: "MULTI_STEP",
					confidence: 1,
					source: "structural",
					latencyMs: 42,
				},
			},
			{
				seq: 2,
				timestamp: 1_100,
				kind: "task_decomposed",
				payload: { plan },
			},
			{
				seq: 3,
				timestamp: 1_200,
				kind: "subtask_started",
				payload: { leafId: "step-1" },
			},
			{
				seq: 4,
				timestamp: 1_300,
				kind: "subtask_done",
				payload: { leafId: "step-1" },
			},
			{
				seq: 5,
				timestamp: 1_400,
				kind: "terminated",
				payload: { reason: "finished" },
			},
		];

		const state = events.reduce(applyEvent, createPlanningState("run-1"));

		expect(state.intent).toEqual(events[0]?.payload);
		expect(state.plan).toEqual(plan);
		expect(state.currentLeafId).toBeNull();
		expect(state.phase).toBe("terminated");
		expect(state.events).toEqual(events);
	});

	it("returns a new state and keeps the previous state unchanged", () => {
		const initial = createPlanningState("run-immut");
		const event: PlanningEvent = {
			seq: 1,
			timestamp: 2_000,
			kind: "intent_classified",
			payload: {
				intent: "SINGLE_TOOL",
				confidence: 0.8,
				source: "audit",
				latencyMs: 55,
				reasoningDigest: "Use a single tool call.",
			},
		};

		const next = applyEvent(initial, event);

		expect(next).not.toBe(initial);
		expect(next.events).not.toBe(initial.events);
		expect(initial.intent).toBeNull();
		expect(initial.phase).toBe("classifying");
		expect(initial.events).toEqual([]);
		expect(next.intent).toEqual(event.payload);
		expect(next.phase).toBe("executing");
	});

	it("records checkpoint_failed as an independent event without mutating checkpoints", () => {
		const initial = createPlanningState("run-checkpoint");
		const payload: CheckpointFailedPayload = {
			run_id: "run-checkpoint",
			phase: "executing",
			task_hash: "task-abc",
			error_code: "OMEM_WRITE_FAILED",
			ts: 1_717_171_717,
		};
		const event: PlanningEvent = {
			seq: 1,
			timestamp: payload.ts,
			kind: "checkpoint_failed",
			payload,
		};

		const next = applyEvent(initial, event);

		expect(next.checkpoints).toEqual([]);
		expect(next.events).toEqual([event]);
		expect(next.events[0]).toMatchObject({
			kind: "checkpoint_failed",
			payload: {
				run_id: "run-checkpoint",
				phase: "executing",
				task_hash: "task-abc",
				error_code: "OMEM_WRITE_FAILED",
				ts: 1_717_171_717,
			},
		});
	});

	it("freezes the state contract as readonly arrays", () => {
		expectTypeOf<PlanningState["events"]>().toEqualTypeOf<
			ReadonlyArray<PlanningEvent>
		>();
	});
});
