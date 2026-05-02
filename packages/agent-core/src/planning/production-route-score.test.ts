import { describe, expect, it } from "vitest";
import type {
	ProductionRouteScore,
	ProductionRouteScoreBatch,
	ProductionRouteScoreExplanation,
} from "./index.js";
import {
	classifyProductionRouteScoreBatchReadiness,
	explainProductionRoute,
	scoreProductionRoute,
	scoreProductionRoutes,
	summarizeProductionRouteExplanations,
	summarizeProductionRouteScoreBatchReadiness,
	summarizeProductionRouteScores,
} from "./index.js";

describe("scoreProductionRoute", () => {
	it("recommends supervisor handoff for high-risk tasks", () => {
		const result = scoreProductionRoute({
			taskRisk: "high",
			complexity: 0.1,
			cost: 0.1,
			capabilityFit: 0.95,
		});

		expect(result.handoffRecommendation).toBe("handoff_to_supervisor");
		expect(result.score).toBeGreaterThanOrEqual(result.threshold);
		expect(result.reasonCodes).toContain("task_risk_high_supervisor");
		expect(result.reasonCodes).toContain("risk_requires_supervisor_handoff");
		expect(result.reasonCodes).toContain("recommend_handoff_to_supervisor");
		expect(result.explanation).toEqual({
			score: 61,
			threshold: 60,
			scoreBand: "high",
			selectedRoute: {
				route: "handoff_to_supervisor",
				reasonCodes: [
					"risk_requires_supervisor_handoff",
					"score_above_threshold",
					"recommend_handoff_to_supervisor",
				],
			},
			normalizedFactors: {
				taskRisk: "high",
				taskRiskScore: 90,
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
				capabilityGap: 0.05,
				nonBlockingSupervisorRequired: false,
			},
		});
	});

	it("returns an explainable score breakdown for deterministic calibration", () => {
		const result = scoreProductionRoute({
			taskRisk: "medium",
			complexity: 0.4,
			cost: 0.2,
			capabilityFit: 0.75,
		});

		expect(result.scoreBreakdown).toEqual({
			taskRisk: 39,
			complexity: 6,
			cost: 1,
			capabilityGap: 3.75,
			nonBlockingSupervisorBonus: 0,
		});
		expect(result.score).toBe(50);
		expect(result.threshold).toBe(60);
		expect(result.handoffRecommendation).toBe("keep_local");
		expect(result.explanation.scoreBand).toBe("medium");
		expect(result.explanation.selectedRoute).toEqual({
			route: "keep_local",
			reasonCodes: ["score_below_threshold", "recommend_keep_local"],
		});
	});

	it("keeps low-risk, low-complexity, strong-fit tasks local", () => {
		const result = scoreProductionRoute({
			taskRisk: "low",
			complexity: 0.2,
			cost: 0.2,
			capabilityFit: 0.95,
		});

		expect(result.score).toBeLessThan(result.threshold);
		expect(result.handoffRecommendation).toBe("keep_local");
		expect(result.reasonCodes).toEqual([
			"task_risk_low_local",
			"complexity_low_local",
			"cost_low_local",
			"capability_fit_strong_local",
			"score_below_threshold",
			"recommend_keep_local",
		]);
		expect(result.explanation.scoreBand).toBe("low");
		expect(result.explanation.normalizedFactors).toEqual({
			taskRisk: "low",
			taskRiskScore: 15,
			complexity: 0.2,
			cost: 0.2,
			capabilityFit: 0.95,
			capabilityGap: 0.05,
			nonBlockingSupervisorRequired: false,
		});
	});

	it("honors explicit supervisor handoff thresholds at the boundary", () => {
		const input = {
			taskRisk: "medium" as const,
			complexity: 0,
			cost: 0,
			capabilityFit: 1,
		};

		expect(
			scoreProductionRoute(input, {
				supervisorHandoffThreshold: 39,
			}).handoffRecommendation,
		).toBe("handoff_to_supervisor");
		expect(
			scoreProductionRoute(input, {
				supervisorHandoffThreshold: 40,
			}).handoffRecommendation,
		).toBe("keep_local");
		expect(
			explainProductionRoute(input, {
				supervisorHandoffThreshold: 39,
			}).scoreBand,
		).toBe("high");
		expect(
			explainProductionRoute(input, {
				supervisorHandoffThreshold: 40,
			}).scoreBand,
		).toBe("medium");
	});

	it("uses conservative defaults when route signals are missing", () => {
		const result = scoreProductionRoute({});

		expect(result.score).toBeGreaterThanOrEqual(result.threshold);
		expect(result.handoffRecommendation).toBe("handoff_to_supervisor");
		expect(result.reasonCodes).toEqual([
			"missing_task_risk_default_medium",
			"task_risk_medium_monitor",
			"missing_complexity_default_conservative",
			"complexity_medium",
			"missing_cost_default_conservative",
			"cost_medium",
			"missing_capability_fit_default_conservative",
			"capability_fit_weak_supervisor",
			"score_above_threshold",
			"recommend_handoff_to_supervisor",
		]);
		expect(result.explanation.normalizedFactors).toEqual({
			taskRisk: "medium",
			taskRiskScore: 60,
			complexity: 0.65,
			cost: 0.65,
			capabilityFit: 0.35,
			capabilityGap: 0.65,
			nonBlockingSupervisorRequired: false,
		});
	});

	it("returns a stable explanation shape and selected route reason ordering", () => {
		const explanation: ProductionRouteScoreExplanation = explainProductionRoute(
			{
				taskRisk: "critical",
				complexity: 0.8,
				cost: 0.8,
				capabilityFit: 0.1,
				nonBlockingSupervisorRequired: true,
			},
		);

		expect(Object.keys(explanation)).toEqual([
			"score",
			"threshold",
			"scoreBand",
			"selectedRoute",
			"normalizedFactors",
		]);
		expect(Object.keys(explanation.selectedRoute)).toEqual([
			"route",
			"reasonCodes",
		]);
		expect(Object.keys(explanation.normalizedFactors)).toEqual([
			"taskRisk",
			"taskRiskScore",
			"complexity",
			"cost",
			"capabilityFit",
			"capabilityGap",
			"nonBlockingSupervisorRequired",
		]);
		expect(explanation.selectedRoute).toEqual({
			route: "handoff_to_supervisor",
			reasonCodes: [
				"non_blocking_supervisor_required",
				"risk_requires_supervisor_handoff",
				"score_above_threshold",
				"recommend_handoff_to_supervisor",
			],
		});
		expect(explanation.score).toBe(100);
	});

	it("rejects invalid normalized route signals", () => {
		expect(() => scoreProductionRoute({ complexity: 1.1 })).toThrow(
			"complexity must be a finite number between 0 and 1",
		);
		expect(() => scoreProductionRoute({ complexity: -0.1 })).toThrow(
			"complexity must be a finite number between 0 and 1",
		);
		expect(() => scoreProductionRoute({ cost: 2 })).toThrow(
			"cost must be a finite number between 0 and 1",
		);
		expect(() => scoreProductionRoute({ capabilityFit: Number.NaN })).toThrow(
			"capabilityFit must be a finite number between 0 and 1",
		);
		expect(() => scoreProductionRoute({ taskRisk: "severe" as never })).toThrow(
			"taskRisk must be a known delegation risk level",
		);
		expect(() =>
			scoreProductionRoute({
				nonBlockingSupervisorRequired: "true" as never,
			}),
		).toThrow("nonBlockingSupervisorRequired must be a boolean");
		expect(() =>
			scoreProductionRoute(
				{},
				{
					supervisorHandoffThreshold: 101,
				},
			),
		).toThrow(
			"supervisorHandoffThreshold must be a finite number between 0 and 100",
		);
	});
});

