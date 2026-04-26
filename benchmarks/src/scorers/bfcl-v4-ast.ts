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

type BfclLanguage = "python" | "java" | "javascript";

type ParameterSchema = {
	readonly type?: string;
	readonly nestedType?: string;
};

type MatchContext = {
	readonly language: BfclLanguage;
	readonly functionSchemas: ReadonlyMap<
		string,
		ReadonlyMap<string, ParameterSchema>
	>;
};

type ConvertedValue =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };

const javaConvertibleTypes = new Set([
	"byte",
	"short",
	"integer",
	"float",
	"double",
	"long",
	"boolean",
	"char",
	"Array",
	"ArrayList",
	"HashMap",
	"String",
	"any",
]);

const jsConvertibleTypes = new Set([
	"String",
	"integer",
	"float",
	"Bigint",
	"Boolean",
	"dict",
	"array",
	"any",
]);

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

	const context: MatchContext = {
		functionSchemas: readFunctionSchemas(task.inputs.function_definitions),
		language: readLanguage(task, category),
	};
	const passed = isParallelCategory(category)
		? matchCallsUnordered(toolCalls, expectedCalls, context)
		: matchCallsOrdered(toolCalls, expectedCalls, context);
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

function readLanguage(task: BenchmarkTask, category: string): BfclLanguage {
	const language = task.metadata?.language;
	if (
		language === "java" ||
		language === "javascript" ||
		language === "python"
	) {
		return language;
	}
	if (category.includes("javascript")) {
		return "javascript";
	}
	if (category.includes("java")) {
		return "java";
	}
	return "python";
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
	context: MatchContext,
): boolean {
	if (toolCalls.length !== expectedCalls.length) {
		return false;
	}
	return expectedCalls.every((expected, index) => {
		const actual = toolCalls[index];
		return actual != null && toolCallMatches(actual, expected, context);
	});
}

