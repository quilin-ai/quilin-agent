/**
 * GET /api/mcp
 *
 * Returns the status of every configured MCP server: id, transport
 * (stdio / http), connection result (connected / failed + error
 * message), and the tools the server exposes when connected. Used by
 * the /mcp page to render the connectivity snapshot.
 *
 * The data comes from the shared `tools-loader.ts` catalog so this
 * endpoint reflects exactly what the chat route sees — no duplicate
 * MCP registry, no drift.
 *
 * 返回每个 MCP 服务器的连接情况(id / transport / status / tools / error),
 * 数据源是 tools-loader 共享的 catalog,/api/mcp 与 /api/chat 看到的是同一份。
 */

import { readMcpConfig } from "@/lib/mcp-loader";
import { getToolsCatalog, invalidateToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Strip credentials from a URL before exposing it to the dashboard:
 * - userinfo (`user:pass@`) → removed
 * - sensitive query params (`token`, `key`, `auth`, `signature`,
 *   `access_token`, `api_key`, `bearer`) → value replaced with `<redacted>`
 *
 * Falls back to a single `<unparseable url>` if the input isn't a valid
 * URL, since we'd rather hide the value than leak something we couldn't
 * parse and therefore couldn't redact.
 *
 * URL 在写进 /api/mcp 响应前必须脱敏:删 userinfo,把可疑 query 参数值替换为
 * `<redacted>`。解析失败时统一显示 `<unparseable url>` 避免漏。
 */
const SENSITIVE_QUERY_PARAM_RX = /^(token|key|auth|signature|access_token|api_key|bearer)$/i;

function sanitizeMcpUrl(raw: string): string {
	try {
		const u = new URL(raw);
		if (u.username !== "" || u.password !== "") {
			u.username = "";
			u.password = "";
		}
		const newParams: [string, string][] = [];
		for (const [k, v] of u.searchParams) {
			if (SENSITIVE_QUERY_PARAM_RX.test(k)) {
				newParams.push([k, "<redacted>"]);
			} else {
				newParams.push([k, v]);
			}
		}
		u.search = "";
		for (const [k, v] of newParams) {
			u.searchParams.append(k, v);
		}
		return u.toString();
	} catch {
		return "<unparseable url>";
	}
}

interface ServerToolSummary {
	readonly publicName: string;
	readonly originalName: string;
	readonly description: string;
}

export interface McpServerView {
	readonly id: string;
	readonly transport: "stdio" | "http";
	readonly configured: {
		readonly command?: string;
		readonly args?: readonly string[];
		readonly cwd?: string;
		readonly url?: string;
		readonly hasHeaders: boolean;
	};
	readonly status: "connected" | "failed" | "skipped";
	readonly toolCount: number;
	readonly error: string | null;
	readonly tools: readonly ServerToolSummary[];
}

export async function GET(req: Request): Promise<Response> {
	try {
		const config = readMcpConfig();
		// `?refresh=1` (or `?refresh=true`) tears down active MCP stdio
		// subprocesses and forces a full catalog rebuild on the next
		// `getToolsCatalog()` call. Wired to the "↻ 重新加载" button on
		// /mcp so the operator can pick up MCP tool additions
		// (`@server.tool` decorators in providers/memory/src/quilin_mem)
		// without restarting `pnpm dev`. Without this flag, the cached
		// catalog stays sticky and new tools never appear.
		const refreshParam = new URL(req.url).searchParams.get("refresh");
		if (refreshParam === "1" || refreshParam === "true") {
			await invalidateToolsCatalog();
		}
		const catalog = await getToolsCatalog();

		const toolsByServer = new Map<string, ServerToolSummary[]>();
		for (const entry of catalog.entries) {
			if (entry.source !== "mcp" || entry.mcpServer == null) continue;
			const bucket = toolsByServer.get(entry.mcpServer) ?? [];
			bucket.push({
				publicName: entry.publicName,
				originalName: entry.originalName,
				description: entry.description,
			});
			toolsByServer.set(entry.mcpServer, bucket);
		}

		const resultById = new Map<string, (typeof catalog.mcpResults)[number]>();
		for (const r of catalog.mcpResults) {
			resultById.set(r.id, r);
		}

		const servers: readonly McpServerView[] = Object.entries(config).map(([id, raw]) => {
			const transport: "stdio" | "http" = raw.type === "http" ? "http" : "stdio";
			const result = resultById.get(id);
			const tools = toolsByServer.get(id) ?? [];
			let status: McpServerView["status"];
			if (result == null) status = "skipped";
			else if (result.error == null) status = "connected";
			else status = "failed";

			return {
				id,
				transport,
				configured: {
					...(raw.command == null ? {} : { command: raw.command }),
					...(raw.args == null ? {} : { args: raw.args }),
					...(raw.cwd == null ? {} : { cwd: raw.cwd }),
					...(raw.url == null ? {} : { url: sanitizeMcpUrl(raw.url) }),
					hasHeaders: raw.headers != null && Object.keys(raw.headers).length > 0,
				},
				status,
				toolCount: result?.toolCount ?? 0,
				error: result?.error ?? null,
				tools,
			};
		});

		return Response.json(
			{
				ok: true,
				data: {
					servers,
					counts: {
						total: servers.length,
						connected: servers.filter((s) => s.status === "connected").length,
						failed: servers.filter((s) => s.status === "failed").length,
						skipped: servers.filter((s) => s.status === "skipped").length,
						totalTools: catalog.entries.filter((e) => e.source === "mcp").length,
					},
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/mcp] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "mcp_load_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
