import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SweBenchLiteRecord } from "./dataset.js";
import {
	resolveSweBenchLiteJsonlPath,
	resolveSweBenchLiteManifestPath,
} from "./dataset.js";
import {
	iterateSweBenchLiteTasks,
	loadSweBenchLiteTasks,
	takeFirstN,
	toSweBenchLiteTask,
} from "./task-loader.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-task-loader-"));
	createdDirs.push(dir);
	return dir;
}

async function writeCache(
	cacheRoot: string,
	records: readonly SweBenchLiteRecord[],
): Promise<void> {
	const jsonlPath = resolveSweBenchLiteJsonlPath(cacheRoot);
	const manifestPath = resolveSweBenchLiteManifestPath(cacheRoot);
	const jsonl = records
		.map((row) => JSON.stringify(row))
		.join("\n")
		.concat("\n");
	const sha256 = createHash("sha256").update(jsonl).digest("hex");
	await mkdir(join(cacheRoot, "datasets", "swe-bench-lite"), {
		recursive: true,
	});
	await writeFile(jsonlPath, jsonl, "utf8");
	await writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				dataset: "swe-bench-lite",
				sourceDataset: "princeton-nlp/SWE-bench_Lite",
				config: "default",
				split: "test",
				pageSize: 100,
				rows: records.length,
				sha256,
				downloadedAt: "2026-04-22T00:00:00.000Z",
				sourceUrl: "https://example.test/rows",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function fixtureRecords(): SweBenchLiteRecord[] {
	return [
		{
			instance_id: "org__repo-1",
			problem_statement: "Fix bug 1",
			repo: "org/repo",
			base_commit: "sha1",
			patch: "diff --git a/one.ts b/one.ts",
			test_patch: "diff --git a/one.test.ts b/one.test.ts",
		},
		{
			instance_id: "org__repo-2",
			problem_statement: "Fix bug 2",
			repo: "org/repo",
			base_commit: "sha2",
			patch: "diff --git a/two.ts b/two.ts",
			test_patch: "diff --git a/two.test.ts b/two.test.ts",
		},
		{
			instance_id: "org__repo-3",
			problem_statement: "Fix bug 3",
			repo: "other-org/other-repo",
			base_commit: "sha3",
			patch: "diff --git a/three.ts b/three.ts",
			test_patch: "diff --git a/three.test.ts b/three.test.ts",
		},
	];
}

describe("swe-bench-lite task loader", () => {
	it("renames the raw 'patch' field to 'golden_patch' in the task view", () => {
		const [first] = fixtureRecords();
		const task = toSweBenchLiteTask(first);

		expect(task).toEqual({
			instance_id: "org__repo-1",
			problem_statement: "Fix bug 1",
			repo: "org/repo",
			base_commit: "sha1",
			golden_patch: "diff --git a/one.ts b/one.ts",
			test_patch: "diff --git a/one.test.ts b/one.test.ts",
		});
		expect("patch" in task).toBe(false);
	});

	it("loads tasks from an in-memory records override without touching disk", async () => {
		const records = fixtureRecords();
		const tasks = await loadSweBenchLiteTasks({ records });

		expect(tasks).toHaveLength(3);
		expect(tasks[0].golden_patch).toBe("diff --git a/one.ts b/one.ts");
		expect(tasks[2].repo).toBe("other-org/other-repo");
	});

	it("loads tasks from the E1-a cache when no override is provided", async () => {
		const cacheRoot = await createTempDir();
		const records = fixtureRecords();
		await writeCache(cacheRoot, records);

		const tasks = await loadSweBenchLiteTasks({ cacheRoot });

		expect(tasks.map((task) => task.instance_id)).toEqual([
			"org__repo-1",
			"org__repo-2",
			"org__repo-3",
		]);
		expect(tasks[1].golden_patch).toBe("diff --git a/two.ts b/two.ts");
	});

	it("iterateSweBenchLiteTasks yields records one at a time in order", async () => {
		const records = fixtureRecords();
		const yielded: string[] = [];

		for await (const task of iterateSweBenchLiteTasks({ records })) {
			yielded.push(task.instance_id);
		}

		expect(yielded).toEqual(["org__repo-1", "org__repo-2", "org__repo-3"]);
	});

	it("takeFirstN returns a new array containing the first n items without mutating input", () => {
		const records = fixtureRecords().map(toSweBenchLiteTask);
		const first2 = takeFirstN(records, 2);

		expect(first2).toHaveLength(2);
		expect(first2.map((t) => t.instance_id)).toEqual([
			"org__repo-1",
			"org__repo-2",
		]);
		expect(records).toHaveLength(3);
		expect(first2).not.toBe(records);
	});

	it("takeFirstN rejects negative or non-integer n", () => {
		const records = fixtureRecords().map(toSweBenchLiteTask);

		expect(() => takeFirstN(records, -1)).toThrow(
			/takeFirstN requires a non-negative integer/u,
		);
		expect(() => takeFirstN(records, 1.5)).toThrow(
			/takeFirstN requires a non-negative integer/u,
		);
	});

	it("takeFirstN clamps n larger than input length", () => {
		const records = fixtureRecords().map(toSweBenchLiteTask);
		const all = takeFirstN(records, 99);

		expect(all).toHaveLength(3);
	});
});
