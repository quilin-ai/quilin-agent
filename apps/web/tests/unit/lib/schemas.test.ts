import { describe, expect, it } from "vitest";

import {
	AgentSummarySchema,
	AuthorizePostSchema,
	AuthRequestSchema,
	ConfigPatchSchema,
	ConfigSchema,
	IsoDateTime,
	MCPServerSchema,
	MemoryEntrySchema,
	MemoryTierSchema,
	RuntimeSnapshotSchema,
	SessionSummarySchema,
	SkillSchema,
	SseEventSchema,
	ToolSchema,
	TurnSchema,
} from "@/lib/schemas";

describe("zod schemas — happy parses", () => {
	it("SessionSummarySchema accepts a valid session", () => {
		const parsed = SessionSummarySchema.parse({
			id: "s1",
			title: "t",
			agentId: "main",
			turnsCount: 3,
			tokensTotal: 100,
			startedAt: "2026-05-12T10:00:00Z",
			lastTurnAt: "2026-05-12T10:00:00Z",
			status: "active",
			costUsd: null,
		});
		expect(parsed.id).toBe("s1");
	});

	it("MemoryTierSchema accepts each tier name", () => {
		for (const tier of ["working", "episodic", "semantic", "skill"] as const) {
			MemoryTierSchema.parse({
				tier,
				count: 0,
				bytes: 0,
				latestAt: null,
				latestPreview: null,
			});
		}
	});

	it("MemoryEntrySchema enforces source enum", () => {
		expect(() =>
			MemoryEntrySchema.parse({
				id: "m1",
				tier: "working",
				content: "x",
				createdAt: "2026-05-12T10:00:00Z",
				source: "bad",
				agentId: "main",
			}),
		).toThrow();
	});

	it("SkillSchema enforces maturity", () => {
		const parsed = SkillSchema.parse({
			name: "cross-review-loop",
			source: "project",
			maturity: "M2",
			usedCount: 47,
			description: "...",
			triggers: ["写完代码"],
		});
		expect(parsed.maturity).toBe("M2");
	});

	it("ToolSchema validates success rate bounds", () => {
		expect(() =>
			ToolSchema.parse({
				name: "read_file",
				category: "core",
				source: "builtin",
				usedCount: 1,
				successRate: 1.2,
				avgLatencyMs: 12,
			}),
		).toThrow();
	});

	it("MCPServerSchema enforces transport", () => {
		MCPServerSchema.parse({
			name: "quilin-mem",
			transport: "stdio",
			status: "healthy",
			toolsCount: 4,
			callsToday: 89,
			avgLatencyMs: 12,
		});
	});

	it("ConfigSchema rejects out-of-range warn_at", () => {
		expect(() =>
			ConfigSchema.parse({
				trustMode: "auto",
				idleEvolution: false,
				autoReflect: true,
				tokenBudgetDaily: 120_000,
				tokenBudgetWarnAt: 1.5,
				modelDefault: "claude",
				modelCheap: "haiku",
				redactionPolicy: "standard",
			}),
		).toThrow();
	});

	it("ConfigPatchSchema accepts partial input", () => {
		const result = ConfigPatchSchema.parse({ trustMode: "ask" });
		expect(result).toEqual({ trustMode: "ask" });
	});

	it("AgentSummarySchema accepts pending auth request", () => {
		const result = AgentSummarySchema.parse({
			id: "review-loop-r1",
			kind: "subagent",
			parentId: "main",
			task: "cross-review",
			status: "running",
			startedAt: "2026-05-12T10:00:00Z",
			elapsedMs: 12_000,
			lastHeartbeatAt: null,
			pendingAuthRequest: null,
		});
		expect(result.kind).toBe("subagent");
	});

	it("AuthRequestSchema enforces classification", () => {
		AuthRequestSchema.parse({
			id: "r1",
			agentId: "main",
			tool: "shell_exec",
			args: { cmd: "echo" },
			reason: "test",
			classification: "CRITICAL",
			impactEstimate: "1 file",
		});
	});

	it("AuthorizePostSchema requires decision", () => {
		expect(() => AuthorizePostSchema.parse({ requestId: "r1", decision: "approve" })).not.toThrow();
		expect(() => AuthorizePostSchema.parse({ requestId: "r1", decision: "bad" })).toThrow();
	});

	it("RuntimeSnapshotSchema composites cleanly", () => {
		RuntimeSnapshotSchema.parse({
			version: "0.1.0",
			startedAt: "2026-05-12T10:00:00Z",
			currentSessionId: "s1",
			currentAgentId: "main",
			agents: [],
			memory: [],
			skills: [],
			tools: [],
			mcp: [],
			config: {
				trustMode: "auto",
				idleEvolution: false,
				autoReflect: true,
				tokenBudgetDaily: 100,
				tokenBudgetWarnAt: 0.8,
				modelDefault: "claude",
				modelCheap: "haiku",
				redactionPolicy: "minimal",
			},
			trustMode: "auto",
		});
	});

	it("SseEventSchema validates known kinds", () => {
		// NR-D-2: SseEventSchema is now a discriminated union mirroring the
		// backend; `loop-step` carries a strict LoopStepEvent payload.
		const parsed = SseEventSchema.parse({
			kind: "loop-step",
			payload: {
				id: "ev-1",
				kind: "tool-call",
				timestamp: "2026-05-12T08:00:00.000Z",
			},
		});
		expect(parsed.kind).toBe("loop-step");
		expect(() => SseEventSchema.parse({ kind: "unknown", payload: {} })).toThrow();
	});

	it("TurnSchema parses tokens block with strict LoopStepEvent shape (R6)", () => {
		const turn = TurnSchema.parse({
			id: "t1",
			role: "assistant",
			agentId: "main",
			startedAt: "2026-05-12T10:00:00Z",
			finishedAt: null,
			events: [
				{
					id: "ev-1",
					kind: "memory-recall",
					timestamp: "2026-05-12T10:00:00Z",
				},
			],
			content: "hi",
			reflection: null,
			tokens: { thinking: 0, tools: 0, response: 0 },
		});
		expect(turn.role).toBe("assistant");
	});

	it("TurnSchema rejects events missing the required LoopStepEvent fields", () => {
		const looseTurn = {
			id: "t1",
			role: "user",
			agentId: "main",
			startedAt: "2026-05-12T10:00:00Z",
			finishedAt: null,
			events: [{ kind: "memory-recall" }],
			content: "hi",
			reflection: null,
			tokens: { thinking: 0, tools: 0, response: 0 },
		};
		expect(() => TurnSchema.parse(looseTurn)).toThrow();
	});

	it("IsoDateTime rejects non-RFC3339 strings (R4)", () => {
		// Frontend used to accept any non-empty string; now matches
		// backend's z.string().datetime({ offset: true }).
		expect(IsoDateTime.safeParse("not a date").success).toBe(false);
		expect(IsoDateTime.safeParse("2026-05-12T10:00:00Z").success).toBe(true);
	});
});
