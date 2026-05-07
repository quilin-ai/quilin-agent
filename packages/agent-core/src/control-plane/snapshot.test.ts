import { describe, expect, it } from "vitest";
import type { CapabilitiesReloadStatus } from "../config/hot-reload.js";
import type { UserRuntimeStateSnapshot } from "../config/runtime.js";
import type { SpanSnapshot } from "../observability/span.js";
import type { SkillsReloadStatus } from "../skills/manager.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { AgentState } from "../state/types.js";
import type { MCPServerEntry } from "../tools/registry.js";
import type { ToolPromptDescriptor } from "../tools/tool-metadata.js";
import {
	buildControlPlaneSnapshot,
	CONTROL_PLANE_SNAPSHOT_SCHEMA_VERSION,
	type ControlPlaneSkillsCatalogSource,
} from "./snapshot.js";

const NOW = "2026-05-07T08:00:00.000Z";
const SECRET_API_KEY = "sk-1234567890abcdef";
const SECRET_BEARER = "Bearer abcdefghijklmnop";
const TRACE_ID = "a".repeat(32);

const runtimeState: UserRuntimeStateSnapshot = {
	generation: 7,
	booted: true,
	inFlight: false,
	inFlightGenerations: [],
	lastSuccess: {
		generation: 7,
		operation: "bootstrap",
		completedAtEpochMs: 1_777_777_000_000,
		configPath: null,
		change: {
			added: ["defaults"],
			removed: [],
			changed: [],
		},
	},
	lastFailure: {
		generation: 6,
		operation: "reload",
		completedAtEpochMs: 1_777_776_000_000,
		errorName: "UserConfigError",
		errorMessage: `OPENAI_API_KEY=${SECRET_API_KEY}`,
	},
};

const capabilitiesStatus: CapabilitiesReloadStatus = {
	generation: 3,
	booted: true,
	watching: true,
	watchedPaths: ["capabilities.yaml"],
	inFlight: false,
	inFlightGenerations: [],
	lastSuccess: null,
	lastFailure: null,
	lastSkillsChange: null,
	skillsStatus: null,
	mcpReconnect: {
		status: "pending_repl_apply",
		reason: "applied_at_repl_turn_boundary",
		applyState: "pending",
		appliesAt: "repl_turn_boundary",
		pendingReason: "waiting_for_repl_turn_boundary",
		generation: 3,
		requestedAtEpochMs: 1_777_777_200_000,
		activeServerIds: ["memory"],
		change: {
			added: [],
			removed: [],
			changed: ["memory"],
		},
	},
	management: {
		config: {
			domain: "config",
			generation: 3,
			inFlight: false,
			applyState: "applied",
			added: [],
			removed: [],
			changed: ["capabilities.yaml"],
			error: null,
			lastApplied: null,
		},
		mcp: {
			domain: "mcp",
			generation: 3,
			inFlight: false,
			applyState: "pending_repl_turn_boundary",
			added: [],
			removed: [],
			changed: ["memory"],
			error: null,
			lastApplied: null,
		},
		skills: {
			domain: "skills",
			generation: 3,
			inFlight: false,
			applyState: "not_requested",
			added: [],
			removed: [],
			changed: [],
			error: null,
			lastApplied: null,
		},
	},
};

const agentState: AgentState = {
	createdAt: "2026-05-07T07:00:00.000Z",
	lastActiveAt: "2026-05-07T07:30:00.000Z",
	isTerminal: false,
	turnCount: 2,
	messages: [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: `stored credential OPENAI_API_KEY=${SECRET_API_KEY}`,
		},
	],
};

const sessionSpan: SpanSnapshot = {
	name: "agent.session",
	traceId: TRACE_ID,
	spanId: "b".repeat(16),
	startTimeUnixMs: Date.parse("2026-05-07T07:00:00.000Z"),
	endTimeUnixMs: Date.parse("2026-05-07T07:45:00.000Z"),
	durationMs: 2_700_000,
	status: "ok",
	attributes: {
		"session.id": "session-1",
		"session.user_id": "unknown",
		"session.task_summary": "email alpha@example.com about rollout",
		"session.turn_count": 3,
		"session.total_cost_usd": 0.02,
		"session.total_tokens": 42,
	},
	events: [],
	children: [],
};

const skillsReloadStatus: SkillsReloadStatus = {
	generation: 2,
	watching: false,
	inFlight: false,
	inFlightGenerations: [],
	lastSuccess: {
		generation: 2,
		completedAtEpochMs: 1_777_777_100_000,
		catalogSize: 1,
		change: {
			added: ["deploy"],
			removed: [],
			changed: [],
		},
	},
	lastFailure: null,
};

const skillDescriptor: SkillDescriptor = {
	name: "deploy",
	description: `deploy with ${SECRET_BEARER}`,
	path: "/workspace/skills/deploy/SKILL.md",
	source: "project",
	frontmatter: {
		name: "deploy",
		description: "deploy",
		userInvocable: true,
		disableModelInvocation: false,
		mandatory: false,
		allowedTools: ["shell"],
		requiresTools: ["git"],
		requiresToolsets: ["repo"],
		trust: "community",
		dependencies: {
			skills: ["review"],
			tools: ["test"],
		},
	},
};

