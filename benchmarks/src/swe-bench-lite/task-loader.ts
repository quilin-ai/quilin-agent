import {
	loadSweBenchLiteFromCache,
	resolveBenchmarksRoot,
	type SweBenchLiteRecord,
} from "./dataset.js";

export interface SweBenchLiteTask {
	readonly instance_id: string;
	readonly problem_statement: string;
	readonly repo: string;
	readonly base_commit: string;
	readonly golden_patch: string;
	readonly test_patch: string;
}

export interface LoadSweBenchLiteTasksOptions {
	readonly cacheRoot?: string;
	readonly records?: readonly SweBenchLiteRecord[];
}

export function toSweBenchLiteTask(
	record: SweBenchLiteRecord,
): SweBenchLiteTask {
	return {
		instance_id: record.instance_id,
		problem_statement: record.problem_statement,
		repo: record.repo,
		base_commit: record.base_commit,
		golden_patch: record.patch,
		test_patch: record.test_patch,
	};
}

export async function loadSweBenchLiteTasks(
	options: LoadSweBenchLiteTasksOptions = {},
): Promise<readonly SweBenchLiteTask[]> {
	const records = await resolveRecords(options);
	return records.map(toSweBenchLiteTask);
}

export async function* iterateSweBenchLiteTasks(
	options: LoadSweBenchLiteTasksOptions = {},
): AsyncIterable<SweBenchLiteTask> {
	const records = await resolveRecords(options);
	for (const record of records) {
		yield toSweBenchLiteTask(record);
	}
}

export function takeFirstN<T>(items: readonly T[], n: number): readonly T[] {
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(
			`takeFirstN requires a non-negative integer, got: ${String(n)}`,
		);
	}
	return items.slice(0, n);
}

async function resolveRecords(
	options: LoadSweBenchLiteTasksOptions,
): Promise<readonly SweBenchLiteRecord[]> {
	if (options.records != null) {
		return options.records;
	}
	const cacheRoot = options.cacheRoot ?? resolveBenchmarksRoot();
	return loadSweBenchLiteFromCache(cacheRoot);
}
