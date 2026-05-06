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

export type LLMModelTier = "flash" | "lite" | "pro";

export type LLMRoutingMode = "auto" | LLMModelTier;

export type LLMProviderStatus = "enabled" | "blocked" | "candidate";

export type ProviderLiveEvidenceStatus =
	| "verified"
	| "missing"
	| "not-required";

export type ProviderAuthMode = "api_key" | "oauth";

export type ProviderCredentialSource =
	| "env"
	| "oauth_file"
	| "oauth_cli"
	| "keychain";

export interface ProviderAuthStrategy {
	readonly mode: ProviderAuthMode;
	readonly source: ProviderCredentialSource;
	readonly label: string;
	readonly requiredEnv?: readonly string[];
	readonly credentialPath?: string;
	readonly credentialPathEnv?: string;
	readonly refreshAfterDays?: number;
}

export type ProviderCredentialStatus =
	| "configured"
	| "missing"
	| "not_required";

export type ProviderQuotaAwarenessStatus =
	| "available"
	| "planned"
	| "unsupported";

export interface ProviderQuotaAwareness {
	readonly status: ProviderQuotaAwarenessStatus;
	readonly source:
		| "api_balance"
		| "oauth_usage_api"
		| "cli_rpc"
		| "web_dashboard"
		| "none";
	readonly label: string;
	readonly requiresExternalApi: boolean;
	readonly endpointHint?: string;
}

export interface ProviderLiveMatrixEntry {
	readonly provider: LLMProviderId;
	readonly status: LLMProviderStatus;
	readonly transport: ProviderCatalogEntry["transport"];
	readonly authModes: readonly ProviderAuthMode[];
	readonly credentialStatus: ProviderCredentialStatus;
	readonly configuredSources: readonly ProviderCredentialSource[];
	readonly missingCredentials: readonly string[];
	readonly liveEvidence: ProviderLiveEvidenceStatus;
	readonly quotaAwareness: ProviderQuotaAwareness;
}

export type ReasoningStateAdapter =
	| "none"
	| "captured_not_replayed"
	| "captured_replayed_for_tool_calls";

export interface ProviderCatalogEntry {
	readonly provider: LLMProviderId;
	readonly status: LLMProviderStatus;
	readonly transport: "direct" | "gateway" | "candidate";
	readonly defaultModel?: string;
	readonly models: readonly string[];
	readonly allowCustomModels?: boolean;
	readonly requiredEnv?: readonly string[];
	readonly authStrategies?: readonly ProviderAuthStrategy[];
	readonly quotaAwareness?: ProviderQuotaAwareness;
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

export interface LLMModelProfile {
	readonly provider: LLMProviderId;
	readonly model: string;
	readonly thinkingMode: ThinkingMode;
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly thinkingBudget?: number;
	readonly topP?: number;
}

export interface LLMTierRoutingConfig {
	readonly mode: LLMRoutingMode;
	readonly defaultTier: LLMModelTier;
	readonly allowEscalation: boolean;
	readonly tiers: Readonly<Record<LLMModelTier, LLMModelProfile>>;
}

export interface LLMTierRouteSelection {
	readonly tier: LLMModelTier;
	readonly reason: string;
	readonly mode: LLMRoutingMode;
}

export interface LLMRouteBudget {
	readonly maxTokens: number;
	readonly thinkingBudget?: number;
}

export interface LLMRouteDecision {
	readonly provider: LLMProviderId;
	readonly configuredModel: string;
	readonly effectiveModel: string;
	readonly fallbackUsed: false;
	readonly reasoningStateAdapter: ReasoningStateAdapter;
	readonly budget?: LLMRouteBudget;
	readonly selectedTier?: LLMModelTier;
	readonly routingMode?: LLMRoutingMode;
	readonly routeReason?: string;
	readonly thinkingMode?: ThinkingMode;
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
