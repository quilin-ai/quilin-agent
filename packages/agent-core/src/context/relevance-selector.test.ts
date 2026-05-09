import { describe, expect, it, vi } from "vitest";
import {
	createLLMReranker,
	createMCPVectorRetriever,
	DEFAULT_RELEVANCE_THRESHOLD,
	type LLMReranker,
	RelevanceSelector,
	tokenize,
	type VectorRetriever,
} from "./relevance-selector.js";
import type { ContextSource } from "./types.js";

function makeSource(content: string, priority = 50): ContextSource {
	return {
		type: "memory",
		content,
		priority,
		tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
	};
}

function makeLog() {
	return { warn: vi.fn() };
}

describe("RelevanceSelector — keyword strategy (BM25)", () => {
	it("scores BM25-relevant sources higher than unrelated ones", async () => {
		const sources = [
			makeSource("apple banana cherry"),
			makeSource("dog cat fish"),
			makeSource("apple pie recipe"),
		];
		const selector = new RelevanceSelector({ log: makeLog() });
		const scored = await selector.select("apple", sources, {
			strategy: "keyword",
			threshold: 0,
		});

		// At least the apple-mentioning sources should outrank the dog/cat one.
		expect(scored.length).toBe(3);
		expect(scored[0].source.content).toMatch(/apple/);
		expect(scored[scored.length - 1].source.content).toBe("dog cat fish");
	});

	it("returns empty for empty source array", async () => {
		const selector = new RelevanceSelector({ log: makeLog() });
		const result = await selector.select("anything", [], {});
		expect(result).toEqual([]);
	});
});

describe("RelevanceSelector — vector strategy", () => {
	it("uses the injected retriever when strategy=vector", async () => {
		const retriever: VectorRetriever = {
			score: vi
				.fn<VectorRetriever["score"]>()
				.mockResolvedValue([0.9, 0.1, 0.5]),
		};
		const selector = new RelevanceSelector({ retriever, log: makeLog() });
		const sources = [makeSource("a"), makeSource("b"), makeSource("c")];
		const scored = await selector.select("query", sources, {
			strategy: "vector",
			threshold: 0,
		});

		expect(retriever.score).toHaveBeenCalledTimes(1);
		// 0.9 normalizes to 1.0, 0.1 normalizes to 0.0, 0.5 to 0.5
		expect(scored[0].source.content).toBe("a");
		expect(scored[scored.length - 1].source.content).toBe("b");
	});

	it("falls back to keyword strategy when retriever is missing (with logger.warn)", async () => {
		const log = makeLog();
		const selector = new RelevanceSelector({ log });
		const sources = [makeSource("apple"), makeSource("orange")];
		const scored = await selector.select("apple", sources, {
			strategy: "vector",
			threshold: 0,
		});

		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ strategy: "vector", fallback: "keyword" }),
			expect.any(String),
		);
		expect(scored.length).toBeGreaterThan(0);
	});
});

describe("RelevanceSelector — llm_rerank strategy", () => {
	it("uses the injected reranker when strategy=llm_rerank", async () => {
		const reranker: LLMReranker = {
			rerank: vi
				.fn<LLMReranker["rerank"]>()
				.mockResolvedValue([0.2, 0.95, 0.4]),
		};
		const selector = new RelevanceSelector({ reranker, log: makeLog() });
		const sources = [
			makeSource("first"),
			makeSource("second"),
			makeSource("third"),
		];
		const scored = await selector.select("query", sources, {
			strategy: "llm_rerank",
			threshold: 0,
		});

		expect(reranker.rerank).toHaveBeenCalledTimes(1);
		expect(scored[0].source.content).toBe("second");
	});
});

