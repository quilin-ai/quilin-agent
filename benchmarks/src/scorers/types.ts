import type { BenchmarkTask } from "../wire/task.js";

export type ScorerResult = {
	readonly passed: boolean;
	readonly score: number;
	readonly details: Record<string, unknown>;
};

export type Scorer<T extends BenchmarkTask = BenchmarkTask> = (
	task: T,
	output: Record<string, unknown>,
) => Promise<ScorerResult>;
