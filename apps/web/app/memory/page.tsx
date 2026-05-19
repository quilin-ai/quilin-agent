"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ConsolidationTimelineView } from "@/components/memory/ConsolidationTimelineView";
import { KnowledgeGraphView } from "@/components/memory/KnowledgeGraphView";
import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";

interface MemoryRecord {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly layer: string | null;
	readonly createdAt: string | null;
	readonly metadata: Record<string, unknown> | null;
}

interface MemoryResponse {
	readonly ok: true;
	readonly data: {
		readonly available: boolean;
		readonly reason?: string;
		readonly records: readonly MemoryRecord[];
		readonly byTier: Record<string, readonly MemoryRecord[]>;
		readonly counts: Record<string, number>;
		readonly rawSamplePreview?: string;
	};
}

interface MemoryError {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

const TIER_ORDER: readonly string[] = ["working", "episodic", "semantic", "skill"];

const TIER_LABELS: Record<string, { readonly cn: string; readonly en: string }> = {
	working: { cn: "工作", en: "working" },
	episodic: { cn: "情景", en: "episodic" },
	semantic: { cn: "语义", en: "semantic" },
	skill: { cn: "技能", en: "skill" },
};

function formatTimestamp(iso: string | null): string {
	if (iso == null) return "—";
	try {
		const d = new Date(iso);
		return d.toLocaleString("zh-CN", { hour12: false });
	} catch {
		return iso;
	}
}

interface DedupeGroupPreview {
	readonly tier: string;
	readonly content: string;
	readonly keepId: string;
	readonly deleteIds: readonly string[];
}

interface DedupePreview {
	readonly groups: readonly DedupeGroupPreview[];
	readonly totalDelete: number;
	readonly totalKeep: number;
}

interface DedupeResponse {
	readonly ok: true;
	readonly data: {
		readonly executed: boolean;
		readonly plan: DedupePreview;
		readonly totalDelete?: number;
		readonly totalKeep?: number;
		readonly deleted?: number;
		readonly failed?: number;
	};
}

interface DedupeErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

interface BatchDeleteResponse {
	readonly ok: true;
	readonly data: {
		readonly requested: number;
		readonly deleted: number;
		readonly failed: number;
	};
}

interface BatchDeleteErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

export default function MemoryPage() {
	const [memory, setMemory] = useState<MemoryResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("");
	const [tierFilter, setTierFilter] = useState<string>("all");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [view, setView] = useState<"list" | "graph" | "timeline">("list");
	// Selection lives outside the records loop so it survives re-renders;
	// using a Set gives us O(1) membership checks for the checkbox state.
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [actionMessage, setActionMessage] = useState<string | null>(null);
	const [dedupePreview, setDedupePreview] = useState<DedupePreview | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const loadMemory = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/memory", { cache: "no-store" });
			const json = (await res.json()) as MemoryResponse | MemoryError;
			if (!json.ok) {
				setError(json.error.message);
				setMemory(null);
			} else {
				setMemory(json.data);
				// Drop any stale selections that referred to records that
				// no longer exist after the reload.
				setSelectedIds((prev) => {
					if (prev.size === 0) return prev;
					const idSet = new Set(json.data.records.map((r) => r.id));
					const next = new Set<string>();
					for (const id of prev) if (idSet.has(id)) next.add(id);
					return next;
				});
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadMemory();
	}, [loadMemory]);

	const visibleTiers = useMemo(() => {
		if (memory == null) return [];
		const keys = Object.keys(memory.byTier);
		return keys.sort((a, b) => {
			const ia = TIER_ORDER.indexOf(a);
			const ib = TIER_ORDER.indexOf(b);
			if (ia === -1 && ib === -1) return a.localeCompare(b);
			if (ia === -1) return 1;
			if (ib === -1) return -1;
			return ia - ib;
		});
	}, [memory]);

	const visibleRecords = useMemo(() => {
		if (memory == null) return new Map<string, MemoryRecord[]>();
		const needle = filter.trim().toLowerCase();
		const out = new Map<string, MemoryRecord[]>();
		for (const tier of visibleTiers) {
			if (tierFilter !== "all" && tier !== tierFilter) continue;
			const all = memory.byTier[tier] ?? [];
			const filtered =
				needle.length === 0
					? [...all]
					: all.filter((r) => r.content.toLowerCase().includes(needle));
			if (filtered.length > 0) out.set(tier, filtered);
		}
		return out;
	}, [memory, visibleTiers, filter, tierFilter]);

