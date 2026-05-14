/**
 * GET /api/sessions/[id] — Slice 2 单 session 详情 endpoint.
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

import { isPersistenceEnabled, readSessionMessages, readSessionStats } from "@/lib/sessions-db";
import { persistedPartsToUIParts } from "@/lib/sessions-db/persisted-to-ui";

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
