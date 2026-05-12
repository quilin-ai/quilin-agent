/**
 * Shared test fixtures for v2 control-plane API routes.
 *
 * Provides a `createStubRuntime()` factory that returns a deterministic
 * `V2Runtime` implementation populated with realistic data shapes. Each
 * route test composes a stub with the methods it cares about overridden
 * for the scenario at hand.
 *
 * 给 v2 控制面 API 路由测试用的共享 fixture。createStubRuntime() 返回
 * 一个确定性的 V2Runtime stub，每个 case 只覆写关心的 method。
 */

import type {
	AuthorizeResult,
	ConfigWriteResult,
	ListMemoryRecentOptions,
	ListSessionsOptions,
	SseSubscribeOptions,
	SseSubscriber,
	SseSubscription,
	V2Runtime,
} from "./runtime.js";
import type {
	AgentSummary,
	Config,
	ConfigPatch,
	MCPRegistry,
	MemoryEntry,
	MemoryTiers,
	RuntimeSnapshot,
	SessionDetail,
	SessionSummary,
	SessionsListResponseT,
	SkillsCatalog,
	ToolsCatalog,
} from "./schemas.js";

export const FIXED_NOW = "2026-05-12T08:00:00.000Z";

export const stubConfig: Config = {
	trustMode: "auto",
	idleEvolution: false,
	autoReflect: true,
	tokenBudgetDaily: 100_000,
	tokenBudgetWarnAt: 0.8,
	modelDefault: "anthropic/claude-opus-4-7",
	modelCheap: "anthropic/claude-haiku-4-5",
	redactionPolicy: "standard",
};

export const stubAgents: readonly AgentSummary[] = [
	{
		id: "main",
		kind: "main",
		parentId: null,
		task: null,
		status: "running",
		startedAt: "2026-05-12T07:55:00.000Z",
		elapsedMs: 300_000,
		lastHeartbeatAt: FIXED_NOW,
		pendingAuthRequest: null,
	},
	{
		id: "review-loop-r1",
		kind: "subagent",
		parentId: "main",
		task: "Cross-review schema additions",
		status: "blocked",
		startedAt: "2026-05-12T07:58:00.000Z",
		elapsedMs: 120_000,
		lastHeartbeatAt: FIXED_NOW,
		pendingAuthRequest: {
			id: "auth-001",
			agentId: "review-loop-r1",
			tool: "shell_exec",
			args: { cmd: "rm -rf .logs" },
			reason: "cleanup before re-run",
			classification: "CRITICAL",
			impactEstimate: "delete tracing logs in worktree",
		},
	},
];

export const stubSnapshot: RuntimeSnapshot = {
	version: "0.1.0-iter-g2",
	startedAt: "2026-05-12T07:55:00.000Z",
	currentSessionId: "session-current",
	currentAgentId: "main",
	agents: [...stubAgents],
	memory: [
		{
			tier: "working",
			count: 4,
			bytes: 2_048,
			latestAt: FIXED_NOW,
			latestPreview: "working memory preview",
		},
		{
			tier: "episodic",
			count: 12,
			bytes: 24_576,
			latestAt: FIXED_NOW,
			latestPreview: "episodic memory preview",
		},
		{
			tier: "semantic",
			count: 38,
			bytes: 65_536,
			latestAt: FIXED_NOW,
			latestPreview: "semantic memory preview",
		},
		{
			tier: "skill",
			count: 5,
			bytes: 4_096,
			latestAt: FIXED_NOW,
			latestPreview: "skill memory preview",
		},
	],
	skills: [
		{
			name: "cross-review-loop",
			source: "local",
			maturity: "M2",
			usedCount: 7,
			description: "Two-reviewer cross code review loop",
			triggers: ["code review", "cross review"],
		},
	],
	tools: [
		{
			name: "shell_exec",
			category: "core",
			source: "builtin",
			usedCount: 42,
			successRate: 0.95,
			avgLatencyMs: 120,
		},
	],
	mcp: [
		{
			name: "quilin-mem",
			transport: "stdio",
			status: "healthy",
			toolsCount: 8,
			callsToday: 24,
			avgLatencyMs: 38,
		},
	],
	config: stubConfig,
	trustMode: "auto",
};

const stubSessions: readonly SessionSummary[] = [
	{
		id: "session-001",
		title: "Phase 1 backend wiring",
		agentId: "main",
		turnsCount: 8,
		tokensTotal: 12_500,
		startedAt: "2026-05-12T07:00:00.000Z",
		lastTurnAt: "2026-05-12T07:50:00.000Z",
		status: "active",
		costUsd: 0.34,
	},
	{
		id: "session-002",
		title: "Cross review polish",
		agentId: "review-loop-r1",
		turnsCount: 3,
		tokensTotal: 4_200,
		startedAt: "2026-05-12T06:00:00.000Z",
		lastTurnAt: "2026-05-12T06:30:00.000Z",
		status: "closed",
		costUsd: 0.11,
	},
];

