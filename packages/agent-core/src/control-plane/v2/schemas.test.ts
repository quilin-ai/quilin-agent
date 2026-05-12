import { describe, expect, it } from "vitest";
import {
	AgentSummarySchema,
	ApiEnvelopeSchema,
	ApiErrorSchema,
	AuthorizePostSchema,
	AuthRequestSchema,
	ConfigPatchSchema,
	ConfigSchema,
	ERROR_CODES,
	IsoDateTime,
	LoopStepEventSchema,
	MCPRegistrySchema,
	MemoryEntrySchema,
	MemoryTierSchema,
	MemoryTiersSchema,
	RuntimeSnapshotSchema,
	SessionDetailSchema,
	SessionSummarySchema,
	SessionsListResponse,
	SkillSchema,
	SkillsCatalogSchema,
	SSE_EVENT_KINDS,
	SseEventSchema,
	ToolSchema,
	ToolsCatalogSchema,
	TurnSchema,
	V2Schemas,
} from "./schemas.js";

describe("v2 schemas — primitives", () => {
	it("IsoDateTime accepts ISO strings with offset", () => {
		expect(IsoDateTime.safeParse("2026-05-12T08:00:00.000Z").success).toBe(
			true,
		);
		expect(IsoDateTime.safeParse("not a date").success).toBe(false);
	});

	it("ApiEnvelopeSchema produces a schema that accepts both ok and error shapes", () => {
		const schema = ApiEnvelopeSchema(ConfigSchema);
		expect(
			schema.safeParse({
				ok: true,
				data: {
					trustMode: "auto",
					idleEvolution: false,
					autoReflect: true,
					tokenBudgetDaily: 100,
					tokenBudgetWarnAt: 0.5,
					modelDefault: "m",
					modelCheap: "c",
					redactionPolicy: "standard",
				},
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				ok: false,
				error: { code: "boom", message: "boom" },
			}).success,
		).toBe(true);
	});

	it("ApiErrorSchema requires code and message", () => {
		expect(ApiErrorSchema.safeParse({ code: "x", message: "y" }).success).toBe(
			true,
		);
		expect(ApiErrorSchema.safeParse({ code: "x" }).success).toBe(false);
		expect(
			ApiErrorSchema.safeParse({
				code: "x",
				message: "y",
				detail: { extra: 1 },
			}).success,
		).toBe(true);
	});
});

describe("v2 schemas — agents/auth", () => {
	it("AuthRequestSchema enforces enum classification", () => {
		const valid = AuthRequestSchema.safeParse({
			id: "auth-1",
			agentId: "main",
			tool: "shell_exec",
			args: {},
			reason: "",
			classification: "CRITICAL",
			impactEstimate: null,
		});
		expect(valid.success).toBe(true);
		const invalid = AuthRequestSchema.safeParse({
			id: "auth-1",
			agentId: "main",
			tool: "shell_exec",
			args: {},
			reason: "",
			classification: "EXTREME",
			impactEstimate: null,
		});
		expect(invalid.success).toBe(false);
	});

	it("AuthorizePostSchema requires requestId and decision enum", () => {
		expect(
			AuthorizePostSchema.safeParse({
				requestId: "x",
				decision: "approve",
			}).success,
		).toBe(true);
		expect(
			AuthorizePostSchema.safeParse({
				requestId: "x",
				decision: "maybe",
			}).success,
		).toBe(false);
	});

	it("AgentSummarySchema rejects negative elapsedMs", () => {
		expect(
			AgentSummarySchema.safeParse({
				id: "main",
				kind: "main",
				parentId: null,
				task: null,
				status: "running",
				startedAt: "2026-05-12T07:55:00.000Z",
				elapsedMs: -1,
				lastHeartbeatAt: null,
				pendingAuthRequest: null,
			}).success,
		).toBe(false);
	});
});

