"use client";

/**
 * QUI-199 Evidence Graph Visualization — Web /memory page 的"证据图"tab。
 *
 * 一条 memory record 的版本链(supersedes)+ 原始观察(observation)+ 出处
 * (memory_sources)用 reactflow v12 渲染。
 *
 * 用户点击 /memory 列表某条记忆 → 切到 evidence tab → 看到这条记忆的
 * 来龙去脉(谁写的 / 哪次对话 / 覆盖了谁)。
 *
 * Backend:`/api/memory/evidence-graph?id=<memory_id>` → `memory_evidence_graph`
 * MCP tool。
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

interface ServerEvidenceNode {
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

interface ServerEvidenceEdge {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly kind: "supersedes" | "source_of" | "evidence_of";
}

interface EvidenceGraphResponse {
	readonly ok: true;
	readonly data: {
		readonly nodes: ReadonlyArray<ServerEvidenceNode>;
		readonly edges: ReadonlyArray<ServerEvidenceEdge>;
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

/**
 * Place memory nodes on top row, observation nodes below — 显式两层布局
 * 让用户一眼看出"事件 → 记忆"的派生关系。
 */
function layoutNodes(serverNodes: ReadonlyArray<ServerEvidenceNode>): Node[] {
	const memoryNodes = serverNodes.filter((n) => n.kind === "memory");
	const obsNodes = serverNodes.filter((n) => n.kind === "observation");
	const colWidth = 280;
	const rowMemory = 60;
	const rowObs = 280;
	const out: Node[] = [];
	memoryNodes.forEach((n, i) => {
		const isLatest = n.is_latest ?? true;
		out.push({
			id: n.id,
			data: { label: n.label },
			position: { x: i * colWidth, y: rowMemory },
			style: {
				fontSize: 11,
				border: `2px solid ${isLatest ? "var(--accent-vermillion, #b91c1c)" : "var(--fg-muted, #888)"}`,
				background: isLatest ? "var(--bg, #fff)" : "var(--bg-soft, #f5f5f5)",
				color: "var(--fg, #000)",
				borderRadius: 6,
				padding: "8px 12px",
				width: 250,
			},
		});
	});
	obsNodes.forEach((n, i) => {
		out.push({
			id: n.id,
			data: { label: `${n.role ?? "?"}: ${n.label}` },
			position: { x: i * colWidth, y: rowObs },
			style: {
				fontSize: 10,
				border: "1px dashed var(--fg-muted, #888)",
				background: "var(--bg-elev, #fafafa)",
				color: "var(--fg-muted, #666)",
				borderRadius: 6,
				padding: "6px 10px",
				width: 250,
			},
		});
	});
	return out;
}

function buildEdges(serverEdges: ReadonlyArray<ServerEvidenceEdge>): Edge[] {
	return serverEdges.map((e) => ({
		id: e.id,
		source: e.from,
		target: e.to,
		label: e.kind === "supersedes" ? "覆盖" : e.kind === "source_of" ? "出处" : "证据",
		markerEnd: { type: MarkerType.ArrowClosed },
		labelStyle: { fontSize: 9 },
		style: {
			strokeWidth: 1.5,
			stroke:
				e.kind === "supersedes" ? "var(--accent-vermillion, #b91c1c)" : "var(--fg-muted, #888)",
		},
	}));
}

export interface EvidenceGraphViewProps {
	readonly memoryId: string | null;
}

export function EvidenceGraphView({ memoryId }: EvidenceGraphViewProps) {
	const [data, setData] = useState<EvidenceGraphResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const fetchEpochRef = useState<{ current: number }>({ current: 0 })[0];

	const fetchGraph = useCallback(
		async (id: string) => {
			const myEpoch = ++fetchEpochRef.current;
			setLoading(true);
			setError(null);
			try {
				const res = await fetch(`/api/memory/evidence-graph?id=${encodeURIComponent(id)}`, {
					cache: "no-store",
				});
				if (myEpoch !== fetchEpochRef.current) return;
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as EvidenceGraphErrorResponse | null;
					throw new Error(body?.error.message ?? `HTTP ${res.status}`);
				}
				const body = (await res.json()) as EvidenceGraphResponse;
				if (myEpoch !== fetchEpochRef.current) return;
				setData(body.data);
			} catch (e) {
				if (myEpoch !== fetchEpochRef.current) return;
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (myEpoch === fetchEpochRef.current) setLoading(false);
			}
		},
		[fetchEpochRef],
	);

	useEffect(() => {
		if (memoryId == null) return;
		void fetchGraph(memoryId);
	}, [memoryId, fetchGraph]);

	const nodes = useMemo<Node[]>(() => (data ? layoutNodes(data.nodes) : []), [data]);
	const edges = useMemo<Edge[]>(() => (data ? buildEdges(data.edges) : []), [data]);

	if (memoryId == null) {
		return (
			<div
				data-testid="evidence-view-no-selection"
				style={{ padding: 24, color: "var(--fg-muted)" }}
			>
				<p>
					从左侧记忆列表点一条记忆,这里会显示它的<strong>证据图</strong>:
				</p>
				<ul style={{ marginTop: 8, paddingLeft: 20, fontSize: 12, lineHeight: 1.8 }}>
					<li>↑ 上排:这条记忆的版本链(谁覆盖了谁,QUI-193 supersede)</li>
					<li>↓ 下排:原始对话观察(memory_observations,从哪次 chat 派生)</li>
					<li>红色边:版本覆盖(supersedes)</li>
					<li>灰色边:出处链接(source_of)</li>
				</ul>
			</div>
		);
	}

	if (loading) {
		return (
			<div data-testid="evidence-view-loading" style={{ padding: 24, color: "var(--fg-muted)" }}>
				加载证据图中…
			</div>
		);
	}
	if (error != null) {
		return (
			<div
				data-testid="evidence-view-error"
				style={{ padding: 24, color: "var(--accent-vermillion)" }}
			>
				证据图加载失败:{error}
				<button
					type="button"
					onClick={() => void fetchGraph(memoryId)}
					style={{
						marginLeft: 12,
						padding: "4px 12px",
						background: "transparent",
						border: "1px solid var(--border)",
						borderRadius: 4,
						color: "var(--fg)",
						cursor: "pointer",
					}}
				>
					重试 / retry
				</button>
			</div>
		);
	}
	if (data == null || data.nodes.length === 0) {
		return (
			<div
				data-testid="evidence-view-empty"
				style={{ padding: 24, color: "var(--fg-muted)", fontStyle: "italic" }}
			>
				这条记忆暂无证据图(没有版本链 / 没有 memory_sources 链接)。
			</div>
		);
	}

	return (
		<div data-testid="evidence-view" style={{ marginTop: 4 }}>
			<div className="q-section-title">
				<span className="cn">证据图 · evidence graph</span>
				<span className="right">
					{data.counts.memories} 条记忆 · {data.counts.observations} 条观察 ·{" "}
					{data.counts.supersedes_edges} 条版本边 · {data.counts.source_edges} 条出处边
				</span>
			</div>
			<div
				style={{
					width: "100%",
					height: 500,
					border: "1px solid var(--border)",
					borderRadius: 6,
				}}
			>
				<ReactFlow nodes={nodes} edges={edges} fitView attributionPosition="bottom-right">
					<Background />
					<Controls />
					<MiniMap pannable zoomable />
				</ReactFlow>
			</div>
		</div>
	);
}
