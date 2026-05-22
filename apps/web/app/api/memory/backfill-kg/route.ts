/**
 * POST /api/memory/backfill-kg — 把现有 memory_records 灌进 KG。
 *
 * 实测发现 KG 默认是空的(没有自动 backfill),user 看到 "知识图谱为空"
 * 但不知道怎么填。这里提供一个一键 backfill 按钮入口:Web KG view 的
 * empty state 点 "立即灌入 KG" → POST 本路由 → 调 quilin-mem MCP
 * `memory_backfill_kg` tool(dry_run=false)→ 把全部 memory_records 灌进 KG。
 *
 * Returns:
 *   { ok: true, data: { backfilled: number, edges: number } } — 成功
 *   { ok: false, error: {...} } — MCP tool 不可用 / 调用失败
 */

import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
	try {
		const catalog = await getToolsCatalog();
		const backfillTool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_backfill_kg");
		if (backfillTool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_backfill_kg_unavailable",
						message:
							"quilin-mem MCP server is not connected, or memory_backfill_kg tool is missing.",
					},
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		const result = await backfillTool.execute({ dry_run: false });
		if (result.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_backfill_kg_failed",
						message: result.error?.message ?? result.content,
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		// D.17 fix: parse the correct BackfillResult fields.
		// Previous code looked for `backfilled` / `backfilled_count` / `records_backfilled`
		// — none of which exist on BackfillResult. The real keys are
		// `processed` / `edges_added` / `skipped` / `errors` / `dry_run`.
		// Real dogfood saw API return `{backfilled:0, edges:0}` while DB
		// actually grew by 4 edges — UI silently disagreed with truth.
		let processed = 0;
		let edgesAdded = 0;
		let skipped = 0;
		let errors: string[] = [];
		try {
			const parsed = JSON.parse(result.content) as unknown;
			if (parsed != null && typeof parsed === "object") {
				const o = parsed as Record<string, unknown>;
				if (typeof o.processed === "number") processed = o.processed;
				if (typeof o.edges_added === "number") edgesAdded = o.edges_added;
				if (typeof o.skipped === "number") skipped = o.skipped;
				if (Array.isArray(o.errors))
					errors = o.errors.filter((s): s is string => typeof s === "string");
			}
		} catch {
			// fall through with zeros — tool returned non-JSON text, still success
		}

		return Response.json(
			{
				ok: true,
				data: {
					processed,
					edgesAdded,
					skipped,
					errors,
					// Back-compat alias for older clients that read `backfilled` / `edges`.
					// `backfilled` ≈ processed records (not # actually written); `edges`
					// is the real # of new KG triples written.
					backfilled: processed,
					edges: edgesAdded,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "memory_backfill_kg_error",
					message: e instanceof Error ? e.message : String(e),
				},
			},
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