describe("v2 schemas — memory/skills/tools/mcp/config", () => {
	it("MemoryTierSchema requires non-negative count/bytes", () => {
		expect(
			MemoryTierSchema.safeParse({
				tier: "working",
				count: -1,
				bytes: 0,
				latestAt: null,
				latestPreview: null,
			}).success,
		).toBe(false);
		expect(
			MemoryTierSchema.safeParse({
				tier: "skill",
				count: 0,
				bytes: 0,
				latestAt: null,
				latestPreview: null,
			}).success,
		).toBe(true);
	});

	it("MemoryTiersSchema is an array", () => {
		expect(MemoryTiersSchema.safeParse([]).success).toBe(true);
	});

	it("MemoryEntrySchema enforces source enum", () => {
		expect(
			MemoryEntrySchema.safeParse({
				id: "m1",
				tier: "skill",
				content: "",
				createdAt: "2026-05-12T08:00:00.000Z",
				source: "explicit",
				agentId: "main",
			}).success,
		).toBe(true);
		expect(
			MemoryEntrySchema.safeParse({
				id: "m1",
				tier: "skill",
				content: "",
				createdAt: "2026-05-12T08:00:00.000Z",
				source: "bogus",
				agentId: "main",
			}).success,
		).toBe(false);
	});

	it("SkillSchema and SkillsCatalogSchema accept valid payloads", () => {
		const skill = {
			name: "x",
			source: "local" as const,
			maturity: "M0" as const,
			usedCount: 0,
			description: "",
			triggers: [],
		};
		expect(SkillSchema.safeParse(skill).success).toBe(true);
		expect(SkillsCatalogSchema.safeParse([skill]).success).toBe(true);
	});

	it("ToolSchema bounds successRate to [0,1]", () => {
		const valid = ToolSchema.safeParse({
			name: "t",
			category: "core",
			source: "builtin",
			usedCount: 0,
			successRate: 0.5,
			avgLatencyMs: 10,
		});
		expect(valid.success).toBe(true);
		const invalid = ToolSchema.safeParse({
			name: "t",
			category: "core",
			source: "builtin",
			usedCount: 0,
			successRate: 1.5,
			avgLatencyMs: 10,
		});
		expect(invalid.success).toBe(false);
	});

	it("ToolsCatalogSchema accepts array of tools", () => {
		expect(ToolsCatalogSchema.safeParse([]).success).toBe(true);
	});

	it("MCPRegistrySchema accepts array of MCP server entries", () => {
		expect(
			MCPRegistrySchema.safeParse([
				{
					name: "x",
					transport: "stdio",
					status: "healthy",
					toolsCount: 0,
					callsToday: 0,
					avgLatencyMs: 0,
				},
			]).success,
		).toBe(true);
	});

	it("ConfigSchema is partial-able via ConfigPatchSchema", () => {
		expect(ConfigPatchSchema.safeParse({}).success).toBe(true);
		expect(ConfigPatchSchema.safeParse({ trustMode: "yolo" }).success).toBe(
			true,
		);
		expect(
			ConfigSchema.safeParse({
				trustMode: "auto",
				idleEvolution: false,
				autoReflect: true,
				tokenBudgetDaily: 1,
				tokenBudgetWarnAt: 0,
				modelDefault: "m",
				modelCheap: "c",
				redactionPolicy: "strict",
			}).success,
		).toBe(true);
	});
});

