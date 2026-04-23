import { describe, expect, it, vi } from "vitest";
import {
	createTaskHash,
	DEFAULT_EXECUTOR_MAX_STEPS,
	LinearPlanExecutor,
} from "./executor.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type {
	IntentClassification,
	LinearPlan,
	PlanningEvent,
	SubTask,
} from "./index.js";

function makeStep(id: string, action = "web_search"): SubTask {
	return {
		id,
		action,
		name: `Step ${id}`,
		description: `Execute ${id}`,
		estimatedTokens: 120,
		estimatedSteps: 1,
		preconditions: [],
		effects: [`done:${id}`],
		writeScope: "working",
		risk: "low",
		arguments: { query: `payload:${id}` },
	};
}

function makePlan(count = 3): LinearPlan {
	return {
		kind: "linear",
		subtasks: Array.from({ length: count }, (_, index) =>
			makeStep(`step-${index + 1}`),
		),
	};
}

const MULTI_STEP_INTENT: IntentClassification = {
	intent: "MULTI_STEP",
	confidence: 1,
	source: "structural",
	latencyMs: 12,
};

describe("createTaskHash", () => {
	it("is stable for the same task + action shape", () => {
		const plan = makePlan(2);
		expect(createTaskHash("compare competitors", plan)).toBe(
			createTaskHash("compare competitors", plan),
		);
	});
});

describe("LinearPlanExecutor", () => {
	it("runs a linear plan end-to-end and emits per-step events", async () => {
		const emittedEvents: PlanningEvent[] = [];
		const checkpointWriter = vi.fn(async ({ eventSeq }) => ({
			id: `ckpt-${eventSeq}`,
			storageRef: `episodic://planning/${eventSeq}`,
		}));
		const handler = vi.fn(
			async (toolCall: ToolCall): Promise<ToolResult> => ({
				toolCallId: toolCall.id,
				content: JSON.stringify({ ok: toolCall.arguments.query }),
				isError: false,
			}),
		);
		const executor = new LinearPlanExecutor({
			tools: { web_search: handler },
			checkpointWriter,
			onEvent: (event) => emittedEvents.push(event),
			now: (() => {
				let current = 10_000;
				return () => {
					current += 1;
					return current;
				};
			})(),
		});

		const result = await executor.execute({
			runId: "run-success",
			task: "Compare competitor agents",
			intent: MULTI_STEP_INTENT,
			plan: makePlan(3),
		});

		expect(handler).toHaveBeenCalledTimes(3);
		expect(checkpointWriter).toHaveBeenCalledTimes(3);
		expect(result.haltedOnError).toBe(false);
		expect(result.terminatedReason).toBe("Success");
		expect(result.outputs).toHaveLength(3);
		expect(result.state.phase).toBe("terminated");
		expect(result.state.events.at(-1)).toMatchObject({
			kind: "terminated",
			payload: { reason: "Success" },
		});
		expect(emittedEvents.filter((event) => event.kind === "subtask_started")).toHaveLength(
			3,
		);
		expect(emittedEvents.filter((event) => event.kind === "tool_called")).toHaveLength(
			3,
		);
		expect(emittedEvents.filter((event) => event.kind === "tool_returned")).toHaveLength(
			3,
		);
		expect(emittedEvents.filter((event) => event.kind === "subtask_done")).toHaveLength(
			3,
		);
	});

	it("writes tool_returned + local_repair when a step fails", async () => {
		const handler = vi.fn(
			async (toolCall: ToolCall): Promise<ToolResult> => ({
				toolCallId: toolCall.id,
				content: JSON.stringify({ error: "downstream failed" }),
				isError: toolCall.arguments.query === "payload:step-2",
			}),
		);
		const executor = new LinearPlanExecutor({
			tools: { web_search: handler },
		});

		const result = await executor.execute({
			runId: "run-repair",
			task: "Compare competitor agents",
			plan: makePlan(3),
		});

		expect(result.haltedOnError).toBe(true);
		expect(result.outputs).toHaveLength(1);
		expect(result.state.phase).toBe("repairing");
		expect(result.state.events).toContainEqual(
			expect.objectContaining({
				kind: "tool_returned",
				payload: expect.objectContaining({
					toolCallId: "run-repair:step-2:2",
					isError: true,
					leafId: "step-2",
				}),
			}),
		);
		expect(result.state.events).toContainEqual(
			expect.objectContaining({
				kind: "local_repair",
				payload: {
					leafId: "step-2",
					note: "tool_failed:web_search",
				},
			}),
		);
	});

	it("emits checkpoint_failed with the frozen payload shape on writer errors", async () => {
		const executor = new LinearPlanExecutor({
			tools: {
				web_search: async (toolCall) => ({
					toolCallId: toolCall.id,
					content: "ok",
					isError: false,
				}),
			},
			checkpointWriter: vi.fn(async () => {
				throw new Error("OMEM write failed");
			}),
			now: (() => {
				let current = 20_000;
				return () => {
					current += 5;
					return current;
				};
			})(),
		});

		const result = await executor.execute({
			runId: "run-ckpt-fail",
			task: "Persist checkpoints",
			plan: makePlan(1),
		});

		const failedEvent = result.state.events.find(
			(event) => event.kind === "checkpoint_failed",
		);

		expect(failedEvent).toMatchObject({
			kind: "checkpoint_failed",
			payload: {
				run_id: "run-ckpt-fail",
				phase: "executing",
				task_hash: createTaskHash("Persist checkpoints", makePlan(1)),
				error_code: "OMEM_WRITE_FAILED",
				ts: 20_030,
			},
		});
		expect(JSON.stringify(failedEvent)).not.toContain("storageRef");
	});

	it("stops at the M0 hard cap of 20 steps", async () => {
		const executor = new LinearPlanExecutor({
			tools: {
				web_search: async (toolCall) => ({
					toolCallId: toolCall.id,
					content: "ok",
					isError: false,
				}),
			},
			maxSteps: DEFAULT_EXECUTOR_MAX_STEPS,
		});

		const result = await executor.execute({
			runId: "run-max-steps",
			task: "Too many steps",
			plan: makePlan(DEFAULT_EXECUTOR_MAX_STEPS + 1),
		});

		expect(result.terminatedReason).toBe("MaxSteps");
		expect(result.state.events.at(-1)).toMatchObject({
			kind: "terminated",
			payload: { reason: "MaxSteps" },
		});
	});
});
