/**
 * Barrel export for the MCP Stage 2 (Prompts + Elicitation) module.
 * Stage 1 (Resources) lives in a parallel module owned by a separate worktree
 * and must not be touched here.
 *
 * MCP Stage 2（Prompts + Elicitation）模块的 barrel 导出。Stage 1（Resources）
 * 由并行 worktree 单独负责，本目录不得触碰。
 */

export {
	createMCPCapabilities,
	type MCPCapabilities,
	type MCPCapabilitiesOptions,
} from "./client.js";
export {
	ELICITATION_DEFAULT_TIMEOUT_MS,
	type ElicitationAction,
	type ElicitationCapableClient,
	type ElicitationContentValue,
	type ElicitationHandlerOptions,
	type ElicitationRequest,
	type ElicitationResolver,
	type ElicitationResponse,
	type ElicitationSchema,
	type FormElicitationRequest,
	registerElicitationHandler,
	type UrlElicitationRequest,
} from "./elicitation-handler.js";
export {
	createPromptsClient,
	PROMPTS_DEFAULT_TIMEOUT_MS,
	type PromptArgumentSummary,
	type PromptSummary,
	PromptsClient,
	type PromptsClientLike,
	type PromptsClientOptions,
	type PromptsResult,
	PromptsTimeoutError,
	type RenderedPrompt,
	type RenderedPromptMessage,
} from "./prompts-client.js";
