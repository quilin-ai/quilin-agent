/**
 * AgentService — public entrypoint for the unified TUI + Web backend.
 *
 * AgentService —— 统一 TUI + Web 后端的公开入口。
 *
 * Slice 1 wired the in-memory `SessionRegistry` and `EventBus` together and
 * exposed the read-side API (`createSession` / `getSession` / `listSessions`
 * / `subscribe`). Task #22 Phase 1 extended the public surface so the Web
 * chat route can adopt AgentService without reaching for the `_emit` /
 * `_patchSession` helpers: process-epoch UUID on every event, four public
 * mutator methods (`emitFromRunner`, `setSessionStatus`, `deleteSession`,
 * `getEventCount`), a `maxSessions` option for LRU eviction, and AI SDK v6
 * boundary variants on `AgentEventPayload`. See
 * `docs/00-core-loop/agent-service.md` for the full surface and behavioral
 * notes for SSE adapters.
 *
 * Slice 1 把 in-memory 的 `SessionRegistry` 和 `EventBus` 接起来,暴露读侧
 * API。Task #22 Phase 1 把公共写入 API 补齐(`emitFromRunner` 等),并加
 * process-epoch + LRU + AI SDK v6 边界 variant,让 Web 不再需要碰 `_emit` /
 * `_patchSession`。完整 API 与 SSE 接入注意事项见 `docs/00-core-loop/agent-service.md`。
 *
 * **Exported from `packages/agent-core/src/index.ts`** since Task #22 Phase 1
 * (re-export block in root index.ts). The `_`-prefixed helpers
 * (`_emit` / `_patchSession` / `_getEventBus` / `_getSessionRegistry`)
 * remain intra-package — they're still listed below for the existing
 * tests + slice 1 / slice 2 internal call sites, but new consumers should
 * use the public mutators instead.
 *
 * **已从 root index.ts 导出**(Task #22 Phase 1 落)。`_` 前缀 helper 仍是
 * 包内 only,新调用方用公共 mutator 即可,不要碰 `_emit` / `_patchSession`。
 */

import { EventBus, type EventBusOptions } from "./event-bus.js";
import {
	type SessionPatch,
	SessionRegistry,
	type SessionRegistryOptions,
} from "./session-registry.js";
import type {
	AgentEventPayload,
	AgentSession,
	AgentSubscription,
	CreateSessionInput,
	SessionStatus,
	SubscribeOptions,
} from "./types.js";

export type { EventBusOptions } from "./event-bus.js";
export {
	DEFAULT_HISTORY_CAPACITY,
	EventBus,
	MIN_HISTORY_CAPACITY,
} from "./event-bus.js";
export type {
	SessionPatch,
	SessionRegistryOptions,
} from "./session-registry.js";
export {
	DEFAULT_SESSION_TITLE,
	SessionRegistry,
} from "./session-registry.js";
export type {
	AgentEvent,
	AgentEventPayload,
	AgentSession,
	AgentSubscription,
	CreateSessionInput,
	SessionOrigin,
	SessionStatus,
	SubscribeOptions,
	SubscriptionInfo,
} from "./types.js";

export interface AgentServiceOptions {
	readonly eventBus?: EventBusOptions;
	readonly sessionRegistry?: SessionRegistryOptions;
	/**
	 * Optional cap on concurrent registered sessions. When set and the
	 * cap is exceeded after `createSession`, the LRU (oldest
	 * `lastActiveAt`) session(s) are evicted via the registry. Eviction
	 * does NOT emit events — callers that need to notify subscribers of
	 * cancellation should emit `session.failed` first.
	 *
	 * 并发 session 上限。createSession 后超限按 LRU 驱逐,不发事件。
	 */
	readonly maxSessions?: number;
}

/**
 * Options for `emitFromRunner`. `touchActivity: true` patches
 * `lastActiveAt` for the session, which is meant for session-level
 * boundaries (turn.started, turn.completed, assistant.message,
 * session.completed) — not for high-frequency token deltas where
 * touching every event would make `lastActiveAt ≈ now` for any active
 * session and starve LRU eviction signal.
 *
 * `emitFromRunner` 的选项。`touchActivity: true` 才会 patch lastActiveAt;
 * 高频 token delta 默认不 touch,避免 lastActiveAt 永远是 now 让 LRU 失效。
 */
