import { z } from "zod";
import type { BenchmarkTask } from "../wire/task.js";
import { CacheError, loadDatasetCache } from "./cache.js";

export const BFCL_V4_DATASET = "bfcl-v4";
export const BFCL_V4_SCORER_TYPE = "bfcl-v4-ast";
export const BFCL_V4_VERSION_PREFIX = "BFCL_v4";
export const BFCL_V4_PINNED_COMMIT = "f7cf735";

export const BFCL_V4_NON_LIVE_CATEGORIES = [
	"simple_python",
	"simple_java",
	"simple_javascript",
	"multiple",
	"parallel",
	"parallel_multiple",
	"irrelevance",
] as const;

export const BFCL_V4_LIVE_CATEGORIES = [
	"live_simple",
	"live_multiple",
	"live_parallel",
	"live_parallel_multiple",
	"live_irrelevance",
	"live_relevance",
] as const;

export const BFCL_V4_SUPPORTED_AST_CATEGORIES = [
	...BFCL_V4_NON_LIVE_CATEGORIES,
	...BFCL_V4_LIVE_CATEGORIES,
] as const;

const bfclV4CategorySchema = z.enum(BFCL_V4_SUPPORTED_AST_CATEGORIES);
const bfclV4GeneralCategorySchema = z.enum(["non_live", "live"]);
const bfclV4RawRecordSchema = z
	.object({
		id: z.string().min(1),
		category: bfclV4CategorySchema,
		general_category: bfclV4GeneralCategorySchema,
		question: z.unknown(),
		function: z.array(z.record(z.string(), z.unknown())).default([]),
		ground_truth: z.unknown().optional(),
	})
	.passthrough();

export type BfclV4Category = z.infer<typeof bfclV4CategorySchema>;
export type BfclV4GeneralCategory = z.infer<typeof bfclV4GeneralCategorySchema>;

type BfclV4RawRecord = z.infer<typeof bfclV4RawRecordSchema>;

export interface BfclV4TaskFilter {
	readonly taskIds?: readonly string[];
	readonly categories?: readonly BfclV4Category[];
	readonly generalCategories?: readonly BfclV4GeneralCategory[];
}

export interface LoadBfclV4TasksOptions {
	readonly cacheRoot?: string;
	readonly filter?: BfclV4TaskFilter;
}

export async function loadBfclV4Tasks(
	options: LoadBfclV4TasksOptions = {},
): Promise<BenchmarkTask[]> {
	const tasks: BenchmarkTask[] = [];
	for await (const task of iterateBfclV4Tasks(options)) {
		tasks.push(task);
	}
	return tasks;
}

export async function* iterateBfclV4Tasks(
	options: LoadBfclV4TasksOptions = {},
): AsyncIterable<BenchmarkTask> {
	const cache = await loadDatasetCache({
		cacheRoot: options.cacheRoot,
		dataset: BFCL_V4_DATASET,
	});
	const filter = normalizeFilter(options.filter);

	let index = 0;
	for (const line of cache.data.split(/\r?\n/)) {
		if (line.length === 0) {
			continue;
		}
		if (isMultiTurnLine(line)) {
			index += 1;
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
			`BFCL v4 row count mismatch: manifest has ${cache.manifest.rows}, data has ${index}`,
		);
	}
}

function normalizeFilter(
	filter: BfclV4TaskFilter | undefined,
): Required<BfclV4TaskFilter> {
	return {
		categories: filter?.categories ?? [],
		generalCategories: filter?.generalCategories ?? [],
		taskIds: filter?.taskIds ?? [],
	};
}

function matchesFilter(
	record: BfclV4RawRecord,
	filter: Required<BfclV4TaskFilter>,
): boolean {
	if (filter.taskIds.length > 0 && !filter.taskIds.includes(record.id)) {
		return false;
	}
	if (
		filter.categories.length > 0 &&
		!filter.categories.includes(record.category)
	) {
		return false;
	}
	if (
		filter.generalCategories.length > 0 &&
		!filter.generalCategories.includes(record.general_category)
	) {
		return false;
	}
	return true;
}

function parseJsonlRecord(line: string, index: number): BfclV4RawRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new CacheError(
			`Invalid BFCL v4 JSONL at row ${index}: ${formatCause(error)}`,
		);
	}
	const result = bfclV4RawRecordSchema.safeParse(parsed);
	if (!result.success) {
		throw new CacheError(
			`Invalid BFCL v4 record at row ${index}: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
		);
	}
	return result.data;
}

function isMultiTurnLine(line: string): boolean {
	try {
		const parsed = JSON.parse(line);
		return isRecord(parsed) && parsed.general_category === "multi_turn";
	} catch {
		return false;
	}
}

function toBenchmarkTask(
	record: BfclV4RawRecord,
	index: number,
): BenchmarkTask {
	return {
		dataset: BFCL_V4_DATASET,
		expected: {
			category: record.category,
			expected_tool_calls: normalizeExpectedToolCalls(record.ground_truth),
			general_category: record.general_category,
			ground_truth: record.ground_truth ?? [],
		},
		inputs: {
			function_definitions: record.function,
			messages: record.question,
			question: extractQuestionText(record.question),
		},
		metadata: {
			bfcl_version: "v4",
			category: record.category,
			general_category: record.general_category,
			official_parity: false,
			partial_eval: true,
			source_commit: BFCL_V4_PINNED_COMMIT,
			source_row: index,
		},
		scorer_type: BFCL_V4_SCORER_TYPE,
		task_id: record.id,
	};
}

function normalizeExpectedToolCalls(
	groundTruth: unknown,
): readonly Record<string, unknown>[] {
	if (!Array.isArray(groundTruth)) {
		return [];
	}
	return groundTruth.flatMap((entry) => {
		if (!isRecord(entry)) {
			return [];
		}
		return Object.entries(entry).map(([functionName, rawArguments]) => ({
			arguments: normalizeFirstAllowedArguments(rawArguments),
			function: functionName,
		}));
	});
}

function normalizeFirstAllowedArguments(
	rawArguments: unknown,
): Record<string, unknown> {
	if (!isRecord(rawArguments)) {
		return {};
	}
	const normalized: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(rawArguments)) {
		if (Array.isArray(value) && value.length > 0) {
			normalized[name] = value[0];
		} else {
			normalized[name] = value;
		}
	}
	return normalized;
}

function extractQuestionText(question: unknown): string {
	const parts: string[] = [];
	collectContentStrings(question, parts);
	if (parts.length > 0) {
		return parts.join("\n");
	}
	return JSON.stringify(question);
}

function collectContentStrings(value: unknown, parts: string[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectContentStrings(entry, parts);
		}
		return;
	}
	if (!isRecord(value)) {
		return;
	}
	const content = value.content;
	if (typeof content === "string" && content.trim().length > 0) {
		parts.push(content);
	}
	for (const [key, nested] of Object.entries(value)) {
		if (key !== "content") {
			collectContentStrings(nested, parts);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function formatCause(error: unknown): string {
	return String(error);
}
