/**
 * GET /api/memory/archived — list soft-deleted memory records still within
 * the 7-day forget window. Used by /memory page "已删除" section to expose
 * the recover UI (D.14 fix).
 *
 * 真人 dogfood 发现:DB schema 有 recovered_at + 7 天 forget_after,但 UI
 * 没暴露恢复入口,user 误删后只能 SQL 直改。这条 route 把 archived records
 * 拉出来,UI 可显示 + 加 recover button。
 */
import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ArchivedItem {
	readonly id: string;
	readonly tier: string;
	readonly content: string;
	readonly archived_at: string | null;
	readonly forget_after: string | null;
	readonly recovered_at: string | null;
	readonly last_writer_client: string | null;
	readonly kind: string | null;
}

function parseToolContent(content: unknown): unknown {
	if (Array.isArray(content)) {
		const textItem = (content as Array<{ type?: string; text?: string }>).find(
			(c) => c?.type === "text" && typeof c.text === "string",
		);
		if (textItem?.text != null) {
			try {
				return JSON.parse(textItem.text);
			} catch {
				return textItem.text;
			}
		}
	}
	if (typeof content === "string") {
		try {
			return JSON.parse(content);
		} catch {
			return content;
		}
	}
	return content;
}

export async function GET(): Promise<Response> {
	try {
		const catalog = await getToolsCatalog();
		const tool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_list_archived");
		if (tool == null) {
			return Response.json(
				{
					ok: true,
					data: { available: false, reason: "memory_list_archived tool missing", items: [] },
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}
		const result = await tool.execute({ limit: 100 });
		if (result.isError) {
			return Response.json(
				{
					ok: false,
					error: { code: "memory_list_archived_failed", message: result.content },
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}
		const body = parseToolContent(result.content);
		const items: ArchivedItem[] =
			body != null &&
			typeof body === "object" &&
			"items" in (body as Record<string, unknown>) &&
			Array.isArray((body as { items?: unknown }).items)
				? (body as { items: ArchivedItem[] }).items
				: [];
		return Response.json(
			{ ok: true, data: { available: true, items } },
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "memory_list_archived_error",
					message: e instanceof Error ? e.message : String(e),
				},
			},
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
