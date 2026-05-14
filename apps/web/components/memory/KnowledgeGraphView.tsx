"use client";

/**
 * UX-4 Slice 3.2 — KG visualization component for the /memory page.
 *
 * Fetches /api/memory/graph and renders the returned edge list with
 * @xyflow/react (reactflow v12). Layout is simple grid-based — proper
 * force-directed / hierarchical layout is intentionally deferred:
 * for ≤500 edges the grid is readable, and adding a layout engine
 * (elkjs, dagre) is its own slice.
 *
 * Node click → calls the optional `onSelectMemory` prop with the
 * `memory_id` of the first edge connected to that node, letting the
 * parent page show the source memory record alongside.
 *
 * UX-4 Slice 3.2 KG 可视化:从 /api/memory/graph 拉边集,用 reactflow v12
 * 渲染。默认 grid layout 简单清晰;点击节点回调 memory_id 让父页面查
 * 原 memory record。
 */

import {
	Background,
	Controls,
	type Edge,
	MarkerType,
	MiniMap,
	type Node,
	ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";

interface ServerGraphNode {
	readonly id: string;
	readonly label: string;
}

interface ServerGraphEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly label: string;
	readonly valid_from: string | null;
	readonly valid_to: string | null;
	readonly memory_id: string | null;
	readonly weight: number;
}

interface GraphFetchResponse {
	readonly ok: true;
	readonly data: {
		readonly available: boolean;
		readonly reason?: string;
		readonly nodes: ReadonlyArray<ServerGraphNode>;
		readonly edges: ReadonlyArray<ServerGraphEdge>;
		readonly counts: { readonly nodes: number; readonly edges: number };
	};
}

interface GraphErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

/**
 * Place nodes on a simple square grid. Spacing is chosen so labels
 * don't overlap at default font sizes; larger graphs flow into more
 * rows automatically.
 */
function gridLayout(nodes: ReadonlyArray<ServerGraphNode>): Node[] {
	const colCount = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
	const colWidth = 220;
	const rowHeight = 110;
	return nodes.map((n, i) => ({
		id: n.id,
		data: { label: n.label },
		position: {
			x: (i % colCount) * colWidth,
			y: Math.floor(i / colCount) * rowHeight,
		},
		style: {
			fontSize: 12,
			border: "1px solid var(--border, #888)",
			background: "var(--bg-soft, #fff)",
			color: "var(--fg, #000)",
			borderRadius: 6,
			padding: "6px 10px",
		},
	}));
}

function buildEdges(serverEdges: ReadonlyArray<ServerGraphEdge>): Edge[] {
	return serverEdges.map((e) => ({
		id: e.id,
		source: e.source,
		target: e.target,
		label: e.label,
		markerEnd: { type: MarkerType.ArrowClosed },
		labelStyle: { fontSize: 10 },
		style: { strokeWidth: Math.max(1, Math.min(3, e.weight * 2)) },
	}));
}

export interface KnowledgeGraphViewProps {
	/** Called when the user clicks a node — receives the entity id +
	 *  the first matching edge's `memory_id` (or null if none has one).
	 *  Lets the parent surface the source memory record. */
	readonly onSelectMemory?: (entityId: string, memoryId: string | null) => void;
}

export function KnowledgeGraphView({ onSelectMemory }: KnowledgeGraphViewProps) {
	const [data, setData] = useState<GraphFetchResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const fetchGraph = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/memory/graph?limit=500", { cache: "no-store" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as GraphErrorResponse | null;
				throw new Error(body?.error.message ?? `HTTP ${res.status}`);
			}
			const body = (await res.json()) as GraphFetchResponse;
			setData(body.data);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchGraph();
	}, [fetchGraph]);

	const nodes = useMemo<Node[]>(() => (data ? gridLayout(data.nodes) : []), [data]);
	const edges = useMemo<Edge[]>(() => (data ? buildEdges(data.edges) : []), [data]);

	const handleNodeClick = useCallback(
		(_event: unknown, node: Node) => {
			if (onSelectMemory == null || data == null) return;
			const firstEdge = data.edges.find(
				(e) => (e.source === node.id || e.target === node.id) && e.memory_id != null,
			);
			onSelectMemory(node.id, firstEdge?.memory_id ?? null);
		},
		[data, onSelectMemory],
	);

	if (loading) {
		return (
			<div data-testid="kg-view-loading" style={{ padding: 24, color: "var(--fg-muted)" }}>
				加载中 · loading knowledge graph…
			</div>
		);
	}
	if (error != null) {
		return (
			<div data-testid="kg-view-error" style={{ padding: 24, color: "var(--destructive)" }}>
				读取知识图谱失败:{error}
				<button
					type="button"
					onClick={() => void fetchGraph()}
					style={{
						marginLeft: 12,
						padding: "4px 12px",
						background: "var(--bg-soft)",
						border: "1px solid var(--border)",
						borderRadius: 4,
						cursor: "pointer",
					}}
				>
					重试 / retry
				</button>
			</div>
		);
	}
	if (data == null || !data.available) {
		return (
			<div
				data-testid="kg-view-unavailable"
				style={{ padding: 24, color: "var(--fg-muted)", fontStyle: "italic" }}
			>
				{data?.reason ?? "知识图谱不可用 · KG unavailable"}
			</div>
		);
	}
	if (data.edges.length === 0) {
		return (
			<div data-testid="kg-view-empty" style={{ padding: 24, color: "var(--fg-muted)" }}>
				<p>知识图谱为空 · KG is empty.</p>
				<p style={{ fontSize: 12, marginTop: 8 }}>
					让 agent 调一次 <code>memory_backfill_kg</code> MCP 工具(dry_run: false) 把现有
					memory_records 灌进 KG 后再回来。
				</p>
				<p style={{ fontSize: 12, marginTop: 8 }}>
					Have the agent run <code>memory_backfill_kg</code> (dry_run: false) on the existing memory
					records, then revisit this tab.
				</p>
			</div>
		);
	}

	return (
		<div
			data-testid="kg-view"
			style={{ width: "100%", height: 600, border: "1px solid var(--border)", borderRadius: 6 }}
		>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodeClick={handleNodeClick}
				fitView
				attributionPosition="bottom-right"
			>
				<Background />
				<Controls />
				<MiniMap pannable zoomable />
			</ReactFlow>
		</div>
	);
}
