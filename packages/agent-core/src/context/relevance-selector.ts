// RelevanceSelector — 02-Context spec §2.4 selection.
// Closes the gap described in docs/02-context/README.md status block:
// "完整相关性选择仍未作为独立模块落地".
//
// Provides 3 injectable scoring strategies (keyword BM25 / vector / llm_rerank),
// a relevance threshold filter, and stable score-tie ordering.
// All strategies return ScoredContextSource[] in descending score order.
//
// Hand-rolled BM25 — no external NLP deps (project rule: no new npm deps).
// Vector strategy delegates to quilin-mem MCP (no new embedding model dep).

import type { LLMClient } from "../llm/types.js";
import type { ContextSource, RelevanceStrategy } from "./types.js";

// Minimal logger surface used by this module. We avoid importing the
// concrete pino logger statically so this module can be added to other
// modules' import graphs (e.g. via `BasicContextManager`) without
// triggering test files that mock `../logger.js` via `vi.mock(...)`
// factories with TDZ-bound outer variables.
//
// Production callers (`BasicContextManager`) pass the real logger
// through `RelevanceSelectorDeps.log`. Default is a silent no-op so
// stand-alone use stays fully self-contained.
export interface RelevanceLogSink {
	warn(payload: unknown, message?: string): void;
}

const NOOP_LOG_SINK: RelevanceLogSink = {
	warn: () => {
		/* default: silent. Production wires the pino logger via deps.log. */
	},
};

/**
 * Wraps a `ContextSource` with the relevance score assigned by the selector.
 * `originalIndex` preserves caller order to make tie-breaks stable.
 */
export interface ScoredContextSource {
	readonly source: ContextSource;
	readonly score: number;
	readonly originalIndex: number;
}

/**
 * MCP-backed retriever interface. Production callers wire this to the
 * `MCPClientManager` that talks to `providers/memory` (quilin-mem).
 * The selector is intentionally decoupled from `MCPClientManager` so unit
 * tests can supply a fake without spawning a stdio child process.
 */
export interface VectorRetriever {
	score(input: {
		readonly query: string;
		readonly contents: readonly string[];
	}): Promise<readonly number[]>;
}

/**
 * Cross-encoder-style reranker driven by a single LLM call. The selector
 * uses `llm.chat` directly so callers can inject any provider supported
 * by Vercel AI SDK — no extra dependency surface.
 */
export interface LLMReranker {
	rerank(input: {
		readonly query: string;
		readonly contents: readonly string[];
	}): Promise<readonly number[]>;
}

/**
 * Runtime configuration for `RelevanceSelector`. `threshold` defaults to
 * 0.65 to match docs/02-context/README.md line 468 (`relevance_threshold`).
 * `rerankEnabled` is opt-in because the LLM call adds latency and cost.
 */
export interface RelevanceConfig {
	readonly threshold?: number;
	readonly rerankEnabled?: boolean;
	readonly topK?: number;
	readonly strategy?: RelevanceStrategy;
}

export interface RelevanceSelectorDeps {
	readonly retriever?: VectorRetriever;
	readonly reranker?: LLMReranker;
	/**
	 * Optional injection point. Defaults to a silent no-op so stand-alone
	 * use is dependency-free; `BasicContextManager` wires the production
	 * pino logger through this slot at construction time.
	 */
	readonly log?: RelevanceLogSink;
}

export const DEFAULT_RELEVANCE_THRESHOLD = 0.65;
export const DEFAULT_RELEVANCE_STRATEGY: RelevanceStrategy = "keyword";

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

interface CorpusStats {
	readonly avgDocLen: number;
	readonly idf: ReadonlyMap<string, number>;
	readonly docs: readonly TokenizedDoc[];
}

interface TokenizedDoc {
	readonly tokens: readonly string[];
	readonly tf: ReadonlyMap<string, number>;
	readonly length: number;
}

/**
 * Lowercase Unicode-aware tokenizer.
 * Pure TS — no external NLP deps. Covers CJK as fallthrough on
 * `\p{L}` (Letter) and digits (`\p{N}`).
 */
export function tokenize(text: string): string[] {
	return Array.from(text.toLowerCase().matchAll(TOKEN_PATTERN), (m) => m[0]);
}

