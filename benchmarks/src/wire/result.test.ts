import { describe, expect, it } from "vitest";
import {
	assertBenchmarkResult,
	type BenchmarkResult,
	benchmarkResultSchema,
	parseBenchmarkResult,
} from "./result.js";

const validResult = {
	run_id: "018f2d35-6d86-73bb-9f21-2d8107c90f8d",
	task_id: "swe-1",
	output: { patch: "diff --git a/file.ts b/file.ts" },
	passed: true,
	score: 1,
	details: { matcher: "patch-apply" },
	cost: {
		input_tokens: 100,
		output_tokens: 20,
		thinking_tokens: 7,
		total_usd: 0.031,
		per_model_usd: { "gpt-5": 0.031 },
	},
	latency_ms: 1250.5,
};

describe("benchmarkResultSchema", () => {
	it("parses a valid benchmark result", () => {
		expect(parseBenchmarkResult(validResult)).toEqual(validResult);
	});

	it("accepts score and latency lower bounds", () => {
		expect(
			benchmarkResultSchema.safeParse({
				...validResult,
				score: 0,
				latency_ms: 0,
			}).success,
		).toBe(true);
	});

	it("asserts the input type", () => {
		const input: unknown = validResult;
		assertBenchmarkResult(input);

		const result: BenchmarkResult = input;
		expect(result.passed).toBe(true);
	});

	it.each([
		["missing run_id", { ...validResult, run_id: undefined }],
		["empty task_id", { ...validResult, task_id: "" }],
		["non-record output", { ...validResult, output: "done" }],
		["non-boolean passed", { ...validResult, passed: "true" }],
		["negative score", { ...validResult, score: -0.01 }],
		["score above one", { ...validResult, score: 1.01 }],
		["non-record details", { ...validResult, details: null }],
		[
			"invalid nested cost",
			{ ...validResult, cost: { ...validResult.cost, total_usd: -0.01 } },
		],
		["negative latency_ms", { ...validResult, latency_ms: -1 }],
		["extra top-level field", { ...validResult, scorer_type: "patch-apply" }],
	])("rejects invalid result: %s", (_caseName, invalidResult) => {
		expect(benchmarkResultSchema.safeParse(invalidResult).success).toBe(false);
	});
});
