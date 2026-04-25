import { readFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { z } from "zod";
import type { BenchmarkTask } from "../wire/task.js";
import {
	CacheError,
	computeSha256,
	type DatasetManifest,
	loadDatasetCache,
} from "./cache.js";

export const GAIA_DATASET = "gaia";
export const GAIA_EXPECTED_VALIDATION_ROWS = 165;

const dockerCacheRoot = "/workspace/cache";
const maxAttachmentFilenameBytes = 255;
const gaiaRawRecordSchema = z.record(z.string(), z.unknown());
const attachmentFilePattern = /^[A-Za-z0-9._-]+$/;

type GaiaRawRecord = z.infer<typeof gaiaRawRecordSchema>;

export interface GaiaTaskFilter {
	readonly taskIds?: readonly string[];
	readonly levels?: readonly number[];
}

export interface LoadGaiaTasksOptions {
	readonly cacheRoot?: string;
	readonly filter?: GaiaTaskFilter;
}

interface GaiaRecord {
	readonly task_id: string;
	readonly question: string;
	readonly level: number;
	readonly final_answer: string;
	readonly file_name?: string;
	readonly raw: GaiaRawRecord;
}

interface GaiaAttachment {
	readonly container_path: string;
	readonly file_name: string;
	readonly file_path: string;
	readonly host_path: string;
	readonly relative_path: string;
	readonly sha256: string;
	readonly size_bytes: number;
}

interface GaiaPromptAttachment {
	readonly container_path: string;
	readonly file_name: string;
	readonly file_path: string;
	readonly sha256: string;
	readonly size_bytes: number;
}

export async function loadGaiaTasks(
	options: LoadGaiaTasksOptions = {},
): Promise<BenchmarkTask[]> {
	const tasks: BenchmarkTask[] = [];
	for await (const task of iterateGaiaTasks(options)) {
		tasks.push(task);
	}
	return tasks;
}

export async function* iterateGaiaTasks(
	options: LoadGaiaTasksOptions = {},
): AsyncIterable<BenchmarkTask> {
	const cache = await loadDatasetCache({
		cacheRoot: options.cacheRoot,
		dataset: GAIA_DATASET,
	});
	const filter = normalizeFilter(options.filter);

	let index = 0;
	for (const line of cache.data.split(/\r?\n/)) {
		if (line.length === 0) {
			continue;
		}
		const record = parseJsonlRecord(line, index);
		if (matchesFilter(record, filter)) {
			yield await toBenchmarkTask(
				record,
				index,
				cache.cacheDir,
				cache.manifest,
			);
		}
		index += 1;
	}

	if (index !== cache.manifest.rows) {
		throw new CacheError(
			`GAIA row count mismatch: manifest has ${cache.manifest.rows}, data has ${index}`,
		);
	}
}

function normalizeFilter(
	filter: GaiaTaskFilter | undefined,
): Required<GaiaTaskFilter> {
	return {
		levels: filter?.levels ?? [],
		taskIds: filter?.taskIds ?? [],
	};
}

function matchesFilter(
	record: GaiaRecord,
	filter: Required<GaiaTaskFilter>,
): boolean {
	if (filter.taskIds.length > 0 && !filter.taskIds.includes(record.task_id)) {
		return false;
	}
	if (filter.levels.length > 0 && !filter.levels.includes(record.level)) {
		return false;
	}
	return true;
}

function parseJsonlRecord(line: string, index: number): GaiaRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new CacheError(
			`Invalid GAIA JSONL at row ${index}: ${formatCause(error)}`,
		);
	}

	const result = gaiaRawRecordSchema.safeParse(parsed);
	if (!result.success) {
		throw new CacheError(
			`Invalid GAIA record at row ${index}: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
		);
	}

	return normalizeGaiaRecord(result.data, index);
}

function normalizeGaiaRecord(record: GaiaRawRecord, index: number): GaiaRecord {
	return {
		file_name: readOptionalStringField(record, ["file_name", "file"]),
		final_answer: readStringField(
			record,
			["Final answer", "final_answer", "answer"],
			index,
		),
		level: readLevel(record, index),
		question: readStringField(record, ["Question", "question"], index),
		raw: record,
		task_id: readStringField(record, ["task_id", "id"], index),
	};
}

function readStringField(
	record: GaiaRawRecord,
	keys: readonly string[],
	index: number,
): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
	}
	throw new CacheError(
		`Invalid GAIA record at row ${index}: missing ${keys.join("/")}`,
	);
}

function readOptionalStringField(
	record: GaiaRawRecord,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

function readLevel(record: GaiaRawRecord, index: number): number {
	const value = record.Level ?? record.level;
	const level =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	if (![1, 2, 3].includes(level)) {
		throw new CacheError(
			`Invalid GAIA record at row ${index}: level must be 1, 2, or 3`,
		);
	}
	return level;
}

async function toBenchmarkTask(
	record: GaiaRecord,
	index: number,
	cacheDir: string,
	manifest: DatasetManifest,
): Promise<BenchmarkTask> {
	const attachment = record.file_name
		? await resolveAttachment(cacheDir, record.file_name, manifest.attachments)
		: undefined;
	return {
		dataset: GAIA_DATASET,
		expected: {
			eval_metadata: {
				level: record.level,
				source_row: index,
			},
			final_answer: record.final_answer,
		},
		inputs: {
			...(attachment == null
				? {}
				: {
						file_attachments: [toPromptAttachment(attachment)],
						file_name: attachment.file_name,
						file_path: attachment.file_path,
					}),
			level: record.level,
			question: record.question,
		},
		metadata: {
			source_row: index,
			source_schema: "gaia-2023",
		},
		scorer_type: "gaia-exact-match",
		task_id: record.task_id,
	};
}

function toPromptAttachment(attachment: GaiaAttachment): GaiaPromptAttachment {
	return {
		container_path: attachment.container_path,
		file_name: attachment.file_name,
		file_path: attachment.file_path,
		sha256: attachment.sha256,
		size_bytes: attachment.size_bytes,
	};
}

async function resolveAttachment(
	cacheDir: string,
	fileName: string,
	attachments: DatasetManifest["attachments"],
): Promise<GaiaAttachment> {
	if (
		fileName === "." ||
		fileName === ".." ||
		Buffer.byteLength(fileName, "utf8") > maxAttachmentFilenameBytes ||
		!attachmentFilePattern.test(fileName) ||
		fileName.includes("..") ||
		fileName.includes("/") ||
		fileName.includes("\\")
	) {
		throw new CacheError(`Unsafe GAIA attachment file_name: ${fileName}`);
	}

	const relativePath = join("attachments", fileName);
	const hostPath = resolve(cacheDir, relativePath);
	const pathFromCacheDir = relative(cacheDir, hostPath);
	if (pathFromCacheDir.startsWith("..") || isAbsolute(pathFromCacheDir)) {
		throw new CacheError(
			`GAIA attachment escapes cache directory: ${fileName}`,
		);
	}
	if (attachments == null) {
		throw new CacheError(`Missing GAIA attachment manifest entry: ${fileName}`);
	}
	const manifestEntry = attachments[fileName];
	if (manifestEntry == null) {
		throw new CacheError(`Missing GAIA attachment manifest entry: ${fileName}`);
	}
	let attachment: Buffer;
	try {
		attachment = await readFile(hostPath);
	} catch (error) {
		throw new CacheError(
			`Missing or unreadable GAIA attachment: ${fileName} (${formatCause(error)})`,
		);
	}
	const actualSha256 = computeSha256(attachment);
	if (actualSha256 !== manifestEntry.sha256) {
		throw new CacheError(
			`GAIA attachment sha256 mismatch for ${fileName}: expected ${manifestEntry.sha256}, got ${actualSha256}`,
		);
	}
	if (attachment.byteLength !== manifestEntry.size_bytes) {
		throw new CacheError(
			`GAIA attachment size mismatch for ${fileName}: expected ${manifestEntry.size_bytes}, got ${attachment.byteLength}`,
		);
	}

	const cacheRelativePath = posix.join(
		"datasets",
		GAIA_DATASET,
		"attachments",
		fileName,
	);
	const containerPath = posix.join(dockerCacheRoot, cacheRelativePath);

	return {
		container_path: containerPath,
		file_name: fileName,
		file_path: containerPath,
		host_path: hostPath,
		relative_path: relativePath,
		sha256: manifestEntry.sha256,
		size_bytes: manifestEntry.size_bytes,
	};
}

function formatCause(error: unknown): string {
	return String(error);
}
