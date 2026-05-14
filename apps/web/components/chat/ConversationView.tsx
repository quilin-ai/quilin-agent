"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { AsidePart, type AsidePartData } from "@/components/chat/AsidePart";
import { InlineApproval, type InlineApprovalData } from "@/components/chat/InlineApproval";
import { InlineQuestion, type InlineQuestionData } from "@/components/chat/InlineQuestion";
import { SubagentDetailView } from "@/components/chat/SubagentDetailView";
import { SubagentLiveProgress } from "@/components/chat/SubagentLiveProgress";
import { Process } from "@/components/conversation/Process";
import { Reasoning } from "@/components/conversation/Reasoning";
import {
	ToolCall,
	type ToolCallKind,
	type ToolCallStatus,
} from "@/components/conversation/ToolCall";
import { Composer } from "@/components/shell/Composer";
import { deriveAgentDisplayName } from "@/lib/agent-display-name";
import { loadSession, saveSession } from "@/lib/session-store";
import { summarizeProcessBlock, summarizeToolCall } from "@/lib/tool-call-summary";
import {
	buildTranscriptBlocks,
	extractToolCallId,
	extractToolPartsFromBlocks,
	type InteractionBlock,
	type ProcessBlock,
	type RawPart,
	type TextBlock,
	type ToolGroupItem,
	type TranscriptBlock,
	toolNameOf,
} from "@/lib/transcript-blocks";

interface SpawnSubagentOutput {
	readonly agentId: string;
	readonly displayName?: string;
	readonly task?: string;
}

interface QueuedUserMessage {
	readonly id: string;
	readonly text: string;
}

function extractSpawnedSubagent(
	p: RawPart,
): { readonly agentId: string; readonly displayName: string; readonly task: string } | null {
	if (toolNameOf(p) !== "spawn_subagent") return null;
	const out = p.output;
	if (typeof out !== "object" || out == null) return null;
	const candidate = out as Partial<SpawnSubagentOutput>;
	if (typeof candidate.agentId !== "string" || candidate.agentId.length === 0) {
		return null;
	}
	const taskFromOutput = typeof candidate.task === "string" ? candidate.task : null;
	const taskFromInput =
		typeof p.input === "object" && p.input != null && "task" in (p.input as object)
			? String((p.input as { readonly task: unknown }).task ?? "")
			: "";
	const task = taskFromOutput ?? taskFromInput;
	const displayName =
		typeof candidate.displayName === "string" && candidate.displayName.trim().length > 0
			? candidate.displayName.trim()
			: deriveAgentDisplayName(task);
	return { agentId: candidate.agentId, displayName, task };
}

export interface ConversationViewProps {
	readonly sessionId: string;
	readonly initialMessage?: string;
	readonly parentSessionId?: string;
}

function isSubagentId(id: string): boolean {
	return id.startsWith("subagent-");
}

/**
 * Client-side conversation view backed by AI SDK v6 `useChat`.
 *
 * To avoid SSR/client hydration mismatch (localStorage isn't readable on the
 * server), this component splits into:
 * - Outer (hydrate gate): waits until mount, loads stored session, then renders
 * - Inner (ChatBody): mounts `useChat` with the resolved initial messages
 */
