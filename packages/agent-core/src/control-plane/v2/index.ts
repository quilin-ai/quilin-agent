/**
 * Public surface of the v2 control-plane API module.
 *
 * Re-exports schemas and types for downstream consumers (frontend
 * client, integration tests). Route handlers and the runtime adapter
 * stay private to the backend — callers wire them up via `router.ts`.
 *
 * v2 控制面 API 模块的对外暴露。schema/类型留给前端客户端和集成测试
 * 使用；route handler 与 runtime 适配器仅供后端，通过 router.ts 装配。
 */

export type {
	AgentSummary,
	AgentsListResponseT,
	ApiError,
	AuthorizePost,
	AuthorizeResponseT,
	AuthRequest,
	AuthResolved,
	Config,
	ConfigPatch,
	ErrorCode,
	LoopStepEvent,
	MCPRegistry,
	MCPServer,
	MemoryEntry,
	MemoryRecentResponseT,
	MemoryTier,
	MemoryTiers,
	RuntimeSnapshot,
	SessionDetail,
	SessionSummary,
	SessionsListResponseT,
	Skill,
	SkillsCatalog,
	SseEvent,
	SseEventKindT,
	Tool,
	ToolsCatalog,
	Turn,
} from "./schemas.js";
export {
	AgentId,
	AgentKind,
	AgentStatus,
	AgentSummarySchema,
	// Agents
	AgentsListResponseSchema,
	ApiEnvelopeSchema,
	ApiErrorSchema,
	// Auth
	AuthClassification,
	AuthorizePostSchema,
	AuthorizeResponseSchema,
	AuthRequestSchema,
	AuthResolvedSchema,
	ConfigPatchSchema,
	// Config
	ConfigSchema,
	// Error codes
	ERROR_CODES,
	// Common primitives
	IsoDateTime,
	LoopStepEventSchema,
	MCPRegistrySchema,
	// MCP
	MCPServerSchema,
	MemoryEntrySchema,
	MemoryRecentResponseSchema,
	// Memory
	MemoryTierName,
	MemoryTierSchema,
	MemoryTiersSchema,
	// Snapshot
	RuntimeSnapshotSchema,
	SessionDetailSchema,
	SessionId,
	// Sessions
	SessionStatus,
	SessionSummarySchema,
	SessionsListResponse,
	// Skills
	SkillSchema,
	SkillsCatalogSchema,
	SSE_EVENT_KINDS,
	// SSE
	SseEventKind,
	SseEventSchema,
	// Tools
	ToolSchema,
	ToolsCatalogSchema,
	TrustMode,
	TurnSchema,
	// Grouped export
	V2Schemas,
} from "./schemas.js";
