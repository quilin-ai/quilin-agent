/**
 * AgentService — public entrypoint for the unified TUI + Web backend.
 *
 * AgentService —— 统一 TUI + Web 后端的公开入口。
 *
 * Slice 1 wires the in-memory `SessionRegistry` and `EventBus` together and
 * exposes the read-side API (`createSession` / `getSession` / `listSessions`
 * / `subscribe`). The `chat()` method that drives `runAgentLoop` arrives in
 * slice 2; see `docs/00-core-loop/agent-service.md`.
 *
 * Slice 1 把 in-memory 的 `SessionRegistry` 和 `EventBus` 接起来，暴露读侧
 * API（`createSession` / `getSession` / `listSessions` / `subscribe`）。
 * 驱动 `runAgentLoop` 的 `chat()` 方法留到 slice 2，见
 * `docs/00-core-loop/agent-service.md`。
 *
 * **NOT exported from `packages/agent-core/src/index.ts`** by design — slice 3
 * is the right place to add the root re-export, once `routes/chat.ts` and the
 * CLI bootstrap actually consume `AgentService`. Adding it sooner would
 * publish an internal API surface (notably the `_emit` / `_patchSession`
 * helpers below) to package consumers prematurely.
 *
 * **故意不从 `packages/agent-core/src/index.ts` 导出**：等 slice 3 控制面
 * `routes/chat.ts` 和 CLI 启动时真正用到 `AgentService` 再加 root re-export。
 * 现在导出会过早把 `_emit` / `_patchSession` 等内部 helper 暴露给包外。
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
}

export class AgentService {
	private readonly registry: SessionRegistry;
	private readonly bus: EventBus;

	constructor(options: AgentServiceOptions = {}) {
		this.registry = new SessionRegistry(options.sessionRegistry);
		this.bus = new EventBus(options.eventBus);
	}

	createSession(input: CreateSessionInput): AgentSession {
		const session = this.registry.create(input);
		this.bus.emit(session.id, { type: "session.created", session });
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
