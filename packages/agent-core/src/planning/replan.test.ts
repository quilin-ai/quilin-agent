import { describe, expect, it } from "vitest";
import type { LinearPlan, PlanningEvent, SubTask } from "./index.js";
import {
	applyGlobalReplan,
	applyLocalRearrange,
	applyLocalRedecompose,
	computeGlobalReplanRate,
	toReplanEventPayload,
} from "./replan.js";
import { applyEvent, createPlanningState } from "./state.js";

function makeStep(id: string, overrides: Partial<SubTask> = {}): SubTask {
	return {
		id,
		action: overrides.action ?? "web_search",
		name: overrides.name ?? `Step ${id}`,
		description: overrides.description ?? `Execute ${id}`,
		estimatedTokens: overrides.estimatedTokens ?? 120,
		estimatedSteps: overrides.estimatedSteps ?? 1,
		preconditions: overrides.preconditions ?? [],
		effects: overrides.effects ?? [`effect:${id}`],
		skillHint: overrides.skillHint,
		arguments: overrides.arguments,
		depth: overrides.depth,
		writeScope: overrides.writeScope ?? "working",
		risk: overrides.risk ?? "low",
	};
}

describe("applyLocalRearrange", () => {
	it("patches the failed leaf in place without escalating to G-Replan", () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("search"), makeStep("summarize")],
		};

		const patch = applyLocalRearrange(plan, {
			kind: "tool_failed",
			leafId: "search",
			errorCode: "TOOL_TIMEOUT",
			changes: {
				action: "web_search_cached",
				arguments: { query: "fallback search" },
			},
		});

		expect(patch.level).toBe("L-Rearrange");
		expect(patch.reason).toBe("tool_failed:TOOL_TIMEOUT");
		expect(patch.operations).toEqual([
			expect.objectContaining({
				kind: "replace_leaf",
				leafId: "search",
				nextLeaf: expect.objectContaining({
					action: "web_search_cached",
					arguments: { query: "fallback search" },
				}),
			}),
		]);
		expect(toReplanEventPayload(patch)).toEqual({
			plan: patch.plan,
			currentLeafId: "search",
			reason: "tool_failed:TOOL_TIMEOUT",
		});
		expect(patch.plan.subtasks.map((step) => step.id)).toEqual([
			"search",
			"summarize",
		]);
	});

	it("reorders an existing provider leaf when a precondition is missing", () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeStep("search", { effects: ["competitors_found"] }),
				makeStep("recommend", {
					preconditions: ["comparison_table_ready"],
					effects: ["recommendation_ready"],
				}),
				makeStep("table", { effects: ["comparison_table_ready"] }),
			],
		};

		const patch = applyLocalRearrange(plan, {
			kind: "precondition_missing",
			leafId: "recommend",
			missing: ["comparison_table_ready"],
			providerLeafId: "table",
		});

		expect(patch.level).toBe("L-Rearrange");
		expect(patch.operations).toEqual([
			{
				kind: "move_before",
				movedLeafId: "table",
				beforeLeafId: "recommend",
			},
		]);
		expect(patch.plan.subtasks.map((step) => step.id)).toEqual([
			"search",
			"table",
			"recommend",
		]);
		expect(patch.currentLeafId).toBe("table");
	});

	it("rewrites the leaf after retries are exhausted", () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("search"), makeStep("table")],
		};

		const patch = applyLocalRearrange(plan, {
			kind: "retry_exhausted",
			leafId: "search",
			retries: 3,
			changes: {
				action: "web_search_archive",
				name: "Search archive",
			},
		});

		expect(patch.level).toBe("L-Rearrange");
		expect(patch.reason).toBe("retry_exhausted:3");
		expect(patch.plan.subtasks[0]).toMatchObject({
			id: "search",
			action: "web_search_archive",
			name: "Search archive",
		});
	});

	it("clears skill hints explicitly and rejects invalid local moves", () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeStep("search", { skillHint: "web-research" }),
				makeStep("draft"),
			],
		};

		const patch = applyLocalRearrange(plan, {
			kind: "tool_failed",
			leafId: "search",
			errorCode: "BAD_HINT",
			changes: {
				skillHint: null,
			},
		});

		expect(patch.plan.subtasks[0]?.skillHint).toBeUndefined();
		expect(() =>
			applyLocalRearrange(plan, {
				kind: "tool_failed",
				leafId: "missing",
				errorCode: "NO_STEP",
				changes: {},
			}),
		).toThrow(/unknown leafId: missing/);
		expect(() =>
			applyLocalRearrange(plan, {
				kind: "precondition_missing",
				leafId: "search",
				missing: ["draft_ready"],
				providerLeafId: "search",
			}),
		).toThrow(/cannot move a leaf before itself/);
	});
});

