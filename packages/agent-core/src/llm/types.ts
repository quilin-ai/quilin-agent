import type { Message } from "../state/types.js";
import type { Tool, ToolCall } from "../tools/types.js";

/** 思考模式控制 — 来自 01-LLM spec §ThinkingMode */
export type ThinkingMode = "enabled" | "disabled" | "auto";

/** 推理配置 — 来自 01-LLM spec §InferenceConfig */
export interface InferenceConfig {
	readonly temperature: number;
	readonly maxTokens: number;
	readonly thinkingMode: ThinkingMode;
	readonly thinkingBudget?: number;
	readonly topP?: number;
	readonly stopSequences?: readonly string[];
}

/** LLM 响应 */
export interface LLMResponse {
	readonly content: string;
	readonly toolCalls?: readonly ToolCall[];
	readonly thinking?: string;
	readonly usage: TokenUsage;
	readonly finishReason: "stop" | "tool_calls" | "length" | "error";
}

export interface TokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheHitTokens?: number;
}

/** LLMClient 接口 — Agent Loop 唯一的 LLM 交互点 */
export interface LLMClient {
	chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
	): Promise<LLMResponse>;
}
