import type { ContextManager, ContextSource, TokenBudget } from "./types.js";

export class BasicContextManager implements ContextManager {
	async buildContext(
		sources: readonly ContextSource[],
		budget: TokenBudget,
	): Promise<string> {
		void sources;
		void budget;
		throw new Error("Not implemented");
	}
}
