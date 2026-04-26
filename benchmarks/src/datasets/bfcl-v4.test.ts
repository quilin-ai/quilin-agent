import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSha256 } from "./cache.js";
import {
	BFCL_V4_DATASET,
	BFCL_V4_SCORER_TYPE,
	iterateBfclV4Tasks,
	loadBfclV4Tasks,
} from "./index.js";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("loadBfclV4Tasks", () => {
	it("loads non-live and live BFCL v4 rows as partial AST benchmark tasks", async () => {
		const cacheRoot = await writeBfclCache([
			bfclRow({
				category: "simple_python",
				id: "simple_python_0",
				ground_truth: [
					{ calculate_triangle_area: { base: [10], height: [5] } },
				],
			}),
			bfclRow({
				category: "live_relevance",
				general_category: "live",
				id: "live_relevance_0-0-0",
				ground_truth: [],
			}),
		]);

		const tasks = await loadBfclV4Tasks({ cacheRoot });

		expect(tasks).toHaveLength(2);
		expect(tasks[0]).toMatchObject({
			dataset: BFCL_V4_DATASET,
			scorer_type: BFCL_V4_SCORER_TYPE,
			task_id: "simple_python_0",
			inputs: {
				question: "Find the area.",
				function_definitions: [
					expect.objectContaining({ name: "calculate_triangle_area" }),
				],
			},
			expected: {
				category: "simple_python",
				expected_tool_calls: [
					{
						arguments: { base: 10, height: 5 },
						function: "calculate_triangle_area",
					},
				],
				general_category: "non_live",
			},
			metadata: {
				category: "simple_python",
				general_category: "non_live",
				official_parity: false,
				partial_eval: true,
			},
		});
		expect(tasks[1]?.metadata?.general_category).toBe("live");
	});

	it("filters by task id, category, and general category while preserving iteration order", async () => {
		const cacheRoot = await writeBfclCache([
			bfclRow({ category: "simple_python", id: "simple_python_0" }),
			bfclRow({
				category: "live_simple",
				general_category: "live",
				id: "live_simple_0",
			}),
			bfclRow({ category: "parallel", id: "parallel_0" }),
		]);

		const tasks = await loadBfclV4Tasks({
			cacheRoot,
			filter: {
				categories: ["parallel"],
				generalCategories: ["non_live"],
				taskIds: ["parallel_0"],
			},
		});

		expect(tasks.map((task) => task.task_id)).toEqual(["parallel_0"]);
		await expect(
			loadBfclV4Tasks({
				cacheRoot,
				filter: { categories: ["multiple"], generalCategories: ["live"] },
			}),
		).resolves.toEqual([]);
		await expect(
			loadBfclV4Tasks({
				cacheRoot,
				filter: { generalCategories: ["live"] },
			}),
		).resolves.toHaveLength(1);
		const iterated: string[] = [];
		for await (const task of iterateBfclV4Tasks({ cacheRoot })) {
			iterated.push(task.task_id);
		}
		expect(iterated).toEqual([
			"simple_python_0",
			"live_simple_0",
			"parallel_0",
		]);
	});

	it("rejects malformed rows and manifest/data row-count drift", async () => {
		const malformedRoot = await writeBfclCache([
			{ id: "bad", category: "unknown", general_category: "non_live" },
		]);
		await expect(loadBfclV4Tasks({ cacheRoot: malformedRoot })).rejects.toThrow(
			/Invalid BFCL v4 record/,
		);

		const driftRoot = await writeBfclCache(
			[bfclRow({ category: "simple_python", id: "simple_python_0" })],
			2,
		);
		await expect(loadBfclV4Tasks({ cacheRoot: driftRoot })).rejects.toThrow(
			/row count mismatch/,
		);
	});

	it("handles rows without official answers and falls back to serialized question text", async () => {
		const cacheRoot = await writeBfclCache([
			{
				category: "irrelevance",
				function: [],
				general_category: "non_live",
				id: "irrelevance_0",
				question: 42,
			},
			{
				category: "live_relevance",
				function: [],
				general_category: "live",
				ground_truth: ["ignored", { literal_tool: { raw: 1 } }],
				id: "live_relevance_0",
				question: [[{ content: "   ", role: "user" }]],
			},
		]);

		const tasks = await loadBfclV4Tasks({ cacheRoot });

		expect(tasks[0]?.inputs.question).toBe("42");
		expect(tasks[0]?.expected.expected_tool_calls).toEqual([]);
		expect(tasks[1]?.inputs.question).toBe(
			JSON.stringify([[{ content: "   ", role: "user" }]]),
		);
		expect(tasks[1]?.expected.expected_tool_calls).toEqual([
			{ arguments: { raw: 1 }, function: "literal_tool" },
		]);
	});

	it("normalizes malformed official argument maps as empty expected arguments", async () => {
		const cacheRoot = await writeBfclCache([
			bfclRow({
				category: "simple_python",
				ground_truth: [{ weird_tool: "not-a-map" }],
				id: "simple_python_weird",
			}),
		]);

		const tasks = await loadBfclV4Tasks({ cacheRoot });

		expect(tasks[0]?.expected.expected_tool_calls).toEqual([
			{ arguments: {}, function: "weird_tool" },
		]);
	});

	it("surfaces invalid JSON with row context", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-bfcl-cache-"));
		tempRoots.push(cacheRoot);
		const cacheDir = join(cacheRoot, "datasets", BFCL_V4_DATASET);
		await mkdir(cacheDir, { recursive: true });
		const data = "{not-json}\n";
		await writeFile(join(cacheDir, "data.jsonl"), data, "utf8");
		await writeFile(
			join(cacheDir, "manifest.json"),
			`${JSON.stringify({
				data_file: "data.jsonl",
				dataset: BFCL_V4_DATASET,
				fetched_at: "2026-04-26T00:00:00.000Z",
				requested_max_rows: null,
				rows: 1,
				schema_version: 1,
				sha256: computeSha256(data),
				source_url: "source",
			})}\n`,
			"utf8",
		);

		await expect(loadBfclV4Tasks({ cacheRoot })).rejects.toThrow(
			/Invalid BFCL v4 JSONL at row 0/,
		);
	});
});

async function writeBfclCache(
	rows: readonly Record<string, unknown>[],
	manifestRows = rows.length,
): Promise<string> {
	const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-bfcl-cache-"));
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
					"https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/data?categories=non_live,live",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return cacheRoot;
}

function bfclRow(overrides: {
	readonly category: string;
	readonly id: string;
	readonly general_category?: string;
	readonly ground_truth?: unknown;
}): Record<string, unknown> {
	return {
		category: overrides.category,
		function: [
			{
				name: "calculate_triangle_area",
				parameters: {
					properties: {
						base: { type: "integer" },
						height: { type: "integer" },
					},
					required: ["base", "height"],
					type: "dict",
				},
			},
		],
		general_category: overrides.general_category ?? "non_live",
		ground_truth: overrides.ground_truth ?? [
			{ calculate_triangle_area: { base: [10], height: [5] } },
		],
		id: overrides.id,
		question: [[{ content: "Find the area.", role: "user" }]],
	};
}
