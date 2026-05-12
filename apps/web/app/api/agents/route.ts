/**
 * GET /api/agents — return current in-memory agent registry summary list.
 * Used by AgentSwitcher polling to refresh the agent list every few seconds.
 *
 * Query params:
 *   ?parent=<sessionId>  — filter subagents to those spawned by the given
 *                          chat session (the "main" agent is always returned
 *                          so the switcher can show the parent row).
 */
import { agentRegistry } from "@/lib/agent-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
	const url = new URL(req.url);
	const parentFilter = url.searchParams.get("parent");
	const all = agentRegistry.toSummaries();
	const items =
		parentFilter == null || parentFilter.length === 0
			? all
			: all.filter((a) => a.kind === "main" || a.parentId === parentFilter);
	return Response.json({ ok: true, data: { items } }, { headers: { "cache-control": "no-store" } });
}
