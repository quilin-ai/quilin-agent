import type { BenchmarkTask } from "../wire/task.js";
import type { Scorer, ScorerResult } from "./types.js";

export const BFCL_V4_AST_SCORER_TYPE = "bfcl-v4-ast";

type BfclToolCall = {
	readonly function: string;
	readonly arguments: Readonly<Record<string, unknown>>;
};

type ExpectedCall = {
	readonly function: string;
	readonly arguments: Readonly<Record<string, readonly unknown[]>>;
};

export const bfclV4AstScorer: Scorer = async (task, output) =>
	scoreBfclV4Ast(task, output);

export function scoreBfclV4Ast(
	task: BenchmarkTask,
	output: Record<string, unknown>,
): ScorerResult {
	const category = readCategory(task);
	const toolCalls = readToolCalls(output);
	if (toolCalls == null) {
		return failedResult("invalid_model_tool_calls", { category });
	}

	if (category === "irrelevance" || category === "live_irrelevance") {
		const passed = toolCalls.length === 0;
		return {
			passed,
			score: passed ? 1 : 0,
			details: {
				category,
				model_tool_call_count: toolCalls.length,
				scorer_type: BFCL_V4_AST_SCORER_TYPE,
				...(passed ? {} : { reason: "unexpected_tool_call" }),
			},
		};
	}

	if (category === "live_relevance") {
		const passed = toolCalls.length > 0;
		return {
			passed,
			score: passed ? 1 : 0,
			details: {
				category,
				model_tool_call_count: toolCalls.length,
				scorer_type: BFCL_V4_AST_SCORER_TYPE,
				...(passed ? {} : { reason: "missing_relevant_tool_call" }),
			},
		};
	}

	const expectedCalls = readExpectedCalls(task.expected.ground_truth);
	if (expectedCalls.length === 0) {
		return failedResult("missing_expected_tool_calls", { category });
	}

	const passed = isParallelCategory(category)
		? matchCallsUnordered(toolCalls, expectedCalls)
		: matchCallsOrdered(toolCalls, expectedCalls);
	return {
		passed,
		score: passed ? 1 : 0,
		details: {
			category,
			expected_tool_call_count: expectedCalls.length,
			model_tool_call_count: toolCalls.length,
			scorer_type: BFCL_V4_AST_SCORER_TYPE,
			...(passed ? {} : { reason: "tool_call_ast_mismatch" }),
		},
	};
}

function readCategory(task: BenchmarkTask): string {
	const category = task.metadata?.category ?? task.expected.category;
	return typeof category === "string" ? category : "";
}

function readToolCalls(
	output: Record<string, unknown>,
): BfclToolCall[] | undefined {
	if (!Array.isArray(output.tool_calls)) {
		return undefined;
	}
	const toolCalls: BfclToolCall[] = [];
	for (const entry of output.tool_calls) {
		const toolCall = readToolCall(entry);
		if (toolCall == null) {
			return undefined;
		}
		toolCalls.push(toolCall);
	}
	return toolCalls;
}

function readToolCall(value: unknown): BfclToolCall | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const functionName = value.function ?? value.name;
	if (typeof functionName !== "string" || functionName.trim().length === 0) {
		return undefined;
	}
	const args = value.arguments ?? value.args ?? value.parameters;
	if (!isRecord(args)) {
		return undefined;
	}
	return {
		arguments: args,
		function: functionName,
	};
}

function readExpectedCalls(groundTruth: unknown): ExpectedCall[] {
	if (!Array.isArray(groundTruth)) {
		return [];
	}
	const calls: ExpectedCall[] = [];
	for (const entry of groundTruth) {
		if (!isRecord(entry)) {
			continue;
		}
		for (const [functionName, rawArguments] of Object.entries(entry)) {
			if (!isRecord(rawArguments)) {
				continue;
			}
			const expectedArguments: Record<string, readonly unknown[]> = {};
			for (const [argumentName, values] of Object.entries(rawArguments)) {
				expectedArguments[argumentName] = Array.isArray(values)
					? values
					: [values];
			}
			calls.push({
				arguments: expectedArguments,
				function: functionName,
			});
		}
	}
	return calls;
}

