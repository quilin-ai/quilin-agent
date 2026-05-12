/**
 * Quilin Agent · v2 control-plane Zod schemas
 *
 * TEMPORARY local mirror per QUI-154 Phase 1a P1a-5. Once
 * `packages/agent-core/src/control-plane/v2/schemas.ts` lands and is exported
 * from the @quilin/agent-core workspace package, this file SHOULD be replaced
 * by a re-export:
 *
 *     export * from "@quilin/agent-core/control-plane/v2/schemas";
 *
 * Mirror keeps the shape locked to docs/08-observability/web-ui-rebuild-plan.md
 * §4.1–§4.13 verbatim so the frontend can build before the backend route lands.
 *
 * Removal blocker: parallel subagent owning `handler-v2.ts` + zod schemas.
 */
import { z } from "zod";

// -----------------------------------------------------------------------------
// 4.1 Common types
// -----------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	detail: z.unknown().optional(),
});

export const ApiEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
	z.object({
		ok: z.boolean(),
		data: data.optional(),
		error: ApiErrorSchema.optional(),
	});

export const IsoDateTime = z.string().datetime({ offset: true });
export const AgentId = z.string().min(1).max(64);
export const SessionId = z.string().min(1).max(64);

export const TrustMode = z.enum(["ask", "auto", "yolo", "read_only"]);
export const SessionStatus = z.enum(["active", "closed", "archived", "blocked"]);

// -----------------------------------------------------------------------------
// 4.3 Sessions
// -----------------------------------------------------------------------------

export const SessionSummarySchema = z.object({
	id: SessionId,
	title: z.string(),
	agentId: AgentId,
	turnsCount: z.number().int(),
	tokensTotal: z.number().int(),
	startedAt: IsoDateTime,
	lastTurnAt: IsoDateTime,
	status: SessionStatus,
	costUsd: z.number().nullable(),
});

export const SessionsListResponse = z.object({
	items: z.array(SessionSummarySchema),
	nextCursor: z.string().nullable(),
});

// -----------------------------------------------------------------------------
// 4.5 Memory tiers + entries
// -----------------------------------------------------------------------------

export const MemoryTierName = z.enum(["working", "episodic", "semantic", "skill"]);

export const MemoryTierSchema = z.object({
	tier: MemoryTierName,
	count: z.number().int(),
	bytes: z.number().int(),
	latestAt: IsoDateTime.nullable(),
	latestPreview: z.string().nullable(),
});

export const MemoryTiersSchema = z.array(MemoryTierSchema);

export const MemoryEntrySchema = z.object({
	id: z.string(),
	tier: MemoryTierName,
	content: z.string(),
	createdAt: IsoDateTime,
	source: z.enum(["user", "auto-reflect", "explicit", "consolidation"]),
	agentId: AgentId,
});

export const MemoryRecentResponseSchema = z.object({
	items: z.array(MemoryEntrySchema),
});

// -----------------------------------------------------------------------------
// 4.6 Skills
// -----------------------------------------------------------------------------

export const SkillSchema = z.object({
	name: z.string(),
	source: z.enum(["local", "project", "remote"]),
	maturity: z.enum(["M0", "M1", "M2"]),
	usedCount: z.number().int(),
	description: z.string(),
	triggers: z.array(z.string()),
});

export const SkillsCatalogSchema = z.array(SkillSchema);

// -----------------------------------------------------------------------------
// 4.7 Tools
// -----------------------------------------------------------------------------

export const ToolSchema = z.object({
	name: z.string(),
	category: z.enum(["core", "orchestration", "network", "discovery", "multimodal"]),
	source: z.enum(["builtin", "mcp", "cli-anything"]),
	usedCount: z.number().int(),
	successRate: z.number().min(0).max(1).nullable(),
	avgLatencyMs: z.number().nullable(),
});

export const ToolsCatalogSchema = z.array(ToolSchema);

// -----------------------------------------------------------------------------
// 4.8 MCP
// -----------------------------------------------------------------------------

export const MCPServerSchema = z.object({
	name: z.string(),
	transport: z.enum(["stdio", "http"]),
	status: z.enum(["healthy", "degraded", "offline"]),
	toolsCount: z.number().int(),
	callsToday: z.number().int(),
	avgLatencyMs: z.number(),
});

export const MCPRegistrySchema = z.array(MCPServerSchema);

// -----------------------------------------------------------------------------
// 4.9 Config
// -----------------------------------------------------------------------------

export const ConfigSchema = z.object({
	trustMode: TrustMode,
	idleEvolution: z.boolean(),
	autoReflect: z.boolean(),
	tokenBudgetDaily: z.number().int(),
	tokenBudgetWarnAt: z.number().min(0).max(1),
	modelDefault: z.string(),
	modelCheap: z.string(),
	redactionPolicy: z.enum(["minimal", "standard", "strict"]),
});

export const ConfigPatchSchema = ConfigSchema.partial();

// -----------------------------------------------------------------------------
// 4.10 Agents
// -----------------------------------------------------------------------------

export const AuthClassification = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const AuthRequestSchema = z.object({
	id: z.string(),
	agentId: AgentId,
	tool: z.string(),
	args: z.record(z.string(), z.unknown()),
	reason: z.string(),
	classification: AuthClassification,
	impactEstimate: z.string().nullable(),
});

export const AuthResolvedSchema = z.object({
	requestId: z.string().min(1),
	decision: z.enum(["approve", "deny"]),
	resolvedAt: IsoDateTime,
	resolver: z.string().optional(),
	comment: z.string().optional(),
});