export function ConversationView({
	sessionId,
	initialMessage,
	parentSessionId,
}: ConversationViewProps) {
	const [hydrated, setHydrated] = useState(false);
	const [storedMessages, setStoredMessages] = useState<readonly UIMessage[] | undefined>(undefined);

	useEffect(() => {
		if (isSubagentId(sessionId)) {
			setHydrated(true);
			return;
		}
		const stored = loadSession(sessionId);
		if (stored != null && stored.messages.length > 0) {
			setStoredMessages(stored.messages);
			setHydrated(true);
			return;
		}
		// Slice 3 restart recovery: localStorage doesn't have this session
		// (cache cleared / cross-browser / first visit). Try the SQLite-backed
		// `/api/sessions/[id]` endpoint as a fallback so the conversation
		// can resume from the server-side persisted history.
		//
		// Slice 3 重启恢复:本地缓存没有该 session(清缓存 / 跨浏览器 / 首次访问)→
		// fallback 到服务端 `/api/sessions/[id]`,从 SQLite 持久化恢复历史。
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
					cache: "no-store",
				});
				if (!res.ok || cancelled) {
					setHydrated(true);
					return;
				}
				const body = (await res.json()) as {
					readonly messages?: ReadonlyArray<{
						readonly id: string;
						readonly role: string;
						readonly parts: readonly unknown[];
					}>;
				};
				const fetched = body.messages;
				if (cancelled) return;
				if (Array.isArray(fetched) && fetched.length > 0) {
					setStoredMessages(
						fetched.map((m) => ({
							id: m.id,
							role: m.role,
							parts: m.parts,
						})) as readonly UIMessage[],
					);
				}
			} catch {
				// network failure / API down — fall through to fresh-start UI
			} finally {
				if (!cancelled) setHydrated(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	if (!hydrated) {
		// Same shape on server + first client render → no hydration mismatch
		return (
			<main className="q-workspace">
				<section className="q-view">
					<div style={{ color: "var(--fg-muted)", padding: "24px 0" }}>加载中 · loading…</div>
				</section>
			</main>
		);
	}

	if (isSubagentId(sessionId)) {
		return <SubagentDetailView agentId={sessionId} parentSessionId={parentSessionId} />;
	}

	return (
		<ChatBody
			sessionId={sessionId}
			initialMessage={initialMessage}
			storedMessages={storedMessages}
		/>
	);
}

/**
 * sessionStorage key for the AgentService process-epoch UUID we
 * received in `/api/chat/status` (and via the `X-Quilin-Epoch`
 * response header on `/api/chat`). The client echoes this back as
 * `clientEpoch` on every POST so the server can detect cross-process
 * agent-core restarts and force a fresh session.
 *
 * sessionStorage 持久化 epoch,作为 strict-epoch handshake 的客户端侧。
 */
const EPOCH_STORAGE_KEY = "quilin:agent-service:epoch";

function readPersistedEpoch(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.sessionStorage.getItem(EPOCH_STORAGE_KEY);
	} catch {
		return null;
	}
}

function writePersistedEpoch(epoch: string | null): void {
	if (typeof window === "undefined") return;
	try {
		if (epoch == null) window.sessionStorage.removeItem(EPOCH_STORAGE_KEY);
		else window.sessionStorage.setItem(EPOCH_STORAGE_KEY, epoch);
	} catch {
		/* sessionStorage may be unavailable in private mode; non-fatal */
	}
}

