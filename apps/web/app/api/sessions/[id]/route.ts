/**
 * /api/sessions/[id] — Slice 2 GET + Slice 3 DELETE endpoints.
 *
 * GET — Slice 2 单 session 详情 endpoint.
 *
 * 返回 session 元数据 + 完整消息历史(messages 数组按 seq 升序;assistant
 * 行的 PersistedPart 翻译成 AI SDK v6 UIMessage.parts wire 形状)。
 * Spec § 5.2。
 *
 * Returns session metadata + the full message history. Assistant rows'
 * PersistedPart shape gets translated to AI SDK v6 `UIMessage.parts`
 * wire shape so `useChat({ messages: ... })` can rehydrate without
 * per-part transformation. Per spec §5.2.
 *
 * Wire shape:
 *   {
 *     session: { id, title, created_at, updated_at, message_count },
 *     messages: Array<{ id, role, parts: UIPart[], created_at, finalized_at }>
 *   }
 *
 * 404 when session not found or `QUILIN_WEB_PERSISTENCE=off`. 500 on
 * DB error.
 */
import { NextResponse } from "next/server";

import { getAgentService } from "@/lib/agent-service-client";
import {
	deleteSession,
	isPersistenceEnabled,
	readSessionMessages,
	readSessionStats,
} from "@/lib/sessions-db";
import { persistedPartsToUIParts } from "@/lib/sessions-db/persisted-to-ui";
import { evictSession } from "@/lib/web-session-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	if (!isPersistenceEnabled()) {
		return NextResponse.json({ error: "persistence disabled" }, { status: 404 });
	}
	const { id } = await params;
	if (typeof id !== "string" || id.length === 0 || id.length > 200) {
		return NextResponse.json({ error: "invalid session id" }, { status: 400 });
	}
	try {
		const stats = readSessionStats(id);
		if (stats == null) {
			return NextResponse.json({ error: "session not found" }, { status: 404 });
		}
		const messages = readSessionMessages(id);
		return NextResponse.json({
			session: {
				id: stats.id,
				title: stats.title,
				created_at: stats.created_at,
				updated_at: stats.updated_at,
				message_count: stats.message_count,
			},
			messages: messages.map((m) => ({
				id: m.id,
				role: m.role,
				parts: persistedPartsToUIParts(m.parts),
				created_at: m.created_at,
				finalized_at: m.finalized_at,
			})),
		});
	} catch (e) {
		console.log(`[GET /api/sessions/${id}] db read failed: ${String(e)}`);
		return NextResponse.json({ error: "sessions db read failed" }, { status: 500 });
	}
}

/**
 * DELETE /api/sessions/[id] — Slice 3 删除 endpoint.
 *
 * Hard delete (`sessions` + `messages` via FK CASCADE). Also evicts the
 * AgentService session if a live runner exists for this id, so any
 * subscribed clients receive `session.failed` and the in-memory state
 * is reclaimed. Per spec §7.
 *
 * 硬删 session + messages,顺带 evict 活的 AgentService runner(让订阅者
 * 收到 session.failed)。spec §7。
 *
 * - 200 + `{ deleted: true }` on success
 * - 404 when session not found (or `QUILIN_WEB_PERSISTENCE=off`)
 * - 400 on invalid id
 */
export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	if (!isPersistenceEnabled()) {
		return NextResponse.json({ error: "persistence disabled" }, { status: 404 });
	}
	const { id } = await params;
	if (typeof id !== "string" || id.length === 0 || id.length > 200) {
		return NextResponse.json({ error: "invalid session id" }, { status: 400 });
	}
	try {
		// Evict AgentService runner first so subscribers see termination
		// before the DB row disappears (per spec §7 step 2 ordering).
		try {
			const service = await getAgentService();
			evictSession(id, service, "DELETE /api/sessions/[id]");
		} catch (e) {
			// AgentService may not be initialized or session may not exist;
			// don't fail the DELETE on this — DB cleanup is the primary
			// contract.
			console.log(`[DELETE /api/sessions/${id}] agent-service evict failed: ${String(e)}`);
		}
		const deleted = deleteSession(id);
		if (!deleted) {
			return NextResponse.json({ error: "session not found" }, { status: 404 });
		}
		return NextResponse.json({ deleted: true });
	} catch (e) {
		console.log(`[DELETE /api/sessions/${id}] db delete failed: ${String(e)}`);
		return NextResponse.json({ error: "sessions db delete failed" }, { status: 500 });
	}
}
