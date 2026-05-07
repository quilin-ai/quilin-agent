import type { ScanResult } from "./context/injection-scanner.js";
import type { OutboundPromptRequest } from "./context/prompt-session-assembler.js";
import type { ContextManager } from "./context/types.js";
import type { InferenceConfig, LLMClient } from "./llm/types.js";
import type { AgentLoopObservability } from "./observability/loop.js";
import type { ActionVerificationResult } from "./safety/action-verifier.js";
import type { AgentState, Checkpoint, Message } from "./state/types.js";
import type { ToolRouterOptions } from "./tools/router.js";
import type { Tool, ToolCall, ToolResult } from "./tools/types.js";

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
	readonly onMessagesUpdated?: (
		messages: readonly Message[],
		info: { readonly phase: string; readonly turnCount: number },
	) => void | Promise<void>;
	readonly onToolResult?: (event: {
		readonly toolCall: ToolCall;
		readonly toolResult: ToolResult;
		readonly actionVerification: ActionVerificationResult;
		readonly scanResult: ScanResult;
		readonly sanitizedContent: string;
		readonly trustedToolOutput: boolean;
		readonly hasBlockedThreat: boolean;
	}) => void | Promise<void>;
	readonly onTurnComplete?: (
		turnCount: number,
		messages: readonly Message[],
	) => void | Promise<void>;
}

export async function recordLoopSpan(
	hooks: LoopHooks | undefined,
	name: string,
	attributes?: Record<string, unknown>,
): Promise<void> {
	await hooks?.recordSpan?.(name, attributes);
}

export function createAssistantMessage(
	response: Pick<Message, "content"> & {
		readonly toolCalls?: Message["toolCalls"];
		readonly reasoning?: Message["reasoning"];
	},
): Message {
	return {
		role: "assistant",
		content: response.content,
		...(response.toolCalls == null ? {} : { toolCalls: response.toolCalls }),
		...(response.reasoning == null ? {} : { reasoning: response.reasoning }),
	};
}

export interface AgentLoopConfig {
	readonly llm: LLMClient;
	readonly context?: ContextManager;
	readonly sessionAssembler?: {
		readonly buildOutboundRequest: (input: {
			readonly transcript: readonly Message[];
			readonly turnKind: "user-turn" | "tool-resume";
			readonly lastMessageTime?: string;
		}) => OutboundPromptRequest;
	};
	readonly tools?: readonly Tool[];
	readonly checkpoint?: Checkpoint;
	readonly state?: AgentState;
	readonly modelId?: string;
	readonly lastMessageTime?: string;
	readonly maxTurns?: number;
	readonly maxTotalTokens?: number;
	readonly hooks?: LoopHooks;
	readonly observability?: AgentLoopObservability;
	readonly toolRouterOptions?: ToolRouterOptions;
	readonly inferenceConfig: InferenceConfig;
}
