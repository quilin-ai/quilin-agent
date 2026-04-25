import { describe, expect, it } from "vitest";
import {
	assertAcyclicDag,
	getStepWriteSet,
	haveIndependentWriteSets,
	linearPlanToDag,
	validateDagPlan,
} from "./dag.js";
import type { DagPlan, LinearPlan, SubTask } from "./types.js";

function makeStep(id: string, overrides: Partial<SubTask> = {}): SubTask {
	return {
		id,
		action: overrides.action ?? "tool",
		name: overrides.name ?? `Step ${id}`,
		description: overrides.description ?? `Execute ${id}`,
		estimatedTokens: overrides.estimatedTokens ?? 10,
		estimatedSteps: overrides.estimatedSteps ?? 1,
		preconditions: overrides.preconditions ?? [],
		effects: overrides.effects ?? [`effect:${id}`],
		arguments: overrides.arguments,
		writeScope: overrides.writeScope,
		risk: overrides.risk,
		depth: overrides.depth,
		skillHint: overrides.skillHint,
	};
}

describe("linearPlanToDag", () => {
	it("promotes a linear plan into an equivalent dependency chain without rewriting steps", () => {
		const first = makeStep("search", { writeScope: "working" });
		const second = makeStep("summarize", { writeScope: "episodic" });
		const linear: LinearPlan = {
			kind: "linear",
			subtasks: [first, second],
		};

		const dag = linearPlanToDag(linear);

		expect(dag).toEqual({
			kind: "dag",
			subtasks: [first, second],
			edges: [["search", "summarize"]],
		});
		expect(dag.subtasks[0]).toBe(first);
	});
});

describe("validateDagPlan", () => {
	it("accepts acyclic DAGs and rejects missing, duplicate, or cyclic step ids", () => {
		const valid: DagPlan = {
			kind: "dag",
			subtasks: [makeStep("a"), makeStep("b"), makeStep("c")],
			edges: [
				["a", "c"],
				["b", "c"],
			],
		};

		expect(validateDagPlan(valid)).toEqual({
			ok: true,
			missingStepIds: [],
			duplicateStepIds: [],
			cycle: [],
		});
		expect(() => assertAcyclicDag(valid)).not.toThrow();

		expect(
			validateDagPlan({
				...valid,
				edges: [["a", "missing"]],
			}),
		).toMatchObject({ ok: false, missingStepIds: ["missing"] });

		expect(
			validateDagPlan({
				kind: "dag",
				subtasks: [makeStep("a"), makeStep("a")],
				edges: [],
			}),
		).toMatchObject({ ok: false, duplicateStepIds: ["a"] });
		expect(() =>
			assertAcyclicDag({
				kind: "dag",
				subtasks: [makeStep("a"), makeStep("a")],
				edges: [],
			}),
		).toThrow("DAG contains duplicate step ids: a");
		expect(() =>
			assertAcyclicDag({
				...valid,
				edges: [["a", "missing"]],
			}),
		).toThrow("DAG edge references missing step ids: missing");

		const cyclic: DagPlan = {
			kind: "dag",
			subtasks: [makeStep("a"), makeStep("b"), makeStep("c")],
			edges: [
				["a", "b"],
				["b", "c"],
				["c", "a"],
			],
		};

		expect(validateDagPlan(cyclic)).toMatchObject({
			ok: false,
			cycle: ["a", "b", "c", "a"],
		});
		expect(() => assertAcyclicDag(cyclic)).toThrow(/cycle/i);
	});
});

describe("write-set helpers", () => {
	it("extracts resource ids from common arguments for delegation checks", () => {
		expect(
			getStepWriteSet(
				makeStep("write", {
					writeScope: "episodic",
					arguments: {
						path: "notes.md",
						resources: ["memory:1", "memory:2"],
					},
				}),
			),
		).toEqual({
			scope: "episodic",
			resources: ["memory:1", "memory:2", "notes.md"],
			unknown: false,
		});
	});

	it("normalizes default and nested resource arguments", () => {
		expect(getStepWriteSet(makeStep("read-default"))).toEqual({
			scope: "none",
			resources: [],
			unknown: false,
		});
		expect(
			getStepWriteSet(
				makeStep("write", {
					writeScope: "working",
					arguments: {
						files: [" b.md ", ["a.md", "", ["c.md"]]],
						resource: 42,
					},
				}),
			),
		).toEqual({
			scope: "working",
			resources: ["a.md", "b.md", "c.md"],
			unknown: false,
		});
	});

	it("treats read-only, different scopes, and disjoint resources as independent", () => {
		expect(
			haveIndependentWriteSets(
				makeStep("read", { writeScope: "none" }),
				makeStep("write", { writeScope: "working" }),
			),
		).toBe(true);
		expect(
			haveIndependentWriteSets(
				makeStep("working", { writeScope: "working" }),
				makeStep("episodic", { writeScope: "episodic" }),
			),
		).toBe(true);
		expect(
			haveIndependentWriteSets(
				makeStep("left", {
					writeScope: "working",
					arguments: { path: "left.md" },
				}),
				makeStep("right", {
					writeScope: "working",
					arguments: { path: "right.md" },
				}),
			),
		).toBe(true);
	});

	it("treats overlapping or unknown writes in the same scope as conflicting", () => {
		expect(
			haveIndependentWriteSets(
				makeStep("left", {
					writeScope: "working",
					arguments: { path: "same.md" },
				}),
				makeStep("right", {
					writeScope: "working",
					arguments: { paths: ["same.md"] },
				}),
			),
		).toBe(false);
		expect(
			haveIndependentWriteSets(
				makeStep("unknown-left", { writeScope: "semantic" }),
				makeStep("unknown-right", { writeScope: "semantic" }),
			),
		).toBe(false);
	});
});
