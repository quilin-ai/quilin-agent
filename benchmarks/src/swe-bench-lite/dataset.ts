import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SWE_BENCH_LITE_DATASET_ID = "swe-bench-lite";
export const SWE_BENCH_LITE_SOURCE_DATASET = "princeton-nlp/SWE-bench_Lite";
export const SWE_BENCH_LITE_DEFAULT_CONFIG = "default";
export const SWE_BENCH_LITE_DEFAULT_SPLIT = "test";
export const SWE_BENCH_LITE_DEFAULT_PAGE_SIZE = 100;
export const DATASETS_SERVER_ROWS_URL =
	"https://datasets-server.huggingface.co/rows";

export interface SweBenchLiteRecord {
	readonly instance_id: string;
	readonly problem_statement: string;
	readonly repo: string;
	readonly base_commit: string;
	readonly patch: string;
	readonly test_patch: string;
}

export interface SweBenchLiteManifest {
	readonly schemaVersion: 1;
	readonly dataset: string;
	readonly sourceDataset: string;
	readonly config: string;
	readonly split: string;
	readonly pageSize: number;
	readonly rows: number;
	readonly sha256: string;
	readonly downloadedAt: string;
	readonly sourceUrl: string;
}

interface DatasetServerRow {
	readonly row?: Record<string, unknown>;
}

interface DatasetServerRowsResponse {
	readonly rows?: readonly DatasetServerRow[];
}

export interface DownloadSweBenchLiteOptions {
	readonly cacheRoot?: string;
	readonly pageSize?: number;
	readonly fetcher?: typeof fetch;
	readonly rowsBaseUrl?: string;
	readonly config?: string;
	readonly split?: string;
	readonly maxRows?: number;
}

export interface DownloadSweBenchLiteResult {
	readonly outputPath: string;
	readonly manifestPath: string;
	readonly rows: number;
	readonly sha256: string;
	readonly bytes: number;
}

export function resolveBenchmarksRoot(startDir = process.cwd()): string {
	return join(startDir, ".benchmarks");
}

export function resolveSweBenchLiteCacheDir(
	cacheRoot = resolveBenchmarksRoot(),
): string {
	return join(cacheRoot, "datasets", SWE_BENCH_LITE_DATASET_ID);
}

export function resolveSweBenchLiteJsonlPath(
	cacheRoot = resolveBenchmarksRoot(),
): string {
	return join(resolveSweBenchLiteCacheDir(cacheRoot), "test.jsonl");
}

export function resolveSweBenchLiteManifestPath(
	cacheRoot = resolveBenchmarksRoot(),
): string {
	return join(resolveSweBenchLiteCacheDir(cacheRoot), "manifest.json");
}

