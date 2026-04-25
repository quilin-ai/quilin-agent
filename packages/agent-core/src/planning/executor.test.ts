import { describe, expect, it, vi } from "vitest";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type { ExecutorScratchpadClient } from "./executor.js";
import {
	createTaskHash,
	DEFAULT_EXECUTOR_MAX_STEPS,
	LinearPlanExecutor,
} from "./executor.js";
import type {
	IntentClassification,
	LinearPlan,
	PlanningEvent,
	SubTask,
} from "./index.js";
import { parseLLMPlannerResponse } from "./types.js";

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

function makeScratchpadStep(
	id: string,
	scratchpad: SubTask["scratchpad"],
): SubTask {
	return {
		...makeStep(id),
		scratchpad,
	};
}

class InMemoryExecutorScratchpad implements ExecutorScratchpadClient {
	readonly reads: Array<{
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
	}> = [];
	readonly writes: Array<{
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
		readonly value: string;
	}> = [];
	readonly clears: Array<{
		readonly taskId: string;
		readonly sessionId: string;
		readonly key?: string;
	}> = [];
	private readonly values = new Map<string, string>();

	async read(input: {
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
	}): Promise<string | null> {
		this.reads.push(input);
		return this.values.get(this.storageKey(input)) ?? null;
	}

	async write(input: {
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
		readonly value: string;
	}): Promise<void> {
		this.writes.push(input);
		this.values.set(this.storageKey(input), input.value);
	}

	async clear(input: {
		readonly taskId: string;
		readonly sessionId: string;
		readonly key?: string;
	}): Promise<number> {
		this.clears.push(input);
		if (input.key != null) {
			const key = this.storageKey({
				taskId: input.taskId,
				sessionId: input.sessionId,
				key: input.key,
			});
			const existed = this.values.delete(key);
			return existed ? 1 : 0;
		}

		const prefix = `${input.taskId}:${input.sessionId}:`;
		let cleared = 0;
		for (const key of [...this.values.keys()]) {
			if (key.startsWith(prefix)) {
				this.values.delete(key);
				cleared += 1;
			}
		}
		return cleared;
	}

	seed(input: {
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
		readonly value: string;
	}): void {
		this.values.set(this.storageKey(input), input.value);
	}

	get(input: {
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
	}): string | null {
		return this.values.get(this.storageKey(input)) ?? null;
	}

	private storageKey(input: {
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
	}): string {
		return `${input.taskId}:${input.sessionId}:${input.key}`;
	}
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
	it("accepts optional scratchpad metadata in parsed plan sketches", () => {
		const parsed = parseLLMPlannerResponse({
			planSketch: {
				kind: "linear",
				subtasks: [
					{
						...makeScratchpadStep("step-schema", {
							readKey: "handoff",
							writeKey: "handoff",
							clearOnSuccess: true,
						}),
					},
					makeStep("step-plain"),
				],
			},
		});

		expect(parsed.planSketch?.subtasks[0]?.scratchpad).toEqual({
			readKey: "handoff",
			writeKey: "handoff",
			clearOnSuccess: true,
		});
		expect(parsed.planSketch?.subtasks[1]?.scratchpad).toBeUndefined();
	});

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
		expect(
			emittedEvents.filter((event) => event.kind === "subtask_started"),
		).toHaveLength(3);
		expect(
			emittedEvents.filter((event) => event.kind === "tool_called"),
		).toHaveLength(3);
		expect(
			emittedEvents.filter((event) => event.kind === "tool_returned"),
		).toHaveLength(3);
		expect(
			emittedEvents.filter((event) => event.kind === "subtask_done"),
		).toHaveLength(3);
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

