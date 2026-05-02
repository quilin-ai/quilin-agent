import type { AssembledPrompt } from "../context/prompt-types.js";
import type { Message, ReasoningPart } from "../state/types.js";
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
	readonly thinking?: readonly ReasoningPart[];
	readonly usage: TokenUsage;
	readonly finishReason: "stop" | "tool_calls" | "length" | "error";
}

export type LLMStreamEvent =
	| {
			readonly type: "text";
			readonly delta: string;
	  }
	| {
			readonly type: "reasoning";
			readonly delta: string;
	  }
	| {
			readonly type: "tool-call-start";
			readonly toolCallId: string;
			readonly toolName: string;
	  }
	| {
			readonly type: "tool-call-args-delta";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly delta: string;
	  }
	| {
			readonly type: "tool-call-end";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly inputText: string;
			readonly input?: unknown;
	  }
	| {
			readonly type: "tool-result";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly output: unknown;
			readonly isError?: boolean;
	  };

export type CacheUsageSource = "native" | "wall-clock" | "unknown";

export interface CacheUsage {
	readonly readTokens?: number;
	readonly writeTokens?: number;
	readonly source: CacheUsageSource;
}

export interface TokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cache?: CacheUsage;
}

export type LLMProviderId = "anthropic" | "deepseek" | "gemini" | "openai";

export type LLMProviderStatus = "enabled" | "blocked" | "candidate";

export type ProviderLiveEvidenceStatus =
	| "verified"
	| "missing"
	| "not-required";

export type ReasoningStateAdapter = "none" | "captured_not_replayed";

export interface ProviderCatalogEntry {
	readonly provider: LLMProviderId;
	readonly status: LLMProviderStatus;
	readonly transport: "direct" | "gateway" | "candidate";
	readonly defaultModel?: string;
	readonly models: readonly string[];
	readonly requiredEnv?: readonly string[];
	readonly liveEvidence: ProviderLiveEvidenceStatus;
	readonly blockReason?: string;
}

export interface ProviderCatalog {
	readonly entries: readonly ProviderCatalogEntry[];
}

export interface LLMRouteRequest {
	readonly provider: LLMProviderId;
	readonly model: string;
	readonly thinkingMode?: ThinkingMode;
}

export interface LLMRouteDecision {
	readonly provider: LLMProviderId;
	readonly configuredModel: string;
	readonly effectiveModel: string;
	readonly fallbackUsed: false;
	readonly reasoningStateAdapter: ReasoningStateAdapter;
}

export interface NormalizedProviderError {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly category?: string;
}

export interface ProviderAttempt {
	readonly attemptNumber: 1;
	readonly provider: LLMProviderId;
	readonly model: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly outcome: "success" | "error";
	readonly usage?: TokenUsage;
	readonly error?: NormalizedProviderError;
}

export interface ProviderRunRecord {
	readonly route: LLMRouteDecision;
	readonly attempts: readonly ProviderAttempt[];
	readonly outcome: "success" | "error";
	readonly fallbackUsed: false;
	readonly error?: NormalizedProviderError;
}

/** LLMClient 接口 — Agent Loop 唯一的 LLM 交互点 */
export interface LLMClient {
	chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
		prompt?: AssembledPrompt,
	): Promise<LLMResponse>;
}
