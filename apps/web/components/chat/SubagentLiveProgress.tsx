"use client";

import Link from "next/link";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { deriveAgentDisplayName } from "@/lib/agent-display-name";
import { formatDuration } from "@/lib/format";

type LiveStatus =
	| "pending"
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "cancelled"
	// Round 4 LOW fix — distinct state when /api/agents/[id] 404s
	// (registry evicted or server restarted). Previously this rendered
	// as "completed · 0ms" which misled users into thinking the run
	// actually finished. Now surfaces as "快照丢失 · snapshot lost".
	| "snapshot_lost";

interface AgentUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

interface AgentSnapshot {
	readonly displayName?: string | null;
	readonly task?: string | null;
	readonly status: LiveStatus;
	readonly streamedText: string;
	readonly elapsedMs: number;
	readonly usage: AgentUsage | null;
}

interface AgentDetailResponse {
	readonly ok: boolean;
	readonly data?: AgentSnapshot;
}

export interface SubagentLiveProgressProps {
	readonly agentId: string;
	readonly displayName?: string;
	readonly task: string;
	readonly parentSessionId?: string;
}

const POLL_INTERVAL_MS = 1000;

function statusBadge(status: LiveStatus): { label: string; tone: string } {
	switch (status) {
		case "running":
		case "pending":
			return { label: "运行中 · running", tone: "var(--accent-vermillion)" };
		case "completed":
			return { label: "已完成 · completed", tone: "var(--fg-muted)" };
		case "failed":
			return { label: "失败 · failed", tone: "var(--accent-vermillion)" };
		case "blocked":
			return { label: "等待 · blocked", tone: "var(--fg-muted)" };
		case "cancelled":
			return { label: "已取消 · cancelled", tone: "var(--fg-muted)" };
		case "snapshot_lost":
			return { label: "快照丢失 · snapshot lost", tone: "var(--fg-subtle)" };
		default:
			return { label: status, tone: "var(--fg-muted)" };
	}
}

/**
 * Inline live-status panel rendered next to a `spawn_subagent` tool call.
 * Polls `/api/agents/[id]` every second until the subagent reaches a
 * terminal status, then keeps the last snapshot visible so the user can
 * still see the result after the parent message finishes streaming.
 *
 * 行内子代理实时进度面板：在 `spawn_subagent` 工具调用旁渲染。每秒
 * 轮询 `/api/agents/[id]` 直到终止状态，之后保留最后快照让用户在主消息
 * 流式结束后仍能看到。
 */
