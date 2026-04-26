import { describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../wire/index.js";
import {
	BFCL_V4_AST_SCORER_TYPE,
	bfclV4AstScorer,
	scoreBfclV4Ast,
} from "./index.js";

describe("bfclV4AstScorer", () => {
	it("passes simple function calls when function and typed arguments match", async () => {
		const result = await bfclV4AstScorer(
			task({
				category: "simple_python",
				ground_truth: [
					{
						calculate_triangle_area: {
							base: [10],
							height: [5],
							unit: ["units", ""],
						},
					},
				],
			}),
			{
				tool_calls: [
					{
						arguments: { base: 10, height: 5, unit: "units" },
						function: "calculate_triangle_area",
					},
				],
			},
		);

		expect(result).toMatchObject({
			passed: true,
			score: 1,
			details: { scorer_type: BFCL_V4_AST_SCORER_TYPE },
		});
	});

	it.each([
		[
			"function name mismatch",
			[{ function: "wrong", arguments: { base: 10, height: 5 } }],
		],
		[
			"missing required argument",
			[{ function: "calculate_triangle_area", arguments: { base: 10 } }],
		],
		[
			"unexpected argument",
			[
				{
					function: "calculate_triangle_area",
					arguments: { base: 10, height: 5, extra: true },
				},
			],
		],
		[
			"type mismatch",
			[
				{
					function: "calculate_triangle_area",
					arguments: { base: "10", height: 5 },
				},
			],
		],
	])("fails for %s", async (_label, toolCalls) => {
		const result = await bfclV4AstScorer(
			task({
				category: "simple_python",
				ground_truth: [
					{ calculate_triangle_area: { base: [10], height: [5] } },
				],
			}),
			{ tool_calls: toolCalls },
		);

		expect(result).toMatchObject({
			passed: false,
			score: 0,
			details: { reason: "tool_call_ast_mismatch" },
		});
	});

	it("matches parallel tool calls without requiring output order", async () => {
		const result = await bfclV4AstScorer(
			task({
				category: "parallel",
				ground_truth: [
					{ "spotify.play": { artist: ["Taylor Swift"], duration: [20] } },
					{ "spotify.play": { artist: ["Maroon 5"], duration: [15] } },
				],
			}),
			{
				tool_calls: [
					{
						arguments: { artist: "Maroon 5", duration: 15 },
						function: "spotify.play",
					},
					{
						arguments: { artist: "Taylor Swift", duration: 20 },
						function: "spotify.play",
					},
				],
			},
		);

		expect(result.passed).toBe(true);
	});

	it("keeps ordered categories order-sensitive", async () => {
		const result = await bfclV4AstScorer(
			task({
				category: "multiple",
				ground_truth: [
					{ first_tool: { value: [1] } },
					{ second_tool: { value: [2] } },
				],
			}),
			{
				tool_calls: [
					{ arguments: { value: 2 }, function: "second_tool" },
					{ arguments: { value: 1 }, function: "first_tool" },
				],
			},
		);

		expect(result.passed).toBe(false);
	});

	it("handles live relevance and irrelevance as function-call presence checks", async () => {
		expect(
			scoreBfclV4Ast(task({ category: "live_relevance", ground_truth: [] }), {
				tool_calls: [{ arguments: { q: "weather" }, function: "search" }],
			}).passed,
		).toBe(true);
		expect(
			scoreBfclV4Ast(task({ category: "live_relevance", ground_truth: [] }), {
				tool_calls: [],
			}).details.reason,
		).toBe("missing_relevant_tool_call");
		expect(
			scoreBfclV4Ast(task({ category: "irrelevance", ground_truth: [] }), {
				tool_calls: [],
			}).passed,
		).toBe(true);
		expect(
			scoreBfclV4Ast(task({ category: "live_irrelevance", ground_truth: [] }), {
				tool_calls: [{ arguments: {}, function: "search" }],
			}).details.reason,
		).toBe("unexpected_tool_call");
	});

	it("compares nested arrays and objects without sentinel fallback", async () => {
		const result = await bfclV4AstScorer(
			task({
				category: "simple_python",
				ground_truth: [
					{
						db_fetch_records: {
							conditions: [{ department: ["Science"], school: ["Bluebird"] }],
							fields: [["Personal Info", "Job History"]],
						},
					},
				],
			}),
			{
				tool_calls: [
					{
						arguments: {
							conditions: { department: "Science", school: "Bluebird" },
							fields: ["Personal Info", "Job History"],
						},
						function: "db_fetch_records",
					},
				],
			},
		);

		expect(result.passed).toBe(true);
		expect(
			scoreBfclV4Ast(
				task({
					category: "simple_python",
					ground_truth: [
						{ number_tool: { value: [Number.POSITIVE_INFINITY] } },
					],
				}),
				{
					tool_calls: [
						{ arguments: { value: "garbage" }, function: "number_tool" },
					],
				},
			).passed,
		).toBe(false);
	});

	it("fails loudly for missing expected or invalid model output", async () => {
		expect(
			(
				await bfclV4AstScorer(
					task({ category: "simple_python", ground_truth: [] }),
					{ tool_calls: [] },
				)
			).details.reason,
		).toBe("missing_expected_tool_calls");
		expect(
			(
				await bfclV4AstScorer(
					task({ category: "simple_python", ground_truth: [] }),
					{ tool_calls: [{ function: "", arguments: {} }] },
				)
			).details.reason,
		).toBe("invalid_model_tool_calls");
		expect(
			(
				await bfclV4AstScorer(
					task({ category: "simple_python", ground_truth: [] }),
					{ tool_calls: ["invalid"] },
				)
			).details.reason,
		).toBe("invalid_model_tool_calls");
		expect(
			(
				await bfclV4AstScorer(
					task({ category: "simple_python", ground_truth: [] }),
					{ tool_calls: [{ arguments: "bad", function: "x" }] },
				)
			).details.reason,
		).toBe("invalid_model_tool_calls");
		expect(
			(
				await bfclV4AstScorer(
					task({ category: "simple_python", ground_truth: [] }),
					{ tool_calls: "not-array" },
				)
			).details.reason,
		).toBe("invalid_model_tool_calls");
	});

	it("covers alias input forms, optional omissions, and malformed expected entries", async () => {
		expect(
			scoreBfclV4Ast(
				task({
					category: "simple_python",
					ground_truth: [
						{
							lookup: {
								optional: ["", null],
								query: ["weather"],
							},
						},
						"ignored",
						{ ignored_tool: "not-record" },
					],
				}),
				{ tool_calls: [{ args: { query: "weather" }, name: "lookup" }] },
			).passed,
		).toBe(true);
		expect(
			scoreBfclV4Ast(
				task({
					category: "simple_python",
					ground_truth: { lookup: { query: ["weather"] } },
				}),
				{
					tool_calls: [{ arguments: { query: "weather" }, function: "lookup" }],
				},
			).details.reason,
		).toBe("missing_expected_tool_calls");
		expect(
			scoreBfclV4Ast(
				task({
					category: "parallel",
					ground_truth: [{ first: { value: [1] } }],
				}),
				{ tool_calls: [] },
			).passed,
		).toBe(false);
		expect(
			scoreBfclV4Ast(
				task({
					category: "parallel",
					ground_truth: [{ first: { value: [1] } }],
				}),
				{ tool_calls: [{ arguments: { value: 2 }, function: "second" }] },
			).passed,
		).toBe(false);
		expect(
			scoreBfclV4Ast(
				task({
					category: "simple_python",
					ground_truth: [{ first: { value: [1] } }],
				}),
				{ tool_calls: [] },
			).passed,
		).toBe(false);
	});

	it("rejects malformed nested argument objects and accepts alternate scalar values", async () => {
		const nestedTask = task({
			category: "simple_python",
			ground_truth: [
				{
					db_fetch_records: {
						conditions: [{ department: ["Science"], school: ["Bluebird"] }],
						limit: [10, 20],
					},
				},
			],
		});

		expect(
			scoreBfclV4Ast(nestedTask, {
				tool_calls: [
					{
						arguments: {
							conditions: "not-object",
							limit: 20,
						},
						function: "db_fetch_records",
					},
				],
			}).passed,
		).toBe(false);
		expect(
			scoreBfclV4Ast(nestedTask, {
				tool_calls: [
					{
						arguments: {
							conditions: { department: "Science", school: "Bluebird" },
							limit: 20,
						},
						function: "db_fetch_records",
					},
				],
			}).passed,
		).toBe(true);
		expect(
			scoreBfclV4Ast(
				task({
					category: "simple_python",
					ground_truth: [
						{
							lookup_object: {
								payload: [{ nested: { enabled: true } }],
							},
						},
					],
				}),
				{
					tool_calls: [
						{
							arguments: { payload: { nested: { enabled: true } } },
							function: "lookup_object",
						},
					],
				},
			).passed,
		).toBe(true);
	});

	it("covers scalar, null, and nested mismatch branches", async () => {
		const scalarTask = task({
			category: "simple_python",
			ground_truth: [
				{
					mixed_tool: {
						enabled: [true],
						metadata: [null],
						optional_text: [""],
						tags: [["alpha", "beta"]],
					},
				},
			],
		});

		expect(
			scoreBfclV4Ast(scalarTask, {
				tool_calls: [
					{
						arguments: {
							enabled: true,
							metadata: null,
							optional_text: "",
							tags: ["alpha", "beta"],
						},
						function: "mixed_tool",
					},
				],
			}).passed,
		).toBe(true);
		expect(
			scoreBfclV4Ast(scalarTask, {
				tool_calls: [
					{
						arguments: {
							enabled: "true",
							metadata: null,
							optional_text: "",
							tags: ["alpha", "beta"],
						},
						function: "mixed_tool",
					},
				],
			}).passed,
		).toBe(false);
		expect(
			scoreBfclV4Ast(
				task({
					category: "simple_python",
					ground_truth: [{ object_tool: { value: [{ a: 1, b: 2 }] } }],
				}),
				{
					tool_calls: [
						{ arguments: { value: { a: 1 } }, function: "object_tool" },
					],
				},
			).passed,
		).toBe(false);
	});
});

function task(input: {
	readonly category: string;
	readonly ground_truth: unknown;
}): BenchmarkTask {
	const generalCategory = input.category.startsWith("live_")
		? "live"
		: "non_live";
	return {
		dataset: "bfcl-v4",
		expected: {
			category: input.category,
			general_category: generalCategory,
			ground_truth: input.ground_truth,
		},
		inputs: {
			function_definitions: [],
			question: "Call the right function.",
		},
		metadata: {
			category: input.category,
			general_category: generalCategory,
		},
		scorer_type: BFCL_V4_AST_SCORER_TYPE,
		task_id: `${input.category}-fixture`,
	};
}
