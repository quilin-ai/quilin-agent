import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const DATASETS_SERVER_ROWS_URL = "https://datasets-server.huggingface.co/rows";
const SWE_BENCH_LITE_SOURCE_DATASET = "princeton-nlp/SWE-bench_Lite";
const SWE_BENCH_VERIFIED_SOURCE_DATASET = "princeton-nlp/SWE-bench_Verified";
const GAIA_SOURCE_DATASET = "gaia-benchmark/GAIA";
const DEFAULT_CONFIG = "default";
const DEFAULT_SPLIT = "test";
const GAIA_CONFIG = "2023_all";
const GAIA_SPLIT = "validation";
const GAIA_ATTACHMENT_BASE_URL =
	"https://huggingface.co/datasets/gaia-benchmark/GAIA/resolve/main/2023/validation";
const BFCL_V4_PINNED_COMMIT = "f7cf735";
const BFCL_V4_RAW_BASE_URL = `https://raw.githubusercontent.com/ShishirPatil/gorilla/${BFCL_V4_PINNED_COMMIT}/berkeley-function-call-leaderboard/bfcl_eval`;
const BFCL_V4_SOURCE_URL = `${BFCL_V4_RAW_BASE_URL}/data?categories=non_live,live,multi_turn`;
const BFCL_V4_RESULT_FIXTURE_BASE_URL =
	"https://raw.githubusercontent.com/HuanzhiMao/BFCL-Result/main/2025-12-16/result/gpt-5-mini-2025-08-07-FC/multi_turn";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_RETRIES = 3;
const MAX_PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const SOURCE_DATASETS: Record<string, string> = {
	gaia: GAIA_SOURCE_DATASET,
	"bfcl-v4": "ShishirPatil/gorilla",
	"swe-bench-lite": SWE_BENCH_LITE_SOURCE_DATASET,
	"swe-bench-verified": SWE_BENCH_VERIFIED_SOURCE_DATASET,
};
const EXPECTED_ROWS: Record<string, number> = {
	gaia: 165,
	"bfcl-v4": Number.MAX_SAFE_INTEGER,
	"swe-bench-lite": 300,
	"swe-bench-verified": 500,
};
const ALLOWED_ROWS_BASE_URLS = new Set([DATASETS_SERVER_ROWS_URL]);
const MAX_GAIA_ATTACHMENT_FILENAME_BYTES = 255;
const FETCH_LOCK_RETRY_MS = 25;
const FETCH_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;
const FETCH_LOCK_STALE_MS = 30 * 60 * 1000;
const gaiaAttachmentFilePattern = /^[A-Za-z0-9._-]+$/;
const bfclV4NonLiveCategories = [
	"simple_python",
	"simple_java",
	"simple_javascript",
	"multiple",
	"parallel",
	"parallel_multiple",
	"irrelevance",
] as const;
const bfclV4LiveCategories = [
	"live_simple",
	"live_multiple",
	"live_parallel",
	"live_parallel_multiple",
	"live_irrelevance",
	"live_relevance",
] as const;
const bfclV4AstCategories = [
	...bfclV4NonLiveCategories,
	...bfclV4LiveCategories,
] as const;
const bfclV4MultiTurnCategories = [
	"multi_turn_base",
	"multi_turn_miss_func",
	"multi_turn_miss_param",
	"multi_turn_long_context",
] as const;
const bfclV4SupportedCategories = [
	...bfclV4AstCategories,
	...bfclV4MultiTurnCategories,
] as const;
const bfclV4PossibleAnswerCategories: ReadonlySet<string> = new Set([
	...bfclV4NonLiveCategories.filter((category) => category !== "irrelevance"),
	...bfclV4LiveCategories.filter(
		(category) => !["live_irrelevance", "live_relevance"].includes(category),
	),
	...bfclV4MultiTurnCategories,
]);
const bfclV4CheckerSupportFiles = [
	"bfcl_eval/__init__.py",
	"bfcl_eval/constants/__init__.py",
	"bfcl_eval/constants/executable_backend_config.py",
	"bfcl_eval/eval_checker/__init__.py",
	"bfcl_eval/eval_checker/multi_turn_eval/__init__.py",
	"bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py",
	"bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/__init__.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/gorilla_file_system.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/long_context.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/math_api.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/message_api.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/posting_api.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/ticket_api.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/trading_bot.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/travel_booking.py",
	"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/vehicle_control.py",
] as const;

