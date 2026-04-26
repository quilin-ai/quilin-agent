import type { BenchmarkResult } from "../wire/result.js";
import type { BenchmarkTask } from "../wire/task.js";
import type { SubmissionAdapter } from "./types.js";
import { SubmissionAdapterError } from "./types.js";

type BfclV4MultiTurnTask = Omit<BenchmarkTask, "dataset"> & {
	readonly dataset: "bfcl-v4";
};

export interface BfclV4MultiTurnSubmissionAdapterOptions {
	readonly modelName?: string;
}

type BfclMultiTurnManifest = {
	readonly partial_eval: true;
	readonly official_parity: false;
	readonly stateful_eval: false;
	readonly bfcl_slice: "multi_turn";
	readonly categories_included: readonly string[];
	readonly result_files: readonly string[];
	readonly quilin_run_metadata: {
		readonly model_name: string;
		readonly run_ids: readonly string[];
	};
};

type BfclMultiTurnResultRow = {
	readonly id: string;
	readonly result: readonly unknown[];
	readonly input_token_count?: readonly unknown[];
	readonly output_token_count?: readonly unknown[];
	readonly latency?: readonly unknown[];
	readonly inference_log?: unknown;
};

export function createBfclV4MultiTurnJsonlAdapter(
	options: BfclV4MultiTurnSubmissionAdapterOptions = {},
): SubmissionAdapter<BfclV4MultiTurnTask> {
	const modelName = options.modelName ?? "quilin-agent";
	return {
		dataset: "bfcl-v4",
		format: "json",
		serialize(results) {
			return `${JSON.stringify(createManifest(results, modelName), null, 2)}\n`;
		},
		serializeFiles(results, runId) {
			assertSafePathSegment(runId, "run_id");
			const files = new Map<string, string>();
			const resultFiles = createBfclV4MultiTurnResultFiles(results, {
				modelName,
				runId,
			});
			const manifest = createManifest(results, modelName, runId, resultFiles);
			files.set(
				`bfcl-v4/${runId}/manifest.json`,
				`${JSON.stringify(manifest, null, 2)}\n`,
			);
			for (const file of resultFiles) {
				files.set(file.path, file.content);
			}
			return files;
		},
		filename(runId) {
			assertSafePathSegment(runId, "run_id");
			return `bfcl-v4/${runId}/manifest.json`;
		},
	};
}

export function createBfclV4MultiTurnResultFiles(
	results: readonly BenchmarkResult[],
	options: BfclV4MultiTurnSubmissionAdapterOptions & { readonly runId: string },
): readonly { readonly path: string; readonly content: string }[] {
	const modelName = options.modelName ?? "quilin-agent";
	const byCategory = new Map<string, BenchmarkResult[]>();
	for (const result of results) {
		const category = readCategory(result);
		byCategory.set(category, [...(byCategory.get(category) ?? []), result]);
	}
	return [...byCategory.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([category, categoryResults]) => {
			const rows = categoryResults.map((result) => serializeResultRow(result));
			return {
				content: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
				path: resultPath({ category, modelName, runId: options.runId }),
			};
		});
}

function createManifest(
	results: readonly BenchmarkResult[],
	modelName: string,
	runId = "RUN_ID",
	files = createBfclV4MultiTurnResultFiles(results, { modelName, runId }),
): BfclMultiTurnManifest {
	return {
		bfcl_slice: "multi_turn",
		categories_included: categoriesIncluded(results),
		official_parity: false,
		partial_eval: true,
		quilin_run_metadata: {
			model_name: modelName,
			run_ids: unique(results.map((result) => result.run_id)),
		},
		result_files: files.map((file) =>
			file.path.replace("/RUN_ID/", "/<run_id>/"),
		),
		stateful_eval: false,
	};
}

function serializeResultRow(result: BenchmarkResult): BfclMultiTurnResultRow {
	const trajectory =
		result.output.model_output_trajectory ?? result.output.result;
	if (!Array.isArray(trajectory)) {
		throw new SubmissionAdapterError(
			`BFCL v4 multi-turn result is missing nested trajectory: ${result.task_id}`,
		);
	}
	return {
		id: result.task_id,
		inference_log: result.output.inference_log,
		input_token_count: optionalNestedArray(result.output.input_token_count),
		latency: optionalNestedArray(result.output.latency),
		output_token_count: optionalNestedArray(result.output.output_token_count),
		result: trajectory,
	};
}

function optionalNestedArray(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function resultPath(input: {
	readonly runId: string;
	readonly modelName: string;
	readonly category: string;
}): string {
	assertSafePathSegment(input.runId, "run_id");
	assertSafePathSegment(input.modelName, "model_name");
	assertSafePathSegment(input.category, "category");
	return `bfcl-v4/${input.runId}/result/${input.modelName}/multi_turn/BFCL_v4_${input.category}_result.json`;
}

function readCategory(result: BenchmarkResult): string {
	const category = result.details.category ?? result.output.category;
	if (typeof category !== "string" || category.trim().length === 0) {
		throw new SubmissionAdapterError(
			`BFCL v4 multi-turn result is missing category metadata: ${result.task_id}`,
		);
	}
	return category;
}

function categoriesIncluded(
	results: readonly BenchmarkResult[],
): readonly string[] {
	return unique(results.map((result) => readCategory(result))).sort();
}

function unique(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

function assertSafePathSegment(value: string, label: string): void {
	if (
		value.trim().length === 0 ||
		value.includes("/") ||
		value.includes("\\") ||
		value.includes("..")
	) {
		throw new SubmissionAdapterError(
			`Invalid BFCL v4 multi-turn ${label}: ${value}`,
		);
	}
}

export const bfclV4MultiTurnJsonlAdapter = createBfclV4MultiTurnJsonlAdapter();
