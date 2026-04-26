import { z } from "zod";
import type { BenchmarkTask } from "../wire/task.js";
import { BFCL_V4_DATASET, BFCL_V4_PINNED_COMMIT } from "./bfcl-v4.js";
import { CacheError, loadDatasetCache } from "./cache.js";

export const BFCL_V4_MULTI_TURN_SCORER_TYPE = "bfcl-v4-multi-turn";

export const BFCL_V4_MULTI_TURN_CATEGORIES = [
	"multi_turn_base",
	"multi_turn_miss_func",
	"multi_turn_miss_param",
	"multi_turn_long_context",
] as const;

const bfclV4MultiTurnCategorySchema = z.enum(BFCL_V4_MULTI_TURN_CATEGORIES);
const bfclV4MultiTurnRawRecordSchema = z
	.object({
		id: z.string().min(1),
		category: bfclV4MultiTurnCategorySchema,
		general_category: z.literal("multi_turn"),
		question: z.array(z.array(z.record(z.string(), z.unknown()))),
		initial_config: z.record(z.string(), z.unknown()),
		involved_classes: z.array(z.string().min(1)),
		path: z.array(z.string()).default([]),
		possible_answer: z.array(z.array(z.string())),
		fixture_result: z.record(z.string(), z.unknown()).optional(),
		excluded_function: z.array(z.string()).optional(),
		missed_function: z.record(z.string(), z.array(z.string())).optional(),
	})
	.passthrough();

type BfclV4MultiTurnRawRecord = z.infer<typeof bfclV4MultiTurnRawRecordSchema>;

export type BfclV4MultiTurnCategory = z.infer<
	typeof bfclV4MultiTurnCategorySchema
>;

export interface BfclV4MultiTurnTaskFilter {
	readonly categories?: readonly BfclV4MultiTurnCategory[];
	readonly taskIds?: readonly string[];
}

export interface LoadBfclV4MultiTurnTasksOptions {
	readonly cacheRoot?: string;
	readonly filter?: BfclV4MultiTurnTaskFilter;
}

export async function loadBfclV4MultiTurnTasks(
	options: LoadBfclV4MultiTurnTasksOptions = {},
): Promise<BenchmarkTask[]> {
	const tasks: BenchmarkTask[] = [];
	for await (const task of iterateBfclV4MultiTurnTasks(options)) {
		tasks.push(task);
	}
	return tasks;
}

export async function* iterateBfclV4MultiTurnTasks(
	options: LoadBfclV4MultiTurnTasksOptions = {},
): AsyncIterable<BenchmarkTask> {
	const cache = await loadDatasetCache({
		cacheRoot: options.cacheRoot,
		dataset: BFCL_V4_DATASET,
	});
	const filter = normalizeFilter(options.filter);

	let index = 0;
	let yielded = 0;
	for (const line of cache.data.split(/\r?\n/)) {
		if (line.length === 0) {
			continue;
		}
		const parsed = parseJsonLine(line, index);
		if (!isMultiTurnRaw(parsed)) {
			index += 1;
			continue;
		}
		const record = parseMultiTurnRecord(parsed, index);
		if (matchesFilter(record, filter)) {
			yield toBenchmarkTask(record, index);
			yielded += 1;
		}
		index += 1;
	}

	if (index !== cache.manifest.rows) {
		throw new CacheError(
			`BFCL v4 multi-turn row count mismatch: manifest has ${cache.manifest.rows}, data has ${index}`,
		);
	}
	if (
		yielded === 0 &&
		filter.categories.length === 0 &&
		filter.taskIds.length === 0
	) {
		throw new CacheError("BFCL v4 cache contains no multi-turn rows");
	}
}

function normalizeFilter(
	filter: BfclV4MultiTurnTaskFilter | undefined,
): Required<BfclV4MultiTurnTaskFilter> {
	return {
		categories: filter?.categories ?? [],
		taskIds: filter?.taskIds ?? [],
	};
}

function matchesFilter(
	record: BfclV4MultiTurnRawRecord,
	filter: Required<BfclV4MultiTurnTaskFilter>,
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
	return true;
}

function parseJsonLine(line: string, index: number): unknown {
	try {
		return JSON.parse(line);
	} catch (error) {
		throw new CacheError(
			`Invalid BFCL v4 JSONL at row ${index}: ${formatCause(error)}`,
		);
	}
}

function parseMultiTurnRecord(
	value: unknown,
	index: number,
): BfclV4MultiTurnRawRecord {
	const result = bfclV4MultiTurnRawRecordSchema.safeParse(value);
	if (!result.success) {
		throw new CacheError(
			`Invalid BFCL v4 multi-turn record at row ${index}: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
		);
	}
	return result.data;
}

function toBenchmarkTask(
	record: BfclV4MultiTurnRawRecord,
	index: number,
): BenchmarkTask {
	const fixtureResult = record.fixture_result;
	return {
		dataset: BFCL_V4_DATASET,
		expected: {
			category: record.category,
			general_category: "multi_turn",
			initial_config: record.initial_config,
			involved_classes: record.involved_classes,
			possible_answer: record.possible_answer,
			...(fixtureResult == null ? {} : { fixture_result: fixtureResult }),
		},
		inputs: {
			question: extractQuestionText(record.question),
			turns: record.question,
		},
		metadata: {
			bfcl_version: "v4",
			category: record.category,
			excluded_function: record.excluded_function ?? [],
			general_category: "multi_turn",
			missed_function: record.missed_function ?? {},
			multi_turn: true,
			official_parity: false,
			partial_eval: true,
			path: record.path,
			source_commit: BFCL_V4_PINNED_COMMIT,
			source_row: index,
			stateful_eval: false,
		},
		scorer_type: BFCL_V4_MULTI_TURN_SCORER_TYPE,
		task_id: record.id,
	};
}

function extractQuestionText(turns: readonly unknown[]): string {
	const parts: string[] = [];
	collectContentStrings(turns, parts);
	return parts.length === 0 ? JSON.stringify(turns) : parts.join("\n");
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

function isMultiTurnRaw(value: unknown): boolean {
	return isRecord(value) && value.general_category === "multi_turn";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function formatCause(error: unknown): string {
	return String(error);
}
