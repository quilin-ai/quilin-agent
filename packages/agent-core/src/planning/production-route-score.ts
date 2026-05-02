import {
	type DelegationAgentProfile,
	type DelegationAssignment,
	type DelegationDecisionReason,
	type DelegationRiskLevel,
	type DelegationTriggerConditions,
	evaluateDelegation,
} from "./delegation.js";
import type { DagPlan, SubTask } from "./types.js";

export type ProductionRouteHandoffRecommendation =
	| "keep_local"
	| "handoff_to_supervisor";

export type ProductionRouteScoreBand = "low" | "medium" | "high";

export type ProductionRouteScoreReasonCode =
	| "missing_task_risk_default_medium"
	| "missing_complexity_default_conservative"
	| "missing_cost_default_conservative"
	| "missing_capability_fit_default_conservative"
	| "task_risk_safe_local"
	| "task_risk_low_local"
	| "task_risk_medium_monitor"
	| "task_risk_high_supervisor"
	| "task_risk_critical_supervisor"
	| "complexity_low_local"
	| "complexity_medium"
	| "complexity_high_supervisor"
	| "cost_low_local"
	| "cost_medium"
	| "cost_high_supervisor"
	| "capability_fit_strong_local"
	| "capability_fit_partial"
	| "capability_fit_weak_supervisor"
	| "non_blocking_supervisor_required"
	| "score_below_threshold"
	| "score_above_threshold"
	| "risk_requires_supervisor_handoff"
	| "recommend_keep_local"
	| "recommend_handoff_to_supervisor";

export interface ProductionRouteScoreInput {
	readonly taskRisk?: DelegationRiskLevel;
	readonly complexity?: number;
	readonly cost?: number;
	readonly capabilityFit?: number;
	readonly nonBlockingSupervisorRequired?: boolean;
}

export interface ProductionRouteScoreOptions {
	readonly supervisorHandoffThreshold?: number;
}

export interface ProductionRouteScoreBreakdown {
	readonly taskRisk: number;
	readonly complexity: number;
	readonly cost: number;
	readonly capabilityGap: number;
	readonly nonBlockingSupervisorBonus: number;
}

export interface ProductionRouteNormalizedFactors {
	readonly taskRisk: DelegationRiskLevel;
	readonly taskRiskScore: number;
	readonly complexity: number;
	readonly cost: number;
	readonly capabilityFit: number;
	readonly capabilityGap: number;
	readonly nonBlockingSupervisorRequired: boolean;
}

export interface ProductionRouteSelectedRouteExplanation {
	readonly route: ProductionRouteHandoffRecommendation;
	readonly reasonCodes: ReadonlyArray<ProductionRouteScoreReasonCode>;
}

export interface ProductionRouteScoreExplanation {
	readonly score: number;
	readonly threshold: number;
	readonly scoreBand: ProductionRouteScoreBand;
	readonly selectedRoute: ProductionRouteSelectedRouteExplanation;
	readonly normalizedFactors: ProductionRouteNormalizedFactors;
}

export type ProductionRouteScoreBandCounts = Record<
	ProductionRouteScoreBand,
	number
>;

export type ProductionRouteSelectedRouteCounts = Record<
	ProductionRouteHandoffRecommendation,
	number
>;

export type ProductionRouteReasonCodeCounts = Partial<
	Record<ProductionRouteScoreReasonCode, number>
>;

export interface ProductionRouteExplanationBatchSummaryItem {
	readonly index: number;
	readonly score: number;
	readonly scoreBand: ProductionRouteScoreBand;
	readonly selectedRoute: ProductionRouteHandoffRecommendation;
	readonly taskRisk: DelegationRiskLevel;
}

export interface ProductionRouteExplanationBatchSummary {
	readonly total: number;
	readonly byBand: ProductionRouteScoreBandCounts;
	readonly bySelectedRoute: ProductionRouteSelectedRouteCounts;
	readonly byReasonCode: ProductionRouteReasonCodeCounts;
	readonly highestRisk: ProductionRouteExplanationBatchSummaryItem | null;
	readonly lowestScore: ProductionRouteExplanationBatchSummaryItem | null;
}

