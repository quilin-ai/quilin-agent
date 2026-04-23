import { describe, expect, it } from "vitest";
import {
	computeAuditAgreement,
	observePlannerAudit,
} from "./audit.js";
import type { LLMPlannerResponse, LinearPlan } from "./types.js";

function makePlan(): LinearPlan {
	return {
		kind: "linear",
		subtasks: [
			{
				id: "step-1",
				action: "web_search",
				name: "Collect context",
				description: "Collect context before executing.",
				estimatedTokens: 120,
				estimatedSteps: 1,
				preconditions: [],
				effects: ["context_collected"],
				writeScope: "working",
				risk: "low",
			},
		],
	};
}

describe("observePlannerAudit", () => {
	it("records intentHint/confidence without changing the structural decision", () => {
		const response: LLMPlannerResponse = {
			text: "Search, tabulate, then summarize.",
			planSketch: makePlan(),
			audit: {
				intentHint: "MULTI_STEP",
				confidence: 0.91,
				reasoningDigest: "The response already contains an execution sketch.",
			},
		};

		const observation = observePlannerAudit(response);

		expect(observation).toEqual({
			structuralIntent: "MULTI_STEP",
			dispatchedIntent: "MULTI_STEP",
			dispatchSource: "audit",
			intentHint: "MULTI_STEP",
			confidence: 0.91,
			reasoningDigest: "The response already contains an execution sketch.",
			matchesStructural: true,
			matchesDispatched: true,
		});
	});

	it("returns null audit fields when the planner response has no audit payload", () => {
		expect(
			observePlannerAudit({
				text: "Python GIL is the global interpreter lock.",
			}),
		).toEqual({
			structuralIntent: "SIMPLE_QA",
			dispatchedIntent: "SIMPLE_QA",
			dispatchSource: "structural",
			intentHint: null,
			confidence: null,
			matchesStructural: null,
			matchesDispatched: null,
		});
	});
});

describe("computeAuditAgreement", () => {
	it("computes consistency metrics from audit fixtures", () => {
		const observations = [
			observePlannerAudit({
				text: "Need a short plan.",
				planSketch: makePlan(),
				audit: {
					intentHint: "MULTI_STEP",
					confidence: 0.94,
				},
			}),
			observePlannerAudit({
				toolCalls: [
					{
						id: "tool-1",
						name: "web_search",
						arguments: { query: "latest Quilin benchmarks" },
					},
				],
				audit: {
					intentHint: "SINGLE_TOOL",
					confidence: 0.82,
				},
			}),
			observePlannerAudit({
				text: "done",
				audit: {
					intentHint: "MULTI_STEP",
					confidence: 0.91,
				},
			}),
			observePlannerAudit({
				text: "No audit payload here.",
			}),
		];

		expect(computeAuditAgreement(observations)).toEqual({
			totalSamples: 4,
			auditedSamples: 3,
			structuralMatches: 2,
			dispatchedMatches: 3,
			structuralAgreementRate: 2 / 3,
			dispatchedAgreementRate: 1,
		});
	});

	it("returns zero rates when no observations contain an audit payload", () => {
		expect(
			computeAuditAgreement([
				observePlannerAudit({ text: "one" }),
				observePlannerAudit({ text: "two" }),
			]),
		).toEqual({
			totalSamples: 2,
			auditedSamples: 0,
			structuralMatches: 0,
			dispatchedMatches: 0,
			structuralAgreementRate: 0,
			dispatchedAgreementRate: 0,
		});
	});
});