function ChatBody({
	sessionId,
	initialMessage,
	storedMessages,
}: {
	readonly sessionId: string;
	readonly initialMessage?: string;
	readonly storedMessages?: readonly UIMessage[];
}) {
	const router = useRouter();
	// Build the transport once. `prepareSendMessagesRequest` injects the
	// cached epoch into every `/api/chat` body so the server can validate
	// it against `AgentService.currentEpoch()`. Wrapping in `useMemo`
	// guarantees the same transport across renders, which `useChat`
	// expects (transport identity is part of its dep tracking).
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api: "/api/chat",
				prepareSendMessagesRequest: ({ id, messages, body }) => {
					const clientEpoch = readPersistedEpoch();
					return {
						body: {
							...(body ?? {}),
							id,
							messages,
							...(clientEpoch == null ? {} : { clientEpoch }),
						},
					};
				},
			}),
		[],
	);
	const { messages, sendMessage, status, resumeStream } = useChat({
		id: sessionId,
		messages: storedMessages ? [...storedMessages] : undefined,
		transport,
	});
	const streaming = status === "submitted" || status === "streaming";
	const activeRunRef = useRef(streaming);
	const queuedIdRef = useRef(0);
	const [queuedSends, setQueuedSends] = useState<readonly QueuedUserMessage[]>([]);

	useEffect(() => {
		activeRunRef.current = streaming;
	}, [streaming]);

	// Mount hook:
	//   1. Probe `/api/chat/status` to learn the server's current epoch
	//      + whether there's an inflight run to resume.
	//   2. Persist the epoch in sessionStorage so future POSTs round-trip
	//      it back to the server.
	//   3. If the server still has a running session for this id, call
	//      `resumeStream()` to re-attach — the server-side
	//      session-meta hashes by user-message-only, so the new POST
	//      hits the same AgentService session and replays from event
	//      seq=0 in the bus history.
	const resumedRef = useRef(false);
	useEffect(() => {
		if (resumedRef.current) return;
		resumedRef.current = true;
		(async () => {
			try {
				const res = await fetch(`/api/chat/status?session=${encodeURIComponent(sessionId)}`, {
					cache: "no-store",
				});
				if (!res.ok) return;
				const body = (await res.json()) as {
					readonly ok: boolean;
					readonly data?: {
						readonly exists: boolean;
						readonly status: string | null;
						readonly epoch?: string;
					};
				};
				if (!body.ok || body.data == null) return;
				// Persist the latest epoch on every probe so a refresh
				// after agent-core restart sees the new epoch on next POST.
				if (typeof body.data.epoch === "string" && body.data.epoch.length > 0) {
					writePersistedEpoch(body.data.epoch);
				}
				if (body.data.exists && body.data.status === "running") {
					// Server still has an active run — re-attach.
					await resumeStream();
				}
			} catch {
				/* status probe is best-effort; on failure we just stay idle */
			}
		})();
	}, [sessionId, resumeStream]);

	const onSelectAgent = useCallback(
		(id: string) => {
			if (id === sessionId) return;
			if (id === "main") {
				router.push(`/?session=${encodeURIComponent(sessionId)}`);
				return;
			}
			router.push(`/?session=${encodeURIComponent(id)}&from=${encodeURIComponent(sessionId)}`);
		},
		[router, sessionId],
	);

	const sentInitial = useRef(false);

	useEffect(() => {
		if (sentInitial.current) return;
		// Skip auto-submit if we restored a non-empty conversation
		if (storedMessages != null && storedMessages.length > 0) {
			sentInitial.current = true;
			return;
		}
		if (!initialMessage) return;
		sentInitial.current = true;
		activeRunRef.current = true;
		void sendMessage({ text: initialMessage });
	}, [initialMessage, sendMessage, storedMessages]);

	// Auto-scroll: q-view itself doesn't scroll (the document does), so reset
	// `window.scrollY` to the bottom of the page whenever the message list
	// reference changes (new message, new part appended, streaming delta).
	// Skip the auto-scroll if the user has scrolled up by more than ~120px
	// from the bottom — they're explicitly reading earlier content and we
	// don't want to yank them back.
	const bottomRef = useRef<HTMLDivElement | null>(null);
	const autoScrollEnabledRef = useRef(true);
	useEffect(() => {
		// Detect *user-initiated* scroll-up via real input events
		// (wheel up, ArrowUp / PageUp / Home keys, touch swipe down).
		// We do NOT use the generic `scroll` event because
		// `scrollIntoView` from our own RAF loop also fires it,
		// creating a feedback loop where auto-scroll disables itself
		// on the first frame. Discovered during 2026-05-13 e2e
		// capability assessment.
		//
		// 不用 scroll 事件检测用户滚动 —— 我们自己的 scrollIntoView 也会
		// 触发 scroll 事件,导致 onScroll handler 关掉 auto-scroll,形成
		// 反向反馈循环。改成监听真实用户输入（wheel up / 键盘上翻 / 触摸下拉）。
		const onWheel = (e: WheelEvent): void => {
			if (e.deltaY < 0) autoScrollEnabledRef.current = false;
		};
		const onKey = (e: KeyboardEvent): void => {
			if (
				e.key === "ArrowUp" ||
				e.key === "PageUp" ||
				e.key === "Home" ||
				(e.key === " " && e.shiftKey) // Shift+Space scrolls up
			) {
				autoScrollEnabledRef.current = false;
			}
			if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "End" || e.key === " ") {
				// User explicitly asked to go down — opt back in to
				// auto-follow if they reach the bottom.
				const distance =
					document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
				if (distance < 120) autoScrollEnabledRef.current = true;
			}
		};
		let touchStartY = 0;
		const onTouchStart = (e: TouchEvent): void => {
			touchStartY = e.touches[0]?.clientY ?? 0;
		};
		const onTouchMove = (e: TouchEvent): void => {
			const y = e.touches[0]?.clientY ?? 0;
			if (y - touchStartY > 10) autoScrollEnabledRef.current = false;
		};
		window.addEventListener("wheel", onWheel, { passive: true });
		window.addEventListener("keydown", onKey);
		window.addEventListener("touchstart", onTouchStart, { passive: true });
		window.addEventListener("touchmove", onTouchMove, { passive: true });
		return () => {
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("touchstart", onTouchStart);
			window.removeEventListener("touchmove", onTouchMove);
		};
	}, []);

	// During streaming, useChat mutates `message.parts` in place rather
	// than swapping references — so `useEffect([messages])` doesn't
	// fire reliably on every delta. Drive a requestAnimationFrame loop
	// while `streaming === true`, and keep the loop alive for an
	// additional ~1.5s after streaming flips to false so any late
	// layout shifts (streamdown's incomplete-markdown final reparse,
	// font/image loads, hydration of tool cards) also keep the viewport
	// pinned to the bottom.
	//
	// 流式期间 useChat 直接 mutate parts 数组,messages 引用不变,
	// `useEffect([messages])` 不会每帧触发。改用 RAF 循环,在 streaming
	// 期间持续把锚点滚进视图,流结束后再延长 1.5s 跟随最后的 layout shift。
	useEffect(() => {
		let raf = 0;
		const stopAt: number | null = streaming ? null : performance.now() + 1500;
		const loop = (): void => {
			if (autoScrollEnabledRef.current) {
				bottomRef.current?.scrollIntoView({
					block: "end",
					inline: "nearest",
				});
			}
			if (stopAt != null && performance.now() >= stopAt) return;
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [streaming]);

	// Re-enable auto-scroll on each user submit so a new question always
	// jumps to the bottom regardless of where the user had scrolled before.
	const forceScrollToBottom = useCallback((): void => {
		autoScrollEnabledRef.current = true;
		// scrollIntoView in a microtask so layout has settled after the user
		// message has been appended.
		queueMicrotask(() => {
			bottomRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
		});
	}, []);

	const enqueueSend = useCallback(
		(text: string): void => {
			queuedIdRef.current += 1;
			setQueuedSends((prev) => [
				...prev,
				{
					id: `${sessionId}-queued-${queuedIdRef.current}`,
					text,
				},
			]);
			forceScrollToBottom();
		},
		[forceScrollToBottom, sessionId],
	);

	useEffect(() => {
		if (streaming || activeRunRef.current || queuedSends.length === 0) return;
		const next = queuedSends[0];
		if (next == null) return;
		activeRunRef.current = true;
		setQueuedSends((prev) => prev.slice(1));
		forceScrollToBottom();
		void sendMessage({ text: next.text }).catch(() => {
			activeRunRef.current = false;
		});
	}, [streaming, queuedSends, sendMessage, forceScrollToBottom]);

	// Persist conversation to localStorage so /sessions page can list it.
	useEffect(() => {
		if (messages.length === 0) return;
		saveSession({ id: sessionId, messages });
	}, [sessionId, messages]);

	const onSubmit = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			forceScrollToBottom();
			if (streaming || activeRunRef.current || queuedSends.length > 0) {
				enqueueSend(trimmed);
				return;
			}
			activeRunRef.current = true;
			void sendMessage({ text: trimmed }).catch(() => {
				activeRunRef.current = false;
			});
		},
		[sendMessage, forceScrollToBottom, streaming, queuedSends.length, enqueueSend],
	);

	return (
		<main className="q-workspace">
			<section className="q-view">
				{messages.length === 0 ? (
					<div style={{ color: "var(--fg-muted)", padding: "24px 0" }}>
						开始对话 · session id <code>{sessionId}</code>
					</div>
				) : null}
				{messages.map((m: UIMessage, idx: number) => (
					<TurnMessage
						key={m.id}
						sessionId={sessionId}
						message={m}
						streaming={streaming && idx === messages.length - 1 && m.role === "assistant"}
					/>
				))}
				{queuedSends.map((queued, idx) => (
					<QueuedUserTurn key={queued.id} message={queued} position={idx + 1} />
				))}
				{/* Bottom sentinel for auto-scroll. The document scrolls (not q-view),
				    so we anchor scrollIntoView() to this empty element at the end. */}
				{/* Scroll anchor — `scroll-margin-bottom` keeps the *last
				    content row* clear of the fixed composer when
				    `scrollIntoView({block: "end"})` aligns this anchor to
				    the viewport bottom. The composer is ~88px tall plus
				    ~32px breathing room → 120px total. Without this margin
				    the last lines render behind the composer and the user
				    has to scroll a bit further by hand. */}
				<div
					ref={bottomRef}
					aria-hidden="true"
					style={{ height: 1, scrollMarginBottom: "120px" }}
				/>
			</section>
			<Composer
				agents={[]}
				currentAgentId="main"
				sessionId={sessionId}
				onSubmit={onSubmit}
				onSelectAgent={onSelectAgent}
			/>
		</main>
	);
}