export interface ProductionRouteScore {
	readonly score: number;
	readonly threshold: number;
	readonly scoreBreakdown: ProductionRouteScoreBreakdown;
	readonly reasonCodes: ReadonlyArray<ProductionRouteScoreReasonCode>;
	readonly handoffRecommendation: ProductionRouteHandoffRecommendation;
	readonly explanation: ProductionRouteScoreExplanation;
}

export interface ProductionRouteScoreBatch {
	readonly scores: readonly ProductionRouteScore[];
	readonly summary: ProductionRouteExplanationBatchSummary;
}

export type ProductionRouteScoreBatchReadiness =
	| "empty"
	| "local_only"
	| "mixed"
	| "handoff_required";

export type ProductionRouteScoreBatchReadinessCounts = Record<
	ProductionRouteScoreBatchReadiness,
	number
>;

export interface ProductionRouteScoreBatchReadinessSummary {
	readonly totalBatches: number;
	readonly totalScores: number;
	readonly byReadiness: ProductionRouteScoreBatchReadinessCounts;
	readonly highestRequiredReadiness: ProductionRouteScoreBatchReadiness;
}

export interface ProductionRouteSupervisorHandoffItem {
	readonly index: number;
	readonly score: number;
	readonly scoreBand: ProductionRouteScoreBand;
	readonly taskRisk: DelegationRiskLevel;
	readonly reasonCodes: ReadonlyArray<ProductionRouteScoreReasonCode>;
}

export interface ProductionRouteSupervisorHandoffPlan {
	readonly kind: "production_route_supervisor_handoff_plan";
	readonly schemaVersion: 1;
	readonly readiness: ProductionRouteScoreBatchReadiness;
	readonly handoffRequired: boolean;
	readonly handoffCount: number;
	readonly keepLocalCount: number;
	readonly handoffItems: ReadonlyArray<ProductionRouteSupervisorHandoffItem>;
	readonly keepLocalIndexes: ReadonlyArray<number>;
}

export interface ProductionRouteDelegationHandoffBlockedItem {
	readonly index: number;
	readonly taskId: string;
	readonly reason: Exclude<DelegationDecisionReason, "accepted">;
	readonly score: number;
	readonly scoreBand: ProductionRouteScoreBand;
	readonly taskRisk: DelegationRiskLevel;
	readonly reasonCodes: ReadonlyArray<ProductionRouteScoreReasonCode>;
}

export interface ProductionRouteDelegationHandoffAcceptedItem {
	readonly index: number;
	readonly taskId: string;
	readonly score: number;
	readonly scoreBand: ProductionRouteScoreBand;
	readonly taskRisk: DelegationRiskLevel;
	readonly reasonCodes: ReadonlyArray<ProductionRouteScoreReasonCode>;
	readonly assignment: DelegationAssignment;
}

export interface ProductionRouteDelegationHandoffPlan {
	readonly kind: "production_route_delegation_handoff_plan";
	readonly schemaVersion: 1;
	readonly supervisorPlan: ProductionRouteSupervisorHandoffPlan;
	readonly acceptedAssignments: ReadonlyArray<ProductionRouteDelegationHandoffAcceptedItem>;
	readonly blockedItems: ReadonlyArray<ProductionRouteDelegationHandoffBlockedItem>;
	readonly handoffReadyCount: number;
	readonly blockedCount: number;
}

export interface ProductionRouteDelegationHandoffPlanInput {
	readonly parentRunId: string;
	readonly plan: DagPlan;
	readonly batch: ProductionRouteScoreBatch;
	readonly subAgentForStep: (
		step: SubTask,
		item: ProductionRouteSupervisorHandoffItem,
	) => DelegationAgentProfile;
	readonly triggers?: Partial<DelegationTriggerConditions>;
}

const DEFAULT_SUPERVISOR_HANDOFF_THRESHOLD = 60;
const DEFAULT_COMPLEXITY = 0.65;
const DEFAULT_COST = 0.65;
const DEFAULT_CAPABILITY_FIT = 0.35;
const NON_BLOCKING_SUPERVISOR_BONUS = 20;
const EXPLANATION_DECIMAL_PLACES = 6;

const SCORE_WEIGHTS = {
	taskRisk: 0.65,
	complexity: 0.15,
	cost: 0.05,
	capabilityGap: 0.15,
} as const;

