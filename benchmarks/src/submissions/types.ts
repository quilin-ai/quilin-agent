import type { BenchmarkResult } from "../wire/result.js";
import type { BenchmarkTask } from "../wire/task.js";

export type SubmissionFormat = "jsonl" | "json" | "csv";

export type SubmissionAdapter<T extends BenchmarkTask = BenchmarkTask> = {
	readonly dataset: T["dataset"];
	readonly format: SubmissionFormat;
	readonly serialize: (results: readonly BenchmarkResult[]) => string;
	readonly filename: (runId: string) => string;
};

export class SubmissionAdapterError extends Error {
	override readonly name: string = "SubmissionAdapterError";
}

export class SubmissionAdapterRegistryError extends SubmissionAdapterError {
	override readonly name = "SubmissionAdapterRegistryError";
}