	it("emits repair and termination events when preflight fails", async () => {
		const executor = new LinearPlanExecutor({
			tools: {
				preflight_check: async (toolCall) => ({
					toolCallId: toolCall.id,
					content: JSON.stringify({ error: "missing credential" }),
					isError: true,
				}),
				web_search: async (toolCall) => ({
					toolCallId: toolCall.id,
					content: "ok",
					isError: false,
				}),
			},
		});

		const result = await executor.execute({
			runId: "run-preflight-fail",
			task: "Check environment before plan",
			plan: makePlan(1),
			initialToolCalls: [
				{
					id: "preflight-1",
					name: "preflight_check",
					arguments: {},
				},
			],
		});

		expect(result.haltedOnError).toBe(true);
		expect(result.terminatedReason).toBe("PreflightFailed");
		expect(result.outputs).toHaveLength(0);
		expect(result.preflightOutputs).toHaveLength(1);
		expect(result.state.events).toContainEqual(
			expect.objectContaining({
				kind: "local_repair",
				payload: {
					leafId: "preflight:preflight-1",
					note: "preflight_failed:preflight_check",
				},
			}),
		);
		expect(result.state.events.at(-1)).toMatchObject({
			kind: "terminated",
			payload: { reason: "PreflightFailed" },
		});
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

	it("rejects invalid maxSteps at construction time", () => {
		expect(
			() =>
				new LinearPlanExecutor({
					tools: {},
					maxSteps: 0,
				}),
		).toThrow(/maxSteps/);
	});

	it("halts with TOOL_NOT_FOUND when a step has no registered handler", async () => {
		const executor = new LinearPlanExecutor({
			tools: {},
		});

		const result = await executor.execute({
			runId: "run-missing-tool",
			task: "Call missing tool",
			plan: {
				kind: "linear",
				subtasks: [makeStep("unknown", "missing_tool")],
			},
		});

		expect(result.haltedOnError).toBe(true);
		expect(result.state.events).toContainEqual(
			expect.objectContaining({
				kind: "tool_returned",
				payload: expect.objectContaining({
					toolCallId: "run-missing-tool:unknown:1",
					isError: true,
					leafId: "unknown",
				}),
			}),
		);
		expect(result.state.events).toContainEqual(
			expect.objectContaining({
				kind: "local_repair",
				payload: {
					leafId: "unknown",
					note: "tool_failed:missing_tool",
				},
			}),
		);
	});

	it("passes scratchpad state through a long-running linear fixture", async () => {
		const stepCount = 55;
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: Array.from({ length: stepCount }, (_, index) =>
				makeScratchpadStep(`scratch-${index + 1}`, {
					...(index === 0 ? {} : { readKey: "rolling-state" }),
					writeKey: "rolling-state",
				}),
			),
		};
		const scratchpadClient = new InMemoryExecutorScratchpad();
		const handler = vi.fn(
			async (toolCall: ToolCall, step: SubTask | null): Promise<ToolResult> => {
				const stepNumber = Number(step?.id.replace("scratch-", "") ?? "0");
				const scratchpad = toolCall.arguments.scratchpad;
				const previous =
					typeof scratchpad === "object" &&
					scratchpad !== null &&
					"value" in scratchpad &&
					typeof scratchpad.value === "string"
						? (JSON.parse(scratchpad.value) as { count: number }).count
						: 0;

				expect(previous).toBe(stepNumber - 1);
				return {
					toolCallId: toolCall.id,
					content: JSON.stringify({ count: previous + 1 }),
					isError: false,
				};
			},
		);
		const executor = new LinearPlanExecutor({
			tools: { web_search: handler },
			scratchpadClient,
			maxSteps: stepCount,
		});

		const result = await executor.execute({
			runId: "run-long-scratchpad",
			task: "Carry scratchpad state across many steps",
			plan,
		});
		const taskHash = createTaskHash(
			"Carry scratchpad state across many steps",
			plan,
		);

		expect(result.haltedOnError).toBe(false);
		expect(result.terminatedReason).toBe("Success");
		expect(handler).toHaveBeenCalledTimes(stepCount);
		expect(scratchpadClient.reads).toHaveLength(stepCount - 1);
		expect(scratchpadClient.writes).toHaveLength(stepCount);
		expect(
			scratchpadClient.get({
				taskId: taskHash,
				sessionId: "run-long-scratchpad",
				key: "rolling-state",
			}),
		).toBe(JSON.stringify({ count: stepCount }));
		expect(
			scratchpadClient.writes.every((write) => write.taskId === taskHash),
		).toBe(true);
		expect(
			scratchpadClient.writes.every(
				(write) => write.sessionId === "run-long-scratchpad",
			),
		).toBe(true);
	});

	it("does not inject scratchpad arguments for steps that do not declare readKey", async () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeScratchpadStep("scratch-writer", { writeKey: "handoff" }),
				makeStep("plain-step"),
				makeScratchpadStep("scratch-reader", {
					readKey: "handoff",
					clearOnSuccess: true,
				}),
			],
		};
		const scratchpadClient = new InMemoryExecutorScratchpad();
		const seenArguments: Array<Record<string, unknown>> = [];
		const executor = new LinearPlanExecutor({
			tools: {
				web_search: async (toolCall) => {
					seenArguments.push(toolCall.arguments);
					return {
						toolCallId: toolCall.id,
						content: JSON.stringify({ ok: toolCall.arguments.query }),
						isError: false,
					};
				},
			},
			scratchpadClient,
		});

		const result = await executor.execute({
			runId: "run-no-inject",
			task: "Only inject declared scratchpad reads",
			plan,
		});

