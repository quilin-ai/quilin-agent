import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DATASETS_SERVER_ROWS_URL = "https://datasets-server.huggingface.co/rows";
const SWE_BENCH_LITE_SOURCE_DATASET = "princeton-nlp/SWE-bench_Lite";
const SWE_BENCH_VERIFIED_SOURCE_DATASET = "princeton-nlp/SWE-bench_Verified";
const DEFAULT_CONFIG = "default";
const DEFAULT_SPLIT = "test";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_RETRIES = 3;
const MAX_PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const SOURCE_DATASETS: Record<string, string> = {
	"swe-bench-lite": SWE_BENCH_LITE_SOURCE_DATASET,
	"swe-bench-verified": SWE_BENCH_VERIFIED_SOURCE_DATASET,
};
const EXPECTED_ROWS: Record<string, number> = {
	"swe-bench-lite": 300,
	"swe-bench-verified": 500,
};
const ALLOWED_ROWS_BASE_URLS = new Set([DATASETS_SERVER_ROWS_URL]);

interface FetchBenchmarkOptions {
	readonly dataset: string;
	readonly cacheRoot: string;
	readonly pageSize: number;
	readonly maxRows?: number;
	readonly rowsBaseUrl: string;
	readonly retries: number;
	readonly force: boolean;
	readonly allowUnsafeRowsBaseUrl: boolean;
}

interface DatasetServerRowsResponse {
	readonly rows?: readonly { readonly row?: Record<string, unknown> }[];
}

interface DatasetManifest {
	readonly schema_version: 1;
	readonly dataset: string;
	readonly fetched_at: string;
	readonly rows: number;
	readonly requested_max_rows: number | null;
	readonly sha256: string;
	readonly source_url: string;
	readonly data_file: string;
}

interface FetchResult {
	readonly dataset: string;
	readonly rows: number;
	readonly bytes: number;
	readonly sha256: string;
	readonly outputPath: string;
	readonly manifestPath: string;
	readonly skipped: boolean;
}

async function fetchBenchmark(
	options: FetchBenchmarkOptions,
): Promise<FetchResult> {
	const sourceDataset = sourceDatasetFor(options.dataset);
	validateFetchOptions(options);
	const cacheDir = resolveDatasetCacheDir(options.cacheRoot, options.dataset);
	const outputPath = join(cacheDir, "data.jsonl");
	const manifestPath = join(cacheDir, "manifest.json");
	const sourceUrl = buildSourceUrl({
		baseUrl: options.rowsBaseUrl,
		dataset: sourceDataset,
		config: DEFAULT_CONFIG,
		split: DEFAULT_SPLIT,
	});
	if (!options.force) {
		const cached = await tryReadValidManifest({
			currentMaxRows: options.maxRows ?? null,
			manifestPath,
			outputPath,
			sourceUrl,
			dataset: options.dataset,
		});
		if (cached != null) {
			return {
				dataset: cached.dataset,
				rows: cached.rows,
				bytes: Buffer.byteLength(await readFile(outputPath)),
				sha256: cached.sha256,
				outputPath,
				manifestPath,
				skipped: true,
			};
		}
	}

	const rows = await fetchAllRows(options, sourceDataset);
	const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	const sha256 = computeSha256(jsonl);
	const manifest: DatasetManifest = {
		schema_version: 1,
		dataset: options.dataset,
		fetched_at: new Date().toISOString(),
		rows: rows.length,
		requested_max_rows: options.maxRows ?? null,
		sha256,
		source_url: sourceUrl,
		data_file: "data.jsonl",
	};

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, jsonl, "utf8");
	await writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);

	return {
		dataset: options.dataset,
		rows: rows.length,
		bytes: Buffer.byteLength(jsonl, "utf8"),
		sha256,
		outputPath,
		manifestPath,
		skipped: false,
	};
}