function QueuedUserTurn({
	message,
	position,
}: {
	readonly message: QueuedUserMessage;
	readonly position: number;
}): React.ReactElement {
	return (
		<article className="q-turn" data-role="user" data-state="queued">
			<div className="q-turn-label">
				<span>you</span>
				<span className="dot">·</span>
				<span className="cjk-tag">你</span>
				<span className="q-queued-badge">已排队 · queued {position}</span>
			</div>
			<div className="q-turn-body">
				<p style={{ whiteSpace: "pre-wrap" }}>{message.text}</p>
			</div>
		</article>
	);
}

function toolKindOf(name: string): ToolCallKind {
	if (name.includes("subagent")) return "subagent";
	if (name.includes("memory") || name.includes("mem")) return "memory";
	if (name.includes("mcp")) return "mcp";
	return "tool";
}
function toolStatusOf(state: string | undefined): ToolCallStatus {
	if (state === "output-available") return "done";
	if (state === "output-error") return "error";
	return "pending";
}

function stableToolPartKey(part: RawPart): string {
	return [
		toolNameOf(part),
		part.state ?? "",
		JSON.stringify(part.input ?? null),
		JSON.stringify(part.output ?? null),
		part.errorText ?? "",
	]
		.join("|")
		.slice(0, 160);
}

