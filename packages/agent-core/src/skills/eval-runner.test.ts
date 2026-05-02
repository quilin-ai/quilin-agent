import { describe, expect, it } from "vitest";
import {
	runSkillTriggerEval,
	scoreSkillTriggerQuality,
} from "./eval-runner.js";
import type { SkillTriggerEvalCase } from "./types.js";

const cases: readonly SkillTriggerEvalCase[] = [
	{
		id: "research",
		input: "Research the latest browser automation release",
		expectedSkillNames: ["web-research"],
	},
	{
		id: "local",
		input: "Summarize this local file",
		expectedSkillNames: ["local-analysis"],
	},
];

describe("runSkillTriggerEval", () => {
	it("passes when selected skills meet precision and recall thresholds", () => {
		const report = runSkillTriggerEval({
			cases,
			minPrecision: 1,
			minRecall: 1,
			selectSkillNames: (testCase) =>
				testCase.id === "research" ? ["web-research"] : ["local-analysis"],
		});

		expect(report.passed).toBe(true);
		expect(report.metrics).toEqual({ precision: 1, recall: 1 });
		expect(report.quality).toEqual({
			score: 1,
			precision: 1,
			recall: 1,
			band: "excellent",
		});
		expect(report.totals).toEqual({
			truePositives: 2,
			falsePositives: 0,
			falseNegatives: 0,
		});
		expect(report.cases.every((testCase) => testCase.passed)).toBe(true);
	});

	it("fails when false positives pull precision below the threshold", () => {
		const report = runSkillTriggerEval({
			cases: [cases[0] as SkillTriggerEvalCase],
			minPrecision: 0.75,
			minRecall: 1,
			selectSkillNames: () => ["web-research", "browser-debug"],
		});

		expect(report.passed).toBe(false);
		expect(report.metrics.precision).toBe(0.5);
		expect(report.metrics.recall).toBe(1);
		expect(report.quality.score).toBeCloseTo(2 / 3);
		expect(report.quality.band).toBe("needs_improvement");
		expect(report.cases[0]?.falsePositives).toEqual(["browser-debug"]);
	});

	it("fails when missed expected skills pull recall below the threshold", () => {
		const report = runSkillTriggerEval({
			cases: [cases[1] as SkillTriggerEvalCase],
			minPrecision: 1,
			minRecall: 0.8,
			selectSkillNames: () => [],
		});

		expect(report.passed).toBe(false);
		expect(report.metrics.precision).toBe(1);
		expect(report.metrics.recall).toBe(0);
		expect(report.quality).toEqual({
			score: 0,
			precision: 1,
			recall: 0,
			band: "poor",
		});
		expect(report.cases[0]?.falseNegatives).toEqual(["local-analysis"]);
	});

	it("deduplicates and sorts selected and expected skill names deterministically", () => {
		const report = runSkillTriggerEval({
			cases: [
				{
					id: "stable-order",
					input: "Analyze and research",
					expectedSkillNames: [
						"web-research",
						"local-analysis",
						"web-research",
					],
				},
			],
			selectSkillNames: () => [
				"web-research",
				"local-analysis",
				"web-research",
			],
		});

		expect(report.cases[0]?.selectedSkillNames).toEqual([
			"local-analysis",
			"web-research",
		]);
		expect(report.cases[0]?.expectedSkillNames).toEqual([
			"local-analysis",
			"web-research",
		]);
	});

	it("fails empty eval suites instead of reporting perfect trigger quality", () => {
		const report = runSkillTriggerEval({
			cases: [],
			selectSkillNames: () => ["web-research"],
		});

		expect(report.passed).toBe(false);
		expect(report.metrics).toEqual({ precision: 0, recall: 0 });
		expect(report.quality).toEqual({
			score: 0,
			precision: 0,
			recall: 0,
			band: "poor",
		});
		expect(report.totals).toEqual({
			truePositives: 0,
			falsePositives: 0,
			falseNegatives: 0,
		});
		expect(report.cases).toEqual([]);
	});

	it("fails all-negative suites because recall coverage is unproven", () => {
		const report = runSkillTriggerEval({
			cases: [
				{
					id: "negative",
					input: "Just say hello",
					expectedSkillNames: [],
				},
			],
			selectSkillNames: () => [],
		});

		expect(report.passed).toBe(false);
		expect(report.metrics).toEqual({ precision: 1, recall: 0 });
		expect(report.quality).toEqual({
			score: 0,
			precision: 1,
			recall: 0,
			band: "poor",
		});
	});

	it("scores trigger quality into stable bands", () => {
		expect(
			scoreSkillTriggerQuality({
				truePositives: 3,
				falsePositives: 0,
				falseNegatives: 1,
			}),
		).toEqual({
			score: 0.8571428571428571,
			precision: 1,
			recall: 0.75,
			band: "good",
		});
		expect(
			scoreSkillTriggerQuality({
				truePositives: 1,
				falsePositives: 2,
				falseNegatives: 1,
			}).band,
		).toBe("poor");
	});
});
