import { describe, expect, it } from "vitest";
import {
	createRedecomposedSubtasks,
	DEFAULT_MAX_DECOMPOSE_DEPTH,
	DEFAULT_MAX_DECOMPOSE_STEPS,
	decomposePlan,
	inferStepDepth,
	replacePlanSubtree,
} from "./decompose.js";
import type { DagPlan, LinearPlan, SubTask } from "./types.js";

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
		writeScope: overrides.writeScope,
		risk: overrides.risk,
	};
}

describe("inferStepDepth", () => {
	it("uses explicit depth when present and otherwise derives it from the id path", () => {
		expect(inferStepDepth(makeStep("1.2.3", { depth: 2 }))).toBe(2);
		expect(inferStepDepth(makeStep("research/table/summary"))).toBe(3);
		expect(inferStepDepth(makeStep("step-1"))).toBe(1);
	});
});

describe("decomposePlan", () => {
	it("reuses the existing planSketch and preserves executable step fields", () => {
		const planSketch: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeStep("1", {
					action: "web_search",
					preconditions: ["network_ready"],
					effects: ["competitors_found"],
					writeScope: "working",
					risk: "medium",
					arguments: { query: "top coding agents 2026" },
				}),
			],
		};

		const result = decomposePlan({ planSketch });
		const step = result.plan.subtasks[0];

		expect(result).toMatchObject({
			truncated: false,
			omittedSteps: 0,
			maxStepsApplied: DEFAULT_MAX_DECOMPOSE_STEPS,
			maxDepthApplied: DEFAULT_MAX_DECOMPOSE_DEPTH,
		});
		expect(step).toMatchObject({
			action: "web_search",
			preconditions: ["network_ready"],
			effects: ["competitors_found"],
			writeScope: "working",
			risk: "medium",
			arguments: { query: "top coding agents 2026" },
			depth: 1,
		});
	});

	it("enforces maxSteps and maxDepth on the linearized output", () => {
		const planSketch: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeStep("1", { action: "search" }),
				makeStep("1.1", { action: "collect" }),
				makeStep("1.1.1", { action: "deep_dive" }),
				makeStep("2", { action: "summarize" }),
			],
		};

		const result = decomposePlan(planSketch, {
			maxSteps: 2,
			maxDepth: 2,
		});

		expect(result.plan.subtasks.map((step) => step.id)).toEqual(["1", "1.1"]);
		expect(result.truncated).toBe(true);
		expect(result.omittedSteps).toBe(2);
	});

	it("linearizes DAG sketches before applying the step cap", () => {
		const dagSketch: DagPlan = {
			kind: "dag",
			subtasks: [
				makeStep("search", { action: "web_search" }),
				makeStep("table", {
					action: "table_write",
					preconditions: ["competitors_found"],
				}),
				makeStep("recommend", {
					action: "draft_recommendation",
					preconditions: ["table_ready"],
				}),
			],
			edges: [
				["search", "table"],
				["table", "recommend"],
			],
		};

		const result = decomposePlan(dagSketch, { maxSteps: 3 });

		expect(result.plan.subtasks.map((step) => step.id)).toEqual([
			"search",
			"table",
			"recommend",
		]);
		expect(result.plan.kind).toBe("linear");
	});

	it("keeps stable order while linearizing DAGs with fan-in dependencies", () => {
		const dagSketch: DagPlan = {
			kind: "dag",
			subtasks: [
				makeStep("search"),
				makeStep("profile"),
				makeStep("summarize"),
				makeStep("publish"),
			],
			edges: [
				["search", "summarize"],
				["profile", "summarize"],
				["summarize", "publish"],
			],
		};

		const result = decomposePlan(dagSketch, { maxSteps: 4 });

		expect(result.plan.subtasks.map((step) => step.id)).toEqual([
			"search",
			"profile",
			"summarize",
			"publish",
		]);
	});

	it("rejects cyclic DAG sketches before decomposition", () => {
		const dagSketch: DagPlan = {
			kind: "dag",
			subtasks: [
				makeStep("search", { action: "web_search" }),
				makeStep("table", { action: "table_write" }),
			],
			edges: [
				["search", "table"],
				["table", "search"],
			],
		};

		expect(() => decomposePlan(dagSketch)).toThrow(/cycle/i);
	});

	it("rejects DAG sketches with duplicate or missing edge step ids", () => {
		expect(() =>
			decomposePlan({
				kind: "dag",
				subtasks: [makeStep("search"), makeStep("search")],
				edges: [],
			}),
		).toThrow(/duplicate step ids: search/);

		expect(() =>
			decomposePlan({
				kind: "dag",
				subtasks: [makeStep("search")],
				edges: [["search", "missing"]],
			}),
		).toThrow(/missing step ids: missing/);
	});

	it("rejects missing plan sketches and invalid limits", () => {
		expect(() => decomposePlan({ text: "no plan" })).toThrow(/planSketch/);
		expect(() =>
			decomposePlan({ kind: "linear", subtasks: [] }, { maxSteps: 0 }),
		).toThrow(/maxSteps/);
		expect(() =>
			decomposePlan({ kind: "linear", subtasks: [] }, { maxDepth: 0 }),
		).toThrow(/maxDepth/);
	});
});