export interface EmitFromRunnerOptions {
	readonly touchActivity?: boolean;
}

export class AgentService {
	private readonly registry: SessionRegistry;
	private readonly bus: EventBus;
	private readonly maxSessions: number | null;

	constructor(options: AgentServiceOptions = {}) {
		this.registry = new SessionRegistry(options.sessionRegistry);
		this.bus = new EventBus(options.eventBus);
		this.maxSessions = options.maxSessions ?? null;
	}

	createSession(input: CreateSessionInput): AgentSession {
		const session = this.registry.create(input);
		this.bus.emit(session.id, { type: "session.created", session });
		if (this.maxSessions != null) {
			// Eviction runs AFTER create so the just-created session is
			// guaranteed to survive (its lastActiveAt === now, the newest).
			this.registry.evictLruIfOver(this.maxSessions);
		}
		return session;
	}

	getSession(id: string): AgentSession | null {
		return this.registry.get(id);
	}

	listSessions(): readonly AgentSession[] {
		return this.registry.list();
	}

	subscribe(options: SubscribeOptions = {}): AgentSubscription {
		return this.bus.subscribe(options);
	}

	/**
	 * Process-epoch UUID. Stable for the lifetime of this `AgentService`
	 * instance. Clients that persist a `seq` cursor should pair it with
	 * this epoch and pass both to `subscribe` via
	 * `SubscribeOptions.expectedEpoch` so cross-process restarts are
	 * detected (the EventBus rejects the subscription with `info.epochMismatch`).
	 *
	 * 进程级 epoch UUID,实例存活期内稳定。客户端持久化 seq 时必须配 epoch,
	 * 跨进程重启 subscribe 会被拒,客户端自行重新建会话。
	 */
	currentEpoch(): string {
		return this.bus.epoch;
	}

	/**
	 * The seq value the next emitted event will receive. Useful for
	 * callers that need to bracket "events from now on" — e.g., the
	 * Web chat route captures `currentSeq()` before `createSession()`
	 * and passes the result as `subscribe({ afterSeq: startSeq - 1 })`
	 * so a sessionId that was just evicted-and-recreated doesn't
	 * replay the prior session's events that are still in the history
	 * ring buffer under the same sessionId filter.
	 *
	 * 下一条 event 将拿到的 seq。Web 路由用它在 evict+recreate 同 id session
	 * 时画一道线,subscriber 只看新 session 的 events,不复读旧 events。
	 */
	currentSeq(): number {
		return this.bus._peekNextSeq();
	}

	/**
	 * Emit an event for a session from an external runner (e.g., the web
	 * chat route's background streamText pump). Optionally touches the
	 * session's `lastActiveAt` — pass `touchActivity: true` on
	 * session-level boundaries, leave it off on high-frequency deltas
	 * (see `EmitFromRunnerOptions` rationale).
	 *
	 * Throws when the session id is unknown so the runner gets fast
	 * feedback rather than silently dropping events on the floor.
	 *
	 * 外部 runner(web chat 路由后台 pump)发事件用。session 边界 touch,
	 * token delta 不 touch。未知 session 直接抛,避免事件无声丢失。
	 */
	emitFromRunner(
		sessionId: string,
		payload: AgentEventPayload,
		options: EmitFromRunnerOptions = {},
	): void {
		if (this.registry.get(sessionId) == null) {
			throw new Error(`cannot emit for unknown session: ${sessionId}`);
		}
		this.bus.emit(sessionId, payload);
		if (options.touchActivity === true) {
			this.registry.update(sessionId, { touch: true });
			this.bus.emit(sessionId, {
				type: "session.updated",
				session: this.registry.get(sessionId) as AgentSession,
			});
		}
	}

	/**
	 * Patch session status (idle / running / completed / failed) and
	 * touch `lastActiveAt`. Emits `session.updated` so subscribers see
	 * the new snapshot. Use this on session lifecycle transitions:
	 * `running` when the runner starts, `completed` / `failed` when
	 * the runner ends.
	 *
	 * Throws on unknown session id.
	 *
	 * 切 session.status,自动 touch,发 session.updated。未知 session 抛。
	 */
	setSessionStatus(id: string, status: SessionStatus): AgentSession {
		const next = this.registry.update(id, { status, touch: true });
		this.bus.emit(next.id, { type: "session.updated", session: next });
		return next;
	}

