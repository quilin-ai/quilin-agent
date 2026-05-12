/**
 * Server-side chat session store — decouples the LLM runner from the HTTP
 * response lifecycle so a session keeps running in the Next.js Node
 * process even after the browser navigates away. Slice 3 of the unified
 * TUI+Web backend rollout.
 *
 * Why this exists
 *   The default Vercel AI SDK v6 path (`streamText().toUIMessageStreamResponse()`)
 *   pipes the LLM stream straight to the HTTP response. When the client
 *   disconnects, the underlying ReadableStream cancels and the LLM call
 *   gets aborted — the user loses the rest of the answer. We solve this
 *   by introducing a per-session in-memory buffer between the runner and
 *   the HTTP response:
 *
 *   ```
 *   streamText →  buffer (ring + listeners)  ←  HTTP response (subscriber)
 *                  ▲                               │
 *                  │                               ▼ client disconnects
 *                  runner keeps writing            buffer keeps growing
 *                  └─────────┐                ┌────  client reconnects
 *                            ▼                ▼      (new HTTP response
 *                            buffer            buffer  subscribes from
 *                              ◀─────────────▶          seq 0 → replays)
 *   ```
 *
 *   Each session keeps the full event stream (capped by a ring buffer) so
 *   reconnecting clients can replay everything they missed.
 *
 * 服务端聊天会话存储 —— 把 LLM runner 和 HTTP 响应生命周期解耦,客户端切走也不
 * 中断 LLM,切回时从 buffer replay。slice 3。
 */

/**
 * One SSE frame as it would be written to the wire. We store the raw
 * `data:` payload (already JSON-encoded by the AI SDK) so subscribers can
 * write it out verbatim without re-encoding.
 */
export interface SessionFrame {
	readonly seq: number;
	/** The JSON-stringified UIMessage chunk (no `data: ` prefix, no `\n\n`). */
	readonly data: string;
}

export type SessionStatus = "running" | "complete" | "failed";

export interface ChatSession {
	readonly id: string;
	frames: SessionFrame[];
	status: SessionStatus;
	nextSeq: number;
	listeners: Set<(frame: SessionFrame) => void>;
	completionListeners: Set<() => void>;
	/** Monotonic timestamp of last activity for stale-session cleanup. */
	updatedAtMs: number;
	/** Hash of the messages that started this run; used to detect "same question, re-attach" vs "new question, restart". */
	startedFromHash: string;
}

const MAX_FRAMES_PER_SESSION = 5_000;
const STALE_SESSION_MS = 30 * 60 * 1000; // 30 min
/**
 * Hard ceiling on concurrent sessions. Without this, a long-lived dev
 * server that finishes lots of chats without ever starting a new one
 * (which is what triggers `cleanupStaleSessions`) accumulates completed
 * session frames forever. When the cap is hit we evict the LRU
 * (oldest `updatedAtMs`) session.
 *
 * 当 dev 服务长期跑、用户做了很多对话又不再开新 session 时,
 * `cleanupStaleSessions` 不会被触发。这里加硬上限避免无界增长。
 */
const MAX_SESSIONS = 200;

declare global {
	var __quilin_chat_sessions__: Map<string, ChatSession> | undefined;
}

const sessions: Map<string, ChatSession> = globalThis.__quilin_chat_sessions__ ?? new Map();
if (!globalThis.__quilin_chat_sessions__) {
	globalThis.__quilin_chat_sessions__ = sessions;
}

/**
 * Look up a session by id. Returns undefined when the session does not
 * exist (or was evicted by stale cleanup). Opportunistically prunes
 * stale sessions on every lookup so a long-running process doesn't
 * accumulate completed sessions forever.
 */
export function getSession(id: string): ChatSession | undefined {
	cleanupStaleSessions();
	return sessions.get(id);
}

/**
 * Create-or-reset a session for a new runner. If an old session exists
 * for the same id (e.g., a previous completed conversation), its frames
 * are dropped so the new run starts with a clean buffer.
 *
 * Returns the fresh session in `running` state with no frames yet.
 */
export function startSession(id: string, startedFromHash: string): ChatSession {
	cleanupStaleSessions();
	enforceSessionCap();
	const existing = sessions.get(id);
	if (existing != null) {
		// Notify any lingering completion listeners that we're tearing down
		// before they get stuck waiting on a session that's being replaced.
		for (const cb of existing.completionListeners) {
			try {
				cb();
			} catch {
				/* swallow */
			}
		}
	}
	const session: ChatSession = {
		id,
		frames: [],
		status: "running",
		nextSeq: 1,
		listeners: new Set(),
		completionListeners: new Set(),
		updatedAtMs: Date.now(),
		startedFromHash,
	};
	sessions.set(id, session);
	return session;
}

/**
 * Hard cap eviction: if more than `MAX_SESSIONS` are alive after stale
 * cleanup, drop the LRU (oldest `updatedAtMs`) until we're back under
 * the cap. Running sessions get a small bias by skipping eviction on
 * the most recently active session.
 */
function enforceSessionCap(): void {
	if (sessions.size < MAX_SESSIONS) return;
	const ordered = [...sessions.entries()].sort(([, a], [, b]) => a.updatedAtMs - b.updatedAtMs);
	const toEvict = sessions.size - MAX_SESSIONS + 1;
	for (let i = 0; i < toEvict && i < ordered.length; i += 1) {
		const entry = ordered[i];
		if (entry == null) continue;
		const [id, session] = entry;
		session.status = "complete";
		for (const cb of [...session.completionListeners]) {
			try {
				cb();
			} catch {
				/* swallow */
			}
		}
		sessions.delete(id);
	}
}

