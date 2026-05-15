"use client";

import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";

interface ServerToolSummary {
	readonly publicName: string;
	readonly originalName: string;
	readonly description: string;
}

interface McpServerView {
	readonly id: string;
	readonly transport: "stdio" | "http";
	readonly configured: {
		readonly command?: string;
		readonly args?: readonly string[];
		readonly cwd?: string;
		readonly url?: string;
		readonly hasHeaders: boolean;
	};
	readonly status: "connected" | "failed" | "skipped";
	readonly toolCount: number;
	readonly error: string | null;
	readonly tools: readonly ServerToolSummary[];
}

interface McpResponse {
	readonly ok: true;
	readonly data: {
		readonly servers: readonly McpServerView[];
		readonly counts: {
			readonly total: number;
			readonly connected: number;
			readonly failed: number;
			readonly skipped: number;
			readonly totalTools: number;
		};
	};
}

interface McpError {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

function statusColor(status: McpServerView["status"]): string {
	if (status === "connected") return "var(--accent-vermillion)";
	if (status === "failed") return "var(--fg-muted)";
	return "var(--fg-muted)";
}

function statusLabel(status: McpServerView["status"]): string {
	if (status === "connected") return "✓ 已连接";
	if (status === "failed") return "✗ 失败";
	return "⊘ 跳过";
}

export default function McpPage() {
	const [catalog, setCatalog] = useState<McpResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const loadCatalog = useCallback(async (refresh = false) => {
		setLoading(true);
		setError(null);
		try {
			// `refresh=true` flag tears down active MCP stdio subprocesses
			// and respawns them, so newly-added `@server.tool` decorators in
			// MCP servers take effect without restarting the dev server.
			// First load (mount) skips the flag — just reads the cached
			// catalog. The "↻ 重新加载" button passes refresh=true.
			const url = refresh ? "/api/mcp?refresh=1" : "/api/mcp";
			const res = await fetch(url, { cache: "no-store" });
			const json = (await res.json()) as McpResponse | McpError;
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

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="mcp-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							MCP Servers<span className="cjk">服务</span>
						</h1>
						<p className="q-page-subtitle">
							Model Context Protocol · 配置源 ~/.claude.json + Quilin 内置 providers
						</p>
						<div className="q-page-stats">
							{catalog == null ? null : (
								<>
									<span>
										<strong>{catalog.counts.total}</strong>个服务
									</span>
									<span style={{ color: "var(--accent-vermillion)" }}>
										<strong>{catalog.counts.connected}</strong>已连接
									</span>
									{catalog.counts.failed > 0 ? (
										<span>
											<strong>{catalog.counts.failed}</strong>失败
										</span>
									) : null}
									<span>
										<strong>{catalog.counts.totalTools}</strong>个工具
									</span>
								</>
							)}
							<button
								type="button"
								onClick={() => void loadCatalog(true)}
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
					) : catalog == null ? null : catalog.servers.length === 0 ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>
							还没有配置任何 MCP 服务器 · 在{" "}
							<code style={{ fontFamily: '"JetBrains Mono", monospace' }}>~/.claude.json</code> 里加
							mcpServers 字段
						</p>
					) : (
						<div style={{ marginTop: 20 }}>
							{catalog.servers.map((server) => {
								const expanded = expandedId === server.id;
								return (
									<div
										key={server.id}
										style={{
											borderBottom: "1px solid var(--border)",
											marginBottom: 8,
											paddingBottom: 8,
										}}
									>
										<button
											type="button"
											onClick={() => setExpandedId(expanded ? null : server.id)}
											className="q-resource-row"
											data-testid={`mcp-server-${server.id}`}
											style={{
												textAlign: "left",
												width: "100%",
												background: expanded ? "var(--bg-elev)" : "transparent",
												border: "none",
												cursor: "pointer",
												padding: "10px 12px",
												display: "block",
											}}
										>
											<div
												style={{
													display: "flex",
													gap: 12,
													alignItems: "baseline",
													flexWrap: "wrap",
												}}
											>
												<span
													style={{
														fontFamily: '"JetBrains Mono", monospace',
														fontSize: 13,
														color: "var(--fg)",
														fontWeight: 600,
														minWidth: 180,
													}}
												>
													{server.id}
												</span>
												<span
													style={{
														fontFamily: '"JetBrains Mono", monospace',
														fontSize: 10,
														color: "var(--fg-muted)",
														padding: "1px 6px",
														border: "1px solid var(--border)",
													}}
												>
													{server.transport}
												</span>
												<span
													style={{
														fontFamily: '"JetBrains Mono", monospace',
														fontSize: 11,
														color: statusColor(server.status),
													}}
												>
													{statusLabel(server.status)}
												</span>
												{server.status === "connected" ? (
													<span
														style={{
															fontSize: 11,
															color: "var(--fg-muted)",
														}}
													>
														{server.toolCount} 个工具
													</span>
												) : null}
											</div>
											{server.error != null ? (
												<div
													style={{
														marginTop: 6,
														padding: "6px 8px",
														fontFamily: '"JetBrains Mono", monospace',
														fontSize: 10,
														color: "var(--fg-muted)",
														background: "transparent",
														borderLeft: "2px solid var(--border)",
														wordBreak: "break-word",
													}}
												>
													{server.error}
												</div>
											) : null}
											{expanded ? (
												<div
													style={{
														marginTop: 10,
														padding: "8px 10px",
														border: "1px solid var(--border)",
														fontFamily: '"JetBrains Mono", monospace',
														fontSize: 10,
														color: "var(--fg-muted)",
														lineHeight: 1.7,
													}}
												>
													<div style={{ marginBottom: 8, opacity: 0.7 }}>configuration:</div>
													{server.configured.url != null ? (
														<div>
															<span style={{ color: "var(--fg)" }}>url:</span>{" "}
															{server.configured.url}
															{server.configured.hasHeaders ? " · headers: yes" : ""}
														</div>
													) : null}
													{server.configured.command != null ? (
														<div>
															<span style={{ color: "var(--fg)" }}>command:</span>{" "}
															{server.configured.command} {(server.configured.args ?? []).join(" ")}
														</div>
													) : null}
													{server.configured.cwd != null ? (
														<div>
															<span style={{ color: "var(--fg)" }}>cwd:</span>{" "}
															{server.configured.cwd}
														</div>
													) : null}
													{server.tools.length > 0 ? (
														<>
															<div style={{ marginTop: 10, marginBottom: 4, opacity: 0.7 }}>
																exposed tools:
															</div>
															{server.tools.map((tool) => (
																<div key={tool.publicName} style={{ marginBottom: 4 }}>
																	<span style={{ color: "var(--fg)" }}>{tool.originalName}</span>
																	{tool.publicName !== tool.originalName ? (
																		<span style={{ opacity: 0.5 }}>
																			{" → "}
																			{tool.publicName}
																		</span>
																	) : null}
																	<div style={{ paddingLeft: 16, opacity: 0.7 }}>
																		{tool.description}
																	</div>
																</div>
															))}
														</>
													) : null}
												</div>
											) : null}
										</button>
									</div>
								);
							})}
						</div>
					)}
				</section>
			</main>
		</>
	);
}
