import type { Scorer, ScorerResult } from "./types.js";

export const GAIA_EXACT_MATCH_SCORER_TYPE = "gaia-exact-match";

type GaiaExpected = {
	readonly final_answer?: unknown;
};

export const gaiaExactMatchScorer: Scorer = async (task, output) => {
	const expected = expectedFinalAnswer(task.expected as GaiaExpected);

	if (expected == null) {
		return failedResult("missing_expected_final_answer");
	}

	const candidate = candidateAnswer(output);

	if (candidate == null) {
		return failedResult("missing_model_answer", {
			expected_normalized: normalizeGaiaAnswer(expected),
		});
	}

	const expectedNormalized = normalizeGaiaAnswer(expected);
	const candidateNormalized = normalizeGaiaAnswer(candidate);
	const passed = questionScorer(candidate, expected);

	return {
		passed,
		score: passed ? 1 : 0,
		details: {
			scorer_type: GAIA_EXACT_MATCH_SCORER_TYPE,
			expected_normalized: expectedNormalized,
			model_answer_normalized: candidateNormalized,
			...(passed ? {} : { reason: "answer_mismatch" }),
		},
	};
};

export function normalizeGaiaAnswer(value: string): string {
	return normalizeString(value);
}

function candidateAnswer(output: Record<string, unknown>): string | undefined {
	const value = output.model_answer;

	if (typeof value === "string") {
		return value;
	}

	return undefined;
}

function questionScorer(modelAnswer: string, groundTruth: string): boolean {
	const groundTruthNumber = parsePythonFloat(groundTruth);
	if (groundTruthNumber !== undefined) {
		const modelAnswerNumber = normalizeNumberString(modelAnswer);
		return (
			modelAnswerNumber !== undefined && modelAnswerNumber === groundTruthNumber
		);
	}

	if (groundTruth.includes(",") || groundTruth.includes(";")) {
		const groundTruthElements = splitAnswerList(groundTruth);
		const modelAnswerElements = splitAnswerList(modelAnswer);
		if (groundTruthElements.length !== modelAnswerElements.length) {
			return false;
		}
		return groundTruthElements.every((groundTruthElement, index) => {
			const modelAnswerElement = modelAnswerElements[index] as string;
			const groundTruthElementNumber = parsePythonFloat(groundTruthElement);
			if (groundTruthElementNumber !== undefined) {
				const modelAnswerElementNumber =
					normalizeNumberString(modelAnswerElement);
				return (
					modelAnswerElementNumber !== undefined &&
					modelAnswerElementNumber === groundTruthElementNumber
				);
			}
			return (
				normalizeString(modelAnswerElement, { removePunctuation: false }) ===
				normalizeString(groundTruthElement, { removePunctuation: false })
			);
		});
	}

	return normalizeString(modelAnswer) === normalizeString(groundTruth);
}

function normalizeNumberString(value: string): number | undefined {
	const normalized = value
		.replaceAll("$", "")
		.replaceAll("%", "")
		.replaceAll(",", "");
	return parsePythonFloat(normalized);
}

function splitAnswerList(value: string): string[] {
	return value.split(/[,;]/);
}

function normalizeString(
	value: string,
	options: { readonly removePunctuation?: boolean } = {},
): string {
	const withoutWhitespace = value.replace(/\s/g, "").toLowerCase();
	if (options.removePunctuation === false) {
		return withoutWhitespace;
	}
	return withoutWhitespace.replace(
		/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g,
		"",
	);
}

function parsePythonFloat(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const normalized = trimmed.toLowerCase();
	if (/^[+-]?nan$/.test(normalized)) {
		return Number.NaN;
	}
	if (/^[+-]?(?:inf|infinity)$/.test(normalized)) {
		return normalized.startsWith("-")
			? Number.NEGATIVE_INFINITY
			: Number.POSITIVE_INFINITY;
	}
	if (
		!/^[+-]?(?:(?:\p{Nd}(?:_?\p{Nd})*)(?:\.(?:\p{Nd}(?:_?\p{Nd})*)?)?|\.(?:\p{Nd}(?:_?\p{Nd})*))(?:[eE][+-]?(?:\p{Nd}(?:_?\p{Nd})*))?$/u.test(
			trimmed,
		)
	) {
		return undefined;
	}
	const parsed = Number(foldUnicodeDecimalDigits(trimmed).replaceAll("_", ""));
	return Number.isNaN(parsed) ? undefined : parsed;
}

function foldUnicodeDecimalDigits(value: string): string {
	return Array.from(value, (char) => {
		if (!/\p{Nd}/u.test(char)) {
			return char;
		}
		const digit = unicodeDecimalDigitValue(char);
		return digit == null ? char : String(digit);
	}).join("");
}

function unicodeDecimalDigitValue(char: string): number | undefined {
	const codePoint = char.codePointAt(0) as number;
	for (const zeroCodePoint of unicodeDecimalZeroCodePoints) {
		const digit = codePoint - zeroCodePoint;
		if (digit >= 0 && digit <= 9) {
			return digit;
		}
	}
	return undefined;
}

const unicodeDecimalZeroCodePoints = [
	0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
	0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
	0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
	0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
	0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0,
	0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50,
	0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8,
	0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950, 0x1fbf0,
] as const;

function expectedFinalAnswer(expected: GaiaExpected): string | undefined {
	const finalAnswer = expected.final_answer;

	if (
		typeof finalAnswer === "string" ||
		typeof finalAnswer === "number" ||
		typeof finalAnswer === "boolean"
	) {
		return String(finalAnswer);
	}

	return undefined;
}

function failedResult(
	reason: string,
	details: Record<string, unknown> = {},
): ScorerResult {
	return {
		passed: false,
		score: 0,
		details: {
			scorer_type: GAIA_EXACT_MATCH_SCORER_TYPE,
			...details,
			reason,
		},
	};
}
