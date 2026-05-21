/**
 * GET /api/memory/evidence-graph?id=<memory_id>
 *
 * QUI-199 evidence visualization Web API。调 quilin-mem `memory_evidence_graph`
 * MCP tool 拿一条记忆的版本链 + 原始观察 + 出处图,返 reactflow-ready JSON。
 *
 * Web `/memory` page 的 "evidence" tab 展开一条 memory 时调本路由。
 *
 * Returns:
 *   { ok: true, data: { nodes, edges, counts } }
 *   { ok: false, error: { code, message } }
 */

import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EvidenceNode {
	readonly id: string;
	readonly kind: "memory" | "observation" | "source";
	readonly label: string;
	readonly tier?: string;
	readonly is_latest?: boolean;
	readonly last_writer_client?: string | null;
	readonly created_at?: string;
	readonly role?: string | null;
	readonly observed_at?: string;
}

interface EvidenceEdge {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly kind: "supersedes" | "source_of" | "evidence_of";
}

interface EvidenceGraphResponse {
	readonly ok: true;
	readonly data: {
		readonly nodes: readonly EvidenceNode[];
		readonly edges: readonly EvidenceEdge[];
		readonly counts: {
			readonly memories: number;
			readonly observations: number;
			readonly supersedes_edges: number;
			readonly source_edges: number;
		};
	};
}

interface EvidenceGraphErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

export async function GET(request: Request): Promise<Response> {
	try {
		const url = new URL(request.url);
		const memoryId = url.searchParams.get("id");
		if (memoryId == null || memoryId.length === 0) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "missing_memory_id",
						message: "Query parameter `id` (memory record id) is required.",
					},
				} satisfies EvidenceGraphErrorResponse,
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}

		const catalog = await getToolsCatalog();
		const tool = catalog.rawTools.find(
			(t) =>
				t.name === "quilin-mem/memory_evidence_graph" ||
				t.name === "quilin-mem__memory_evidence_graph",
		);
		if (tool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_evidence_graph_unavailable",
						message:
							"quilin-mem MCP server is not connected, or memory_evidence_graph tool is missing.",
					},
				} satisfies EvidenceGraphErrorResponse,
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		const result = await tool.execute({ memory_id: memoryId });
		if (result.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_evidence_graph_failed",
						message: result.error?.message ?? result.content,
					},
				} satisfies EvidenceGraphErrorResponse,
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		const parsed = JSON.parse(result.content) as unknown;
		if (parsed == null || typeof parsed !== "object") {
			throw new Error("memory_evidence_graph returned non-object payload");
		}
		const data = parsed as EvidenceGraphResponse["data"];
		return Response.json({ ok: true, data } satisfies EvidenceGraphResponse, {
			headers: { "cache-control": "no-store" },
		});
	} catch (e) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "memory_evidence_graph_error",
					message: e instanceof Error ? e.message : String(e),
				},
			} satisfies EvidenceGraphErrorResponse,
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
