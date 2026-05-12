/**
 * AgentService types — slice 1 of QUI-15X (TUI + Web unified backend).
 *
 * AgentService 类型定义 —— QUI-15X slice 1（TUI + Web 共享后端）。
 *
 * Slice 1 introduces the in-memory event/session contracts that the TUI and
 * the control-plane HTTP server will both consume in later slices. No runtime
 * code in `repl.ts`, `control-plane/`, or `apps/web/` is touched in slice 1;
 * see `docs/00-core-loop/agent-service.md` for the full design.
 *
 * Slice 1 引入 in-memory 事件/session 契约，后续 slice 让 TUI 和控制面
 * HTTP server 都消费它。Slice 1 不动 `repl.ts`、`control-plane/`、`apps/web/`，
 * 完整设计见 `docs/00-core-loop/agent-service.md`。
 */

/** Lifecycle status of a session. / 会话生命周期状态。 */
export type SessionStatus = "idle" | "running" | "completed" | "failed";

/** Entry point that created the session. / 创建该 session 的入口。 */
export type SessionOrigin = "tui" | "web" | "api";

/**
 * Immutable snapshot of a chat session. Updates always return a new object;
 * `SessionRegistry.update` enforces this.
 *
 * 不可变的 session 快照。更新永远返回新对象，由 `SessionRegistry.update` 保证。
 */
export interface AgentSession {
	readonly id: string;
	readonly title: string;
	readonly origin: SessionOrigin;
	readonly status: SessionStatus;
	readonly turnCount: number;
	readonly createdAt: string;
	readonly lastActiveAt: string;
}

/**
 * Discriminated union of every event the AgentService can emit. Tool-call
 * `input` / `output` payload shapes are intentionally `unknown` so the event
 * log doesn't couple to a specific tool runtime; consumers narrow with their
 * own contracts.
 *
 * `AgentEventPayload` 的判别联合：覆盖 AgentService 能发的所有事件。`input` /
 * `output` 故意用 `unknown`，避免事件日志和具体工具运行时耦合。
 *
 * ## Slice 2 mapping from `LLMStreamEvent` to `AgentEventPayload`
 *
 * Slice 2 wraps the LLM client with `StreamingLLMClient` (see
 * `packages/agent-core/src/llm/client.ts`) and translates each
 * `LLMStreamEvent` into the variants below:
 *
 * | `LLMStreamEvent.type`     | `AgentEventPayload.type` | Notes                                                            |
 * |---------------------------|--------------------------|------------------------------------------------------------------|
 * | `text`                    | `llm.text`               | direct passthrough of `delta`                                    |
 * | `reasoning`               | `llm.reasoning`          | direct passthrough of `delta`                                    |
 * | `tool-call-start`         | (dropped in slice 2)     | reserved — see "future variants" below                           |
 * | `tool-call-args-delta`    | (dropped in slice 2)     | reserved — see "future variants" below                           |
 * | `tool-call-end`           | `tool.call`              | emitted with assembled `input`; slice 2 buffers args before emit |
 * | `tool-result`             | `tool.result`            | direct passthrough of `output` + `isError`                       |
 *
 * The `runAgentLoop` hooks contribute the session-level variants:
 *
 * | Hook                      | `AgentEventPayload.type` |
 * |---------------------------|--------------------------|
 * | `onAssistantMessage`      | `assistant.message`      |
 * | `onTurnComplete`          | `turn.completed`         |
 * | (loop start, sync to L3a) | `turn.started`           |
 * | (loop exit, throw caught) | `session.failed`         |
 * | (loop exit, normal)       | `session.completed`      |
 *
 * ## Future variants (additive, non-breaking)
 *
 * If slice 4's web SSE consumer needs streaming tool-call args (e.g. to show
 * "args: {city: 'San..." mid-stream), add these variants then — discriminated
 * unions are open for extension:
 *
 * - `tool.call_start` — `{ toolCallId, toolName, turnIndex }`
 * - `tool.call_args`  — `{ toolCallId, turnIndex, delta }`
 *
 * If a turn fails (vs the whole session), add `turn.failed`. Slice 1 keeps
 * the union minimal so we don't ship dead variants.
 *
 * 详细映射见上表。slice 4 若需要流式 tool args，再加 `tool.call_start` /
 * `tool.call_args`；turn 级别失败可加 `turn.failed`。判别联合可平滑扩展。
 */