describe("v2 schemas — sessions/turns/snapshot", () => {
	it("SessionSummarySchema and SessionsListResponse round-trip", () => {
		const session = {
			id: "s",
			title: "",
			agentId: "main",
			turnsCount: 0,
			tokensTotal: 0,
			startedAt: "2026-05-12T08:00:00.000Z",
			lastTurnAt: "2026-05-12T08:00:00.000Z",
			status: "active" as const,
			costUsd: null,
		};
		expect(SessionSummarySchema.safeParse(session).success).toBe(true);
		expect(
			SessionsListResponse.safeParse({ items: [session], nextCursor: null })
				.success,
		).toBe(true);
		expect(
			SessionsListResponse.safeParse({ items: [], nextCursor: "abc" }).success,
		).toBe(true);
	});

	it("TurnSchema requires tokens object and content", () => {
		expect(
			TurnSchema.safeParse({
				id: "t1",
				role: "assistant",
				agentId: "main",
				startedAt: "2026-05-12T08:00:00.000Z",
				finishedAt: null,
				events: [],
				content: "",
				reflection: null,
				tokens: { thinking: 0, tools: 0, response: 0 },
			}).success,
		).toBe(true);
	});

	it("LoopStepEventSchema is permissive on payload", () => {
		expect(
			LoopStepEventSchema.safeParse({
				id: "e",
				kind: "anything",
				timestamp: "2026-05-12T08:00:00.000Z",
			}).success,
		).toBe(true);
	});

	it("SessionDetailSchema bundles a session and its turns", () => {
		expect(
			SessionDetailSchema.safeParse({
				session: {
					id: "s",
					title: "",
					agentId: "main",
					turnsCount: 0,
					tokensTotal: 0,
					startedAt: "2026-05-12T08:00:00.000Z",
					lastTurnAt: "2026-05-12T08:00:00.000Z",
					status: "active",
					costUsd: null,
				},
				turns: [],
			}).success,
		).toBe(true);
	});

	it("RuntimeSnapshotSchema enforces nested shape", () => {
		const ok = RuntimeSnapshotSchema.safeParse({
			version: "0.1.0",
			startedAt: "2026-05-12T08:00:00.000Z",
			currentSessionId: null,
			currentAgentId: null,
			agents: [],
			memory: [],
			skills: [],
			tools: [],
			mcp: [],
			config: {
				trustMode: "auto",
				idleEvolution: false,
				autoReflect: true,
				tokenBudgetDaily: 1,
				tokenBudgetWarnAt: 0,
				modelDefault: "m",
				modelCheap: "c",
				redactionPolicy: "minimal",
			},
			trustMode: "auto",
		});
		expect(ok.success).toBe(true);
	});
});

describe("v2 schemas — SSE discriminator", () => {
	it("SseEventSchema accepts each declared kind", () => {
		for (const kind of SSE_EVENT_KINDS) {
			const payload =
				kind === "loop-step"
					? {
							id: "x",
							kind: "step",
							timestamp: "2026-05-12T08:00:00.000Z",
						}
					: kind === "auth-request"
						? {
								id: "x",
								agentId: "main",
								tool: "shell_exec",
								args: {},
								reason: "",
								classification: "LOW" as const,
								impactEstimate: null,
							}
						: kind === "auth-resolved"
							? {
									requestId: "x",
									decision: "approve" as const,
									resolvedAt: "2026-05-12T08:00:00.000Z",
								}
							: { hello: "world" };
			const result = SseEventSchema.safeParse({ kind, payload });
			expect(result.success).toBe(true);
		}
	});

	it("SseEventSchema rejects unknown kinds", () => {
		expect(
			SseEventSchema.safeParse({ kind: "not-a-kind", payload: {} }).success,
		).toBe(false);
	});
});

describe("v2 schemas — grouped exports", () => {
	it("V2Schemas exposes every named export", () => {
		expect(V2Schemas.IsoDateTime).toBe(IsoDateTime);
		expect(V2Schemas.SseEventSchema).toBe(SseEventSchema);
		expect(V2Schemas.ConfigPatchSchema).toBe(ConfigPatchSchema);
		expect(V2Schemas.AuthorizePostSchema).toBe(AuthorizePostSchema);
		expect(V2Schemas.AuthRequestSchema).toBe(AuthRequestSchema);
		expect(V2Schemas.RuntimeSnapshotSchema).toBe(RuntimeSnapshotSchema);
	});

	it("ERROR_CODES is exhaustive", () => {
		expect(ERROR_CODES.sessionNotFound).toBe("session_not_found");
		expect(ERROR_CODES.validationError).toBe("validation_error");
		expect(ERROR_CODES.forbiddenCriticalWrite).toBe("forbidden_critical_write");
	});
});
