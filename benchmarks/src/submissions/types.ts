import type { BenchmarkResult } from "../wire/result.js";
import type { BenchmarkTask } from "../wire/task.js";

export type SubmissionFormat = "jsonl" | "json" | "csv";

export type SubmissionAdapter<T extends BenchmarkTask = BenchmarkTask> = {
	readonly dataset: T["dataset"];
	readonly format: SubmissionFormat;
	readonly serialize: (results: readonly BenchmarkResult[]) => string;
	readonly serializeFiles?: (
		results: readonly BenchmarkResult[],
		runId: string,
	) => ReadonlyMap<string, string>;
	readonly filename: (runId: string) => string;
};

export function serializeSubmissionFiles(
	adapter: SubmissionAdapter,
	results: readonly BenchmarkResult[],
	runId: string,
): ReadonlyMap<string, string> {
	return (
		adapter.serializeFiles?.(results, runId) ??
		new Map([[adapter.filename(runId), adapter.serialize(results)]])
	);
}

export class SubmissionAdapterError extends Error {
	override readonly name: string = "SubmissionAdapterError";
}

export class SubmissionAdapterRegistryError extends SubmissionAdapterError {
	override readonly name = "SubmissionAdapterRegistryError";
}
