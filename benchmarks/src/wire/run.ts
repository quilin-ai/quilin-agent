import { z } from "zod";

const iso8601DateTimeSchema = z.iso.datetime({ offset: true });

export const benchmarkRunSchema = z
	.object({
		run_id: z.string().min(1),
		task_id: z.string().min(1),
		agent_session_id: z.string().min(1),
		started_at: iso8601DateTimeSchema,
		finished_at: iso8601DateTimeSchema,
	})
	.strict();

export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>;

export function parseBenchmarkRun(input: unknown): BenchmarkRun {
	return benchmarkRunSchema.parse(input);
}

export function assertBenchmarkRun(
	input: unknown,
): asserts input is BenchmarkRun {
	benchmarkRunSchema.parse(input);
}
