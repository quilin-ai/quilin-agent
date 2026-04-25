import { z } from "zod";

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().nonnegative();

export const benchmarkCostSchema = z
	.object({
		input_tokens: nonNegativeIntegerSchema,
		output_tokens: nonNegativeIntegerSchema,
		thinking_tokens: nonNegativeIntegerSchema,
		total_usd: nonNegativeNumberSchema,
		per_model_usd: z.record(z.string(), nonNegativeNumberSchema),
	})
	.strict();

export type BenchmarkCost = z.infer<typeof benchmarkCostSchema>;

export function parseBenchmarkCost(input: unknown): BenchmarkCost {
	return benchmarkCostSchema.parse(input);
}

export function assertBenchmarkCost(
	input: unknown,
): asserts input is BenchmarkCost {
	benchmarkCostSchema.parse(input);
}
