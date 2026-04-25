import type { BenchmarkResult } from "../wire/result.js";
import type { BenchmarkTask } from "../wire/task.js";
import type { SubmissionAdapter } from "./types.js";
import { SubmissionAdapterError } from "./types.js";

type SweBenchVerifiedTask = BenchmarkTask & {
	readonly dataset: "swe-bench-verified";
};

type SweBenchPrediction = {
	readonly instance_id: string;
	readonly model_name_or_path: string;
	readonly model_patch: string;
};

type SweBenchVerifiedJsonlAdapterOptions = {
	readonly modelNameOrPath?: string;
};

const DEFAULT_MODEL_NAME_OR_PATH = "quilin-agent";

function readPatch(result: BenchmarkResult): string {
	const patch = result.output.patch ?? result.output.diff;

	if (typeof patch !== "string" || patch.trim().length === 0) {
		throw new SubmissionAdapterError(
			`SWE-bench submission result is missing a non-empty patch: ${result.task_id}`,
		);
	}

	return patch;
}

function serializePrediction(
	result: BenchmarkResult,
	modelNameOrPath: string,
): SweBenchPrediction {
	if (result.task_id.trim().length === 0) {
		throw new SubmissionAdapterError(
			"SWE-bench submission result is missing instance_id",
		);
	}

	return {
		instance_id: result.task_id,
		model_name_or_path: modelNameOrPath,
		model_patch: readPatch(result),
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

export function createSweBenchVerifiedJsonlAdapter(
	options: SweBenchVerifiedJsonlAdapterOptions = {},
): SubmissionAdapter<SweBenchVerifiedTask> {
	const modelNameOrPath =
		options.modelNameOrPath?.trim() || DEFAULT_MODEL_NAME_OR_PATH;
	return {
		dataset: "swe-bench-verified",
		// Targets SWE-bench local harness prediction files; sb-cli upload
		// adapters are intentionally separate because their JSON shape differs.
		format: "jsonl",
		serialize(results) {
			if (results.length === 0) {
				return "";
			}

			return `${results
				.map((result) =>
					JSON.stringify(serializePrediction(result, modelNameOrPath)),
				)
				.join("\n")}\n`;
		},
		filename(runId) {
			assertSafeRunId(runId);

			return `swe-bench-verified-${runId}.jsonl`;
		},
	};
}

export const sweBenchVerifiedJsonlAdapter =
	createSweBenchVerifiedJsonlAdapter();