const PRODUCTION_ROUTE_REASON_CODE_ORDER: ReadonlyArray<ProductionRouteScoreReasonCode> =
	[
		"missing_task_risk_default_medium",
		"missing_complexity_default_conservative",
		"missing_cost_default_conservative",
		"missing_capability_fit_default_conservative",
		"task_risk_safe_local",
		"task_risk_low_local",
		"task_risk_medium_monitor",
		"task_risk_high_supervisor",
		"task_risk_critical_supervisor",
		"complexity_low_local",
		"complexity_medium",
		"complexity_high_supervisor",
		"cost_low_local",
		"cost_medium",
		"cost_high_supervisor",
		"capability_fit_strong_local",
		"capability_fit_partial",
		"capability_fit_weak_supervisor",
		"non_blocking_supervisor_required",
		"risk_requires_supervisor_handoff",
		"score_above_threshold",
		"score_below_threshold",
		"recommend_handoff_to_supervisor",
		"recommend_keep_local",
	];

const SELECTED_ROUTE_REASON_CODE_ORDER: ReadonlyArray<ProductionRouteScoreReasonCode> =
	[
		"non_blocking_supervisor_required",
		"risk_requires_supervisor_handoff",
		"score_above_threshold",
		"score_below_threshold",
		"recommend_handoff_to_supervisor",
		"recommend_keep_local",
	];

const TASK_RISK_SCORE: Record<DelegationRiskLevel, number> = {
	safe: 0,
	low: 15,
	medium: 60,
	high: 90,
	critical: 100,
};
const VALID_TASK_RISKS = new Set<DelegationRiskLevel>([
	"safe",
	"low",
	"medium",
	"high",
	"critical",
]);

const PRODUCTION_ROUTE_BATCH_READINESS_PRIORITY: Record<
	ProductionRouteScoreBatchReadiness,
	number
> = {
	empty: 0,
	local_only: 1,
	mixed: 2,
	handoff_required: 3,
};

function normalizeUnitSignal(name: string, value: number): number {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new RangeError(`${name} must be a finite number between 0 and 1`);
	}
	return value;
}

function normalizeThreshold(value: number | undefined): number {
	const threshold = value ?? DEFAULT_SUPERVISOR_HANDOFF_THRESHOLD;
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
		throw new RangeError(
			"supervisorHandoffThreshold must be a finite number between 0 and 100",
		);
	}
	return threshold;
}

function normalizeTaskRisk(value: DelegationRiskLevel): DelegationRiskLevel {
	if (!VALID_TASK_RISKS.has(value)) {
		throw new RangeError("taskRisk must be a known delegation risk level");
	}
	return value;
}

function normalizeNonBlockingSupervisorRequired(
	value: boolean | undefined,
): boolean {
	if (value === undefined) {
		return false;
	}
	if (typeof value !== "boolean") {
		throw new TypeError("nonBlockingSupervisorRequired must be a boolean");
	}
	return value;
}

function reasonForTaskRisk(
	taskRisk: DelegationRiskLevel,
): ProductionRouteScoreReasonCode {
	if (taskRisk === "safe") {
		return "task_risk_safe_local";
	}
	if (taskRisk === "low") {
		return "task_risk_low_local";
	}
	if (taskRisk === "medium") {
		return "task_risk_medium_monitor";
	}
	if (taskRisk === "high") {
		return "task_risk_high_supervisor";
	}
	return "task_risk_critical_supervisor";
}

function reasonForComplexity(value: number): ProductionRouteScoreReasonCode {
	if (value < 0.35) {
		return "complexity_low_local";
	}
	if (value < 0.7) {
		return "complexity_medium";
	}
	return "complexity_high_supervisor";
}

function reasonForCost(value: number): ProductionRouteScoreReasonCode {
	if (value < 0.35) {
		return "cost_low_local";
	}
	if (value < 0.7) {
		return "cost_medium";
	}
	return "cost_high_supervisor";
}

function reasonForCapabilityFit(value: number): ProductionRouteScoreReasonCode {
	if (value >= 0.8) {
		return "capability_fit_strong_local";
	}
	if (value >= 0.5) {
		return "capability_fit_partial";
	}
	return "capability_fit_weak_supervisor";
}