const skillsManager: ControlPlaneSkillsCatalogSource = {
	list: () => [skillDescriptor],
	getRecentSkillNames: () => ["deploy"],
	getReloadStatus: () => skillsReloadStatus,
};

const mcpTools: readonly ToolPromptDescriptor[] = [
	{
		name: "memory/search",
		description: `search using ${SECRET_BEARER}`,
		category: "programmatic",
		riskLevel: "read",
	},
];

const mcpServers: readonly MCPServerEntry[] = [
	{
		id: "memory",
		namespace: "memory",
		defaultRiskLevel: "read",
		config: {
			command: "node",
			args: ["server.js", `OPENAI_API_KEY=${SECRET_API_KEY}`],
			cwd: "/workspace",
		},
	},
];

describe("buildControlPlaneSnapshot", () => {
	it("aggregates read-only console data and redacts secrets", async () => {
		const snapshot = await buildControlPlaneSnapshot({
			now: () => new Date(NOW),
			runtimeState,
			capabilitiesStatus,
			checkpoint: {
				list: async () => ["session-1"],
				load: async () => agentState,
			},
			traceStore: {
				querySpanSnapshots: async () => ({
					spans: [sessionSpan],
					skippedLines: 0,
					files: ["traces-2026-05-07.jsonl"],
				}),
			},
			skillsManager,
			mcpRegistry: {
				getToolDescriptors: () => mcpTools,
			},
			mcpServers,
			providerProbe: {
				env: {
					DEEPSEEK_API_KEY: "plain-deepseek-secret",
				},
				existingCredentialPaths: [],
			},
			config: {
				llm: {
					api_key: SECRET_API_KEY,
				},
				session_token: "plain-session-secret",
				database_url: "postgres://user:pass@localhost/db",
			},
			configSources: {
				"llm.default_model": "default",
			},
			supervisorRecords: [
				{
					sourceEventId: "event-1",
					eventType: "child_heartbeat",
					severity: "info",
					title: "Heartbeat",
					summary: `still has ${SECRET_BEARER}`,
					childRunId: "run-1",
					taskId: "task-1",
					timestamp: NOW,
				},
			],
			observabilityEvents: [
				{
					kind: "component_health",
					timestamp: NOW,
					source: "agent-core.test",
					payload: {
						component: "control-plane",
						source: `OPENAI_API_KEY=${SECRET_API_KEY}`,
					},
				},
			],
		});

		expect(snapshot.schemaVersion).toBe(CONTROL_PLANE_SNAPSHOT_SCHEMA_VERSION);
		expect(snapshot.generatedAt).toBe(NOW);
		expect(snapshot.agent.status).toBe("degraded");
		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]).toMatchObject({
			sessionId: "session-1",
			source: "checkpoint+trace",
			status: "active",
			turnCount: 3,
			messageCount: 2,
			totalTokens: 42,
			taskSummary: "email [REDACTED:email] about rollout",
			traceIds: [TRACE_ID],
		});
		expect(snapshot.skills).toMatchObject({
			total: 1,
			countsBySource: { project: 1 },
			countsByTrust: { community: 1 },
			recentSkillNames: ["deploy"],
		});
		expect(snapshot.mcp).toMatchObject({
			status: "active",
			activeServerIds: ["memory"],
			toolCount: 1,
			toolCountByNamespace: { memory: 1 },
			configuredServers: [
				expect.objectContaining({
					id: "memory",
					namespace: "memory",
					status: "pending_repl_apply",
				}),
			],
		});
		expect(snapshot.providers).toContainEqual(
			expect.objectContaining({
				provider: "deepseek",
				credentialStatus: "configured",
				configuredSources: ["env"],
			}),
		);
		expect(snapshot.config.redaction).toEqual({
			status: "applied",
			secretFields: "redacted",
		});

		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain(SECRET_API_KEY);
		expect(serialized).not.toContain(SECRET_BEARER);
		expect(serialized).not.toContain("plain-deepseek-secret");
		expect(serialized).not.toContain("plain-session-secret");
		expect(serialized).not.toContain("postgres://user:pass@localhost/db");
		expect(serialized).toContain("[REDACTED");
	});

	it("returns stable empty sections when optional runtimes are absent", async () => {
		const snapshot = await buildControlPlaneSnapshot({
			now: () => new Date(NOW),
			runtimeState: {
				generation: 0,
				booted: false,
				inFlight: false,
				inFlightGenerations: [],
				lastSuccess: null,
				lastFailure: null,
			},
		});

		expect(snapshot.agent.status).toBe("offline");
		expect(snapshot.sessions).toEqual([]);
		expect(snapshot.skills).toMatchObject({
			catalog: [],
			total: 0,
			recentSkillNames: [],
			reloadStatus: null,
		});
		expect(snapshot.mcp).toMatchObject({
			status: "empty",
			configuredServers: [],
			activeServerIds: [],
			toolCount: 0,
		});
		expect(snapshot.config.redacted).toBeNull();
	});
});
