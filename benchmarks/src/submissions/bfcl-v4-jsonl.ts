import type { BenchmarkResult } from "../wire/result.js";
import type { BenchmarkTask } from "../wire/task.js";
import type { SubmissionAdapter } from "./types.js";
import { SubmissionAdapterError } from "./types.js";

type BfclV4Task = Omit<BenchmarkTask, "dataset"> & {
	readonly dataset: "bfcl-v4";
};

export interface BfclV4SubmissionAdapterOptions {
	readonly modelName?: string;
}

export interface BfclV4ResultFile {
	readonly path: string;
	readonly content: string;
}

type BfclToolCall = {
	readonly function: string;
	readonly arguments: Readonly<Record<string, unknown>>;
};

type BfclSubmissionRow = {
	readonly id: string;
	readonly result: readonly Record<string, string>[];
	readonly input_token_count?: number;
	readonly output_token_count?: number;
	readonly latency_ms?: number;
};

type BfclSubmissionManifest = {
	readonly partial_eval: true;
	readonly official_parity: false;
	readonly categories_included: readonly string[];
	readonly result_files: readonly string[];
	readonly quilin_run_metadata: {
		readonly run_ids: readonly string[];
		readonly model_name: string;
	};
};

export function createBfclV4JsonlAdapter(
	options: BfclV4SubmissionAdapterOptions = {},
): SubmissionAdapter<BfclV4Task> {
	const modelName = options.modelName ?? "quilin-agent";
	return {
		dataset: "bfcl-v4",
		format: "json",
		serialize(results) {
			return `${JSON.stringify(createBfclV4SubmissionManifest(results, modelName), null, 2)}\n`;
		},
		filename(runId) {
			assertSafePathSegment(runId, "run_id");
			return `bfcl-v4/${runId}/manifest.json`;
		},
	};
}

export function createBfclV4ResultFiles(
	results: readonly BenchmarkResult[],
	options: BfclV4SubmissionAdapterOptions & { readonly runId: string } = {
		runId: "run",
	},
): readonly BfclV4ResultFile[] {
	const modelName = options.modelName ?? "quilin-agent";
	const byCategory = new Map<string, BenchmarkResult[]>();
	for (const result of results) {
		const category = readStringDetail(result, "category");
		const generalCategory = readStringDetail(result, "general_category");
		if (category == null || generalCategory == null) {
			throw new SubmissionAdapterError(
				`BFCL v4 result is missing category metadata: ${result.task_id}`,
			);
		}
		const key = `${generalCategory}\u0000${category}`;
		byCategory.set(key, [...(byCategory.get(key) ?? []), result]);
	}

	return [...byCategory.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, categoryResults]) => {
			const [generalCategory, category] = key.split("\u0000") as [
				string,
				string,
			];
			const rows = categoryResults.map((result) => serializeResultRow(result));
			return {
				content: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
				path: bfclV4ResultPath({
					category,
					generalCategory,
					modelName,
					runId: options.runId,
				}),
			};
		});
}

function createBfclV4SubmissionManifest(
	results: readonly BenchmarkResult[],
	modelName: string,
): BfclSubmissionManifest {
	const files = createBfclV4ResultFiles(results, {
		modelName,
		runId: "RUN_ID",
	});
	return {
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
	};
}

function serializeResultRow(result: BenchmarkResult): BfclSubmissionRow {
	const toolCalls = readToolCalls(result.output.tool_calls, result.task_id);
	return {
		id: result.task_id,
		input_token_count: optionalPositiveInteger(result.cost.input_tokens),
		latency_ms: optionalNonNegativeNumber(result.latency_ms),
		output_token_count: optionalPositiveInteger(result.cost.output_tokens),
		result: toolCalls.map((toolCall) => ({
			[toolCall.function]: JSON.stringify(toolCall.arguments),
		})),
	};
}

function readToolCalls(
	value: unknown,
	taskId: string,
): readonly BfclToolCall[] {
	if (!Array.isArray(value)) {
		throw new SubmissionAdapterError(
			`BFCL v4 submission result is missing tool_calls: ${taskId}`,
		);
	}
	return value.map((entry) => {
		if (!isRecord(entry)) {
			throw new SubmissionAdapterError(
				`BFCL v4 submission tool_call must be an object: ${taskId}`,
			);
		}
		const functionName = entry.function;
		const args = entry.arguments;
		if (typeof functionName !== "string" || !isRecord(args)) {
			throw new SubmissionAdapterError(
				`BFCL v4 submission tool_call requires function and arguments: ${taskId}`,
			);
		}
		return {
			arguments: args,
			function: functionName,
		};
	});
}

function bfclV4ResultPath(input: {
	readonly runId: string;
	readonly modelName: string;
	readonly generalCategory: string;
	readonly category: string;
}): string {
	assertSafePathSegment(input.runId, "run_id");
	assertSafePathSegment(input.modelName, "model_name");
	assertSafePathSegment(input.generalCategory, "general_category");
	assertSafePathSegment(input.category, "category");
	return `bfcl-v4/${input.runId}/result/${input.modelName}/${input.generalCategory}/BFCL_v4_${input.category}_result.json`;
}

function categoriesIncluded(
	results: readonly BenchmarkResult[],
): readonly string[] {
	return unique(
		results
			.map((result) => readStringDetail(result, "category"))
			.filter((category): category is string => category != null),
	).sort();
}

function readStringDetail(
	result: BenchmarkResult,
	key: string,
): string | undefined {
	const value = result.details[key] ?? result.output[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function unique(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

function optionalPositiveInteger(value: number): number | undefined {
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalNonNegativeNumber(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function assertSafePathSegment(value: string, label: string): void {
	if (
		value.trim().length === 0 ||
		value.includes("/") ||
		value.includes("\\") ||
		value.includes("..")
	) {
		throw new SubmissionAdapterError(`Invalid BFCL v4 ${label}: ${value}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

export const bfclV4JsonlAdapter = createBfclV4JsonlAdapter();
