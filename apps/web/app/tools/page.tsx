"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { McpServerCard, type McpServerCardData } from "@/components/McpServerCard";
import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";

interface ToolEntry {
	readonly publicName: string;
	readonly originalName: string;
	readonly description: string;
	readonly source: "builtin" | "inline" | "mcp";
	readonly mcpServer: string | null;
	readonly inputShape: Record<string, string> | null;
}

interface ToolsResponse {
	readonly ok: true;
	readonly data: {
		readonly tools: readonly ToolEntry[];
		readonly counts: {
			readonly total: number;
			readonly builtin: number;
			readonly inline: number;
			readonly mcp: number;
		};
		readonly byMcpServer: Record<string, number>;
		readonly mcpServerStatus: ReadonlyArray<{
			readonly id: string;
			readonly transport: "stdio" | "http";
			readonly toolCount: number;
			readonly error: string | null;
		}>;
	};
}

interface ToolsError {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

type SourceFilter = "all" | "builtin" | "inline" | "mcp";

export default function ToolsPage() {
	const [catalog, setCatalog] = useState<ToolsResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("");
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
	const [expandedName, setExpandedName] = useState<string | null>(null);

	const loadCatalog = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/tools", { cache: "no-store" });
			const json = (await res.json()) as ToolsResponse | ToolsError;
			if (!json.ok) {
				setError(json.error.message);
				setCatalog(null);
			} else {
				setCatalog(json.data);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadCatalog();
	}, [loadCatalog]);

	const visibleTools = useMemo(() => {
		if (catalog == null) return [];
		const needle = filter.trim().toLowerCase();
		return catalog.tools.filter((t) => {
			if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
			if (needle.length === 0) return true;
			return (
				t.publicName.toLowerCase().includes(needle) ||
				t.originalName.toLowerCase().includes(needle) ||
				t.description.toLowerCase().includes(needle) ||
				(t.mcpServer?.toLowerCase().includes(needle) ?? false)
			);
		});
	}, [catalog, filter, sourceFilter]);

	const groupedTools = useMemo(() => {
		const groups: Record<string, ToolEntry[]> = {};
		for (const t of visibleTools) {
			const key = t.source === "mcp" ? `mcp:${t.mcpServer ?? "(unknown)"}` : t.source;
			if (groups[key] == null) groups[key] = [];
			groups[key].push(t);
		}
		return groups;
	}, [visibleTools]);

	const sortedGroupKeys = useMemo(() => {
		const keys = Object.keys(groupedTools);
		const priority: Record<string, number> = { builtin: 0, inline: 1 };
		return keys.sort((a, b) => {
			const pa = priority[a] ?? 100;
			const pb = priority[b] ?? 100;
			if (pa !== pb) return pa - pb;
			return a.localeCompare(b);
		});
	}, [groupedTools]);

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="tools-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Tools<span className="cjk">工具</span>
						</h1>
						<p className="q-page-subtitle">
							当前 Agent 进程实际加载的全部工具 · Builtin / Inline / MCP namespace
						</p>
						<div className="q-page-stats">
							{catalog == null ? null : (
								<>
									<span>
										<strong>{catalog.counts.total}</strong>个工具
									</span>
									<span>
										<strong>{catalog.counts.builtin}</strong>内置
									</span>
									{catalog.counts.inline > 0 ? (
										<span>
											<strong>{catalog.counts.inline}</strong>web-only
										</span>
									) : null}
									<span>
										<strong>{catalog.counts.mcp}</strong>MCP
									</span>
								</>
							)}
							<button
								type="button"
								onClick={() => void loadCatalog()}
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
								↻ 重新加载
							</button>
						</div>
					</div>

