import type {
	SkillTriggerEvalCase,
	SkillTriggerEvalCaseResult,
	SkillTriggerEvalReport,
	SkillTriggerQualityBand,
	SkillTriggerQualityScore,
} from "./types.js";

export interface SkillTriggerQualityCounts {
	readonly truePositives: number;
	readonly falsePositives: number;
	readonly falseNegatives: number;
}

export interface RunSkillTriggerEvalOptions {
	readonly cases: readonly SkillTriggerEvalCase[];
	readonly selectSkillNames: (
		testCase: SkillTriggerEvalCase,
	) => readonly string[];
	readonly minPrecision?: number;
	readonly minRecall?: number;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
	return Array.from(new Set(values)).sort();
}

function intersection(
	left: readonly string[],
	right: ReadonlySet<string>,
): readonly string[] {
	return left.filter((value) => right.has(value));
}

function difference(
	left: readonly string[],
	right: ReadonlySet<string>,
): readonly string[] {
	return left.filter((value) => !right.has(value));
}

function divideOrPerfect(numerator: number, denominator: number): number {
	if (denominator === 0) {
		return 1;
	}

	return numerator / denominator;
}

function f1Score(precision: number, recall: number): number {
	if (precision === 0 && recall === 0) {
		return 0;
	}

	return (2 * precision * recall) / (precision + recall);
}

function qualityBand(score: number): SkillTriggerQualityBand {
	if (score >= 0.9) {
		return "excellent";
	}
	if (score >= 0.75) {
		return "good";
	}
	if (score >= 0.5) {
		return "needs_improvement";
	}

	return "poor";
}

export function scoreSkillTriggerQuality(
	counts: SkillTriggerQualityCounts,
): SkillTriggerQualityScore {
	const precision = divideOrPerfect(
		counts.truePositives,
		counts.truePositives + counts.falsePositives,
	);
	const recall = divideOrPerfect(
		counts.truePositives,
		counts.truePositives + counts.falseNegatives,
	);
	const score = f1Score(precision, recall);

	return {
		score,
		precision,
		recall,
		band: qualityBand(score),
	};
}

function evaluateCase(
	testCase: SkillTriggerEvalCase,
	selectSkillNames: (testCase: SkillTriggerEvalCase) => readonly string[],
): SkillTriggerEvalCaseResult {
	const selectedSkillNames = uniqueSorted(selectSkillNames(testCase));
	const expectedSkillNames = uniqueSorted(testCase.expectedSkillNames);
	const selected = new Set(selectedSkillNames);
	const expected = new Set(expectedSkillNames);
	const truePositives = intersection(selectedSkillNames, expected);
	const falsePositives = difference(selectedSkillNames, expected);
	const falseNegatives = difference(expectedSkillNames, selected);
	const quality = scoreSkillTriggerQuality({
		truePositives: truePositives.length,
		falsePositives: falsePositives.length,
		falseNegatives: falseNegatives.length,
	});

	return {
		id: testCase.id,
		selectedSkillNames,
		expectedSkillNames,
		truePositives,
		falsePositives,
		falseNegatives,
		precision: quality.precision,
		recall: quality.recall,
		quality,
		passed: falsePositives.length === 0 && falseNegatives.length === 0,
	};
}

export function runSkillTriggerEval(
	options: RunSkillTriggerEvalOptions,
): SkillTriggerEvalReport {
	const minPrecision = options.minPrecision ?? 1;
	const minRecall = options.minRecall ?? 1;
	const cases = options.cases.map((testCase) =>
		evaluateCase(testCase, options.selectSkillNames),
	);
	const hasCases = cases.length > 0;
	const totals = cases.reduce(
		(accumulator, testCase) => ({
			truePositives: accumulator.truePositives + testCase.truePositives.length,
			falsePositives:
				accumulator.falsePositives + testCase.falsePositives.length,
			falseNegatives:
				accumulator.falseNegatives + testCase.falseNegatives.length,
		}),
		{ truePositives: 0, falsePositives: 0, falseNegatives: 0 },
	);
	const quality = hasCases
		? scoreSkillTriggerQuality(totals)
		: {
				score: 0,
				precision: 0,
				recall: 0,
				band: "poor" as const,
			};
	const { precision, recall } = quality;

	return {
		schemaVersion: "quilin.skill_trigger_eval.v1",
		cases,
		totals,
		metrics: {
			precision,
			recall,
		},
		quality,
		thresholds: {
			minPrecision,
			minRecall,
		},
		passed: hasCases && precision >= minPrecision && recall >= minRecall,
	};
}