	/**
	 * Remove a session from the registry. Subscribers waiting on
	 * `subscribe({ sessionId })` are NOT auto-notified — callers should
	 * emit `session.failed` or `session.completed` *before* calling
	 * `deleteSession` so live subscribers see termination.
	 *
	 * Returns `true` if the session existed, `false` otherwise.
	 *
	 * 删除 session。订阅者不会自动收到通知,调用方需在 delete 前 emit
	 * session.failed / session.completed。
	 */
	deleteSession(id: string): boolean {
		return this.registry.delete(id);
	}

	/**
	 * Count of buffered events in the underlying EventBus that match the
	 * given session id. Used by `/api/chat/status` and `/api/config` to
	 * report per-session activity without exposing the raw event log.
	 *
	 * 某 session 在 EventBus 缓冲里有多少条事件。给 /api/chat/status 用。
	 */
	getEventCount(sessionId: string): number {
		return this.bus.historySnapshot({ sessionId }).length;
	}

	/**
	 * Apply a session patch and emit `session.updated`. Slice 2's `chat()`
	 * uses this; exposed as a package-internal helper so slice 1 tests can
	 * cover it without standing up the full chat loop.
	 *
	 * apply patch 并发 `session.updated`。slice 2 的 `chat()` 会用到；
	 * 在 slice 1 作为包内 helper 暴露，让单测能覆盖到不依赖 chat loop。
	 *
	 * @internal Reserved for internal `agent-core` use. The `_` prefix
	 *   signals "package-private" — do not call from packages outside
	 *   `@quilin/agent-core`.
	 */
	_patchSession(id: string, patch: SessionPatch): AgentSession {
		const next = this.registry.update(id, patch);
		this.bus.emit(next.id, { type: "session.updated", session: next });
		return next;
	}

	/**
	 * Emit an arbitrary event for a session. Slice 2's `runAgentLoop` hooks
	 * call this with `llm.text`, `tool.call`, etc.
	 *
	 * 为某个 session 发任意事件。slice 2 的 `runAgentLoop` hooks
	 * 用它发 `llm.text`、`tool.call` 等。
	 *
	 * **`_emit` does NOT touch `lastActiveAt`** — token-delta events fire
	 * dozens of times per second and auto-touching would make the field
	 * essentially equal to "now" for every active session. Callers that
	 * represent meaningful activity boundaries (e.g., `turn.started`,
	 * `assistant.message`, `turn.completed`, `session.completed`) MUST
	 * explicitly call `_patchSession(id, { touch: true })` to update the
	 * timestamp. See `agent-service.test.ts > AgentService._emit > does
	 * not touch lastActiveAt` for the asserted invariant.
	 *
	 * **`_emit` 不会 touch `lastActiveAt`** —— token delta 一秒触发几十次，
	 * 自动 touch 会把字段变成"几乎等于 now"，对前端排序无意义。在表达"活动
	 * 边界"的事件上（如 `turn.started` / `assistant.message` / `turn.completed`
	 * / `session.completed`），调用方必须显式 `_patchSession(id, { touch:
	 * true })`。当前行为有单测断言（见 `AgentService._emit > does not touch
	 * lastActiveAt`）。
	 *
	 * @internal Reserved for internal `agent-core` use. The `_` prefix
	 *   signals "package-private" — do not call from packages outside
	 *   `@quilin/agent-core`.
	 */
	_emit(sessionId: string, payload: AgentEventPayload): void {
		if (this.registry.get(sessionId) == null) {
			throw new Error(`cannot emit for unknown session: ${sessionId}`);
		}
		this.bus.emit(sessionId, payload);
	}

	/**
	 * @internal Test/diagnostic accessor for the underlying bus. Not for use
	 *   by packages outside `@quilin/agent-core`.
	 */
	_getEventBus(): EventBus {
		return this.bus;
	}

	/**
	 * @internal Test/diagnostic accessor for the underlying registry. Not for
	 *   use by packages outside `@quilin/agent-core`.
	 */
	_getSessionRegistry(): SessionRegistry {
		return this.registry;
	}
}