/**
 * Append a frame and fan it out to live subscribers. Drops oldest frames
 * when the ring buffer hits capacity to bound memory usage on long runs.
 */
export function appendFrame(session: ChatSession, data: string): SessionFrame {
	const frame: SessionFrame = { seq: session.nextSeq, data };
	session.nextSeq += 1;
	session.frames.push(frame);
	while (session.frames.length > MAX_FRAMES_PER_SESSION) {
		session.frames.shift();
	}
	session.updatedAtMs = Date.now();
	for (const listener of [...session.listeners]) {
		try {
			listener(frame);
		} catch {
			/* one bad subscriber shouldn't take down others */
		}
	}
	return frame;
}

/**
 * Mark the session as complete (or failed). Notifies completion listeners
 * so any active SSE subscriber knows to finish its [DONE] handshake.
 */
export function markSessionComplete(session: ChatSession, status: "complete" | "failed"): void {
	session.status = status;
	session.updatedAtMs = Date.now();
	for (const cb of [...session.completionListeners]) {
		try {
			cb();
		} catch {
			/* swallow */
		}
	}
	session.completionListeners.clear();
}

/**
 * Subscribe to a session's event stream. Yields buffered frames whose
 * `seq > afterSeq` first (replay), then yields live frames as they
 * arrive. Stops when the session is marked complete AND all buffered
 * frames have been delivered.
 *
 * The returned iterator has a `close()` to unsubscribe early (used when
 * the HTTP response is canceled by the client).
 */
export function subscribeSession(
	session: ChatSession,
	afterSeq: number,
): AsyncIterableIterator<SessionFrame> & { close(): void } {
	const queue: SessionFrame[] = [];
	for (const frame of session.frames) {
		if (frame.seq > afterSeq) queue.push(frame);
	}
	let closed = false;
	const waiters: ((value: IteratorResult<SessionFrame>) => void)[] = [];

	const listener = (frame: SessionFrame): void => {
		if (closed) return;
		const waiter = waiters.shift();
		if (waiter == null) {
			queue.push(frame);
		} else {
			waiter({ value: frame, done: false });
		}
	};
	session.listeners.add(listener);

	const completionListener = (): void => {
		// Flush any pending waiters with done=true so consumers can exit.
		while (waiters.length > 0) {
			const w = waiters.shift();
			if (w != null) w({ value: undefined, done: true });
		}
	};
	session.completionListeners.add(completionListener);

	const iter: AsyncIterableIterator<SessionFrame> & { close(): void } = {
		async next(): Promise<IteratorResult<SessionFrame>> {
			if (queue.length > 0) {
				const frame = queue.shift();
				if (frame != null) return { value: frame, done: false };
			}
			if (closed) {
				return { value: undefined, done: true };
			}
			if ((session.status === "complete" || session.status === "failed") && queue.length === 0) {
				return { value: undefined, done: true };
			}
			return new Promise<IteratorResult<SessionFrame>>((resolve) => {
				waiters.push(resolve);
			});
		},
		async return(): Promise<IteratorResult<SessionFrame>> {
			this.close();
			return { value: undefined, done: true };
		},
		[Symbol.asyncIterator]() {
			return this;
		},
		close(): void {
			if (closed) return;
			closed = true;
			session.listeners.delete(listener);
			session.completionListeners.delete(completionListener);
			while (waiters.length > 0) {
				const w = waiters.shift();
				if (w != null) w({ value: undefined, done: true });
			}
		},
	};
	return iter;
}

/**
 * Drop sessions that haven't been touched for `STALE_SESSION_MS`.
 * Called on every `startSession` so memory doesn't leak across a long
 * dev-server lifetime.
 */
function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [id, session] of sessions) {
		if (now - session.updatedAtMs > STALE_SESSION_MS) {
			// Notify subscribers + drop. They'll wake with done:true.
			session.status = "complete";
			for (const cb of [...session.completionListeners]) {
				try {
					cb();
				} catch {
					/* swallow */
				}
			}
			sessions.delete(id);
		}
	}
}

/**
 * Compute a stable hash for a messages array so two posts with the same
 * USER INPUT map to the same session run. Assistant messages are
 * intentionally ignored: when the client reconnects mid-stream, its
 * stored messages may include a *partial* assistant response that would
 * otherwise change the hash and miss the inflight runner. Hashing only
 * user turns means "same user history → same session" regardless of how
 * much the assistant has streamed so far.
 *
 * 只对 user 消息算 hash:客户端 reconnect 时 stored messages 可能含 partial
 * assistant 内容,把它纳入 hash 会破坏匹配。只看 user 输入,reconnect 才能稳。
 */
export function hashMessages(
	messages: readonly { readonly role: string; readonly parts?: readonly unknown[] }[],
): string {
	const pieces: string[] = [];
	for (const m of messages) {
		if (m.role !== "user") continue;
		const parts = m.parts ?? [];
		const text = parts
			.map((p) => {
				if (typeof p !== "object" || p == null) return "";
				const obj = p as { readonly type?: string; readonly text?: string };
				return obj.type === "text" ? (obj.text ?? "") : "";
			})
			.join("");
		pieces.push(text);
	}
	// Simple FNV-1a 32-bit hash → hex. Deterministic and good enough for
	// dedup; not used for security.
	let h = 0x811c9dc5;
	const joined = pieces.join("\n");
	for (let i = 0; i < joined.length; i += 1) {
		h ^= joined.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}
