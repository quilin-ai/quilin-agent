/**
 * GET /api/memory       — list every stored memory record, grouped by tier.
 * DELETE /api/memory    — batch-delete by `?ids=a,b,c` (comma-separated id list).
 *
 * Read-side view of `quilin-mem` MCP memory. GET calls the
 * `quilin-mem/memory_recall` tool with an empty query to fetch every
 * stored record, groups by tier (working / episodic / semantic / skill),
 * and returns the structured list for the /memory page.
 *
 * DELETE provides the operator-facing "select N rows, click 删除选中"
 * cleanup path. Each id is forwarded to the `quilin-mem/memory_delete`
 * tool, which soft-deletes (sets `deleted=1`, removes from FTS) so the
 * row is gone from future recalls but still on disk for audit.
 *
 * Why this lives in a separate web route instead of being a generic
 * "call any MCP tool" passthrough: the LLM is the one who decides when
 * to call MCP tools; this route is *not* an open dispatcher. It's a
 * single read+delete endpoint specifically for the operator's memory
 * dashboard.
 *
 * 调 quilin-mem MCP 的 memory_recall 把全部记忆拉出来,按 tier 分组返回；
 * DELETE 把选中的 id 逐个交给 memory_delete 软删除。仅作 dashboard 用,
 * 不是通用 MCP 转发口。
 */

import { getToolsCatalog } from "@/lib/tools-loader";

/** Hard cap to prevent a single DELETE call from running unbounded MCP traffic. */
const MAX_BATCH_DELETE = 500;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface MemoryRecord {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly layer: string | null;
	readonly createdAt: string | null;
	readonly metadata: Record<string, unknown> | null;
	// v2 字段(QUI-193/196/197 ship 后真有值)— UI 详情面板用
	readonly version: number | null;
	readonly parentId: string | null;
	readonly isLatest: boolean | null;
	readonly supersedesJson: Record<string, unknown> | readonly unknown[] | string | null;
	readonly lastWriterClient: string | null;
	readonly lastWriterSessionId: string | null;
	readonly projectScope: string | null;
	readonly salience: Record<string, unknown> | null;
	readonly kind: string | null;
	readonly importanceScore: number | null;
	readonly archivedAt: string | null;
	readonly recoveredAt: string | null;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
	const v = obj[key];
	if (typeof v === "string" && v.length > 0) return v;
	return null;
}

/**
 * Stable-but-cheap hash from string → 8-hex FNV-1a 32-bit. Used to
 * synthesize an `id` for records that came back from quilin-mem without
 * one, so React `key={record.id}` doesn't collide on the /memory page.
 */
