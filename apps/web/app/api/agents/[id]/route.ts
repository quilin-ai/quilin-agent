/**
 * GET /api/agents/[id] — return a single agent record including its accumulated
 * streamedText so the UI can render the subagent's in-flight / completed output
 * when the user selects the subagent in AgentSwitcher.
 */
import { agentRegistry } from "@/lib/agent-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
	readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
	const { id } = await ctx.params;
	const all = agentRegistry.list();
	const record = all.find((r) => r.id === id);
	if (!record) {
		return Response.json(
			{ ok: false, error: { code: "not_found", message: `agent ${id} not found` } },
			{ status: 404, headers: { "cache-control": "no-store" } },
		);
	}
	const now = Date.now();
	return Response.json(
		{
			ok: true,
			data: {
				id: record.id,
				kind: record.kind,
				parentId: record.parentId,
				displayName: record.displayName,
				task: record.task,
				status: record.status,
				startedAt: record.startedAt,
				lastHeartbeatAt: record.lastHeartbeatAt,
				elapsedMs: Math.max(0, now - new Date(record.startedAt).getTime()),
				streamedText: record.streamedText,
				toolEvents: record.toolEvents,
				usage: record.usage,
			},
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
