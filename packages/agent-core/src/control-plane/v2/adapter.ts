import type { CapabilitiesRuntime } from "../../config/loader.js";
import type { UserConfig } from "../../config/user-config-schema.js";
import type { LocalMemoryBackend } from "../../memory/local-backend.js";
import type { DashboardRuntimeRefs } from "../../observability/dashboard-runtime-providers.js";
import type { SQLiteCheckpoint } from "../../state/checkpoint.js";
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
	AuthorizePost,
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
	Turn,
} from "./schemas.js";

interface MessageTokenUsage {
	readonly response?: number;
	readonly thinking?: number;
}

function messageTokenTotal(message: unknown): number {
	if (
		message == null ||
		typeof message !== "object" ||
		!("tokens" in message)
	) {
		return 0;
	}

	const tokens = (message as { readonly tokens?: MessageTokenUsage }).tokens;
	if (tokens == null) {
		return 0;
	}
	return (tokens.response ?? 0) + (tokens.thinking ?? 0);
}

export interface V2RuntimeAdapterOptions {
	readonly refs: DashboardRuntimeRefs;
	readonly checkpoint: SQLiteCheckpoint;
	readonly getUserConfig: () => UserConfig;
	readonly getCapabilitiesRuntime: () => CapabilitiesRuntime;
}

export class V2RuntimeAdapter implements V2Runtime {
	private readonly refs: DashboardRuntimeRefs;
	private readonly checkpoint: SQLiteCheckpoint;
	private readonly getUserConfig: () => UserConfig;
	private readonly getCapabilitiesRuntime: () => CapabilitiesRuntime;
	private readonly startedAtIso: string;
	private readonly startedAtTime: number;
	private tokenBudgetWarnAt = 0.8;
	private redactionPolicy: Config["redactionPolicy"] = "standard";

	private readonly sseSubscribers = new Set<{
		readonly options: SseSubscribeOptions;
		readonly subscriber: SseSubscriber;
	}>();

	constructor(options: V2RuntimeAdapterOptions) {
		this.refs = options.refs;
		this.checkpoint = options.checkpoint;
		this.getUserConfig = options.getUserConfig;
		this.getCapabilitiesRuntime = options.getCapabilitiesRuntime;
		this.startedAtTime = Date.now();
		this.startedAtIso = new Date().toISOString();
	}

	async getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
		const config = this.getConfig();
		const agents = await this.listAgents();
		const memory = await this.listMemoryTiers();
		const skills = await this.listSkills();
		const tools = this.listTools();
		const mcp = await this.listMcp();

