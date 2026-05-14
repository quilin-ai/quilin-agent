"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Streamdown } from "streamdown";

import { Process } from "@/components/conversation/Process";
import {
	ToolCall,
	type ToolCallKind,
	type ToolCallStatus,
} from "@/components/conversation/ToolCall";
import { Composer } from "@/components/shell/Composer";
import { deriveAgentDisplayName } from "@/lib/agent-display-name";
import { formatDuration } from "@/lib/format";
import type { AgentStatus } from "@/lib/schemas";

interface ToolEvent {
	readonly kind: "call" | "result" | "error";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: string;
	readonly at: string;
}

interface MergedToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: string;
	readonly status: ToolCallStatus;
}

function mergeToolEvents(events: readonly ToolEvent[]): MergedToolCall[] {
	const byId = new Map<string, MergedToolCall>();
	for (const ev of events) {
		const prev = byId.get(ev.toolCallId);
		const base = prev ?? {
			toolCallId: ev.toolCallId,
			toolName: ev.toolName,
			status: "pending" as ToolCallStatus,
		};
		if (ev.kind === "call") {
			byId.set(ev.toolCallId, { ...base, input: ev.input });
		} else if (ev.kind === "result") {
			byId.set(ev.toolCallId, { ...base, output: ev.output, status: "done" });
		} else {
			byId.set(ev.toolCallId, { ...base, error: ev.error, status: "error" });
		}
	}
	return [...byId.values()];
}

function toolKindOf(name: string): ToolCallKind {
	if (name.includes("subagent")) return "subagent";
	if (name.includes("memory") || name.includes("mem")) return "memory";
	if (name.includes("mcp")) return "mcp";
	return "tool";
}

interface AgentDetail {
	readonly id: string;
	readonly kind: "main" | "subagent";
	readonly parentId: string | null;
	readonly displayName?: string | null;
	readonly task: string | null;
	readonly status: AgentStatus;
	readonly startedAt: string;
	readonly lastHeartbeatAt: string | null;
	readonly elapsedMs: number;
	readonly streamedText: string;
	readonly toolEvents?: readonly ToolEvent[];
}

interface AgentDetailResponse {
	readonly ok: boolean;
	readonly data?: AgentDetail;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface SubagentDetailViewProps {
	readonly agentId: string;
	readonly parentSessionId?: string;
}

function statusLabel(status: AgentStatus): string {
	switch (status) {
		case "running":
			return "运行中 · running";
		case "pending":
			return "等待中 · pending";
		case "completed":
			return "已完成 · completed";
		case "blocked":
			return "阻塞 · blocked";
		case "failed":
			return "失败 · failed";
		case "cancelled":
			return "已取消 · cancelled";
		default:
			return status;
	}
}

export function SubagentDetailView({ agentId, parentSessionId }: SubagentDetailViewProps) {
	const router = useRouter();
	const [detail, setDetail] = useState<AgentDetail | null>(null);
	const [notFound, setNotFound] = useState(false);

	useEffect(() => {
		let cancelled = false;
		async function refresh(): Promise<void> {
			try {
				const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
					cache: "no-store",
				});
				if (cancelled) return;
				if (res.status === 404) {
					setNotFound(true);
					return;
				}
				if (!res.ok) return;
				const body = (await res.json()) as AgentDetailResponse;
				if (cancelled) return;
				if (body.ok && body.data) {
					setNotFound(false);
					setDetail(body.data);
				}
			} catch {
				// ignore transient errors
			}
		}
		void refresh();
		const interval = setInterval(refresh, 1500);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [agentId]);

	const onSelectAgent = useCallback(
		(id: string) => {
			const effectiveParentId = parentSessionId ?? detail?.parentId ?? null;
			if (id === "main") {
				if (effectiveParentId) {
					router.push(`/?session=${encodeURIComponent(effectiveParentId)}`);
				} else {
					router.push("/");
				}
				return;
			}
			if (id === agentId) return;
			const suffix = effectiveParentId ? `&from=${encodeURIComponent(effectiveParentId)}` : "";
			router.push(`/?session=${encodeURIComponent(id)}${suffix}`);
		},
		[router, parentSessionId, detail?.parentId, agentId],
	);

