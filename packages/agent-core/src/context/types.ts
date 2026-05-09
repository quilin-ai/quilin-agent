/** 上下文来源 — 来自 02-Context spec §ContextSource */
export interface ContextSource {
	readonly type:
		| "system"
		| "memory"
		| "environment"
		| "temporal"
		| "user_profile";
	readonly content: string;
	readonly priority: number;
	readonly tokenEstimate: number;
}

/** Token 预算 */
export interface TokenBudget {
	readonly total: number;
	readonly system: number;
	readonly memory: number;
	readonly tools: number;
	readonly conversation: number;
	readonly reserved: number;
}

/** 相关性评分策略 — see relevance-selector.ts */
export type RelevanceStrategy = "keyword" | "vector" | "llm_rerank";

/**
 * Build-time options forwarded from `runAgentLoop` into `ContextManager.buildContext`.
 * `relevanceQuery` is optional; when undefined, callers retain Phase 0
 * priority-only behavior (backward compatible).
 */
export interface BuildContextOptions {
	readonly relevanceQuery?: string;
}

/** ContextManager 接口 */
export interface ContextManager {
	buildContext(
		sources: readonly ContextSource[],
		budget: TokenBudget,
		options?: BuildContextOptions,
	): Promise<string>;
}
