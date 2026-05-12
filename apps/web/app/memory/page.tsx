"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

export default function MemoryPage() {
	const [memory, setMemory] = useState<MemoryResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("");
	const [tierFilter, setTierFilter] = useState<string>("all");
	const [expandedId, setExpandedId] = useState<string | null>(null);

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
					</div>

					{loading && memory == null ? (
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
											return (
												<button
													key={record.id}
													type="button"
													onClick={() => setExpandedId(expanded ? null : record.id)}
													className="q-resource-row"
													data-testid={`memory-${record.id}`}
													style={{
														textAlign: "left",
														width: "100%",
														background: expanded ? "var(--bg-elev)" : "transparent",
														border: "none",
														borderBottom: "1px solid var(--border)",
														cursor: "pointer",
														padding: "10px 12px",
														display: "block",
													}}
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
											);
										})}
									</div>
								))
							)}
						</>
					)}
				</section>
			</main>
		</>
	);
}