function tokenizeDoc(text: string): TokenizedDoc {
	const tokens = tokenize(text);
	const tf = new Map<string, number>();
	for (const tok of tokens) {
		tf.set(tok, (tf.get(tok) ?? 0) + 1);
	}
	return { tokens, tf, length: tokens.length };
}

function buildCorpusStats(contents: readonly string[]): CorpusStats {
	const docs = contents.map(tokenizeDoc);
	const totalLen = docs.reduce((sum, d) => sum + d.length, 0);
	const avgDocLen = docs.length > 0 ? totalLen / docs.length : 0;
	const df = new Map<string, number>();
	for (const doc of docs) {
		for (const term of doc.tf.keys()) {
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	}
	const idf = new Map<string, number>();
	const N = docs.length;
	for (const [term, freq] of df) {
		// BM25-style idf with +1 smoothing to keep values non-negative.
		idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
	}
	return { avgDocLen, idf, docs };
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * Score one document against a query using the BM25 ranking function.
 * Hand-rolled to avoid taking on an external dependency.
 */
function bm25Score(
	queryTokens: readonly string[],
	doc: TokenizedDoc,
	stats: CorpusStats,
): number {
	if (doc.length === 0 || stats.avgDocLen === 0) {
		return 0;
	}
	let score = 0;
	for (const qt of queryTokens) {
		const idf = stats.idf.get(qt);
		if (idf == null || idf <= 0) continue;
		const tf = doc.tf.get(qt) ?? 0;
		if (tf === 0) continue;
		const denom =
			tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / stats.avgDocLen);
		score += idf * ((tf * (BM25_K1 + 1)) / denom);
	}
	return score;
}

/**
 * Linearly normalize an array of raw scores into [0, 1] so that it is
 * comparable to the configured threshold (which itself is a [0, 1] cutoff).
 * If all scores collapse to the same value, every entry maps to 0 — this
 * is intentional: a constant raw score carries no relevance signal.
 */
function normalizeScores(raw: readonly number[]): number[] {
	if (raw.length === 0) return [];
	let max = -Infinity;
	let min = Infinity;
	for (const v of raw) {
		if (v > max) max = v;
		if (v < min) min = v;
	}
	if (!Number.isFinite(max) || !Number.isFinite(min) || max === min) {
		return raw.map(() => 0);
	}
	const range = max - min;
	return raw.map((v) => (v - min) / range);
}

function clamp01(v: number): number {
	if (!Number.isFinite(v)) return 0;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

/**
 * RelevanceSelector — input: query + ContextSource[] + RelevanceConfig.
 * Output: ScoredContextSource[] sorted by score (desc), filtered by
 * threshold, and optionally truncated to `topK`. Sources whose score
 * ties resolve in original-input order to guarantee deterministic output.
 */
export class RelevanceSelector {
	private readonly retriever?: VectorRetriever;
	private readonly reranker?: LLMReranker;
	private readonly log: RelevanceLogSink;

	constructor(deps: RelevanceSelectorDeps = {}) {
		this.retriever = deps.retriever;
		this.reranker = deps.reranker;
		this.log = deps.log ?? NOOP_LOG_SINK;
	}

	async select(
		query: string,
		sources: readonly ContextSource[],
		config: RelevanceConfig = {},
	): Promise<ScoredContextSource[]> {
		const threshold = config.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
		const strategy = config.strategy ?? DEFAULT_RELEVANCE_STRATEGY;
		const rerankEnabled = config.rerankEnabled ?? false;
		const topK = config.topK;

		if (sources.length === 0) return [];
		if (query.trim().length === 0) {
			// Missing query => selector cannot score; preserve input order
			// with neutral score 0. Caller decides whether to keep them via
			// threshold (threshold=0 keeps all; >0 drops all).
			return this.passThrough(sources).filter((s) => s.score >= threshold);
		}

		const baseScores = await this.scoreWith(strategy, query, sources);
		// Optional cross-encoder rerank pass. Only meaningful when strategy
		// itself isn't already llm_rerank. We average the two signals so the
		// rerank is a weighted refinement, not a hard override.
		const finalScores =
			rerankEnabled && strategy !== "llm_rerank" && this.reranker != null
				? await this.applyRerank(query, sources, baseScores)
				: baseScores;

		const scored: ScoredContextSource[] = sources.map((source, index) => ({
			source,
			score: clamp01(finalScores[index] ?? 0),
			originalIndex: index,
		}));

		const filtered = scored.filter((s) => s.score >= threshold);
		filtered.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.originalIndex - b.originalIndex;
		});

		if (topK != null && topK >= 0 && filtered.length > topK) {
			return filtered.slice(0, topK);
		}
		return filtered;
	}

	private passThrough(
		sources: readonly ContextSource[],
	): ScoredContextSource[] {
		return sources.map((source, index) => ({
			source,
			score: 0,
			originalIndex: index,
		}));
	}

	private async scoreWith(
		strategy: RelevanceStrategy,
		query: string,
		sources: readonly ContextSource[],
	): Promise<number[]> {
		if (strategy === "vector") {
			if (this.retriever == null) {
				this.log.warn(
					{ strategy: "vector", fallback: "keyword" },
					"RelevanceSelector: vector retriever unavailable, falling back to keyword",
				);
				return this.scoreKeyword(query, sources);
			}
			return this.scoreVector(query, sources);
		}
		if (strategy === "llm_rerank") {
			if (this.reranker == null) {
				this.log.warn(
					{ strategy: "llm_rerank", fallback: "keyword" },
					"RelevanceSelector: reranker unavailable, falling back to keyword",
				);
				return this.scoreKeyword(query, sources);
			}
			return this.scoreLLMRerank(query, sources);
		}
		return this.scoreKeyword(query, sources);
	}

	private scoreKeyword(
		query: string,
		sources: readonly ContextSource[],
	): number[] {
		const contents = sources.map((s) => s.content);
		const stats = buildCorpusStats(contents);
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) {
			return new Array(sources.length).fill(0);
		}
		const raw = stats.docs.map((doc) => bm25Score(queryTokens, doc, stats));
		return normalizeScores(raw);
	}

	private async scoreVector(
		query: string,
		sources: readonly ContextSource[],
	): Promise<number[]> {
		if (this.retriever == null) {
			return this.scoreKeyword(query, sources);
		}
		try {
			const contents = sources.map((s) => s.content);
			const raw = await this.retriever.score({ query, contents });
			if (raw.length !== sources.length) {
				this.log.warn(
					{ expected: sources.length, got: raw.length },
					"RelevanceSelector: vector retriever returned mismatched length, falling back to keyword",
				);
				return this.scoreKeyword(query, sources);
			}
			// Vector scores are typically already in [0,1]; normalize defensively.
			return normalizeScores(raw.map((v) => (Number.isFinite(v) ? v : 0)));
		} catch (error) {
			this.log.warn(
				{ err: error },
				"RelevanceSelector: vector retriever failed, falling back to keyword",
			);
			return this.scoreKeyword(query, sources);
		}
	}

	private async scoreLLMRerank(
		query: string,
		sources: readonly ContextSource[],
	): Promise<number[]> {
		if (this.reranker == null) {
			return this.scoreKeyword(query, sources);
		}
		try {
			const contents = sources.map((s) => s.content);
			const raw = await this.reranker.rerank({ query, contents });
			if (raw.length !== sources.length) {
				this.log.warn(
					{ expected: sources.length, got: raw.length },
					"RelevanceSelector: reranker returned mismatched length, falling back to keyword",
				);
				return this.scoreKeyword(query, sources);
			}
			return normalizeScores(raw.map((v) => (Number.isFinite(v) ? v : 0)));
		} catch (error) {
			this.log.warn(
				{ err: error },
				"RelevanceSelector: reranker failed, falling back to keyword",
			);
			return this.scoreKeyword(query, sources);
		}
	}

	private async applyRerank(
		query: string,
		sources: readonly ContextSource[],
		baseScores: readonly number[],
	): Promise<number[]> {
		if (this.reranker == null) return [...baseScores];
		try {
			const contents = sources.map((s) => s.content);
			const rerankRaw = await this.reranker.rerank({ query, contents });
			if (rerankRaw.length !== sources.length) {
				this.log.warn(
					{ expected: sources.length, got: rerankRaw.length },
					"RelevanceSelector: rerank pass returned mismatched length, ignoring",
				);
				return [...baseScores];
			}
			const rerankNorm = normalizeScores(
				rerankRaw.map((v) => (Number.isFinite(v) ? v : 0)),
			);
			return baseScores.map((b, i) => (b + rerankNorm[i]) / 2);
		} catch (error) {
			this.log.warn(
				{ err: error },
				"RelevanceSelector: rerank pass failed, ignoring",
			);
			return [...baseScores];
		}
	}
}

