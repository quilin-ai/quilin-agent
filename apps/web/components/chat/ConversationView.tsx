"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

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
import { loadSession, saveSession } from "@/lib/session-store";

interface SpawnSubagentOutput {
	readonly agentId: string;
	readonly task?: string;
}

function extractSpawnedSubagent(
	p: RawPart,
): { readonly agentId: string; readonly task: string } | null {
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
	return { agentId: candidate.agentId, task: taskFromOutput ?? taskFromInput };
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
		}
		setHydrated(true);
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
	const { messages, sendMessage, status, resumeStream } = useChat({
		id: sessionId,
		messages: storedMessages ? [...storedMessages] : undefined,
		transport: new DefaultChatTransport({ api: "/api/chat" }),
	});

	// Slice 3: when ChatBody mounts and the server has an inflight run for
	// this session (because the user navigated away mid-stream and is now
	// back), call `resumeStream()` to re-attach. The server's session-store
	// hashes by user-message-only, so the new POST hits the same buffer
	// and replays everything we missed. If the session is already complete
	// or doesn't exist, do nothing — the stored messages are the source of
	// truth.
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
					readonly data?: { readonly exists: boolean; readonly status: string | null };
				};
				if (body.ok && body.data?.exists && body.data.status === "running") {
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

	const streaming = status === "submitted" || status === "streaming";
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
		const onScroll = (): void => {
			const distanceFromBottom =
				document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
			autoScrollEnabledRef.current = distanceFromBottom < 120;
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire scroll on every messages reference change (including streaming delta) — body only reads refs
	useEffect(() => {
		if (!autoScrollEnabledRef.current) return;
		bottomRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
	}, [messages]);
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

	// Persist conversation to localStorage so /sessions page can list it.
	useEffect(() => {
		if (messages.length === 0) return;
		saveSession({ id: sessionId, messages });
	}, [sessionId, messages]);

	const onSubmit = useCallback(
		(text: string) => {
			if (!text.trim()) return;
			forceScrollToBottom();
			void sendMessage({ text });
		},
		[sendMessage, forceScrollToBottom],
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
						message={m}
						streaming={streaming && idx === messages.length - 1 && m.role === "assistant"}
					/>
				))}
				{/* Bottom sentinel for auto-scroll. The document scrolls (not q-view),
				    so we anchor scrollIntoView() to this empty element at the end. */}
				<div ref={bottomRef} aria-hidden="true" style={{ height: 1 }} />
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

interface RawPart {
	readonly type: string;
	readonly text?: string;
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly state?: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly errorText?: string;
}

function isReasoningPart(p: RawPart): boolean {
	return p.type === "reasoning";
}
function isToolPart(p: RawPart): boolean {
	return p.type.startsWith("tool-") || p.type === "dynamic-tool";
}
function toolNameOf(p: RawPart): string {
	if (p.toolName) return p.toolName;
	return p.type.replace(/^tool-/, "");
}
function extractToolCallId(p: RawPart): string | null {
	if (typeof p.toolCallId === "string" && p.toolCallId.length > 0) {
		return p.toolCallId;
	}
	return null;
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

function TurnMessage({
	message,
	streaming,
}: {
	readonly message: UIMessage;
	readonly streaming: boolean;
}): React.ReactElement {
	const isUser = message.role === "user";
	const parts = (message.parts ?? []) as readonly RawPart[];

	const reasoningParts = parts.filter(isReasoningPart);
	const toolParts = parts.filter(isToolPart);
	const textParts = parts.filter(
		(p): p is RawPart & { text: string } => p.type === "text" && typeof p.text === "string",
	);
	const body = textParts.map((p) => p.text).join("");

	const hasProcess = !isUser && (reasoningParts.length > 0 || toolParts.length > 0);

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
				{hasProcess ? (
					<Process
						title="过程 · process"
						defaultOpen={streaming}
						status={streaming ? "running" : "done"}
					>
						{reasoningParts.map((p, idx) => (
							<Reasoning
								// biome-ignore lint/suspicious/noArrayIndexKey: parts list is append-only in turn order; idx is stable for the message lifetime
								key={`r-${message.id}-${idx}`}
								title="思考 · reasoning"
							>
								<p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{p.text ?? ""}</p>
							</Reasoning>
						))}
						{toolParts.map((p, idx) => {
							const name = toolNameOf(p);
							const kind = toolKindOf(name);
							const status = toolStatusOf(p.state);
							const partKey = extractToolCallId(p) ?? `t-${message.id}-${idx}-${name}`;
							// Group with the previous tool call when it has the same name —
							// reduces visual spacing on consecutive same-type ops (e.g.,
							// three back-to-back spawn_subagent calls).
							const prevPart = idx > 0 ? toolParts[idx - 1] : null;
							const grouped = prevPart != null && toolNameOf(prevPart) === name;
							return (
								<ToolCall key={partKey} name={name} kind={kind} status={status} grouped={grouped}>
									<div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
										{p.input !== undefined ? (
											<div style={{ marginBottom: 6 }}>
												<div style={{ color: "var(--fg-muted)" }}>input</div>
												<pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
													{JSON.stringify(p.input, null, 2)}
												</pre>
											</div>
										) : null}
										{p.output !== undefined ? (
											<div>
												<div style={{ color: "var(--fg-muted)" }}>output</div>
												<pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
													{JSON.stringify(p.output, null, 2)}
												</pre>
											</div>
										) : null}
										{p.errorText ? (
											<div style={{ color: "var(--accent-vermillion)" }}>{p.errorText}</div>
										) : null}
									</div>
								</ToolCall>
							);
						})}
					</Process>
				) : null}
				{/* Inline live progress for any spawned subagents — rendered OUTSIDE
				    the Process panel so it stays visible after Process auto-collapses
				    when streaming ends. Each panel polls /api/agents/[id] live. */}
				{toolParts.length > 0
					? toolParts
							.map(extractSpawnedSubagent)
							.filter((s): s is { readonly agentId: string; readonly task: string } => s != null)
							.map((s) => (
								<SubagentLiveProgress key={`live-${s.agentId}`} agentId={s.agentId} task={s.task} />
							))
					: null}
				{body.length > 0 || !hasProcess ? (
					isUser ? (
						// User input stays plain text — typed by a human, no markdown.
						<p style={{ whiteSpace: "pre-wrap" }}>{body}</p>
					) : (
						// Assistant body is markdown; Streamdown renders tables, lists,
						// code blocks, etc., and gracefully parses incomplete markdown
						// while tokens are still streaming in.
						<div className="q-md">
							<Streamdown
								mode={streaming ? "streaming" : "static"}
								parseIncompleteMarkdown
								controls={{ table: false, code: false, mermaid: false }}
							>
								{body}
							</Streamdown>
							{streaming ? <span className="q-stream-cursor" /> : null}
						</div>
					)
				) : null}
			</div>
		</article>
	);
}
