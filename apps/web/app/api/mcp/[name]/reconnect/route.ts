/**
 * POST /api/mcp/[name]/reconnect
 *
 * Re-runs `MCPRegistry.register()` for a single MCP server without
 * touching the other connected servers. Used by the "↻ 重连" button
 * on /mcp and /tools so the operator can retry a failed server after
 * editing `~/.claude.json` (e.g. refreshing a token, fixing args)
 * without restarting `pnpm dev`.
 *
 * Returns:
 *   200 + `{ status: "connected", toolCount }` on success
 *   200 + `{ status: "failed", error }` if the server still fails
 *           (UI renders the new error message; we don't 500 because
 *            "token expired" is the most common cause and the user
 *            wants to see *which* error, not a generic 500)
 *   404 if the id isn't in the merged MCP config
 *   500 only on unexpected errors (registry not initialized, etc.)
 *
 * 给单个 MCP server 做重连:不动其它健康连接,只重试给定 id。失败把
 * 新的错误文案返回 UI,不抛 500——用户改完 `~/.claude.json` 后点重连
 * 看的就是这条错误。
 */

import { reconnectMcpServer } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
	readonly params: Promise<{ readonly name: string }>;
}

export async function POST(_req: Request, ctx: RouteContext): Promise<Response> {
	const { name: rawName } = await ctx.params;
	const name = decodeURIComponent(rawName);
	try {
		const result = await reconnectMcpServer(name);
		if (result.status === "unknown_id") {
			return Response.json(
				{ ok: false, error: { code: "unknown_mcp_server", message: result.error } },
				{ status: 404, headers: { "cache-control": "no-store" } },
			);
		}
		return Response.json({ ok: true, data: result }, { headers: { "cache-control": "no-store" } });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/mcp/${name}/reconnect] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "reconnect_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