describe("summarizeProductionRouteExplanations", () => {
	it("returns a stable empty summary", () => {
		expect(summarizeProductionRouteExplanations([])).toEqual({
			total: 0,
			byBand: {
				low: 0,
				medium: 0,
				high: 0,
			},
			bySelectedRoute: {
				keep_local: 0,
				handoff_to_supervisor: 0,
			},
			byReasonCode: {},
			highestRisk: null,
			lowestScore: null,
		});
	});

	it("summarizes mixed low, medium, and high route explanations", () => {
		const summary = summarizeProductionRouteExplanations([
			explainProductionRoute({
				taskRisk: "low",
				complexity: 0.2,
				cost: 0.2,
				capabilityFit: 0.95,
			}),
			explainProductionRoute({
				taskRisk: "medium",
				complexity: 0.4,
				cost: 0.2,
				capabilityFit: 0.75,
			}),
			explainProductionRoute({
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			}),
		]);

		expect(summary).toEqual({
			total: 3,
			byBand: {
				low: 1,
				medium: 1,
				high: 1,
			},
			bySelectedRoute: {
				keep_local: 2,
				handoff_to_supervisor: 1,
			},
			byReasonCode: {
				risk_requires_supervisor_handoff: 1,
				score_above_threshold: 1,
				score_below_threshold: 2,
				recommend_handoff_to_supervisor: 1,
				recommend_keep_local: 2,
			},
			highestRisk: {
				index: 2,
				score: 61,
				scoreBand: "high",
				selectedRoute: "handoff_to_supervisor",
				taskRisk: "high",
			},
			lowestScore: {
				index: 0,
				score: 15,
				scoreBand: "low",
				selectedRoute: "keep_local",
				taskRisk: "low",
			},
		});
	});

	it("keeps reason code ordering and tied extrema stable", () => {
		const baseExplanation = explainProductionRoute({
			taskRisk: "safe",
			complexity: 0,
			cost: 0,
			capabilityFit: 1,
			nonBlockingSupervisorRequired: true,
		});
		const explanation: ProductionRouteScoreExplanation = {
			...baseExplanation,
			selectedRoute: {
				route: baseExplanation.selectedRoute.route,
				reasonCodes: [
					"recommend_handoff_to_supervisor",
					"score_below_threshold",
					"non_blocking_supervisor_required",
				],
			},
		};

		const summary = summarizeProductionRouteExplanations([
			explanation,
			explanation,
		]);

		expect(Object.keys(summary.byReasonCode)).toEqual([
			"non_blocking_supervisor_required",
			"score_below_threshold",
			"recommend_handoff_to_supervisor",
		]);
		expect(summary.byReasonCode).toEqual({
			non_blocking_supervisor_required: 2,
			score_below_threshold: 2,
			recommend_handoff_to_supervisor: 2,
		});
		expect(summary.highestRisk?.index).toBe(0);
		expect(summary.lowestScore?.index).toBe(0);
	});

	it("summarizes score band boundaries without recalculating explanations", () => {
		const summary = summarizeProductionRouteExplanations([
			explainProductionRoute(
				{
					taskRisk: "medium",
					complexity: 0,
					cost: 0,
					capabilityFit: 1,
				},
				{ supervisorHandoffThreshold: 39 },
			),
			explainProductionRoute(
				{
					taskRisk: "medium",
					complexity: 0,
					cost: 0,
					capabilityFit: 1,
				},
				{ supervisorHandoffThreshold: 40 },
			),
			explainProductionRoute({
				taskRisk: "safe",
				complexity: 1,
				cost: 0,
				capabilityFit: 0,
			}),
			explainProductionRoute({
				taskRisk: "safe",
				complexity: 0.9,
				cost: 0,
				capabilityFit: 0,
			}),
		]);

		expect(summary.byBand).toEqual({
			low: 1,
			medium: 2,
			high: 1,
		});
		expect(summary.bySelectedRoute).toEqual({
			keep_local: 3,
			handoff_to_supervisor: 1,
		});
		expect(summary.highestRisk).toEqual({
			index: 0,
			score: 39,
			scoreBand: "high",
			selectedRoute: "handoff_to_supervisor",
			taskRisk: "medium",
		});
		expect(summary.lowestScore).toEqual({
			index: 3,
			score: 29,
			scoreBand: "low",
			selectedRoute: "keep_local",
			taskRisk: "safe",
		});
	});
});