export const AgentStatus = z.enum([
	"pending",
	"running",
	"blocked",
	"completed",
	"failed",
	"cancelled",
]);

export const AgentSummarySchema = z.object({
	id: AgentId,
	kind: z.enum(["main", "subagent"]),
	parentId: AgentId.nullable(),
	task: z.string().nullable(),
	status: AgentStatus,
	startedAt: IsoDateTime,
	elapsedMs: z.number().int(),
	lastHeartbeatAt: IsoDateTime.nullable(),
	pendingAuthRequest: AuthRequestSchema.nullable(),
});

export const AgentsListResponseSchema = z.object({
	items: z.array(AgentSummarySchema),
});

// -----------------------------------------------------------------------------
// 4.4 Turn — events use the LoopStepEventSchema mirror (kept in lock-step
// with the canonical @quilin/agent-core control-plane schema). The shape
// MUST stay identical so the swap-to-re-export migration is a no-op.
// -----------------------------------------------------------------------------

export const LoopStepEventSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	timestamp: IsoDateTime,
	source: z.string().min(1).optional(),
	payload: z.unknown().optional(),
});

export const TurnSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system"]),
	agentId: AgentId,
	startedAt: IsoDateTime,
	finishedAt: IsoDateTime.nullable(),
	events: z.array(LoopStepEventSchema),
	content: z.string(),
	reflection: z.string().nullable(),
	tokens: z.object({
		thinking: z.number().int(),
		tools: z.number().int(),
		response: z.number().int(),
	}),
});

export const SessionDetailSchema = z.object({
	session: SessionSummarySchema,
	turns: z.array(TurnSchema),
});

// -----------------------------------------------------------------------------
// 4.2 Runtime snapshot — composite first-load payload
// -----------------------------------------------------------------------------

export const RuntimeSnapshotSchema = z.object({
	version: z.string(),
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

// -----------------------------------------------------------------------------
// 4.11 SSE — discriminated union by `kind`. Mirrors the canonical backend
// schema 1:1: `loop-step` / `auth-request` / `auth-resolved` carry strict
// payload schemas; the other 20 kinds use a generic `PayloadShell` until the
// downstream contracts (QUI-66 LoopStep payloads etc.) land. Round-2 fix
// NR-D-2: the previous frontend mirror used `payload: z.record(...)` which
// silently accepted malformed auth-request / auth-resolved frames that the
// backend would reject.
//
// 4.11 SSE 与后端 schema 1:1 对齐。loop-step / auth-request / auth-resolved
// 用严格 payload；其余 20 个事件类型继续使用 PayloadShell 占位，等下游
// 契约落地后收紧。NR-D-2 round-2 修复：前端原先用 `payload: z.record(...)`
// 太松，导致后端会拒绝的畸形 auth-request 在前端"过审"。
// -----------------------------------------------------------------------------

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

/**
 * Generic timestamped payload shell — mirrors the backend `PayloadShell`
 * (an open object permitting `at` / `agentId` / `sessionId` plus arbitrary
 * extra keys). Used by every SSE event-kind whose deep payload schema has
 * not landed yet, so the frontend can render without coupling to the
 * eventual strict types.
 *
 * 通用 payload 壳，与后端 PayloadShell 一致：允许 at / agentId / sessionId
 * 三个可选字段，并允许任意额外键。
 */
const PayloadShell = z
	.object({
		at: IsoDateTime.optional(),
		agentId: AgentId.optional(),
		sessionId: SessionId.optional(),
	})
	.catchall(z.unknown());

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

// -----------------------------------------------------------------------------
// 4.12 Authorize
// -----------------------------------------------------------------------------

export const AuthorizePostSchema = z.object({
	requestId: z.string(),
	decision: z.enum(["approve", "deny"]),
	comment: z.string().optional(),
});

export const AuthorizeResponseSchema = z.object({
	requestId: z.string(),
	resolved: z.boolean(),
});

// -----------------------------------------------------------------------------
// Inferred TS types — kept inline so consumers don't have to chain z.infer.
// -----------------------------------------------------------------------------

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type TrustMode = z.infer<typeof TrustMode>;
export type SessionStatus = z.infer<typeof SessionStatus>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionsListResponse = z.infer<typeof SessionsListResponse>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type LoopStepEvent = z.infer<typeof LoopStepEventSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type MemoryTier = z.infer<typeof MemoryTierSchema>;
export type MemoryTiers = z.infer<typeof MemoryTiersSchema>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type MemoryTierName = z.infer<typeof MemoryTierName>;
export type Skill = z.infer<typeof SkillSchema>;
export type SkillsCatalog = z.infer<typeof SkillsCatalogSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type ToolsCatalog = z.infer<typeof ToolsCatalogSchema>;
export type MCPServer = z.infer<typeof MCPServerSchema>;
export type MCPRegistry = z.infer<typeof MCPRegistrySchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;
export type AuthClassification = z.infer<typeof AuthClassification>;
export type AuthRequest = z.infer<typeof AuthRequestSchema>;
export type AuthResolved = z.infer<typeof AuthResolvedSchema>;
export type AgentStatus = z.infer<typeof AgentStatus>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type AgentsListResponse = z.infer<typeof AgentsListResponseSchema>;
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;
export type SseEventKind = z.infer<typeof SseEventKind>;
export type SseEvent = z.infer<typeof SseEventSchema>;
export type AuthorizePost = z.infer<typeof AuthorizePostSchema>;
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;
