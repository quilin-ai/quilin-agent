import {
	DEFAULT_RELEVANCE_STRATEGY,
	DEFAULT_RELEVANCE_THRESHOLD,
	type RelevanceConfig,
	type RelevanceLogSink,
	RelevanceSelector,
} from "./relevance-selector.js";
import { estimateTokens } from "./tokens.js";
import type {
	BuildContextOptions,
	ContextManager,
	ContextSource,
	TokenBudget,
} from "./types.js";

export const DEFAULT_CONTEXT_BUDGET: TokenBudget = {
	// NOTE: per-category limits not yet enforced — Phase 0 uses budget.total only.
	total: 4096,
	system: 1024,
	memory: 1024,
	tools: 512,
	conversation: 1024,
	reserved: 512,
};

export function createSystemContextSource(content: string): ContextSource {
	return {
		type: "system",
		content,
		priority: 100,
		tokenEstimate: estimateTokens(content),
	};
}

export interface BasicContextManagerOptions {
	/**
	 * Optional injected RelevanceSelector. When omitted, a default
	 * keyword-strategy selector is created lazily on first use.
	 */
	readonly selector?: RelevanceSelector;
	/**
	 * Default relevance config used when callers do not provide one through
	 * `BuildContextOptions`. Lets product code wire user-config defaults at
	 * construction time without re-passing them on every `buildContext` call.
	 */
	readonly relevance?: RelevanceConfig;
	/**
	 * Optional logger surface forwarded to the default selector so fallback
	 * warnings (e.g. "vector strategy without retriever") surface in
	 * production stdout. Tests can omit this to keep selector quiet.
	 */
	readonly log?: RelevanceLogSink;
}

/**
 * Phase 0 ContextManager — priority sort + first-fit greedy fill.
 * Phase 1 (QUI-145) adds an optional relevance pre-filter that runs
 * BEFORE priority sort when callers pass `relevanceQuery` through
 * `BuildContextOptions`. When `relevanceQuery` is undefined the manager
 * falls back to Phase 0 behavior (BACKWARD COMPATIBLE).
 */
export class BasicContextManager implements ContextManager {
	private readonly selector: RelevanceSelector;
	private readonly defaultRelevance: RelevanceConfig;

	constructor(options: BasicContextManagerOptions = {}) {
		// Default selector uses a no-op logger unless the caller supplies
		// one. We deliberately do NOT statically import `../logger.js` here
		// because tests in repl.test.ts mock that module with a factory
		// that references TDZ-bound outer variables; any new statically-
		// imported consumer of logger.js trips that hoisting. Production
		// wiring (REPL boot path) injects the logger explicitly via
		// `options.log` or `options.selector`.
		this.selector =
			options.selector ??
			new RelevanceSelector(options.log != null ? { log: options.log } : {});
		this.defaultRelevance = options.relevance ?? {
			threshold: DEFAULT_RELEVANCE_THRESHOLD,
			strategy: DEFAULT_RELEVANCE_STRATEGY,
			rerankEnabled: false,
		};
	}

	async buildContext(
		sources: readonly ContextSource[],
		budget: TokenBudget,
		options: BuildContextOptions = {},
	): Promise<string> {
		// 1. Relevance filter (only when a query is provided — preserves
		// Phase 0 priority-only behavior for callers that don't pass one).
		const filtered = await this.applyRelevance(sources, options);

		// 2. Priority sort (existing Phase 0 behavior).
		const sortedSources = filtered
			.map((source, index) => ({ source, index }))
			.sort(
				(left, right) =>
					right.source.priority - left.source.priority ||
					left.index - right.index,
			);

		// 3. First-fit greedy fill against budget.total.
		let usedTokens = 0;
		const selectedContent: string[] = [];
		for (const { source } of sortedSources) {
			if (usedTokens + source.tokenEstimate > budget.total) {
				// Phase 0: first-fit — breaks on first oversized source.
				break;
			}
			usedTokens += source.tokenEstimate;
			selectedContent.push(source.content);
		}

		return selectedContent.join("\n\n---\n\n");
	}

	private async applyRelevance(
		sources: readonly ContextSource[],
		options: BuildContextOptions,
	): Promise<readonly ContextSource[]> {
		const query = options.relevanceQuery;
		if (query == null) return sources;
		if (sources.length === 0) return sources;
		const scored = await this.selector.select(
			query,
			sources,
			this.defaultRelevance,
		);
		// Preserve original input order so the priority sort step is the only
		// authority on placement; the selector here is just a filter.
		const kept = new Set(scored.map((s) => s.originalIndex));
		return sources.filter((_, idx) => kept.has(idx));
	}
}