describe("summarizeProductionRouteScores", () => {
	it("summarizes full diagnostic reason codes for score objects", () => {
		const scores = [
			scoreProductionRoute({
				taskRisk: "low",
				complexity: 0.2,
				cost: 0.2,
				capabilityFit: 0.95,
			}),
			scoreProductionRoute({
				taskRisk: "medium",
				complexity: 0.4,
				cost: 0.2,
				capabilityFit: 0.75,
			}),
			scoreProductionRoute({
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			}),
		];

		expect(summarizeProductionRouteScores(scores)).toMatchObject({
			byReasonCode: {
				task_risk_low_local: 1,
				task_risk_medium_monitor: 1,
				task_risk_high_supervisor: 1,
				complexity_low_local: 2,
				complexity_medium: 1,
				cost_low_local: 3,
				capability_fit_strong_local: 2,
				capability_fit_partial: 1,
				risk_requires_supervisor_handoff: 1,
				score_above_threshold: 1,
				score_below_threshold: 2,
				recommend_handoff_to_supervisor: 1,
				recommend_keep_local: 2,
			},
		});
	});

	it("returns a stable empty summary", () => {
		expect(summarizeProductionRouteScores([])).toEqual({
			total: 0,
			byBand: {
				low: 0,
				medium: 0,
				high: 0,
			},
			bySelectedRoute: {
				keep_local: 0,
				handoff_to_supervisor: 0,
			},
			byReasonCode: {},
			highestRisk: null,
			lowestScore: null,
		});
	});

	it("keeps deterministic ordering from embedded explanations", () => {
		const baseScore = scoreProductionRoute({
			taskRisk: "safe",
			complexity: 0,
			cost: 0,
			capabilityFit: 1,
			nonBlockingSupervisorRequired: true,
		});
		const score: ProductionRouteScore = {
			...baseScore,
			score: 99,
			handoffRecommendation: "keep_local",
			reasonCodes: ["recommend_keep_local"],
			explanation: {
				...baseScore.explanation,
				selectedRoute: {
					route: baseScore.explanation.selectedRoute.route,
					reasonCodes: [
						"recommend_handoff_to_supervisor",
						"score_below_threshold",
						"non_blocking_supervisor_required",
					],
				},
			},
		};

		const summary = summarizeProductionRouteScores([score, score]);

		expect(Object.keys(summary.byReasonCode)).toEqual(["recommend_keep_local"]);
		expect(summary.byReasonCode).toEqual({
			recommend_keep_local: 2,
		});
		expect(summary.bySelectedRoute).toEqual({
			keep_local: 0,
			handoff_to_supervisor: 2,
		});
		expect(summary.highestRisk?.index).toBe(0);
		expect(summary.lowestScore).toEqual({
			index: 0,
			score: score.explanation.score,
			scoreBand: score.explanation.scoreBand,
			selectedRoute: score.explanation.selectedRoute.route,
			taskRisk: score.explanation.normalizedFactors.taskRisk,
		});
	});
});

