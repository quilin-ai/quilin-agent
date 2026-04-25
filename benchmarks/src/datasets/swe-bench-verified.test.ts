import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CacheError, computeSha256 } from "./cache.js";
import { takeFirstN } from "./swe-bench-lite.js";
import {
	iterateSweBenchVerifiedTasks,
	loadSweBenchVerifiedTasks,
	SWE_BENCH_VERIFIED_DATASET,
	SWE_BENCH_VERIFIED_EXPECTED_ROWS,
} from "./swe-bench-verified.js";

const records = [
	{
		instance_id: "astropy__astropy-12907",
		problem_statement: "Fix separability for nested CompoundModels.",
		repo: "astropy/astropy",
		base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
		patch:
			"diff --git a/astropy/modeling/separable.py b/astropy/modeling/separable.py\n+fix\n",
		test_patch:
			"diff --git a/astropy/modeling/tests/test_separable.py b/astropy/modeling/tests/test_separable.py\n+test\n",
		difficulty: "medium",
		environment_setup_commit: "env123",
		version: "5.0",
	},
	{
		instance_id: "django__django-11099",
		problem_statement: "Correct queryset annotation behavior.",
		repo: "django/django",
		base_commit: "f00dbabe",
		patch:
			"diff --git a/django/db/models/query.py b/django/db/models/query.py\n+fix\n",
		test_patch: "diff --git a/tests/queryset.py b/tests/queryset.py\n+test\n",
		difficulty: "hard",
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

describe("SWE-bench Verified dataset loader", () => {
	it("documents the full Verified dataset size", () => {
		expect(SWE_BENCH_VERIFIED_EXPECTED_ROWS).toBe(500);
	});

	it("loads cached Verified rows as BenchmarkTask values", async () => {
		const cacheRoot = await writeSweBenchVerifiedCache(records);

		await expect(loadSweBenchVerifiedTasks({ cacheRoot })).resolves.toEqual([
			{
				task_id: "astropy__astropy-12907",
				dataset: SWE_BENCH_VERIFIED_DATASET,
				inputs: {
					problem_statement: "Fix separability for nested CompoundModels.",
					repo: "astropy/astropy",
					base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
				},
				expected: {
					golden_patch:
						"diff --git a/astropy/modeling/separable.py b/astropy/modeling/separable.py\n+fix\n",
					test_patch:
						"diff --git a/astropy/modeling/tests/test_separable.py b/astropy/modeling/tests/test_separable.py\n+test\n",
				},
				scorer_type: "swe-bench-patch-apply",
				metadata: {
					source_row: 0,
					difficulty: "medium",
					environment_setup_commit: "env123",
					version: "5.0",
				},
			},
			{
				task_id: "django__django-11099",
				dataset: SWE_BENCH_VERIFIED_DATASET,
				inputs: {
					problem_statement: "Correct queryset annotation behavior.",
					repo: "django/django",
					base_commit: "f00dbabe",
				},
				expected: {
					golden_patch:
						"diff --git a/django/db/models/query.py b/django/db/models/query.py\n+fix\n",
					test_patch:
						"diff --git a/tests/queryset.py b/tests/queryset.py\n+test\n",
				},
				scorer_type: "swe-bench-patch-apply",
				metadata: { source_row: 1, difficulty: "hard" },
			},
		]);
	});

	it("iterates, filters, and takes first records", async () => {
		const cacheRoot = await writeSweBenchVerifiedCache(records);
		const iteratedIds: string[] = [];

		for await (const task of iterateSweBenchVerifiedTasks({
			cacheRoot,
			filter: { repos: ["astropy/astropy"], difficulties: ["medium"] },
		})) {
			iteratedIds.push(task.task_id);
		}

		const allTasks = await loadSweBenchVerifiedTasks({ cacheRoot });
		expect(iteratedIds).toEqual(["astropy__astropy-12907"]);
		expect(takeFirstN(allTasks, 1).map((task) => task.task_id)).toEqual([
			"astropy__astropy-12907",
		]);
	});

	it("filters by instance id and rejects non-matching difficulties", async () => {
		const cacheRoot = await writeSweBenchVerifiedCache(records);

		await expect(
			loadSweBenchVerifiedTasks({
				cacheRoot,
				filter: { instanceIds: ["django__django-11099"] },
			}),
		).resolves.toHaveLength(1);
		await expect(
			loadSweBenchVerifiedTasks({
				cacheRoot,
				filter: { difficulties: ["easy"] },
			}),
		).resolves.toEqual([]);
	});

	it("uses .benchmarks as the default cache root", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "quilin-verified-cwd-"));
		tempRoots.push(workDir);
		const originalCwd = process.cwd();
		try {
			process.chdir(workDir);
			await writeSweBenchVerifiedCache(records, { cacheRoot: ".benchmarks" });

			await expect(loadSweBenchVerifiedTasks()).resolves.toHaveLength(2);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("rejects tampered cache data", async () => {
		const cacheRoot = await writeSweBenchVerifiedCache(records);
		await writeFile(
			join(cacheRoot, "datasets", SWE_BENCH_VERIFIED_DATASET, "data.jsonl"),
			`${JSON.stringify({ ...records[0], repo: "tampered/repo" })}\n`,
			"utf8",
		);

		await expect(loadSweBenchVerifiedTasks({ cacheRoot })).rejects.toThrow(
			/sha256 mismatch/,
		);
	});

	it("rejects invalid upstream rows before conversion", async () => {
		const { patch: _patch, ...invalidRecord } = records[0];
		const cacheRoot = await writeSweBenchVerifiedCache([invalidRecord]);

		await expect(loadSweBenchVerifiedTasks({ cacheRoot })).rejects.toThrow(
			CacheError,
		);
		await expect(loadSweBenchVerifiedTasks({ cacheRoot })).rejects.toThrow(
			/Invalid SWE-bench Verified record/,
		);
	});

	it("rejects invalid JSONL and row count mismatches", async () => {
		const cacheRoot = await writeSweBenchVerifiedCache(records);
		const datasetDir = join(cacheRoot, "datasets", SWE_BENCH_VERIFIED_DATASET);
		await writeFile(join(datasetDir, "data.jsonl"), "{", "utf8");
		await rewriteManifest(cacheRoot, {
			rows: 1,
			sha256: computeSha256("{"),
		});

		await expect(loadSweBenchVerifiedTasks({ cacheRoot })).rejects.toThrow(
			/Invalid SWE-bench Verified JSONL/,
		);

		await writeSweBenchVerifiedCache(records, {
			cacheRoot,
			manifestPatch: { rows: records.length + 1 },
		});
		await expect(loadSweBenchVerifiedTasks({ cacheRoot })).rejects.toThrow(
			/row count mismatch/,
		);
	});

	it("rejects manifests for a different dataset", async () => {
		const cacheRoot = await writeSweBenchVerifiedCache(records, {
			manifestPatch: { dataset: "swe-bench-lite" },
		});

		await expect(loadSweBenchVerifiedTasks({ cacheRoot })).rejects.toThrow(
			/dataset mismatch/,
		);
	});
});

async function writeSweBenchVerifiedCache(
	inputRecords: readonly Record<string, unknown>[],
	options: {
		readonly cacheRoot?: string;
		readonly manifestPatch?: Record<string, unknown>;
	} = {},
): Promise<string> {
	const cacheRoot =
		options.cacheRoot ?? (await mkdtemp(join(tmpdir(), "quilin-verified-")));
	if (options.cacheRoot == null) {
		tempRoots.push(cacheRoot);
	}
	const datasetDir = join(cacheRoot, "datasets", SWE_BENCH_VERIFIED_DATASET);
	await mkdir(datasetDir, { recursive: true });

	const data = `${inputRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
	await writeFile(join(datasetDir, "data.jsonl"), data, "utf8");

	const manifest = {
		schema_version: 1,
		dataset: SWE_BENCH_VERIFIED_DATASET,
		fetched_at: "2026-04-26T00:00:00.000Z",
		rows: inputRecords.length,
		sha256: computeSha256(data),
		source_url:
			"https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified",
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
	const datasetDir = join(cacheRoot, "datasets", SWE_BENCH_VERIFIED_DATASET);
	const manifest = {
		schema_version: 1,
		dataset: SWE_BENCH_VERIFIED_DATASET,
		fetched_at: "2026-04-26T00:00:00.000Z",
		rows: records.length,
		sha256: "",
		source_url:
			"https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified",
		data_file: "data.jsonl",
		...patch,
	};
	await writeFile(
		join(datasetDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
}
