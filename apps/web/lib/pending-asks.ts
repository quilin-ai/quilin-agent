/**
 * In-memory pending-ask registry — Iter F 交互 primitives wire skeleton.
 *
 * 暂存某个 session 的某个 ask 待用户回复。`ask_user_question` /
 * `request_approval` 发出时,agent runtime 把 askId 注册到这里并 await
 * 一个 Promise;POST `/api/chat/answer` 收到用户回复时按 askId 命中
 * 并 resolve 那个 Promise,agent runtime 继续。
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3.3 + §7.1
 *
 * Stored on `globalThis` so Next.js HMR doesn't churn the map between
 * dev rebuilds — matches the `web-session-meta` / `agent-service-client`
 * pattern used elsewhere in this codebase.
 *
 * NOTE Iter F Slice 1: this module ships the registry + endpoint shape.
 * The agent-runtime side (whoever calls `registerAsk` and awaits the
 * Promise) is deferred to Slice 2 when the `ask_user_question` tool +
 * `WriteAuthority.confirm` web hook land. For now this module is exercised
 * by tests + a no-op endpoint round-trip; it has no production callers
 * inside the agent loop until those land.
 *
 * Memory bounded: at most 1000 pending asks across all sessions; oldest
 * gets evicted (with timeout reply) when the cap is hit.
 */

import { randomBytes } from "node:crypto";
import type { AgentReplyPayload } from "./agent-service-client.js";

const MAX_PENDING_ASKS = 1000;
const ASK_TOKEN_BYTES = 16;

interface PendingAsk {
	readonly sessionId: string;
	readonly askId: string;
	/** Capability token bound at registration time. Must match the
	 *  ``askToken`` field on the answer POST or the answer is rejected.
	 *  Mitigates cross-session forgery in the absence of a session auth
	 *  layer (task #15). */
	readonly askToken: string;
	/** Reply shape the agent runtime is expecting. Used by the eviction
	 *  path to synthesize a correctly-shaped timeout reply for the
	 *  evicted ask (its own kind, not the incoming ask's kind). */
	readonly kind: "user_answered_question" | "user_decision";
	readonly createdAt: number;
	readonly resolve: (reply: AgentReplyPayload) => void;
	readonly timeoutTimer: ReturnType<typeof setTimeout> | null;
}

declare global {
	var __quilin_pending_asks__: Map<string, PendingAsk> | undefined;
}

function getMap(): Map<string, PendingAsk> {
	let m = globalThis.__quilin_pending_asks__;
	if (m == null) {
		m = new Map<string, PendingAsk>();
		globalThis.__quilin_pending_asks__ = m;
	}
	return m;
}

function keyFor(sessionId: string, askId: string): string {
	return `${sessionId}::${askId}`;
}

export interface RegisteredAsk {
	/** The capability token the caller must emit alongside the SSE event;
	 *  /api/chat/answer's POST body must echo this token to resolve. */
	readonly askToken: string;
	/** Promise that resolves with the user's reply, or a synthetic timeout. */
	readonly reply: Promise<AgentReplyPayload>;
}

/**
 * Register a pending ask. Returns `{askToken, reply}` — the caller
 * MUST emit the ``askToken`` to the client in the same payload as the
 * ``askId`` (so the client can echo it back), then await ``reply``.
 *
 * Mitigates cross-session forgery: even an attacker who knows the
 * sessionId + askId cannot resolve the ask without the 128-bit
 * unguessable ``askToken``. Token is generated server-side at
 * registration time and never re-emitted after that.
 *
 * 注册一个 pending ask,返回 {askToken, reply}。caller 必须把 askToken
 * 通过 SSE 推给客户端,客户端在 POST /api/chat/answer 里带回。32 hex
 * = 128 bit 不可猜,即使攻击者知道 sessionId + askId 也无法 resolve。
 */
export function registerAsk(input: {
	readonly sessionId: string;
	readonly askId: string;
	readonly kind: "user_answered_question" | "user_decision";
	readonly timeoutMs?: number;
}): RegisteredAsk {
	const map = getMap();
	if (map.size >= MAX_PENDING_ASKS) {
		// Drop the oldest pending ask with a timeout reply to free space.
		// Use the evicted ask's OWN `kind` (not the incoming `input.kind`)
		// so the synthetic timeout payload matches the shape the awaiter
		// is expecting — a `user_decision` Promise must resolve to a
		// `user_decision`-shaped reply, not a `user_answered_question`.
		const oldest = [...map.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
		if (oldest != null) {
			resolveAsk(
				oldest.sessionId,
				oldest.askId,
				oldest.askToken,
				syntheticTimeoutReply(oldest.askId, oldest.kind),
			);
		}
	}
	const askToken = randomBytes(ASK_TOKEN_BYTES).toString("hex");
	const reply = new Promise<AgentReplyPayload>((resolve) => {
		const timeoutTimer =
			input.timeoutMs != null && input.timeoutMs > 0
				? setTimeout(() => {
						resolveAsk(
							input.sessionId,
							input.askId,
							askToken,
							syntheticTimeoutReply(input.askId, input.kind),
						);
					}, input.timeoutMs)
				: null;
		map.set(keyFor(input.sessionId, input.askId), {
			sessionId: input.sessionId,
			askId: input.askId,
			askToken,
			kind: input.kind,
			createdAt: Date.now(),
			resolve,
			timeoutTimer,
		});
	});
	return { askToken, reply };
}

/**
 * Look up and resolve a pending ask by `(sessionId, askId, askToken)`.
 * Returns true if a pending ask matched (and the token verified) and
 * was resolved, false if not (already answered, timed out, never
 * registered, or token mismatch).
 *
 * Called by `/api/chat/answer` POST handler.
 *
 * Token comparison is constant-time-equivalent for short fixed-length
 * hex strings (===) — Node lacks `crypto.timingSafeEqual` for plain
 * strings without Buffer wrapping; we accept the negligible timing
 * leak because the token is 128-bit-unguessable to begin with.
 */
export function resolveAsk(
	sessionId: string,
	askId: string,
	askToken: string,
	reply: AgentReplyPayload,
): boolean {
	const map = getMap();
	const k = keyFor(sessionId, askId);
	const pending = map.get(k);
	if (pending == null) return false;
	if (pending.askToken !== askToken) return false;
	if (pending.timeoutTimer != null) clearTimeout(pending.timeoutTimer);
	map.delete(k);
	pending.resolve(reply);
	return true;
}

/**
 * Test / introspection helper — current pending count + ids.
 *
 * @internal
 */
export function snapshotPendingAsks(): ReadonlyArray<{
	readonly sessionId: string;
	readonly askId: string;
	readonly ageMs: number;
}> {
	const now = Date.now();
	return [...getMap().values()].map((p) => ({
		sessionId: p.sessionId,
		askId: p.askId,
		ageMs: now - p.createdAt,
	}));
}

/**
 * Test-only: wipe the registry. Used by Vitest `beforeEach`.
 *
 * @internal
 */
export function _resetPendingAsksForTests(): void {
	const map = getMap();
	for (const p of map.values()) {
		if (p.timeoutTimer != null) clearTimeout(p.timeoutTimer);
	}
	map.clear();
}

function syntheticTimeoutReply(
	askId: string,
	kind: "user_answered_question" | "user_decision",
): AgentReplyPayload {
	if (kind === "user_decision") {
		return { kind: "user_decision", askId, decision: "deny", reason: "timeout" };
	}
	return { kind: "user_answered_question", askId, answer: { mode: "timeout" } };
}
