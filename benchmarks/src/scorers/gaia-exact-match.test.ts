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
		["whitespace", "  alpha\t beta\n gamma  ", "alphabetagamma"],
		["punctuation", "!!! Alpha, beta.???", "alphabeta"],
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
				expected_normalized: "newyorkcity",
				model_answer_normalized: "newyorkcity",
			},
		});
	});

	it("removes internal whitespace and punctuation like the official string scorer", async () => {
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "seagull" } },
				{ model_answer: "sea gull!!!" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
	});

	it("scores numeric answers with the official currency, percent, and comma cleanup", async () => {
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "1000" } },
				{ model_answer: "$1,000%" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "1_000" } },
				{ model_answer: "$1_000%" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "42" } },
				{ model_answer: "not-a-number" },
			),
		).resolves.toMatchObject({
			passed: false,
			score: 0,
		});
	});

	it("does not let unparsable numeric answers collide with infinity", async () => {
		for (const finalAnswer of ["inf", "Infinity", "+infinity"]) {
			await expect(
				gaiaExactMatchScorer(
					{ ...task, expected: { final_answer: finalAnswer } },
					{ model_answer: "not-a-number" },
				),
			).resolves.toMatchObject({
				passed: false,
				score: 0,
			});
		}
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "ok, inf" } },
				{ model_answer: "ok, garbage" },
			),
		).resolves.toMatchObject({
			passed: false,
			score: 0,
		});
	});

	it("matches Python float() for Unicode decimal digits and invalid underscores", async () => {
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "１２٣" } },
				{ model_answer: "123" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "١.٥e+١٠" } },
				{ model_answer: "1.5e+10" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		for (const finalAnswer of ["1_", "_1"]) {
			await expect(
				gaiaExactMatchScorer(
					{ ...task, expected: { final_answer: finalAnswer } },
					{ model_answer: "1" },
				),
			).resolves.toMatchObject({
				passed: true,
				score: 1,
			});
		}
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "1__0" } },
				{ model_answer: "2" },
			),
		).resolves.toMatchObject({
			passed: false,
			score: 0,
		});
		for (const finalAnswer of ["", "+"]) {
			await expect(
				gaiaExactMatchScorer(
					{ ...task, expected: { final_answer: finalAnswer } },
					{ model_answer: "1" },
				),
			).resolves.toMatchObject({
				passed: false,
				score: 0,
			});
		}
	});

	it("does not treat JavaScript-only numeric syntax as official Python floats", async () => {
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "0x10" } },
				{ model_answer: "16" },
			),
		).resolves.toMatchObject({
			passed: false,
			score: 0,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "0x10" } },
				{ model_answer: "0x10" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
	});

	it("scores comma and semicolon separated lists element by element", async () => {
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "Paris; 42, Dr. King" } },
				{ model_answer: " paris ; $42, dr. king" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "Paris; Rome" } },
				{ model_answer: "Paris" },
			),
		).resolves.toMatchObject({
			passed: false,
			score: 0,
		});
	});

	it("keeps official edge behavior for empty, nan, and infinity numeric values", async () => {
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "Paris," } },
				{ model_answer: "Paris," },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "nan" } },
				{ model_answer: "nan" },
			),
		).resolves.toMatchObject({
			passed: false,
			score: 0,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "-inf" } },
				{ model_answer: "-infinity" },
			),
		).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		await expect(
			gaiaExactMatchScorer(
				{ ...task, expected: { final_answer: "inf" } },
				{ model_answer: "+infinity" },
			),
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
				expected_normalized: "newyorkcity",
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
			caseName: "legacy answer alias",
			output: { answer: "New York City" },
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
