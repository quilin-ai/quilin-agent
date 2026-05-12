import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { ApiEnvelopeError, ApiHttpError, api } from "@/lib/api";
import type { MCPServer } from "@/lib/schemas";

export const dynamic = "force-dynamic";

async function loadMcp(): Promise<{
	readonly items: readonly MCPServer[];
	readonly error: string | null;
}> {
	try {
		return { items: await api.mcp(), error: null };
	} catch (error) {
		if (error instanceof ApiHttpError) {
			return { items: [], error: `控制面返回 HTTP ${error.status}` };
		}
		if (error instanceof ApiEnvelopeError) {
			return { items: [], error: `[${error.code}] ${error.message}` };
		}
		return {
			items: [],
			error: `无法加载 MCP · ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function statusChip(status: MCPServer["status"]): { className: string; label: string } {
	switch (status) {
		case "healthy":
			return { className: "on", label: "▢ healthy" };
		case "degraded":
			return { className: "off", label: "▪ degraded" };
		case "offline":
			return { className: "err", label: "✕ offline" };
	}
}

export default async function McpPage() {
	const { items, error } = await loadMcp();
	const totalTools = items.reduce((sum, s) => sum + s.toolsCount, 0);
	const totalCalls = items.reduce((sum, s) => sum + s.callsToday, 0);
	const online = items.filter((s) => s.status === "healthy").length;
	const avgLatency =
		items.length > 0
			? Math.round(items.reduce((sum, s) => sum + s.avgLatencyMs, 0) / items.length)
			: 0;
	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip pinned />
			<main className="q-workspace no-composer">
				<section className="q-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							MCP<span className="cjk">服务</span>
						</h1>
						<p className="q-page-subtitle">
							Model Context Protocol servers · stdio + http · 工具与资源的提供方
						</p>
						<div className="q-page-stats">
							<span>
								<strong>
									{online} / {items.length}
								</strong>
								online
							</span>
							<span>
								<strong>{totalTools}</strong>tools exposed
							</span>
							<span>
								<strong>{totalCalls}</strong>calls today
							</span>
							<span>
								<strong>{avgLatency}ms</strong>avg latency
							</span>
						</div>
					</div>

					{error ? (
						<div
							style={{
								padding: 16,
								border: "1px solid var(--destructive)",
								color: "var(--destructive)",
								fontFamily: '"JetBrains Mono", monospace',
								fontSize: 12,
								marginBottom: 24,
							}}
						>
							{error}
						</div>
					) : null}

					<div className="q-section-title">
						<span className="cn">已连接 · connected</span>
						<span className="right">click to inspect</span>
					</div>
					{items.map((server) => {
						const chip = statusChip(server.status);
						return (
							<div className="q-resource-row" key={server.name}>
								<span className="rn">
									{server.name}
									<span className="desc">
										{server.transport} · {server.toolsCount} tools · {server.callsToday} calls
									</span>
								</span>
								<span className="rm">{server.avgLatencyMs}ms avg</span>
								<span className={`rs ${chip.className}`}>{chip.label}</span>
							</div>
						);
					})}
				</section>
			</main>
		</>
	);
}