function fallbackCopyText(text: string): boolean {
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "true");
	textarea.style.position = "fixed";
	textarea.style.top = "-1000px";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	const copied = document.execCommand("copy");
	document.body.removeChild(textarea);
	return copied;
}

function MarkdownCopyButton({ text }: { readonly text: string }): React.ReactElement {
	const [copied, setCopied] = useState(false);
	const onCopy = useCallback(async () => {
		let ok = fallbackCopyText(text);
		try {
			if (!ok && navigator.clipboard?.writeText != null) {
				await navigator.clipboard.writeText(text);
				ok = true;
			}
		} catch {
			ok = fallbackCopyText(text);
		}
		setCopied(ok);
		window.setTimeout(() => setCopied(false), 1400);
	}, [text]);

	return (
		<button
			type="button"
			className="q-copy-markdown"
			onClick={onCopy}
			aria-label="复制 markdown 原文"
		>
			<span className="q-copy-icon" aria-hidden="true">
				⧉
			</span>
			<span>{copied ? "已复制" : "复制 markdown"}</span>
		</button>
	);
}

function ToolCallDetails({ part }: { readonly part: RawPart }): React.ReactElement {
	return (
		<div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
			{part.input !== undefined ? (
				<div style={{ marginBottom: 6 }}>
					<div style={{ color: "var(--fg-muted)" }}>input</div>
					<pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
						{JSON.stringify(part.input, null, 2)}
					</pre>
				</div>
			) : null}
			{part.output !== undefined ? (
				<div>
					<div style={{ color: "var(--fg-muted)" }}>output</div>
					<pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
						{JSON.stringify(part.output, null, 2)}
					</pre>
				</div>
			) : null}
			{part.errorText ? (
				<div style={{ color: "var(--accent-vermillion)" }}>{part.errorText}</div>
			) : null}
		</div>
	);
}

