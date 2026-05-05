import { describe, expect, it } from "vitest";
import {
	evaluateCostRoutingGate,
	evaluateTinyClassifierGate,
	validateCostRoutingSignal,
	validateTinyClassifierSignal,
} from "./index.js";

describe("evaluateCostRoutingGate", () => {
	it("keeps cost routing disabled until provider evidence gates are complete", () => {
		expect(
			evaluateCostRoutingGate({
				schemaVersion: 1,
				costStrategy: "none",
				recommendedModelTier: "balanced",
				mayDownshift: false,
				traceId: "trace-cost-none",
			}),
		).toEqual({
			schemaVersion: 1,
			enabled: false,
			mayAffectDefaultRoute: false,
			reason: "cost_routing_disabled",
			traceId: "trace-cost-none",
		});
		expect(
			evaluateCostRoutingGate({
				schemaVersion: 1,
				costStrategy: "threshold_router",
				recommendedModelTier: "cheap",
				costThreshold: 0.25,
				evidenceRecordRef: "provider-evidence://future/record",
				mayDownshift: true,
				traceId: "trace-cost-threshold",
			}),
		).toEqual({
			schemaVersion: 1,
			enabled: false,
			mayAffectDefaultRoute: false,
			reason: "provider_evidence_required",
			traceId: "trace-cost-threshold",
		});
	});

	it("validates cost signal shape before returning a disabled gate", () => {
		expect(() =>
			validateCostRoutingSignal({
				schemaVersion: 1,
				costStrategy: "quality_floor_router",
				recommendedModelTier: "strong",
				qualityFloor: 1.2,
				mayDownshift: false,
				traceId: "trace-cost-invalid",
			}),
		).toThrow("signal.qualityFloor must be between 0 and 1");
		expect(() =>
			evaluateCostRoutingGate({
				schemaVersion: 1,
				costStrategy: "unknown" as never,
				recommendedModelTier: "balanced",
				mayDownshift: false,
				traceId: "trace-cost-invalid",
			}),
		).toThrow("signal.costStrategy must be a known cost strategy");
	});
});

describe("evaluateTinyClassifierGate", () => {
	it("keeps the tiny classifier disabled or advisory-only", () => {
		expect(
			evaluateTinyClassifierGate({
				schemaVersion: 1,
				enabled: false,
				modelRef: "classifier://tiny/off",
				predictedRoute: "simple_answer",
				confidence: 0.9,
				calibrated: false,
			}),
		).toEqual({
			schemaVersion: 1,
			enabled: false,
			mayInfluenceDefaultRoute: false,
			reason: "classifier_disabled_by_default",
		});
		expect(
			evaluateTinyClassifierGate({
				schemaVersion: 1,
				enabled: true,
				modelRef: "classifier://tiny/lab",
				predictedRoute: "single_tool",
				confidence: 0.72,
				calibrated: false,
			}),
		).toEqual({
			schemaVersion: 1,
			enabled: false,
			mayInfluenceDefaultRoute: false,
			reason: "classifier_calibration_required",
			predictedRoute: "single_tool",
		});
		expect(
			evaluateTinyClassifierGate({
				schemaVersion: 1,
				enabled: true,
				modelRef: "classifier://tiny/calibrated",
				predictedRoute: "multi_step_linear",
				confidence: 0.81,
				calibrated: true,
				disagreementWithStructural: true,
			}),
		).toEqual({
			schemaVersion: 1,
			enabled: false,
			mayInfluenceDefaultRoute: false,
			reason: "classifier_advisory_only",
			predictedRoute: "multi_step_linear",
		});
	});

	it("validates classifier signal shape before gate evaluation", () => {
		expect(() =>
			validateTinyClassifierSignal({
				schemaVersion: 1,
				enabled: true,
				modelRef: "classifier://tiny/lab",
				predictedRoute: "unknown" as never,
				confidence: 0.5,
				calibrated: false,
			}),
		).toThrow("signal.predictedRoute must be a known planner route");
		expect(() =>
			evaluateTinyClassifierGate({
				schemaVersion: 1,
				enabled: true,
				modelRef: "classifier://tiny/lab",
				predictedRoute: "simple_answer",
				confidence: 1.2,
				calibrated: false,
			}),
		).toThrow("signal.confidence must be a finite number between 0 and 1");
	});
});
