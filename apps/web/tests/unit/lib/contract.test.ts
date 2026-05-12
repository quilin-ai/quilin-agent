/**
 * Contract parity test: verifies the frontend Zod mirror in
 * `apps/web/lib/schemas.ts` agrees on wire shapes with the canonical
 * backend schemas at `packages/agent-core/src/control-plane/v2/schemas.ts`.
 *
 * Both sides ship Zod schemas that MUST round-trip identical sample
 * payloads. This is the safety net for the R1-R8 class of drift that
 * QUI-154 Phase 1 cross-review round 1 surfaced.
 *
 * 契约对齐测试：验证前端镜像与后端 canonical schema 在有线形状上一致。
 * 任何漂移都是 QUI-154 Phase 1 round 1 cross-review 抓出的那一类问题。
 *
 * Location note:
 *
 * The test lives under `apps/web` (not `packages/agent-core`) because the
 * agent-core tsconfig pins `rootDir: src`, which blocks cross-package
 * file imports. The web test runner already has both schemas accessible
 * via relative imports, so we resolve the backend canonical file
 * directly here and keep the frontend mirror import via the standard
 * `@` alias.
 *
 * 测试放在 `apps/web` 而不是 `packages/agent-core` 的原因：agent-core
 * 的 tsconfig 把 `rootDir` 限定在 `src`，不允许跨 package 的相对路径
 * 引用。web 测试已经能通过相对路径访问后端 schema，前端 mirror 走 `@`
 * 别名即可。
 */

import { describe, expect, it } from "vitest";

// Frontend Zod mirror — imported via the standard @/lib alias.
import * as frontend from "@/lib/schemas";
// Backend canonical schemas — relative path bypasses the
// `@quilin/agent-core/control-plane/v2/schemas` alias which is wired to
// the frontend mirror inside the web vitest config.
import * as backend from "../../../../../packages/agent-core/src/control-plane/v2/schemas";

const ISO = "2026-05-12T08:00:00.000Z";

const SAMPLE_SESSION_SUMMARY = {
	id: "session-001",
	title: "demo",
	agentId: "main",
	turnsCount: 1,
	tokensTotal: 100,
	startedAt: ISO,
	lastTurnAt: ISO,
	status: "active",
	costUsd: 0.12,
} as const;

const SAMPLE_TURN = {
	id: "turn-1",
	role: "user",
	agentId: "main",
	startedAt: ISO,
	finishedAt: ISO,
	events: [
		{
			id: "ev-1",
			kind: "loop-step",
			timestamp: ISO,
		},
	],
	content: "hello",
	reflection: null,
	tokens: { thinking: 0, tools: 0, response: 0 },
} as const;

const SAMPLE_SESSION_DETAIL = {
	session: SAMPLE_SESSION_SUMMARY,
	turns: [SAMPLE_TURN],
} as const;

const SAMPLE_MEMORY_ENTRY = {
	id: "m1",
	tier: "working",
	content: "ctx",
	createdAt: ISO,
	source: "user",
	agentId: "main",
} as const;

const SAMPLE_AGENT_SUMMARY = {
	id: "main",
	kind: "main",
	parentId: null,
	task: null,
	status: "running",
	startedAt: ISO,
	elapsedMs: 1_000,
	lastHeartbeatAt: ISO,
	pendingAuthRequest: null,
} as const;

const SAMPLE_AUTH_RESPONSE = {
	requestId: "auth-1",
	resolved: true,
} as const;

interface SchemaLike {
	readonly safeParse: (v: unknown) => { readonly success: boolean };
}

function bothParse(
	backendSchema: SchemaLike,
	frontendSchema: SchemaLike,
	sample: unknown,
): { backend: boolean; frontend: boolean } {
	return {
		backend: backendSchema.safeParse(sample).success,
		frontend: frontendSchema.safeParse(sample).success,
	};
}