function matchCallsOrdered(
	toolCalls: readonly BfclToolCall[],
	expectedCalls: readonly ExpectedCall[],
): boolean {
	if (toolCalls.length !== expectedCalls.length) {
		return false;
	}
	return expectedCalls.every((expected, index) => {
		const actual = toolCalls[index];
		return actual != null && toolCallMatches(actual, expected);
	});
}

function matchCallsUnordered(
	toolCalls: readonly BfclToolCall[],
	expectedCalls: readonly ExpectedCall[],
): boolean {
	if (toolCalls.length !== expectedCalls.length) {
		return false;
	}
	const used = new Set<number>();
	return expectedCalls.every((expected) => {
		const matchIndex = toolCalls.findIndex(
			(actual, index) => !used.has(index) && toolCallMatches(actual, expected),
		);
		if (matchIndex === -1) {
			return false;
		}
		used.add(matchIndex);
		return true;
	});
}

function toolCallMatches(
	actual: BfclToolCall,
	expected: ExpectedCall,
): boolean {
	if (actual.function !== expected.function) {
		return false;
	}
	const actualArgNames = Object.keys(actual.arguments);
	const expectedArgNames = Object.keys(expected.arguments);
	for (const actualArgName of actualArgNames) {
		if (!expectedArgNames.includes(actualArgName)) {
			return false;
		}
	}
	for (const [argumentName, allowedValues] of Object.entries(
		expected.arguments,
	)) {
		const actualValue = actual.arguments[argumentName];
		if (actualValue === undefined) {
			if (allowedValues.some((value) => value === "" || value === null)) {
				continue;
			}
			return false;
		}
		if (
			!allowedValues.some((expectedValue) =>
				valuesEquivalent(actualValue, expectedValue),
			)
		) {
			return false;
		}
	}
	return true;
}

function valuesEquivalent(actual: unknown, expected: unknown): boolean {
	if (expected === "") {
		return actual === "";
	}
	if (typeof expected === "number") {
		return typeof actual === "number" && actual === expected;
	}
	if (typeof expected === "boolean") {
		return typeof actual === "boolean" && actual === expected;
	}
	if (typeof expected === "string") {
		return (
			typeof actual === "string" &&
			standardizeString(actual) === standardizeString(expected)
		);
	}
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((entry, index) => valuesEquivalent(actual[index], entry))
		);
	}
	if (isRecord(expected)) {
		return objectEquivalent(actual, expected);
	}
	return Object.is(actual, expected);
}

function objectEquivalent(
	actual: unknown,
	expected: Readonly<Record<string, unknown>>,
): boolean {
	if (!isRecord(actual)) {
		return false;
	}
	const actualKeys = Object.keys(actual);
	const expectedKeys = Object.keys(expected);
	if (actualKeys.length !== expectedKeys.length) {
		return false;
	}
	return expectedKeys.every((key) =>
		nestedExpectedValueMatches(actual[key], expected[key]),
	);
}

function nestedExpectedValueMatches(
	actual: unknown,
	expected: unknown,
): boolean {
	if (Array.isArray(expected) && !Array.isArray(actual)) {
		return expected.some((candidate) => valuesEquivalent(actual, candidate));
	}
	return valuesEquivalent(actual, expected);
}

function standardizeString(value: string): string {
	return value
		.replaceAll("'", '"')
		.replace(/[ ,./\-_*^]/g, "")
		.toLowerCase();
}

function isParallelCategory(category: string): boolean {
	return category.includes("parallel");
}

function failedResult(
	reason: string,
	details: Record<string, unknown> = {},
): ScorerResult {
	return {
		passed: false,
		score: 0,
		details: {
			scorer_type: BFCL_V4_AST_SCORER_TYPE,
			...details,
			reason,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}
