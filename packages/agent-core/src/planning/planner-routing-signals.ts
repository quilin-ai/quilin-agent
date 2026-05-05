import type { PlannerRoute } from "./planner-routing.js";

export type CostRoutingStrategy =
	| "none"
	| "threshold_router"
	| "quality_floor_router";

export type RecommendedModelTier = "cheap" | "balanced" | "strong";

export interface CostRoutingSignal {
	readonly schemaVersion: 1;
	readonly costStrategy: CostRoutingStrategy;
	readonly recommendedModelTier: RecommendedModelTier;
	readonly costThreshold?: number;
	readonly qualityFloor?: number;
	readonly evidenceRecordRef?: string;
	readonly mayDownshift: boolean;
	readonly traceId: string;
}

export type CostRoutingGateReason =
	| "cost_routing_disabled"
	| "provider_evidence_required";

export interface CostRoutingGateDecision {
	readonly schemaVersion: 1;
	readonly enabled: false;
	readonly mayAffectDefaultRoute: false;
	readonly reason: CostRoutingGateReason;
	readonly traceId: string;
}

export interface TinyClassifierSignal {
	readonly schemaVersion: 1;
	readonly enabled: boolean;
	readonly modelRef: string;
	readonly predictedRoute: PlannerRoute;
	readonly confidence: number;
	readonly calibrated: boolean;
	readonly disagreementWithStructural?: boolean;
}

export type TinyClassifierGateReason =
	| "classifier_disabled_by_default"
	| "classifier_calibration_required"
	| "classifier_advisory_only";

export interface TinyClassifierGateDecision {
	readonly schemaVersion: 1;
	readonly enabled: false;
	readonly mayInfluenceDefaultRoute: false;
	readonly reason: TinyClassifierGateReason;
	readonly predictedRoute?: PlannerRoute;
}

const COST_ROUTING_STRATEGIES = new Set<CostRoutingStrategy>([
	"none",
	"threshold_router",
	"quality_floor_router",
]);

const RECOMMENDED_MODEL_TIERS = new Set<RecommendedModelTier>([
	"cheap",
	"balanced",
	"strong",
]);

const PLANNER_ROUTES = new Set<PlannerRoute>([
	"simple_answer",
	"single_tool",
	"multi_step_linear",
	"multi_step_parallel",
	"clarification",
	"supervisor_required",
	"deferred_due_to_budget",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, name: string): void {
	if (!isRecord(value)) {
		throw new TypeError(`${name} must be an object`);
	}
}

function assertBoolean(value: boolean, name: string): void {
	if (typeof value !== "boolean") {
		throw new TypeError(`${name} must be a boolean`);
	}
}

function assertNonEmptyString(value: string, name: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new RangeError(`${name} must be a non-empty string`);
	}
}

function assertOptionalNonNegativeNumber(
	value: number | undefined,
	name: string,
): void {
	if (value != null && (!Number.isFinite(value) || value < 0)) {
		throw new RangeError(`${name} must be a finite non-negative number`);
	}
}

function assertConfidence(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new RangeError(`${name} must be a finite number between 0 and 1`);
	}
}

export function validateCostRoutingSignal(signal: CostRoutingSignal): void {
	assertRecord(signal, "signal");
	if (signal.schemaVersion !== 1) {
		throw new RangeError("signal.schemaVersion must be 1");
	}
	if (!COST_ROUTING_STRATEGIES.has(signal.costStrategy)) {
		throw new RangeError("signal.costStrategy must be a known cost strategy");
	}
	if (!RECOMMENDED_MODEL_TIERS.has(signal.recommendedModelTier)) {
		throw new RangeError(
			"signal.recommendedModelTier must be a known model tier",
		);
	}
	assertOptionalNonNegativeNumber(signal.costThreshold, "signal.costThreshold");
	assertOptionalNonNegativeNumber(signal.qualityFloor, "signal.qualityFloor");
	if (signal.qualityFloor != null && signal.qualityFloor > 1) {
		throw new RangeError("signal.qualityFloor must be between 0 and 1");
	}
	if (signal.evidenceRecordRef != null) {
		assertNonEmptyString(signal.evidenceRecordRef, "signal.evidenceRecordRef");
	}
	assertBoolean(signal.mayDownshift, "signal.mayDownshift");
	assertNonEmptyString(signal.traceId, "signal.traceId");
}

export function evaluateCostRoutingGate(
	signal: CostRoutingSignal,
): CostRoutingGateDecision {
	validateCostRoutingSignal(signal);
	return {
		schemaVersion: 1,
		enabled: false,
		mayAffectDefaultRoute: false,
		reason:
			signal.costStrategy === "none"
				? "cost_routing_disabled"
				: "provider_evidence_required",
		traceId: signal.traceId,
	};
}

export function validateTinyClassifierSignal(
	signal: TinyClassifierSignal,
): void {
	assertRecord(signal, "signal");
	if (signal.schemaVersion !== 1) {
		throw new RangeError("signal.schemaVersion must be 1");
	}
	assertBoolean(signal.enabled, "signal.enabled");
	assertNonEmptyString(signal.modelRef, "signal.modelRef");
	if (!PLANNER_ROUTES.has(signal.predictedRoute)) {
		throw new RangeError("signal.predictedRoute must be a known planner route");
	}
	assertConfidence(signal.confidence, "signal.confidence");
	assertBoolean(signal.calibrated, "signal.calibrated");
	if (signal.disagreementWithStructural != null) {
		assertBoolean(
			signal.disagreementWithStructural,
			"signal.disagreementWithStructural",
		);
	}
}

export function evaluateTinyClassifierGate(
	signal: TinyClassifierSignal,
): TinyClassifierGateDecision {
	validateTinyClassifierSignal(signal);
	if (!signal.enabled) {
		return {
			schemaVersion: 1,
			enabled: false,
			mayInfluenceDefaultRoute: false,
			reason: "classifier_disabled_by_default",
		};
	}
	if (!signal.calibrated) {
		return {
			schemaVersion: 1,
			enabled: false,
			mayInfluenceDefaultRoute: false,
			reason: "classifier_calibration_required",
			predictedRoute: signal.predictedRoute,
		};
	}
	return {
		schemaVersion: 1,
		enabled: false,
		mayInfluenceDefaultRoute: false,
		reason: "classifier_advisory_only",
		predictedRoute: signal.predictedRoute,
	};
}