function scoreBandFor(
	score: number,
	threshold: number,
): ProductionRouteScoreBand {
	if (score >= threshold) {
		return "high";
	}
	if (score >= threshold / 2) {
		return "medium";
	}
	return "low";
}

function selectedRouteReasonCodes(
	reasonCodes: ReadonlyArray<ProductionRouteScoreReasonCode>,
): ReadonlyArray<ProductionRouteScoreReasonCode> {
	const reasonCodeSet = new Set(reasonCodes);
	return SELECTED_ROUTE_REASON_CODE_ORDER.filter((reasonCode) =>
		reasonCodeSet.has(reasonCode),
	);
}

function roundExplanationFactor(value: number): number {
	return Number(value.toFixed(EXPLANATION_DECIMAL_PLACES));
}

function buildProductionRouteExplanation(
	score: number,
	threshold: number,
	reasonCodes: ReadonlyArray<ProductionRouteScoreReasonCode>,
	handoffRecommendation: ProductionRouteHandoffRecommendation,
	normalizedFactors: ProductionRouteNormalizedFactors,
): ProductionRouteScoreExplanation {
	return {
		score,
		threshold,
		scoreBand: scoreBandFor(score, threshold),
		selectedRoute: {
			route: handoffRecommendation,
			reasonCodes: selectedRouteReasonCodes(reasonCodes),
		},
		normalizedFactors,
	};
}

export function scoreProductionRoute(
	input: ProductionRouteScoreInput,
	options: ProductionRouteScoreOptions = {},
): ProductionRouteScore {
	const threshold = normalizeThreshold(options.supervisorHandoffThreshold);
	const reasonCodes: ProductionRouteScoreReasonCode[] = [];

	const taskRisk = normalizeTaskRisk(input.taskRisk ?? "medium");
	if (input.taskRisk == null) {
		reasonCodes.push("missing_task_risk_default_medium");
	}
	reasonCodes.push(reasonForTaskRisk(taskRisk));

	const complexity = normalizeUnitSignal(
		"complexity",
		input.complexity ?? DEFAULT_COMPLEXITY,
	);
	if (input.complexity == null) {
		reasonCodes.push("missing_complexity_default_conservative");
	}
	reasonCodes.push(reasonForComplexity(complexity));

	const cost = normalizeUnitSignal("cost", input.cost ?? DEFAULT_COST);
	if (input.cost == null) {
		reasonCodes.push("missing_cost_default_conservative");
	}
	reasonCodes.push(reasonForCost(cost));

	const capabilityFit = normalizeUnitSignal(
		"capabilityFit",
		input.capabilityFit ?? DEFAULT_CAPABILITY_FIT,
	);
	if (input.capabilityFit == null) {
		reasonCodes.push("missing_capability_fit_default_conservative");
	}
	reasonCodes.push(reasonForCapabilityFit(capabilityFit));
	const nonBlockingSupervisorRequired = normalizeNonBlockingSupervisorRequired(
		input.nonBlockingSupervisorRequired,
	);
	const normalizedFactors: ProductionRouteNormalizedFactors = {
		taskRisk,
		taskRiskScore: TASK_RISK_SCORE[taskRisk],
		complexity: roundExplanationFactor(complexity),
		cost: roundExplanationFactor(cost),
		capabilityFit: roundExplanationFactor(capabilityFit),
		capabilityGap: roundExplanationFactor(1 - capabilityFit),
		nonBlockingSupervisorRequired,
	};

	const scoreBreakdown: ProductionRouteScoreBreakdown = {
		taskRisk: TASK_RISK_SCORE[taskRisk] * SCORE_WEIGHTS.taskRisk,
		complexity: complexity * 100 * SCORE_WEIGHTS.complexity,
		cost: cost * 100 * SCORE_WEIGHTS.cost,
		capabilityGap: (1 - capabilityFit) * 100 * SCORE_WEIGHTS.capabilityGap,
		nonBlockingSupervisorBonus: nonBlockingSupervisorRequired
			? NON_BLOCKING_SUPERVISOR_BONUS
			: 0,
	};

	if (nonBlockingSupervisorRequired) {
		reasonCodes.push("non_blocking_supervisor_required");
	}

	const rawScore =
		scoreBreakdown.taskRisk +
		scoreBreakdown.complexity +
		scoreBreakdown.cost +
		scoreBreakdown.capabilityGap +
		scoreBreakdown.nonBlockingSupervisorBonus;
	const score = Math.min(100, Math.round(rawScore));
	const riskRequiresSupervisor = taskRisk === "high" || taskRisk === "critical";
	const handoffRecommendation =
		score >= threshold ||
		riskRequiresSupervisor ||
		nonBlockingSupervisorRequired
			? "handoff_to_supervisor"
			: "keep_local";

	if (riskRequiresSupervisor) {
		reasonCodes.push("risk_requires_supervisor_handoff");
	}
	reasonCodes.push(
		score >= threshold ? "score_above_threshold" : "score_below_threshold",
	);
	reasonCodes.push(
		handoffRecommendation === "handoff_to_supervisor"
			? "recommend_handoff_to_supervisor"
			: "recommend_keep_local",
	);
	const explanation = buildProductionRouteExplanation(
		score,
		threshold,
		reasonCodes,
		handoffRecommendation,
		normalizedFactors,
	);

	return {
		score,
		threshold,
		scoreBreakdown,
		reasonCodes,
		handoffRecommendation,
		explanation,
	};
}

