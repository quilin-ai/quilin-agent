/**
 * GET /api/chat/status?session=<id>
 *
 * Returns the server-side state of a chat session, so the client can
 * decide whether to auto-reload (resume an in-flight stream) on mount.
 * Used by `ConversationView` after the user navigates back to a session
 * that was streaming when they navigated away.
 *
 * 客户端在 mount 时调用,根据 server-side 状态决定是否自动续上 stream。
 */
import { getSession } from "@/lib/chat-session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
	const url = new URL(req.url);
	const id = url.searchParams.get("session");
	if (id == null || id.length === 0) {
		return Response.json({ ok: false, error: { code: "missing_session" } }, { status: 400 });
	}
	const s = getSession(id);
	if (s == null) {
		return Response.json(
			{ ok: true, data: { exists: false, status: null, frameCount: 0 } },
			{ headers: { "cache-control": "no-store" } },
		);
	}
	return Response.json(
		{
			ok: true,
			data: {
				exists: true,
				status: s.status,
				frameCount: s.frames.length,
				updatedAtMs: s.updatedAtMs,
			},
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
