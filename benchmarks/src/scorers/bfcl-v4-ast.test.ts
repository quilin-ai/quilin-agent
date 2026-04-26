import { describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../wire/index.js";
import {
	__bfclV4AstPrivateForTests,
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
					ground_truth: [{ lookup: { query: "weather" } }],
				}),
				{
					tool_calls: [
						{ function: "lookup", parameters: { query: "weather" } },
					],
				},
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
		expect(
			scoreBfclV4Ast(
				{
					...task({
						category: "simple_python",
						ground_truth: [{ first: { value: [1] } }],
					}),
					metadata: {},
				},
				{ tool_calls: [{ arguments: { value: 1 }, function: "first" }] },
			).passed,
		).toBe(true);
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

	it("converts Java string arguments before AST value matching", async () => {
		const javaTask = task({
			category: "simple_java",
			function_definitions: [
				functionDefinition("setUserFlags", {
					enabled: { type: "boolean" },
					ids: { items: { type: "integer" }, type: "Array" },
					limit: { type: "long" },
				}),
			],
			ground_truth: [
				{
					setUserFlags: {
						enabled: [true],
						ids: [[1, 2, 3]],
						limit: [42],
					},
				},
			],
		});

		expect(
			scoreBfclV4Ast(javaTask, {
				tool_calls: [
					{
						arguments: {
							enabled: "true",
							ids: "new int[]{1, 2, 3}",
							limit: "42L",
						},
						function: "setUserFlags",
					},
				],
			}).passed,
		).toBe(true);
		expect(
			scoreBfclV4Ast(javaTask, {
				tool_calls: [
					{
						arguments: {
							enabled: true,
							ids: "new int[]{1, 2, 3}",
							limit: "42L",
						},
						function: "setUserFlags",
					},
				],
			}).passed,
		).toBe(false);
	});

	it("converts JavaScript string arguments before AST value matching", async () => {
		const javascriptTask = task({
			category: "simple_javascript",
			function_definitions: [
				functionDefinition("submitAtCoordinate", {
					coordinates: { items: { type: "float" }, type: "array" },
					formId: { type: "String" },
					isComplete: { type: "Boolean" },
				}),
			],
			ground_truth: [
				{
					submitAtCoordinate: {
						coordinates: [[60, 30]],
						formId: ["loginForm"],
						isComplete: [true],
					},
				},
			],
		});

		expect(
			scoreBfclV4Ast(javascriptTask, {
				tool_calls: [
					{
						arguments: {
							coordinates: "[60, 30]",
							formId: '"loginForm"',
							isComplete: "true",
						},
						function: "submitAtCoordinate",
					},
				],
			}).passed,
		).toBe(true);
		expect(
			scoreBfclV4Ast(javascriptTask, {
				tool_calls: [
					{
						arguments: {
							coordinates: "[30, 60]",
							formId: '"loginForm"',
							isComplete: "true",
						},
						function: "submitAtCoordinate",
					},
				],
			}).passed,
		).toBe(false);
	});

	it("supports metadata language overrides for live AST fixtures", async () => {
		const liveJavascriptTask = task({
			category: "live_simple",
			function_definitions: [
				functionDefinition("toggleFeature", {
					enabled: { type: "Boolean" },
				}),
			],
			ground_truth: [{ toggleFeature: { enabled: [false] } }],
			language: "javascript",
		});

		expect(
			scoreBfclV4Ast(liveJavascriptTask, {
				tool_calls: [
					{ arguments: { enabled: "false" }, function: "toggleFeature" },
				],
			}).passed,
		).toBe(true);
	});

	it("ports Java converter branches used by the official BFCL AST checker", () => {
		const { convertJavaValue } = __bfclV4AstPrivateForTests;

		expect(convertJavaValue("127", "byte")).toBe(127);
		expect(convertJavaValue("bad", "short")).toBe("bad");
		expect(convertJavaValue("3.5F", "float")).toBe(3.5);
		expect(convertJavaValue("3.5", "float")).toBe("3.5");
		expect(convertJavaValue("2.25", "double")).toBe(2.25);
		expect(convertJavaValue("2.25D", "double")).toBe("2.25D");
		expect(convertJavaValue("42L", "long")).toBe(42);
		expect(convertJavaValue("42", "long")).toBe("42");
		expect(convertJavaValue("false", "boolean")).toBe(false);
		expect(convertJavaValue("maybe", "boolean")).toBe("maybe");
		expect(convertJavaValue("'x'", "char")).toBe("x");
		expect(convertJavaValue("xy", "char")).toBe("xy");
		expect(convertJavaValue("abc", "String")).toBe("abc");
		expect(convertJavaValue("123", "any")).toBe("123");
		expect(convertJavaValue("new int[]{1, 2, 3}", "Array", "integer")).toEqual([
			1, 2, 3,
		]);
		expect(
			convertJavaValue('new Object[]{1L, 3f, 4.5, "x", false}', "Array"),
		).toEqual([1, 3, 4.5, "x", false]);
		expect(convertJavaValue("not-array", "Array")).toBe("not-array");
		expect(
			convertJavaValue(
				'new ArrayList<>(Arrays.asList("a", "b"))',
				"ArrayList",
				"String",
			),
		).toEqual(["a", "b"]);
		expect(
			convertJavaValue("new ArrayList<>() {{ add(1); add(2); }}", "ArrayList"),
		).toEqual([1, 2]);
		expect(convertJavaValue("new ArrayList<>()", "ArrayList")).toEqual([]);
		expect(convertJavaValue("bad-list", "ArrayList")).toBe("bad-list");
		expect(
			convertJavaValue(
				'new HashMap<String, Object>() {{ put("key", true); }}',
				"HashMap",
			),
		).toEqual({ key: true });
		expect(convertJavaValue("new HashMap<>()", "HashMap")).toEqual({});
		expect(convertJavaValue("bad-map", "HashMap")).toBe("bad-map");
		expect(convertJavaValue("value", "Unsupported")).toBe("value");
	});

	it("ports JavaScript converter branches used by the official BFCL AST checker", () => {
		const { convertJsValue, splitTopLevel, topLevelSeparatorIndex } =
			__bfclV4AstPrivateForTests;

		expect(convertJsValue('"abc"', "String")).toBe("abc");
		expect(convertJsValue("abc", "String")).toBe("abc");
		expect(convertJsValue("12", "integer")).toBe(12);
		expect(convertJsValue("12.5", "integer")).toBe("12.5");
		expect(convertJsValue("12.5", "float")).toBe(12.5);
		expect(convertJsValue("12.5px", "float")).toBe("12.5px");
		expect(convertJsValue("12n", "Bigint")).toBe(12);
		expect(convertJsValue("12", "Bigint")).toBe("12");
		expect(convertJsValue("true", "Boolean")).toBe(true);
		expect(convertJsValue("maybe", "Boolean")).toBe("maybe");
		expect(convertJsValue("new Array(1, 'two', true)", "array")).toEqual([
			1,
			"two",
			true,
		]);
		expect(convertJsValue("[1n, 2.5, abc]", "array")).toEqual([1, 2.5, "abc"]);
		expect(convertJsValue("[1.5, 2.5]", "array", "float")).toEqual([1.5, 2.5]);
		expect(convertJsValue("[]", "array")).toEqual([]);
		expect(convertJsValue("not-array", "array")).toBe("not-array");
		expect(convertJsValue("{'key': 123, nested: [1, 2]}", "dict")).toEqual({
			key: 123,
			nested: [1, 2],
		});
		expect(convertJsValue("{nested: {enabled: true}}", "dict")).toEqual({
			nested: { enabled: true },
		});
		expect(convertJsValue("{}", "dict")).toEqual({});
		expect(convertJsValue("not-dict", "dict")).toBe("not-dict");
		expect(convertJsValue("{bad}", "dict")).toBe("{bad}");
		expect(convertJsValue("{123: true}", "dict")).toBe("{123: true}");
		expect(convertJsValue("abc", "any")).toBe("abc");
		expect(convertJsValue("abc", "Unsupported")).toBe("abc");
		expect(splitTopLevel("1, ['a,b'], {x: true}")).toEqual([
			"1",
			"['a,b']",
			"{x: true}",
		]);
		expect(topLevelSeparatorIndex("'a:b': 1", ":")).toBe(5);
		expect(topLevelSeparatorIndex("arr: [1, {nested: 2}]", ":")).toBe(3);
		expect(topLevelSeparatorIndex("{nested: 2}: value", ":")).toBe(11);
		expect(topLevelSeparatorIndex("'a:b'", ":")).toBe(-1);
	});

	it("covers schema reader and conversion guard branches", () => {
		const { convertActualValue, readFunctionSchemas } =
			__bfclV4AstPrivateForTests;

		expect(readFunctionSchemas("not-array").size).toBe(0);
		const schemas = readFunctionSchemas([
			null,
			{ name: 42 },
			{ name: "noParams", parameters: {} },
			{
				name: "mixed",
				parameters: {
					properties: {
						bad: null,
						noType: { items: {} },
						typed: { items: { type: "integer" }, type: "array" },
					},
				},
			},
		]);
		expect(schemas.get("mixed")?.get("bad")).toBeUndefined();
		expect(schemas.get("mixed")?.get("noType")).toEqual({
			nestedType: undefined,
			type: undefined,
		});
		expect(schemas.get("mixed")?.get("typed")).toEqual({
			nestedType: "integer",
			type: "array",
		});
		expect(convertActualValue("1", undefined)).toEqual({
			ok: true,
			value: "1",
		});
		expect(
			convertActualValue("1", {
				language: "python",
				schema: { type: "integer" },
			}),
		).toEqual({ ok: true, value: "1" });
		expect(
			convertActualValue(1, {
				language: "java",
				schema: { type: "String" },
			}),
		).toEqual({ ok: false });
		expect(
			convertActualValue(1, {
				language: "java",
				schema: { type: "Set" },
			}),
		).toEqual({ ok: true, value: 1 });
		expect(
			convertActualValue(1, {
				language: "javascript",
				schema: { type: "String" },
			}),
		).toEqual({ ok: false });
		expect(
			convertActualValue(1, {
				language: "javascript",
				schema: { type: "unknown" },
			}),
		).toEqual({ ok: true, value: 1 });
	});
});

function task(input: {
	readonly category: string;
	readonly function_definitions?: readonly Record<string, unknown>[];
	readonly ground_truth: unknown;
	readonly language?: "java" | "javascript" | "python";
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
			function_definitions: input.function_definitions ?? [],
			question: "Call the right function.",
		},
		metadata: {
			category: input.category,
			general_category: generalCategory,
			...(input.language == null ? {} : { language: input.language }),
		},
		scorer_type: BFCL_V4_AST_SCORER_TYPE,
		task_id: `${input.category}-fixture`,
	};
}

function functionDefinition(
	name: string,
	properties: Record<string, unknown>,
): Record<string, unknown> {
	return {
		name,
		parameters: {
			properties,
			required: Object.keys(properties),
			type: "dict",
		},
	};
}