export function explainProductionRoute(
	input: ProductionRouteScoreInput,
	options: ProductionRouteScoreOptions = {},
): ProductionRouteScoreExplanation {
	return scoreProductionRoute(input, options).explanation;
}

function createScoreBandCounts(): ProductionRouteScoreBandCounts {
	return {
		low: 0,
		medium: 0,
		high: 0,
	};
}

function createSelectedRouteCounts(): ProductionRouteSelectedRouteCounts {
	return {
		keep_local: 0,
		handoff_to_supervisor: 0,
	};
}

function createReadinessCounts(): ProductionRouteScoreBatchReadinessCounts {
	return {
		empty: 0,
		local_only: 0,
		mixed: 0,
		handoff_required: 0,
	};
}

function batchSummaryItemFor(
	index: number,
	explanation: ProductionRouteScoreExplanation,
): ProductionRouteExplanationBatchSummaryItem {
	return {
		index,
		score: explanation.score,
		scoreBand: explanation.scoreBand,
		selectedRoute: explanation.selectedRoute.route,
		taskRisk: explanation.normalizedFactors.taskRisk,
	};
}

function isHigherRiskSummaryItem(
	candidate: ProductionRouteExplanationBatchSummaryItem,
	current: ProductionRouteExplanationBatchSummaryItem,
): boolean {
	const candidateRiskScore = TASK_RISK_SCORE[candidate.taskRisk];
	const currentRiskScore = TASK_RISK_SCORE[current.taskRisk];
	if (candidateRiskScore !== currentRiskScore) {
		return candidateRiskScore > currentRiskScore;
	}
	if (candidate.score !== current.score) {
		return candidate.score > current.score;
	}
	return candidate.index < current.index;
}

function isLowerScoreSummaryItem(
	candidate: ProductionRouteExplanationBatchSummaryItem,
	current: ProductionRouteExplanationBatchSummaryItem,
): boolean {
	if (candidate.score !== current.score) {
		return candidate.score < current.score;
	}
	return candidate.index < current.index;
}

function orderedReasonCodeCounts(
	counts: ReadonlyMap<ProductionRouteScoreReasonCode, number>,
): ProductionRouteReasonCodeCounts {
	const byReasonCode: ProductionRouteReasonCodeCounts = {};
	for (const reasonCode of PRODUCTION_ROUTE_REASON_CODE_ORDER) {
		const count = counts.get(reasonCode);
		if (count !== undefined && count > 0) {
			byReasonCode[reasonCode] = count;
		}
	}
	return byReasonCode;
}

