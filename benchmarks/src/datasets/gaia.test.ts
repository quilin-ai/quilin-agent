import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSha256 } from "./cache.js";
import {
	GAIA_DATASET,
	GAIA_EXPECTED_VALIDATION_ROWS,
	iterateGaiaTasks,
	loadGaiaTasks,
} from "./gaia.js";
import { takeFirstN } from "./swe-bench-lite.js";

const records = [
	{
		task_id: "gaia-validation-1",
		Question: "What is the capital of France?",
		Level: 1,
		"Final answer": "Paris",
		file_name: "",
	},
	{
		task_id: "gaia-validation-2",
		Question: "Inspect the attached spreadsheet.",
		Level: "2",
		"Final answer": 42,
		file_name: "attachment.xlsx",
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

describe("GAIA dataset loader", () => {
	it("documents the official validation row count", () => {
		expect(GAIA_EXPECTED_VALIDATION_ROWS).toBe(165);
	});

	it("loads cached GAIA rows as BenchmarkTask values", async () => {
		const cacheRoot = await writeGaiaCache(records);

		await expect(loadGaiaTasks({ cacheRoot })).resolves.toEqual([
			{
				task_id: "gaia-validation-1",
				dataset: GAIA_DATASET,
				inputs: {
					level: 1,
					question: "What is the capital of France?",
				},
				expected: {
					final_answer: "Paris",
					eval_metadata: { level: 1, source_row: 0 },
				},
				scorer_type: "gaia-exact-match",
				metadata: { source_row: 0, source_schema: "gaia-2023" },
			},
			{
				task_id: "gaia-validation-2",
				dataset: GAIA_DATASET,
				inputs: {
					file_attachments: [
						{
							container_path:
								"/workspace/cache/datasets/gaia/attachments/attachment.xlsx",
							file_name: "attachment.xlsx",
							file_path:
								"/workspace/cache/datasets/gaia/attachments/attachment.xlsx",
							sha256: computeSha256("fixture:attachment.xlsx"),
							size_bytes: Buffer.byteLength("fixture:attachment.xlsx"),
						},
					],
					file_name: "attachment.xlsx",
					file_path:
						"/workspace/cache/datasets/gaia/attachments/attachment.xlsx",
					level: 2,
					question: "Inspect the attached spreadsheet.",
				},
				expected: {
					final_answer: "42",
					eval_metadata: { level: 2, source_row: 1 },
				},
				scorer_type: "gaia-exact-match",
				metadata: { source_row: 1, source_schema: "gaia-2023" },
			},
		]);
	});

	it("rejects missing or tampered GAIA attachments", async () => {
		const cacheRoot = await writeGaiaCache(records);
		await writeFile(
			join(
				cacheRoot,
				"datasets",
				GAIA_DATASET,
				"attachments",
				"attachment.xlsx",
			),
			"tampered",
			"utf8",
		);

		await expect(loadGaiaTasks({ cacheRoot })).rejects.toThrow(
			/attachment sha256 mismatch/,
		);

		const missingManifestRoot = await writeGaiaCache(records, {
			manifestPatch: { attachments: {} },
		});
		await expect(
			loadGaiaTasks({ cacheRoot: missingManifestRoot }),
		).rejects.toThrow(/Missing GAIA attachment manifest entry/);
		const legacyManifestRoot = await writeGaiaCache(records, {
			manifestPatch: { attachments: undefined },
		});
		await expect(
			loadGaiaTasks({ cacheRoot: legacyManifestRoot }),
		).rejects.toThrow(/Missing GAIA attachment manifest entry/);

		const missingFileRoot = await writeGaiaCache(records);
		await rm(
			join(
				missingFileRoot,
				"datasets",
				GAIA_DATASET,
				"attachments",
				"attachment.xlsx",
			),
			{ force: true },
		);
		await expect(loadGaiaTasks({ cacheRoot: missingFileRoot })).rejects.toThrow(
			/Missing or unreadable GAIA attachment/,
		);

		const wrongSizeRoot = await writeGaiaCache(records, {
			manifestPatch: {
				attachments: {
					"attachment.xlsx": {
						sha256: computeSha256("fixture:attachment.xlsx"),
						size_bytes: 999,
					},
				},
			},
		});
		await expect(loadGaiaTasks({ cacheRoot: wrongSizeRoot })).rejects.toThrow(
			/attachment size mismatch/,
		);
	});

	it("iterates, filters, and takes first records", async () => {
		const cacheRoot = await writeGaiaCache(records);
		const iteratedIds: string[] = [];

		for await (const task of iterateGaiaTasks({
			cacheRoot,
			filter: { levels: [2] },
		})) {
			iteratedIds.push(task.task_id);
		}

		const allTasks = await loadGaiaTasks({ cacheRoot });
		expect(iteratedIds).toEqual(["gaia-validation-2"]);
		expect(takeFirstN(allTasks, 1).map((task) => task.task_id)).toEqual([
			"gaia-validation-1",
		]);
		await expect(
			loadGaiaTasks({
				cacheRoot,
				filter: { taskIds: ["gaia-validation-1"] },
			}),
		).resolves.toHaveLength(1);
	});

	it("uses .benchmarks as the default cache root", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "quilin-gaia-cwd-"));
		tempRoots.push(workDir);
		const originalCwd = process.cwd();
		try {
			process.chdir(workDir);
			await writeGaiaCache(records, { cacheRoot: ".benchmarks" });

			await expect(loadGaiaTasks()).resolves.toHaveLength(2);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("rejects invalid GAIA rows and unsafe attachments", async () => {
		await expect(
			loadGaiaTasks({
				cacheRoot: await writeGaiaCache([
					{ ...records[0], "Final answer": undefined },
				]),
			}),
		).rejects.toThrow(/missing Final answer/);

		await expect(
			loadGaiaTasks({
				cacheRoot: await writeGaiaCache([{ ...records[0], Level: 4 }]),
			}),
		).rejects.toThrow(/level must be 1, 2, or 3/);

		await expect(
			loadGaiaTasks({
				cacheRoot: await writeGaiaCache([
					{ ...records[0], file_name: "../secret.txt" },
				]),
			}),
		).rejects.toThrow(/Unsafe GAIA attachment/);

		await expect(
			loadGaiaTasks({
				cacheRoot: await writeGaiaCache([
					{ ...records[0], file_name: `${"a".repeat(256)}.txt` },
				]),
			}),
		).rejects.toThrow(/Unsafe GAIA attachment/);
	});

	it("rejects invalid JSONL and row count mismatches", async () => {
		const cacheRoot = await writeGaiaCache(records);
		const datasetDir = join(cacheRoot, "datasets", GAIA_DATASET);
		await writeFile(join(datasetDir, "data.jsonl"), "{", "utf8");
		await rewriteManifest(cacheRoot, { rows: 1, sha256: computeSha256("{") });

		await expect(loadGaiaTasks({ cacheRoot })).rejects.toThrow(
			/Invalid GAIA JSONL/,
		);

		await writeGaiaCache(records, {
			cacheRoot,
			manifestPatch: { rows: records.length + 1 },
		});
		await expect(loadGaiaTasks({ cacheRoot })).rejects.toThrow(
			/row count mismatch/,
		);
	});

	it("accepts lowercase GAIA field aliases and rejects non-record JSON rows", async () => {
		const aliasRoot = await writeGaiaCache([
			{
				answer: true,
				file: "alias.txt",
				id: "gaia-alias",
				level: 3,
				question: "Alias question?",
			},
		]);

		await expect(loadGaiaTasks({ cacheRoot: aliasRoot })).resolves.toEqual([
			expect.objectContaining({
				expected: { final_answer: "true", eval_metadata: expect.any(Object) },
				inputs: expect.objectContaining({
					file_name: "alias.txt",
					level: 3,
					question: "Alias question?",
				}),
				task_id: "gaia-alias",
			}),
		]);

		const invalidRoot = await writeGaiaCache([]);
		const datasetDir = join(invalidRoot, "datasets", GAIA_DATASET);
		await writeFile(join(datasetDir, "data.jsonl"), "[]\n", "utf8");
		await rewriteManifest(invalidRoot, {
			rows: 1,
			sha256: computeSha256("[]\n"),
		});

		await expect(loadGaiaTasks({ cacheRoot: invalidRoot })).rejects.toThrow(
			/Invalid GAIA record/,
		);
	});

	it("rejects tampered cache data and dataset mismatches", async () => {
		const cacheRoot = await writeGaiaCache(records);
		await writeFile(
			join(cacheRoot, "datasets", GAIA_DATASET, "data.jsonl"),
			`${JSON.stringify({ ...records[0], Question: "tampered" })}\n`,
			"utf8",
		);

		await expect(loadGaiaTasks({ cacheRoot })).rejects.toThrow(
			/sha256 mismatch/,
		);

		const wrongDatasetRoot = await writeGaiaCache(records, {
			manifestPatch: { dataset: "swe-bench-verified" },
		});
		await expect(
			loadGaiaTasks({ cacheRoot: wrongDatasetRoot }),
		).rejects.toThrow(/dataset mismatch/);
	});
});

async function writeGaiaCache(
	inputRecords: readonly Record<string, unknown>[],
	options: {
		readonly cacheRoot?: string;
		readonly manifestPatch?: Record<string, unknown>;
	} = {},
): Promise<string> {
	const cacheRoot =
		options.cacheRoot ?? (await mkdtemp(join(tmpdir(), "quilin-gaia-")));
	if (options.cacheRoot == null) {
		tempRoots.push(cacheRoot);
	}
	const datasetDir = join(cacheRoot, "datasets", GAIA_DATASET);
	await mkdir(join(datasetDir, "attachments"), { recursive: true });
	const attachments: Record<
		string,
		{ readonly sha256: string; readonly size_bytes: number }
	> = {};
	for (const record of inputRecords) {
		const fileName = record.file_name ?? record.file;
		if (typeof fileName !== "string" || fileName.trim().length === 0) {
			continue;
		}
		if (
			fileName === "." ||
			fileName === ".." ||
			Buffer.byteLength(fileName) > 255 ||
			!/^[A-Za-z0-9._-]+$/.test(fileName) ||
			fileName.includes("..")
		) {
			continue;
		}
		const fixture = `fixture:${fileName}`;
		await writeFile(join(datasetDir, "attachments", fileName), fixture, "utf8");
		attachments[fileName] = {
			sha256: computeSha256(fixture),
			size_bytes: Buffer.byteLength(fixture),
		};
	}

	const data = `${inputRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
	await writeFile(join(datasetDir, "data.jsonl"), data, "utf8");

	const manifest = {
		schema_version: 1,
		dataset: GAIA_DATASET,
		fetched_at: "2026-04-26T00:00:00.000Z",
		rows: inputRecords.length,
		requested_max_rows: null,
		sha256: computeSha256(data),
		source_url:
			"https://datasets-server.huggingface.co/rows?dataset=gaia-benchmark%2FGAIA&config=2023_all&split=validation",
		data_file: "data.jsonl",
		attachments,
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
	const datasetDir = join(cacheRoot, "datasets", GAIA_DATASET);
	const data = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
	const manifest = {
		schema_version: 1,
		dataset: GAIA_DATASET,
		fetched_at: "2026-04-26T00:00:00.000Z",
		rows: records.length,
		requested_max_rows: null,
		sha256: computeSha256(data),
		source_url:
			"https://datasets-server.huggingface.co/rows?dataset=gaia-benchmark%2FGAIA&config=2023_all&split=validation",
		data_file: "data.jsonl",
		attachments: {
			"attachment.xlsx": {
				sha256: computeSha256("fixture:attachment.xlsx"),
				size_bytes: Buffer.byteLength("fixture:attachment.xlsx"),
			},
		},
		...patch,
	};
	await writeFile(
		join(datasetDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
}
