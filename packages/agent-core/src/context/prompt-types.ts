import type { ToolPromptDescriptor } from "../tools/tool-metadata.js";

export type UpdateFrequency = "static" | "per_session" | "per_turn";

export type PromptProfile = "full" | "minimal" | "none";

export type PromptSegmentRole = "system" | "user" | "assistant" | "tool";

export type PromptSegmentSource =
	| "prompt-section"
	| "transcript"
	| "temporal-bucket"
	| "temporal-precise";

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
	readonly availableToolsets?: readonly string[];
	readonly availableToolDescriptors?: readonly ToolPromptDescriptor[];
	readonly minTrustLevel?: import("../skills/types.js").SkillTrustLevel;
	readonly profile: PromptProfile;
}

export const PROMPT_CACHE_BOUNDARY = "__QUILIN_CACHE_BOUNDARY__";

export interface PromptSegment {
	readonly id: string;
	readonly role: PromptSegmentRole;
	readonly text: string;
	readonly stability: UpdateFrequency;
	readonly source: PromptSegmentSource;
	readonly cacheEligible: boolean;
}

export interface RecommendedBreakpoint {
	readonly segmentIndex: number;
	readonly reason: "system-tail" | "history-tail" | "tool-resume-tail";
}

export interface AssembledPrompt {
	readonly segments: readonly PromptSegment[];
	readonly recommendedBreakpoints: readonly RecommendedBreakpoint[];
	readonly staticPrefix: string;
	readonly dynamicSuffix: string;
	readonly sectionTokens: Readonly<Record<string, number>>;
	readonly totalTokens: number;
}
