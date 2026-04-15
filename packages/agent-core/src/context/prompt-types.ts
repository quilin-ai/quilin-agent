export type UpdateFrequency = "static" | "per_session" | "per_turn";

export type PromptProfile = "full" | "minimal" | "none";

export interface PromptSection {
	readonly name: string;
	readonly order: number;
	readonly compute: (ctx: BuildContext) => string | null;
	readonly updateFrequency: UpdateFrequency;
	readonly maxTokens?: number;
	readonly profiles?: readonly PromptProfile[];
}

export interface BuildContext {
	readonly userInput: string;
	readonly sessionState: Record<string, unknown>;
	readonly modelId: string;
	readonly availableTools: readonly string[];
	readonly profile: PromptProfile;
}

export const PROMPT_CACHE_BOUNDARY = "__QUILIN_CACHE_BOUNDARY__";

export interface AssembledPrompt {
	readonly staticPrefix: string;
	readonly dynamicSuffix: string;
	readonly sectionTokens: Readonly<Record<string, number>>;
	readonly totalTokens: number;
}