interface FetchBenchmarkOptions {
	readonly dataset: string;
	readonly cacheRoot: string;
	readonly pageSize: number;
	readonly maxRows?: number;
	readonly rowsBaseUrl: string;
	readonly retries: number;
	readonly force: boolean;
	readonly allowUnsafeRowsBaseUrl: boolean;
	readonly hfToken?: string;
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
	readonly attachments?: Readonly<Record<string, AttachmentManifestEntry>>;
}

interface AttachmentManifestEntry {
	readonly sha256: string;
	readonly size_bytes: number;
}

interface FetchLockBody {
	readonly created_at: string;
	readonly nonce: string;
	readonly pid: number;
}

interface FetchLockRead {
	readonly body?: FetchLockBody;
	readonly mtimeMs: number;
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
	const sourceConfig = sourceConfigFor(options.dataset);
	const sourceSplit = sourceSplitFor(options.dataset);
	validateFetchOptions(options);
	const cacheDir = resolveDatasetCacheDir(options.cacheRoot, options.dataset);
	await mkdir(cacheDir, { recursive: true });
	return withDatasetFetchLock(cacheDir, () =>
		fetchBenchmarkWithLock({
			cacheDir,
			options,
			sourceConfig,
			sourceDataset,
			sourceSplit,
		}),
	);
}

