/**
 * GET /api/memory/graph
 *
 * UX-4 Slice 3 backend. Reads up to `limit` KG edges from the
 * quilin-mem `kg_dump_for_viz` MCP tool and returns them in a
 * reactflow / cytoscape-friendly `{nodes, edges}` shape for the
 * /memory page graph tab.
 *
 * Query params:
 *   limit:  1-2000 (default 500), clamped server-side too
 *   as_of:  optional ISO 8601 — only return edges whose
 *           [valid_from, valid_to] window contains this moment
 *
 * GET /api/memory/graph?limit=200&as_of=2026-05-15T00:00:00Z
 *   → 200 { ok: true, data: { nodes, edges, counts, available } }
 *   → 200 { ok: true, data: { available: false, reason: "..." } } when MCP unavailable
 *   → 400 invalid query
 *   → 502 MCP tool failure
 *
 * Reactflow JSON shape:
 *   nodes:  [{id: string, label: string}]            (deduplicated entities)
 *   edges:  [{id, source, target, label, valid_from, valid_to, memory_id, weight}]
 *
 * UX-4 Slice 3 后端:走 quilin-mem MCP 的 kg_dump_for_viz 工具拉 KG 边集,
 * 转成 reactflow JSON 形式给前端可视化用。
 */

import { z } from "zod";
import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface GraphNode {
	readonly id: string;
	readonly label: string;
}

export interface GraphEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly label: string;
	readonly valid_from: string | null;
	readonly valid_to: string | null;
	readonly memory_id: string | null;
	readonly weight: number;
}

export interface GraphPayload {
	readonly nodes: ReadonlyArray<GraphNode>;
	readonly edges: ReadonlyArray<GraphEdge>;
}

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(2000).default(500),
	as_of: z.string().datetime({ offset: true }).optional(),
});

function parseDumpOutput(content: string): GraphPayload | null {
	try {
		const parsed = JSON.parse(content);
		if (parsed == null || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];
		const edges = Array.isArray(obj.edges) ? obj.edges : [];
		const cleanNodes: GraphNode[] = [];
		for (const n of nodes) {
			if (n == null || typeof n !== "object") continue;
			const nObj = n as Record<string, unknown>;
			const id = typeof nObj.id === "string" ? nObj.id : null;
			const label = typeof nObj.label === "string" ? nObj.label : id;
			if (id == null || label == null) continue;
			cleanNodes.push({ id, label });
		}
		const cleanEdges: GraphEdge[] = [];
		for (const e of edges) {
			if (e == null || typeof e !== "object") continue;
			const eObj = e as Record<string, unknown>;
			const id = typeof eObj.id === "string" ? eObj.id : null;
			const source = typeof eObj.source === "string" ? eObj.source : null;
			const target = typeof eObj.target === "string" ? eObj.target : null;
			const label = typeof eObj.label === "string" ? eObj.label : "";
			if (id == null || source == null || target == null) continue;
			cleanEdges.push({
				id,
				source,
				target,
				label,
				valid_from: typeof eObj.valid_from === "string" ? eObj.valid_from : null,
				valid_to: typeof eObj.valid_to === "string" ? eObj.valid_to : null,
				memory_id: typeof eObj.memory_id === "string" ? eObj.memory_id : null,
				weight: typeof eObj.weight === "number" ? eObj.weight : 1.0,
			});
		}
		return { nodes: cleanNodes, edges: cleanEdges };
	} catch {
		return null;
	}
}

export async function GET(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const queryRaw = {
		limit: url.searchParams.get("limit") ?? undefined,
		as_of: url.searchParams.get("as_of") ?? undefined,
	};
	const parsedQuery = querySchema.safeParse(queryRaw);
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
	const { limit, as_of } = parsedQuery.data;

	try {
		const catalog = await getToolsCatalog();
		const dumpTool = catalog.rawTools.find((t) => t.name === "quilin-mem/kg_dump_for_viz");
		if (dumpTool == null) {
			return Response.json(
				{
					ok: true,
					data: {
						available: false,
						reason:
							"quilin-mem MCP server is not connected. KG graph dashboard is unavailable. Check /mcp for connection status.",
						nodes: [],
						edges: [],
						counts: { nodes: 0, edges: 0 },
					},
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}

		const result = await dumpTool.execute({
			limit,
			...(as_of === undefined ? {} : { as_of }),
		});
		if (result.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "kg_dump_failed",
						message: result.error?.message ?? result.content,
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}
		const graph = parseDumpOutput(result.content);
		if (graph == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "kg_dump_parse_failed",
						message: "could not parse MCP tool output as graph payload",
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		return Response.json(
			{
				ok: true,
				data: {
					available: true,
					nodes: graph.nodes,
					edges: graph.edges,
					counts: { nodes: graph.nodes.length, edges: graph.edges.length },
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "kg_graph_route_failed",
					message: e instanceof Error ? e.message : String(e),
				},
			},
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
