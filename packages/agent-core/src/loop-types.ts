import type { ScanResult } from "./context/injection-scanner.js";
import type { OutboundPromptRequest } from "./context/prompt-session-assembler.js";
import type { ContextManager, TokenBudget } from "./context/types.js";
import type { InferenceConfig, LLMClient } from "./llm/types.js";
import type { ObserverBridge } from "./memory/observer-bridge.js";
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
	readonly onIdle?: () => Promise<void>;
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
	readonly contextBudget?: TokenBudget;
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
	/**
	 * Optional bridge to the L3a observer (memory_observe MCP tool).
	 * When provided, runAgentLoop calls observeTurn() after each completed
	 * agent turn. The bridge is best-effort — failures never abort the
	 * loop. Default agent runs leave this undefined and skip observation.
	 *
	 * 可选：L3a 观察桥（memory_observe MCP 工具）。配置后 runAgentLoop 在
	 * 每次 agent 回合结束后调用 observeTurn()。桥层尽力而为，失败也不会
	 * 中断 loop。默认运行不配置该项即跳过观察。
	 */
	readonly observerBridge?: ObserverBridge;
	/** Optional user identifier passed through to the observer. */
	readonly observerUserId?: string;
	/** Optional session identifier passed through to the observer. */
	readonly observerSessionId?: string;
	/**
	 * Optional natural-language query used by `BasicContextManager` to drive
	 * its relevance pre-filter (QUI-145). When undefined, the context manager
	 * falls back to Phase 0 priority-only behavior — fully backward compatible.
	 *
	 * 当未提供时（`undefined`），ContextManager 退化为 Phase 0 的 priority-only
	 * 行为，保持完全向后兼容。
	 */
	readonly relevanceQuery?: string;
}
