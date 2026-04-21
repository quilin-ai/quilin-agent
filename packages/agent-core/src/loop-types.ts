import type { PromptSessionAssembler } from "./context/prompt-session-assembler.js";
import type { ContextManager } from "./context/types.js";
import type { InferenceConfig, LLMClient } from "./llm/types.js";
import type { AgentState, Checkpoint, Message } from "./state/types.js";
import type { Tool } from "./tools/types.js";

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_MAX_TOTAL_TOKENS = 200_000;

export class AgentLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentLoopError";
	}
}

export interface LoopHooks {
	readonly recordSpan?: (
		name: string,
		attributes?: Record<string, unknown>,
	) => void | Promise<void>;
	readonly onAssistantMessage?: (message: Message) => void | Promise<void>;
}

export interface AgentLoopConfig {
	readonly llm: LLMClient;
	readonly context?: ContextManager;
	readonly sessionAssembler?: Pick<
		PromptSessionAssembler,
		"buildOutboundRequest"
	>;
	readonly tools?: readonly Tool[];
	readonly checkpoint?: Checkpoint;
	readonly state?: AgentState;
	readonly modelId?: string;
	readonly lastMessageTime?: string;
	readonly maxTurns?: number;
	readonly maxTotalTokens?: number;
	readonly hooks?: LoopHooks;
	readonly inferenceConfig: InferenceConfig;
}
