import type { BenchmarkResult } from "../wire/result.js";
import type { BenchmarkTask } from "../wire/task.js";
import type { SubmissionAdapter } from "./types.js";
import { SubmissionAdapterError } from "./types.js";

type GaiaTask = Omit<BenchmarkTask, "dataset"> & {
	readonly dataset: "gaia";
};

type GaiaSubmissionRow = {
	readonly task_id: string;
	readonly model_answer: string;
	readonly reasoning_trace?: string;
};

function readModelAnswer(result: BenchmarkResult): string {
	const value = result.output.model_answer ?? result.output.answer;

	if (typeof value !== "string" || value.trim().length === 0) {
		throw new SubmissionAdapterError(
			`GAIA submission result is missing a non-empty model_answer: ${result.task_id}`,
		);
	}

	return value;
}

function readReasoningTrace(result: BenchmarkResult): string | undefined {
	const value = result.output.reasoning_trace;

	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}

	return undefined;
}

function serializeRow(result: BenchmarkResult): GaiaSubmissionRow {
	if (result.task_id.trim().length === 0) {
		throw new SubmissionAdapterError(
			"GAIA submission result is missing task_id",
		);
	}

	const reasoningTrace = readReasoningTrace(result);

	return {
		task_id: result.task_id,
		model_answer: readModelAnswer(result),
		...(reasoningTrace == null ? {} : { reasoning_trace: reasoningTrace }),
	};
}

function assertSafeRunId(runId: string): void {
	if (
		runId.trim().length === 0 ||
		runId.includes("/") ||
		runId.includes("\\")
	) {
		throw new SubmissionAdapterError(`Invalid submission run_id: ${runId}`);
	}
}

export function createGaiaJsonlAdapter(): SubmissionAdapter<GaiaTask> {
	return {
		dataset: "gaia",
		format: "jsonl",
		serialize(results) {
			if (results.length === 0) {
				return "";
			}

			return `${results.map((result) => JSON.stringify(serializeRow(result))).join("\n")}\n`;
		},
		filename(runId) {
			assertSafeRunId(runId);

			return `gaia-${runId}.jsonl`;
		},
	};
}

export const gaiaJsonlAdapter = createGaiaJsonlAdapter();
