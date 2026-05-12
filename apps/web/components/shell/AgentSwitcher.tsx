"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { formatDuration } from "@/lib/format";
import type { AgentSummary } from "@/lib/schemas";

export interface AgentSwitcherProps {
	readonly agents?: readonly AgentSummary[];
	readonly currentAgentId: string | null;
	/**
	 * When provided, the switcher only shows subagents whose `parentId`
	 * matches this id (plus the main agent). Used to scope the popover to
	 * the current chat session and avoid leaking subagents from earlier
	 * conversations on the same dev-server instance.
	 */
	readonly sessionId?: string;
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

interface AgentsApiResponse {
	readonly ok: boolean;
	readonly data?: { readonly items: readonly AgentSummary[] };
}

/**
 * Popover anchored above the composer-context badge.
 *
 * Self-fetches `/api/agents` every 2s when mounted so the trigger badge always
 * reflects live state (number of running subagents). Includes an inline
 * "+ 派遣新子代理" affordance that POSTs `/api/agents/spawn`.
 */
export function AgentSwitcher({
	agents: agentsProp,
	currentAgentId,
	sessionId,
	onSelect,
}: AgentSwitcherProps) {
	const [open, setOpen] = useState(false);
	const [fetched, setFetched] = useState<readonly AgentSummary[]>([]);
	const [spawnInputOpen, setSpawnInputOpen] = useState(false);
	const [spawnTask, setSpawnTask] = useState("");
	const [spawning, setSpawning] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	// Poll /api/agents every 2s. When a sessionId is provided, fetch the
	// session-filtered list (`?parent=<sessionId>`) so the popover only shows
	// subagents that belong to the current chat session.
	useEffect(() => {
		let cancelled = false;
		const url =
			sessionId != null && sessionId.length > 0
				? `/api/agents?parent=${encodeURIComponent(sessionId)}`
				: "/api/agents";
		async function refresh(): Promise<void> {
			try {
				const res = await fetch(url, { cache: "no-store" });
				if (!res.ok) return;
				const body = (await res.json()) as AgentsApiResponse;
				if (cancelled) return;
				if (body.ok && body.data?.items) setFetched(body.data.items);
			} catch {
				// ignore transient errors
			}
		}
		void refresh();
		const interval = setInterval(refresh, 2000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [sessionId]);

	useEffect(() => {
		if (!open) return;
		const onDocClick = (event: MouseEvent) => {
			if (!wrapRef.current) return;
			if (!wrapRef.current.contains(event.target as Node)) {
				setOpen(false);
				setSpawnInputOpen(false);
			}
		};
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [open]);

	const onToggle = useCallback(() => setOpen((prev) => !prev), []);

	const rawAgents = fetched.length > 0 ? fetched : (agentsProp ?? []);
	// Visibility policy for the switcher:
	//   - Main agent: always shown.
	//   - Running / pending subagents: always shown.
	//   - Currently selected subagent: shown even after it finishes so the
	//     user isn't yanked out of view.
	//   - Terminal (completed / failed / cancelled / blocked) subagents:
	//     shown for `RECENT_TERMINAL_WINDOW_MS` after `lastHeartbeatAt`, then
	//     hidden — they remain in the registry and can be reached directly
	//     via `/?session=<subagent-id>` for drill-in.
	const RECENT_TERMINAL_WINDOW_MS = 60_000;
	const now = Date.now();
	const isTerminal = (s: AgentSummary["status"]): boolean =>
		s === "completed" || s === "failed" || s === "cancelled" || s === "blocked";
	const isFresh = (a: AgentSummary): boolean => {
		const ts = a.lastHeartbeatAt ?? a.startedAt;
		const last = ts ? new Date(ts).getTime() : now;
		return now - last < RECENT_TERMINAL_WINDOW_MS;
	};
	const agents = rawAgents.filter((a) => {
		if (a.kind === "main") return true;
		if (a.id === currentAgentId) return true;
		if (!isTerminal(a.status)) return true; // running / pending
		return isFresh(a); // recently-finished terminal
	});
	const activeSubagentCount = agents.filter(
		(a) => a.kind !== "main" && (a.status === "running" || a.status === "pending"),
	).length;
	const totalSubagentCount = agents.filter((a) => a.kind !== "main").length;

	const currentLabel =
		currentAgentId && currentAgentId !== "main" ? `子代理 · ${currentAgentId}` : "主代理";

	const doSpawn = useCallback(async () => {
		const trimmed = spawnTask.trim();
		if (trimmed.length === 0 || spawning) return;
		setSpawning(true);
		try {
			const res = await fetch("/api/agents/spawn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ task: trimmed }),
			});
			// drain the stream in background so server can mark agent completed
			if (res.body) {
				const reader = res.body.getReader();
				void (async () => {
					while (!(await reader.read()).done) {
						/* discard */
					}
				})();
			}
			setSpawnTask("");
			setSpawnInputOpen(false);
		} catch {
			/* ignore */
		} finally {
			setSpawning(false);
		}
	}, [spawnTask, spawning]);

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
				{activeSubagentCount > 0 ? (
					<span
						style={{
							marginLeft: 6,
							padding: "1px 5px",
							border: "1px solid currentColor",
							borderRadius: 8,
							fontSize: 9,
							lineHeight: "1.4",
							fontFamily: '"JetBrains Mono", monospace',
							letterSpacing: "0.04em",
						}}
						data-testid="agent-count-badge"
					>
						+{activeSubagentCount}
					</span>
				) : null}
			</button>
			<div
				className="q-agent-popover"
				data-open={open ? "true" : "false"}
				role="listbox"
				aria-label="代理切换 · subagents"
			>
				<div className="q-popover-head">
					<span className="q-popover-title">代理切换 · subagents</span>
					<span className="q-popover-meta">
						{activeSubagentCount} active · {totalSubagentCount} total
					</span>
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
				<div
					style={{
						marginTop: 6,
						padding: "10px 16px 4px",
						borderTop: "1px solid var(--border)",
					}}
				>
					{!spawnInputOpen ? (
						<button
							type="button"
							onClick={() => setSpawnInputOpen(true)}
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
							data-testid="spawn-open"
						>
							＋ 派遣新子代理
						</button>
					) : (
						<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
							<input
								type="text"
								value={spawnTask}
								onChange={(e) => setSpawnTask(e.target.value)}
								placeholder="子代理任务描述…"
								disabled={spawning}
								onKeyDown={(e) => {
									if (e.nativeEvent.isComposing || e.keyCode === 229) return;
									if (e.key === "Enter") void doSpawn();
									if (e.key === "Escape") {
										setSpawnInputOpen(false);
										setSpawnTask("");
									}
								}}
								style={{
									flex: 1,
									background: "transparent",
									border: "1px solid var(--border)",
									color: "var(--fg)",
									fontSize: 12,
									padding: "4px 8px",
									outline: "none",
								}}
								data-testid="spawn-input"
								aria-label="子代理任务"
							/>
							<button
								type="button"
								onClick={() => void doSpawn()}
								disabled={spawning || spawnTask.trim().length === 0}
								style={{
									background: "none",
									border: "none",
									cursor: "pointer",
									padding: 0,
									fontSize: 11,
									color: "var(--accent-vermillion)",
									fontFamily: '"JetBrains Mono", monospace',
									letterSpacing: "0.06em",
								}}
								data-testid="spawn-confirm"
							>
								{spawning ? "…" : "↵"}
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
