import { z } from "zod";
import { logger } from "../../logger.js";
import type { Checkpoint } from "../../state/types.js";
import type { UserConfig } from "../../config/user-config-schema.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

// ---------------------------------------------------------------------------
// config_view — read current runtime config (redacted)
// ---------------------------------------------------------------------------

export interface ConfigViewToolOptions {
	readonly getRuntimeState: () => { readonly config: UserConfig } | null;
}

export function createConfigViewTool(
	options: ConfigViewToolOptions,
): ToolWithMetadata {
	return {
		name: "config_view",
		description:
			"View the current runtime configuration. " +
			"Shows LLM routing, safety mode, tools enabled/disabled, " +
			"memory settings, and session config. All secrets are redacted.",
		parameters: z.object({}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (): Promise<ToolResult> => {
			const state = options.getRuntimeState();
			if (state == null) {
				return { toolCallId: "config-view", content: "Runtime is not booted yet. No config available.", isError: false };
			}

			const c = state.config;
			const summary = {
				schemaVersion: c.schema_version,
				llm: {
					defaultModel: c.llm.default_model ?? "(not set)",
					routingMode: c.llm.routing.mode,
					defaultTier: c.llm.routing.default_tier,
					allowEscalation: c.llm.routing.allow_escalation,
					tiers: Object.fromEntries(
						Object.entries(c.llm.tiers).map(([name, tier]: [string, { provider: string; model: string; thinking: string }]) => [
							name,
							{ provider: tier.provider, model: tier.model, thinking: tier.thinking },
						]),
					),
				},
				memory: {
					scratchpadTtlSec: c.memory.scratchpad.ttl_sec,
					scratchpadCapacity: c.memory.scratchpad.capacity_per_task,
				},
				safety: { trustMode: c.safety.trust_mode },
				tools: {
					enabled: c.tools.enabled,
					disabled: c.tools.disabled,
				},
				session: { storage: c.session.storage },
				idleEvolution: { enabled: c.idle_evolution.enabled, mode: c.idle_evolution.mode },
			};

			return { toolCallId: "config-view", content: JSON.stringify(summary, null, 2), isError: false };
		},
	};
}

// ---------------------------------------------------------------------------
// session_list — list saved sessions
// ---------------------------------------------------------------------------

export interface SessionListToolOptions {
	readonly checkpoint?: Pick<Checkpoint, "listSessions">;
}

export function createSessionListTool(
	options: SessionListToolOptions = {},
): ToolWithMetadata {
	return {
		name: "session_list",
		description:
			"List saved conversation sessions. Returns session IDs, last message previews, " +
			"message counts, and last active times. Use with /resume to restore a session.",
		parameters: z.object({}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (): Promise<ToolResult> => {
			if (options.checkpoint == null) {
				return { toolCallId: "config-view", content: "Session storage is not available.", isError: false };
			}

			try {
				const sessions = await options.checkpoint.listSessions();
				if (sessions.length === 0) {
					return { toolCallId: "config-view", content: "No saved sessions found.", isError: false };
				}

				const list = sessions.slice(0, 20).map((s) => ({
					sessionId: s.sessionId,
					lastMessage: s.lastMessage.slice(0, 100),
					messageCount: s.messageCount,
					lastActiveAt: s.lastActiveAt,
				}));

				return {
					toolCallId: "session_list",
					content: JSON.stringify({ total: sessions.length, shown: list.length, sessions: list }),
					isError: false,
				};
			} catch (err) {
				logger.warn({ err }, "session_list tool failed");
				return { toolCallId: "config-view", content: "Failed to read session data.", isError: false };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// tool_search — search all available tools
// ---------------------------------------------------------------------------

export interface ToolSearchToolOptions {
	readonly getTools: () => readonly ToolWithMetadata[];
}

export function createToolSearchTool(
	options: ToolSearchToolOptions,
): ToolWithMetadata {
	return {
		name: "tool_search",
		description:
			"Search all available tools by name or description. " +
			"Returns tool names, descriptions, parameters, and categories. " +
			"Use this to discover what tools are available before calling them.",
		parameters: z.object({
			query: z.string().optional().describe("Search query"),
		}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (args: unknown): Promise<ToolResult> => {
			const { query } = z.object({
				query: z.string().optional(),
			}).parse(args as Record<string, unknown>);
			const tools = options.getTools();
			const q = query?.toLowerCase() ?? "";
			const matches = tools
				.filter((t) => {
					if (q === "") return true;
					const n = t.name?.toLowerCase() ?? "";
					const d = (typeof t.description === "string" ? t.description : "").toLowerCase();
					return n.includes(q) || d.includes(q);
				})
				.map((t) => ({
					name: t.name ?? "(unnamed)",
					description: typeof t.description === "string" ? t.description.slice(0, 120) : "",
					category: t.category ?? "unknown",
				}));
			return {
				toolCallId: "tool_search",
				content: JSON.stringify({ query: q || "(all)", total: matches.length, tools: matches }),
				isError: false,
			};
		},
	};
}