describe("scoreProductionRoutes", () => {
	it("returns scores and a stable summary for empty input", () => {
		const batch: ProductionRouteScoreBatch = scoreProductionRoutes([]);

		expect(batch).toEqual({
			scores: [],
			summary: {
				total: 0,
				byBand: {
					low: 0,
					medium: 0,
					high: 0,
				},
				bySelectedRoute: {
					keep_local: 0,
					handoff_to_supervisor: 0,
				},
				byReasonCode: {},
				highestRisk: null,
				lowestScore: null,
			},
		});
	});

	it("scores mixed route inputs and summarizes the resulting routes", () => {
		const inputs = [
			{
				taskRisk: "low",
				complexity: 0.2,
				cost: 0.2,
				capabilityFit: 0.95,
			},
			{
				taskRisk: "medium",
				complexity: 0.4,
				cost: 0.2,
				capabilityFit: 0.75,
			},
			{
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			},
		] as const;

		const batch = scoreProductionRoutes(inputs);

		expect(batch.scores).toEqual(
			inputs.map((input) => scoreProductionRoute(input)),
		);
		expect(batch.summary).toEqual({
			total: 3,
			byBand: {
				low: 1,
				medium: 1,
				high: 1,
			},
			bySelectedRoute: {
				keep_local: 2,
				handoff_to_supervisor: 1,
			},
			byReasonCode: {
				task_risk_low_local: 1,
				task_risk_medium_monitor: 1,
				task_risk_high_supervisor: 1,
				complexity_low_local: 2,
				complexity_medium: 1,
				cost_low_local: 3,
				capability_fit_strong_local: 2,
				capability_fit_partial: 1,
				risk_requires_supervisor_handoff: 1,
				score_above_threshold: 1,
				score_below_threshold: 2,
				recommend_handoff_to_supervisor: 1,
				recommend_keep_local: 2,
			},
			highestRisk: {
				index: 2,
				score: 61,
				scoreBand: "high",
				selectedRoute: "handoff_to_supervisor",
				taskRisk: "high",
			},
			lowestScore: {
				index: 0,
				score: 15,
				scoreBand: "low",
				selectedRoute: "keep_local",
				taskRisk: "low",
			},
		});
	});

	it("applies a shared custom threshold to every route input", () => {
		const inputs = [
			{
				taskRisk: "medium",
				complexity: 0,
				cost: 0,
				capabilityFit: 1,
			},
			{
				taskRisk: "safe",
				complexity: 0.9,
				cost: 0,
				capabilityFit: 0,
			},
		] as const;

		const batch = scoreProductionRoutes(inputs, {
			supervisorHandoffThreshold: 39,
		});

		expect(batch.scores.map((score) => score.threshold)).toEqual([39, 39]);
		expect(batch.scores.map((score) => score.handoffRecommendation)).toEqual([
			"handoff_to_supervisor",
			"keep_local",
		]);
		expect(batch.summary.byBand).toEqual({
			low: 0,
			medium: 1,
			high: 1,
		});
		expect(batch.summary.bySelectedRoute).toEqual({
			keep_local: 1,
			handoff_to_supervisor: 1,
		});
	});

	it("returns the same summary as summarizing its individual scores", () => {
		const batch = scoreProductionRoutes(
			[
				{
					taskRisk: "critical",
					complexity: 0.8,
					cost: 0.8,
					capabilityFit: 0.1,
					nonBlockingSupervisorRequired: true,
				},
				{
					taskRisk: "safe",
					complexity: 0,
					cost: 0,
					capabilityFit: 1,
				},
			],
			{
				supervisorHandoffThreshold: 80,
			},
		);

		expect(batch.summary).toEqual(summarizeProductionRouteScores(batch.scores));
	});
});