	const isStreaming = detail?.status === "running" || detail?.status === "pending";
	const displayName =
		detail?.displayName?.trim() ||
		(detail ? deriveAgentDisplayName(detail.task) : deriveAgentDisplayName(null));

	return (
		<main className="q-workspace">
			<section className="q-view" data-testid="subagent-view">
				<div className="q-page-head" style={{ marginBottom: 16 }}>
					<h1 className="q-page-title">
						子代理 · subagent
						<span
							className="cjk"
							style={{ marginLeft: 8, fontFamily: '"JetBrains Mono", monospace' }}
						>
							{displayName}
						</span>
					</h1>
					{notFound ? (
						<p className="q-page-subtitle">未找到该子代理 · agent not found (可能已重启或被回收)</p>
					) : detail ? (
						<>
							<p className="q-page-subtitle">{detail.task ?? "无任务描述 · no task description"}</p>
							<div className="q-page-stats">
								<span data-testid="subagent-status">
									<strong>{statusLabel(detail.status)}</strong>
								</span>
								<span>
									已运行 <strong>{formatDuration(detail.elapsedMs)}</strong>
								</span>
								{detail.parentId ? (
									<span>
										父代理 <strong>{detail.parentId}</strong>
									</span>
								) : null}
								<span title={agentId}>
									id <strong>{agentId}</strong>
								</span>
							</div>
						</>
					) : (
						<p className="q-page-subtitle">加载中 · loading…</p>
					)}
				</div>

				{detail && !notFound ? (
					<article className="q-turn" data-role="assistant" data-testid="subagent-stream">
						<div className="q-turn-label">
							<span>{displayName}</span>
							<span className="dot">·</span>
							<span className="cjk-tag">subagent</span>
						</div>
						<div className="q-turn-body">
							{(detail.toolEvents?.length ?? 0) > 0 ? (
								<Process
									title="过程 · process"
									autoScrollKey={`${detail.status}:${detail.toolEvents?.length ?? 0}`}
									defaultOpen={isStreaming}
									status={isStreaming ? "running" : "done"}
								>
									{mergeToolEvents(detail.toolEvents ?? []).map((t) => (
										<ToolCall
											key={t.toolCallId}
											name={t.toolName}
											kind={toolKindOf(t.toolName)}
											status={t.status}
											defaultOpen={isStreaming && t.status !== "done"}
										>
											<div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
												{t.input !== undefined ? (
													<div style={{ marginBottom: 6 }}>
														<div style={{ color: "var(--fg-muted)" }}>input</div>
														<pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
															{JSON.stringify(t.input, null, 2)}
														</pre>
													</div>
												) : null}
												{t.output !== undefined ? (
													<div>
														<div style={{ color: "var(--fg-muted)" }}>output</div>
														<pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
															{JSON.stringify(t.output, null, 2)}
														</pre>
													</div>
												) : null}
												{t.error ? (
													<div style={{ color: "var(--accent-vermillion)" }}>{t.error}</div>
												) : null}
											</div>
										</ToolCall>
									))}
								</Process>
							) : null}
							{detail.streamedText.length > 0 ? (
								<div className="q-md">
									<Streamdown
										mode={isStreaming ? "streaming" : "static"}
										parseIncompleteMarkdown
										controls={{ table: false, code: false, mermaid: false }}
									>
										{detail.streamedText}
									</Streamdown>
									{isStreaming ? <span className="q-stream-cursor" /> : null}
								</div>
							) : (
								<p style={{ whiteSpace: "pre-wrap", color: "var(--fg-muted)" }}>
									{isStreaming
										? "（等待子代理输出 · waiting for stream…）"
										: "（无输出 · no output）"}
									{isStreaming ? <span className="q-stream-cursor" /> : null}
								</p>
							)}
						</div>
					</article>
				) : null}
			</section>
			<Composer
				agents={[]}
				currentAgentId={agentId}
				sessionId={parentSessionId ?? detail?.parentId ?? undefined}
				onSelectAgent={onSelectAgent}
				hidden={false}
			/>
		</main>
	);
}
