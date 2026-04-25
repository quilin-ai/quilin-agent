import { describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../wire/task.js";
import { createScorerRegistry, ScorerRegistryError } from "./registry.js";
import type { Scorer } from "./types.js";

const task = {
	task_id: "swe-1",
	dataset: "swe-bench-verified",
	inputs: { repo_workdir: "/tmp/repo" },
	expected: {},
	scorer_type: "demo",
} satisfies BenchmarkTask;

describe("ScorerRegistry", () => {
	it("registers and retrieves scorers by scorer_type", async () => {
		const registry = createScorerRegistry();
		const scorer: Scorer = async () => ({
			passed: true,
			score: 1,
			details: { scorer_type: "demo" },
		});

		registry.register("demo", scorer);

		expect(registry.has("demo")).toBe(true);
		await expect(registry.get("demo")(task, {})).resolves.toEqual({
			passed: true,
			score: 1,
			details: { scorer_type: "demo" },
		});
	});

	it("rejects duplicate scorer registration", () => {
		const registry = createScorerRegistry();
		const scorer: Scorer = async () => ({
			passed: true,
			score: 1,
			details: {},
		});

		registry.register("demo", scorer);

		expect(() => registry.register("demo", scorer)).toThrow(
			ScorerRegistryError,
		);
		expect(() => registry.register("demo", scorer)).toThrow(
			"Scorer already registered: demo",
		);
	});

	it("rejects missing scorers", () => {
		const registry = createScorerRegistry();

		expect(() => registry.get("missing")).toThrow(ScorerRegistryError);
		expect(() => registry.get("missing")).toThrow(
			"Scorer not registered: missing",
		);
	});

	it("rejects blank scorer types", () => {
		const registry = createScorerRegistry();
		const scorer: Scorer = async () => ({
			passed: true,
			score: 1,
			details: {},
		});

		expect(() => registry.register(" ", scorer)).toThrow(
			"Scorer type must be a non-empty string",
		);
		expect(() => registry.get(" ")).toThrow(
			"Scorer type must be a non-empty string",
		);
	});
});
