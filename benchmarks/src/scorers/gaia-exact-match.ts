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
		return normalizeNumberString(modelAnswer) === groundTruthNumber;
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
				return (
					normalizeNumberString(modelAnswerElement) === groundTruthElementNumber
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

function normalizeNumberString(value: string): number {
	const normalized = value
		.replaceAll("$", "")
		.replaceAll("%", "")
		.replaceAll(",", "");
	return parsePythonFloat(normalized) ?? Number.POSITIVE_INFINITY;
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
		!/^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.(?:\d(?:_?\d)*))(?:[eE][+-]?(?:\d(?:_?\d)*))?$/.test(
			trimmed,
		)
	) {
		return undefined;
	}
	const parsed = Number(trimmed.replaceAll("_", ""));
	return Number.isNaN(parsed) ? undefined : parsed;
}

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
