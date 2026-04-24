import { describe, expect, it, vi } from "vitest";
import { createBudgetLedger } from "./budget.js";
import type { PlanContext } from "./context.js";
import { MainLLMPlanner } from "./planner.js";
import type { LinearPlan, LLMPlannerResponse } from "./types.js";

const DEFAULT_CONTEXT: PlanContext = {
	task: "Compare the latest coding agent competitors",
	conversationHistory: [],
	memoryRecall: [],
	skillCatalog: [],
	budget: createBudgetLedger({
		tokenBudget: 1_000,
		turnBudget: 4,
		stepBudget: 6,
	}),
	iteration: 0,
};

function makePlan(): LinearPlan {
	return {
		kind: "linear",
		subtasks: [
			{
				id: "step-1",
				action: "web_search",
				name: "Search competitors",
				description: "Collect competitor snapshots",
				estimatedTokens: 180,
				estimatedSteps: 1,
				preconditions: [],
				effects: ["competitors_found"],
				writeScope: "working",
				risk: "low",
			},
		],
	};
}

describe("MainLLMPlanner", () => {
	it("delegates deliberate() to the injected model without extra calls", async () => {
		const response: LLMPlannerResponse = {
			text: "Python GIL is the global interpreter lock.",
		};
		const deliberate = vi.fn(async () => response);
		const planner = new MainLLMPlanner({ deliberate });

		await expect(planner.deliberate(DEFAULT_CONTEXT)).resolves.toEqual(
			response,
		);
		expect(deliberate).toHaveBeenCalledTimes(1);
		expect(deliberate).toHaveBeenCalledWith(DEFAULT_CONTEXT);
	});

	it("throws a clear error when the model returns an invalid planner payload", async () => {
		const deliberate = vi.fn(async () => ({
			planSketch: {
				kind: "linear",
				subtasks: [
					{
						id: "step-1",
					},
				],
			},
		}));
		const planner = new MainLLMPlanner({ deliberate });

		await expect(planner.deliberate(DEFAULT_CONTEXT)).rejects.toThrow(
			/Invalid planner response from model: planSketch\.subtasks\[0\]\.action:/,
		);
	});

	it.each<
		readonly [
			name: string,
			response: LLMPlannerResponse,
			expectedIntent: string,
		]
	>([
		[
			"simple answer",
			{
				text: "The benchmarks favor specialized coding agents.",
			},
			"SIMPLE_QA",
		],
		[
			"single tool call",
			{
				toolCalls: [
					{
						id: "tool-1",
						name: "web_search",
						arguments: { query: "latest Quilin competitors" },
					},
				],
			},
			"SINGLE_TOOL",
		],
		[
			"clarification request",
			{
				needClarification: {
					question: "Which benchmark should I compare against?",
					missing: ["benchmark"],
				},
			},
			"CLARIFICATION",
		],
		[
			"plan sketch",
			{
				text: "I need a short execution plan.",
				planSketch: makePlan(),
				toolCalls: [
					{
						id: "tool-2",
						name: "skill_view",
						arguments: { skill_id: "competitor-research" },
					},
				],
			},
			"MULTI_STEP",
		],
	])("classifies %s from one deliberate() response", async (_name, response, expectedIntent) => {
		const deliberate = vi.fn(async () => response);
		const planner = new MainLLMPlanner(
			{ deliberate },
			{
				now: vi
					.fn<() => number>()
					.mockReturnValueOnce(1_000)
					.mockReturnValueOnce(1_042),
			},
		);

		const result = await planner.deliberateAndClassify(DEFAULT_CONTEXT);

		expect(deliberate).toHaveBeenCalledTimes(1);
		expect(result.response).toEqual(response);
		expect(result.classification).toMatchObject({
			intent: expectedIntent,
			latencyMs: 42,
		});
	});

	it("reuses the pure C1.1 classifier for audit-aware dispatch", () => {
		const planner = new MainLLMPlanner(
			{
				deliberate: vi.fn(async () => ({ text: "done" })),
			},
			{
				intent: {
					auditConfidenceThreshold: 0.8,
				},
			},
		);

		expect(
			planner.classifyIntent({
				text: "done",
				audit: {
					intentHint: "SIMPLE_QA",
					confidence: 0.92,
					reasoningDigest: "No tools are needed.",
				},
			}),
		).toEqual({
			intent: "SIMPLE_QA",
			confidence: 0.92,
			source: "audit",
			latencyMs: 0,
			reasoningDigest: "No tools are needed.",
		});
	});

	it("reuses the linear decomposer for planSketch responses", async () => {
		const planner = new MainLLMPlanner({
			deliberate: vi.fn(async () => ({
				planSketch: makePlan(),
			})),
		});

		await expect(
			planner.decompose(
				{
					planSketch: makePlan(),
				},
				DEFAULT_CONTEXT,
			),
		).resolves.toEqual({
			kind: "linear",
			subtasks: [
				expect.objectContaining({
					id: "step-1",
					action: "web_search",
					writeScope: "working",
				}),
			],
		});
	});
});
