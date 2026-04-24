import type { PlanningEvent } from "../state.js";
import type { LinearPlan, SubTask } from "../types.js";

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

function makeDeadLoopPlan(): LinearPlan {
	return {
		kind: "linear",
		subtasks: [makeStep("step-loop")],
	};
}

export const DEAD_LOOP_FIXTURE: readonly PlanningEvent[] = [
	{
		seq: 1,
		timestamp: 1_000,
		kind: "task_decomposed",
		payload: { plan: makeDeadLoopPlan() },
	},
	{
		seq: 2,
		timestamp: 1_010,
		kind: "subtask_started",
		payload: { leafId: "step-loop" },
	},
	{
		seq: 3,
		timestamp: 1_020,
		kind: "tool_called",
		payload: {
			leafId: "step-loop",
			toolCall: {
				id: "tool-1",
				name: "web_search",
				arguments: { query: "competitor loop" },
			},
		},
	},
	{
		seq: 4,
		timestamp: 1_030,
		kind: "tool_returned",
		payload: {
			toolCallId: "tool-1",
			isError: true,
			leafId: "step-loop",
		},
	},
	{
		seq: 5,
		timestamp: 1_040,
		kind: "local_repair",
		payload: {
			leafId: "step-loop",
			note: "tool_failed:web_search",
		},
	},
	{
		seq: 6,
		timestamp: 1_050,
		kind: "subtask_started",
		payload: { leafId: "step-loop" },
	},
	{
		seq: 7,
		timestamp: 1_060,
		kind: "tool_called",
		payload: {
			leafId: "step-loop",
			toolCall: {
				id: "tool-2",
				name: "web_search",
				arguments: { query: "competitor loop" },
			},
		},
	},
	{
		seq: 8,
		timestamp: 1_070,
		kind: "tool_returned",
		payload: {
			toolCallId: "tool-2",
			isError: true,
			leafId: "step-loop",
		},
	},
	{
		seq: 9,
		timestamp: 1_080,
		kind: "local_repair",
		payload: {
			leafId: "step-loop",
			note: "tool_failed:web_search",
		},
	},
	{
		seq: 10,
		timestamp: 1_090,
		kind: "subtask_started",
		payload: { leafId: "step-loop" },
	},
	{
		seq: 11,
		timestamp: 1_100,
		kind: "tool_called",
		payload: {
			leafId: "step-loop",
			toolCall: {
				id: "tool-3",
				name: "web_search",
				arguments: { query: "competitor loop" },
			},
		},
	},
	{
		seq: 12,
		timestamp: 1_110,
		kind: "tool_returned",
		payload: {
			toolCallId: "tool-3",
			isError: true,
			leafId: "step-loop",
		},
	},
	{
		seq: 13,
		timestamp: 1_120,
		kind: "local_repair",
		payload: {
			leafId: "step-loop",
			note: "tool_failed:web_search",
		},
	},
] as const;
