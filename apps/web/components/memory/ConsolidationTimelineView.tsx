"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface ConsolidationAction {
	readonly kind: string;
	readonly target_layer: string | null;
	readonly reason: string;
	readonly dry_run: boolean;
	readonly writes_semantic: boolean;
	readonly writes_skill: boolean;
	readonly metadata: Record<string, unknown> | null;
}

interface ConsolidationEntry {
	readonly id: number;
	readonly task: string;
	readonly dry_run: boolean;
	readonly budget_decision: string;
	readonly actions: ReadonlyArray<ConsolidationAction>;
	readonly writes_performed: number;
	readonly created_at: string;
	readonly schema_version: number;
}

interface ConsolidationsResponse {
	readonly ok: true;
	readonly data: {
		readonly available: boolean;
		readonly reason?: string;
		readonly total: number;
		readonly entries: ReadonlyArray<ConsolidationEntry>;
	};
}

interface ConsolidationsErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

function formatTimestamp(iso: string): string {
	try {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString("zh-CN", { hour12: false });
	} catch {
		return iso;
	}
}

function decisionLabel(decision: string): string {
	switch (decision) {
		case "allow":
		case "approved":
			return "允许";
		case "deny":
		case "denied":
			return "拒绝";
		case "skip":
		case "skipped":
			return "跳过";
		default:
			return decision;
	}
}

function actionSummary(actions: ReadonlyArray<ConsolidationAction>): string {
	if (actions.length === 0) return "无动作 · no actions";
	const counts = new Map<string, number>();
	for (const action of actions) {
		counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([kind, count]) => `${kind} × ${count}`)
		.join(" · ");
}

export function ConsolidationTimelineView() {
	const [data, setData] = useState<ConsolidationsResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [expandedId, setExpandedId] = useState<number | null>(null);
	const fetchEpochRef = useState<{ current: number }>({ current: 0 })[0];

	const fetchTimeline = useCallback(async () => {
		const myEpoch = ++fetchEpochRef.current;
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/memory/consolidations?limit=100", { cache: "no-store" });
			if (myEpoch !== fetchEpochRef.current) return;
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as ConsolidationsErrorResponse | null;
				throw new Error(body?.error.message ?? `HTTP ${res.status}`);
			}
			const body = (await res.json()) as ConsolidationsResponse | ConsolidationsErrorResponse;
			if (!body.ok) throw new Error(body.error.message);
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
		void fetchTimeline();
	}, [fetchTimeline]);

	const visibleEntries = useMemo(() => data?.entries ?? [], [data]);

	if (loading) {
		return (
			<div
				data-testid="consolidation-view-loading"
				style={{ padding: 24, color: "var(--fg-muted)" }}
			>
				加载中 · loading consolidation timeline…
			</div>
		);
	}
	if (error != null) {
		return (
			<div
				data-testid="consolidation-view-error"
				style={{ padding: 24, color: "var(--accent-vermillion)" }}
			>
				读取整合记录失败:{error}
				<button
					type="button"
					onClick={() => void fetchTimeline()}
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
	if (data == null || !data.available) {
		return (
			<div
				data-testid="consolidation-view-unavailable"
				style={{ padding: 24, color: "var(--fg-muted)", fontStyle: "italic" }}
			>
				{data?.reason ?? "整合记录不可用 · consolidation log unavailable"}
			</div>
		);
	}
	if (visibleEntries.length === 0) {
		return (
			<div data-testid="consolidation-view-empty" style={{ padding: 24, color: "var(--fg-muted)" }}>
				<p>还没有整合记录 · no consolidation events yet.</p>
				<p style={{ fontSize: 12, marginTop: 8 }}>
					等 consolidator 生成 proposal 后,这里会显示最近的 dry-run / 写入动作。
				</p>
			</div>
		);
	}

	return (
		<section data-testid="consolidation-view" style={{ marginTop: 4 }}>
			<div className="q-section-title">
				<span className="cn">整合时间线 · consolidation timeline</span>
				<span className="right">
					{visibleEntries.length}/{data.total} 条
				</span>
			</div>
			<div style={{ borderLeft: "1px solid var(--border)", marginLeft: 12 }}>
				{visibleEntries.map((entry) => {
					const expanded = expandedId === entry.id;
					return (
						<article
							key={entry.id}
							data-testid={`consolidation-entry-${entry.id}`}
							style={{
								position: "relative",
								padding: "0 0 14px 20px",
							}}
						>
							<span
								aria-hidden
								style={{
									position: "absolute",
									left: -5,
									top: 4,
									width: 9,
									height: 9,
									borderRadius: "50%",
									background: entry.dry_run ? "var(--fg-muted)" : "var(--accent-vermillion)",
									boxShadow: "0 0 0 3px var(--bg)",
								}}
							/>
							<button
								type="button"
								onClick={() => setExpandedId(expanded ? null : entry.id)}
								aria-expanded={expanded}
								style={{
									width: "100%",
									textAlign: "left",
									border: "1px solid var(--border)",
									background: expanded ? "var(--bg-elev)" : "transparent",
									color: "var(--fg)",
									borderRadius: 6,
									padding: "10px 12px",
									cursor: "pointer",
								}}
							>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 8,
										flexWrap: "wrap",
										fontSize: 12,
									}}
								>
									<strong style={{ fontFamily: '"Noto Sans SC", sans-serif' }}>
										{entry.task || "memory consolidation"}
									</strong>
									<span style={{ color: "var(--fg-muted)" }}>
										{entry.dry_run ? "dry-run" : "write"}
									</span>
									<span style={{ color: "var(--fg-muted)" }}>
										{decisionLabel(entry.budget_decision)}
									</span>
									<span style={{ marginLeft: "auto", color: "var(--fg-muted)" }}>
										{formatTimestamp(entry.created_at)}
									</span>
								</div>
								<div style={{ marginTop: 6, color: "var(--fg-muted)", fontSize: 11 }}>
									{actionSummary(entry.actions)} · writes={entry.writes_performed}
								</div>
								{expanded ? (
									<pre
										style={{
											marginTop: 10,
											padding: "8px 10px",
											border: "1px solid var(--border)",
											borderRadius: 4,
											color: "var(--fg-muted)",
											fontFamily: '"JetBrains Mono", monospace',
											fontSize: 10,
											lineHeight: 1.5,
											whiteSpace: "pre-wrap",
											wordBreak: "break-word",
										}}
									>
										{JSON.stringify(entry.actions, null, 2)}
									</pre>
								) : null}
							</button>
						</article>
					);
				})}
			</div>
		</section>
	);
}
