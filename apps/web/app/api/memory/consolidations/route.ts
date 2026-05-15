/**
 * GET /api/memory/consolidations
 *
 * UX-4 Slice 4 UI endpoint. Reads recent consolidation proposals from the
 * quilin-mem `consolidation_log_recent` MCP tool and returns a typed JSON
 * shape for the /memory timeline tab.
 *
 * Query params:
 *   limit: 1-1000 (default 100)
 *
 * GET /api/memory/consolidations?limit=50
 *   -> 200 { ok: true, data: { available, total, entries } }
 *   -> 200 { ok: true, data: { available: false, reason, total: 0, entries: [] } }
 *   -> 400 invalid query
 *   -> 502 MCP tool failure / parse failure
 */

import { z } from "zod";
import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ConsolidationAction {
	readonly kind: string;
	readonly target_layer: string | null;
	readonly reason: string;
	readonly dry_run: boolean;
	readonly writes_semantic: boolean;
	readonly writes_skill: boolean;
	readonly metadata: Record<string, unknown> | null;
}

export interface ConsolidationEntry {
	readonly id: number;
	readonly task: string;
	readonly dry_run: boolean;
	readonly budget_decision: string;
	readonly actions: ReadonlyArray<ConsolidationAction>;
	readonly writes_performed: number;
	readonly created_at: string;
	readonly schema_version: number;
}

export interface ConsolidationsPayload {
	readonly available: boolean;
	readonly reason?: string;
	readonly total: number;
	readonly entries: ReadonlyArray<ConsolidationEntry>;
}

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(1000).default(100),
});

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string, fallback = ""): string {
	const value = record[key];
	return typeof value === "string" ? value : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback = 0): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(record: Record<string, unknown>, key: string, fallback = false): boolean {
	const value = record[key];
	return typeof value === "boolean" ? value : fallback;
}

function toolErrorMessage(
	error: { readonly message?: unknown } | undefined,
	content: unknown,
): string {
	if (typeof error?.message === "string" && error.message.length > 0) {
		return error.message;
	}
	if (typeof content === "string") return content;
	try {
		const serialized = JSON.stringify(content);
		if (typeof serialized === "string" && serialized.length > 0) return serialized;
	} catch {
		// fall through to stable generic message
	}
	return "consolidation log MCP tool failed";
}

function actionFromUnknown(value: unknown): ConsolidationAction | null {
	const record = asRecord(value);
	if (record == null) return null;
	const metadata = asRecord(record.metadata);
	const targetLayer = record.target_layer;
	return {
		kind: stringField(record, "kind", "unknown"),
		target_layer: typeof targetLayer === "string" && targetLayer.length > 0 ? targetLayer : null,
		reason: stringField(record, "reason"),
		dry_run: booleanField(record, "dry_run"),
		writes_semantic: booleanField(record, "writes_semantic"),
		writes_skill: booleanField(record, "writes_skill"),
		metadata,
	};
}

function entryFromUnknown(value: unknown): ConsolidationEntry | null {
	const record = asRecord(value);
	if (record == null) return null;
	const id = numberField(record, "id", Number.NaN);
	const createdAt = stringField(record, "created_at");
	if (!Number.isFinite(id) || createdAt.length === 0) return null;
	const actionsRaw = Array.isArray(record.actions) ? record.actions : [];
	return {
		id,
		task: stringField(record, "task"),
		dry_run: booleanField(record, "dry_run"),
		budget_decision: stringField(record, "budget_decision", "unknown"),
		actions: actionsRaw.map(actionFromUnknown).filter((a): a is ConsolidationAction => a != null),
		writes_performed: numberField(record, "writes_performed"),
		created_at: createdAt,
		schema_version: numberField(record, "schema_version", 1),
	};
}

function parseRecentOutput(content: string): ConsolidationsPayload | null {
	try {
		const parsed = JSON.parse(content) as unknown;
		const record = asRecord(parsed);
		if (record == null) return null;
		const entriesRaw = Array.isArray(record.entries) ? record.entries : [];
		const entries = entriesRaw
			.map(entryFromUnknown)
			.filter((entry): entry is ConsolidationEntry => entry != null);
		return {
			available: booleanField(record, "available", true),
			reason: stringField(record, "reason") || undefined,
			total: numberField(record, "total", entries.length),
			entries,
		};
	} catch {
		return null;
	}
}

export async function GET(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const parsedQuery = querySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!parsedQuery.success) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "invalid_query",
					message: "invalid query parameters",
					issues: parsedQuery.error.issues,
				},
			},
			{ status: 400, headers: { "cache-control": "no-store" } },
		);
	}

	try {
		const catalog = await getToolsCatalog();
		const tool = catalog.rawTools.find((t) => t.name === "quilin-mem/consolidation_log_recent");
		if (tool == null) {
			return Response.json(
				{
					ok: true,
					data: {
						available: false,
						reason:
							"quilin-mem MCP server is not connected. Consolidation timeline is unavailable. Check /mcp for connection status.",
						total: 0,
						entries: [],
					},
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}

		const result = await tool.execute({ limit: parsedQuery.data.limit });
		if (result.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "consolidation_log_failed",
						message: toolErrorMessage(result.error, result.content),
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		const payload = parseRecentOutput(result.content);
		if (payload == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "consolidation_log_parse_failed",
						message: "could not parse MCP tool output as consolidation log payload",
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		return Response.json(
			{
				ok: true,
				data: payload,
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "consolidations_route_failed",
					message: e instanceof Error ? e.message : String(e),
				},
			},
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
