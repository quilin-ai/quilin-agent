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

import type { AgentReplyPayload } from "./agent-service-client.js";

const MAX_PENDING_ASKS = 1000;

interface PendingAsk {
	readonly sessionId: string;
	readonly askId: string;
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

/**
 * Register a pending ask. Returns a Promise the caller (agent runtime)
 * awaits; the Promise resolves with the user's reply when
 * `/api/chat/answer` POSTs a matching `{sessionId, askId}`, or with a
 * synthetic `{kind, mode: "timeout"}` reply if `timeoutMs` elapses first.
 *
 * 注册一个 pending ask,返回 Promise。agent runtime await 它;`/api/chat/answer`
 * 命中则 resolve 用户回复;超时 resolve 一个 timeout 占位回复。
 */
export function registerAsk(input: {
	readonly sessionId: string;
	readonly askId: string;
	readonly kind: "user_answered_question" | "user_decision";
	readonly timeoutMs?: number;
}): Promise<AgentReplyPayload> {
	const map = getMap();
	if (map.size >= MAX_PENDING_ASKS) {
		// Drop the oldest pending ask with a timeout reply to free space.
		const oldest = [...map.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
		if (oldest != null) {
			resolveAsk(oldest.sessionId, oldest.askId, syntheticTimeoutReply(oldest.askId, input.kind));
		}
	}
	return new Promise<AgentReplyPayload>((resolve) => {
		const timeoutTimer =
			input.timeoutMs != null && input.timeoutMs > 0
				? setTimeout(() => {
						resolveAsk(
							input.sessionId,
							input.askId,
							syntheticTimeoutReply(input.askId, input.kind),
						);
					}, input.timeoutMs)
				: null;
		map.set(keyFor(input.sessionId, input.askId), {
			sessionId: input.sessionId,
			askId: input.askId,
			createdAt: Date.now(),
			resolve,
			timeoutTimer,
		});
	});
}

/**
 * Look up and resolve a pending ask by `(sessionId, askId)`. Returns
 * true if a pending ask was matched + resolved, false if not (already
 * answered, timed out, or never registered).
 *
 * Called by `/api/chat/answer` POST handler.
 */
export function resolveAsk(sessionId: string, askId: string, reply: AgentReplyPayload): boolean {
	const map = getMap();
	const k = keyFor(sessionId, askId);
	const pending = map.get(k);
	if (pending == null) return false;
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