async function fetchBenchmarkWithLock(input: {
	readonly cacheDir: string;
	readonly options: FetchBenchmarkOptions;
	readonly sourceConfig: string;
	readonly sourceDataset: string;
	readonly sourceSplit: string;
}): Promise<FetchResult> {
	const { cacheDir, options, sourceConfig, sourceDataset, sourceSplit } = input;
	const outputPath = join(cacheDir, "data.jsonl");
	const manifestPath = join(cacheDir, "manifest.json");
	const sourceUrl =
		options.dataset === "bfcl-v4"
			? BFCL_V4_SOURCE_URL
			: buildSourceUrl({
					baseUrl: options.rowsBaseUrl,
					config: sourceConfig,
					dataset: sourceDataset,
					split: sourceSplit,
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

	const rows =
		options.dataset === "bfcl-v4"
			? await fetchBfclV4Rows(options)
			: await fetchAllRows(options, sourceDataset, sourceConfig, sourceSplit);
	const attachments = await fetchDatasetSupportFilesIfNeeded({
		cacheDir,
		dataset: options.dataset,
		hfToken: options.hfToken,
		retries: options.retries,
		rows,
	});
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
		...(attachments == null ? {} : { attachments }),
	};

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

async function withDatasetFetchLock<T>(
	cacheDir: string,
	operation: () => Promise<T>,
): Promise<T> {
	assertFetchLockPlatformSupported();
	const lockPath = join(cacheDir, ".fetch.lock");
	while (true) {
		const lockOwner = createFetchLockBody();
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(lockPath, "wx");
			await handle.writeFile(`${JSON.stringify(lockOwner)}\n`, "utf8");
		} catch (error) {
			if (handle != null) {
				await handle.close();
				handle = undefined;
				await rm(lockPath, { force: true });
			}
			if (!isFileExistsError(error)) {
				throw error;
			}
			if (await removeStaleFetchLock(lockPath)) {
				continue;
			}
			await delay(FETCH_LOCK_RETRY_MS);
			continue;
		} finally {
			if (handle != null) {
				await handle.close();
			}
		}
		const heartbeat = startFetchLockHeartbeat(lockPath, lockOwner);
		try {
			return await operation();
		} finally {
			clearInterval(heartbeat);
			await releaseFetchLock(lockPath, lockOwner);
		}
	}
}

async function removeStaleFetchLock(lockPath: string): Promise<boolean> {
	try {
		const lock = await readFetchLock(lockPath);
		const lockAgeMs = fetchLockFreshnessAgeMs(lock);
		if (lock.body == null && lockAgeMs <= FETCH_LOCK_STALE_MS) {
			return false;
		}
		if (
			lock.body != null &&
			isProcessAlive(lock.body.pid) &&
			lockAgeMs <= FETCH_LOCK_STALE_MS
		) {
			return false;
		}
		return releaseFetchLock(lockPath, lock.body);
	} catch (error) {
		if (isNotFoundError(error)) {
			return true;
		}
		throw error;
	}
}

function assertFetchLockPlatformSupported(): void {
	if (process.platform === "win32") {
		throw new Error(
			"fetch-benchmark lockfile is not supported on Windows; use Linux/macOS or provide a platform-native lock implementation.",
		);
	}
}

function createFetchLockBody(): FetchLockBody {
	return {
		created_at: new Date().toISOString(),
		nonce: randomUUID(),
		pid: process.pid,
	};
}

function startFetchLockHeartbeat(
	lockPath: string,
	owner: FetchLockBody,
): ReturnType<typeof setInterval> {
	const heartbeat = setInterval(() => {
		void refreshFetchLock(lockPath, owner).catch(() => undefined);
	}, FETCH_LOCK_HEARTBEAT_MS);
	heartbeat.unref?.();
	return heartbeat;
}

async function refreshFetchLock(
	lockPath: string,
	owner: FetchLockBody,
): Promise<void> {
	if (await fetchLockMatches(lockPath, owner)) {
		const now = new Date();
		await utimes(lockPath, now, now);
	}
}

async function releaseFetchLock(
	lockPath: string,
	owner: FetchLockBody | undefined,
): Promise<boolean> {
	if (owner == null) {
		await rm(lockPath, { force: true });
		return true;
	}
	if (!(await fetchLockMatches(lockPath, owner))) {
		return false;
	}
	await rm(lockPath, { force: true });
	return true;
}

async function fetchLockMatches(
	lockPath: string,
	owner: FetchLockBody,
): Promise<boolean> {
	try {
		const lock = await readFetchLock(lockPath);
		return lock.body?.nonce === owner.nonce && lock.body.pid === owner.pid;
	} catch (error) {
		if (isNotFoundError(error)) {
			return false;
		}
		throw error;
	}
}

async function readFetchLock(lockPath: string): Promise<FetchLockRead> {
	const [rawLock, lockStat] = await Promise.all([
		readFile(lockPath, "utf8"),
		stat(lockPath),
	]);
	return {
		body: parseFetchLockBody(rawLock),
		mtimeMs: lockStat.mtimeMs,
	};
}

function parseFetchLockBody(rawLock: string): FetchLockBody | undefined {
	try {
		const parsed = JSON.parse(rawLock) as Partial<FetchLockBody>;
		const pid = parsed.pid;
		const createdAtMs =
			typeof parsed.created_at === "string"
				? Date.parse(parsed.created_at)
				: Number.NaN;
		if (
			typeof parsed.created_at !== "string" ||
			!Number.isFinite(createdAtMs) ||
			typeof parsed.nonce !== "string" ||
			parsed.nonce.length === 0 ||
			!Number.isSafeInteger(pid) ||
			(pid as number) <= 0
		) {
			return undefined;
		}
		return {
			created_at: parsed.created_at,
			nonce: parsed.nonce,
			pid: pid as number,
		};
	} catch {
		return undefined;
	}
}

function fetchLockFreshnessAgeMs(lock: FetchLockRead): number {
	const createdAtMs =
		lock.body == null
			? Number.NEGATIVE_INFINITY
			: Date.parse(lock.body.created_at);
	const freshnessMs = Math.max(
		lock.mtimeMs,
		Number.isFinite(createdAtMs) ? createdAtMs : Number.NEGATIVE_INFINITY,
	);
	return Date.now() - freshnessMs;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") {
			return false;
		}
		return true;
	}
}

