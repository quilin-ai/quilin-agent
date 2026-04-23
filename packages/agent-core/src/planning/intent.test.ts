import { describe, expect, it } from "vitest";
import {
	classifyIntent,
	dispatchIntent,
	deriveStructuralIntent,
	StructuralIntentClassifier,
} from "./intent.js";
import type { LLMPlannerResponse, LinearPlan } from "./types.js";

function makePlan(): LinearPlan {
	return {
		kind: "linear",
		subtasks: [
			{
				id: "step-1",
				action: "read_context",
				name: "Collect inputs",
				description: "Read the request before acting",
				estimatedTokens: 120,
				estimatedSteps: 1,
				preconditions: [],
				effects: ["context_loaded"],
				writeScope: "none",
				risk: "low",
			},
		],
	};
}

describe("deriveStructuralIntent", () => {
	it.each<
		readonly [name: string, response: LLMPlannerResponse, expected: string]
	>([
		[
			"simple QA text only",
			{ text: "Python GIL is the global interpreter lock." },
			"SIMPLE_QA",
		],
		[
			"single tool call",
			{
				toolCalls: [
					{
						id: "tool-1",
						name: "web_search",
						arguments: { query: "BTC price today" },
					},
				],
			},
			"SINGLE_TOOL",
		],
		[
			"multiple tool calls",
			{
				toolCalls: [
					{ id: "tool-1", name: "search", arguments: { query: "A" } },
					{ id: "tool-2", name: "search", arguments: { query: "B" } },
				],
			},
			"MULTI_STEP",
		],
		[
			"plan sketch present",
			{
				planSketch: makePlan(),
			},
			"MULTI_STEP",
		],
		[
			"clarification requested",
			{
				needClarification: {
					question: "Which file should I edit?",
					missing: ["file"],
				},
			},
			"CLARIFICATION",
		],
		[
			"plan sketch wins over a single tool call",
			{
				planSketch: makePlan(),
				toolCalls: [
					{ id: "tool-1", name: "search", arguments: { query: "repo docs" } },
				],
			},
			"MULTI_STEP",
		],
	])("classifies %s", (_name, response, expected) => {
		expect(deriveStructuralIntent(response)).toBe(expected);
	});
});

describe("dispatchIntent", () => {
	it("returns a structural classification for response shapes", () => {
		const result = dispatchIntent({
			toolCalls: [
				{
					id: "tool-1",
					name: "web_search",
					arguments: { query: "latest benchmark results" },
				},
			],
		});

		expect(result).toEqual({
			intent: "SINGLE_TOOL",
			confidence: 1,
			source: "structural",
			latencyMs: 0,
		});
	});

	it("uses audit when the response is simple QA and audit confidence is high", () => {
		const result = classifyIntent(
			{
				text: "done",
				audit: {
					intentHint: "SIMPLE_QA",
					confidence: 0.92,
					reasoningDigest: "Direct answer is enough.",
				},
			},
			{ latencyMs: 48 },
		);

		expect(result).toEqual({
			intent: "SIMPLE_QA",
			confidence: 0.92,
			source: "audit",
			latencyMs: 48,
			reasoningDigest: "Direct answer is enough.",
		});
	});

	it("falls back to structural intent when audit disagrees with an explicit tool shape", () => {
		const result = dispatchIntent({
			toolCalls: [
				{
					id: "tool-1",
					name: "search",
					arguments: { query: "open PRs" },
				},
			],
			audit: {
				intentHint: "MULTI_STEP",
				confidence: 0.99,
				reasoningDigest: "There might be follow-up work.",
			},
		});

		expect(result.intent).toBe("SINGLE_TOOL");
		expect(result.source).toBe("structural");
		expect(result.confidence).toBe(1);
	});

	it("falls back to structural intent when audit confidence is below threshold", () => {
		const classifier = new StructuralIntentClassifier();
		const result = classifier.dispatch({
			text: "done",
			audit: {
				intentHint: "SINGLE_TOOL",
				confidence: 0.4,
			},
		});

		expect(result.intent).toBe("SIMPLE_QA");
		expect(result.source).toBe("structural");
	});

	it("keeps clarification as the terminal structural branch", () => {
		const result = dispatchIntent({
			needClarification: {
				question: "Which repository should I inspect?",
				missing: ["repository"],
			},
			audit: {
				intentHint: "SIMPLE_QA",
				confidence: 0.99,
			},
		});

		expect(result.intent).toBe("CLARIFICATION");
		expect(result.source).toBe("structural");
	});
});