export type AgentEventPayload =
	| { readonly type: "session.created"; readonly session: AgentSession }
	| { readonly type: "session.updated"; readonly session: AgentSession }
	| {
			readonly type: "turn.started";
			readonly turnIndex: number;
			readonly userText: string;
	  }
	| {
			readonly type: "llm.text";
			readonly turnIndex: number;
			readonly delta: string;
	  }
	| {
			readonly type: "llm.reasoning";
			readonly turnIndex: number;
			readonly delta: string;
	  }
	| {
			readonly type: "tool.call";
			readonly turnIndex: number;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly input?: unknown;
	  }
	| {
			readonly type: "tool.result";
			readonly turnIndex: number;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly output: unknown;
			readonly isError?: boolean;
	  }
	| {
			readonly type: "assistant.message";
			readonly turnIndex: number;
			readonly content: string;
	  }
	| { readonly type: "turn.completed"; readonly turnIndex: number }
	| { readonly type: "session.completed" }
	| { readonly type: "session.failed"; readonly error: string };

/**
 * Envelope wrapped around every payload. `seq` is monotonic across the entire
 * `AgentService` instance (not per-session) so SSE clients can resume by
 * passing the last seen seq as `afterSeq`.
 *
 * 每条 payload 都套这层信封。`seq` 在整个 `AgentService` 实例内单调递增
 * （不是 per-session），SSE 客户端断线重连时用最后一次见过的 seq 当
 * `afterSeq`。
 *
 * **Cross-process caveat**: `seq` is monotonic *within a single agent-core
 * process*. If agent-core restarts, the new EventBus starts at `seq=1` again.
 * `isReplayTruncated` alone cannot detect this gap: a client that holds
 * `lastSeq=42` from a previous process will request `afterSeq=42`, the new
 * bus has events at `seq=1..3`, and `isReplayTruncated` returns `false`
 * (since `oldest.seq=1 ≯ afterSeq+1=43`) — but the client has actually missed
 * every event from the previous process. Slice 3's `/api/v2/events` route
 * **must** attach a process-epoch discriminator (UUID generated at AgentService
 * construction) and reject resume attempts whose epoch is stale.
 *
 * **跨进程注意**：`seq` 的单调性仅在单个 agent-core 进程内有效。重启后新
 * EventBus 又从 `seq=1` 起，仅靠 `isReplayTruncated` 检不出 gap。slice 3 的
 * `/api/v2/events` 路由必须带 process-epoch（AgentService 构造时生成的 UUID），
 * 拒绝陈旧 epoch 的 resume 请求。
 */
export interface AgentEvent {
	readonly seq: number;
	readonly sessionId: string;
	readonly ts: string;
	readonly payload: AgentEventPayload;
}

export interface SubscribeOptions {
	/** When set, only events for this session are emitted. / 仅订阅指定 session。 */
	readonly sessionId?: string;
	/**
	 * Replay events from history with `seq > afterSeq` before going live. If
	 * the requested seq is older than the oldest buffered event, the iterator
	 * yields whatever history is still buffered and sets `replayTruncated: true`
	 * on the optional info channel (see `AgentSubscription.info`).
	 *
	 * 重放历史里 `seq > afterSeq` 的事件再进入 live 状态。如果请求的 seq
	 * 比缓冲里最老的还要老，迭代器只重放还在缓冲里的部分，并在可选
	 * `info` 通道上置 `replayTruncated: true`。
	 */
	readonly afterSeq?: number;
}

/** Side-channel info exposed by a subscription (lightweight; readers may ignore). */
export interface SubscriptionInfo {
	readonly replayTruncated: boolean;
}

/**
 * Async iterator + lifecycle handle returned by `AgentService.subscribe`.
 *
 * The `next()` and `return()` methods conform to the `AsyncIterator<AgentEvent,
 * undefined>` protocol: `return` accepts an optional `value` parameter (which
 * the EventBus ignores) so `for await` runtimes that call `iterator.return(
 * undefined)` on early exit type-check cleanly.
 *
 * `subscribe` 返回的异步迭代器 + 生命周期句柄。`next()` / `return()` 符合
 * `AsyncIterator<AgentEvent, undefined>` 协议：`return` 接收可选 `value`
 * 参数（EventBus 内部忽略），便于 `for await` 提前退出时传递 `undefined`
 * 也能类型检查通过。
 */
export interface AgentSubscription
	extends AsyncIterableIterator<AgentEvent, undefined> {
	/** Stop the iterator and release backpressure on the EventBus. */
	close(): void;
	/**
	 * Override `AsyncIterableIterator.return` to be required so consumers can
	 * safely call `await sub.return()` to end iteration.
	 */
	return(value?: undefined): Promise<IteratorResult<AgentEvent, undefined>>;
	/** Snapshot of side-channel info captured at construction time. */
	readonly info: SubscriptionInfo;
}

/**
 * Input to `createSession`. Title is optional and defaults to a placeholder
 * until the first user message arrives; callers can override for UX.
 *
 * `createSession` 的输入。title 可选，默认占位字符串，等首条用户消息再覆写；
 * 调用方可以预先指定以改善 UX。
 */
export interface CreateSessionInput {
	readonly origin: SessionOrigin;
	readonly title?: string;
}