const firstStubSession: SessionSummary = stubSessions[0] as SessionSummary;

const stubSessionDetail: SessionDetail = {
	session: firstStubSession,
	turns: [
		{
			id: "turn-001",
			role: "user",
			agentId: "main",
			startedAt: "2026-05-12T07:00:00.000Z",
			finishedAt: "2026-05-12T07:00:10.000Z",
			events: [],
			content: "Implement v2 control plane",
			reflection: null,
			tokens: { thinking: 0, tools: 0, response: 0 },
		},
	],
};

const stubMemoryRecent: readonly MemoryEntry[] = [
	{
		id: "mem-001",
		tier: "working",
		content: "ongoing context",
		createdAt: FIXED_NOW,
		source: "user",
		agentId: "main",
	},
	{
		id: "mem-002",
		tier: "episodic",
		content: "yesterday's session highlight",
		createdAt: "2026-05-11T12:00:00.000Z",
		source: "auto-reflect",
		agentId: "main",
	},
];

export interface StubRuntimeOverrides {
	readonly snapshot?: RuntimeSnapshot;
	readonly sessions?: SessionsListResponseT;
	readonly session?: SessionDetail | ((id: string) => SessionDetail | null);
	readonly memoryTiers?: MemoryTiers;
	readonly memoryRecent?:
		| readonly MemoryEntry[]
		| ((options: ListMemoryRecentOptions) => readonly MemoryEntry[]);
	readonly skills?: SkillsCatalog;
	readonly tools?: ToolsCatalog;
	readonly mcp?: MCPRegistry;
	readonly config?: Config;
	readonly writeConfig?: (patch: ConfigPatch) => ConfigWriteResult;
	readonly agents?: readonly AgentSummary[];
	readonly authorize?: (input: {
		readonly requestId: string;
	}) => AuthorizeResult;
	readonly subscribeSse?: (
		options: SseSubscribeOptions,
		subscriber: SseSubscriber,
	) => SseSubscription | Promise<SseSubscription>;
}

export function createStubRuntime(
	overrides: StubRuntimeOverrides = {},
): V2Runtime {
	const sessions: SessionsListResponseT = overrides.sessions ?? {
		items: [...stubSessions],
		nextCursor: null,
	};
	const sessionDetail = overrides.session ?? stubSessionDetail;

	return {
		getRuntimeSnapshot: () => overrides.snapshot ?? stubSnapshot,
		listSessions: (_options: ListSessionsOptions) => sessions,
		getSession: (id: string) => {
			if (typeof sessionDetail === "function") {
				return sessionDetail(id);
			}
			return id === sessionDetail.session.id ? sessionDetail : null;
		},
		listMemoryTiers: () => overrides.memoryTiers ?? stubSnapshot.memory,
		listMemoryRecent: (options: ListMemoryRecentOptions) => {
			if (typeof overrides.memoryRecent === "function") {
				return overrides.memoryRecent(options);
			}
			return overrides.memoryRecent ?? stubMemoryRecent;
		},
		listSkills: () => overrides.skills ?? stubSnapshot.skills,
		listTools: () => overrides.tools ?? stubSnapshot.tools,
		listMcp: () => overrides.mcp ?? stubSnapshot.mcp,
		getConfig: () => overrides.config ?? stubConfig,
		writeConfig: (patch: ConfigPatch) => {
			if (overrides.writeConfig != null) {
				return overrides.writeConfig(patch);
			}
			return {
				kind: "ok" as const,
				config: { ...stubConfig, ...patch },
			};
		},
		listAgents: () => overrides.agents ?? stubAgents,
		authorize: (input) => {
			if (overrides.authorize != null) {
				return overrides.authorize(input);
			}
			return { kind: "ok" as const };
		},
		subscribeSse: (options, subscriber) => {
			if (overrides.subscribeSse != null) {
				return overrides.subscribeSse(options, subscriber);
			}
			return {
				unsubscribe: () => {
					/* noop */
				},
			};
		},
	};
}

/**
 * Helper to read a Response envelope back as `{ status, body }` without
 * having to repeat the same JSON.parse / status assertions per test.
 *
 * 把 Response envelope 解开成 { status, body }，方便测试断言。
 */
export async function readJsonResponse<T = unknown>(
	response: Response,
): Promise<{
	readonly status: number;
	readonly body: {
		readonly ok: boolean;
		readonly data?: T;
		readonly error?: {
			readonly code: string;
			readonly message: string;
			readonly detail?: unknown;
		};
	};
}> {
	const text = await response.text();
	return {
		status: response.status,
		body: JSON.parse(text),
	};
}
