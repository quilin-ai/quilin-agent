/**
 * GET /api/memory
 *
 * Read-side view of `quilin-mem` MCP memory. Calls the
 * `quilin-mem/memory_recall` tool with an empty query to fetch every
 * stored record, groups by tier (working / episodic / semantic / skill),
 * and returns the structured list for the /memory page.
 *
 * Why this lives in a separate web route instead of being a generic
 * "call any MCP tool" passthrough: the LLM is the one who decides when
 * to call MCP tools; this route is *not* an open dispatcher. It's a
 * single read endpoint specifically for the operator's memory dashboard.
 *
 * 调 quilin-mem MCP 的 memory_recall 把全部记忆拉出来,按 tier 分组返回。
 * 仅作只读 dashboard 用,不是通用 MCP 转发口。
 */

import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface MemoryRecord {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly layer: string | null;
	readonly createdAt: string | null;
	readonly metadata: Record<string, unknown> | null;
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
	return { id, content, tier, layer, createdAt, metadata };
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