		return {
			version: "0.0.3",
			startedAt: this.startedAtIso,
			currentSessionId: process.env.QUILIN_SESSION_ID || "main-repl",
			currentAgentId: "main",
			agents: [...agents],
			memory,
			skills,
			tools,
			mcp,
			config,
			trustMode: config.trustMode,
		};
	}

	async listSessions(
		options: ListSessionsOptions,
	): Promise<SessionsListResponseT> {
		const summaries = await this.checkpoint.listSessions();
		const items: SessionSummary[] = [];

		for (const s of summaries) {
			const state = await this.checkpoint.load(s.sessionId);
			if (state) {
				const turnsCount = state.messages.filter(
					(m) => m.role === "user",
				).length;
				items.push({
					id: s.sessionId,
					title: s.lastMessage || "Quilin Session",
					agentId: "main",
					turnsCount: turnsCount || s.messageCount || 0,
					tokensTotal: state.messages.reduce(
						(acc, m) => acc + messageTokenTotal(m),
						0,
					),
					startedAt: state.createdAt || s.lastActiveAt,
					lastTurnAt: state.lastActiveAt || s.lastActiveAt,
					status: "active",
					costUsd: null,
				});
			} else {
				items.push({
					id: s.sessionId,
					title: s.lastMessage || "Quilin Session",
					agentId: "main",
					turnsCount: s.messageCount || 0,
					tokensTotal: 0,
					startedAt: s.lastActiveAt,
					lastTurnAt: s.lastActiveAt,
					status: "active",
					costUsd: null,
				});
			}
		}

		// Support limit filter if present
		let finalItems = items;
		if (options.limit !== undefined) {
			finalItems = items.slice(0, options.limit);
		}

		return {
			items: finalItems,
			nextCursor: null,
		};
	}

	async getSession(id: string): Promise<SessionDetail | null> {
		const state = await this.checkpoint.load(id);
		if (!state) return null;

		const summaries = await this.checkpoint.listSessions();
		const s = summaries.find((x) => x.sessionId === id) || {
			sessionId: id,
			lastMessage: "",
			messageCount: state.messages.length,
			lastActiveAt: state.lastActiveAt,
		};

		const turnsCount = state.messages.filter((m) => m.role === "user").length;

		const session: SessionSummary = {
			id,
			title: s.lastMessage || "Quilin Session",
			agentId: "main",
			turnsCount: turnsCount || s.messageCount || 0,
			tokensTotal: state.messages.reduce(
				(acc, m) => acc + messageTokenTotal(m),
				0,
			),
			startedAt: state.createdAt || s.lastActiveAt,
			lastTurnAt: state.lastActiveAt || s.lastActiveAt,
			status: "active",
			costUsd: null,
		};

		const turns: Turn[] = [];
		let index = 0;
		for (const m of state.messages) {
			if (m.role === "tool") continue;

			turns.push({
				id: `turn-${index}`,
				role: m.role as "user" | "assistant" | "system",
				agentId: "main",
				startedAt: state.createdAt || s.lastActiveAt,
				finishedAt: state.lastActiveAt || s.lastActiveAt,
				events: [],
				content: m.content,
				reflection: null,
				tokens: {
					thinking: 0,
					tools: 0,
					response: 0,
				},
			});
			index++;
		}

		return {
			session,
			turns,
		};
	}

	async listMemoryTiers(): Promise<MemoryTiers> {
		const factory = this.refs.memoryBackendFactory;
		if (factory == null) {
			return [
				{
					tier: "working",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
				{
					tier: "episodic",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
				{
					tier: "semantic",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
				{
					tier: "skill",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
			];
		}

		let backend: LocalMemoryBackend | undefined;
		try {
			backend = factory();
			const counts = backend.countByTier();
			const tiers: MemoryTiers = [];
			for (const tier of [
				"working",
				"episodic",
				"semantic",
				"skill",
			] as const) {
				const recent = backend.list({ layer: tier, limit: 1 });
				const latest = recent[0];
				tiers.push({
					tier,
					count: counts[tier] ?? 0,
					bytes: (counts[tier] ?? 0) * 128,
					latestAt: latest ? new Date(latest.timestamp).toISOString() : null,
					latestPreview: latest ? latest.content.slice(0, 100) : null,
				});
			}
			return tiers;
		} catch {
			return [
				{
					tier: "working",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
				{
					tier: "episodic",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
				{
					tier: "semantic",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
				{
					tier: "skill",
					count: 0,
					bytes: 0,
					latestAt: null,
					latestPreview: null,
				},
			];
		} finally {
			backend?.close();
		}
	}

	async listMemoryRecent(
		options: ListMemoryRecentOptions,
	): Promise<readonly MemoryEntry[]> {
		const factory = this.refs.memoryBackendFactory;
		if (factory == null) return [];
		let backend: LocalMemoryBackend | undefined;
		try {
			backend = factory();
			const items = backend.list({
				layer: options.tier,
				limit: options.limit,
			});
			return items.map((item) => ({
				id: item.id,
				tier: item.layer,
				content: item.content,
				createdAt: new Date(item.timestamp).toISOString(),
				source: "explicit",
				agentId: "main",
			}));
		} catch {
			return [];
		} finally {
			backend?.close();
		}
	}

	async listSkills(): Promise<SkillsCatalog> {
		const runtime = this.getCapabilitiesRuntime();
		const manager = runtime.skillsManager;
		if (manager == null) {
			return [];
		}

		try {
			const descriptors = await manager.discover();
			return descriptors.map((d) => {
				let source: "local" | "project" | "remote" = "local";
				if (d.source === "project") {
					source = "project";
				}

				return {
					name: d.name,
					source,
					maturity: "M1",
					usedCount: 0,
					description: d.description || "",
					triggers:
						d.frontmatter?.whenToUse == null ||
						d.frontmatter.whenToUse.trim() === ""
							? []
							: [d.frontmatter.whenToUse],
				};
			});
		} catch {
			return [];
		}
	}

	listTools(): ToolsCatalog {
		const registry = this.refs.registry;
		if (registry == null) {
			return [];
		}

		try {
			const allTools = registry.getAllTools();
			const allowedCategories = [
				"core",
				"orchestration",
				"network",
				"discovery",
				"multimodal",
			];

			return allTools.map((t) => {
				const category = allowedCategories.includes(t.category || "")
					? (t.category as
							| "core"
							| "orchestration"
							| "network"
							| "discovery"
							| "multimodal")
					: "core";
				const source =
					t.namespace && t.namespace !== "builtin" ? "mcp" : "builtin";
				return {
					name: t.name,
					category,
					source,
					usedCount: 0,
					successRate: null,
					avgLatencyMs: null,
				};
			});
		} catch {
			return [];
		}
	}

	async listMcp(): Promise<MCPRegistry> {
		const runtime = this.getCapabilitiesRuntime();
		const mcpServers = runtime.mcpServers || [];
		const registry = this.refs.registry;
		const allTools = registry ? registry.getAllTools() : [];

		return mcpServers.map((entry) => {
			const ns = entry.namespace || entry.id;
			const toolsForServer = allTools.filter(
				(t) => t.namespace === entry.id || t.namespace === ns,
			);

			let transport: "stdio" | "http" = "stdio";
			if (entry.config.type === "http") {
				transport = "http";
			}

			return {
				name: entry.id,
				transport,
				status: "healthy",
				toolsCount: toolsForServer.length,
				callsToday: 0,
				avgLatencyMs: 0,
			};
		});
	}

	getConfig(): Config {
		const raw = this.getUserConfig();
		return {
			trustMode: raw.safety?.trust_mode ?? "ask",
			idleEvolution: raw.idle_evolution.enabled,
			autoReflect: raw.memory.observer.enabled,
			tokenBudgetDaily: raw.idle_evolution.daily_budget_tokens,
			tokenBudgetWarnAt: this.tokenBudgetWarnAt,
			modelDefault: raw.llm.default_model,
			modelCheap: raw.llm.tiers.flash.model,
			redactionPolicy: this.redactionPolicy,
		};
	}

	writeConfig(patch: ConfigPatch): ConfigWriteResult {
		const raw = this.getUserConfig();
		const criticalField =
			patch.trustMode !== undefined
				? "trustMode"
				: patch.modelDefault !== undefined
					? "modelDefault"
					: null;
		if (criticalField != null) {
			return {
				kind: "forbidden",
				code: "forbidden_critical_write",
				message: `${criticalField} requires WriteAuthority approval before it can be changed through the v2 control plane.`,
				detail: { field: criticalField },
			};
		}

		if (patch.idleEvolution !== undefined)
			raw.idle_evolution.enabled = patch.idleEvolution;
		if (patch.autoReflect !== undefined)
			raw.memory.observer.enabled = patch.autoReflect;
		if (patch.tokenBudgetDaily !== undefined)
			raw.idle_evolution.daily_budget_tokens = patch.tokenBudgetDaily;
		if (patch.tokenBudgetWarnAt !== undefined)
			this.tokenBudgetWarnAt = patch.tokenBudgetWarnAt;
		if (patch.modelCheap !== undefined)
			raw.llm.tiers.flash.model = patch.modelCheap;
		if (patch.redactionPolicy !== undefined)
			this.redactionPolicy = patch.redactionPolicy;

		return {
			kind: "ok",
			config: this.getConfig(),
		};
	}

	async listAgents(): Promise<readonly AgentSummary[]> {
		const agents: AgentSummary[] = [];

		const startedAt = this.startedAtIso;
		const elapsedMs = Date.now() - this.startedAtTime;

		agents.push({
			id: "main",
			kind: "main",
			parentId: null,
			task: null,
			status: "running",
			startedAt,
			elapsedMs,
			lastHeartbeatAt: new Date().toISOString(),
			pendingAuthRequest: null,
		});

		const supervisor = this.refs.supervisorRuntime;
		if (supervisor != null) {
			try {
				const snapshot = supervisor.snapshot();
				for (const record of snapshot.records) {
					const recordStartedAt = record.createdAt || startedAt;
					const recordElapsedMs = Math.max(
						0,
						Date.now() - new Date(recordStartedAt).getTime(),
					);
					agents.push({
						id: record.runId,
						kind: "subagent",
						parentId: "main",
						task: record.taskId || record.summary || null,
						status: this.mapStatus(record.status),
						startedAt: recordStartedAt,
						elapsedMs: recordElapsedMs,
						lastHeartbeatAt: record.lastHeartbeatAt || null,
						pendingAuthRequest: null,
					});
				}
			} catch {
				// swallow and continue
			}
		}

		return agents;
	}

	authorize(_input: AuthorizePost): AuthorizeResult {
		return { kind: "ok" };
	}

	subscribeSse(
		options: SseSubscribeOptions,
		subscriber: SseSubscriber,
	): SseSubscription {
		const entry = { options, subscriber };
		this.sseSubscribers.add(entry);
		return {
			unsubscribe: () => {
				this.sseSubscribers.delete(entry);
			},
			backlog: [],
		};
	}

	private mapStatus(
		status: string,
	): "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled" {
		switch (status) {
			case "pending":
				return "pending";
			case "running":
				return "running";
			case "blocked":
			case "waiting_for_review":
				return "blocked";
			case "completed":
				return "completed";
			case "failed":
				return "failed";
			case "cancelled":
				return "cancelled";
			default:
				return "pending";
		}
	}
}
