/**
 * POST /api/memory/dedupe
 *
 * One-click dedupe for the /memory page. Two modes:
 *
 *   { execute: false } (default)
 *     → Build a preview plan: which exact-content duplicates exist,
 *       how many would be deleted, how many kept. No mutation.
 *
 *   { execute: true }
 *     → Apply the plan: call `memory_delete` for each id flagged for
 *       deletion. Returns per-id success/failure plus aggregate counts.
 *
 * The matching algorithm is exact normalized-string equality within
 * the same tier (see `lib/memory-dedupe.ts`). Semantic / fuzzy
 * dedupe is intentionally out of scope for the MVP — exact match
 * already handles the "用户叫小明 × 30 次" repetition pattern, which
 * is the noisiest source of clutter on the dashboard today.
 *
 * 一键去重：先 dryrun 返回 plan，再 execute=true 真正删。基于精确字符串匹配。
 */

import { buildDedupePlan, type DedupeCandidate, type DedupePlan } from "@/lib/memory-dedupe";
import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DedupeRequestBody {
	readonly execute?: boolean;
}

function isDedupeRequestBody(value: unknown): value is DedupeRequestBody {
	if (value == null || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	if ("execute" in obj && typeof obj.execute !== "boolean") return false;
	return true;
}

interface RecallShape {
	readonly id?: unknown;
	readonly record_id?: unknown;
	readonly content?: unknown;
	readonly text?: unknown;
	readonly tier?: unknown;
	readonly memory_tier?: unknown;
	readonly layer?: unknown;
	readonly memory_layer?: unknown;
	readonly created_at?: unknown;
	readonly createdAt?: unknown;
	readonly timestamp?: unknown;
}

function asString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Extract dedupe candidates from a `memory_recall` MCP response.
 *
 * Records without a usable id or non-empty content are skipped — they
 * can't be deleted (no id) or have nothing meaningful to compare (no
 * content). The id-synthesis logic mirrors `parseToolOutput` in the
 * sibling route but only accepts records that have a real persisted
 * id, since synthetic ids cannot be sent back to `memory_delete`.
 */
function extractCandidates(raw: string): readonly DedupeCandidate[] {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}
	const arr: unknown[] = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" && parsed != null && "records" in parsed
			? ((parsed as { records: unknown[] }).records ?? [])
			: typeof parsed === "object" && parsed != null && "data" in parsed
				? ((parsed as { data: unknown[] }).data ?? [])
				: [];
	if (!Array.isArray(arr)) return [];
	const out: DedupeCandidate[] = [];
	for (const item of arr) {
		if (item == null || typeof item !== "object") continue;
		const obj = item as RecallShape;
		const id = asString(obj.id) ?? asString(obj.record_id);
		if (id == null) continue; // No real id → can't delete safely.
		const content = asString(obj.content) ?? asString(obj.text);
		if (content == null) continue;
		const tier =
			asString(obj.tier) ?? asString(obj.memory_tier) ?? asString(obj.layer) ?? "unknown";
		const createdAt =
			asString(obj.created_at) ?? asString(obj.createdAt) ?? asString(obj.timestamp);
		out.push({ id, content, tier, createdAt });
	}
	return out;
}

interface ExecuteResult {
	readonly id: string;
	readonly ok: boolean;
	readonly error: string | null;
}

async function executePlan(
	plan: DedupePlan,
	deleteTool: {
		readonly execute: (args: unknown) => Promise<{
			readonly content: string;
			readonly isError: boolean;
			readonly error?: { readonly message: string; readonly code?: string };
		}>;
	},
): Promise<{
	readonly results: readonly ExecuteResult[];
	readonly deleted: number;
	readonly failed: number;
}> {
	const results: ExecuteResult[] = [];
	for (const group of plan.groups) {
		for (const id of group.deleteIds) {
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
	}
	const deleted = results.filter((r) => r.ok).length;
	return { results, deleted, failed: results.length - deleted };
}

export async function POST(request: Request): Promise<Response> {
	try {
		// Allow empty body (defaults to preview). Tolerate missing or
		// malformed JSON because the typical fetch from the UI is
		// `POST /api/memory/dedupe` with no body for preview.
		let body: unknown = {};
		try {
			const text = await request.text();
			if (text.length > 0) body = JSON.parse(text);
		} catch {
			return Response.json(
				{
					ok: false,
					error: { code: "invalid_body", message: "request body must be JSON or empty" },
				},
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}
		if (!isDedupeRequestBody(body)) {
			return Response.json(
				{
					ok: false,
					error: { code: "invalid_body", message: "expected `{ execute?: boolean }`" },
				},
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}
		const execute = body.execute === true;

		const catalog = await getToolsCatalog();
		const recallTool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_recall");
		if (recallTool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_unavailable",
						message: "quilin-mem MCP server is not connected; cannot compute dedupe plan.",
					},
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		const recallResult = await recallTool.execute({ query: "" });
		if (recallResult.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_recall_failed",
						message: recallResult.error?.message ?? recallResult.content,
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		const candidates = extractCandidates(recallResult.content);
		const plan = buildDedupePlan(candidates);

		if (!execute) {
			return Response.json(
				{
					ok: true,
					data: {
						executed: false,
						plan,
						/** Convenience surface for the preview UI. */
						totalDelete: plan.totalDelete,
						totalKeep: plan.totalKeep,
					},
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}

		const deleteTool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_delete");
		if (deleteTool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_delete_unavailable",
						message: "quilin-mem MCP server is connected but memory_delete tool is missing.",
					},
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		const { results, deleted, failed } = await executePlan(plan, deleteTool);
		return Response.json(
			{
				ok: true,
				data: {
					executed: true,
					plan,
					deleted,
					failed,
					results,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/memory/dedupe] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "memory_dedupe_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