describe("RelevanceSelector — threshold boundary", () => {
	it("includes the source whose normalized score is exactly at the threshold", async () => {
		const retriever: VectorRetriever = {
			score: vi
				.fn<VectorRetriever["score"]>()
				.mockResolvedValue([1.0, 0.5, 0.0]),
		};
		const selector = new RelevanceSelector({ retriever, log: makeLog() });
		const sources = [makeSource("a"), makeSource("b"), makeSource("c")];
		// After normalize: [1, 0.5, 0]. threshold=0.5 → keep "a" and "b".
		const scored = await selector.select("query", sources, {
			strategy: "vector",
			threshold: 0.5,
		});

		expect(scored.length).toBe(2);
		expect(scored.map((s) => s.source.content)).toEqual(["a", "b"]);
	});

	it("drops a source just below the threshold and keeps just-above", async () => {
		const retriever: VectorRetriever = {
			score: vi
				.fn<VectorRetriever["score"]>()
				.mockResolvedValue([1.0, 0.66, 0.0]),
		};
		const selector = new RelevanceSelector({ retriever, log: makeLog() });
		const sources = [makeSource("a"), makeSource("b"), makeSource("c")];
		// After normalize: [1, 0.66, 0]. threshold=0.65 → keep "a" and "b".
		const scoredAbove = await selector.select("q", sources, {
			strategy: "vector",
			threshold: 0.65,
		});
		expect(scoredAbove.map((s) => s.source.content)).toEqual(["a", "b"]);

		// Now require threshold just above 0.66 — only "a" survives.
		const retriever2: VectorRetriever = {
			score: vi
				.fn<VectorRetriever["score"]>()
				.mockResolvedValue([1.0, 0.66, 0.0]),
		};
		const selector2 = new RelevanceSelector({
			retriever: retriever2,
			log: makeLog(),
		});
		const scoredJustAbove = await selector2.select("q", sources, {
			strategy: "vector",
			threshold: 0.67,
		});
		expect(scoredJustAbove.map((s) => s.source.content)).toEqual(["a"]);
	});
});

