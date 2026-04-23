import { describe, expect, it } from "vitest";
import { applyEvent, createPlanningState } from "./state.js";
import {
	applyLocalRearrange,
	applyLocalRedecompose,
} from "./replan.js";
import type { LinearPlan, PlanningEvent, SubTask } from "./index.js";

function makeStep(
	id: string,
	overrides: Partial<SubTask> = {},
): SubTask {
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
			payload: {
				plan: patch.plan,
				currentLeafId: patch.currentLeafId,
			},
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
	});
});