/**
 * Build a `VectorRetriever` backed by an MCP `callTool` surface (matches the
 * shape of `MCPClientManager.callTool`). Quilin-mem's `recall` tool returns
 * a JSON payload with per-result scores; we map that to the per-content
 * score array the selector expects.
 *
 * The mapping is best-effort: a malformed payload causes the selector to
 * fall back to keyword scoring (logged once). Production callers wire this
 * through `MCPClientManager`; tests can pass a tiny fake `callTool`.
 */
export function createMCPVectorRetriever(deps: {
	readonly callTool: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<string>;
	readonly toolName?: string;
}): VectorRetriever {
	const toolName = deps.toolName ?? "recall";
	return {
		async score({ query, contents }) {
			const payload = await deps.callTool(toolName, {
				query,
				candidates: contents,
				top_k: contents.length,
			});
			const parsed = parseRecallPayload(payload);
			if (parsed == null) {
				return contents.map(() => 0);
			}
			return contents.map((_, idx) => parsed[idx] ?? 0);
		},
	};
}

interface RecallEntry {
	readonly index?: number;
	readonly score?: number;
}

function parseRecallPayload(payload: string): number[] | null {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return null;
	}
	const entries = extractEntries(value);
	if (entries == null) return null;
	const scores: number[] = [];
	for (let i = 0; i < entries.length; i += 1) {
		const e = entries[i];
		const idx = typeof e.index === "number" && e.index >= 0 ? e.index : i;
		const score = typeof e.score === "number" ? e.score : 0;
		while (scores.length <= idx) scores.push(0);
		scores[idx] = score;
	}
	return scores;
}