async function fetchAllRows(
	options: FetchBenchmarkOptions,
	sourceDataset: string,
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	let offset = 0;
	const targetRows = options.maxRows ?? expectedRowsFor(options.dataset);
	while (true) {
		const remaining = Math.min(options.pageSize, targetRows - rows.length);
		if (remaining <= 0) {
			break;
		}

		const url = buildRowsUrl({
			baseUrl: options.rowsBaseUrl,
			dataset: sourceDataset,
			config: DEFAULT_CONFIG,
			split: DEFAULT_SPLIT,
			offset,
			length: remaining,
		});
		const payload = await fetchJsonWithRetry(url, options.retries);
		const pageRows = (payload.rows ?? []).map((entry, index) =>
			validateSweBenchRow(entry.row ?? {}, options.dataset, offset + index),
		);
		if (pageRows.length === 0) {
			break;
		}

		rows.push(...pageRows);
		offset += pageRows.length;
		if (pageRows.length < remaining) {
			break;
		}
	}
	return rows;
}

async function fetchJsonWithRetry(
	url: string,
	retries: number,
): Promise<DatasetServerRowsResponse> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Failed to fetch benchmark rows: ${response.status} ${response.statusText}`,
				);
			}
			return (await response.json()) as DatasetServerRowsResponse;
		} catch (error) {
			lastError = error;
			if (attempt < retries) {
				await delay(100 * attempt);
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Failed to fetch benchmark rows");
}

async function tryReadValidManifest(options: {
	readonly currentMaxRows: number | null;
	readonly manifestPath: string;
	readonly outputPath: string;
	readonly sourceUrl: string;
	readonly dataset: string;
}): Promise<DatasetManifest | null> {
	try {
		const manifest = JSON.parse(
			await readFile(options.manifestPath, "utf8"),
		) as Partial<DatasetManifest>;
		if (
			manifest.schema_version !== 1 ||
			manifest.dataset !== options.dataset ||
			manifest.source_url !== options.sourceUrl ||
			!cacheSatisfiesRequest(
				manifest.requested_max_rows,
				manifest.rows,
				options.currentMaxRows,
				options.dataset,
			) ||
			typeof manifest.sha256 !== "string"
		) {
			return null;
		}
		const data = await readFile(options.outputPath, "utf8");
		if (computeSha256(data) !== manifest.sha256) {
			return null;
		}
		if (typeof manifest.rows !== "number" || manifest.rows < 0) {
			return null;
		}
		return manifest as DatasetManifest;
	} catch {
		return null;
	}
}

function cacheSatisfiesRequest(
	cachedMaxRows: number | null | undefined,
	cachedRows: number | undefined,
	currentMaxRows: number | null,
	dataset: string,
): boolean {
	if (typeof cachedRows !== "number" || cachedRows < 0) {
		return false;
	}
	if (currentMaxRows == null) {
		return cachedMaxRows === null && cachedRows === expectedRowsFor(dataset);
	}
	if (cachedMaxRows == null) {
		return cachedRows >= currentMaxRows;
	}
	return cachedMaxRows >= currentMaxRows && cachedRows >= currentMaxRows;
}

function validateSweBenchRow(
	record: Record<string, unknown>,
	dataset: string,
	index: number,
): Record<string, unknown> {
	for (const field of [
		"instance_id",
		"problem_statement",
		"repo",
		"base_commit",
		"patch",
		"test_patch",
	]) {
		if (typeof record[field] !== "string" || record[field].length === 0) {
			throw new Error(
				`Invalid ${dataset} row at index ${index}: missing ${field}`,
			);
		}
	}
	return record;
}

function sourceDatasetFor(dataset: string): string {
	const sourceDataset = SOURCE_DATASETS[dataset];
	if (sourceDataset == null) {
		throw new Error(`Unsupported dataset: ${dataset}`);
	}
	return sourceDataset;
}

function expectedRowsFor(dataset: string): number {
	const expectedRows = EXPECTED_ROWS[dataset];
	if (expectedRows == null) {
		throw new Error(`Unsupported dataset: ${dataset}`);
	}
	return expectedRows;
}

function validateFetchOptions(options: FetchBenchmarkOptions): void {
	if (options.pageSize > MAX_PAGE_SIZE) {
		throw new Error(`--page-size must be <= ${MAX_PAGE_SIZE}`);
	}
	if (options.retries > MAX_RETRIES) {
		throw new Error(`--retries must be <= ${MAX_RETRIES}`);
	}
	const expectedRows = expectedRowsFor(options.dataset);
	if (options.maxRows != null && options.maxRows > expectedRows) {
		throw new Error(
			`--max-rows must be <= ${expectedRows} for ${options.dataset}`,
		);
	}
	validateRowsBaseUrl(options.rowsBaseUrl, options.allowUnsafeRowsBaseUrl);
}

function validateRowsBaseUrl(
	rowsBaseUrl: string,
	allowUnsafeRowsBaseUrl: boolean,
): void {
	if (allowUnsafeRowsBaseUrl) {
		return;
	}
	if (!ALLOWED_ROWS_BASE_URLS.has(rowsBaseUrl)) {
		throw new Error(
			`Unsafe --rows-base-url rejected: ${rowsBaseUrl}. Set QUILIN_ALLOW_UNSAFE_BENCHMARK_ROWS_BASE_URL=1 or pass --allow-unsafe-rows-base-url for local tests.`,
		);
	}
	const url = new URL(rowsBaseUrl);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "datasets-server.huggingface.co"
	) {
		throw new Error(`Unsafe --rows-base-url rejected: ${rowsBaseUrl}`);
	}
}

function resolveDatasetCacheDir(cacheRoot: string, dataset: string): string {
	return join(cacheRoot, "datasets", dataset);
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

function buildSourceUrl(options: {
	readonly baseUrl: string;
	readonly dataset: string;
	readonly config: string;
	readonly split: string;
}): string {
	const url = new URL(options.baseUrl);
	url.searchParams.set("dataset", options.dataset);
	url.searchParams.set("config", options.config);
	url.searchParams.set("split", options.split);
	return url.toString();
}

function computeSha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(flag: string, value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
		throw new Error(`${flag} must be a positive integer, got: ${value}`);
	}
	return parsed;
}

function parseArgs(argv: readonly string[]): FetchBenchmarkOptions {
	let dataset = "swe-bench-lite";
	let datasetProvided = false;
	let cacheRoot = ".benchmarks";
	let pageSize = DEFAULT_PAGE_SIZE;
	let maxRows: number | undefined;
	let rowsBaseUrl = DATASETS_SERVER_ROWS_URL;
	let retries = DEFAULT_RETRIES;
	let force = false;
	let allowUnsafeRowsBaseUrl =
		process.env.QUILIN_ALLOW_UNSAFE_BENCHMARK_ROWS_BASE_URL === "1";

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = argv[index + 1];
		if (!arg.startsWith("--")) {
			if (datasetProvided) {
				throw new Error(`Unexpected positional argument: ${arg}`);
			}
			dataset = normalizeDataset(arg);
			datasetProvided = true;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--allow-unsafe-rows-base-url") {
			allowUnsafeRowsBaseUrl = true;
			continue;
		}
		if (value == null) {
			throw new Error(`Missing value for ${arg}`);
		}
		if (arg === "--dataset") {
			dataset = normalizeDataset(value);
			datasetProvided = true;
			index += 1;
			continue;
		}
		if (arg === "--cache-root") {
			cacheRoot = value;
			index += 1;
			continue;
		}
		if (arg === "--page-size") {
			pageSize = parsePositiveInt("--page-size", value);
			index += 1;
			continue;
		}
		if (arg === "--max-rows") {
			maxRows = parsePositiveInt("--max-rows", value);
			index += 1;
			continue;
		}
		if (arg === "--rows-base-url") {
			rowsBaseUrl = value;
			index += 1;
			continue;
		}
		if (arg === "--retries") {
			retries = parsePositiveInt("--retries", value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return {
		allowUnsafeRowsBaseUrl,
		cacheRoot,
		dataset,
		force,
		maxRows,
		pageSize,
		retries,
		rowsBaseUrl,
	};
}

function normalizeDataset(value: string): string {
	if (value === "lite") {
		return "swe-bench-lite";
	}
	if (value === "verified") {
		return "swe-bench-verified";
	}
	return value;
}

async function main(
	argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
	const options = parseArgs(argv);
	const result = await fetchBenchmark(options);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Unknown benchmark fetch failure"}\n`,
		);
		process.exit(1);
	});
}

export {
	type FetchBenchmarkOptions,
	type FetchResult,
	fetchBenchmark,
	main,
	parseArgs,
};