describe("applyLocalRedecompose", () => {
	it("replaces only the current subtree and keeps the rest of the plan intact", () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeStep("search"),
				makeStep("table", {
					preconditions: ["competitors_found"],
					effects: ["comparison_table_ready"],
				}),
				makeStep("recommend"),
			],
		};

		const patch = applyLocalRedecompose(plan, "table", [
			makeStep("collect", {
				preconditions: [],
				effects: ["table_rows_collected"],
			}),
			makeStep("write", {
				preconditions: ["table_rows_collected"],
				effects: [],
			}),
		]);

		expect(patch.level).toBe("L-Redecompose");
		expect(patch.plan.subtasks.map((step) => step.id)).toEqual([
			"search",
			"table.collect",
			"table.write",
			"recommend",
		]);
		expect(patch.currentLeafId).toBe("table.collect");
	});

	it("replays to the same state once the replan event is appended", () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("search"), makeStep("table"), makeStep("recommend")],
		};
		const patch = applyLocalRedecompose(plan, "table", [
			makeStep("collect"),
			makeStep("write"),
		]);
		const baseEvents: readonly PlanningEvent[] = [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan },
			},
			{
				seq: 2,
				timestamp: 1_100,
				kind: "subtask_started",
				payload: { leafId: "table" },
			},
		];
		const replanEvent: PlanningEvent = {
			seq: 3,
			timestamp: 1_200,
			kind: "replan",
			payload: toReplanEventPayload(patch),
		};

		const direct = applyEvent(
			baseEvents.reduce(applyEvent, createPlanningState("run-replan")),
			replanEvent,
		);
		const replayed = [...baseEvents, replanEvent].reduce(
			applyEvent,
			createPlanningState("run-replan"),
		);

		expect(replayed).toEqual(direct);
		expect(replayed.plan).toEqual(patch.plan);
		expect(replayed.currentLeafId).toBe("table.collect");
		expect(replanEvent.payload).toMatchObject({
			reason: "redecompose:table",
		});
	});
});