async function fetchAllRows(
	options: FetchBenchmarkOptions,
	sourceDataset: string,
	sourceConfig: string,
	sourceSplit: string,
): Promise<Record<string, unknown>[]> {
	if (options.dataset === "gaia" && !options.hfToken) {
		throw new Error(
			"HF_TOKEN is required to fetch the gated GAIA dataset; set HF_TOKEN and retry.",
		);
	}
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
			config: sourceConfig,
			split: sourceSplit,
			offset,
			length: remaining,
		});
		const payload = await fetchJsonWithRetry(
			url,
			options.retries,
			options.hfToken,
		);
		const pageRows = (payload.rows ?? []).map((entry, index) =>
			validateBenchmarkRow(entry.row ?? {}, options.dataset, offset + index),
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
	hfToken?: string,
): Promise<DatasetServerRowsResponse> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			const response = await fetch(
				url,
				hfToken == null || hfToken.length === 0
					? undefined
					: { headers: { Authorization: `Bearer ${hfToken}` } },
			);
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

async function fetchBfclV4Rows(
	options: FetchBenchmarkOptions,
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	const targetRows = options.maxRows ?? Number.POSITIVE_INFINITY;
	for (const category of bfclV4SupportedCategories) {
		if (rows.length >= targetRows) {
			break;
		}
		const generalCategory = bfclV4GeneralCategory(category);
		const prompts = await fetchBfclV4Jsonl(
			bfclV4DataUrl(category),
			options.retries,
		);
		const possibleAnswers = bfclV4PossibleAnswerCategories.has(category)
			? await fetchBfclV4Jsonl(
					bfclV4PossibleAnswerUrl(category),
					options.retries,
				)
			: [];
		const fixtureRows = isBfclV4MultiTurnCategory(category)
			? await fetchBfclV4Jsonl(
					bfclV4FixtureResultUrl(category),
					options.retries,
				)
			: [];
		const answersById = new Map(
			possibleAnswers
				.map((entry) => [stringField(entry, "id"), entry.ground_truth] as const)
				.filter(([id]) => id != null),
		);
		const fixturesById = new Map(
			fixtureRows
				.map((entry) => [stringField(entry, "id"), entry] as const)
				.filter(([id]) => id != null),
		);
		for (const prompt of prompts) {
			if (rows.length >= targetRows) {
				break;
			}
			const promptId = stringField(prompt, "id") ?? "";
			rows.push(
				validateBfclV4Row(
					{
						category,
						excluded_function: prompt.excluded_function,
						fixture_result: fixturesById.get(promptId),
						function: prompt.function,
						general_category: generalCategory,
						initial_config: prompt.initial_config,
						involved_classes: prompt.involved_classes,
						missed_function: prompt.missed_function,
						path: prompt.path,
						possible_answer: answersById.get(promptId),
						ground_truth: answersById.get(promptId),
						id: prompt.id,
						question: prompt.question,
					},
					rows.length,
				),
			);
		}
	}
	return rows;
}

