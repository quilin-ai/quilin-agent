/**
 * Web UI v2 control-plane API schemas (QUI-154 Phase 1a).
 *
 * Single source of truth for backend request validation and the typed
 * frontend client. Mirrors the contract spec in
 * `docs/08-observability/web-ui-rebuild-plan.md` §4.
 *
 * Web UI v2 控制面 API schema (QUI-154 Phase 1a)。后端请求验证与
 * 类型化前端客户端共用的唯一来源，与
 * `docs/08-observability/web-ui-rebuild-plan.md` §4 中的契约一一对应。
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// 4.1 通用类型 / Common Types
// -----------------------------------------------------------------------------

export const IsoDateTime = z.string().datetime({ offset: true });

export const AgentId = z.string().min(1).max(64);

export const SessionId = z.string().min(1).max(64);

export const TrustMode = z.enum(["ask", "auto", "yolo", "read_only"]);

/**
 * Error envelope used by every non-2xx response.
 *
 * 所有非 2xx 响应的错误包络。
 */
export const ApiErrorSchema = z.object({
	code: z.string().min(1),
	message: z.string(),
	detail: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Build the standard `{ ok, data?, error? }` envelope for any response
 * payload schema. Both `data` and `error` are optional so a single helper
 * works for success ({ ok: true, data }) and failure ({ ok: false, error }).
 *
 * 标准 `{ ok, data?, error? }` 包络构造器。data/error 都可选，让
 * success/error 两种结果共用同一个 envelope。
 */
export function ApiEnvelopeSchema<TData extends z.ZodTypeAny>(
	data: TData,
): z.ZodObject<{
	ok: z.ZodBoolean;
	data: z.ZodOptional<TData>;
	error: z.ZodOptional<typeof ApiErrorSchema>;
}> {
	return z.object({
		ok: z.boolean(),
		data: data.optional(),
		error: ApiErrorSchema.optional(),
	});
}

// -----------------------------------------------------------------------------
// 4.10 Agent summary
// -----------------------------------------------------------------------------

export const AgentStatus = z.enum([
	"pending",
	"running",
	"blocked",
	"completed",
	"failed",
	"cancelled",
]);

export const AgentKind = z.enum(["main", "subagent"]);

// 4.12 AuthRequest is referenced inside AgentSummarySchema → defined first.
export const AuthClassification = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const AuthRequestSchema = z.object({
	id: z.string().min(1),
	agentId: AgentId,
	tool: z.string().min(1),
	args: z.record(z.string(), z.unknown()),
	reason: z.string(),
	classification: AuthClassification,
	impactEstimate: z.string().nullable(),
});
export type AuthRequest = z.infer<typeof AuthRequestSchema>;

export const AuthorizePostSchema = z.object({
	requestId: z.string().min(1),
	decision: z.enum(["approve", "deny"]),
	comment: z.string().optional(),
});
export type AuthorizePost = z.infer<typeof AuthorizePostSchema>;

/**
 * Wire shape returned by a successful `POST /api/v2/authorize`. Echoes
 * back the request id so clients tracking multiple pending
 * authorizations can correlate the response without local bookkeeping.
 *
 * `POST /api/v2/authorize` 成功响应的有线形状——回显 requestId，便于
 * 客户端在追踪多个待批准请求时无需本地簿记即可关联响应。
 */
export const AuthorizeResponseSchema = z.object({
	requestId: z.string().min(1),
	resolved: z.boolean(),
});
export type AuthorizeResponseT = z.infer<typeof AuthorizeResponseSchema>;

export const AuthResolvedSchema = z.object({
	requestId: z.string().min(1),
	decision: z.enum(["approve", "deny"]),
	resolvedAt: IsoDateTime,
	resolver: z.string().optional(),
	comment: z.string().optional(),
});
export type AuthResolved = z.infer<typeof AuthResolvedSchema>;

export const AgentSummarySchema = z.object({
	id: AgentId,
	kind: AgentKind,
	parentId: AgentId.nullable(),
	task: z.string().nullable(),
	status: AgentStatus,
	startedAt: IsoDateTime,
	elapsedMs: z.number().int().nonnegative(),
	lastHeartbeatAt: IsoDateTime.nullable(),
	pendingAuthRequest: AuthRequestSchema.nullable(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

/**
 * Wire shape of `GET /api/v2/agents` — `{ items }` wrapper keeps the
 * envelope forward-compatible with future pagination (matches
 * `SessionsListResponse` from §4.3).
 *
 * `GET /api/v2/agents` 的有线形状——`{ items }` 包装与 §4.3 的
 * SessionsListResponse 保持一致，留下未来分页扩展点。
 */
export const AgentsListResponseSchema = z.object({
	items: z.array(AgentSummarySchema),
});
export type AgentsListResponseT = z.infer<typeof AgentsListResponseSchema>;

// -----------------------------------------------------------------------------
// 4.5 Memory
// -----------------------------------------------------------------------------

export const MemoryTierName = z.enum([
	"working",
	"episodic",
	"semantic",
	"skill",
]);

export const MemoryTierSchema = z.object({
	tier: MemoryTierName,
	count: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	latestAt: IsoDateTime.nullable(),
	latestPreview: z.string().nullable(),
});
export type MemoryTier = z.infer<typeof MemoryTierSchema>;

export const MemoryTiersSchema = z.array(MemoryTierSchema);
export type MemoryTiers = z.infer<typeof MemoryTiersSchema>;

export const MemoryEntrySchema = z.object({
	id: z.string().min(1),
	tier: MemoryTierName,
	content: z.string(),
	createdAt: IsoDateTime,
	source: z.enum(["user", "auto-reflect", "explicit", "consolidation"]),
	agentId: AgentId,
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/**
 * Wire shape of `GET /api/v2/memory/recent` — `{ items }` wrapper keeps
 * the envelope forward-compatible with pagination/filter cursors that
 * the planning doc earmarks for follow-up iterations.
 *
 * `GET /api/v2/memory/recent` 的有线形状——`{ items }` 包装为后续
 * 分页/过滤游标留出兼容空间。
 */
export const MemoryRecentResponseSchema = z.object({
	items: z.array(MemoryEntrySchema),
});
export type MemoryRecentResponseT = z.infer<typeof MemoryRecentResponseSchema>;

// -----------------------------------------------------------------------------
// 4.6 Skills catalog
// -----------------------------------------------------------------------------

export const SkillSchema = z.object({
	name: z.string().min(1),
	source: z.enum(["local", "project", "remote"]),
	maturity: z.enum(["M0", "M1", "M2"]),
	usedCount: z.number().int().nonnegative(),
	description: z.string(),
	triggers: z.array(z.string()),
});
export type Skill = z.infer<typeof SkillSchema>;

export const SkillsCatalogSchema = z.array(SkillSchema);
export type SkillsCatalog = z.infer<typeof SkillsCatalogSchema>;

// -----------------------------------------------------------------------------
// 4.7 Tools catalog
// -----------------------------------------------------------------------------

export const ToolSchema = z.object({
	name: z.string().min(1),
	category: z.enum([
		"core",
		"orchestration",
		"network",
		"discovery",
		"multimodal",
	]),
	source: z.enum(["builtin", "mcp", "cli-anything"]),
	usedCount: z.number().int().nonnegative(),
	successRate: z.number().min(0).max(1).nullable(),
	avgLatencyMs: z.number().nonnegative().nullable(),
});
export type Tool = z.infer<typeof ToolSchema>;

export const ToolsCatalogSchema = z.array(ToolSchema);
export type ToolsCatalog = z.infer<typeof ToolsCatalogSchema>;

// -----------------------------------------------------------------------------
// 4.8 MCP registry
// -----------------------------------------------------------------------------

export const MCPServerSchema = z.object({
	name: z.string().min(1),
	transport: z.enum(["stdio", "http"]),
	status: z.enum(["healthy", "degraded", "offline"]),
	toolsCount: z.number().int().nonnegative(),
	callsToday: z.number().int().nonnegative(),
	avgLatencyMs: z.number().nonnegative(),
});
export type MCPServer = z.infer<typeof MCPServerSchema>;

export const MCPRegistrySchema = z.array(MCPServerSchema);
export type MCPRegistry = z.infer<typeof MCPRegistrySchema>;

// -----------------------------------------------------------------------------
// 4.9 Config
// -----------------------------------------------------------------------------

export const ConfigSchema = z.object({
	trustMode: TrustMode,
	idleEvolution: z.boolean(),
	autoReflect: z.boolean(),
	tokenBudgetDaily: z.number().int().nonnegative(),
	tokenBudgetWarnAt: z.number().min(0).max(1),
	modelDefault: z.string().min(1),
	modelCheap: z.string().min(1),
	redactionPolicy: z.enum(["minimal", "standard", "strict"]),
});
export type Config = z.infer<typeof ConfigSchema>;

export const ConfigPatchSchema = ConfigSchema.partial();
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

// -----------------------------------------------------------------------------
// 4.3 / 4.4 Sessions
// -----------------------------------------------------------------------------

export const SessionStatus = z.enum([
	"active",
	"closed",
	"archived",
	"blocked",
]);

export const SessionSummarySchema = z.object({
	id: SessionId,
	title: z.string(),
	agentId: AgentId,
	turnsCount: z.number().int().nonnegative(),
	tokensTotal: z.number().int().nonnegative(),
	startedAt: IsoDateTime,
	lastTurnAt: IsoDateTime,
	status: SessionStatus,
	costUsd: z.number().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionsListResponse = z.object({
	items: z.array(SessionSummarySchema),
	nextCursor: z.string().nullable(),
});
export type SessionsListResponseT = z.infer<typeof SessionsListResponse>;

/**
 * Single LoopStep event placeholder. The full QUI-66 LoopStep contract
 * has not landed yet; this schema is permissive enough to round-trip the
 * event records that the runtime currently emits.
 *
 * QUI-66 LoopStep 完整契约尚未落地，此处用宽松 schema 兜底，可以
 * 完整保留运行时已有事件记录的所有字段。
 */
export const LoopStepEventSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	timestamp: IsoDateTime,
	source: z.string().min(1).optional(),
	payload: z.unknown().optional(),
});
export type LoopStepEvent = z.infer<typeof LoopStepEventSchema>;

export const TurnSchema = z.object({
	id: z.string().min(1),
	role: z.enum(["user", "assistant", "system"]),
	agentId: AgentId,
	startedAt: IsoDateTime,
	finishedAt: IsoDateTime.nullable(),
	events: z.array(LoopStepEventSchema),
	content: z.string(),
	reflection: z.string().nullable(),
	tokens: z.object({
		thinking: z.number().int().nonnegative(),
		tools: z.number().int().nonnegative(),
		response: z.number().int().nonnegative(),
	}),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionDetailSchema = z.object({
	session: SessionSummarySchema,
	turns: z.array(TurnSchema),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

// -----------------------------------------------------------------------------
// 4.2 Snapshot (composes all of the above)
// -----------------------------------------------------------------------------

export const RuntimeSnapshotSchema = z.object({
	version: z.string().min(1),
	startedAt: IsoDateTime,
	currentSessionId: SessionId.nullable(),
	currentAgentId: AgentId.nullable(),
	agents: z.array(AgentSummarySchema),
	memory: MemoryTiersSchema,
	skills: SkillsCatalogSchema,
	tools: ToolsCatalogSchema,
	mcp: MCPRegistrySchema,
	config: ConfigSchema,
	trustMode: TrustMode,
});
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;

// -----------------------------------------------------------------------------
// 4.11 SSE events
// -----------------------------------------------------------------------------

/**
 * Generic timestamped payload used by event-kind shells whose full
 * schema lives in domain-specific modules (e.g. memory, planning,
 * self-evolution). Phase 1a treats the payload as opaque JSON so the
 * frontend can render without coupling to the eventual deep types.
 *
 * 通用时间戳载荷壳，用于尚未在本模块直接定义的事件类型。Phase 1a
 * 把 payload 视为不透明 JSON，让前端先按通用 schema 渲染，等深度
 * 类型在其它模块落地后再收紧。
 */
const PayloadShell = z
	.object({
		at: IsoDateTime.optional(),
		agentId: AgentId.optional(),
		sessionId: SessionId.optional(),
	})
	.catchall(z.unknown());

/**
 * The discriminated union covering all 22 SSE event kinds defined in
 * planning doc §4.11. Payload schemas reference modules that haven't
 * landed yet (LoopStep / MemoryRecall / Planning / Reflection / etc.),
 * so each entry uses a `PayloadShell` placeholder — this matches the
 * existing runtime which emits flexible JSON payloads, and lets the
 * frontend parse without runtime errors while the contracts mature.
 *
 * Phase 1a 用 PayloadShell 作占位，等下游模块（QUI-66 LoopStep 等）
 * 落地后再收紧 payload schema；当前实现避免与未提交契约硬耦合。
 */
export const SseEventSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("loop-step"), payload: LoopStepEventSchema }),
	z.object({ kind: z.literal("memory-recall"), payload: PayloadShell }),
	z.object({ kind: z.literal("memory-write"), payload: PayloadShell }),
	z.object({ kind: z.literal("skill-match"), payload: PayloadShell }),
	z.object({ kind: z.literal("skill-load"), payload: PayloadShell }),
	z.object({ kind: z.literal("planning"), payload: PayloadShell }),
	z.object({ kind: z.literal("tool-call"), payload: PayloadShell }),
	z.object({ kind: z.literal("mcp-call"), payload: PayloadShell }),
	z.object({ kind: z.literal("reasoning"), payload: PayloadShell }),
	z.object({ kind: z.literal("response-chunk"), payload: PayloadShell }),
	z.object({ kind: z.literal("reflection"), payload: PayloadShell }),
	z.object({ kind: z.literal("risk-classify"), payload: PayloadShell }),
	z.object({ kind: z.literal("auth-request"), payload: AuthRequestSchema }),
	z.object({ kind: z.literal("auth-resolved"), payload: AuthResolvedSchema }),
	z.object({ kind: z.literal("subagent-spawn"), payload: PayloadShell }),
	z.object({ kind: z.literal("subagent-status"), payload: PayloadShell }),
	z.object({ kind: z.literal("subagent-join"), payload: PayloadShell }),
	z.object({ kind: z.literal("trajectory-log"), payload: PayloadShell }),
	z.object({ kind: z.literal("metric-emit"), payload: PayloadShell }),
	z.object({ kind: z.literal("redaction"), payload: PayloadShell }),
	z.object({ kind: z.literal("proposal-generate"), payload: PayloadShell }),
	z.object({ kind: z.literal("temporal-awareness"), payload: PayloadShell }),
	z.object({ kind: z.literal("user-profile-load"), payload: PayloadShell }),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
export type SseEventKindT = SseEvent["kind"];

/**
 * Runtime-validatable Zod enum mirror of the SSE event-kind discriminator.
 * Used by the frontend contract test (and any client that wants to lift
 * an untyped string to a typed kind) — keeps the wire vocabulary the same
 * single source of truth as `SseEventSchema`.
 *
 * `SseEventSchema` 判别器的 Zod enum 镜像，作为运行时校验的入口；前端
 * 契约测试与外部客户端都能用同一份字符串字典。
 */
// Namespace-merged TS type — same name as the Zod schema so existing
// consumers that imported `type SseEventKind` keep compiling without
// caring whether they reach the runtime value or the type.
export type SseEventKind = SseEventKindT;
export const SseEventKind = z.enum([
	"loop-step",
	"memory-recall",
	"memory-write",
	"skill-match",
	"skill-load",
	"planning",
	"tool-call",
	"mcp-call",
	"reasoning",
	"response-chunk",
	"reflection",
	"risk-classify",
	"auth-request",
	"auth-resolved",
	"subagent-spawn",
	"subagent-status",
	"subagent-join",
	"trajectory-log",
	"metric-emit",
	"redaction",
	"proposal-generate",
	"temporal-awareness",
	"user-profile-load",
]);

export const SSE_EVENT_KINDS: readonly SseEventKindT[] = [
	"loop-step",
	"memory-recall",
	"memory-write",
	"skill-match",
	"skill-load",
	"planning",
	"tool-call",
	"mcp-call",
	"reasoning",
	"response-chunk",
	"reflection",
	"risk-classify",
	"auth-request",
	"auth-resolved",
	"subagent-spawn",
	"subagent-status",
	"subagent-join",
	"trajectory-log",
	"metric-emit",
	"redaction",
	"proposal-generate",
	"temporal-awareness",
	"user-profile-load",
] as const;

// -----------------------------------------------------------------------------
// Error codes (4.13)
// -----------------------------------------------------------------------------

export const ERROR_CODES = {
	sessionNotFound: "session_not_found",
	agentNotFound: "agent_not_found",
	authRequestExpired: "auth_request_expired",
	authRequestAlreadyResolved: "auth_request_already_resolved",
	validationError: "validation_error",
	forbiddenCriticalWrite: "forbidden_critical_write",
	internal: "internal",
	notFound: "not_found",
	methodNotAllowed: "method_not_allowed",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// -----------------------------------------------------------------------------
// Grouped export (per task spec): V2Schemas
// -----------------------------------------------------------------------------

export const V2Schemas = {
	IsoDateTime,
	AgentId,
	SessionId,
	TrustMode,
	ApiErrorSchema,
	ApiEnvelopeSchema,
	AgentStatus,
	AgentKind,
	AgentSummarySchema,
	AgentsListResponseSchema,
	AuthClassification,
	AuthRequestSchema,
	AuthorizePostSchema,
	AuthorizeResponseSchema,
	AuthResolvedSchema,
	MemoryTierName,
	MemoryTierSchema,
	MemoryTiersSchema,
	MemoryEntrySchema,
	MemoryRecentResponseSchema,
	SkillSchema,
	SkillsCatalogSchema,
	ToolSchema,
	ToolsCatalogSchema,
	MCPServerSchema,
	MCPRegistrySchema,
	ConfigSchema,
	ConfigPatchSchema,
	SessionStatus,
	SessionSummarySchema,
	SessionsListResponse,
	LoopStepEventSchema,
	TurnSchema,
	SessionDetailSchema,
	RuntimeSnapshotSchema,
	SseEventKind,
	SseEventSchema,
} as const;