function ToolGroup({ item }: { readonly item: ToolGroupItem }): React.ReactElement {
	const first = item.calls[0];
	const status: ToolCallStatus = item.calls.some((part) => toolStatusOf(part.state) === "error")
		? "error"
		: item.calls.some((part) => toolStatusOf(part.state) === "pending")
			? "pending"
			: "done";
	const count = item.calls.length;
	const name = item.name;
	const kind = toolKindOf(name);
	const statusLabel =
		count > 1
			? `${status === "done" ? "▢ done" : status === "error" ? "✕ error" : "▪ running"} · ${count} 次`
			: undefined;

	return (
		<ToolCall
			name={count > 1 ? `${name} × ${count}` : name}
			kind={kind}
			status={status}
			statusLabel={statusLabel}
			grouped={false}
		>
			{count > 1 ? (
				<div className="q-tool-call-group-list">
					{item.calls.map((part) => (
						<details
							key={extractToolCallId(part) ?? `${name}-${stableToolPartKey(part)}`}
							className="q-tool-call-subcall"
						>
							<summary>
								<span className="q-tool-call-subcall-title">{summarizeToolCall(part)}</span>
								<span className={`q-tool-call-subcall-status ${toolStatusOf(part.state)}`}>
									{toolStatusOf(part.state)}
								</span>
							</summary>
							<ToolCallDetails part={part} />
						</details>
					))}
				</div>
			) : first != null ? (
				<ToolCallDetails part={first} />
			) : null}
		</ToolCall>
	);
}

function ProcessBlockView({
	block,
	streaming,
}: {
	readonly block: ProcessBlock;
	readonly streaming: boolean;
}): React.ReactElement {
	const autoScrollKey = block.items
		.map((item) => {
			if (item.type === "reasoning") return `r:${item.part.text?.length ?? 0}`;
			return `t:${item.name}:${item.calls.map(stableToolPartKey).join(",")}`;
		})
		.join("|");
	return (
		<Process
			title={summarizeProcessBlock(block, streaming)}
			autoScrollKey={autoScrollKey}
			defaultOpen={streaming}
			status={streaming ? "running" : "done"}
		>
			{block.items.map((item, idx) => {
				if (item.type === "reasoning") {
					return (
						<Reasoning
							// biome-ignore lint/suspicious/noArrayIndexKey: process block order is append-only during one streamed turn
							key={`r-${block.id}-${idx}`}
							title="思考 · reasoning"
						>
							<p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{item.part.text ?? ""}</p>
						</Reasoning>
					);
				}
				const groupKey =
					item.calls.map(extractToolCallId).filter(Boolean).join("-") ||
					`${item.name}-${stableToolPartKey(item.calls[0] ?? { type: item.name })}`;
				return <ToolGroup key={`tg-${block.id}-${groupKey}`} item={item} />;
			})}
		</Process>
	);
}

