/**
 * Barrel for the `mcp/` module. Re-exports the public surface of two
 * parallel sub-modules:
 *   - Stage 2 (Prompts + Elicitation): client-side bidirectional MCP
 *     primitives that let third-party MCP servers push prompts and
 *     server-initiated elicitation back to the LLM.
 *   - Stage 3 (server/): Quilin-as-server skeleton that lets external
 *     MCP clients (Claude Desktop / Cursor / Goose / ...) consume
 *     quilin's tools and resources.
 *
 * `mcp/` 模块的 barrel。导出两个并行子模块的公开 API：Stage 2 客户端
 * 双向 MCP primitive（Prompts + Elicitation），Stage 3 server 子模块
 * （Quilin-as-server stdio MCP server 骨架）。
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
export * from "./server/index.js";