	const visibleIds = useMemo(() => {
		const ids: string[] = [];
		for (const records of visibleRecords.values()) {
			for (const r of records) ids.push(r.id);
		}
		return ids;
	}, [visibleRecords]);

	const allVisibleSelected = useMemo(() => {
		if (visibleIds.length === 0) return false;
		return visibleIds.every((id) => selectedIds.has(id));
	}, [visibleIds, selectedIds]);

	const toggleSelection = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const clearSelection = useCallback(() => {
		setSelectedIds(new Set());
	}, []);

	const selectAllVisible = useCallback(() => {
		setSelectedIds((prev) => {
			// If everything visible is already selected, clear them; otherwise
			// extend the selection to include every visible id.
			if (visibleIds.length === 0) return prev;
			const allSelected = visibleIds.every((id) => prev.has(id));
			if (allSelected) {
				const next = new Set(prev);
				for (const id of visibleIds) next.delete(id);
				return next;
			}
			const next = new Set(prev);
			for (const id of visibleIds) next.add(id);
			return next;
		});
	}, [visibleIds]);

	const handleBatchDelete = useCallback(async () => {
		if (selectedIds.size === 0) return;
		setPendingAction("delete");
		setActionMessage(null);
		try {
			const ids = Array.from(selectedIds);
			const res = await fetch(`/api/memory?ids=${encodeURIComponent(ids.join(","))}`, {
				method: "DELETE",
				cache: "no-store",
			});
			const json = (await res.json()) as BatchDeleteResponse | BatchDeleteErrorResponse;
			if (!json.ok) {
				setActionMessage(`删除失败 · ${json.error.message}`);
			} else {
				setActionMessage(
					`已删除 ${json.data.deleted} 条${json.data.failed > 0 ? ` · 失败 ${json.data.failed} 条` : ""}`,
				);
				setSelectedIds(new Set());
				setConfirmDelete(false);
				await loadMemory();
			}
		} catch (e) {
			setActionMessage(`删除失败 · ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setPendingAction(null);
		}
	}, [selectedIds, loadMemory]);

	const handleDedupePreview = useCallback(async () => {
		setPendingAction("dedupe-preview");
		setActionMessage(null);
		try {
			const res = await fetch("/api/memory/dedupe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ execute: false }),
				cache: "no-store",
			});
			const json = (await res.json()) as DedupeResponse | DedupeErrorResponse;
			if (!json.ok) {
				setActionMessage(`去重预览失败 · ${json.error.message}`);
				setDedupePreview(null);
			} else {
				setDedupePreview(json.data.plan);
			}
		} catch (e) {
			setActionMessage(`去重预览失败 · ${e instanceof Error ? e.message : String(e)}`);
			setDedupePreview(null);
		} finally {
			setPendingAction(null);
		}
	}, []);

	const handleDedupeExecute = useCallback(async () => {
		setPendingAction("dedupe-execute");
		setActionMessage(null);
		try {
			const res = await fetch("/api/memory/dedupe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ execute: true }),
				cache: "no-store",
			});
			const json = (await res.json()) as DedupeResponse | DedupeErrorResponse;
			if (!json.ok) {
				setActionMessage(`去重失败 · ${json.error.message}`);
			} else {
				setActionMessage(
					`去重完成 · 删除 ${json.data.deleted ?? 0} 条${
						(json.data.failed ?? 0) > 0 ? ` · 失败 ${json.data.failed} 条` : ""
					}`,
				);
				setDedupePreview(null);
				setSelectedIds(new Set());
				await loadMemory();
			}
		} catch (e) {
			setActionMessage(`去重失败 · ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setPendingAction(null);
		}
	}, [loadMemory]);

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="memory-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Memory<span className="cjk">记忆</span>
						</h1>
						<p className="q-page-subtitle">
							通过 quilin-mem MCP 拉取的全部记忆 · 按层级分组(工作 / 情景 / 语义 / 技能)
						</p>
						<div className="q-page-stats">
							{memory == null ? null : memory.available ? (
								<>
									<span>
										<strong>{memory.counts.total ?? 0}</strong>条记忆
									</span>
									{visibleTiers.map((tier) => (
										<span key={tier}>
											<strong>{memory.counts[tier] ?? 0}</strong>
											{TIER_LABELS[tier]?.cn ?? tier}
										</span>
									))}
								</>
							) : (
								<span style={{ color: "var(--fg-muted)" }}>quilin-mem 未连接</span>
							)}
							<button
								type="button"
								onClick={() => void loadMemory()}
								style={{
									marginLeft: "auto",
									padding: "5px 10px",
									border: "1px solid var(--accent-vermillion)",
									color: "var(--accent-vermillion)",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 11,
									letterSpacing: "0.02em",
									background: "transparent",
									cursor: "pointer",
								}}
							>
								↻ 刷新
							</button>
						</div>

						<div
							style={{
								display: "flex",
								gap: 4,
								marginTop: 12,
								borderBottom: "1px solid var(--border)",
							}}
							role="tablist"
							aria-label="Memory view"
						>
							<button
								type="button"
								role="tab"
								aria-selected={view === "list"}
								data-testid="memory-tab-list"
								onClick={() => setView("list")}
								style={{
									padding: "8px 16px",
									background: "transparent",
									border: "none",
									borderBottom:
										view === "list"
											? "2px solid var(--accent-vermillion)"
											: "2px solid transparent",
									color: view === "list" ? "var(--fg)" : "var(--fg-muted)",
									cursor: "pointer",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 13,
								}}
							>
								列表 · list
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={view === "graph"}
								data-testid="memory-tab-graph"
								onClick={() => setView("graph")}
								style={{
									padding: "8px 16px",
									background: "transparent",
									border: "none",
									borderBottom:
										view === "graph"
											? "2px solid var(--accent-vermillion)"
											: "2px solid transparent",
									color: view === "graph" ? "var(--fg)" : "var(--fg-muted)",
									cursor: "pointer",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 13,
								}}
							>
								知识图谱 · graph
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={view === "timeline"}
								data-testid="memory-tab-timeline"
								onClick={() => setView("timeline")}
								style={{
									padding: "8px 16px",
									background: "transparent",
									border: "none",
									borderBottom:
										view === "timeline"
											? "2px solid var(--accent-vermillion)"
											: "2px solid transparent",
									color: view === "timeline" ? "var(--fg)" : "var(--fg-muted)",
									cursor: "pointer",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 13,
								}}
							>
								整合时间线 · timeline
							</button>
						</div>
					</div>

					{view === "graph" ? (
						<div style={{ marginTop: 20 }}>
							<KnowledgeGraphView />
						</div>
					) : view === "timeline" ? (
						<div style={{ marginTop: 20 }}>
							<ConsolidationTimelineView />
						</div>
					) : loading && memory == null ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>加载中 · loading…</p>
					) : error != null ? (
						<p style={{ color: "var(--accent-vermillion)", marginTop: 24 }}>加载失败 · {error}</p>
					) : memory == null ? null : !memory.available ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>{memory.reason}</p>
					) : memory.records.length === 0 ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>
							还没有任何记忆条目 · agent 写入后会显示在这里
						</p>
					) : (
						<>
							<div
								style={{
									display: "flex",
									gap: 8,
									alignItems: "center",
									marginTop: 20,
									marginBottom: 12,
									flexWrap: "wrap",
								}}
							>
								<input
									type="text"
									placeholder="筛选 · filter by content…"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									data-testid="memory-filter"
									style={{
										flex: 1,
										minWidth: 240,
										padding: "6px 10px",
										border: "1px solid var(--border)",
										background: "transparent",
										color: "var(--fg)",
										fontFamily: '"JetBrains Mono", monospace',
										fontSize: 12,
									}}
								/>
								<button
									type="button"
									onClick={() => setTierFilter("all")}
									style={{
										padding: "5px 10px",
										border: `1px solid ${tierFilter === "all" ? "var(--accent-vermillion)" : "var(--border)"}`,
										color: tierFilter === "all" ? "var(--accent-vermillion)" : "var(--fg-muted)",
										background: "transparent",
										fontFamily: '"JetBrains Mono", monospace',
										fontSize: 11,
										cursor: "pointer",
									}}
								>
									全部
									<span style={{ marginLeft: 6, opacity: 0.6 }}>{memory.counts.total ?? 0}</span>
								</button>
								{visibleTiers.map((tier) => {
									const active = tierFilter === tier;
									return (
										<button
											key={tier}
											type="button"
											onClick={() => setTierFilter(tier)}
											style={{
												padding: "5px 10px",
												border: `1px solid ${active ? "var(--accent-vermillion)" : "var(--border)"}`,
												color: active ? "var(--accent-vermillion)" : "var(--fg-muted)",
												background: "transparent",
												fontFamily: '"JetBrains Mono", monospace',
												fontSize: 11,
												cursor: "pointer",
											}}
										>
											{TIER_LABELS[tier]?.cn ?? tier}
											<span style={{ marginLeft: 6, opacity: 0.6 }}>
												{memory.counts[tier] ?? 0}
											</span>
										</button>
									);
								})}
							</div>

							{/* Sticky action bar — shows up the moment the user picks
								anything, so they don't have to hunt for a button after
								selecting. Keeps the affordance discoverable without
								eating header space when nothing's selected. */}
							{selectedIds.size > 0 ? (
								<div
									data-testid="memory-action-bar"
									style={{
										position: "sticky",
										top: 0,
										zIndex: 10,
										background: "var(--bg-elev)",
										border: "1px solid var(--accent-vermillion)",
										padding: "8px 12px",
										marginBottom: 12,
										display: "flex",
										gap: 8,
										alignItems: "center",
										flexWrap: "wrap",
									}}
								>
									<span
										style={{
											fontFamily: '"Noto Sans SC", sans-serif',
											fontSize: 12,
											color: "var(--fg)",
										}}
									>
										已选 <strong data-testid="memory-selected-count">{selectedIds.size}</strong> 条
									</span>
									<button
										type="button"
										onClick={() => setConfirmDelete(true)}
										disabled={pendingAction != null}
										data-testid="memory-batch-delete"
										style={{
											padding: "5px 10px",
											border: "1px solid var(--accent-vermillion)",
											background: "var(--accent-vermillion)",
											color: "var(--bg)",
											fontFamily: '"Noto Sans SC", sans-serif',
											fontSize: 11,
											cursor: pendingAction != null ? "not-allowed" : "pointer",
											opacity: pendingAction != null ? 0.6 : 1,
										}}
									>
										删除选中
									</button>
									<button
										type="button"
										onClick={clearSelection}
										disabled={pendingAction != null}
										data-testid="memory-clear-selection"
										style={{
											padding: "5px 10px",
											border: "1px solid var(--border)",
											background: "transparent",
											color: "var(--fg-muted)",
											fontFamily: '"Noto Sans SC", sans-serif',
											fontSize: 11,
											cursor: pendingAction != null ? "not-allowed" : "pointer",
										}}
									>
										取消选中
									</button>
								</div>
							) : null}

							{/* Selection / dedupe toolbar lives below the filter row so
								it's always discoverable, not just after selection. */}
							<div
								style={{
									display: "flex",
									gap: 8,
									alignItems: "center",
									marginBottom: 12,
									flexWrap: "wrap",
								}}
							>
								<label
									style={{
										display: "inline-flex",
										gap: 6,
										alignItems: "center",
										fontFamily: '"JetBrains Mono", monospace',
										fontSize: 11,
										color: "var(--fg-muted)",
										cursor: visibleIds.length === 0 ? "not-allowed" : "pointer",
									}}
								>
									<input
										type="checkbox"
										checked={allVisibleSelected}
										onChange={selectAllVisible}
										disabled={visibleIds.length === 0 || pendingAction != null}
										data-testid="memory-select-all"
									/>
									全选当前
								</label>
								<button
									type="button"
									onClick={() => void handleDedupePreview()}
									disabled={pendingAction != null || memory == null}
									data-testid="memory-dedupe-button"
									style={{
										padding: "5px 10px",
										border: "1px solid var(--accent-vermillion)",
										background: "transparent",
										color: "var(--accent-vermillion)",
										fontFamily: '"Noto Sans SC", sans-serif',
										fontSize: 11,
										cursor: pendingAction != null ? "not-allowed" : "pointer",
										opacity: pendingAction != null ? 0.6 : 1,
									}}
								>
									一键去重
								</button>
								{actionMessage != null ? (
									<span
										data-testid="memory-action-message"
										style={{
											fontFamily: '"JetBrains Mono", monospace',
											fontSize: 11,
											color: "var(--fg-muted)",
										}}
									>
										{actionMessage}
									</span>
								) : null}
							</div>

							{visibleRecords.size === 0 ? (
								<p style={{ color: "var(--fg-muted)", marginTop: 16 }}>
									没有匹配的记忆 · no matches
								</p>
							) : (
								Array.from(visibleRecords.entries()).map(([tier, records]) => (
									<div key={tier} style={{ marginBottom: 18 }}>
										<div className="q-section-title">
											<span className="cn">
												{TIER_LABELS[tier]?.cn ?? tier} · {TIER_LABELS[tier]?.en ?? tier}
											</span>
											<span className="right">{records.length} 条</span>
										</div>
										{records.map((record) => {
											const expanded = expandedId === record.id;
											const contentToShow =
												!expanded && record.content.length > 220
													? `${record.content.slice(0, 220)}…`
													: record.content;
											const checked = selectedIds.has(record.id);
											return (
												<div
													key={record.id}
													data-testid={`memory-${record.id}`}
													className="q-resource-row"
													style={{
														background: expanded ? "var(--bg-elev)" : "transparent",
														borderBottom: "1px solid var(--border)",
														padding: "10px 12px",
														display: "flex",
														gap: 10,
														alignItems: "flex-start",
													}}
												>
													<input
														type="checkbox"
														checked={checked}
														onChange={(e) => {
															e.stopPropagation();
															toggleSelection(record.id);
														}}
														onClick={(e) => e.stopPropagation()}
														data-testid={`memory-checkbox-${record.id}`}
														aria-label={`选中 ${record.id.slice(0, 8)}`}
														style={{ marginTop: 2, flexShrink: 0 }}
													/>
													<button
														type="button"
														onClick={() => setExpandedId(expanded ? null : record.id)}
														style={{
															flex: 1,
															textAlign: "left",
															background: "transparent",
															border: "none",
															padding: 0,
															cursor: "pointer",
															display: "block",
														}}
														aria-expanded={expanded}
														aria-label={`查看记忆 ${record.id.slice(0, 8)}`}
													>
														<div
															style={{
																whiteSpace: "pre-wrap",
																color: "var(--fg)",
																fontSize: 12,
																lineHeight: 1.6,
															}}
														>
															{contentToShow}
														</div>
														<div
															style={{
																marginTop: 6,
																fontFamily: '"JetBrains Mono", monospace',
																fontSize: 10,
																color: "var(--fg-muted)",
															}}
														>
															{formatTimestamp(record.createdAt)} · id={record.id.slice(0, 8)}
														</div>
														{expanded && record.metadata != null ? (
															<pre
																style={{
																	marginTop: 8,
																	padding: "6px 8px",
																	border: "1px solid var(--border)",
																	fontFamily: '"JetBrains Mono", monospace',
																	fontSize: 10,
																	color: "var(--fg-muted)",
																	lineHeight: 1.5,
																	whiteSpace: "pre-wrap",
																	wordBreak: "break-word",
																}}
															>
																{JSON.stringify(record.metadata, null, 2)}
															</pre>
														) : null}
													</button>
												</div>
											);
										})}
									</div>
								))
							)}

							{confirmDelete ? (
								<div
									data-testid="memory-confirm-delete"
									role="dialog"
									aria-modal="true"
									aria-label="确认删除选中记忆"
									style={{
										position: "fixed",
										inset: 0,
										background: "rgba(0,0,0,0.5)",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										zIndex: 100,
									}}
								>
									<div
										style={{
											background: "var(--bg)",
											border: "1px solid var(--accent-vermillion)",
											padding: "20px 24px",
											maxWidth: 480,
											minWidth: 320,
										}}
									>
										<h2
											style={{
												margin: 0,
												marginBottom: 12,
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 16,
												color: "var(--fg)",
											}}
										>
											确认删除
										</h2>
										<p
											style={{
												color: "var(--fg-muted)",
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 13,
												lineHeight: 1.6,
											}}
										>
											将永久删除 <strong>{selectedIds.size}</strong> 条记忆, 此操作不可撤销。
										</p>
										<div
											style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}
										>
											<button
												type="button"
												onClick={() => setConfirmDelete(false)}
												disabled={pendingAction != null}
												data-testid="memory-confirm-delete-cancel"
												style={{
													padding: "6px 12px",
													border: "1px solid var(--border)",
													background: "transparent",
													color: "var(--fg-muted)",
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
													cursor: "pointer",
												}}
											>
												取消
											</button>
											<button
												type="button"
												onClick={() => void handleBatchDelete()}
												disabled={pendingAction != null}
												data-testid="memory-confirm-delete-confirm"
												style={{
													padding: "6px 12px",
													border: "1px solid var(--accent-vermillion)",
													background: "var(--accent-vermillion)",
													color: "var(--bg)",
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
													cursor: "pointer",
												}}
											>
												{pendingAction === "delete" ? "删除中…" : "确认删除"}
											</button>
										</div>
									</div>
								</div>
							) : null}

							{dedupePreview != null ? (
								<div
									data-testid="memory-dedupe-preview"
									role="dialog"
									aria-modal="true"
									aria-label="去重预览"
									style={{
										position: "fixed",
										inset: 0,
										background: "rgba(0,0,0,0.5)",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										zIndex: 100,
									}}
								>
									<div
										style={{
											background: "var(--bg)",
											border: "1px solid var(--accent-vermillion)",
											padding: "20px 24px",
											maxWidth: 640,
											minWidth: 360,
											maxHeight: "80vh",
											overflowY: "auto",
										}}
									>
										<h2
											style={{
												margin: 0,
												marginBottom: 12,
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 16,
												color: "var(--fg)",
											}}
										>
											去重预览
										</h2>
										<p
											style={{
												color: "var(--fg-muted)",
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 13,
												lineHeight: 1.6,
											}}
										>
											按精确字符串匹配将删除{" "}
											<strong data-testid="memory-dedupe-delete-count">
												{dedupePreview.totalDelete}
											</strong>{" "}
											条, 保留{" "}
											<strong data-testid="memory-dedupe-keep-count">
												{dedupePreview.totalKeep}
											</strong>{" "}
											条 (每组保留最早一条)。
										</p>
										{dedupePreview.groups.length === 0 ? (
											<p
												style={{
													color: "var(--fg-muted)",
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
												}}
											>
												没有发现完全重复的条目。
											</p>
										) : (
											<ul
												style={{
													listStyle: "none",
													padding: 0,
													margin: "12px 0",
													maxHeight: 320,
													overflowY: "auto",
												}}
											>
												{dedupePreview.groups.slice(0, 20).map((group) => (
													<li
														key={`${group.tier}::${group.keepId}`}
														style={{
															padding: "6px 0",
															borderBottom: "1px solid var(--border)",
															fontSize: 11,
															color: "var(--fg-muted)",
															fontFamily: '"JetBrains Mono", monospace',
														}}
													>
														<div style={{ color: "var(--fg)", marginBottom: 2 }}>
															{group.content.length > 80
																? `${group.content.slice(0, 80)}…`
																: group.content}
														</div>
														<div>
															tier={group.tier} · 删除 {group.deleteIds.length} 条 · 保留{" "}
															{group.keepId.slice(0, 8)}
														</div>
													</li>
												))}
												{dedupePreview.groups.length > 20 ? (
													<li
														style={{
															padding: "6px 0",
															fontSize: 11,
															color: "var(--fg-muted)",
														}}
													>
														…还有 {dedupePreview.groups.length - 20} 组未显示
													</li>
												) : null}
											</ul>
										)}
										<div
											style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}
										>
											<button
												type="button"
												onClick={() => setDedupePreview(null)}
												disabled={pendingAction != null}
												data-testid="memory-dedupe-cancel"
												style={{
													padding: "6px 12px",
													border: "1px solid var(--border)",
													background: "transparent",
													color: "var(--fg-muted)",
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
													cursor: "pointer",
												}}
											>
												取消
											</button>
											<button
												type="button"
												onClick={() => void handleDedupeExecute()}
												disabled={pendingAction != null || dedupePreview.totalDelete === 0}
												data-testid="memory-dedupe-confirm"
												style={{
													padding: "6px 12px",
													border: "1px solid var(--accent-vermillion)",
													background: "var(--accent-vermillion)",
													color: "var(--bg)",
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
													cursor:
														pendingAction != null || dedupePreview.totalDelete === 0
															? "not-allowed"
															: "pointer",
													opacity:
														pendingAction != null || dedupePreview.totalDelete === 0 ? 0.5 : 1,
												}}
											>
												{pendingAction === "dedupe-execute" ? "去重中…" : "确认去重"}
											</button>
										</div>
									</div>
								</div>
							) : null}
						</>
					)}
				</section>
			</main>
		</>
	);
}
