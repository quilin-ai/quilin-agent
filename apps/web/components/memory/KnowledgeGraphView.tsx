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

	// Track an "in-flight epoch" so rapid retry clicks don't race —
	// only the most recent fetch's result wins. A user double-clicking
	// "重试" would otherwise see flicker as both fetches resolve in
	// arbitrary order.
	const fetchEpochRef = useState<{ current: number }>({ current: 0 })[0];

	const fetchGraph = useCallback(async () => {
		const myEpoch = ++fetchEpochRef.current;
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/memory/graph?limit=500", { cache: "no-store" });
			if (myEpoch !== fetchEpochRef.current) return; // superseded
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as GraphErrorResponse | null;
				throw new Error(body?.error.message ?? `HTTP ${res.status}`);
			}
			const body = (await res.json()) as GraphFetchResponse;
			if (myEpoch !== fetchEpochRef.current) return;
			setData(body.data);
		} catch (e) {
			if (myEpoch !== fetchEpochRef.current) return;
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (myEpoch === fetchEpochRef.current) setLoading(false);
		}
	}, [fetchEpochRef]);

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
		return <KgEmptyState onBackfilled={() => void fetchGraph()} />;
	}

	return (
		<div>
			{/* D.16 fix: keep "立即灌入" button visible even when KG has data
			    so user can trigger incremental backfill on new memories.
			    Real dogfood: KG showed 8 edges from 3 memories but new
			    chat-stored records (10 active) never auto-processed; user
			    had no way to refresh KG without restarting daemon. */}
			<div
				style={{
					marginBottom: 12,
					display: "flex",
					alignItems: "center",
					gap: 12,
					fontSize: 12,
					color: "var(--fg-muted)",
				}}
			>
				<KgBackfillInlineButton onBackfilled={() => void fetchGraph()} />
				<span>
					{data.nodes.length} 个实体 · {data.edges.length} 条关系
				</span>
			</div>
			<div
				data-testid="kg-view"
				style={{
					width: "100%",
					height: 600,
					border: "1px solid var(--border)",
					borderRadius: 6,
				}}
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
		</div>
	);
}

function KgBackfillInlineButton({ onBackfilled }: { readonly onBackfilled: () => void }) {
	const [running, setRunning] = useState(false);
	const [feedback, setFeedback] = useState<string | null>(null);
	const trigger = useCallback(async () => {
		setRunning(true);
		setFeedback(null);
		try {
			const res = await fetch("/api/memory/backfill-kg", { method: "POST", cache: "no-store" });
			const body = (await res.json().catch(() => null)) as
				| {
						ok: true;
						data: {
							processed?: number;
							edgesAdded?: number;
							skipped?: number;
							backfilled?: number;
							edges?: number;
						};
				  }
				| { ok: false; error: { code: string; message: string } }
				| null;
			if (body == null || !body.ok) {
				const msg = body != null && !body.ok ? body.error.message : `HTTP ${res.status}`;
				setFeedback(`✗ ${msg}`);
				return;
			}
			const processed = body.data.processed ?? body.data.backfilled ?? 0;
			const added = body.data.edgesAdded ?? body.data.edges ?? 0;
			const skipped = body.data.skipped ?? 0;
			setFeedback(
				`✓ 已处理 ${processed} 条记忆, 新增 ${added} 条关系, 跳过 ${skipped} 条 (无变化)`,
			);
			onBackfilled();
		} catch (e) {
			setFeedback(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setRunning(false);
		}
	}, [onBackfilled]);
	return (
		<>
			<button
				type="button"
				onClick={() => void trigger()}
				disabled={running}
				data-testid="kg-backfill-inline-button"
				style={{
					padding: "4px 12px",
					background: running ? "var(--bg-soft)" : "transparent",
					color: "var(--fg)",
					border: "1px solid var(--border)",
					borderRadius: 4,
					cursor: running ? "not-allowed" : "pointer",
					fontSize: 12,
				}}
			>
				{running ? "灌入中…" : "↻ 增量灌入"}
			</button>
			{feedback != null ? <span data-testid="kg-backfill-inline-feedback">{feedback}</span> : null}
		</>
	);
}

/**
 * 知识图谱空状态:不再让用户去手动调 MCP tool,直接在 UI 加 "立即灌入" 按钮。
 */
interface KgEmptyStateProps {
	readonly onBackfilled: () => void;
}

function KgEmptyState({ onBackfilled }: KgEmptyStateProps) {
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const triggerBackfill = useCallback(async () => {
		setRunning(true);
		setErr(null);
		setResult(null);
		try {
			const res = await fetch("/api/memory/backfill-kg", {
				method: "POST",
				cache: "no-store",
			});
			const body = (await res.json().catch(() => null)) as
				| { ok: true; data: { backfilled: number; edges: number } }
				| { ok: false; error: { code: string; message: string } }
				| null;
			if (body == null || !body.ok) {
				const msg = body != null && !body.ok ? body.error.message : `HTTP ${res.status}`;
				throw new Error(msg);
			}
			setResult(`已灌入 ${body.data.backfilled} 条记忆,生成 ${body.data.edges} 条图谱关系`);
			onBackfilled();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setRunning(false);
		}
	}, [onBackfilled]);

	return (
		<div data-testid="kg-view-empty" style={{ padding: 24, color: "var(--fg-muted)" }}>
			<p style={{ color: "var(--fg)" }}>知识图谱还是空的。</p>
			<p style={{ fontSize: 12, marginTop: 8 }}>
				图谱节点 = 记忆里出现的实体(人、地点、概念),边 =
				它们之间的关系。需要先把现有记忆灌进图谱,才能看到节点。
			</p>
			<button
				type="button"
				onClick={() => void triggerBackfill()}
				disabled={running}
				data-testid="kg-backfill-button"
				style={{
					marginTop: 16,
					padding: "8px 16px",
					background: running ? "var(--bg-soft)" : "var(--accent-vermillion)",
					color: running ? "var(--fg-muted)" : "var(--bg)",
					border: "1px solid var(--accent-vermillion)",
					borderRadius: 6,
					cursor: running ? "not-allowed" : "pointer",
					fontSize: 12,
					fontFamily: '"Noto Sans SC", sans-serif',
				}}
			>
				{running ? "灌入中…" : "立即灌入 · backfill from memory_records"}
			</button>
			{result != null ? (
				<p
					data-testid="kg-backfill-success"
					style={{ marginTop: 12, color: "var(--accent-vermillion)", fontSize: 12 }}
				>
					✓ {result}
				</p>
			) : null}
			{err != null ? (
				<p
					data-testid="kg-backfill-error"
					style={{ marginTop: 12, color: "var(--destructive, #d97706)", fontSize: 12 }}
				>
					✗ 灌入失败:{err}
				</p>
			) : null}
		</div>
	);
}