		expect(result.haltedOnError).toBe(false);
		expect(seenArguments[0]?.scratchpad).toBeUndefined();
		expect(seenArguments[1]?.scratchpad).toBeUndefined();
		expect(seenArguments[2]?.scratchpad).toEqual({
			key: "handoff",
			value: JSON.stringify({ ok: "payload:scratch-writer" }),
		});
		expect(scratchpadClient.clears).toEqual([
			{
				taskId: createTaskHash("Only inject declared scratchpad reads", plan),
				sessionId: "run-no-inject",
				key: "handoff",
			},
		]);
	});

	it("does not write scratchpad content when a step fails", async () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeScratchpadStep("failing-step", {
					readKey: "handoff",
					writeKey: "handoff",
				}),
				makeScratchpadStep("next-step", {
					readKey: "handoff",
					writeKey: "handoff",
				}),
			],
		};
		const task = "Failed scratchpad steps must not pollute state";
		const runId = "run-failed-scratchpad";
		const taskHash = createTaskHash(task, plan);
		const scratchpadClient = new InMemoryExecutorScratchpad();
		scratchpadClient.seed({
			taskId: taskHash,
			sessionId: runId,
			key: "handoff",
			value: "clean-state",
		});
		const handler = vi.fn(
			async (toolCall: ToolCall): Promise<ToolResult> => ({
				toolCallId: toolCall.id,
				content: "dirty-state",
				isError: true,
			}),
		);
		const executor = new LinearPlanExecutor({
			tools: { web_search: handler },
			scratchpadClient,
		});

		const result = await executor.execute({
			runId,
			task,
			plan,
		});

		expect(result.haltedOnError).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(scratchpadClient.writes).toHaveLength(0);
		expect(
			scratchpadClient.get({
				taskId: taskHash,
				sessionId: runId,
				key: "handoff",
			}),
		).toBe("clean-state");
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				arguments: expect.objectContaining({
					scratchpad: { key: "handoff", value: "clean-state" },
				}),
			}),
			plan.subtasks[0],
		);
	});

	it("halts before tool execution when scratchpad reads fail", async () => {
		const handler = vi.fn(
			async (toolCall: ToolCall): Promise<ToolResult> => ({
				toolCallId: toolCall.id,
				content: "ok",
				isError: false,
			}),
		);
		const scratchpadClient: ExecutorScratchpadClient = {
			read: vi.fn(async () => {
				throw new Error("read offline");
			}),
			write: vi.fn(async () => undefined),
			clear: vi.fn(async () => 0),
		};
		const executor = new LinearPlanExecutor({
			tools: { web_search: handler },
			scratchpadClient,
		});

		const result = await executor.execute({
			runId: "run-read-fails",
			task: "Read scratchpad",
			plan: {
				kind: "linear",
				subtasks: [makeScratchpadStep("reader", { readKey: "handoff" })],
			},
		});

		expect(result.haltedOnError).toBe(true);
		expect(handler).not.toHaveBeenCalled();
		expect(result.state.events).toContainEqual(
			expect.objectContaining({
				kind: "local_repair",
				payload: {
					leafId: "reader",
					note: "scratchpad_failed:READ_OFFLINE",
				},
			}),
		);
	});

	it("halts after tool success when scratchpad commits fail", async () => {
		const scratchpadClient: ExecutorScratchpadClient = {
			read: vi.fn(async () => null),
			write: vi.fn(async () => {
				throw "write rejected";
			}),
			clear: vi.fn(async () => 0),
		};
		const executor = new LinearPlanExecutor({
			tools: {
				web_search: async (toolCall) => ({
					toolCallId: toolCall.id,
					content: "ok",
					isError: false,
				}),
			},
			scratchpadClient,
		});

		const result = await executor.execute({
			runId: "run-commit-fails",
			task: "Write scratchpad",
			plan: {
				kind: "linear",
				subtasks: [makeScratchpadStep("writer", { writeKey: "handoff" })],
			},
		});

		expect(result.haltedOnError).toBe(true);
		expect(result.outputs).toEqual([]);
		expect(result.state.events).toContainEqual(
			expect.objectContaining({
				kind: "local_repair",
				payload: {
					leafId: "writer",
					note: "scratchpad_failed:UNKNOWN_ERROR",
				},
			}),
		);
	});

	it("clears all scratchpad keys when clearOnSuccess has no read or write key", async () => {
		const scratchpadClient: ExecutorScratchpadClient = {
			read: vi.fn(async () => null),
			write: vi.fn(async () => undefined),
			clear: vi.fn(async () => 2),
		};
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [makeScratchpadStep("cleanup", { clearOnSuccess: true })],
		};
		const executor = new LinearPlanExecutor({
			tools: {
				web_search: async (toolCall) => ({
					toolCallId: toolCall.id,
					content: "ok",
					isError: false,
				}),
			},
			scratchpadClient,
		});

		await expect(
			executor.execute({
				runId: "run-clear-all",
				task: "Clear scratchpad",
				plan,
			}),
		).resolves.toMatchObject({
			haltedOnError: false,
			terminatedReason: "Success",
		});
		expect(scratchpadClient.clear).toHaveBeenCalledWith({
			taskId: createTaskHash("Clear scratchpad", plan),
			sessionId: "run-clear-all",
		});
	});
});