async function fetchBfclV4Jsonl(
	url: string,
	retries: number,
): Promise<Record<string, unknown>[]> {
	validateBfclV4RawUrl(url);
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Failed to fetch BFCL v4 data: ${response.status} ${response.statusText}`,
				);
			}
			return parseBfclV4Jsonl(await response.text(), url);
		} catch (error) {
			lastError = error;
			if (attempt < retries) {
				await delay(100 * attempt);
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Failed to fetch BFCL v4 data");
}

function parseBfclV4Jsonl(raw: string, url: string): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	let index = 0;
	for (const line of raw.split(/\r?\n/)) {
		if (line.length === 0) {
			continue;
		}
		try {
			const parsed = JSON.parse(line);
			if (
				parsed == null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed)
			) {
				throw new Error("row is not an object");
			}
			rows.push(parsed as Record<string, unknown>);
		} catch (error) {
			throw new Error(
				`Invalid BFCL v4 JSONL from ${url} at row ${index}: ${errorMessage(error)}`,
			);
		}
		index += 1;
	}
	return rows;
}

async function fetchDatasetSupportFilesIfNeeded(options: {
	readonly cacheDir: string;
	readonly dataset: string;
	readonly hfToken?: string;
	readonly retries: number;
	readonly rows: readonly Record<string, unknown>[];
}): Promise<Record<string, AttachmentManifestEntry> | undefined> {
	if (options.dataset === "bfcl-v4") {
		return fetchBfclV4CheckerFilesIfNeeded(options.cacheDir, options.retries);
	}
	return fetchGaiaAttachmentsIfNeeded(options);
}

async function fetchGaiaAttachmentsIfNeeded(options: {
	readonly cacheDir: string;
	readonly dataset: string;
	readonly hfToken?: string;
	readonly retries: number;
	readonly rows: readonly Record<string, unknown>[];
}): Promise<Record<string, AttachmentManifestEntry> | undefined> {
	if (options.dataset !== "gaia") {
		return undefined;
	}
	const fileNames = Array.from(
		new Set(
			options.rows
				.map((row) => row.file_name)
				.filter((value): value is string => typeof value === "string"),
		),
	);
	if (fileNames.length === 0) {
		return {};
	}
	if (!options.hfToken) {
		throw new Error(
			"HF_TOKEN is required to fetch GAIA attachments; set HF_TOKEN and retry.",
		);
	}

	const attachmentDir = join(options.cacheDir, "attachments");
	const stagingDir = `${attachmentDir}.tmp-${process.pid}-${Date.now()}`;
	const attachmentManifest: Record<string, AttachmentManifestEntry> = {};
	try {
		await mkdir(stagingDir, { recursive: true });
		for (const fileName of fileNames) {
			const attachmentPath = resolveGaiaAttachmentPath(stagingDir, fileName);
			const attachment = await fetchBinaryWithRetry(
				buildGaiaAttachmentUrl(fileName),
				options.retries,
				options.hfToken,
			);
			await writeFile(attachmentPath, attachment);
			attachmentManifest[fileName] = {
				sha256: computeSha256(attachment),
				size_bytes: attachment.byteLength,
			};
		}
		await rm(attachmentDir, { recursive: true, force: true });
		await rename(stagingDir, attachmentDir);
		return attachmentManifest;
	} catch (error) {
		await rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

async function gaiaAttachmentsComplete(
	cacheDir: string,
	data: string,
	attachments: Readonly<Record<string, AttachmentManifestEntry>> | undefined,
): Promise<boolean> {
	for (const line of data.split(/\r?\n/)) {
		if (line.length === 0) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return false;
		}
		if (parsed == null || typeof parsed !== "object") {
			return false;
		}
		const fileName = (parsed as Record<string, unknown>).file_name;
		if (typeof fileName !== "string" || fileName.length === 0) {
			continue;
		}
		try {
			if (attachments == null) {
				return false;
			}
			const manifestEntry = attachments[fileName];
			if (manifestEntry == null) {
				return false;
			}
			const attachment = await readFile(
				resolveGaiaAttachmentPath(join(cacheDir, "attachments"), fileName),
			);
			if (
				computeSha256(attachment) !== manifestEntry.sha256 ||
				attachment.byteLength !== manifestEntry.size_bytes
			) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
}

async function bfclV4SupportFilesComplete(
	cacheDir: string,
	attachments: Readonly<Record<string, AttachmentManifestEntry>> | undefined,
): Promise<boolean> {
	if (attachments == null) {
		return false;
	}
	for (const relativePath of bfclV4CheckerSupportFiles) {
		const manifestEntry = attachments[relativePath];
		if (manifestEntry == null) {
			return false;
		}
		try {
			const file = await readFile(join(cacheDir, relativePath));
			if (
				computeSha256(file) !== manifestEntry.sha256 ||
				file.byteLength !== manifestEntry.size_bytes
			) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
}

async function fetchBfclV4CheckerFilesIfNeeded(
	cacheDir: string,
	retries: number,
): Promise<Record<string, AttachmentManifestEntry>> {
	const manifest: Record<string, AttachmentManifestEntry> = {};
	for (const relativePath of bfclV4CheckerSupportFiles) {
		const content = await fetchTextWithRetry(
			bfclV4SupportFileUrl(relativePath),
			retries,
		);
		const outputPath = join(cacheDir, relativePath);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, content, "utf8");
		manifest[relativePath] = {
			sha256: computeSha256(content),
			size_bytes: Buffer.byteLength(content, "utf8"),
		};
	}
	return manifest;
}

async function fetchBinaryWithRetry(
	url: string,
	retries: number,
	hfToken: string,
): Promise<Buffer> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${hfToken}` },
			});
			if (!response.ok) {
				throw new Error(
					`Failed to fetch GAIA attachment: ${response.status} ${response.statusText}`,
				);
			}
			return Buffer.from(await response.arrayBuffer());
		} catch (error) {
			lastError = error;
			if (attempt < retries) {
				await delay(100 * attempt);
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Failed to fetch GAIA attachment");
}

async function fetchTextWithRetry(
	url: string,
	retries: number,
): Promise<string> {
	validateBfclV4RawUrl(url);
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Failed to fetch BFCL v4 support file: ${response.status} ${response.statusText}`,
				);
			}
			return await response.text();
		} catch (error) {
			lastError = error;
			if (attempt < retries) {
				await delay(100 * attempt);
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Failed to fetch BFCL v4 support file");
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
		if (
			options.dataset === "gaia" &&
			!(await gaiaAttachmentsComplete(
				dirname(options.outputPath),
				data,
				manifest.attachments,
			))
		) {
			return null;
		}
		if (
			options.dataset === "bfcl-v4" &&
			!(await bfclV4SupportFilesComplete(
				dirname(options.outputPath),
				manifest.attachments,
			))
		) {
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
		if (dataset === "bfcl-v4") {
			return cachedMaxRows === null && cachedRows > 0;
		}
		return cachedMaxRows === null && cachedRows === expectedRowsFor(dataset);
	}
	if (cachedMaxRows == null) {
		return cachedRows >= currentMaxRows;
	}
	return cachedMaxRows >= currentMaxRows && cachedRows >= currentMaxRows;
}

function validateBenchmarkRow(
	record: Record<string, unknown>,
	dataset: string,
	index: number,
): Record<string, unknown> {
	if (dataset === "bfcl-v4") {
		return validateBfclV4Row(record, index);
	}
	if (dataset === "gaia") {
		return validateGaiaRow(record, index);
	}
	return validateSweBenchRow(record, dataset, index);
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

function validateBfclV4Row(
	record: Record<string, unknown>,
	index: number,
): Record<string, unknown> {
	const id = record.id;
	const category = record.category;
	const generalCategory = record.general_category;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`Invalid bfcl-v4 row at index ${index}: missing id`);
	}
	if (typeof category !== "string" || !isBfclV4Category(category)) {
		throw new Error(`Invalid bfcl-v4 row at index ${index}: missing category`);
	}
	if (
		generalCategory !== "non_live" &&
		generalCategory !== "live" &&
		generalCategory !== "multi_turn"
	) {
		throw new Error(
			`Invalid bfcl-v4 row at index ${index}: missing general_category`,
		);
	}
	if (generalCategory !== bfclV4GeneralCategory(category)) {
		throw new Error(
			`Invalid bfcl-v4 row at index ${index}: category/general_category mismatch`,
		);
	}
	if (generalCategory === "multi_turn") {
		if (!Array.isArray(record.possible_answer)) {
			throw new Error(
				`Invalid bfcl-v4 row at index ${index}: missing possible_answer`,
			);
		}
		if (!isRecord(record.initial_config)) {
			throw new Error(
				`Invalid bfcl-v4 row at index ${index}: missing initial_config`,
			);
		}
		if (!Array.isArray(record.involved_classes)) {
			throw new Error(
				`Invalid bfcl-v4 row at index ${index}: missing involved_classes`,
			);
		}
	} else if (!Array.isArray(record.function)) {
		throw new Error(
			`Invalid bfcl-v4 row at index ${index}: missing function definitions`,
		);
	}
	if (record.question == null) {
		throw new Error(`Invalid bfcl-v4 row at index ${index}: missing question`);
	}
	return record;
}

function validateGaiaRow(
	record: Record<string, unknown>,
	index: number,
): Record<string, unknown> {
	const normalized = {
		...record,
		"Final answer": readGaiaRequiredField(
			record,
			["Final answer", "final_answer", "answer"],
			index,
		),
		Level: readGaiaLevel(record, index),
		Question: readGaiaRequiredField(record, ["Question", "question"], index),
		file_name: readGaiaOptionalField(record, ["file_name", "file"]),
		task_id: readGaiaRequiredField(record, ["task_id", "id"], index),
	};
	return normalized;
}

function resolveGaiaAttachmentPath(
	attachmentDir: string,
	fileName: string,
): string {
	validateGaiaAttachmentFileName(fileName);
	const attachmentPath = resolve(attachmentDir, fileName);
	const pathFromAttachmentDir = relative(attachmentDir, attachmentPath);
	if (
		pathFromAttachmentDir.startsWith("..") ||
		isAbsolute(pathFromAttachmentDir)
	) {
		throw new Error(`GAIA attachment escapes cache directory: ${fileName}`);
	}
	return attachmentPath;
}

function validateGaiaAttachmentFileName(fileName: string): void {
	if (
		fileName === "." ||
		fileName === ".." ||
		Buffer.byteLength(fileName, "utf8") > MAX_GAIA_ATTACHMENT_FILENAME_BYTES ||
		!gaiaAttachmentFilePattern.test(fileName) ||
		fileName.includes("..") ||
		fileName.includes("/") ||
		fileName.includes("\\")
	) {
		throw new Error(`Unsafe GAIA attachment file_name: ${fileName}`);
	}
}

function buildGaiaAttachmentUrl(fileName: string): string {
	validateGaiaAttachmentFileName(fileName);
	return `${GAIA_ATTACHMENT_BASE_URL}/${encodeURIComponent(fileName)}`;
}

function readGaiaRequiredField(
	record: Record<string, unknown>,
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
	throw new Error(
		`Invalid gaia row at index ${index}: missing ${keys.join("/")}`,
	);
}

function readGaiaOptionalField(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return null;
}

function readGaiaLevel(record: Record<string, unknown>, index: number): number {
	const value = record.Level ?? record.level;
	const level =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	if (![1, 2, 3].includes(level)) {
		throw new Error(`Invalid gaia row at index ${index}: missing Level`);
	}
	return level;
}

function bfclV4GeneralCategory(
	category: string,
): "non_live" | "live" | "multi_turn" {
	if (isBfclV4MultiTurnCategory(category)) {
		return "multi_turn";
	}
	return category.startsWith("live_") ? "live" : "non_live";
}

function isBfclV4Category(category: string): boolean {
	return (bfclV4SupportedCategories as readonly string[]).includes(category);
}

function isBfclV4MultiTurnCategory(category: string): boolean {
	return (bfclV4MultiTurnCategories as readonly string[]).includes(category);
}

function bfclV4DataUrl(category: string): string {
	return `${BFCL_V4_RAW_BASE_URL}/data/BFCL_v4_${category}.json`;
}

function bfclV4PossibleAnswerUrl(category: string): string {
	return `${BFCL_V4_RAW_BASE_URL}/data/possible_answer/BFCL_v4_${category}.json`;
}

function bfclV4FixtureResultUrl(category: string): string {
	return `${BFCL_V4_RESULT_FIXTURE_BASE_URL}/BFCL_v4_${category}_result.json`;
}

function bfclV4SupportFileUrl(relativePath: string): string {
	return `${BFCL_V4_RAW_BASE_URL.replace(/\/bfcl_eval$/, "")}/${relativePath}`;
}

function validateBfclV4RawUrl(url: string): void {
	const parsed = new URL(url);
	const allowedDataPrefix = `/ShishirPatil/gorilla/${BFCL_V4_PINNED_COMMIT}/berkeley-function-call-leaderboard/bfcl_eval/data/`;
	const allowedFixturePrefix =
		"/HuanzhiMao/BFCL-Result/main/2025-12-16/result/gpt-5-mini-2025-08-07-FC/multi_turn/";
	const allowedSupportPaths = new Set(
		bfclV4CheckerSupportFiles.map(
			(relativePath) =>
				`/ShishirPatil/gorilla/${BFCL_V4_PINNED_COMMIT}/berkeley-function-call-leaderboard/${relativePath}`,
		),
	);
	if (
		parsed.origin !== "https://raw.githubusercontent.com" ||
		parsed.pathname.includes("..") ||
		(!parsed.pathname.startsWith(allowedDataPrefix) &&
			!parsed.pathname.startsWith(allowedFixturePrefix) &&
			!allowedSupportPaths.has(parsed.pathname))
	) {
		throw new Error(`Unsafe BFCL v4 raw URL rejected: ${url}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
	record: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sourceDatasetFor(dataset: string): string {
	const sourceDataset = SOURCE_DATASETS[dataset];
	if (sourceDataset == null) {
		throw new Error(`Unsupported dataset: ${dataset}`);
	}
	return sourceDataset;
}

function sourceConfigFor(dataset: string): string {
	return dataset === "gaia" ? GAIA_CONFIG : DEFAULT_CONFIG;
}

function sourceSplitFor(dataset: string): string {
	return dataset === "gaia" ? GAIA_SPLIT : DEFAULT_SPLIT;
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

function computeSha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFileExistsError(error: unknown): boolean {
	return errorCode(error) === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null
		? (error as { readonly code?: unknown }).code
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	const hfToken = process.env.HF_TOKEN;
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
		hfToken,
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
	if (value === "GAIA") {
		return "gaia";
	}
	if (value === "BFCL" || value === "bfcl") {
		return "bfcl-v4";
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

/* v8 ignore next 7 -- direct CLI process exit path; main() is covered directly. */
if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Unknown benchmark fetch failure"}\n`,
		);
		process.exit(1);
	});
}

const __privateForTests = {
	assertFetchLockPlatformSupported,
	fetchLockFreshnessAgeMs,
	fetchLockMatches,
	expectedRowsFor,
	parseFetchLockBody,
	parseBfclV4Jsonl,
	refreshFetchLock,
	releaseFetchLock,
	removeStaleFetchLock,
	sourceConfigFor,
	sourceSplitFor,
	validateBfclV4RawUrl,
	validateBfclV4Row,
} as const;

export {
	__privateForTests,
	type FetchBenchmarkOptions,
	type FetchResult,
	fetchBenchmark,
	main,
	parseArgs,
};