function MarkdownTextBlock({
	block,
	streaming,
}: {
	readonly block: TextBlock;
	readonly streaming: boolean;
}): React.ReactElement {
	return (
		<div className="q-message-segment">
			<div className="q-md">
				<Streamdown
					mode={streaming ? "streaming" : "static"}
					parseIncompleteMarkdown
					controls={{ table: false, code: false, mermaid: false }}
				>
					{block.text}
				</Streamdown>
				{streaming ? <span className="q-stream-cursor" /> : null}
			</div>
			<MarkdownCopyButton text={block.text} />
		</div>
	);
}

/**
 * Iter F 交互 primitives dispatcher — picks the right component for
 * each `data-ask` / `data-approval` / `data-aside` UIMessage part.
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3.2.
 *
 * 三个 primitive 部分的 dispatcher,根据 block.kind 路由到不同组件。
 */
function InteractionBlockView({
	block,
	sessionId,
}: {
	readonly block: InteractionBlock;
	readonly sessionId: string;
}): React.ReactElement | null {
	if (block.kind === "question") {
		return <InlineQuestion sessionId={sessionId} data={block.data as InlineQuestionData} />;
	}
	if (block.kind === "approval") {
		return <InlineApproval sessionId={sessionId} data={block.data as InlineApprovalData} />;
	}
	if (block.kind === "aside") {
		return <AsidePart data={block.data as AsidePartData} />;
	}
	return null;
}

function TurnMessage({
	sessionId,
	message,
	streaming,
}: {
	readonly sessionId: string;
	readonly message: UIMessage;
	readonly streaming: boolean;
}): React.ReactElement {
	const isUser = message.role === "user";
	const parts = (message.parts ?? []) as readonly RawPart[];
	const blocks = buildTranscriptBlocks(parts, message.id);
	const toolParts = extractToolPartsFromBlocks(blocks);
	const body = blocks
		.filter((block): block is TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("");
	const hasProcess = !isUser && blocks.some((block) => block.type === "process");

	return (
		<article className="q-turn" data-role={message.role}>
			<div className="q-turn-label">
				{isUser ? (
					<>
						<span>you</span>
						<span className="dot">·</span>
						<span className="cjk-tag">你</span>
					</>
				) : (
					<>
						<span className="cjk-tag">麒麟</span>
						<span className="dot">·</span>
						<span>assistant</span>
					</>
				)}
			</div>
			<div className="q-turn-body">
				{!isUser
					? blocks.map((block: TranscriptBlock) =>
							block.type === "process" ? (
								<ProcessBlockView key={block.id} block={block} streaming={streaming} />
							) : block.type === "interaction" ? (
								<InteractionBlockView key={block.id} block={block} sessionId={sessionId} />
							) : (
								<MarkdownTextBlock key={block.id} block={block} streaming={streaming} />
							),
						)
					: null}
				{/* Inline live progress for any spawned subagents — rendered OUTSIDE
				    the Process panel so it stays visible after Process auto-collapses
				    when streaming ends. Each panel polls /api/agents/[id] live. */}
				{toolParts.length > 0
					? toolParts
							.map(extractSpawnedSubagent)
							.filter(
								(
									s,
								): s is {
									readonly agentId: string;
									readonly displayName: string;
									readonly task: string;
								} => s != null,
							)
							.map((s) => (
								<SubagentLiveProgress
									key={`live-${s.agentId}`}
									agentId={s.agentId}
									displayName={s.displayName}
									parentSessionId={sessionId}
									task={s.task}
								/>
							))
					: null}
				{isUser && (body.length > 0 || !hasProcess) ? (
					isUser ? (
						// User input stays plain text — typed by a human, no markdown.
						<p style={{ whiteSpace: "pre-wrap" }}>{body}</p>
					) : null
				) : null}
			</div>
		</article>
	);
}
