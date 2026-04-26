import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "../wire/result.js";
import {
	createBfclV4MultiTurnJsonlAdapter,
	createBfclV4MultiTurnResultFiles,
	serializeSubmissionFiles,
} from "./index.js";

const result = {
	cost: {
		input_tokens: 10,
		output_tokens: 5,
		per_model_usd: {},
		thinking_tokens: 0,
		total_usd: 0,
	},
	details: { category: "multi_turn_base", general_category: "multi_turn" },
	latency_ms: 123,
	output: {
		input_token_count: [[10]],
		latency: [[1.5]],
		model_output_trajectory: [[[{ cd: '{"folder":"document"}' }]]],
		output_token_count: [[5]],
	},
	passed: true,
	run_id: "run-1",
	score: 1,
	task_id: "multi_turn_base_0",
} satisfies BenchmarkResult;

describe("bfclV4MultiTurnJsonlAdapter", () => {
	it("writes official multi-turn result files plus a Quilin manifest", () => {
		const adapter = createBfclV4MultiTurnJsonlAdapter({ modelName: "model-x" });
		const files = serializeSubmissionFiles(adapter, [result], "run-123");

		expect([...files.keys()]).toEqual([
			"bfcl-v4/run-123/manifest.json",
			"bfcl-v4/run-123/result/model-x/multi_turn/BFCL_v4_multi_turn_base_result.json",
		]);
		expect(
			JSON.parse(files.get("bfcl-v4/run-123/manifest.json") ?? "{}"),
		).toMatchObject({
			bfcl_slice: "multi_turn",
			categories_included: ["multi_turn_base"],
			official_parity: false,
			partial_eval: true,
			stateful_eval: false,
		});
		expect(
			JSON.parse(
				files
					.get(
						"bfcl-v4/run-123/result/model-x/multi_turn/BFCL_v4_multi_turn_base_result.json",
					)
					?.trim() ?? "{}",
			),
		).toEqual({
			id: "multi_turn_base_0",
			input_token_count: [[10]],
			latency: [[1.5]],
			output_token_count: [[5]],
			result: [[[{ cd: '{"folder":"document"}' }]]],
		});
	});

	it("groups multiple multi-turn categories into separate files", () => {
		const files = createBfclV4MultiTurnResultFiles(
			[
				result,
				{
					...result,
					details: {
						category: "multi_turn_miss_func",
						general_category: "multi_turn",
					},
					task_id: "multi_turn_miss_func_0",
				},
			],
			{ modelName: "model-x", runId: "run-123" },
		);

		expect(files.map((file) => file.path)).toEqual([
			"bfcl-v4/run-123/result/model-x/multi_turn/BFCL_v4_multi_turn_base_result.json",
			"bfcl-v4/run-123/result/model-x/multi_turn/BFCL_v4_multi_turn_miss_func_result.json",
		]);
	});

	it("fails loudly on missing trajectory, category metadata, or unsafe path segments", () => {
		const adapter = createBfclV4MultiTurnJsonlAdapter();
		expect(() =>
			createBfclV4MultiTurnResultFiles([{ ...result, output: {} }], {
				runId: "run-1",
			}),
		).toThrow(/missing nested trajectory/);
		expect(() =>
			createBfclV4MultiTurnResultFiles([{ ...result, details: {} }], {
				runId: "run-1",
			}),
		).toThrow(/missing category metadata/);
		expect(() => adapter.filename("../run")).toThrow(/Invalid BFCL v4/);
		expect(() =>
			createBfclV4MultiTurnJsonlAdapter({ modelName: "bad/model" }).serialize([
				result,
			]),
		).toThrow(/Invalid BFCL v4/);
	});
});