describe("v2 schemas — frontend/backend contract parity", () => {
	it("IsoDateTime: backend strict ISO (offset) — frontend tightened to match (R4)", () => {
		expect(backend.IsoDateTime.safeParse(ISO).success).toBe(true);
		expect(frontend.IsoDateTime.safeParse(ISO).success).toBe(true);

		// Negative test — a bare string previously slipped through the
		// frontend's `z.string().min(1)`. Both sides must reject now.
		expect(backend.IsoDateTime.safeParse("not a date").success).toBe(false);
		expect(frontend.IsoDateTime.safeParse("not a date").success).toBe(false);
	});

	it("SessionDetail wire shape: { session, turns } on both sides (R1)", () => {
		const result = bothParse(
			backend.SessionDetailSchema,
			frontend.SessionDetailSchema,
			SAMPLE_SESSION_DETAIL,
		);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);
	});

	it("MemoryRecentResponse wraps memory entries in { items } (R2)", () => {
		const payload = { items: [SAMPLE_MEMORY_ENTRY] };
		const result = bothParse(
			backend.MemoryRecentResponseSchema,
			frontend.MemoryRecentResponseSchema,
			payload,
		);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);
	});

	it("AgentsListResponse wraps agent summaries in { items } (R3)", () => {
		const payload = { items: [SAMPLE_AGENT_SUMMARY] };
		const result = bothParse(
			backend.AgentsListResponseSchema,
			frontend.AgentsListResponseSchema,
			payload,
		);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);
	});

	it("AuthorizeResponse includes requestId + resolved (R5)", () => {
		const result = bothParse(
			backend.AuthorizeResponseSchema,
			frontend.AuthorizeResponseSchema,
			SAMPLE_AUTH_RESPONSE,
		);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);
	});

	it("Turn.events enforces LoopStepEvent shape, not opaque records (R6)", () => {
		// A loose record-without-required-fields used to pass the frontend
		// but never the backend. After R6 both must reject it.
		const looseTurn = {
			...SAMPLE_TURN,
			events: [{ random: "blob" }],
		};
		expect(backend.TurnSchema.safeParse(looseTurn).success).toBe(false);
		expect(frontend.TurnSchema.safeParse(looseTurn).success).toBe(false);

		// The strict shape parses on both sides.
		expect(backend.TurnSchema.safeParse(SAMPLE_TURN).success).toBe(true);
		expect(frontend.TurnSchema.safeParse(SAMPLE_TURN).success).toBe(true);
	});

	it("Schema export names match backend canonical (R7)", () => {
		// Schema-name parity is a structural concern: both sides MUST
		// export the renamed symbols as Zod schemas so a future
		// `export * from "@quilin/agent-core/control-plane/v2/schemas"`
		// swap is a no-op rename.
		const expected = [
			"TrustMode",
			"SessionStatus",
			"MemoryTierName",
			"AuthClassification",
			"AgentStatus",
			"SessionsListResponse",
			"SseEventKind",
		] as const;
		for (const name of expected) {
			expect(name in frontend).toBe(true);
			expect(name in backend).toBe(true);
			const fSchema = (frontend as Record<string, unknown>)[name];
			const bSchema = (backend as Record<string, unknown>)[name];
			expect(typeof (fSchema as { safeParse?: unknown }).safeParse).toBe("function");
			expect(typeof (bSchema as { safeParse?: unknown }).safeParse).toBe("function");
		}
	});

	it("SseEvent: both sides accept a valid auth-request frame (NR-D-2)", () => {
		const event = {
			kind: "auth-request",
			payload: {
				id: "auth-1",
				agentId: "main",
				tool: "shell_exec",
				args: { command: "ls" },
				reason: "list project files",
				classification: "LOW",
				impactEstimate: null,
			},
		};
		const result = bothParse(backend.SseEventSchema, frontend.SseEventSchema, event);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);
	});

	it("SseEvent: both sides reject a malformed auth-request (NR-D-2)", () => {
		// Missing the required `id` field — backend strict schema rejects;
		// pre-fix frontend `payload: z.record(...)` would have accepted.
		const missingId = {
			kind: "auth-request",
			payload: {
				agentId: "main",
				tool: "shell_exec",
				args: {},
				reason: "x",
				classification: "LOW",
				impactEstimate: null,
			},
		};
		expect(backend.SseEventSchema.safeParse(missingId).success).toBe(false);
		expect(frontend.SseEventSchema.safeParse(missingId).success).toBe(false);

		// Wrong classification value — must be rejected on both sides too.
		const badClassification = {
			kind: "auth-request",
			payload: {
				id: "auth-2",
				agentId: "main",
				tool: "shell_exec",
				args: {},
				reason: "x",
				classification: "BOGUS",
				impactEstimate: null,
			},
		};
		expect(backend.SseEventSchema.safeParse(badClassification).success).toBe(false);
		expect(frontend.SseEventSchema.safeParse(badClassification).success).toBe(false);
	});

	it("SseEvent: PayloadShell kinds accept a bare {} payload (NR-D-2)", () => {
		// All 20 placeholder kinds use PayloadShell, which permits an empty
		// object plus any extra keys. Picking `memory-recall` as a
		// representative — same shape on both sides.
		const event = { kind: "memory-recall", payload: {} };
		const result = bothParse(backend.SseEventSchema, frontend.SseEventSchema, event);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);

		// And tolerate extra keys for forward-compatibility (catchall on
		// PayloadShell).
		const withExtras = {
			kind: "memory-recall",
			payload: { at: "2026-05-12T08:00:00.000Z", custom: 42 },
		};
		const r2 = bothParse(backend.SseEventSchema, frontend.SseEventSchema, withExtras);
		expect(r2.backend).toBe(true);
		expect(r2.frontend).toBe(true);
	});

	it("SseEvent: both sides accept a valid auth-resolved frame (NR-D-2)", () => {
		const event = {
			kind: "auth-resolved",
			payload: {
				requestId: "auth-1",
				decision: "approve",
				resolvedAt: ISO,
				resolver: "human",
			},
		};
		const result = bothParse(backend.SseEventSchema, frontend.SseEventSchema, event);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);
	});

	it("RuntimeSnapshot round-trips on both sides", () => {
		const snapshot = {
			version: "0.1.0",
			startedAt: ISO,
			currentSessionId: "s1",
			currentAgentId: "main",
			agents: [SAMPLE_AGENT_SUMMARY],
			memory: [
				{
					tier: "working",
					count: 1,
					bytes: 100,
					latestAt: ISO,
					latestPreview: "p",
				},
			],
			skills: [],
			tools: [],
			mcp: [],
			config: {
				trustMode: "auto",
				idleEvolution: false,
				autoReflect: true,
				tokenBudgetDaily: 100_000,
				tokenBudgetWarnAt: 0.8,
				modelDefault: "x",
				modelCheap: "y",
				redactionPolicy: "standard",
			},
			trustMode: "auto",
		};
		const result = bothParse(
			backend.RuntimeSnapshotSchema,
			frontend.RuntimeSnapshotSchema,
			snapshot,
		);
		expect(result.backend).toBe(true);
		expect(result.frontend).toBe(true);
	});
});
