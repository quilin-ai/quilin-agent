/**
 * GET /api/tools
 *
 * Returns the full catalog of tools currently loaded into the agent
 * process: agent-core built-ins (file_read, shell_exec, web_fetch, …),
 * inline web-only tools (spawn_subagent, wait_for_subagents), and every
 * MCP-namespaced tool exposed by the connected MCP servers.
 *
 * Used by the /tools page to render an honest snapshot of what the LLM
 * can call. Reflects post-`getToolsCatalog()` reality, so what's shown
 * here is what's actually in chat's `tools: { ... }` map.
 *
 * 返回 agent 进程当前真实加载的全部工具,/tools 页用它渲染"LLM 现在能调啥"
 * 的快照。Builtin + inline + MCP namespace 工具一视同仁。
 */

import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	try {
		const catalog = await getToolsCatalog();
		// The chat route adds three inline tools on top of the shared
		// `getToolsCatalog()` output: `spawn_subagent` (factory-bound to
		// the chat sessionId), `wait_for_subagents`, and `web_fetch`
		// (native-fetch override of agent-core's hung `web_fetch`).
		//
		// These never reach `catalog.entries` because they're constructed
		// inside `apps/web/app/api/chat/route.ts` per request. Hard-list
		// them here so /tools page surfaces the full set of tools the LLM
		// actually sees during chat, not just the catalog half.
		//
		// chat 路由会在 catalog 之外再注入这 3 个 inline 工具,这里硬列出来,
		// 让 /tools 页能看到 LLM 实际能调的完整工具集。
		const inlineEntries: ReadonlyArray<{
			publicName: string;
			originalName: string;
			description: string;
			source: "inline";
			mcpServer: string | null;
			inputShape: Record<string, string> | null;
		}> = [
			{
				publicName: "spawn_subagent",
				originalName: "spawn_subagent",
				description: getInlineDescription("spawn_subagent"),
				source: "inline",
				mcpServer: null,
				inputShape: { task: "string" },
			},
			{
				publicName: "wait_for_subagents",
				originalName: "wait_for_subagents",
				description: getInlineDescription("wait_for_subagents"),
				source: "inline",
				mcpServer: null,
				inputShape: { agentIds: "string[]", timeoutSec: "number?" },
			},
			{
				publicName: "web_fetch",
				originalName: "web_fetch",
				description: getInlineDescription("web_fetch"),
				source: "inline",
				mcpServer: null,
				inputShape: {
					url: "string",
					method: '"GET"|"POST"|"HEAD"?',
					headers: "Record<string,string>?",
					body: "string?",
					maxChars: "number?",
				},
			},
		];
		// The chat route's tool dict is built as
		//   { ...catalog.adapted, web_fetch: inlineWebFetchTool, spawn_subagent, wait_for_subagents }
		// which means agent-core's builtin `web_fetch` is **shadowed** by
		// the inline native-fetch override (agent-core's hangs inside the
		// dist bundle). Mirror that here: drop any catalog entry whose
		// publicName collides with an inline entry, so the dashboard
		// shows the same set of tools the LLM actually sees.
		const inlineNames = new Set(inlineEntries.map((e) => e.publicName));
		const filteredCatalogEntries = catalog.entries.filter((e) => !inlineNames.has(e.publicName));
		const all = [...filteredCatalogEntries, ...inlineEntries];

		const counts = {
			total: all.length,
			builtin: all.filter((e) => e.source === "builtin").length,
			inline: inlineEntries.length,
			mcp: all.filter((e) => e.source === "mcp").length,
		};
		const byMcpServer: Record<string, number> = {};
		for (const e of all) {
			if (e.source === "mcp" && e.mcpServer != null) {
				byMcpServer[e.mcpServer] = (byMcpServer[e.mcpServer] ?? 0) + 1;
			}
		}

		return Response.json(
			{
				ok: true,
				data: {
					tools: all,
					counts,
					byMcpServer,
					mcpServerStatus: catalog.mcpResults,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/tools] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "tools_load_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}

function getInlineDescription(name: string): string {
	switch (name) {
		case "spawn_subagent":
			return "派遣一个并行的子代理(subagent)去执行一个独立的子任务。Fire-and-forget,立即返回 agentId,需配合 wait_for_subagents 拿结果。";
		case "wait_for_subagents":
			return "等待 spawn_subagent 派出的子代理跑完,返回每个 subagent 的最终输出。";
		case "web_fetch":
			return "Fetch HTTP(S) resources. Returns response body as text (truncated to 30KB) plus status/content-type.";
		default:
			return "Inline web-route-only tool.";
	}
}
