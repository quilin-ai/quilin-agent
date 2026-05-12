/**
 * GET /api/chat/status?session=<id>
 *
 * Returns the server-side state of a chat session so the client can
 * decide whether to auto-reload (resume an in-flight stream) on mount.
 * Used by `ConversationView` after the user navigates back to a session
 * that was streaming when they navigated away.
 *
 * Task #22 Phase 3:reads from AgentService instead of the legacy
 * `chat-session-store`. Also surfaces the AgentService's process-epoch
 * UUID so the client can persist it in sessionStorage and echo it back
 * on the next `/api/chat` POST (strict-epoch handshake — see chat
 * route docstring).
 *
 * 客户端 mount 时探,返回 session 状态 + epoch。Phase 3:从 AgentService 读。
 */
import { getAgentService } from "@/lib/agent-service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const id = url.searchParams.get("session");
	if (id == null || id.length === 0) {
		return Response.json({ ok: false, error: { code: "missing_session" } }, { status: 400 });
	}
	const service = await getAgentService();
	const epoch = service.currentEpoch();
	const session = service.getSession(id);
	if (session == null) {
		return Response.json(
			{
				ok: true,
				data: {
					exists: false,
					status: null,
					frameCount: 0,
					epoch,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	}
	const eventCount = service.getEventCount(id);
	return Response.json(
		{
			ok: true,
			data: {
				exists: true,
				status: session.status,
				/**
				 * `frameCount` keeps its legacy name for client compat,
				 * but the semantics shifted slightly: it now counts
				 * structured AgentEvents in the bus history for this
				 * session, not raw SSE frames. The client uses this
				 * only to decide "is there anything to resume" so the
				 * exact unit doesn't matter — non-zero = replayable.
				 */
				frameCount: eventCount,
				updatedAtMs: Date.parse(session.lastActiveAt),
				epoch,
			},
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
