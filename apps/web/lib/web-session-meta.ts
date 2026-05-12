/**
 * Web-only metadata for chat sessions: things AgentService doesn't store
 * because they're specific to the AI-SDK-v6 message protocol.
 *
 *   1. `hash` — FNV-1a of the user-only message turns. Drives reconnect
 *      detection ("same question? → re-attach to the live run").
 *   2. `abortController` — handle to cancel the in-flight `streamText`
 *      runner when the user sends a different question on the same
 *      sessionId, or when LRU eviction reclaims this slot.
 *   3. `createdAtMs` — wall-clock timestamp for LRU ordering.
 *
 * Lives on `globalThis` so Next.js hot reload doesn't churn the map.
 * Capped at `MAX_WEB_SESSION_META` (matches the legacy
 * `chat-session-store`'s ceiling). Eviction aborts the runner and
 * deletes the session from AgentService, then emits a `session.failed`
 * event so any live subscribers see termination instead of hanging.
 *
 * 与 AgentService 平行的 web 端元数据:hash(reconnect 检测)+ AbortController
 * (取消 in-flight runner)+ createdAtMs(LRU 排序)。LRU 上限 200,驱逐时
 * abort + 删 AgentService session + emit session.failed。
 *
 * Task #22 Phase 3.
 */

import type { AgentServiceLike } from "./agent-service-client.js";

export interface WebSessionMeta {
	readonly sessionId: string;
	readonly hash: string;
	/** Abort signal for the in-flight runner; runner watches `abort.signal`. */
	readonly abort: AbortController;
	createdAtMs: number;
	/**
	 * Updated on every reconnect / activity touch so LRU eviction picks
	 * the truly oldest session. `createdAtMs` stays at the original
	 * creation time for forensics; `lastActivityMs` is the eviction key.
	 */
	lastActivityMs: number;
	/**
	 * EventBus seq immediately before the session was created (i.e., the
	 * `currentSeq()` value at session-creation time). Subscribers use
	 * `afterSeq: startSeq - 1` so any events left over from a prior
	 * session with the same sessionId (after `evictSession` +
	 * `createSession` of the same id) are filtered out.
	 *
	 * 旧 session 被 evict 后用同 id recreate 时,EventBus history 仍含旧
	 * events。startSeq 记下"新 session 开始时的下一个 seq",订阅者从
	 * startSeq-1 之后开始接收,过滤掉旧 events。
	 */
	readonly startSeq: number;
}

/**
 * Hard cap on concurrent web-side chat session metadata. Matches the
 * `MAX_SESSIONS=200` the legacy `chat-session-store` enforced.
 */
export const MAX_WEB_SESSION_META = 200;

declare global {
	var __quilin_web_session_meta__: Map<string, WebSessionMeta> | undefined;
}

function getMap(): Map<string, WebSessionMeta> {
	let m = globalThis.__quilin_web_session_meta__;
	if (m == null) {
		m = new Map<string, WebSessionMeta>();
		globalThis.__quilin_web_session_meta__ = m;
	}
	return m;
}

/**
 * Look up a session's metadata by id. Returns `undefined` when the
 * session isn't tracked (either never started, or evicted).
 */
export function getMeta(sessionId: string): WebSessionMeta | undefined {
	return getMap().get(sessionId);
}

/**
 * Register a fresh metadata entry for a new chat session. If an entry
 * already exists for `sessionId`, the caller is responsible for first
 * aborting + cleaning it up via `evictSession(sessionId, ...)`.
 *
 * After registering, evicts LRU-by-`lastActivityMs` until the map size
 * is at or below the cap.
 */
export function setMeta(
	sessionId: string,
	hash: string,
	service: AgentServiceLike,
	startSeq: number,
): WebSessionMeta {
	const now = Date.now();
	const meta: WebSessionMeta = {
		sessionId,
		hash,
		abort: new AbortController(),
		createdAtMs: now,
		lastActivityMs: now,
		startSeq,
	};
	const map = getMap();
	map.set(sessionId, meta);
	enforceCap(service);
	return meta;
}

/** Bump `lastActivityMs` so this session moves to the head of the LRU. */
export function touchMeta(sessionId: string): void {
	const meta = getMap().get(sessionId);
	if (meta != null) meta.lastActivityMs = Date.now();
}

/**
 * Evict a session: abort its runner, delete from AgentService, emit
 * `session.failed` so live subscribers see termination, then drop the
 * metadata entry. Safe to call when the session doesn't exist (no-op).
 *
 * Emits BEFORE delete so the bus fans the event out to subscribers
 * while the session is still in the registry.
 */
export function evictSession(sessionId: string, service: AgentServiceLike, reason: string): void {
	const map = getMap();
	const meta = map.get(sessionId);
	if (meta == null) return;
	try {
		meta.abort.abort(new Error(`evicted: ${reason}`));
	} catch {
		/* abort can throw if already aborted; swallow */
	}
	if (service.getSession(sessionId) != null) {
		try {
			service.emitFromRunner(
				sessionId,
				{ type: "session.failed", error: reason },
				{ touchActivity: true },
			);
		} catch {
			/* emit can throw if session was already deleted; swallow */
		}
		try {
			service.deleteSession(sessionId);
		} catch {
			/* delete on already-deleted session — defensive */
		}
	}
	map.delete(sessionId);
}

/**
 * Drop the LRU sessions until `size <= MAX_WEB_SESSION_META`. Each
 * evicted session goes through `evictSession` so subscribers get a
 * proper `session.failed` instead of silent disappearance.
 */
function enforceCap(service: AgentServiceLike): void {
	const map = getMap();
	if (map.size <= MAX_WEB_SESSION_META) return;
	const ordered = [...map.entries()].sort(([, a], [, b]) => a.lastActivityMs - b.lastActivityMs);
	const toEvict = map.size - MAX_WEB_SESSION_META;
	for (let i = 0; i < toEvict && i < ordered.length; i += 1) {
		const entry = ordered[i];
		if (entry == null) continue;
		const [id] = entry;
		evictSession(id, service, "session cap exceeded");
	}
}

/**
 * Compute a stable FNV-1a 32-bit hex hash over the user-role turns of
 * a UIMessage[]. Assistant messages are intentionally ignored so a
 * mid-stream reconnect (whose stored messages include a partial
 * assistant turn) still hashes to the same value as the original POST.
 *
 * 用 FNV-1a 算 user-only 消息哈希。assistant 消息(包括 partial)不计入,
 * 保证 reconnect 时同 user 输入 → 同 hash → 命中 inflight runner。
 *
 * Returns an 8-char hex string (32 bits is sufficient for in-process
 * collision avoidance — see `feedback_no_review_loophole.md` and the
 * slice-2 cross-review on the legacy `chat-session-store` hash).
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
	let h = 0x811c9dc5;
	const joined = pieces.join("\n");
	for (let i = 0; i < joined.length; i += 1) {
		h ^= joined.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * Test-only helper: wipe the global map. Used by Vitest `beforeEach`
 * to keep tests isolated.
 *
 * @internal
 */
export function _resetWebSessionMetaForTests(): void {
	globalThis.__quilin_web_session_meta__ = new Map<string, WebSessionMeta>();
}
