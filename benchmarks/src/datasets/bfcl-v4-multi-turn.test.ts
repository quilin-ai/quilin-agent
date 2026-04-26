import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSha256 } from "./cache.js";
import {
	BFCL_V4_DATASET,
	BFCL_V4_MULTI_TURN_SCORER_TYPE,
	iterateBfclV4MultiTurnTasks,
	loadBfclV4MultiTurnTasks,
} from "./index.js";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("loadBfclV4MultiTurnTasks", () => {
	it("loads BFCL v4 multi-turn rows without leaking initial_config into inputs", async () => {
		const cacheRoot = await writeBfclCache([
			multiTurnRow({ id: "multi_turn_base_0" }),
			astRow({ id: "simple_python_0" }),
		]);

		const tasks = await loadBfclV4MultiTurnTasks({ cacheRoot });

		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({
			dataset: BFCL_V4_DATASET,
			scorer_type: BFCL_V4_MULTI_TURN_SCORER_TYPE,
			task_id: "multi_turn_base_0",
			inputs: {
				question: "Move a file\nSearch the file",
				turns: [
					[{ content: "Move a file", role: "user" }],
					[{ content: "Search the file", role: "user" }],
				],
			},
			expected: {
				general_category: "multi_turn",
				involved_classes: ["GorillaFileSystem"],
				possible_answer: [["cd(folder='document')"], ["ls(a=True)"]],
			},
			metadata: {
				category: "multi_turn_base",
				general_category: "multi_turn",
				multi_turn: true,
				official_parity: false,
				partial_eval: true,
				stateful_eval: false,
			},
		});
		expect(tasks[0]?.inputs).not.toHaveProperty("initial_config");
	});

	it("filters by task id and category while preserving source order", async () => {
		const cacheRoot = await writeBfclCache([
			multiTurnRow({ category: "multi_turn_miss_func", id: "miss_func_0" }),
			multiTurnRow({ category: "multi_turn_long_context", id: "long_0" }),
		]);

		const tasks = await loadBfclV4MultiTurnTasks({
			cacheRoot,
			filter: {
				categories: ["multi_turn_long_context"],
				taskIds: ["long_0"],
			},
		});
		const iterated: string[] = [];
		for await (const task of iterateBfclV4MultiTurnTasks({ cacheRoot })) {
			iterated.push(task.task_id);
		}

		expect(tasks.map((task) => task.task_id)).toEqual(["long_0"]);
		expect(iterated).toEqual(["miss_func_0", "long_0"]);
		await expect(
			loadBfclV4MultiTurnTasks({
				cacheRoot,
				filter: { categories: ["multi_turn_base"] },
			}),
		).resolves.toEqual([]);
	});

	it("rejects malformed multi-turn rows and manifest/data row-count drift", async () => {
		const malformedRoot = await writeBfclCache([
			{ ...multiTurnRow({ id: "bad" }), possible_answer: "not-a-list" },
		]);
		await expect(
			loadBfclV4MultiTurnTasks({ cacheRoot: malformedRoot }),
		).rejects.toThrow(/Invalid BFCL v4 multi-turn record/);

		const driftRoot = await writeBfclCache(
			[multiTurnRow({ id: "multi_turn_base_0" })],
			2,
		);
		await expect(
			loadBfclV4MultiTurnTasks({ cacheRoot: driftRoot }),
		).rejects.toThrow(/row count mismatch/);

		const invalidJsonRoot = await writeRawBfclCache("{not-json}\n", 1);
		await expect(
			loadBfclV4MultiTurnTasks({ cacheRoot: invalidJsonRoot }),
		).rejects.toThrow(/Invalid BFCL v4 JSONL/);
	});

	it("fails loudly when the cache contains no multi-turn rows", async () => {
		const cacheRoot = await writeBfclCache([astRow({ id: "simple_python_0" })]);

		await expect(loadBfclV4MultiTurnTasks({ cacheRoot })).rejects.toThrow(
			/no multi-turn rows/,
		);
	});

	it("falls back to serialized turns when no content text exists", async () => {
		const row = multiTurnRow({ id: "multi_turn_base_0" });
		const turns = [[{ role: "user", other: 1 }]];
		const cacheRoot = await writeBfclCache([
			{
				...row,
				excluded_function: undefined,
				fixture_result: undefined,
				missed_function: undefined,
				question: turns,
			},
		]);

		const [task] = await loadBfclV4MultiTurnTasks({ cacheRoot });

		expect(task?.inputs.question).toBe(JSON.stringify(turns));
		expect(task?.expected).not.toHaveProperty("fixture_result");
		expect(task?.metadata?.excluded_function).toEqual([]);
		expect(task?.metadata?.missed_function).toEqual({});
	});
});

async function writeBfclCache(
	rows: readonly Record<string, unknown>[],
	manifestRows = rows.length,
): Promise<string> {
	const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-bfcl-mt-cache-"));
	tempRoots.push(cacheRoot);
	const cacheDir = join(cacheRoot, "datasets", BFCL_V4_DATASET);
	await mkdir(cacheDir, { recursive: true });
	const data = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	await writeFile(join(cacheDir, "data.jsonl"), data, "utf8");
	await writeFile(
		join(cacheDir, "manifest.json"),
		`${JSON.stringify(
			{
				data_file: "data.jsonl",
				dataset: BFCL_V4_DATASET,
				fetched_at: "2026-04-26T00:00:00.000Z",
				requested_max_rows: null,
				rows: manifestRows,
				schema_version: 1,
				sha256: computeSha256(data),
				source_url:
					"https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/data?categories=non_live,live,multi_turn",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return cacheRoot;
}

async function writeRawBfclCache(
	raw: string,
	manifestRows: number,
): Promise<string> {
	const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-bfcl-mt-cache-"));
	tempRoots.push(cacheRoot);
	const cacheDir = join(cacheRoot, "datasets", BFCL_V4_DATASET);
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "data.jsonl"), raw, "utf8");
	await writeFile(
		join(cacheDir, "manifest.json"),
		`${JSON.stringify({
			data_file: "data.jsonl",
			dataset: BFCL_V4_DATASET,
			fetched_at: "2026-04-26T00:00:00.000Z",
			requested_max_rows: null,
			rows: manifestRows,
			schema_version: 1,
			sha256: computeSha256(raw),
			source_url: "source",
		})}\n`,
		"utf8",
	);
	return cacheRoot;
}

function multiTurnRow(overrides: {
	readonly id: string;
	readonly category?: string;
}): Record<string, unknown> {
	return {
		category: overrides.category ?? "multi_turn_base",
		excluded_function: ["cp"],
		fixture_result: {
			id: overrides.id,
			result: [[[{ cd: '{"folder":"document"}' }]]],
		},
		general_category: "multi_turn",
		id: overrides.id,
		initial_config: { GorillaFileSystem: { root: {} } },
		involved_classes: ["GorillaFileSystem"],
		path: ["GorillaFileSystem.cd"],
		possible_answer: [["cd(folder='document')"], ["ls(a=True)"]],
		question: [
			[{ content: "Move a file", role: "user" }],
			[{ content: "Search the file", role: "user" }],
		],
	};
}

function astRow(overrides: { readonly id: string }): Record<string, unknown> {
	return {
		category: "simple_python",
		function: [],
		general_category: "non_live",
		id: overrides.id,
		question: [[{ content: "Call a function", role: "user" }]],
	};
}
