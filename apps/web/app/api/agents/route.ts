/**
 * GET /api/agents — return current in-memory agent registry summary list.
 * Used by AgentSwitcher polling to refresh the agent list every few seconds.
 */
import { agentRegistry } from "@/lib/agent-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json(
		{ ok: true, data: { items: agentRegistry.toSummaries() } },
		{ headers: { "cache-control": "no-store" } },
	);
}
