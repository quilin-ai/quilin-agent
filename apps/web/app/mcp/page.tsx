"use client";

import { useCallback, useEffect, useState } from "react";

import { McpServerCard, type McpServerCardData } from "@/components/McpServerCard";
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
		// Lazy snapshot state (SC-3 + audit #1 漏项 fix, QUI-182):
		// /api/mcp returns the last successful snapshot immediately and
		// kicks off a background warm. UI must consume these flags to tell
		// the user "data may be stale, refreshing now" instead of showing
		// stale numbers silently.
		readonly refreshing: boolean;
		readonly stale: boolean;
		readonly refreshedAt: string | null;
		readonly refreshError: string | null;
	};
}

interface McpError {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

function toCardData(server: McpServerView): McpServerCardData {
	return {
		id: server.id,
		transport: server.transport,
		status: server.status,
		toolCount: server.toolCount,
		error: server.error,
		configured: server.configured,
		tools: server.tools,
	};
}

export default function McpPage() {
	const [catalog, setCatalog] = useState<McpResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

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
									{catalog.refreshing ? (
										<span
											style={{ color: "var(--accent-blue, #2b6cb0)", fontStyle: "italic" }}
											title="后端 lazy snapshot 正在后台刷新,稍后会自动显示最新数据"
										>
											↻ 正在后台刷新…
										</span>
									) : null}
									{catalog.refreshError ? (
										<span
											style={{ color: "var(--accent-vermillion)" }}
											title={catalog.refreshError}
										>
											⚠ 刷新出错(hover 查看)
										</span>
									) : null}
									{catalog.stale && !catalog.refreshing ? (
										<span
											style={{ color: "var(--fg-muted)", fontStyle: "italic" }}
											title={
												catalog.refreshedAt
													? `数据上次刷新: ${catalog.refreshedAt}`
													: "数据可能过时"
											}
										>
											数据可能过时
										</span>
									) : null}
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
							{catalog.servers.map((server) => (
								<McpServerCard
									key={server.id}
									server={toCardData(server)}
									variant="full"
									onReconnected={() => void loadCatalog(false)}
								/>
							))}
						</div>
					)}
				</section>
			</main>
		</>
	);
}
