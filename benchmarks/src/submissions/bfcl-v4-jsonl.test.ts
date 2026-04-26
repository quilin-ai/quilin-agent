import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "../wire/index.js";
import {
	bfclV4JsonlAdapter,
	createBfclV4JsonlAdapter,
	createBfclV4ResultFiles,
	serializeSubmissionFiles,
} from "./index.js";

const baseResult: BenchmarkResult = {
	cost: {
		input_tokens: 11,
		output_tokens: 7,
		per_model_usd: {},
		thinking_tokens: 0,
		total_usd: 0,
	},
	details: {
		category: "simple_python",
		general_category: "non_live",
	},
	latency_ms: 42,
	output: {
		tool_calls: [
			{
				arguments: { base: 10, height: 5 },
				function: "calculate_triangle_area",
			},
		],
	},
	passed: true,
	run_id: "run-1",
	score: 1,
	task_id: "simple_python_0",
};

describe("bfclV4JsonlAdapter", () => {
	it("serializes a partial-eval manifest with result file metadata", () => {
		const manifest = JSON.parse(bfclV4JsonlAdapter.serialize([baseResult])) as {
			readonly categories_included: readonly string[];
			readonly official_parity: boolean;
			readonly partial_eval: boolean;
			readonly result_files: readonly string[];
		};

		expect(manifest).toMatchObject({
			categories_included: ["simple_python"],
			official_parity: false,
			partial_eval: true,
		});
		expect(manifest.result_files).toEqual([
			"bfcl-v4/<run_id>/result/quilin-agent/non_live/BFCL_v4_simple_python_result.json",
		]);
	});

	it("generates official-style per-category result files", () => {
		const files = createBfclV4ResultFiles(
			[
				baseResult,
				{
					...baseResult,
					details: { category: "live_relevance", general_category: "live" },
					output: { tool_calls: [] },
					task_id: "live_relevance_0-0-0",
				},
			],
			{ modelName: "model-x", runId: "run-123" },
		);

		expect(files.map((file) => file.path)).toEqual([
			"bfcl-v4/run-123/result/model-x/live/BFCL_v4_live_relevance_result.json",
			"bfcl-v4/run-123/result/model-x/non_live/BFCL_v4_simple_python_result.json",
		]);
		expect(JSON.parse(files[1]?.content.trim() ?? "{}")).toEqual({
			id: "simple_python_0",
			input_token_count: 11,
			latency_ms: 42,
			output_token_count: 7,
			result: [
				{
					calculate_triangle_area: JSON.stringify({ base: 10, height: 5 }),
				},
			],
		});
	});

	it("serializes manifest and per-category result files through the adapter interface", () => {
		const files = serializeSubmissionFiles(
			bfclV4JsonlAdapter,
			[
				baseResult,
				{
					...baseResult,
					details: { category: "live_relevance", general_category: "live" },
					output: { tool_calls: [] },
					task_id: "live_relevance_0-0-0",
				},
			],
			"run-xyz",
		);

		expect([...files.keys()]).toEqual([
			"bfcl-v4/run-xyz/manifest.json",
			"bfcl-v4/run-xyz/result/quilin-agent/live/BFCL_v4_live_relevance_result.json",
			"bfcl-v4/run-xyz/result/quilin-agent/non_live/BFCL_v4_simple_python_result.json",
		]);
		expect(
			JSON.parse(files.get("bfcl-v4/run-xyz/manifest.json") ?? "{}"),
		).toMatchObject({
			official_parity: false,
			partial_eval: true,
			result_files: [
				"bfcl-v4/run-xyz/result/quilin-agent/live/BFCL_v4_live_relevance_result.json",
				"bfcl-v4/run-xyz/result/quilin-agent/non_live/BFCL_v4_simple_python_result.json",
			],
		});
		expect(
			files.get(
				"bfcl-v4/run-xyz/result/quilin-agent/non_live/BFCL_v4_simple_python_result.json",
			),
		).toContain("calculate_triangle_area");
	});

	it("uses nested submission filename and rejects unsafe path segments", () => {
		expect(bfclV4JsonlAdapter.filename("run-1")).toBe(
			"bfcl-v4/run-1/manifest.json",
		);
		expect(() => bfclV4JsonlAdapter.filename("../run")).toThrow(
			/Invalid BFCL v4 run_id/,
		);
		expect(() =>
			createBfclV4JsonlAdapter({ modelName: "bad/model" }).serialize([
				baseResult,
			]),
		).toThrow(/Invalid BFCL v4 model_name/);
	});

	it("fails loudly when result metadata or tool_calls are missing", () => {
		expect(() =>
			bfclV4JsonlAdapter.serialize([
				{ ...baseResult, details: { general_category: "non_live" } },
			]),
		).toThrow(/missing category metadata/);
		expect(() =>
			bfclV4JsonlAdapter.serialize([
				{ ...baseResult, details: { category: "simple_python" } },
			]),
		).toThrow(/missing category metadata/);
		expect(() =>
			createBfclV4ResultFiles([
				{ ...baseResult, output: { tool_calls: "invalid" } },
			]),
		).toThrow(/missing tool_calls/);
		expect(() =>
			createBfclV4ResultFiles([
				{ ...baseResult, output: { tool_calls: ["invalid"] } },
			]),
		).toThrow(/must be an object/);
		expect(() =>
			createBfclV4ResultFiles([
				{ ...baseResult, output: { tool_calls: [{ function: "x" }] } },
			]),
		).toThrow(/requires function and arguments/);
	});
});
