"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { formatDuration } from "@/lib/format";

type LiveStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";

interface AgentUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

interface AgentSnapshot {
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
	task,
	parentSessionId,
}: SubagentLiveProgressProps) {
	const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
	const cancelledRef = useRef(false);

	useEffect(() => {
		cancelledRef.current = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const tick = async (): Promise<void> => {
			try {
				const res = await fetch(`/api/agents/${agentId}`, { cache: "no-store" });
				if (!res.ok || cancelledRef.current) return;
				const body = (await res.json()) as AgentDetailResponse;
				if (cancelledRef.current || !body.ok || body.data == null) return;
				const next: AgentSnapshot = {
					status: body.data.status,
					streamedText: body.data.streamedText,
					elapsedMs: body.data.elapsedMs,
					usage: body.data.usage ?? null,
				};
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
	}, [agentId]);

	const status = snapshot?.status ?? "pending";
	const badge = statusBadge(status);
	const text = snapshot?.streamedText ?? "";
	const elapsed = snapshot?.elapsedMs ?? 0;
	const usage = snapshot?.usage ?? null;
	const isLive = status === "running" || status === "pending";
	const detailHref = `/?session=${encodeURIComponent(agentId)}${
		parentSessionId != null ? `&from=${encodeURIComponent(parentSessionId)}` : ""
	}`;

	return (
		<section
			className="q-subagent-live"
			data-agent-id={agentId}
			data-status={status}
			style={{
				marginTop: 8,
				marginBottom: 8,
				padding: "8px 12px",
				border: "1px solid var(--border)",
				borderLeft: `3px solid ${badge.tone}`,
				background: "var(--bg-elev-1, transparent)",
				fontSize: 12,
			}}
		>
			<header
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: text.length > 0 ? 6 : 0,
					fontFamily: '"JetBrains Mono", monospace',
					fontSize: 11,
					letterSpacing: "0.04em",
					color: "var(--fg-muted)",
					flexWrap: "wrap",
				}}
			>
				<span style={{ color: badge.tone }}>
					{isLive ? "▪" : status === "completed" ? "▢" : "✕"}
				</span>
				<Link
					href={detailHref}
					style={{
						color: "var(--fg)",
						textDecoration: "none",
						fontWeight: 500,
					}}
					data-testid={`subagent-live-link-${agentId}`}
				>
					{agentId}
				</Link>
				<span style={{ color: badge.tone }}>{badge.label}</span>
				<span style={{ marginLeft: "auto" }}>{formatDuration(elapsed)}</span>
				{usage != null && usage.totalTokens > 0 ? (
					<span
						title={`输入 · in ${usage.inputTokens} / 输出 · out ${usage.outputTokens}`}
						data-testid={`subagent-tokens-${agentId}`}
					>
						{usage.totalTokens} tok
					</span>
				) : null}
			</header>
			<div
				style={{
					fontFamily: '"Noto Sans SC", sans-serif',
					color: "var(--fg-muted)",
					fontSize: 11,
					marginBottom: text.length > 0 ? 6 : 0,
				}}
			>
				任务 · task：{task}
			</div>
			{text.length > 0 ? (
				<div
					className="q-md"
					style={{
						margin: 0,
						maxHeight: 240,
						overflow: "auto",
						fontFamily: '"Noto Sans SC", sans-serif',
						fontSize: 12,
						lineHeight: 1.55,
						color: "var(--fg)",
					}}
				>
					<Streamdown
						mode={isLive ? "streaming" : "static"}
						parseIncompleteMarkdown
						controls={{ table: false, code: false, mermaid: false }}
					>
						{text}
					</Streamdown>
					{isLive ? <span className="q-stream-cursor" /> : null}
				</div>
			) : null}
		</section>
	);
}
