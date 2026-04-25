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
	const passed = candidateNormalized === expectedNormalized;

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
	return value
		.toLowerCase()
		.trim()
		.replace(/\s+/g, " ")
		.replace(/^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+/g, "")
		.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/g, "")
		.trim();
}

function candidateAnswer(output: Record<string, unknown>): string | undefined {
	for (const key of ["model_answer", "answer"] as const) {
		const value = output[key];

		if (typeof value === "string") {
			return value;
		}
	}

	return undefined;
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
