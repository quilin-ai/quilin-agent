export type ContextSourceType =
	| "memory"
	| "tool"
	| "session"
	| "temporal"
	| "environment"
	| "user-context-file"
	| "mcp-instructions";

export interface ContextSource {
	readonly sourceType: ContextSourceType;
	readonly content: string;
	readonly tokenCount: number;
	readonly relevanceScore: number;
	readonly timestamp: number;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly isExternal: boolean;
}

export interface BudgetPolicy {
	readonly taskType: string;
	readonly totalBudget: number;
	readonly systemRatio: number;
	readonly memoryRatio: number;
	readonly toolsRatio: number;
	readonly historyRatio: number;
	readonly outputReserve: number;
}