describe("createRedecomposedSubtasks", () => {
	it("prefixes child ids and inherits the leaf contract for first/last subtasks", () => {
		const target = makeStep("table", {
			preconditions: ["competitors_found"],
			effects: ["comparison_table_ready"],
			writeScope: "working",
			risk: "medium",
		});

		const subtasks = createRedecomposedSubtasks(target, [
			makeStep("collect", {
				preconditions: [],
				effects: ["rows_collected"],
				writeScope: undefined,
				risk: undefined,
			}),
			makeStep("write", {
				preconditions: ["rows_collected"],
				effects: [],
				writeScope: undefined,
				risk: undefined,
			}),
		]);

		expect(subtasks).toEqual([
			expect.objectContaining({
				id: "table.collect",
				preconditions: ["competitors_found"],
				effects: ["rows_collected"],
				writeScope: "working",
				risk: "medium",
				depth: 2,
			}),
			expect.objectContaining({
				id: "table.write",
				preconditions: ["rows_collected"],
				effects: ["comparison_table_ready"],
				writeScope: "working",
				risk: "medium",
				depth: 2,
			}),
		]);
	});

	it("requires replacements and normalizes blank, prefixed, and nested child ids", () => {
		const target = makeStep("table", {
			preconditions: ["competitors_found"],
			effects: ["comparison_table_ready"],
		});

		expect(() => createRedecomposedSubtasks(target, [])).toThrow(
			/replacement subtasks/,
		);
		expect(
			createRedecomposedSubtasks(target, [
				makeStep("  "),
				makeStep("/collect"),
				makeStep("table.write"),
			]).map((step) => step.id),
		).toEqual(["table.1", "table.collect", "table.write"]);
	});
});

describe("replacePlanSubtree", () => {
	it("replaces only the target subtree and leaves sibling steps untouched", () => {
		const plan: LinearPlan = {
			kind: "linear",
			subtasks: [
				makeStep("search"),
				makeStep("table"),
				makeStep("table.collect"),
				makeStep("table.write"),
				makeStep("recommend"),
			],
		};

		const result = replacePlanSubtree(plan, "table", [
			makeStep("draft", {
				preconditions: [],
				effects: ["table_draft_ready"],
			}),
			makeStep("finalize", {
				preconditions: ["table_draft_ready"],
				effects: [],
			}),
		]);

		expect(result.replacedStepIds).toEqual([
			"table",
			"table.collect",
			"table.write",
		]);
		expect(result.insertedStepIds).toEqual(["table.draft", "table.finalize"]);
		expect(result.plan.subtasks.map((step) => step.id)).toEqual([
			"search",
			"table.draft",
			"table.finalize",
			"recommend",
		]);
	});

	it("rejects unknown and non-contiguous subtree replacements", () => {
		expect(() =>
			replacePlanSubtree(
				{
					kind: "linear",
					subtasks: [makeStep("search"), makeStep("table")],
				},
				"missing",
				[makeStep("retry")],
			),
		).toThrow(/unknown leafId/);

		expect(() =>
			replacePlanSubtree(
				{
					kind: "linear",
					subtasks: [
						makeStep("table"),
						makeStep("recommend"),
						makeStep("table.write"),
					],
				},
				"table",
				[makeStep("retry")],
			),
		).toThrow(/must remain contiguous/);
	});
});