export function parseJsonlRecords(text: string): Record<string, unknown>[] {
	return text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function validateSweBenchLiteRecord(
	record: Record<string, unknown>,
	index = 0,
): SweBenchLiteRecord {
	const requiredFields = [
		"instance_id",
		"problem_statement",
		"repo",
		"base_commit",
		"patch",
		"test_patch",
	] as const;

	for (const field of requiredFields) {
		if (typeof record[field] !== "string" || record[field].length === 0) {
			throw new Error(
				`Invalid SWE-bench Lite record at index ${index}: missing ${field}`,
			);
		}
	}

	return {
		instance_id: record.instance_id as string,
		problem_statement: record.problem_statement as string,
		repo: record.repo as string,
		base_commit: record.base_commit as string,
		patch: record.patch as string,
		test_patch: record.test_patch as string,
	};
}

export function parseSweBenchLiteJsonl(text: string): SweBenchLiteRecord[] {
	return parseJsonlRecords(text).map((record, index) =>
		validateSweBenchLiteRecord(record, index),
	);
}

export async function loadSweBenchLiteFromCache(
	cacheRoot = resolveBenchmarksRoot(),
): Promise<SweBenchLiteRecord[]> {
	const jsonlPath = resolveSweBenchLiteJsonlPath(cacheRoot);
	const manifestPath = resolveSweBenchLiteManifestPath(cacheRoot);
	const text = await readFile(jsonlPath, "utf8");
	const manifestRaw = await readFile(manifestPath, "utf8");
	const manifest = JSON.parse(manifestRaw) as Partial<SweBenchLiteManifest>;
	if (manifest.schemaVersion !== 1) {
		throw new Error(
			`Unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`,
		);
	}
	const expected = manifest.sha256;
	if (typeof expected !== "string" || expected.length === 0) {
		throw new Error("Manifest is missing sha256 — refusing to load cache");
	}
	const actual = computeSha256(text);
	if (actual !== expected) {
		throw new Error(
			`SWE-bench Lite cache integrity check failed: expected ${expected}, got ${actual}`,
		);
	}
	return parseSweBenchLiteJsonl(text);
}

export async function downloadSweBenchLiteDataset(
	options: DownloadSweBenchLiteOptions = {},
): Promise<DownloadSweBenchLiteResult> {
	const fetcher = options.fetcher ?? fetch;
	const cacheRoot = options.cacheRoot ?? resolveBenchmarksRoot();
	const pageSize = options.pageSize ?? SWE_BENCH_LITE_DEFAULT_PAGE_SIZE;
	const config = options.config ?? SWE_BENCH_LITE_DEFAULT_CONFIG;
	const split = options.split ?? SWE_BENCH_LITE_DEFAULT_SPLIT;
	const rowsBaseUrl = options.rowsBaseUrl ?? DATASETS_SERVER_ROWS_URL;
	const outputPath = resolveSweBenchLiteJsonlPath(cacheRoot);
	const manifestPath = resolveSweBenchLiteManifestPath(cacheRoot);
	const rows: SweBenchLiteRecord[] = [];

	let offset = 0;
	while (true) {
		const remaining =
			options.maxRows == null
				? pageSize
				: Math.min(pageSize, options.maxRows - rows.length);
		if (remaining <= 0) {
			break;
		}

		const sourceUrl = buildRowsUrl({
			baseUrl: rowsBaseUrl,
			dataset: SWE_BENCH_LITE_SOURCE_DATASET,
			config,
			split,
			offset,
			length: remaining,
		});
		const response = await fetcher(sourceUrl);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch SWE-bench Lite rows: ${response.status} ${response.statusText}`,
			);
		}

		const payload = (await response.json()) as DatasetServerRowsResponse;
		const pageRows = (payload.rows ?? [])
			.map((entry) => entry.row ?? {})
			.map((row, index) => validateSweBenchLiteRecord(row, offset + index));
		if (pageRows.length === 0) {
			break;
		}

		rows.push(...pageRows);
		offset += pageRows.length;
		if (pageRows.length < remaining) {
			break;
		}
	}

	const jsonl = rows
		.map((row) => JSON.stringify(row))
		.join("\n")
		.concat("\n");
	const sha256 = computeSha256(jsonl);
	const sourceUrl = buildRowsUrl({
		baseUrl: rowsBaseUrl,
		dataset: SWE_BENCH_LITE_SOURCE_DATASET,
		config,
		split,
		offset: 0,
		length: pageSize,
	});
	const manifest: SweBenchLiteManifest = {
		schemaVersion: 1,
		dataset: SWE_BENCH_LITE_DATASET_ID,
		sourceDataset: SWE_BENCH_LITE_SOURCE_DATASET,
		config,
		split,
		pageSize,
		rows: rows.length,
		sha256,
		downloadedAt: new Date().toISOString(),
		sourceUrl,
	};

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, jsonl, "utf8");
	await writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);

	return {
		outputPath,
		manifestPath,
		rows: rows.length,
		sha256,
		bytes: Buffer.byteLength(jsonl, "utf8"),
	};
}

function buildRowsUrl(options: {
	readonly baseUrl: string;
	readonly dataset: string;
	readonly config: string;
	readonly split: string;
	readonly offset: number;
	readonly length: number;
}): string {
	const url = new URL(options.baseUrl);
	url.searchParams.set("dataset", options.dataset);
	url.searchParams.set("config", options.config);
	url.searchParams.set("split", options.split);
	url.searchParams.set("offset", String(options.offset));
	url.searchParams.set("length", String(options.length));
	return url.toString();
}

function computeSha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
