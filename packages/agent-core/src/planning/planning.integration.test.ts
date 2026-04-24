import { describe, expect, it, vi } from "vitest";
import type { SkillDescriptor } from "../skills/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { createBudgetLedger } from "./budget.js";
import { buildPlanContext } from "./context.js";
import { type DelegationDecision, evaluateDelegation } from "./delegation.js";
import { LinearPlanExecutor } from "./executor.js";
import { MainLLMPlanner } from "./planner.js";
import { applyGlobalReplan, toReplanEventPayload } from "./replan.js";
import type { PlanningEvent } from "./state.js";
import { applyEvent } from "./state.js";
import { detectTermination } from "./termination.js";
import type {
	DagPlan,
	LinearPlan,
	LLMPlannerResponse,
	SubTask,
} from "./types.js";

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

function makeLongTaskStep(
	index: number,
	overrides: Partial<SubTask> = {},
): SubTask {
	const id = overrides.id ?? `step-${String(index).padStart(2, "0")}`;
	return {
		id,
		action: overrides.action ?? "long_task_step",
		name: overrides.name ?? `Long task step ${index}`,
		description: overrides.description ?? `Execute long task step ${index}`,
		estimatedTokens: overrides.estimatedTokens ?? 25,
		estimatedSteps: overrides.estimatedSteps ?? 1,
		preconditions:
			overrides.preconditions ?? (index === 1 ? [] : [`done:${index - 1}`]),
		effects: overrides.effects ?? [`done:${index}`],
		skillHint: overrides.skillHint,
		arguments: overrides.arguments ?? { path: `artifact-${index}.md` },
		depth: overrides.depth,
		writeScope: overrides.writeScope ?? "working",
		risk: overrides.risk ?? "low",
	};
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
				draft_recommendation: async (
					toolCall: ToolCall,
				): Promise<ToolResult> => {
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
		expect(
			execution.state.events.some((event) => event.kind === "replan"),
		).toBe(false);
		expect(termination).toMatchObject({
			shouldTerminate: true,
			reason: "Success",
		});
	});
});

describe("planning M2 integration", () => {
	it("runs a 50+ step long-task mock with delegation policy and G-Replan fixture", async () => {
		const delegatedStep = makeLongTaskStep(12, {
			id: "delegated-research",
			action: "delegate_subagent",
			name: "Delegated research slice",
			description: "Run an isolated research slice in a sub-agent",
			estimatedSteps: 12,
			preconditions: ["done:11"],
			effects: ["delegated_research_done"],
			arguments: { path: "delegated-research.md" },
			writeScope: "episodic",
			risk: "medium",
		});
		const steps: SubTask[] = Array.from({ length: 52 }, (_, index) =>
			index === 11 ? delegatedStep : makeLongTaskStep(index + 1),
		);
		const linearPlan: LinearPlan = {
			kind: "linear",
			subtasks: steps,
		};
		const dagPlan: DagPlan = {
			kind: "dag",
			subtasks: steps,
			edges: steps
				.slice(1)
				.map((step, index) => [steps[index]?.id ?? "", step.id]),
		};
		const delegationDecision = evaluateDelegation({
			parentRunId: "run-c3-5",
			candidateStep: delegatedStep,
			plan: dagPlan,
			mainAgentSteps: steps.filter((step) => step.id !== delegatedStep.id),
			triggers: {
				longRunningTask: true,
				decomposableSubtask: true,
				nonBlockingSupervisorRequired: true,
				subAgentCapabilityAvailable: true,
			},
			subAgent: {
				role: "long-task-worker",
				goal: "Complete the delegated research slice and report checkpoints",
			},
		});
		const delegationMock = vi.fn(
			async (
				_toolCall: ToolCall,
				step: SubTask | null,
			): Promise<ToolResult> => {
				if (!delegationDecision.delegate || step == null) {
					return {
						toolCallId: _toolCall.id,
						content: "delegation rejected",
						isError: true,
					};
				}

				return {
					toolCallId: _toolCall.id,
					content: JSON.stringify({
						childRunId: delegationDecision.assignment.childRunId,
						taskId: step.id,
						status: "success",
					}),
					isError: false,
				};
			},
		);
		const longTaskMock = vi.fn(
			async (
				toolCall: ToolCall,
				step: SubTask | null,
			): Promise<ToolResult> => ({
				toolCallId: toolCall.id,
				content: JSON.stringify({ completed: step?.id ?? toolCall.id }),
				isError: false,
			}),
		);
		const events: PlanningEvent[] = [];
		const executor = new LinearPlanExecutor({
			tools: {
				long_task_step: longTaskMock,
				delegate_subagent: delegationMock,
			},
			maxSteps: 60,
			onEvent: (event) => {
				events.push(event);
			},
		});

		const execution = await executor.execute({
			runId: "run-c3-5",
			task: "Execute a long M2 planning task with an isolated delegation slice",
			plan: linearPlan,
			intent: {
				intent: "MULTI_STEP",
				confidence: 0.99,
				source: "structural",
				latencyMs: 3,
			},
		});
		const nextPlan: LinearPlan = {
			kind: "linear",
			subtasks: [
				...steps.slice(0, 30),
				makeLongTaskStep(53, {
					id: "replanned-validation",
					action: "long_task_step",
					preconditions: ["done:30"],
					effects: ["validation_done"],
					arguments: { path: "validation.md" },
					writeScope: "working",
					risk: "low",
				}),
			],
		};
		const gReplanPatch = applyGlobalReplan(linearPlan, nextPlan, {
			reason: "external_context_changed",
			currentLeafId: "step-30",
			note: "fixture path changed after checkpoint",
			production: false,
		});
		const gReplanEvent: PlanningEvent = {
			seq: execution.state.events.length + 1,
			timestamp: 1,
			kind: "replan",
			payload: toReplanEventPayload(gReplanPatch),
		};
		const replannedState = applyEvent(execution.state, gReplanEvent);

		expect(steps).toHaveLength(52);
		expect(delegationDecision).toMatchObject({
			delegate: true,
			reason: "accepted",
		} satisfies Partial<DelegationDecision>);
		expect(delegationMock).toHaveBeenCalledTimes(1);
		expect(longTaskMock).toHaveBeenCalledTimes(51);
		expect(execution.outputs).toHaveLength(52);
		expect(
			events.filter((event) => event.kind === "subtask_done"),
		).toHaveLength(52);
		expect(execution.terminatedReason).toBe("Success");
		expect(gReplanPatch).toMatchObject({
			level: "G-Replan",
			reason: "external_context_changed",
			currentLeafId: "step-30",
			metric: {
				kind: "global_replan_triggered",
				production: false,
			},
		});
		expect(replannedState.plan).toBe(nextPlan);
		expect(replannedState.events.at(-1)).toMatchObject({
			kind: "replan",
			payload: {
				plan: nextPlan,
				reason: "external_context_changed",
				currentLeafId: "step-30",
			},
		});
	});
});
