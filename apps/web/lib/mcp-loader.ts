/**
 * MCP loader — reads the user's `~/.claude.json` (the same config Claude
 * Code uses) and registers every configured MCP server with the
 * `MCPRegistry` from `@quilin/agent-core`. Both stdio and Streamable HTTP
 * transports are supported (agent-core was extended in slice 2 to handle
 * HTTP via `StreamableHTTPClientTransport`).
 *
 * Per-server failures are logged but do NOT abort the loader — agent
 * stability shouldn't depend on every distant MCP being reachable.
 *
 * MCP 加载器:读 `~/.claude.json` 把用户配置的 MCP server 全部连进 MCPRegistry。
 * 支持 stdio 和 HTTP 两种传输。单个 server 失败不影响其它 server,只记日志。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface RawMcpServerEntry {
	readonly type?: string;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Record<string, string>;
}

interface RawClaudeJson {
	readonly mcpServers?: Record<string, RawMcpServerEntry>;
}

interface MCPRegistryLike {
	register(entry: {
		readonly id: string;
		readonly config: unknown;
		readonly namespace: string;
	}): Promise<readonly unknown[]>;
	getAllTools(): readonly unknown[];
}

interface AgentCoreModuleLike {
	MCPRegistry: new () => MCPRegistryLike;
}

/**
 * Read MCP server entries from `~/.claude.json` (user-configured servers
 * — exa, tavily, etc.) plus auto-discovered Quilin built-ins under
 * `providers/` (quilin-mem and quilin-web Python stdio servers).
 *
 * Returns the merged map. Per-source failures are logged but don't abort.
 */
export function readMcpConfig(): Record<string, RawMcpServerEntry> {
	const merged: Record<string, RawMcpServerEntry> = {};

	// User-configured servers from Claude Code's config file.
	const claudeConfigPath =
		process.env.QUILIN_CLAUDE_CONFIG ?? join(homedir(), ".claude.json");
	try {
		const text = readFileSync(claudeConfigPath, "utf-8");
		const parsed = JSON.parse(text) as RawClaudeJson;
		Object.assign(merged, parsed.mcpServers ?? {});
	} catch (e) {
		console.log(`[MCP] config read failed (${claudeConfigPath}): ${String(e)}`);
	}

	// Quilin built-in stdio MCP providers shipped with this workspace.
	// Detected by directory existence so a stripped checkout doesn't error.
	const workspaceRoot = process.cwd().replace(/\/apps\/web\/?$/, "");
	const memoryProviderCwd = resolve(workspaceRoot, "providers/memory");
	const webProviderCwd = resolve(workspaceRoot, "providers/web");
	if (existsSync(memoryProviderCwd) && merged["quilin-mem"] == null) {
		merged["quilin-mem"] = {
			type: "stdio",
			command: "uv",
			args: ["run", "python", "-m", "quilin_mem"],
			cwd: memoryProviderCwd,
		};
	}
	if (existsSync(webProviderCwd) && merged["quilin-web"] == null) {
		merged["quilin-web"] = {
			type: "stdio",
			command: "uv",
			args: ["run", "python", "-m", "quilin_web"],
			cwd: webProviderCwd,
		};
	}

	return merged;
}

/**
 * Spin up an `MCPRegistry` and connect every server defined in
 * `~/.claude.json`. Returns the registry plus a per-server result map for
 * diagnostics (which servers connected, which failed and why).
 */
export async function loadMcpRegistry(
	agentCoreMod: AgentCoreModuleLike,
	options: { readonly disableHttp?: boolean; readonly disableStdio?: boolean } = {},
): Promise<{
	readonly registry: MCPRegistryLike;
	readonly results: ReadonlyArray<{
		readonly id: string;
		readonly transport: "stdio" | "http";
		readonly toolCount: number;
		readonly error: string | null;
	}>;
}> {
	const registry = new agentCoreMod.MCPRegistry();
	const config = readMcpConfig();
	const results: Array<{
		readonly id: string;
		readonly transport: "stdio" | "http";
		readonly toolCount: number;
		readonly error: string | null;
	}> = [];

	for (const [id, raw] of Object.entries(config)) {
		const transport: "stdio" | "http" = raw.type === "http" ? "http" : "stdio";
		if (transport === "http" && options.disableHttp === true) continue;
		if (transport === "stdio" && options.disableStdio === true) continue;
		try {
			const serverConfig =
				transport === "http"
					? {
							type: "http" as const,
							url: raw.url ?? "",
							...(raw.headers == null ? {} : { headers: raw.headers }),
						}
					: {
							command: raw.command ?? "",
							args: raw.args ?? [],
							...(raw.cwd == null ? {} : { cwd: raw.cwd }),
						};
			const tools = await registry.register({
				id,
				config: serverConfig,
				namespace: id,
			});
			results.push({ id, transport, toolCount: tools.length, error: null });
			console.log(`[MCP] connected ${id} (${transport}): ${tools.length} tools`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			results.push({ id, transport, toolCount: 0, error: message });
			console.log(`[MCP] FAILED ${id} (${transport}): ${message}`);
		}
	}

	return { registry, results };
}
