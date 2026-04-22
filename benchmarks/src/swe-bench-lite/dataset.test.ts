import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	downloadSweBenchLiteDataset,
	loadSweBenchLiteFromCache,
	parseSweBenchLiteJsonl,
	resolveSweBenchLiteJsonlPath,
	resolveSweBenchLiteManifestPath,
} from "./dataset.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-benchmarks-"));
	createdDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("swe-bench-lite dataset bootstrap", () => {
	it("parses valid cached jsonl records", () => {
		const parsed = parseSweBenchLiteJsonl(`
{"instance_id":"task-1","problem_statement":"Fix issue","repo":"org/repo","base_commit":"abc123","patch":"diff --git a","test_patch":"diff --git b"}
`);

		expect(parsed).toEqual([
			{
				instance_id: "task-1",
				problem_statement: "Fix issue",
				repo: "org/repo",
				base_commit: "abc123",
				patch: "diff --git a",
				test_patch: "diff --git b",
			},
		]);
	});

	it("rejects records missing required fields", () => {
		expect(() =>
			parseSweBenchLiteJsonl(`
{"instance_id":"task-1","problem_statement":"Fix issue","repo":"org/repo","base_commit":"abc123","patch":"diff --git a"}
`),
		).toThrow(/missing test_patch/u);
	});

	it("downloads paginated rows into jsonl cache with a manifest", async () => {
		const cacheRoot = await createTempDir();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				makeJsonResponse({
					rows: [
						{
							row: makeTask("task-1"),
						},
						{
							row: makeTask("task-2"),
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				makeJsonResponse({
					rows: [],
				}),
			);

		const result = await downloadSweBenchLiteDataset({
			cacheRoot,
			pageSize: 2,
			fetcher,
		});

		const cachedJsonl = await readFile(
			resolveSweBenchLiteJsonlPath(cacheRoot),
			"utf8",
		);
		const cachedManifest = JSON.parse(
			await readFile(resolveSweBenchLiteManifestPath(cacheRoot), "utf8"),
		) as { rows: number; dataset: string; sha256: string };

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(result.rows).toBe(2);
		expect(cachedManifest.rows).toBe(2);
		expect(cachedManifest.dataset).toBe("swe-bench-lite");
		expect(cachedManifest.sha256).toBe(result.sha256);
		expect(cachedJsonl.trim().split("\n")).toHaveLength(2);
		await expect(loadSweBenchLiteFromCache(cacheRoot)).resolves.toEqual([
			makeTask("task-1"),
			makeTask("task-2"),
		]);
	});

	it("rejects cache load when sha256 manifest does not match jsonl", async () => {
		const cacheRoot = await createTempDir();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				makeJsonResponse({
					rows: [{ row: makeTask("task-1") }],
				}),
			)
			.mockResolvedValueOnce(makeJsonResponse({ rows: [] }));

		await downloadSweBenchLiteDataset({ cacheRoot, pageSize: 1, fetcher });

		const jsonlPath = resolveSweBenchLiteJsonlPath(cacheRoot);
		const original = await readFile(jsonlPath, "utf8");
		await writeFile(jsonlPath, `${original}tampered\n`, "utf8");

		await expect(loadSweBenchLiteFromCache(cacheRoot)).rejects.toThrow(
			/integrity check failed/u,
		);
	});

	it("rejects cache load when manifest schemaVersion is not 1", async () => {
		const cacheRoot = await createTempDir();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				makeJsonResponse({
					rows: [{ row: makeTask("task-1") }],
				}),
			)
			.mockResolvedValueOnce(makeJsonResponse({ rows: [] }));

		await downloadSweBenchLiteDataset({ cacheRoot, pageSize: 1, fetcher });

		const manifestPath = resolveSweBenchLiteManifestPath(cacheRoot);
		const manifestRaw = await readFile(manifestPath, "utf8");
		const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
		manifest.schemaVersion = 2;
		await writeFile(
			manifestPath,
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		);

		await expect(loadSweBenchLiteFromCache(cacheRoot)).rejects.toThrow(
			/Unsupported manifest schemaVersion/u,
		);
	});
});

function makeTask(instanceId: string) {
	return {
		instance_id: instanceId,
		problem_statement: `Fix ${instanceId}`,
		repo: "org/repo",
		base_commit: "abc123",
		patch: "diff --git a/file.ts b/file.ts",
		test_patch: "diff --git a/test.ts b/test.ts",
	};
}

function makeJsonResponse(payload: unknown): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => payload,
	} as Response;
}
