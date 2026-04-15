import { estimateTokens } from "./tokens.js";
import type { ContextManager, ContextSource, TokenBudget } from "./types.js";

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

export class BasicContextManager implements ContextManager {
	async buildContext(
		sources: readonly ContextSource[],
		budget: TokenBudget,
	): Promise<string> {
		let usedTokens = 0;
		const selectedContent: string[] = [];
		const sortedSources = sources
			.map((source, index) => ({ source, index }))
			.sort(
				(left, right) =>
					right.source.priority - left.source.priority ||
					left.index - right.index,
			);

		for (const { source } of sortedSources) {
			if (usedTokens + source.tokenEstimate > budget.total) {
				// Phase 0: first-fit — breaks on first oversized source. Phase 1: switch to greedy fill.
				break;
			}

			usedTokens += source.tokenEstimate;
			selectedContent.push(source.content);
		}

		return selectedContent.join("\n\n---\n\n");
	}
}
