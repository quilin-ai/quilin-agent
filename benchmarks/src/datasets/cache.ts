import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const canonicalDataFilePattern = /^(?:data\.jsonl|data\.json)$/;

export class CacheError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CacheError";
	}
}

export const datasetManifestSchema = z
	.object({
		schema_version: z.literal(1),
		dataset: z.string().min(1),
		fetched_at: z.string().min(1),
		rows: z.number().int().nonnegative(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		source_url: z.string().min(1),
		data_file: z.string().min(1),
	})
	.strict();

export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

export interface LoadDatasetCacheOptions {
	readonly cacheRoot?: string;
	readonly dataset: string;
}

export interface DatasetCache {
	readonly manifest: DatasetManifest;
	readonly cacheDir: string;
	readonly dataPath: string;
	readonly data: string;
}

export async function loadDatasetCache(
	options: LoadDatasetCacheOptions,
): Promise<DatasetCache> {
	const cacheRoot = options.cacheRoot ?? ".benchmarks";
	const cacheDir = resolve(cacheRoot, "datasets", options.dataset);
	const manifestPath = join(cacheDir, "manifest.json");
	const manifest = await readManifest(manifestPath);

	if (manifest.dataset !== options.dataset) {
		throw new CacheError(
			`Cache manifest dataset mismatch: expected ${options.dataset}, got ${manifest.dataset}`,
		);
	}

	const dataPath = resolveContainedDataPath(cacheDir, manifest.data_file);
	const data = await readDataFile(dataPath);
	const actualSha256 = computeSha256(data);
	if (actualSha256 !== manifest.sha256) {
		throw new CacheError(
			`Cache sha256 mismatch for ${options.dataset}: expected ${manifest.sha256}, got ${actualSha256}`,
		);
	}

	return { manifest, cacheDir, dataPath, data };
}

function resolveContainedDataPath(cacheDir: string, dataFile: string): string {
	const dataPath = resolve(cacheDir, dataFile);
	const pathFromCacheDir = relative(cacheDir, dataPath);
	if (pathFromCacheDir.startsWith("..") || isAbsolute(pathFromCacheDir)) {
		throw new CacheError(
			`Cache data_file escapes cache directory: ${dataFile}`,
		);
	}
	if (!canonicalDataFilePattern.test(dataFile)) {
		throw new CacheError(
			`Cache data_file must be a canonical filename: ${dataFile}`,
		);
	}
	assertExistingPathContained(cacheDir, dataPath, dataFile);
	return dataPath;
}

function assertExistingPathContained(
	cacheDir: string,
	dataPath: string,
	dataFile: string,
): void {
	let dataStat: ReturnType<typeof lstatSync>;
	try {
		dataStat = lstatSync(dataPath);
	} catch (error) {
		if (isNotFoundError(error)) {
			return;
		}
		throw new CacheError(
			`Cache data_file stat failed: ${dataFile} (${formatCause(error)})`,
		);
	}

	const realCacheDir = realpathSync.native(cacheDir);
	const realDataPath = realpathSync.native(dataPath);
	if (!isInsidePath(realCacheDir, realDataPath)) {
		const symlinkDetail = dataStat.isSymbolicLink() ? " symlink" : "";
		throw new CacheError(
			`Cache data_file${symlinkDetail} escapes cache directory: ${dataFile}`,
		);
	}
}

function isInsidePath(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
	);
}

export function computeSha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function readManifest(manifestPath: string): Promise<DatasetManifest> {
	let rawManifest: string;
	try {
		rawManifest = await readFile(manifestPath, "utf8");
	} catch (error) {
		throw new CacheError(
			`Missing or unreadable cache manifest: ${manifestPath} (${formatCause(error)})`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawManifest);
	} catch (error) {
		throw new CacheError(
			`Invalid cache manifest JSON: ${manifestPath} (${formatCause(error)})`,
		);
	}

	const result = datasetManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new CacheError(
			`Invalid cache manifest schema: ${manifestPath} (${result.error.issues.map((issue) => issue.path.join(".")).join(", ")})`,
		);
	}
	return result.data;
}

async function readDataFile(dataPath: string): Promise<string> {
	try {
		return await readFile(dataPath, "utf8");
	} catch (error) {
		throw new CacheError(
			`Missing or unreadable cache data file: ${dataPath} (${formatCause(error)})`,
		);
	}
}

function formatCause(error: unknown): string {
	return String(error);
}

function isNotFoundError(error: unknown): boolean {
	return (
		error != null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
