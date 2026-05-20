/**
 * POST /api/chat/stop
 *
 * User-initiated stop for the currently running web chat turn. This
 * releases the in-memory AgentService runner and abort controller, but
 * keeps the persisted SQLite session/messages intact so queued prompts
 * can continue after the active run is stopped.
 */
import { getAgentService } from "@/lib/agent-service-client";
import { stopSession } from "@/lib/web-session-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StopRequestBody {
	readonly sessionId?: unknown;
}

export async function POST(req: Request): Promise<Response> {
	let body: StopRequestBody;
	try {
		body = (await req.json()) as StopRequestBody;
	} catch {
		return Response.json({ ok: false, error: { code: "invalid_json" } }, { status: 400 });
	}

	const sessionId = body.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) {
		return Response.json({ ok: false, error: { code: "invalid_session_id" } }, { status: 400 });
	}

	const service = await getAgentService();
	const epoch = service.currentEpoch();
	const result = stopSession(sessionId, service, "user stopped chat run");

	return Response.json(
		{
			ok: true,
			data: {
				sessionId,
				epoch,
				stopped: result.stopped,
				hadMeta: result.hadMeta,
				hadSession: result.hadSession,
			},
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