describe("classifyProductionRouteScoreBatchReadiness", () => {
	it("classifies an empty batch as empty", () => {
		expect(
			classifyProductionRouteScoreBatchReadiness(scoreProductionRoutes([])),
		).toBe("empty");
	});

	it("classifies batches where every selected route stays local as local-only", () => {
		const batch = scoreProductionRoutes([
			{
				taskRisk: "safe",
				complexity: 0,
				cost: 0,
				capabilityFit: 1,
			},
			{
				taskRisk: "low",
				complexity: 0.2,
				cost: 0.2,
				capabilityFit: 0.95,
			},
		]);

		expect(classifyProductionRouteScoreBatchReadiness(batch)).toBe(
			"local_only",
		);
	});

	it("classifies batches with local and handoff selected routes as mixed", () => {
		const batch = scoreProductionRoutes([
			{
				taskRisk: "low",
				complexity: 0.2,
				cost: 0.2,
				capabilityFit: 0.95,
			},
			{
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			},
		]);

		expect(classifyProductionRouteScoreBatchReadiness(batch)).toBe("mixed");
	});

	it("classifies batches where every selected route needs handoff as handoff-required", () => {
		const batch = scoreProductionRoutes([
			{
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			},
			{
				taskRisk: "critical",
				complexity: 0,
				cost: 0,
				capabilityFit: 1,
			},
		]);

		expect(classifyProductionRouteScoreBatchReadiness(batch)).toBe(
			"handoff_required",
		);
	});

	it("classifies readiness from scores when the batch summary is stale", () => {
		const handoffBatch = scoreProductionRoutes([
			{
				taskRisk: "critical",
				complexity: 0,
				cost: 0,
				capabilityFit: 1,
			},
		]);
		const batch: ProductionRouteScoreBatch = {
			scores: handoffBatch.scores,
			summary: scoreProductionRoutes([]).summary,
		};

		expect(classifyProductionRouteScoreBatchReadiness(batch)).toBe(
			"handoff_required",
		);
	});
});

