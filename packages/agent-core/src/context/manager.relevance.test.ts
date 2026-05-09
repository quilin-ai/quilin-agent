import { describe, expect, it, vi } from "vitest";
import { BasicContextManager } from "./manager.js";
import {
	RelevanceSelector,
	type VectorRetriever,
} from "./relevance-selector.js";
import type { ContextSource, TokenBudget } from "./types.js";

const BUDGET: TokenBudget = {
	total: 1000,
	system: 200,
	memory: 200,
	tools: 200,
	conversation: 200,
	reserved: 200,
};

function makeSource(
	content: string,
	priority: number,
	tokenEstimate = 10,
): ContextSource {
	return {
		type: "memory",
		content,
		priority,
		tokenEstimate,
	};
}

describe("BasicContextManager — integration with RelevanceSelector", () => {
	// 1. Query-aware selection: same source list, different queries → different selections.
	it("query-aware selection: different queries yield different outputs", async () => {
		const sources = [
			makeSource("apple banana cherry", 50),
			makeSource("dog cat fish", 50),
			makeSource("orange grape kiwi", 50),
		];
		// Use a low threshold so keyword BM25 ranks but doesn't drop everything.
		const manager = new BasicContextManager({
			relevance: { strategy: "keyword", threshold: 0.01 },
		});

		const appleOutput = await manager.buildContext(sources, BUDGET, {
			relevanceQuery: "apple",
		});
		const dogOutput = await manager.buildContext(sources, BUDGET, {
			relevanceQuery: "dog",
		});

		expect(appleOutput).toContain("apple banana cherry");
		expect(appleOutput).not.toContain("dog cat fish");
		expect(dogOutput).toContain("dog cat fish");
		expect(dogOutput).not.toContain("apple banana cherry");
	});

	// 2. Threshold drop: source below threshold excluded.
	it("threshold drop: sources scoring below threshold are excluded", async () => {
		const sources = [
			makeSource("apple banana cherry", 50),
			makeSource("xylophone zebra zenith", 50),
		];
		// keyword strategy normalizes top score to 1.0 and bottom to 0.0,
		// so threshold=0.5 keeps only the top match.
		const manager = new BasicContextManager({
			relevance: { strategy: "keyword", threshold: 0.5 },
		});
		const output = await manager.buildContext(sources, BUDGET, {
			relevanceQuery: "apple",
		});
		expect(output).toContain("apple");
		expect(output).not.toContain("xylophone");
	});

	// 3. Strategy fallback: when strategy=vector but no retriever, falls back to keyword.
	it("strategy fallback: vector strategy without retriever falls back to keyword (with warn)", async () => {
		const log = { warn: vi.fn() };
		const selector = new RelevanceSelector({ log });
		const manager = new BasicContextManager({
			selector,
			relevance: { strategy: "vector", threshold: 0 },
		});
		const sources = [
			makeSource("apple banana", 50),
			makeSource("orange grape", 50),
		];
		const output = await manager.buildContext(sources, BUDGET, {
			relevanceQuery: "apple",
		});
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ strategy: "vector", fallback: "keyword" }),
			expect.any(String),
		);
		expect(output).toContain("apple");
	});

	// Backward-compat: no relevanceQuery → behaves exactly like Phase 0 (priority sort + first-fit).
	it("backward compat: undefined relevanceQuery preserves Phase 0 priority-only behavior", async () => {
		const manager = new BasicContextManager();
		const sources = [
			makeSource("low priority", 10, 4),
			makeSource("high priority", 100, 4),
			makeSource("mid priority", 50, 4),
		];
		const output = await manager.buildContext(sources, BUDGET);
		// No relevance filter → priority sort wins.
		expect(output).toBe(
			["high priority", "mid priority", "low priority"].join("\n\n---\n\n"),
		);
	});

	// Sanity: relevance filter happens BEFORE priority sort.
	it("relevance filter runs before priority sort", async () => {
		// Inject a vector retriever that gives the LOW-priority source the
		// highest relevance — confirms priority sort kicks in only after
		// the relevance filter has already preserved it.
		const retriever: VectorRetriever = {
			score: async ({ contents }) => {
				return contents.map((c) =>
					c.startsWith("low") ? 1.0 : c.startsWith("mid") ? 0.6 : 0.0,
				);
			},
		};
		const selector = new RelevanceSelector({ retriever });
		const manager = new BasicContextManager({
			selector,
			relevance: { strategy: "vector", threshold: 0.55 },
		});
		const sources = [
			makeSource("high priority unrelated", 100, 4),
			makeSource("mid priority partial", 50, 4),
			makeSource("low priority bullseye", 10, 4),
		];
		const output = await manager.buildContext(sources, BUDGET, {
			relevanceQuery: "any",
		});
		// "high priority unrelated" should be filtered out (vector score 0.0).
		expect(output).not.toContain("high priority unrelated");
		// Among survivors mid (priority 50) > low (priority 10).
		expect(output).toBe(
			["mid priority partial", "low priority bullseye"].join("\n\n---\n\n"),
		);
	});
});
