import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

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
	const cacheDir = join(cacheRoot, "datasets", options.dataset);
	const manifestPath = join(cacheDir, "manifest.json");
	const manifest = await readManifest(manifestPath);

	if (manifest.dataset !== options.dataset) {
		throw new CacheError(
			`Cache manifest dataset mismatch: expected ${options.dataset}, got ${manifest.dataset}`,
		);
	}

	const dataPath = join(cacheDir, manifest.data_file);
	const data = await readDataFile(dataPath);
	const actualSha256 = computeSha256(data);
	if (actualSha256 !== manifest.sha256) {
		throw new CacheError(
			`Cache sha256 mismatch for ${options.dataset}: expected ${manifest.sha256}, got ${actualSha256}`,
		);
	}

	return { manifest, cacheDir, dataPath, data };
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
