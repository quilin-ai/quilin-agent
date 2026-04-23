import { describe, expect, it, vi } from "vitest";
import { createBudgetLedger } from "./budget.js";
import { buildPlanContext } from "./context.js";
import { LinearPlanExecutor } from "./executor.js";
import { MainLLMPlanner } from "./planner.js";
import { detectTermination } from "./termination.js";
import type { PlanningEvent } from "./state.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { LLMPlannerResponse, SubTask } from "./types.js";

function makeSkillDescriptor(name: string): SkillDescriptor {
	return {
		name,
		description: `${name} description`,
		path: `/skills/${name}/SKILL.md`,
		source: "project",
		frontmatter: {
			name,
			description: `${name} description`,
			whenToUse: `${name} when to use`,
			userInvocable: true,
			disableModelInvocation: false,
		},
	};
}

function makeStep(step: SubTask): SubTask {
	return step;
}

describe("planning M0 integration", () => {
	it("runs the competitor research scenario with on-demand skill_view loading and no G-Replan", async () => {
		const plannerResponse: LLMPlannerResponse = {
			text: "Load the research skill, then search, tabulate, and recommend.",
			toolCalls: [
				{
					id: "prefetch-skill-1",
					name: "skill_view",
					arguments: {
						skill_id: "competitor-research",
					},
				},
			],
			planSketch: {
				kind: "linear",
				subtasks: [
					makeStep({
						id: "search",
						action: "web_search",
						name: "搜索竞品",
						description: "收集竞品材料",
						estimatedTokens: 180,
						estimatedSteps: 1,
						preconditions: [],
						effects: ["competitors_found"],
						skillHint: "competitor-research",
						arguments: {
							query: "best AI coding agents 2026",
						},
						writeScope: "working",
						risk: "low",
					}),
					makeStep({
						id: "table",
						action: "table_write",
						name: "整理表格",
						description: "把竞品差异整理成表格",
						estimatedTokens: 150,
						estimatedSteps: 1,
						preconditions: ["competitors_found"],
						effects: ["comparison_table_ready"],
						arguments: {
							format: "markdown",
							columns: ["product", "strength", "gap"],
						},
						writeScope: "working",
						risk: "low",
					}),
					makeStep({
						id: "recommend",
						action: "draft_recommendation",
						name: "生成建议",
						description: "基于表格给出建议",
						estimatedTokens: 170,
						estimatedSteps: 1,
						preconditions: ["comparison_table_ready"],
						effects: ["recommendation_ready"],
						arguments: {
							tone: "pragmatic",
						},
						writeScope: "episodic",
						risk: "medium",
					}),
				],
			},
			audit: {
				intentHint: "MULTI_STEP",
				confidence: 0.95,
				reasoningDigest: "A three-step execution path is required.",
			},
		};
		const deliberate = vi.fn(async () => plannerResponse);
		const planner = new MainLLMPlanner({
			deliberate,
		});
		const context = await buildPlanContext({
			task: "搜索竞品，整理表格，然后生成 Quilin 的下一步建议",
			conversationHistory: [
				{ role: "user", content: "帮我研究几个竞品并给建议。" },
			],
			skillCatalog: [makeSkillDescriptor("competitor-research")],
			budget: createBudgetLedger({
				tokenBudget: 1_000,
				turnBudget: 4,
				stepBudget: 6,
			}),
		});
		const events: PlanningEvent[] = [];
		const toolOrder: string[] = [];

		const executor = new LinearPlanExecutor({
			tools: {
				skill_view: async (toolCall: ToolCall): Promise<ToolResult> => {
					toolOrder.push(toolCall.name);
					return {
						toolCallId: toolCall.id,
						content: "# competitor-research\nUse concise competitor snapshots.",
						isError: false,
					};
				},
				web_search: async (toolCall: ToolCall): Promise<ToolResult> => {
					toolOrder.push(toolCall.name);
					return {
						toolCallId: toolCall.id,
						content: JSON.stringify([
							{ product: "Claude Code", strength: "mature tool loop" },
							{ product: "Cursor", strength: "strong editor workflow" },
						]),
						isError: false,
					};
				},
				table_write: async (toolCall: ToolCall): Promise<ToolResult> => {
					toolOrder.push(toolCall.name);
					return {
						toolCallId: toolCall.id,
						content: "| product | strength | gap |",
						isError: false,
					};
				},
				draft_recommendation: async (toolCall: ToolCall): Promise<ToolResult> => {
					toolOrder.push(toolCall.name);
					return {
						toolCallId: toolCall.id,
						content: "Prioritize differentiated memory and planning metrics.",
						isError: false,
					};
				},
			},
			onEvent: (event) => {
				events.push(event);
			},
		});

		const deliberateResult = await planner.deliberateAndClassify(context);
		const plan = await planner.decompose(deliberateResult.response, context);
		expect(plan.kind).toBe("linear");
		if (plan.kind !== "linear") {
			throw new Error("M0 integration only supports linear plans");
		}
		const execution = await executor.execute({
			runId: "run-c1-8",
			task: context.task,
			intent: deliberateResult.classification,
			plan,
			initialToolCalls: deliberateResult.response.toolCalls,
		});
		const termination = detectTermination(execution.state);

		expect(deliberate).toHaveBeenCalledTimes(1);
		expect(deliberate).toHaveBeenCalledWith(context);
		expect(deliberateResult.classification.intent).toBe("MULTI_STEP");
		expect(execution.preflightOutputs).toHaveLength(1);
		expect(toolOrder).toEqual([
			"skill_view",
			"web_search",
			"table_write",
			"draft_recommendation",
		]);
		expect(events.find((event) => event.kind === "tool_called")).toMatchObject({
			kind: "tool_called",
			payload: {
				toolCall: {
					id: "prefetch-skill-1",
					name: "skill_view",
					arguments: {
						skill_id: "competitor-research",
					},
				},
			},
		});
		expect(plan.subtasks.map((step) => step.writeScope)).toEqual([
			"working",
			"working",
			"episodic",
		]);
		expect(execution.state.events.some((event) => event.kind === "replan")).toBe(
			false,
		);
		expect(termination).toMatchObject({
			shouldTerminate: true,
			reason: "Success",
		});
	});
});
