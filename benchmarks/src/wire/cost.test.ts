import { describe, expect, it } from "vitest";
import {
	assertBenchmarkCost,
	type BenchmarkCost,
	benchmarkCostSchema,
	parseBenchmarkCost,
} from "./cost.js";

const validCost = {
	input_tokens: 100,
	output_tokens: 20,
	thinking_tokens: 7,
	total_usd: 0.031,
	per_model_usd: {
		"gpt-5": 0.02,
		"claude-sonnet": 0.011,
	},
};

describe("benchmarkCostSchema", () => {
	it("parses a valid benchmark cost", () => {
		expect(parseBenchmarkCost(validCost)).toEqual(validCost);
	});

	it("accepts zero values", () => {
		expect(
			benchmarkCostSchema.safeParse({
				input_tokens: 0,
				output_tokens: 0,
				thinking_tokens: 0,
				total_usd: 0,
				per_model_usd: { "gpt-5": 0 },
			}).success,
		).toBe(true);
	});

	it("asserts the input type", () => {
		const input: unknown = validCost;
		assertBenchmarkCost(input);

		const cost: BenchmarkCost = input;
		expect(cost.total_usd).toBe(0.031);
	});

	it.each([
		["negative input_tokens", { ...validCost, input_tokens: -1 }],
		["fractional output_tokens", { ...validCost, output_tokens: 1.2 }],
		["negative thinking_tokens", { ...validCost, thinking_tokens: -3 }],
		["negative total_usd", { ...validCost, total_usd: -0.01 }],
		[
			"negative per_model_usd",
			{ ...validCost, per_model_usd: { "gpt-5": -0.01 } },
		],
		["non-record per_model_usd", { ...validCost, per_model_usd: [] }],
		["extra top-level field", { ...validCost, cached_tokens: 4 }],
	])("rejects invalid cost: %s", (_caseName, invalidCost) => {
		expect(benchmarkCostSchema.safeParse(invalidCost).success).toBe(false);
	});
});
