"use client";

import type { ReactElement } from "react";
import { useCallback, useState } from "react";

/**
 * Shared MCP server card — used by /mcp (full detail with config +
 * exposed tools) and /tools (compact summary inside the connection
 * snapshot box). Centralizes the "↻ 重连" + "📋 复制错误" controls so
 * both pages stay in sync.
 *
 * Inputs are intentionally permissive so the same component renders
 * the full view (with `configured` + `tools`) and the compact view
 * (no `configured`, no `tools`).
 *
 * 复用的 MCP server 卡片组件:/mcp 渲染完整详情(配置 + 暴露工具),
 * /tools 渲染连接情况精简视图。重连和复制错误按钮在两处保持一致。
 */

export interface McpServerCardTool {
	readonly publicName: string;
	readonly originalName: string;
	readonly description: string;
}

export interface McpServerCardData {
	readonly id: string;
	readonly transport: "stdio" | "http";
	readonly status: "connected" | "failed" | "skipped";
	readonly toolCount: number;
	readonly error: string | null;
	readonly configured?: {
		readonly command?: string;
		readonly args?: readonly string[];
		readonly cwd?: string;
		readonly url?: string;
		readonly hasHeaders: boolean;
	};
	readonly tools?: readonly McpServerCardTool[];
}

export interface McpServerCardProps {
	readonly server: McpServerCardData;
	/**
	 * `full`: show configuration block + tool list when expanded (used
	 * by /mcp). `compact`: single-row summary with reconnect/copy
	 * buttons but no expand toggle (used by /tools status snapshot).
	 */
	readonly variant?: "full" | "compact";
	/**
	 * Fired after a successful reconnect so the parent page can refresh
	 * its catalog state. The card itself patches the rendered status
	 * locally for immediate feedback even before the refresh lands.
	 */
	readonly onReconnected?: () => void;
}

function statusColor(status: McpServerCardData["status"]): string {
	if (status === "connected") return "var(--accent-vermillion)";
	return "var(--fg-muted)";
}

function statusLabel(status: McpServerCardData["status"]): string {
	if (status === "connected") return "✓ 已连接";
	if (status === "failed") return "✗ 失败";
	return "⊘ 跳过";
}

interface ReconnectControlsProps {
	readonly server: McpServerCardData;
	readonly liveStatus: McpServerCardData["status"];
	readonly liveError: string | null;
	readonly busy: boolean;
	readonly copyState: "idle" | "copied" | "error";
	readonly onReconnect: () => void;
	readonly onCopyError: () => void;
}

function ReconnectControls({
	server,
	liveStatus,
	liveError,
	busy,
	copyState,
	onReconnect,
	onCopyError,
}: ReconnectControlsProps): ReactElement {
	return (
		<div
			style={{
				display: "flex",
				gap: 6,
				alignItems: "center",
				marginLeft: "auto",
				flexWrap: "wrap",
			}}
		>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onReconnect();
				}}
				disabled={busy}
				data-testid={`mcp-reconnect-${server.id}`}
				aria-label={`重连 ${server.id}`}
				style={{
					padding: "3px 8px",
					border: `1px solid ${
						liveStatus === "connected" ? "var(--border)" : "var(--accent-vermillion)"
					}`,
					color: liveStatus === "connected" ? "var(--fg-muted)" : "var(--accent-vermillion)",
					background: "transparent",
					fontFamily: '"JetBrains Mono", monospace',
					fontSize: 10,
					letterSpacing: "0.02em",
					cursor: busy ? "wait" : "pointer",
					opacity: busy ? 0.6 : 1,
				}}
			>
				{busy ? "重连中…" : "↻ 重连"}
			</button>
			{liveError != null ? (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onCopyError();
					}}
					data-testid={`mcp-copy-error-${server.id}`}
					aria-label={`复制 ${server.id} 错误信息`}
					style={{
						padding: "3px 8px",
						border: "1px solid var(--border)",
						color: "var(--fg-muted)",
						background: "transparent",
						fontFamily: '"JetBrains Mono", monospace',
						fontSize: 10,
						letterSpacing: "0.02em",
						cursor: "pointer",
					}}
				>
					{copyState === "copied"
						? "✓ 已复制"
						: copyState === "error"
							? "✗ 复制失败"
							: "📋 复制错误"}
				</button>
			) : null}
		</div>
	);
}