export function SubagentLiveProgress({
	agentId,
	displayName,
	task,
	parentSessionId,
}: SubagentLiveProgressProps) {
	const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
	const [detailAvailable, setDetailAvailable] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const cancelledRef = useRef(false);
	const previewRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		cancelledRef.current = false;
		setDetailAvailable(false);
		let timer: ReturnType<typeof setTimeout> | null = null;

		const tick = async (): Promise<void> => {
			try {
				const res = await fetch(`/api/agents/${agentId}`, { cache: "no-store" });
				if (cancelledRef.current) return;
				if (res.status === 404) {
					// Registry doesn't have a live snapshot — either the
					// subagent finished and its session evicted, or the
					// server-side AgentService restarted. Display a
					// distinct "snapshot lost" state instead of pretending
					// the run completed normally. Round 4 LOW finding —
					// previous code marked status="completed" with 0ms,
					// misleading the user.
					setExpanded(false);
					setDetailAvailable(false);
					setSnapshot({
						displayName,
						task,
						status: "snapshot_lost",
						streamedText: "",
						elapsedMs: 0,
						usage: null,
					});
					return;
				}
				if (!res.ok) {
					// Non-404 server error (5xx). One retry after backoff;
					// previous behaviour silently stopped polling. Round 4
					// RECOMMEND #1 from cross-review.
					if (!cancelledRef.current) {
						timer = setTimeout(() => void tick(), POLL_INTERVAL_MS * 2);
					}
					return;
				}
				const body = (await res.json()) as AgentDetailResponse;
				if (cancelledRef.current) return;
				if (!body.ok || body.data == null) {
					setDetailAvailable(false);
					return;
				}
				const next: AgentSnapshot = {
					displayName: body.data.displayName,
					task: body.data.task,
					status: body.data.status,
					streamedText: body.data.streamedText,
					elapsedMs: body.data.elapsedMs,
					usage: body.data.usage ?? null,
				};
				if (next.status !== "running" && next.status !== "pending") {
					setExpanded(false);
				}
				setDetailAvailable(true);
				setSnapshot(next);
				if (next.status === "running" || next.status === "pending") {
					timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
				}
			} catch {
				/* ignore transient errors; retry on next tick */
				if (!cancelledRef.current) {
					timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
				}
			}
		};

		void tick();
		return () => {
			cancelledRef.current = true;
			if (timer != null) clearTimeout(timer);
		};
	}, [agentId, displayName, task]);

	const status = snapshot?.status ?? "pending";
	const badge = statusBadge(status);
	const text = snapshot?.streamedText ?? "";
	const liveTask = snapshot?.task ?? task;
	const label =
		snapshot?.displayName?.trim() || displayName?.trim() || deriveAgentDisplayName(liveTask);
	const elapsed = snapshot?.elapsedMs ?? 0;
	const usage = snapshot?.usage ?? null;
	const isLive = status === "running" || status === "pending";
	const detailHref = `/?session=${encodeURIComponent(agentId)}${
		parentSessionId != null ? `&from=${encodeURIComponent(parentSessionId)}` : ""
	}`;
	const preview = text.length > 0 ? text : liveTask;
	const showPreview = preview.length > 0 && (isLive || expanded);

	useEffect(() => {
		if (!isLive || expanded || preview.length === 0) return;
		const requestFrame =
			window.requestAnimationFrame ??
			((cb: FrameRequestCallback): number => window.setTimeout(() => cb(Date.now()), 0));
		const cancelFrame = window.cancelAnimationFrame ?? window.clearTimeout;
		const frame = requestFrame(() => {
			const el = previewRef.current;
			if (el == null) return;
			el.scrollTop = el.scrollHeight;
		});
		return () => cancelFrame(frame);
	}, [expanded, isLive, preview]);

	return (
		<section
			className="q-subagent-live"
			data-agent-id={agentId}
			data-status={status}
			data-expanded={expanded ? "true" : "false"}
			style={{ "--q-subagent-tone": badge.tone } as CSSProperties}
		>
			<header className="q-subagent-live-head">
				<span className="q-subagent-live-mark">
					{isLive ? "▪" : status === "completed" ? "▢" : "✕"}
				</span>
				{detailAvailable ? (
					<Link
						href={detailHref}
						className="q-subagent-live-title"
						data-testid={`subagent-live-link-${agentId}`}
						title={agentId}
					>
						{label}
					</Link>
				) : (
					<span
						className="q-subagent-live-title"
						data-testid={`subagent-live-title-${agentId}`}
						title={`${agentId} · detail unavailable`}
					>
						{label}
					</span>
				)}
				<span className="q-subagent-live-status">{badge.label}</span>
				<span className="q-subagent-live-elapsed">{formatDuration(elapsed)}</span>
				{usage != null && usage.totalTokens > 0 ? (
					<span
						title={`输入 · in ${usage.inputTokens} / 输出 · out ${usage.outputTokens}`}
						data-testid={`subagent-tokens-${agentId}`}
						className="q-subagent-live-tokens"
					>
						{usage.totalTokens} tok
					</span>
				) : null}
				<div className="q-subagent-live-actions">
					<button
						type="button"
						className="q-subagent-live-action"
						onClick={() => setExpanded((prev) => !prev)}
						aria-expanded={expanded}
					>
						{expanded ? "收起" : "展开"}
					</button>
					{detailAvailable ? (
						<Link className="q-subagent-live-action" href={detailHref} title={agentId}>
							详情
						</Link>
					) : null}
				</div>
			</header>
			{showPreview ? (
				<div
					ref={previewRef}
					className="q-subagent-live-preview q-md"
					data-has-output={text.length > 0 ? "true" : "false"}
					data-tail-scroll={isLive && !expanded ? "true" : "false"}
				>
					<Streamdown
						mode={isLive ? "streaming" : "static"}
						parseIncompleteMarkdown
						controls={{ table: false, code: false, mermaid: false }}
					>
						{preview}
					</Streamdown>
					{isLive ? <span className="q-stream-cursor" /> : null}
				</div>
			) : null}
		</section>
	);
}
