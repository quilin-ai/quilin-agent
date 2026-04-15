import type { ContextSource } from "./source-types.js";
import { estimateTokens } from "./tokens.js";

export interface MemoryRecallResult {
	readonly content: string;
	readonly score: number;
	readonly timestamp: number;
	readonly layer: "working" | "episodic" | "semantic" | "skill";
}

/**
 * 将 OmniMem recall 结果转换为 ContextSource 列表。
 * 不做 extractKeywords——直接由调用方传入 userInput 作为 recall query，
 * 让 OmniMem 自己做 query expansion 和 CJK n-gram 检索。
 */
export function recallResultsToSources(
	results: readonly MemoryRecallResult[],
	options: { threshold: number },
): ContextSource[] {
	return results
		.filter((result) => result.score >= options.threshold)
		.map((result) => ({
			sourceType: "memory" as const,
			content: result.content,
			tokenCount: estimateTokens(result.content),
			relevanceScore: result.score,
			timestamp: result.timestamp,
			metadata: { layer: result.layer },
			isExternal: true,
		}));
}