export function McpServerCard({
	server,
	variant = "full",
	onReconnected,
}: McpServerCardProps): ReactElement {
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [liveStatus, setLiveStatus] = useState<McpServerCardData["status"]>(server.status);
	const [liveError, setLiveError] = useState<string | null>(server.error);
	const [liveToolCount, setLiveToolCount] = useState<number>(server.toolCount);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

	const handleReconnect = useCallback(async () => {
		setBusy(true);
		try {
			const res = await fetch(`/api/mcp/${encodeURIComponent(server.id)}/reconnect`, {
				method: "POST",
				cache: "no-store",
			});
			const json = (await res.json()) as
				| {
						readonly ok: true;
						readonly data:
							| { readonly status: "connected"; readonly toolCount: number }
							| { readonly status: "failed"; readonly error: string };
				  }
				| {
						readonly ok: false;
						readonly error: { readonly code: string; readonly message: string };
				  };
			if (json.ok) {
				if (json.data.status === "connected") {
					setLiveStatus("connected");
					setLiveError(null);
					setLiveToolCount(json.data.toolCount);
				} else {
					setLiveStatus("failed");
					setLiveError(json.data.error);
					setLiveToolCount(0);
				}
				onReconnected?.();
			} else {
				setLiveStatus("failed");
				setLiveError(json.error.message);
			}
		} catch (e) {
			setLiveStatus("failed");
			setLiveError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [server.id, onReconnected]);

	const handleCopyError = useCallback(async () => {
		const text = liveError ?? "";
		if (text === "") return;
		try {
			// Clipboard API is async + permission-gated; fall back to a
			// hidden textarea + execCommand for older browsers / contexts
			// where `navigator.clipboard` is undefined (e.g. http://).
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText != null) {
				await navigator.clipboard.writeText(text);
			} else {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.left = "-9999px";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
			}
			setCopyState("copied");
			setTimeout(() => setCopyState("idle"), 1500);
		} catch {
			setCopyState("error");
			setTimeout(() => setCopyState("idle"), 1500);
		}
	}, [liveError]);

	if (variant === "compact") {
		return (
			<div
				data-testid={`mcp-server-compact-${server.id}`}
				style={{
					display: "flex",
					gap: 12,
					alignItems: "center",
					padding: "4px 0",
					flexWrap: "wrap",
				}}
			>
				<span style={{ minWidth: 160 }}>{server.id}</span>
				<span style={{ minWidth: 60 }}>{server.transport}</span>
				{liveError == null ? (
					<span style={{ color: "var(--accent-vermillion)" }}>✓ {liveToolCount} tools</span>
				) : (
					<span
						style={{ color: "var(--fg-muted)", flex: 1, minWidth: 200, wordBreak: "break-word" }}
					>
						✗ {liveError}
					</span>
				)}
				<ReconnectControls
					server={server}
					liveStatus={liveStatus}
					liveError={liveError}
					busy={busy}
					copyState={copyState}
					onReconnect={handleReconnect}
					onCopyError={handleCopyError}
				/>
			</div>
		);
	}

	return (
		<div
			style={{
				borderBottom: "1px solid var(--border)",
				marginBottom: 8,
				paddingBottom: 8,
			}}
		>
			<div
				data-testid={`mcp-server-${server.id}`}
				style={{
					textAlign: "left",
					width: "100%",
					background: expanded ? "var(--bg-elev)" : "transparent",
					padding: "10px 12px",
				}}
			>
				<button
					type="button"
					onClick={() => setExpanded((prev) => !prev)}
					data-testid={`mcp-server-toggle-${server.id}`}
					aria-expanded={expanded}
					aria-label={`展开 ${server.id} 详情`}
					style={{
						width: "100%",
						textAlign: "left",
						background: "transparent",
						border: "none",
						padding: 0,
						cursor: "pointer",
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
							color: statusColor(liveStatus),
						}}
					>
						{statusLabel(liveStatus)}
					</span>
					{liveStatus === "connected" ? (
						<span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{liveToolCount} 个工具</span>
					) : null}
					<ReconnectControls
						server={server}
						liveStatus={liveStatus}
						liveError={liveError}
						busy={busy}
						copyState={copyState}
						onReconnect={handleReconnect}
						onCopyError={handleCopyError}
					/>
				</button>
				{liveError != null ? (
					<div
						data-testid={`mcp-error-${server.id}`}
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
						{liveError}
					</div>
				) : null}
				<div
					style={{
						marginTop: 6,
						fontFamily: '"JetBrains Mono", monospace',
						fontSize: 10,
						color: "var(--fg-muted)",
						lineHeight: 1.5,
					}}
				>
					配置位于 <code style={{ color: "var(--fg)" }}>~/.claude.json</code> →{" "}
					<code style={{ color: "var(--fg)" }}>mcpServers.{server.id}</code>
					,改完点"↻ 重连"即可生效(无需重启 dev server)。
				</div>
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
						{server.configured?.url != null ? (
							<div>
								<span style={{ color: "var(--fg)" }}>url:</span> {server.configured.url}
								{server.configured.hasHeaders ? " · headers: yes" : ""}
							</div>
						) : null}
						{server.configured?.command != null ? (
							<div>
								<span style={{ color: "var(--fg)" }}>command:</span> {server.configured.command}{" "}
								{(server.configured.args ?? []).join(" ")}
							</div>
						) : null}
						{server.configured?.cwd != null ? (
							<div>
								<span style={{ color: "var(--fg)" }}>cwd:</span> {server.configured.cwd}
							</div>
						) : null}
						{server.tools != null && server.tools.length > 0 ? (
							<>
								<div style={{ marginTop: 10, marginBottom: 4, opacity: 0.7 }}>exposed tools:</div>
								{server.tools.map((tool) => (
									<div key={tool.publicName} style={{ marginBottom: 4 }}>
										<span style={{ color: "var(--fg)" }}>{tool.originalName}</span>
										{tool.publicName !== tool.originalName ? (
											<span style={{ opacity: 0.5 }}>
												{" → "}
												{tool.publicName}
											</span>
										) : null}
										<div style={{ paddingLeft: 16, opacity: 0.7 }}>{tool.description}</div>
									</div>
								))}
							</>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