export function summarizeProductionRouteExplanations(
	explanations: ReadonlyArray<ProductionRouteScoreExplanation>,
): ProductionRouteExplanationBatchSummary {
	const byBand = createScoreBandCounts();
	const bySelectedRoute = createSelectedRouteCounts();
	const reasonCodeCounts = new Map<ProductionRouteScoreReasonCode, number>();
	let highestRisk: ProductionRouteExplanationBatchSummaryItem | null = null;
	let lowestScore: ProductionRouteExplanationBatchSummaryItem | null = null;

	for (const [index, explanation] of explanations.entries()) {
		byBand[explanation.scoreBand] += 1;
		bySelectedRoute[explanation.selectedRoute.route] += 1;
		for (const reasonCode of explanation.selectedRoute.reasonCodes) {
			reasonCodeCounts.set(
				reasonCode,
				(reasonCodeCounts.get(reasonCode) ?? 0) + 1,
			);
		}

		const item = batchSummaryItemFor(index, explanation);
		if (highestRisk === null || isHigherRiskSummaryItem(item, highestRisk)) {
			highestRisk = item;
		}
		if (lowestScore === null || isLowerScoreSummaryItem(item, lowestScore)) {
			lowestScore = item;
		}
	}

	return {
		total: explanations.length,
		byBand,
		bySelectedRoute,
		byReasonCode: orderedReasonCodeCounts(reasonCodeCounts),
		highestRisk,
		lowestScore,
	};
}

export function summarizeProductionRouteScores(
	scores: ReadonlyArray<ProductionRouteScore>,
): ProductionRouteExplanationBatchSummary {
	const summary = summarizeProductionRouteExplanations(
		scores.map((score) => score.explanation),
	);
	const reasonCodeCounts = new Map<ProductionRouteScoreReasonCode, number>();

	for (const score of scores) {
		for (const reasonCode of score.reasonCodes) {
			reasonCodeCounts.set(
				reasonCode,
				(reasonCodeCounts.get(reasonCode) ?? 0) + 1,
			);
		}
	}

	return {
		...summary,
		byReasonCode: orderedReasonCodeCounts(reasonCodeCounts),
	};
}

export function scoreProductionRoutes(
	inputs: readonly ProductionRouteScoreInput[],
	options: ProductionRouteScoreOptions = {},
): ProductionRouteScoreBatch {
	const scores = inputs.map((input) => scoreProductionRoute(input, options));

	return {
		scores,
		summary: summarizeProductionRouteScores(scores),
	};
}

export function classifyProductionRouteScoreBatchReadiness(
	batch: ProductionRouteScoreBatch,
): ProductionRouteScoreBatchReadiness {
	const summary = summarizeProductionRouteScores(batch.scores);
	const total = summary.total;
	if (total === 0) {
		return "empty";
	}

	const { handoff_to_supervisor, keep_local } = summary.bySelectedRoute;
	if (handoff_to_supervisor === 0 && keep_local === total) {
		return "local_only";
	}
	if (handoff_to_supervisor === total) {
		return "handoff_required";
	}
	return "mixed";
}

export function summarizeProductionRouteScoreBatchReadiness(
	batches: Iterable<ProductionRouteScoreBatch>,
): ProductionRouteScoreBatchReadinessSummary {
	const byReadiness = createReadinessCounts();
	let totalBatches = 0;
	let totalScores = 0;
	let highestRequiredReadiness: ProductionRouteScoreBatchReadiness = "empty";

	for (const batch of batches) {
		const readiness = classifyProductionRouteScoreBatchReadiness(batch);
		byReadiness[readiness] += 1;
		totalBatches += 1;
		totalScores += batch.scores.length;

		if (
			PRODUCTION_ROUTE_BATCH_READINESS_PRIORITY[readiness] >
			PRODUCTION_ROUTE_BATCH_READINESS_PRIORITY[highestRequiredReadiness]
		) {
			highestRequiredReadiness = readiness;
		}
	}

	return {
		totalBatches,
		totalScores,
		byReadiness,
		highestRequiredReadiness,
	};
}

function supervisorHandoffItemFor(
	index: number,
	score: ProductionRouteScore,
): ProductionRouteSupervisorHandoffItem {
	return {
		index,
		score: score.score,
		scoreBand: score.explanation.scoreBand,
		taskRisk: score.explanation.normalizedFactors.taskRisk,
		reasonCodes: selectedRouteReasonCodes(score.reasonCodes),
	};
}

