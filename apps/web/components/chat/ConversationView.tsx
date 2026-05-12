"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { Composer } from "@/components/shell/Composer";
import { loadSession, saveSession } from "@/lib/session-store";

export interface ConversationViewProps {
	readonly sessionId: string;
	readonly initialMessage?: string;
}

/**
 * Client-side conversation view backed by AI SDK v6 `useChat`.
 * - On mount: if the session id matches a stored conversation, replay its messages
 * - Otherwise: auto-submits `initialMessage` (passed via URL from IntroScreen)
 * - Streams assistant tokens directly into the view
 * - Persists every change back to localStorage so /sessions can list it
 */
export function ConversationView({ sessionId, initialMessage }: ConversationViewProps) {
	const stored = useMemo(() => loadSession(sessionId), [sessionId]);
	const { messages, sendMessage, status } = useChat({
		id: sessionId,
		messages: stored?.messages ? [...stored.messages] : undefined,
		transport: new DefaultChatTransport({ api: "/api/chat" }),
	});

	const streaming = status === "submitted" || status === "streaming";
	const sentInitial = useRef(false);
	useEffect(() => {
		if (sentInitial.current) return;
		// Don't auto-submit the initial if we already restored a stored conversation.
		if (stored != null && stored.messages.length > 0) {
			sentInitial.current = true;
			return;
		}
		if (!initialMessage) return;
		sentInitial.current = true;
		void sendMessage({ text: initialMessage });
	}, [initialMessage, sendMessage, stored]);

	const scrollerRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [messages]);

	// Persist conversation to localStorage so the /sessions page can list it.
	// 把会话写入 localStorage,让 /sessions 页能列出历史会话。
	useEffect(() => {
		if (messages.length === 0) return;
		saveSession({ id: sessionId, messages });
	}, [sessionId, messages]);

	const onSubmit = useCallback(
		(text: string) => {
			if (!text.trim()) return;
			void sendMessage({ text });
		},
		[sendMessage],
	);

	return (
		<main className="q-workspace">
			<section className="q-view" ref={scrollerRef}>
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
			</section>
			<Composer
				agents={[]}
				currentAgentId="main"
				onSubmit={onSubmit}
			/>
		</main>
	);
}

function TurnMessage({
	message,
	streaming,
}: {
	readonly message: UIMessage;
	readonly streaming: boolean;
}): React.ReactElement {
	const isUser = message.role === "user";
	const textParts = (message.parts ?? []).filter(
		(p: { type: string }): p is { type: "text"; text: string } => p.type === "text",
	);
	const body = textParts.map((p) => p.text).join("");

	return (
		<article className="q-turn" data-role={message.role}>
			<div className="q-turn-label">
				<span>{isUser ? "you" : "麒麟"}</span>
				<span className="dot">·</span>
				<span className="cjk-tag">{isUser ? "你" : "assistant"}</span>
			</div>
			<div className="q-turn-body">
				<p style={{ whiteSpace: "pre-wrap" }}>
					{body}
					{streaming ? <span className="q-stream-cursor" /> : null}
				</p>
			</div>
		</article>
	);
}
