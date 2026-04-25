import { describe, expect, it } from "vitest";
import {
	assertBenchmarkTask,
	type BenchmarkDataset,
	type BenchmarkTask,
	benchmarkDatasetSchema,
	benchmarkTaskSchema,
	parseBenchmarkTask,
} from "./task.js";

const validTask = {
	task_id: "swe-1",
	dataset: "swe-bench-verified" as BenchmarkDataset,
	inputs: { repo: "owner/project", issue: "fix failing test" },
	expected: { patch_applies: true },
	scorer_type: "patch-apply",
	token_budget: 12000,
	metadata: { split: "verified" },
};

describe("benchmarkTaskSchema", () => {
	it("freezes the supported dataset identifiers", () => {
		expect(benchmarkDatasetSchema.options).toEqual([
			"swe-bench-lite",
			"swe-bench-verified",
		]);
	});

	it("parses a valid benchmark task", () => {
		expect(parseBenchmarkTask(validTask)).toEqual(validTask);
	});

	it("accepts omitted optional fields", () => {
		const {
			metadata: _metadata,
			token_budget: _tokenBudget,
			...minimal
		} = validTask;

		expect(benchmarkTaskSchema.safeParse(minimal).success).toBe(true);
	});

	it("asserts the input type", () => {
		const input: unknown = validTask;
		assertBenchmarkTask(input);

		const task: BenchmarkTask = input;
		expect(task.task_id).toBe("swe-1");
	});

	it.each([
		["missing task_id", { ...validTask, task_id: undefined }],
		["unsupported dataset", { ...validTask, dataset: "web-arena" }],
		["non-record inputs", { ...validTask, inputs: "repo" }],
		["non-record expected", { ...validTask, expected: [] }],
		["empty scorer_type", { ...validTask, scorer_type: "" }],
		["zero token_budget", { ...validTask, token_budget: 0 }],
		["fractional token_budget", { ...validTask, token_budget: 1.5 }],
		["non-record metadata", { ...validTask, metadata: null }],
		["extra top-level field", { ...validTask, extra: true }],
	])("rejects invalid task: %s", (_caseName, invalidTask) => {
		expect(benchmarkTaskSchema.safeParse(invalidTask).success).toBe(false);
	});
});
