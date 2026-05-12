"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { formatDuration } from "@/lib/format";
import type { AgentSummary } from "@/lib/schemas";

export interface AgentSwitcherProps {
	readonly agents: readonly AgentSummary[];
	readonly currentAgentId: string | null;
	readonly onSelect?: (agentId: string) => void;
	readonly onSpawn?: () => void;
}

function statusGlyph(status: AgentSummary["status"]): string {
	switch (status) {
		case "running":
			return "▪";
		case "completed":
			return "▢";
		case "blocked":
		case "failed":
			return "✕";
		case "pending":
			return "○";
		case "cancelled":
			return "—";
		default:
			return "●";
	}
}

function rowStatusClass(agent: AgentSummary): string {
	if (agent.kind === "main") return "s-main";
	switch (agent.status) {
		case "running":
		case "pending":
			return "s-running";
		case "completed":
			return "s-done";
		case "blocked":
		case "failed":
			return "s-blocked";
		default:
			return "";
	}
}

/**
 * Popover that opens above the composer-context badge. Lists all running /
 * recent agents (matches demo lines 1116–1156). Clicking a row swaps the
 * active conversation context via `onSelect`.
 */
export function AgentSwitcher({ agents, currentAgentId, onSelect, onSpawn }: AgentSwitcherProps) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDocClick = (event: MouseEvent) => {
			if (!wrapRef.current) return;
			if (!wrapRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [open]);

	const onToggle = useCallback(() => setOpen((prev) => !prev), []);

	const currentLabel =
		currentAgentId && currentAgentId !== "main" ? `子代理 · ${currentAgentId}` : "主代理";

	return (
		<div className="q-agent-switcher" ref={wrapRef}>
			<button
				type="button"
				className="q-composer-context"
				data-active={open ? "true" : "false"}
				onClick={onToggle}
				aria-haspopup="listbox"
				aria-expanded={open}
				data-testid="agent-switcher-toggle"
			>
				{currentLabel}
			</button>
			<div
				className="q-agent-popover"
				data-open={open ? "true" : "false"}
				role="listbox"
				aria-label="代理切换 · subagents"
			>
				<div className="q-popover-head">
					<span className="q-popover-title">代理切换 · subagents</span>
					<span className="q-popover-meta">{agents.length} active</span>
				</div>
				{agents.map((agent) => {
					const active = agent.id === currentAgentId;
					return (
						<button
							type="button"
							key={agent.id}
							className={`q-agent-row ${rowStatusClass(agent)}${active ? " active" : ""}`}
							data-agent={agent.id}
							onClick={() => {
								onSelect?.(agent.id);
								setOpen(false);
							}}
							role="option"
							aria-selected={active}
						>
							<span className="agent-status">{statusGlyph(agent.status)}</span>
							<span className="agent-name">
								{agent.id}
								{agent.task ? <span className="agent-task">{agent.task}</span> : null}
							</span>
							<span className="agent-time">{formatDuration(agent.elapsedMs)}</span>
						</button>
					);
				})}
				{onSpawn ? (
					<div
						style={{
							marginTop: 6,
							padding: "10px 16px 4px",
							borderTop: "1px solid var(--border)",
						}}
					>
						<button
							type="button"
							onClick={onSpawn}
							style={{
								background: "none",
								border: "none",
								cursor: "pointer",
								padding: 0,
								fontFamily: '"Noto Sans SC", sans-serif',
								fontSize: 12,
								color: "var(--accent-vermillion)",
								letterSpacing: "0.02em",
							}}
						>
							＋ 派遣新子代理
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}