describe("summarizeProductionRouteScoreBatchReadiness", () => {
	it("returns a stable empty summary for empty input", () => {
		expect(summarizeProductionRouteScoreBatchReadiness([])).toEqual({
			totalBatches: 0,
			totalScores: 0,
			byReadiness: {
				empty: 0,
				local_only: 0,
				mixed: 0,
				handoff_required: 0,
			},
			highestRequiredReadiness: "empty",
		});
	});

	it("summarizes all-local batches as local-only", () => {
		const summary = summarizeProductionRouteScoreBatchReadiness([
			scoreProductionRoutes([
				{
					taskRisk: "safe",
					complexity: 0,
					cost: 0,
					capabilityFit: 1,
				},
			]),
			scoreProductionRoutes([
				{
					taskRisk: "safe",
					complexity: 0,
					cost: 0,
					capabilityFit: 1,
				},
				{
					taskRisk: "low",
					complexity: 0.2,
					cost: 0.2,
					capabilityFit: 0.95,
				},
			]),
		]);

		expect(summary).toEqual({
			totalBatches: 2,
			totalScores: 3,
			byReadiness: {
				empty: 0,
				local_only: 2,
				mixed: 0,
				handoff_required: 0,
			},
			highestRequiredReadiness: "local_only",
		});
	});

	it("summarizes mixed readiness across empty, local, and mixed batches", () => {
		const summary = summarizeProductionRouteScoreBatchReadiness([
			scoreProductionRoutes([]),
			scoreProductionRoutes([
				{
					taskRisk: "safe",
					complexity: 0,
					cost: 0,
					capabilityFit: 1,
				},
			]),
			scoreProductionRoutes([
				{
					taskRisk: "low",
					complexity: 0.2,
					cost: 0.2,
					capabilityFit: 0.95,
				},
				{
					taskRisk: "high",
					complexity: 0.1,
					cost: 0.1,
					capabilityFit: 0.95,
				},
			]),
		]);

		expect(summary).toEqual({
			totalBatches: 3,
			totalScores: 3,
			byReadiness: {
				empty: 1,
				local_only: 1,
				mixed: 1,
				handoff_required: 0,
			},
			highestRequiredReadiness: "mixed",
		});
	});

	it("prioritizes handoff-required over mixed readiness from any iterable", () => {
		const mixedBatch = scoreProductionRoutes([
			{
				taskRisk: "low",
				complexity: 0.2,
				cost: 0.2,
				capabilityFit: 0.95,
			},
			{
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			},
		]);
		const handoffBatch = scoreProductionRoutes([
			{
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			},
			{
				taskRisk: "critical",
				complexity: 0,
				cost: 0,
				capabilityFit: 1,
			},
		]);
		function* batches(): Iterable<ProductionRouteScoreBatch> {
			yield mixedBatch;
			yield handoffBatch;
		}

		expect(summarizeProductionRouteScoreBatchReadiness(batches())).toEqual({
			totalBatches: 2,
			totalScores: 4,
			byReadiness: {
				empty: 0,
				local_only: 0,
				mixed: 1,
				handoff_required: 1,
			},
			highestRequiredReadiness: "handoff_required",
		});
	});
});