					{loading && catalog == null ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>加载中 · loading…</p>
					) : error != null ? (
						<p style={{ color: "var(--accent-vermillion)", marginTop: 24 }}>加载失败 · {error}</p>
					) : catalog == null ? null : (
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
									placeholder="筛选 · filter by name, description, server…"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									data-testid="tools-filter"
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
								{(["all", "builtin", "inline", "mcp"] as const).map((src) => {
									const active = sourceFilter === src;
									const count =
										src === "all"
											? catalog.counts.total
											: src === "builtin"
												? catalog.counts.builtin
												: src === "inline"
													? catalog.counts.inline
													: catalog.counts.mcp;
									if (src !== "all" && count === 0) return null;
									return (
										<button
											key={src}
											type="button"
											onClick={() => setSourceFilter(src)}
											style={{
												padding: "5px 10px",
												border: `1px solid ${active ? "var(--accent-vermillion)" : "var(--border)"}`,
												color: active ? "var(--accent-vermillion)" : "var(--fg-muted)",
												background: "transparent",
												fontFamily: '"JetBrains Mono", monospace',
												fontSize: 11,
												letterSpacing: "0.04em",
												cursor: "pointer",
											}}
										>
											{src === "all"
												? "全部"
												: src === "builtin"
													? "内置"
													: src === "inline"
														? "Web only"
														: "MCP"}
											<span style={{ marginLeft: 6, opacity: 0.6 }}>{count}</span>
										</button>
									);
								})}
							</div>

							{catalog.mcpServerStatus.length > 0 ? (
								<div
									data-testid="tools-mcp-status"
									style={{
										marginTop: 8,
										marginBottom: 16,
										padding: "8px 12px",
										border: "1px solid var(--border)",
										fontSize: 11,
										fontFamily: '"JetBrains Mono", monospace',
										color: "var(--fg-muted)",
									}}
								>
									<div style={{ marginBottom: 4 }}>
										MCP 服务器连接情况(失败的不会出现在工具列表里):
									</div>
									{catalog.mcpServerStatus.map((s) => {
										const cardData: McpServerCardData = {
											id: s.id,
											transport: s.transport,
											status: s.error == null ? "connected" : "failed",
											toolCount: s.toolCount,
											error: s.error,
										};
										return (
											<McpServerCard
												key={s.id}
												server={cardData}
												variant="compact"
												onReconnected={() => void loadCatalog()}
											/>
										);
									})}
								</div>
							) : null}

							<div>
								{visibleTools.length === 0 ? (
									<p style={{ color: "var(--fg-muted)", marginTop: 16 }}>
										没有匹配的工具 · no matches
									</p>
								) : (
									sortedGroupKeys.map((groupKey) => (
										<div key={groupKey} style={{ marginBottom: 18 }}>
											<div className="q-section-title">
												<span className="cn">
													{groupKey === "builtin"
														? "内置 · builtin"
														: groupKey === "inline"
															? "Web Only · inline"
															: groupKey}
												</span>
												<span className="right">{groupedTools[groupKey]?.length ?? 0} tools</span>
											</div>
											{(groupedTools[groupKey] ?? []).map((tool) => {
												const expanded = expandedName === tool.publicName;
												return (
													<button
														key={tool.publicName}
														type="button"
														onClick={() => setExpandedName(expanded ? null : tool.publicName)}
														className="q-resource-row"
														data-testid={`tool-${tool.publicName}`}
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
																display: "flex",
																gap: 10,
																alignItems: "baseline",
																flexWrap: "wrap",
															}}
														>
															<span
																style={{
																	fontFamily: '"JetBrains Mono", monospace',
																	fontSize: 12,
																	color: "var(--fg)",
																	fontWeight: 600,
																}}
															>
																{tool.publicName}
															</span>
															{tool.originalName !== tool.publicName ? (
																<span
																	style={{
																		fontFamily: '"JetBrains Mono", monospace',
																		fontSize: 10,
																		color: "var(--fg-muted)",
																	}}
																>
																	({tool.originalName})
																</span>
															) : null}
															<span
																style={{
																	flex: 1,
																	color: "var(--fg-muted)",
																	fontSize: 11,
																	lineHeight: 1.5,
																}}
															>
																{tool.description}
															</span>
														</div>
														{expanded && tool.inputShape != null ? (
															<div
																style={{
																	marginTop: 8,
																	padding: "8px 10px",
																	background: "transparent",
																	border: "1px solid var(--border)",
																	fontFamily: '"JetBrains Mono", monospace',
																	fontSize: 10,
																	color: "var(--fg-muted)",
																	lineHeight: 1.7,
																}}
															>
																<div style={{ marginBottom: 4, opacity: 0.7 }}>
																	input schema (sniffed from Zod):
																</div>
																{Object.entries(tool.inputShape).map(([k, v]) => (
																	<div key={k}>
																		<span style={{ color: "var(--fg)" }}>{k}</span>: {v}
																	</div>
																))}
															</div>
														) : null}
														{expanded && tool.inputShape == null ? (
															<div
																style={{
																	marginTop: 6,
																	fontFamily: '"JetBrains Mono", monospace',
																	fontSize: 10,
																	color: "var(--fg-muted)",
																}}
															>
																没有可探测的 input schema (非 ZodObject 根)。
															</div>
														) : null}
													</button>
												);
											})}
										</div>
									))
								)}
							</div>
						</>
					)}
				</section>
			</main>
		</>
	);
}