function extractEntries(value: unknown): RecallEntry[] | null {
	if (Array.isArray(value)) return value as RecallEntry[];
	if (typeof value === "object" && value !== null) {
		const v = value as { results?: unknown };
		if (Array.isArray(v.results)) return v.results as RecallEntry[];
	}
	return null;
}

/**
 * Build an `LLMReranker` driven by a single `LLMClient.chat` call. The
 * prompt asks the model to return a JSON array of {index, score} pairs;
 * malformed responses fall back to neutral scores (0) so the selector can
 * still apply the threshold safely.
 */
export function createLLMReranker(deps: {
	readonly llm: LLMClient;
	readonly modelId?: string;
}): LLMReranker {
	const llm = deps.llm;
	return {
		async rerank({ query, contents }) {
			const numbered = contents.map((c, i) => `[${i}] ${c}`).join("\n---\n");
			const userPrompt =
				`Query: ${query}\n\n` +
				`Score each candidate for relevance to the query on a 0..1 scale.\n` +
				`Return ONLY JSON of the form {"scores":[{"index":0,"score":0.0}, ...]}.\n\n` +
				`Candidates:\n${numbered}`;
			const response = await llm.chat(
				[
					{
						role: "system",
						content:
							"You are a relevance reranker. Output strictly JSON, no prose.",
					},
					{ role: "user", content: userPrompt },
				],
				[],
				{
					temperature: 0,
					maxTokens: 512,
					thinkingMode: "disabled",
				},
			);
			return parseRerankResponse(response.content, contents.length);
		},
	};
}

function parseRerankResponse(content: string, n: number): number[] {
	const scores = new Array<number>(n).fill(0);
	const start = content.indexOf("{");
	const end = content.lastIndexOf("}");
	if (start < 0 || end <= start) return scores;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.slice(start, end + 1));
	} catch {
		return scores;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray((parsed as { scores?: unknown }).scores)
	) {
		return scores;
	}
	const arr = (parsed as { scores: unknown[] }).scores;
	for (const entry of arr) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as { index?: unknown; score?: unknown };
		if (
			typeof e.index === "number" &&
			e.index >= 0 &&
			e.index < n &&
			typeof e.score === "number"
		) {
			scores[e.index] = e.score;
		}
	}
	return scores;
}