describe("RelevanceSelector — robustness", () => {
	it("returns empty when query is empty string and threshold > 0", async () => {
		const selector = new RelevanceSelector({ log: makeLog() });
		const sources = [makeSource("apple"), makeSource("orange")];
		const scored = await selector.select("   ", sources, {
			strategy: "keyword",
			threshold: 0.1,
		});
		expect(scored).toEqual([]);
	});

	it("returns all sources at neutral score when query is empty and threshold=0", async () => {
		const selector = new RelevanceSelector({ log: makeLog() });
		const sources = [makeSource("apple"), makeSource("orange")];
		const scored = await selector.select("", sources, {
			strategy: "keyword",
			threshold: 0,
		});
		expect(scored.length).toBe(2);
		for (const s of scored) {
			expect(s.score).toBe(0);
		}
	});

	it("respects topK by truncating after sort", async () => {
		const sources = [
			makeSource("apple banana"),
			makeSource("apple"),
			makeSource("banana"),
			makeSource("orange"),
		];
		const selector = new RelevanceSelector({ log: makeLog() });
		const scored = await selector.select("apple", sources, {
			strategy: "keyword",
			threshold: 0,
			topK: 2,
		});
		expect(scored.length).toBe(2);
	});

	it("breaks score ties stably by original input order", async () => {
		const retriever: VectorRetriever = {
			score: vi
				.fn<VectorRetriever["score"]>()
				.mockResolvedValue([0.5, 0.5, 0.5]),
		};
		const selector = new RelevanceSelector({ retriever, log: makeLog() });
		const sources = [
			makeSource("first"),
			makeSource("second"),
			makeSource("third"),
		];
		// All identical raw scores → normalize collapses to 0; threshold 0
		// keeps everything; ordering is by originalIndex.
		const scored = await selector.select("q", sources, {
			strategy: "vector",
			threshold: 0,
		});
		expect(scored.map((s) => s.source.content)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(scored.map((s) => s.originalIndex)).toEqual([0, 1, 2]);
	});

	it("handles sources whose tokenized content is empty (no scoring fields)", async () => {
		const sources = [
			makeSource(""),
			makeSource("apple"),
			makeSource("!!!  ???"),
		];
		const selector = new RelevanceSelector({ log: makeLog() });
		const scored = await selector.select("apple", sources, {
			strategy: "keyword",
			threshold: 0,
		});
		// Empty / punctuation-only sources tokenize to no terms → score 0.
		// "apple" should rank first.
		expect(scored.length).toBeGreaterThan(0);
		expect(scored[0].source.content).toBe("apple");
	});

	it("falls back to keyword when vector retriever returns mismatched length", async () => {
		const log = makeLog();
		const retriever: VectorRetriever = {
			// returns wrong-length array → fallback path
			score: vi.fn<VectorRetriever["score"]>().mockResolvedValue([0.5]),
		};
		const selector = new RelevanceSelector({ retriever, log });
		const sources = [makeSource("apple banana"), makeSource("orange")];
		const scored = await selector.select("apple", sources, {
			strategy: "vector",
			threshold: 0,
		});
		expect(log.warn).toHaveBeenCalled();
		expect(scored.length).toBeGreaterThan(0);
		expect(scored[0].source.content).toMatch(/apple/);
	});

	it("falls back to keyword when vector retriever throws", async () => {
		const log = makeLog();
		const retriever: VectorRetriever = {
			score: vi
				.fn<VectorRetriever["score"]>()
				.mockRejectedValue(new Error("boom")),
		};
		const selector = new RelevanceSelector({ retriever, log });
		const sources = [makeSource("apple"), makeSource("orange")];
		const scored = await selector.select("apple", sources, {
			strategy: "vector",
			threshold: 0,
		});
		expect(log.warn).toHaveBeenCalled();
		expect(scored.length).toBeGreaterThan(0);
	});

	it("uses default threshold of 0.65 when not provided", async () => {
		expect(DEFAULT_RELEVANCE_THRESHOLD).toBe(0.65);
		const retriever: VectorRetriever = {
			score: vi
				.fn<VectorRetriever["score"]>()
				.mockResolvedValue([1.0, 0.5, 0.0]),
		};
		const selector = new RelevanceSelector({ retriever, log: makeLog() });
		const sources = [makeSource("a"), makeSource("b"), makeSource("c")];
		// normalized: [1, 0.5, 0] — only 1.0 survives default 0.65 cutoff.
		const scored = await selector.select("q", sources, { strategy: "vector" });
		expect(scored.map((s) => s.source.content)).toEqual(["a"]);
	});

	it("supports rerankEnabled to blend keyword + reranker scores", async () => {
		const reranker: LLMReranker = {
			rerank: vi.fn<LLMReranker["rerank"]>().mockResolvedValue([1.0, 0.0]),
		};
		const selector = new RelevanceSelector({ reranker, log: makeLog() });
		const sources = [makeSource("apple"), makeSource("apple")];
		const scored = await selector.select("apple", sources, {
			strategy: "keyword",
			rerankEnabled: true,
			threshold: 0,
		});
		expect(reranker.rerank).toHaveBeenCalledTimes(1);
		expect(scored.length).toBe(2);
		// First source got rerank 1.0, second got 0.0 → first should rank higher.
		expect(scored[0].source.content).toBe("apple");
		expect(scored[0].originalIndex).toBe(0);
	});
});

describe("createMCPVectorRetriever", () => {
	it("maps quilin-mem recall payload to per-content scores", async () => {
		const callTool = vi
			.fn<(name: string, args: Record<string, unknown>) => Promise<string>>()
			.mockResolvedValue(
				JSON.stringify({
					results: [
						{ index: 1, score: 0.9 },
						{ index: 0, score: 0.4 },
					],
				}),
			);
		const retriever = createMCPVectorRetriever({ callTool });
		const scores = await retriever.score({
			query: "q",
			contents: ["a", "b"],
		});
		expect(scores).toEqual([0.4, 0.9]);
		expect(callTool).toHaveBeenCalledWith(
			"recall",
			expect.objectContaining({ query: "q" }),
		);
	});

	it("returns zero scores when payload is malformed", async () => {
		const callTool = vi
			.fn<(name: string, args: Record<string, unknown>) => Promise<string>>()
			.mockResolvedValue("not json");
		const retriever = createMCPVectorRetriever({ callTool });
		const scores = await retriever.score({
			query: "q",
			contents: ["a", "b"],
		});
		expect(scores).toEqual([0, 0]);
	});
});

describe("createLLMReranker", () => {
	it("parses JSON scores from the LLM response", async () => {
		const llm = {
			chat: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					scores: [
						{ index: 0, score: 0.1 },
						{ index: 1, score: 0.9 },
					],
				}),
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop" as const,
			}),
		};
		const reranker = createLLMReranker({ llm });
		const scores = await reranker.rerank({
			query: "q",
			contents: ["a", "b"],
		});
		expect(scores).toEqual([0.1, 0.9]);
	});

	it("returns zero scores when LLM response is non-JSON", async () => {
		const llm = {
			chat: vi.fn().mockResolvedValue({
				content: "i refuse to follow instructions",
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop" as const,
			}),
		};
		const reranker = createLLMReranker({ llm });
		const scores = await reranker.rerank({
			query: "q",
			contents: ["a", "b"],
		});
		expect(scores).toEqual([0, 0]);
	});
});

describe("tokenize", () => {
	it("lowercases and splits on non-letter/digit boundaries", () => {
		expect(tokenize("Hello, World! 123")).toEqual(["hello", "world", "123"]);
	});

	it("handles CJK unicode letters via \\p{L}", () => {
		expect(tokenize("你好 世界")).toEqual(["你好", "世界"]);
	});
});
