/**
 * GET /api/agents — return current in-memory agent registry summary list.
 * Used by AgentSwitcher polling to refresh the agent list every few seconds.
 *
 * Query params:
 *   ?parent=<sessionId>  — filter subagents to those spawned by the given
 *                          chat session (the "main" agent is always returned
 *                          so the switcher can show the parent row).
 */
import { type AgentSummary, agentRegistry, agentStatusFromMainSession } from "@/lib/agent-registry";
import { type AgentSession, getAgentService } from "@/lib/agent-service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function elapsedMsForSession(session: AgentSession): number {
	const startedMs = Date.parse(session.createdAt);
	const lastActiveMs = Date.parse(session.lastActiveAt);
	if (!Number.isFinite(startedMs) || !Number.isFinite(lastActiveMs)) return 0;
	const endMs = session.status === "running" ? Date.now() : lastActiveMs;
	return Math.max(0, endMs - startedMs);
}

async function getParentSession(parentId: string): Promise<AgentSession | null> {
	try {
		const service = await getAgentService();
		return service.getSession(parentId);
	} catch {
		return null;
	}
}

function withParentSessionMainStatus(
	summary: AgentSummary,
	parentSession: AgentSession | null,
): AgentSummary {
	if (summary.kind !== "main" || parentSession == null) return summary;
	return {
		...summary,
		status: agentStatusFromMainSession(parentSession.status),
		startedAt: parentSession.createdAt,
		elapsedMs: elapsedMsForSession(parentSession),
		lastHeartbeatAt: parentSession.lastActiveAt,
	};
}

export async function GET(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const parentFilter = url.searchParams.get("parent");
	const all = agentRegistry.toSummaries();
	const parentSession =
		parentFilter == null || parentFilter.length === 0 ? null : await getParentSession(parentFilter);
	const items =
		parentFilter == null || parentFilter.length === 0
			? all
			: all
					.filter((a) => a.kind === "main" || a.parentId === parentFilter)
					.map((a) => withParentSessionMainStatus(a, parentSession));
	return Response.json({ ok: true, data: { items } }, { headers: { "cache-control": "no-store" } });
}