function matchCallsUnordered(
	toolCalls: readonly BfclToolCall[],
	expectedCalls: readonly ExpectedCall[],
	context: MatchContext,
): boolean {
	if (toolCalls.length !== expectedCalls.length) {
		return false;
	}
	const used = new Set<number>();
	return expectedCalls.every((expected) => {
		const matchIndex = toolCalls.findIndex(
			(actual, index) =>
				!used.has(index) && toolCallMatches(actual, expected, context),
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
	context: MatchContext,
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
		const argumentSchema = context.functionSchemas
			.get(expected.function)
			?.get(argumentName);
		if (actualValue === undefined) {
			if (allowedValues.some((value) => value === "" || value === null)) {
				continue;
			}
			return false;
		}
		if (
			!allowedValues.some((expectedValue) =>
				valuesEquivalent(actualValue, expectedValue, {
					language: context.language,
					schema: argumentSchema,
				}),
			)
		) {
			return false;
		}
	}
	return true;
}

function valuesEquivalent(
	actual: unknown,
	expected: unknown,
	context?: {
		readonly language: BfclLanguage;
		readonly schema: ParameterSchema | undefined;
	},
): boolean {
	const converted = convertActualValue(actual, context);
	if (!converted.ok) {
		return false;
	}
	return rawValuesEquivalent(converted.value, expected);
}

function rawValuesEquivalent(actual: unknown, expected: unknown): boolean {
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
			expected.every((entry, index) =>
				rawValuesEquivalent(actual[index], entry),
			)
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
		return expected.some((candidate) => rawValuesEquivalent(actual, candidate));
	}
	return rawValuesEquivalent(actual, expected);
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

function readFunctionSchemas(
	functionDefinitions: unknown,
): ReadonlyMap<string, ReadonlyMap<string, ParameterSchema>> {
	const schemas = new Map<string, ReadonlyMap<string, ParameterSchema>>();
	if (!Array.isArray(functionDefinitions)) {
		return schemas;
	}
	for (const definition of functionDefinitions) {
		if (!isRecord(definition) || typeof definition.name !== "string") {
			continue;
		}
		const parameters = definition.parameters;
		const properties = isRecord(parameters) ? parameters.properties : undefined;
		if (!isRecord(properties)) {
			continue;
		}
		const argumentSchemas = new Map<string, ParameterSchema>();
		for (const [argumentName, rawSchema] of Object.entries(properties)) {
			if (!isRecord(rawSchema)) {
				continue;
			}
			const items = rawSchema.items;
			argumentSchemas.set(argumentName, {
				nestedType:
					isRecord(items) && typeof items.type === "string"
						? items.type
						: undefined,
				type: typeof rawSchema.type === "string" ? rawSchema.type : undefined,
			});
		}
		schemas.set(definition.name, argumentSchemas);
	}
	return schemas;
}

function convertActualValue(
	actual: unknown,
	context:
		| {
				readonly language: BfclLanguage;
				readonly schema: ParameterSchema | undefined;
		  }
		| undefined,
): ConvertedValue {
	const expectedType = context?.schema?.type;
	if (
		context == null ||
		expectedType == null ||
		context.language === "python"
	) {
		return { ok: true, value: actual };
	}
	if (context.language === "java") {
		if (!javaConvertibleTypes.has(expectedType)) {
			return { ok: true, value: actual };
		}
		return typeof actual === "string"
			? {
					ok: true,
					value: convertJavaValue(
						actual,
						expectedType,
						context.schema?.nestedType,
					),
				}
			: { ok: false };
	}
	if (!jsConvertibleTypes.has(expectedType)) {
		return { ok: true, value: actual };
	}
	return typeof actual === "string"
		? {
				ok: true,
				value: convertJsValue(actual, expectedType, context.schema?.nestedType),
			}
		: { ok: false };
}

function convertJavaValue(
	value: string,
	expectedType: string,
	nestedType?: string,
): unknown {
	switch (expectedType) {
		case "byte":
		case "short":
		case "integer":
			return /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : String(value);
		case "float":
			return /^-?\d+(\.\d+)?([eE][+-]?\d+)?[fF]$/.test(value)
				? Number.parseFloat(value.replace(/[fF]$/, ""))
				: String(value);
		case "double":
			return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)
				? Number.parseFloat(value)
				: String(value);
		case "long":
			return /^-?\d+[lL]$/.test(value)
				? Number.parseInt(value.slice(0, -1), 10)
				: String(value);
		case "boolean":
			return value === "true" || value === "false"
				? value === "true"
				: String(value);
		case "char":
			return /^'.'$/.test(value) ? value.slice(1, -1) : String(value);
		case "Array":
			return parseJavaArray(value, nestedType);
		case "ArrayList":
			return parseJavaArrayList(value, nestedType);
		case "HashMap":
			return parseJavaHashMap(value);
		case "String":
		case "any":
			return String(value);
		default:
			return value;
	}
}

function parseJavaArray(value: string, nestedType?: string): unknown {
	const match = /^new\s+\w+\[\]\s*\{(.*)\}$/.exec(value.trim());
	if (match == null) {
		return value;
	}
	return splitTopLevel(match[1] ?? "")
		.filter((entry) => entry.length > 0)
		.map((entry) => parseJavaScalar(entry, nestedType));
}

function parseJavaArrayList(value: string, nestedType?: string): unknown {
	const trimmed = value.trim();
	const arrayListMatch =
		/^new\s+ArrayList<\w*>\(Arrays\.asList\((.*)\)\)$/.exec(trimmed);
	if (arrayListMatch != null) {
		return splitTopLevel(arrayListMatch[1] ?? "").map((entry) =>
			parseJavaScalar(entry, nestedType),
		);
	}
	const addBlockMatch = /^new\s+ArrayList<\w*>\(\)\s*\{\{\s*(.*?)\s*\}\}$/.exec(
		trimmed,
	);
	if (addBlockMatch != null) {
		return [...(addBlockMatch[1] ?? "").matchAll(/add\((.*?)\)/g)].map(
			(match) => parseJavaScalar(match[1] ?? "", nestedType),
		);
	}
	return /^new\s+ArrayList<\w*>\(\)$/.test(trimmed) ? [] : value;
}

function parseJavaHashMap(value: string): unknown {
	const trimmed = value.trim();
	if (/^new\s+HashMap<.*?>\s*\(\)$/.test(trimmed)) {
		return {};
	}
	const block =
		/^new\s+HashMap<.*?>\s*\(\)\s*\{\s*\{?\s*(.*?)\s*\}?\s*\}$/s.exec(trimmed);
	if (block == null) {
		return value;
	}
	const parsed: Record<string, unknown> = {};
	for (const match of (block[1] ?? "").matchAll(/put\("([^"]+)",\s*(.*?)\)/g)) {
		parsed[match[1] ?? ""] = parseJavaScalar(match[2] ?? "");
	}
	return parsed;
}

function parseJavaScalar(value: string, nestedType?: string): unknown {
	const trimmed = value.trim();
	if (nestedType === "String" || nestedType === "char") {
		return stripQuotes(trimmed) ?? trimmed;
	}
	if (nestedType != null && javaConvertibleTypes.has(nestedType)) {
		return convertJavaValue(trimmed, nestedType);
	}
	if (trimmed === "true" || trimmed === "false") {
		return trimmed === "true";
	}
	const quoted = stripQuotes(trimmed);
	if (quoted != null) {
		return quoted;
	}
	if (/^-?\d+[lL]$/.test(trimmed)) {
		return Number.parseInt(trimmed.slice(0, -1), 10);
	}
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?[fF]$/.test(trimmed)) {
		return Number.parseFloat(trimmed.replace(/[fF]$/, ""));
	}
	if (/^-?\d+$/.test(trimmed)) {
		return Number.parseInt(trimmed, 10);
	}
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
		return Number.parseFloat(trimmed);
	}
	return trimmed;
}

