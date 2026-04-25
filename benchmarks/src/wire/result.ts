import { z } from "zod";
import { benchmarkCostSchema } from "./cost.js";

const unknownRecordSchema = z.record(z.string(), z.unknown());

export const benchmarkResultSchema = z
	.object({
		run_id: z.string().min(1),
		task_id: z.string().min(1),
		output: unknownRecordSchema,
		passed: z.boolean(),
		score: z.number().min(0).max(1),
		details: unknownRecordSchema,
		cost: benchmarkCostSchema,
		latency_ms: z.number().nonnegative(),
	})
	.strict();

export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;

export function parseBenchmarkResult(input: unknown): BenchmarkResult {
	return benchmarkResultSchema.parse(input);
}

export function assertBenchmarkResult(
	input: unknown,
): asserts input is BenchmarkResult {
	benchmarkResultSchema.parse(input);
}
