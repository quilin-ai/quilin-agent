/**
 * GET /api/sessions — Slice 2 列表 endpoint.
 *
 * 返回最近 100 个 session(`updated_at DESC`),分页参数 `?limit=N&offset=M`。
 * Spec § 5.1.
 *
 * Returns up to 100 most-recently-updated sessions with optional
 * `?limit=N&offset=M` pagination. Per spec §5.1.
 *
 * Wire shape per row:
 *   { id, title, created_at, updated_at, message_count, preview }
 *
 * When `QUILIN_WEB_PERSISTENCE=off`, returns `{ sessions: [] }` so the
 * `/sessions` page falls back cleanly to localStorage-only mode.
 *
 * 当 `QUILIN_WEB_PERSISTENCE=off` 时返回空数组,前端 `/sessions` 页降级到
 * 纯 localStorage 模式。
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { isPersistenceEnabled, listSessionsForReadEndpoint } from "@/lib/sessions-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).optional(),
	offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: Request): Promise<Response> {
	if (!isPersistenceEnabled()) {
		return NextResponse.json({ sessions: [], persistenceEnabled: false });
	}
	const url = new URL(req.url);
	const parsed = QuerySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
	});
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid query", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	try {
		const sessions = listSessionsForReadEndpoint({
			limit: parsed.data.limit,
			offset: parsed.data.offset,
		});
		return NextResponse.json({ sessions, persistenceEnabled: true });
	} catch (e) {
		console.log(`[GET /api/sessions] db read failed: ${String(e)}`);
		return NextResponse.json({ error: "sessions db read failed" }, { status: 500 });
	}
}