export function buildProductionRouteSupervisorHandoffPlan(
	batch: ProductionRouteScoreBatch,
): ProductionRouteSupervisorHandoffPlan {
	const readiness = classifyProductionRouteScoreBatchReadiness(batch);
	const handoffItems: ProductionRouteSupervisorHandoffItem[] = [];
	const keepLocalIndexes: number[] = [];

	for (const [index, score] of batch.scores.entries()) {
		if (score.handoffRecommendation === "handoff_to_supervisor") {
			handoffItems.push(supervisorHandoffItemFor(index, score));
			continue;
		}
		keepLocalIndexes.push(index);
	}

	return {
		kind: "production_route_supervisor_handoff_plan",
		schemaVersion: 1,
		readiness,
		handoffRequired: handoffItems.length > 0,
		handoffCount: handoffItems.length,
		keepLocalCount: keepLocalIndexes.length,
		handoffItems,
		keepLocalIndexes,
	};
}

function assertRoutePlanScoreShape(
	plan: DagPlan,
	batch: ProductionRouteScoreBatch,
): void {
	if (plan.subtasks.length !== batch.scores.length) {
		throw new RangeError(
			`route_plan_length_mismatch: expected ${plan.subtasks.length} score(s) for ${plan.subtasks.length} subtask(s), got ${batch.scores.length}`,
		);
	}
}

function handoffTriggers(
	overrides: Partial<DelegationTriggerConditions> = {},
): DelegationTriggerConditions {
	return {
		longRunningTask: true,
		decomposableSubtask: true,
		nonBlockingSupervisorRequired: true,
		subAgentCapabilityAvailable: true,
		...overrides,
	};
}

function blockedHandoffItem(
	item: ProductionRouteSupervisorHandoffItem,
	step: SubTask,
	reason: Exclude<DelegationDecisionReason, "accepted">,
): ProductionRouteDelegationHandoffBlockedItem {
	return {
		index: item.index,
		taskId: step.id,
		reason,
		score: item.score,
		scoreBand: item.scoreBand,
		taskRisk: item.taskRisk,
		reasonCodes: item.reasonCodes,
	};
}

function acceptedHandoffItem(
	item: ProductionRouteSupervisorHandoffItem,
	step: SubTask,
	assignment: DelegationAssignment,
): ProductionRouteDelegationHandoffAcceptedItem {
	return {
		index: item.index,
		taskId: step.id,
		score: item.score,
		scoreBand: item.scoreBand,
		taskRisk: item.taskRisk,
		reasonCodes: item.reasonCodes,
		assignment,
	};
}

export function buildProductionRouteDelegationHandoffPlan(
	input: ProductionRouteDelegationHandoffPlanInput,
): ProductionRouteDelegationHandoffPlan {
	assertRoutePlanScoreShape(input.plan, input.batch);

	const supervisorPlan = buildProductionRouteSupervisorHandoffPlan(input.batch);
	const acceptedAssignments: ProductionRouteDelegationHandoffAcceptedItem[] =
		[];
	const blockedItems: ProductionRouteDelegationHandoffBlockedItem[] = [];

	for (const item of supervisorPlan.handoffItems) {
		const step = input.plan.subtasks[item.index];
		if (step == null) {
			throw new RangeError(
				`route_plan_missing_step: no subtask exists for score index ${item.index}`,
			);
		}

		const decision = evaluateDelegation({
			parentRunId: input.parentRunId,
			candidateStep: step,
			plan: input.plan,
			mainAgentSteps: input.plan.subtasks.filter(
				(_candidate, index) => index !== item.index,
			),
			triggers: handoffTriggers(input.triggers),
			subAgent: input.subAgentForStep(step, item),
			riskOverride: item.taskRisk,
		});

		if (decision.delegate) {
			acceptedAssignments.push(
				acceptedHandoffItem(item, step, decision.assignment),
			);
			continue;
		}

		blockedItems.push(blockedHandoffItem(item, step, decision.reason));
	}

	return {
		kind: "production_route_delegation_handoff_plan",
		schemaVersion: 1,
		supervisorPlan,
		acceptedAssignments,
		blockedItems,
		handoffReadyCount: acceptedAssignments.length,
		blockedCount: blockedItems.length,
	};
}