function convertJsValue(
	value: string,
	expectedType: string,
	nestedType?: string,
): unknown {
	switch (expectedType) {
		case "String":
			return stripQuotes(value.trim()) ?? String(value);
		case "integer":
			return /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : String(value);
		case "float":
			return /^-?\d+(\.\d+)?$/.test(value)
				? Number.parseFloat(value)
				: String(value);
		case "Bigint":
			return /^-?\d+n$/.test(value)
				? Number.parseInt(value.slice(0, -1), 10)
				: String(value);
		case "Boolean":
			return value === "true" || value === "false"
				? value === "true"
				: String(value);
		case "array":
			return parseJsArray(value, nestedType);
		case "dict":
			return parseJsObject(value);
		case "any":
			return String(value);
		default:
			return value;
	}
}

function parseJsArray(value: string, nestedType?: string): unknown {
	const trimmed = value.trim();
	const bracketMatch = /^\[(.*)\]$/.exec(trimmed);
	const newArrayMatch = /^new\s+Array\((.*)\)$/.exec(trimmed);
	const body = bracketMatch?.[1] ?? newArrayMatch?.[1];
	if (body == null) {
		return value;
	}
	return body.trim().length === 0
		? []
		: splitTopLevel(body).map((entry) => parseJsScalar(entry, nestedType));
}

function parseJsObject(value: string): unknown {
	const match = /^\{(.*)\}$/.exec(value.trim());
	if (match == null) {
		return value;
	}
	const parsed: Record<string, unknown> = {};
	for (const pair of splitTopLevel(match[1] ?? "")) {
		const separator = topLevelSeparatorIndex(pair, ":");
		if (separator === -1) {
			return value;
		}
		const rawKey = pair.slice(0, separator).trim();
		const key =
			stripQuotes(rawKey) ??
			(/^[A-Za-z_$][\w$]*$/.test(rawKey) ? rawKey : undefined);
		if (key == null) {
			return value;
		}
		parsed[key] = parseJsScalar(pair.slice(separator + 1).trim());
	}
	return parsed;
}

function parseJsScalar(value: string, nestedType?: string): unknown {
	const trimmed = value.trim();
	if (nestedType != null && jsConvertibleTypes.has(nestedType)) {
		return convertJsValue(trimmed, nestedType);
	}
	if (trimmed === "true" || trimmed === "false") {
		return trimmed === "true";
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return parseJsArray(trimmed);
	}
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return parseJsObject(trimmed);
	}
	const quoted = stripQuotes(trimmed);
	if (quoted != null) {
		return quoted;
	}
	if (/^-?\d+n$/.test(trimmed)) {
		return Number.parseInt(trimmed.slice(0, -1), 10);
	}
	if (/^-?\d+$/.test(trimmed)) {
		return Number.parseInt(trimmed, 10);
	}
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return Number.parseFloat(trimmed);
	}
	return trimmed;
}

function splitTopLevel(input: string): string[] {
	const values: string[] = [];
	let start = 0;
	let quote: string | undefined;
	let depth = 0;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (quote != null) {
			if (char === quote && input[index - 1] !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "[" || char === "{" || char === "(") {
			depth += 1;
			continue;
		}
		if (char === "]" || char === "}" || char === ")") {
			depth -= 1;
			continue;
		}
		if (char === "," && depth === 0) {
			values.push(input.slice(start, index).trim());
			start = index + 1;
		}
	}
	const finalValue = input.slice(start).trim();
	if (finalValue.length > 0) {
		values.push(finalValue);
	}
	return values;
}

function topLevelSeparatorIndex(input: string, separator: string): number {
	let quote: string | undefined;
	let depth = 0;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (quote != null) {
			if (char === quote && input[index - 1] !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "[" || char === "{" || char === "(") {
			depth += 1;
			continue;
		}
		if (char === "]" || char === "}" || char === ")") {
			depth -= 1;
			continue;
		}
		if (char === separator && depth === 0) {
			return index;
		}
	}
	return -1;
}

function stripQuotes(value: string): string | undefined {
	return (value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
		? value.slice(1, -1)
		: undefined;
}

export const __privateForTests = {
	convertJavaValue,
	convertActualValue,
	convertJsValue,
	readFunctionSchemas,
	splitTopLevel,
	topLevelSeparatorIndex,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}
