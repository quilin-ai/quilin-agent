import { z } from "zod";
import type { BenchmarkTask } from "../wire/task.js";
import { CacheError, loadDatasetCache } from "./cache.js";

const SWE_BENCH_LITE_DATASET = "swe-bench-lite";

const sweBenchLiteRecordSchema = z
	.object({
		instance_id: z.string().min(1),
		problem_statement: z.string().min(1),
		repo: z.string().min(1),
		base_commit: z.string().min(1),
		patch: z.string().min(1),
		test_patch: z.string().min(1),
	})
	.passthrough();

type SweBenchLiteRecord = z.infer<typeof sweBenchLiteRecordSchema>;

export interface LoadSweBenchLiteTasksOptions {
	readonly cacheRoot?: string;
}

export async function loadSweBenchLiteTasks(
	options: LoadSweBenchLiteTasksOptions = {},
): Promise<BenchmarkTask[]> {
	const tasks: BenchmarkTask[] = [];
	for await (const task of iterateSweBenchLiteTasks(options)) {
		tasks.push(task);
	}
	return tasks;
}

export async function* iterateSweBenchLiteTasks(
	options: LoadSweBenchLiteTasksOptions = {},
): AsyncIterable<BenchmarkTask> {
	const cache = await loadDatasetCache({
		cacheRoot: options.cacheRoot,
		dataset: SWE_BENCH_LITE_DATASET,
	});

	let index = 0;
	for (const line of cache.data.split(/\r?\n/)) {
		if (line.length === 0) {
			continue;
		}
		const record = parseJsonlRecord(line, index);
		yield toBenchmarkTask(record, index);
		index += 1;
	}

	if (index !== cache.manifest.rows) {
		throw new CacheError(
			`SWE-bench Lite row count mismatch: manifest has ${cache.manifest.rows}, data has ${index}`,
		);
	}
}

export function takeFirstN<T>(records: Iterable<T>, n: number): T[] {
	if (!Number.isInteger(n) || n < 0) {
		throw new RangeError(`n must be a non-negative integer, got: ${n}`);
	}
	const taken: T[] = [];
	if (n === 0) {
		return taken;
	}
	for (const record of records) {
		taken.push(record);
		if (taken.length === n) {
			break;
		}
	}
	return taken;
}

function parseJsonlRecord(line: string, index: number): SweBenchLiteRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new CacheError(
			`Invalid SWE-bench Lite JSONL at row ${index}: ${formatCause(error)}`,
		);
	}

	const result = sweBenchLiteRecordSchema.safeParse(parsed);
	if (!result.success) {
		throw new CacheError(
			`Invalid SWE-bench Lite record at row ${index}: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
		);
	}
	return result.data;
}

function toBenchmarkTask(
	record: SweBenchLiteRecord,
	index: number,
): BenchmarkTask {
	return {
		task_id: record.instance_id,
		dataset: SWE_BENCH_LITE_DATASET,
		inputs: {
			problem_statement: record.problem_statement,
			repo: record.repo,
			base_commit: record.base_commit,
		},
		expected: {
			golden_patch: record.patch,
			test_patch: record.test_patch,
		},
		scorer_type: "swe-bench-patch-apply",
		metadata: { source_row: index },
	};
}

function formatCause(error: unknown): string {
	return String(error);
}
