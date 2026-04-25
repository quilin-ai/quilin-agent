import { z } from "zod";

const unknownRecordSchema = z.record(z.string(), z.unknown());

export const benchmarkDatasetSchema = z.enum([
	"swe-bench-lite",
	"swe-bench-verified",
]);

export const benchmarkTaskSchema = z
	.object({
		task_id: z.string().min(1),
		dataset: benchmarkDatasetSchema,
		inputs: unknownRecordSchema,
		expected: unknownRecordSchema,
		scorer_type: z.string().min(1),
		token_budget: z.number().int().positive().optional(),
		metadata: unknownRecordSchema.optional(),
	})
	.strict();

export type BenchmarkDataset = z.infer<typeof benchmarkDatasetSchema>;
export type BenchmarkTask = z.infer<typeof benchmarkTaskSchema>;

export function parseBenchmarkTask(input: unknown): BenchmarkTask {
	return benchmarkTaskSchema.parse(input);
}

export function assertBenchmarkTask(
	input: unknown,
): asserts input is BenchmarkTask {
	benchmarkTaskSchema.parse(input);
}