function fnvHash(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		h ^= input.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

function pickRecord(value: unknown, indexHint: number): MemoryRecord | null {
	if (value == null || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	const content = pickString(obj, "content") ?? pickString(obj, "text") ?? "";
	if (content.length === 0) return null;
	const explicitId = pickString(obj, "id") ?? pickString(obj, "record_id");
	const tier =
		pickString(obj, "tier") ??
		pickString(obj, "memory_tier") ??
		pickString(obj, "layer") ??
		"unknown";
	const layer = pickString(obj, "layer") ?? pickString(obj, "memory_layer");
	const createdAt =
		pickString(obj, "created_at") ?? pickString(obj, "createdAt") ?? pickString(obj, "timestamp");
	// Synthesize a stable id when the MCP response omits one. Using
	// `${tier}:${index}:${fnvHash(content)}` keeps collisions vanishingly
	// rare for distinct records while still being deterministic for the
	// same content + tier + position across reloads.
	const id =
		explicitId != null && explicitId.length > 0
			? explicitId
			: `synth:${tier}:${indexHint}:${fnvHash(content)}`;
	const metadataValue = obj.metadata;
	const metadata =
		metadataValue != null && typeof metadataValue === "object"
			? (metadataValue as Record<string, unknown>)
			: null;
	// v2 字段提取(QUI-193/196/197 — UI 详情面板用)
	const pickNumber = (key: string): number | null => {
		const v = obj[key];
		return typeof v === "number" && Number.isFinite(v) ? v : null;
	};
	const pickBool = (key: string): boolean | null => {
		const v = obj[key];
		return typeof v === "boolean" ? v : null;
	};
	const pickObject = (key: string): Record<string, unknown> | null => {
		const v = obj[key];
		return v != null && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	};
	const pickJsonLike = (
		key: string,
	): Record<string, unknown> | readonly unknown[] | string | null => {
		const v = obj[key];
		if (v == null) return null;
		if (typeof v === "object") {
			return Array.isArray(v) ? v : (v as Record<string, unknown>);
		}
		if (typeof v !== "string" || v.length === 0) return null;
		try {
			const parsed = JSON.parse(v) as unknown;
			if (Array.isArray(parsed)) return parsed;
			if (parsed != null && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			// Keep legacy string payloads visible instead of silently dropping them.
		}
		return v;
	};
	return {
		id,
		content,
		tier,
		layer,
		createdAt,
		metadata,
		version: pickNumber("version"),
		parentId: pickString(obj, "parent_id") ?? pickString(obj, "parentId"),
		isLatest: pickBool("is_latest") ?? pickBool("isLatest"),
		supersedesJson: pickJsonLike("supersedes_json") ?? pickJsonLike("supersedesJson"),
		lastWriterClient: pickString(obj, "last_writer_client") ?? pickString(obj, "lastWriterClient"),
		lastWriterSessionId:
			pickString(obj, "last_writer_session_id") ?? pickString(obj, "lastWriterSessionId"),
		projectScope: pickString(obj, "project_scope") ?? pickString(obj, "projectScope"),
		salience: pickObject("salience") ?? pickObject("salience_json"),
		kind: pickString(obj, "kind"),
		importanceScore: pickNumber("importance_score") ?? pickNumber("importanceScore"),
		archivedAt: pickString(obj, "archived_at") ?? pickString(obj, "archivedAt"),
		recoveredAt: pickString(obj, "recovered_at") ?? pickString(obj, "recoveredAt"),
	};
}

function parseToolOutput(content: string): readonly MemoryRecord[] {
	const trimmed = content.trim();
	if (trimmed.length === 0) return [];
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		// Common shapes the MCP server might return: array, { records: [...] },
		// or { data: [...] }. Probe each.
		const arr = Array.isArray(parsed)
			? parsed
			: typeof parsed === "object" && parsed != null && "records" in parsed
				? (parsed as { records: unknown[] }).records
				: typeof parsed === "object" && parsed != null && "data" in parsed
					? (parsed as { data: unknown[] }).data
					: [];
		if (!Array.isArray(arr)) return [];
		const records: MemoryRecord[] = [];
		arr.forEach((item, index) => {
			const rec = pickRecord(item, index);
			if (rec != null) records.push(rec);
		});
		return records;
	} catch {
		return [];
	}
}

export async function GET(): Promise<Response> {
	try {
		const catalog = await getToolsCatalog();
		const recallTool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_recall");
		if (recallTool == null) {
			return Response.json(
				{
					ok: true,
					data: {
						available: false,
						reason:
							"quilin-mem MCP server is not connected. Memory dashboard is unavailable. Check /mcp for connection status.",
						records: [],
						byTier: {},
						counts: { total: 0 },
					},
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}

		const result = await recallTool.execute({ query: "" });
		if (result.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_recall_failed",
						message: result.error?.message ?? result.content,
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}
		const records = parseToolOutput(result.content);
		const byTier: Record<string, MemoryRecord[]> = {};
		for (const r of records) {
			const key = r.layer ?? r.tier;
			if (byTier[key] == null) byTier[key] = [];
			byTier[key].push(r);
		}
		const counts: Record<string, number> = { total: records.length };
		for (const [k, v] of Object.entries(byTier)) {
			counts[k] = v.length;
		}

		return Response.json(
			{
				ok: true,
				data: {
					available: true,
					records,
					byTier,
					counts,
					/** Echo of the raw MCP response, in case the UI wants to display unparseable output. */
					rawSamplePreview:
						result.content.length > 2000 ? `${result.content.slice(0, 2000)}…` : result.content,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/memory] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "memory_load_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}

/**
 * Result of a single id's delete attempt. `ok` is true if the
 * underlying `memory_delete` MCP call resolved without `isError`;
 * idempotent no-ops (deleting an id that doesn't exist) still count
 * as `ok: true` because the tool itself treats them that way.
 */
export interface BatchDeleteItem {
	readonly id: string;
	readonly ok: boolean;
	readonly error: string | null;
}

function parseIdsParam(raw: string | null): {
	ids: readonly string[];
	error: string | null;
} {
	if (raw == null || raw.length === 0) {
		return { ids: [], error: "missing required query param `ids`" };
	}
	const ids = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (ids.length === 0) {
		return { ids: [], error: "`ids` resolved to an empty list" };
	}
	if (ids.length > MAX_BATCH_DELETE) {
		return {
			ids: [],
			error: `batch delete exceeds limit of ${MAX_BATCH_DELETE} ids per request`,
		};
	}
	// De-duplicate so the same id isn't deleted twice (still idempotent
	// on the MCP side, but no need to thrash the wire for it).
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		deduped.push(id);
	}
	return { ids: deduped, error: null };
}

export async function DELETE(request: Request): Promise<Response> {
	try {
		const url = new URL(request.url);
		const { ids, error: parseError } = parseIdsParam(url.searchParams.get("ids"));
		if (parseError != null) {
			return Response.json(
				{ ok: false, error: { code: "invalid_query", message: parseError } },
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}

		const catalog = await getToolsCatalog();
		const deleteTool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_delete");
		if (deleteTool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_delete_unavailable",
						message: "quilin-mem MCP server is not connected; memory_delete tool unavailable.",
					},
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		// Serial execution: most batches are small (a handful to a few
		// dozen), and the MCP transport doesn't benefit meaningfully
		// from concurrency for a SQLite-backed store. Going serial keeps
		// error reporting straightforward and avoids storming the MCP
		// stdio pipe.
		const results: BatchDeleteItem[] = [];
		for (const id of ids) {
			// audit 漏项 #5 fix (QUI-182): GET 路径给没 explicit id 的 record 合成
			// `synth:${tier}:${index}:${fnvHash}` 形式 id 给 UI 列表用,但 quilin-mem
			// MCP 不认这种合成 id。之前直接传过去会 isError = true 但 client 拿到
			// 的错误信息("memory not found")让人误以为 DB 出问题。这里 pre-check
			// 给出明确文案,UI 显示"自动合成 id 不能批量删,先用 memory_save
			// 注入真实 id 再操作"。
			if (id.startsWith("synth:")) {
				results.push({
					id,
					ok: false,
					error:
						"无法删除自动合成 id 的记录(synth:*)。这类 record 来自旧版 MCP, 没有 explicit memory_id, 需要 quilin-mem 端先 backfill 才能删。",
				});
				continue;
			}
			try {
				const out = await deleteTool.execute({ memory_id: id });
				if (out.isError) {
					results.push({ id, ok: false, error: out.error?.message ?? out.content });
				} else {
					results.push({ id, ok: true, error: null });
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				results.push({ id, ok: false, error: msg });
			}
		}

		const okCount = results.filter((r) => r.ok).length;
		const failedCount = results.length - okCount;
		return Response.json(
			{
				ok: true,
				data: {
					requested: ids.length,
					deleted: okCount,
					failed: failedCount,
					results,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/memory DELETE] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "memory_delete_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
