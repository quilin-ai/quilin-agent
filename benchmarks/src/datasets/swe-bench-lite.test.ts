import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CacheError, computeSha256 } from "./cache.js";
import {
	iterateSweBenchLiteTasks,
	loadSweBenchLiteTasks,
	takeFirstN,
} from "./swe-bench-lite.js";

const records = [
	{
		instance_id: "astropy__astropy-1",
		problem_statement: "Fix the failing coordinate parser.",
		repo: "astropy/astropy",
		base_commit: "abc123",
		patch: "diff --git a/a.py b/a.py\n+fix\n",
		test_patch: "diff --git a/test.py b/test.py\n+test\n",
	},
	{
		instance_id: "django__django-2",
		problem_statement: "Correct model validation.",
		repo: "django/django",
		base_commit: "def456",
		patch: "diff --git a/models.py b/models.py\n+fix\n",
		test_patch: "diff --git a/tests.py b/tests.py\n+test\n",
	},
] as const;

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("SWE-bench Lite dataset loader", () => {
	it("loads valid cache records as BenchmarkTask values", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records);

		await expect(loadSweBenchLiteTasks({ cacheRoot })).resolves.toEqual([
			{
				task_id: "astropy__astropy-1",
				dataset: "swe-bench-lite",
				inputs: {
					problem_statement: "Fix the failing coordinate parser.",
					repo: "astropy/astropy",
					base_commit: "abc123",
				},
				expected: {
					golden_patch: "diff --git a/a.py b/a.py\n+fix\n",
					test_patch: "diff --git a/test.py b/test.py\n+test\n",
				},
				scorer_type: "swe-bench-patch-apply",
				metadata: { source_row: 0 },
			},
			{
				task_id: "django__django-2",
				dataset: "swe-bench-lite",
				inputs: {
					problem_statement: "Correct model validation.",
					repo: "django/django",
					base_commit: "def456",
				},
				expected: {
					golden_patch: "diff --git a/models.py b/models.py\n+fix\n",
					test_patch: "diff --git a/tests.py b/tests.py\n+test\n",
				},
				scorer_type: "swe-bench-patch-apply",
				metadata: { source_row: 1 },
			},
		]);
	});

	it("iterates tasks with async iterable semantics", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records);
		const taskIds: string[] = [];

		for await (const task of iterateSweBenchLiteTasks({ cacheRoot })) {
			taskIds.push(task.task_id);
		}

		expect(taskIds).toEqual(["astropy__astropy-1", "django__django-2"]);
	});

	it("uses .benchmarks as the default cache root", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "quilin-benchmarks-cwd-"));
		tempRoots.push(workDir);
		const originalCwd = process.cwd();
		try {
			process.chdir(workDir);
			await writeSweBenchLiteCache(records, { cacheRoot: ".benchmarks" });

			await expect(loadSweBenchLiteTasks()).resolves.toHaveLength(2);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("takes the first n records and validates n", () => {
		expect(takeFirstN([1, 2, 3], 2)).toEqual([1, 2]);
		expect(takeFirstN([1, 2, 3], 0)).toEqual([]);
		expect(takeFirstN([1, 2], 5)).toEqual([1, 2]);
		expect(() => takeFirstN([1, 2], -1)).toThrow(RangeError);
		expect(() => takeFirstN([1, 2], 1.5)).toThrow(RangeError);
	});

	it("rejects tampered data when manifest sha256 no longer matches", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records);
		await writeFile(
			join(cacheRoot, "datasets", "swe-bench-lite", "data.jsonl"),
			`${JSON.stringify({ ...records[0], repo: "tampered/repo" })}\n`,
			"utf8",
		);

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			CacheError,
		);
		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/sha256 mismatch/,
		);
	});

	it("rejects cache manifests with mismatched schema_version", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records, {
			manifestPatch: { schema_version: 2 },
		});

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			CacheError,
		);
		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/Invalid cache manifest schema/,
		);
	});

	it("rejects invalid upstream records before conversion", async () => {
		const { patch: _patch, ...invalidRecord } = records[0];
		const cacheRoot = await writeSweBenchLiteCache([invalidRecord]);

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			CacheError,
		);
		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/Invalid SWE-bench Lite record/,
		);
	});

	it("rejects missing data files declared by a valid manifest", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records, {
			manifestPatch: {
				data_file: "missing.jsonl",
				sha256: computeSha256(""),
			},
		});

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/missing.jsonl/,
		);
	});

	it("rejects manifests for a different dataset", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records, {
			manifestPatch: { dataset: "swe-bench-verified" },
		});

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/dataset mismatch/,
		);
	});

	it("rejects invalid manifest JSON", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records);
		await writeFile(
			join(cacheRoot, "datasets", "swe-bench-lite", "manifest.json"),
			"{",
			"utf8",
		);

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/Invalid cache manifest JSON/,
		);
	});

	it("rejects missing manifests", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-benchmarks-"));
		tempRoots.push(cacheRoot);

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/Missing or unreadable cache manifest/,
		);
	});

	it("rejects invalid JSONL rows", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records);
		const data = "{";
		await writeFile(
			join(cacheRoot, "datasets", "swe-bench-lite", "data.jsonl"),
			data,
			"utf8",
		);
		await rewriteManifest(cacheRoot, { rows: 1, sha256: computeSha256(data) });

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/Invalid SWE-bench Lite JSONL/,
		);
	});

	it("rejects row count mismatches after reading JSONL", async () => {
		const cacheRoot = await writeSweBenchLiteCache(records, {
			manifestPatch: { rows: records.length + 1 },
		});

		await expect(loadSweBenchLiteTasks({ cacheRoot })).rejects.toThrow(
			/row count mismatch/,
		);
	});
});

async function writeSweBenchLiteCache(
	inputRecords: readonly Record<string, unknown>[],
	options: {
		readonly cacheRoot?: string;
		readonly manifestPatch?: Record<string, unknown>;
	} = {},
): Promise<string> {
	const cacheRoot =
		options.cacheRoot ?? (await mkdtemp(join(tmpdir(), "quilin-benchmarks-")));
	if (options.cacheRoot == null) {
		tempRoots.push(cacheRoot);
	}
	const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
	await mkdir(datasetDir, { recursive: true });

	const data = `${inputRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
	await writeFile(join(datasetDir, "data.jsonl"), data, "utf8");

	const manifest = {
		schema_version: 1,
		dataset: "swe-bench-lite",
		fetched_at: "2026-04-25T00:00:00.000Z",
		rows: inputRecords.length,
		sha256: computeSha256(data),
		source_url: "https://datasets-server.huggingface.co/rows?dataset=swe",
		data_file: "data.jsonl",
		...options.manifestPatch,
	};
	await writeFile(
		join(datasetDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);

	return cacheRoot;
}

async function rewriteManifest(
	cacheRoot: string,
	patch: Record<string, unknown>,
): Promise<void> {
	const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
	const manifest = {
		schema_version: 1,
		dataset: "swe-bench-lite",
		fetched_at: "2026-04-25T00:00:00.000Z",
		rows: records.length,
		sha256: "",
		source_url: "https://datasets-server.huggingface.co/rows?dataset=swe",
		data_file: "data.jsonl",
		...patch,
	};
	await writeFile(
		join(datasetDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
}