describe("applyGlobalReplan", () => {
	it("records a global replan trigger metric and replaces the whole plan", () => {
		const previousPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("search"), makeStep("draft")],
		};
		const nextPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("reconfirm"), makeStep("rewrite")],
		};

		const patch = applyGlobalReplan(previousPlan, nextPlan, {
			reason: "goal_drift",
			currentLeafId: "reconfirm",
			note: "goal changed after user correction",
			production: true,
		});

		expect(patch).toMatchObject({
			level: "G-Replan",
			reason: "goal_drift",
			note: "goal changed after user correction",
			plan: nextPlan,
			previousPlan,
			currentLeafId: "reconfirm",
			production: true,
			metric: {
				kind: "global_replan_triggered",
				reason: "goal_drift",
				production: true,
			},
		});
	});

	it("replays to the same state once the global replan event is appended", () => {
		const previousPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("search"), makeStep("draft")],
		};
		const nextPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("scope"), makeStep("draft")],
		};
		const patch = applyGlobalReplan(previousPlan, nextPlan, {
			reason: "external_context_changed",
			currentLeafId: "scope",
		});
		const baseEvents: readonly PlanningEvent[] = [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan: previousPlan },
			},
			{
				seq: 2,
				timestamp: 1_100,
				kind: "subtask_started",
				payload: { leafId: "draft" },
			},
		];
		const replanEvent: PlanningEvent = {
			seq: 3,
			timestamp: 1_200,
			kind: "replan",
			payload: toReplanEventPayload(patch),
		};

		const direct = applyEvent(
			baseEvents.reduce(applyEvent, createPlanningState("run-global-replan")),
			replanEvent,
		);
		const replayed = [...baseEvents, replanEvent].reduce(
			applyEvent,
			createPlanningState("run-global-replan"),
		);

		expect(replayed).toEqual(direct);
		expect(replayed.plan).toEqual(nextPlan);
		expect(replayed.currentLeafId).toBe("scope");
		expect(replayed.events.at(-1)).toMatchObject({
			kind: "replan",
			payload: {
				reason: "external_context_changed",
				production: false,
				metric: {
					kind: "global_replan_triggered",
					reason: "external_context_changed",
					production: false,
				},
			},
		});
	});

	it("lets state preserve a live leaf when G-Replan omits currentLeafId", () => {
		const previousPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("search"), makeStep("draft")],
		};
		const nextPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("draft"), makeStep("validate")],
		};
		const baseEvents: readonly PlanningEvent[] = [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan: previousPlan },
			},
			{
				seq: 2,
				timestamp: 1_100,
				kind: "subtask_started",
				payload: { leafId: "draft" },
			},
		];
		const baseState = baseEvents.reduce(
			applyEvent,
			createPlanningState("run-global-replan-keep-leaf"),
		);
		const patch = applyGlobalReplan(previousPlan, nextPlan, {
			reason: "external_context_changed",
			production: true,
		});
		const payload = toReplanEventPayload(patch);

		const replanned = applyEvent(baseState, {
			seq: 3,
			timestamp: 1_200,
			kind: "replan",
			payload,
		});

		expect(patch.currentLeafId).toBeUndefined();
		expect("currentLeafId" in payload).toBe(false);
		expect(replanned.plan).toEqual(nextPlan);
		expect(replanned.currentLeafId).toBe("draft");
		expect(replanned.phase).toBe("replanning");
	});

	it("clears a live leaf when G-Replan explicitly sets currentLeafId to null", () => {
		const previousPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("search"), makeStep("draft")],
		};
		const nextPlan: LinearPlan = {
			kind: "linear",
			subtasks: [makeStep("draft"), makeStep("validate")],
		};
		const baseEvents: readonly PlanningEvent[] = [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan: previousPlan },
			},
			{
				seq: 2,
				timestamp: 1_100,
				kind: "subtask_started",
				payload: { leafId: "draft" },
			},
		];
		const baseState = baseEvents.reduce(
			applyEvent,
			createPlanningState("run-global-replan-clear-leaf"),
		);
		const patch = applyGlobalReplan(previousPlan, nextPlan, {
			reason: "manual_request",
			currentLeafId: null,
		});
		const payload = toReplanEventPayload(patch);

		const replanned = applyEvent(baseState, {
			seq: 3,
			timestamp: 1_200,
			kind: "replan",
			payload,
		});

		expect(patch.currentLeafId).toBeNull();
		expect(payload.currentLeafId).toBeNull();
		expect(replanned.plan).toEqual(nextPlan);
		expect(replanned.currentLeafId).toBeNull();
		expect(replanned.phase).toBe("replanning");
	});
});

describe("computeGlobalReplanRate", () => {
	it("treats the production <=5% target as passing", () => {
		expect(
			computeGlobalReplanRate([
				{ hadGlobalReplan: true, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: true, production: false },
			]),
		).toEqual({
			totalRuns: 21,
			globalReplanTriggers: 2,
			triggerRate: 2 / 21,
			productionRuns: 20,
			productionGlobalReplanTriggers: 1,
			productionTriggerRate: 1 / 20,
			productionTargetRate: 0.05,
			productionTargetMet: true,
		});
	});

	it("marks the metric as failing when production global replans exceed the target", () => {
		expect(
			computeGlobalReplanRate([
				{ hadGlobalReplan: true, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
			]),
		).toMatchObject({
			productionRuns: 5,
			productionGlobalReplanTriggers: 1,
			productionTriggerRate: 1 / 5,
			productionTargetRate: 0.05,
			productionTargetMet: false,
		});
	});

	it("treats an unobserved production sample set as target-met metric baseline", () => {
		expect(computeGlobalReplanRate([])).toEqual({
			totalRuns: 0,
			globalReplanTriggers: 0,
			triggerRate: 0,
			productionRuns: 0,
			productionGlobalReplanTriggers: 0,
			productionTriggerRate: 0,
			productionTargetRate: 0.05,
			productionTargetMet: true,
		});
	});
});
