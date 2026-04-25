import { z } from "zod";
import type { BenchmarkTask } from "../wire/task.js";
import { CacheError, loadDatasetCache } from "./cache.js";

export const SWE_BENCH_VERIFIED_DATASET = "swe-bench-verified";
export const SWE_BENCH_VERIFIED_EXPECTED_ROWS = 500;

const sweBenchVerifiedRecordSchema = z
	.object({
		instance_id: z.string().min(1),
		problem_statement: z.string().min(1),
		repo: z.string().min(1),
		base_commit: z.string().min(1),
		patch: z.string().min(1),
		test_patch: z.string().min(1),
		difficulty: z.string().min(1).optional(),
		environment_setup_commit: z.string().min(1).optional(),
		version: z.string().min(1).optional(),
	})
	.passthrough();

type SweBenchVerifiedRecord = z.infer<typeof sweBenchVerifiedRecordSchema>;

export interface SweBenchVerifiedTaskFilter {
	readonly instanceIds?: readonly string[];
	readonly repos?: readonly string[];
	readonly difficulties?: readonly string[];
}

export interface LoadSweBenchVerifiedTasksOptions {
	readonly cacheRoot?: string;
	readonly filter?: SweBenchVerifiedTaskFilter;
}

export async function loadSweBenchVerifiedTasks(
	options: LoadSweBenchVerifiedTasksOptions = {},
): Promise<BenchmarkTask[]> {
	const tasks: BenchmarkTask[] = [];
	for await (const task of iterateSweBenchVerifiedTasks(options)) {
		tasks.push(task);
	}
	return tasks;
}

export async function* iterateSweBenchVerifiedTasks(
	options: LoadSweBenchVerifiedTasksOptions = {},
): AsyncIterable<BenchmarkTask> {
	const cache = await loadDatasetCache({
		cacheRoot: options.cacheRoot,
		dataset: SWE_BENCH_VERIFIED_DATASET,
	});
	const filter = normalizeFilter(options.filter);

	let index = 0;
	for (const line of cache.data.split(/\r?\n/)) {
		if (line.length === 0) {
			continue;
		}
		const record = parseJsonlRecord(line, index);
		if (matchesFilter(record, filter)) {
			yield toBenchmarkTask(record, index);
		}
		index += 1;
	}

	if (index !== cache.manifest.rows) {
		throw new CacheError(
			`SWE-bench Verified row count mismatch: manifest has ${cache.manifest.rows}, data has ${index}`,
		);
	}
}

function normalizeFilter(
	filter: SweBenchVerifiedTaskFilter | undefined,
): Required<SweBenchVerifiedTaskFilter> {
	return {
		difficulties: filter?.difficulties ?? [],
		instanceIds: filter?.instanceIds ?? [],
		repos: filter?.repos ?? [],
	};
}

function matchesFilter(
	record: SweBenchVerifiedRecord,
	filter: Required<SweBenchVerifiedTaskFilter>,
): boolean {
	if (
		filter.instanceIds.length > 0 &&
		!filter.instanceIds.includes(record.instance_id)
	) {
		return false;
	}
	if (filter.repos.length > 0 && !filter.repos.includes(record.repo)) {
		return false;
	}
	if (
		filter.difficulties.length > 0 &&
		(record.difficulty == null ||
			!filter.difficulties.includes(record.difficulty))
	) {
		return false;
	}
	return true;
}

function parseJsonlRecord(line: string, index: number): SweBenchVerifiedRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new CacheError(
			`Invalid SWE-bench Verified JSONL at row ${index}: ${formatCause(error)}`,
		);
	}

	const result = sweBenchVerifiedRecordSchema.safeParse(parsed);
	if (!result.success) {
		throw new CacheError(
			`Invalid SWE-bench Verified record at row ${index}: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
		);
	}
	return result.data;
}

function toBenchmarkTask(
	record: SweBenchVerifiedRecord,
	index: number,
): BenchmarkTask {
	return {
		task_id: record.instance_id,
		dataset: SWE_BENCH_VERIFIED_DATASET,
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
		metadata: {
			source_row: index,
			...(record.difficulty == null ? {} : { difficulty: record.difficulty }),
			...(record.environment_setup_commit == null
				? {}
				: { environment_setup_commit: record.environment_setup_commit }),
			...(record.version == null ? {} : { version: record.version }),
		},
	};
}

function formatCause(error: unknown): string {
	return String(error);
}
