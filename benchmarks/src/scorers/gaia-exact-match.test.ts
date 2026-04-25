import { describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../wire/task.js";
import {
	GAIA_EXACT_MATCH_SCORER_TYPE,
	gaiaExactMatchScorer,
	normalizeGaiaAnswer,
} from "./gaia-exact-match.js";

const task = {
	task_id: "gaia-1",
	dataset: "gaia",
	inputs: {},
	expected: { final_answer: "New York City" },
	scorer_type: GAIA_EXACT_MATCH_SCORER_TYPE,
} satisfies BenchmarkTask;

describe("gaiaExactMatchScorer", () => {
	it.each([
		["case", "ALPHA", "alpha"],
		["whitespace", "  alpha\t beta\n gamma  ", "alpha beta gamma"],
		["basic edge punctuation", "!!! Alpha, beta.???", "alpha, beta"],
	])("normalizes %s", (_caseName, input, expected) => {
		expect(normalizeGaiaAnswer(input)).toBe(expected);
	});

	it("passes when model_answer quasi-exactly matches final_answer", async () => {
		await expect(
			gaiaExactMatchScorer(task, { model_answer: "  new\tYORK city!!! " }),
		).resolves.toEqual({
			passed: true,
			score: 1,
			details: {
				scorer_type: GAIA_EXACT_MATCH_SCORER_TYPE,
				expected_normalized: "new york city",
				model_answer_normalized: "new york city",
			},
		});
	});

	it("uses output.answer when model_answer is absent", async () => {
		await expect(
			gaiaExactMatchScorer(task, { answer: "...New York City..." }),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
	});

	it.each([
		["number", 42, "42"],
		["boolean", true, "true"],
	])("accepts %s final_answer values", async (_caseName, finalAnswer, answer) => {
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: finalAnswer } },
				{ model_answer: answer },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
	});

	it("fails when answers do not match", async () => {
		await expect(
			gaiaExactMatchScorer(task, { model_answer: "Boston" }),
		).resolves.toEqual({
			passed: false,
			score: 0,
			details: {
				scorer_type: GAIA_EXACT_MATCH_SCORER_TYPE,
				expected_normalized: "new york city",
				model_answer_normalized: "boston",
				reason: "answer_mismatch",
			},
		});
	});

	const failureCases: ReadonlyArray<{
		readonly caseName: string;
		readonly task?: BenchmarkTask;
		readonly output: Record<string, unknown>;
		readonly reason: string;
	}> = [
		{
			caseName: "missing output answer",
			output: {},
			reason: "missing_model_answer",
		},
		{
			caseName: "non-string output answer",
			output: { model_answer: 42 },
			reason: "missing_model_answer",
		},
		{
			caseName: "missing final_answer",
			task: { ...task, expected: {} },
			output: { model_answer: "anything" },
			reason: "missing_expected_final_answer",
		},
		{
			caseName: "object final_answer",
			task: { ...task, expected: { final_answer: { text: "answer" } } },
			output: { model_answer: "answer" },
			reason: "missing_expected_final_answer",
		},
	];

	it.each(failureCases)("fails for $caseName", async (fixture) => {
		await expect(
			gaiaExactMatchScorer(fixture.task ?? task, fixture.output),
		).resolves.toMatchObject({
			passed: false,
			score: 0,
			details: {
				scorer_type: GAIA_EXACT_MATCH_SCORER_TYPE,
				reason: fixture.reason,
			},
		});
	});
});
