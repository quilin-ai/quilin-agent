/**
 * EventBus — bounded, monotonic, multi-subscriber event log.
 *
 * EventBus —— 有上限、单调递增、多订阅者的事件日志。
 *
 * Each emitted event is assigned a strictly-increasing `seq` and stored in a
 * fixed-size ring buffer (default capacity 5_000). Subscribers receive events
 * through an async iterator that yields any buffered history matching their
 * filter (when `afterSeq` is set) and then live events as they arrive.
 *
 * 每条事件赋一个严格递增的 `seq`，存进固定大小的环形缓冲（默认 5_000 条上限）。
 * 订阅者通过异步迭代器拿到事件：如果设了 `afterSeq`，先吐符合过滤条件
 * 的缓冲历史，再进入 live 模式。
 *
 * The ring buffer uses a fixed-size array plus a write cursor so eviction is
 * O(1) — appending after the buffer is full overwrites the oldest entry
 * rather than shifting the entire array. With high-throughput token-delta
 * streams this avoids per-emit O(n) GC pressure (Reviewer B M4, 2026-05-12).
 *
 * 环形缓冲用固定大小数组 + 写入游标实现 O(1) 淘汰：缓冲满后直接覆盖最老条目，
 * 不再整体 shift。在高频 token delta 场景下避免每次 emit 都 O(n)（reviewer B M4）。
 *
 * **Seq monotonicity caveat**: `seq` is monotonic within a single
 * `AgentService` process. If agent-core restarts, the new EventBus starts at
 * `seq=1` again. SSE clients that hold a `seq` cursor across process restart
 * will not detect the gap from `isReplayTruncated` alone; slice 3's
 * `/api/v2/events` route MUST attach a process-epoch discriminator and reject
 * resume attempts whose epoch is stale.
 *
 * **seq 单调性注意**：`seq` 仅在单个 `AgentService` 进程内单调。agent-core
 * 重启后新 EventBus 又从 `seq=1` 起，跨进程持有 `seq` 的 SSE 客户端无法
 * 仅靠 `isReplayTruncated` 检出 gap；slice 3 的 `/api/v2/events` 路由
 * 必须附带 process-epoch 鉴别器，拒绝陈旧 epoch 的 resume。
 */

import type {
	AgentEvent,
	AgentEventPayload,
	AgentSubscription,
	SubscribeOptions,
	SubscriptionInfo,
} from "./types.js";

/** Default size of the ring buffer. / 环形缓冲默认大小。 */
export const DEFAULT_HISTORY_CAPACITY = 5_000;
/** Smallest legal capacity (below 1, replay would be meaningless). */
export const MIN_HISTORY_CAPACITY = 1;

export interface EventBusOptions {
	readonly historyCapacity?: number;
	readonly clock?: () => Date;
	/**
	 * Process-epoch UUID stamped onto every emitted event. Lets clients
	 * detect cross-process restarts that `seq` alone wouldn't catch.
	 * Defaults to `crypto.randomUUID()` at construction.
	 *
	 * agent-core 进程级 epoch UUID,每个 event 都贴这个值。客户端可以
	 * 用它检出跨进程重启的 gap。默认 `crypto.randomUUID()`。
	 */
	readonly epoch?: string;
}

type PendingResolver = (result: IteratorResult<AgentEvent, undefined>) => void;

class Subscriber implements AgentSubscription {
	private readonly queue: AgentEvent[] = [];
	private waiters: PendingResolver[] = [];
	private closed = false;
	private readonly filterSessionId: string | undefined;
	private readonly onClose: (sub: Subscriber) => void;
	readonly info: SubscriptionInfo;

	constructor(
		filterSessionId: string | undefined,
		info: SubscriptionInfo,
		onClose: (sub: Subscriber) => void,
	) {
		this.filterSessionId = filterSessionId;
		this.info = info;
		this.onClose = onClose;
	}

	matches(event: AgentEvent): boolean {
		if (this.filterSessionId == null) {
			return true;
		}
		return event.sessionId === this.filterSessionId;
	}

	push(event: AgentEvent): void {
		// No defensive `closed` guard here: `close()` calls `onClose` which
		// removes this subscriber from `EventBus.subscribers`, so `emit()` can
		// no longer reach a closed subscriber's `push`. Adding a redundant
		// guard creates an unreachable branch the test suite can't cover.
		if (!this.matches(event)) {
			return;
		}
		const waiter = this.waiters.shift();
		if (waiter == null) {
			this.queue.push(event);
			return;
		}
		waiter({ value: event, done: false });
	}

	next(): Promise<IteratorResult<AgentEvent, undefined>> {
		const buffered = this.queue.shift();
		if (buffered != null) {
			return Promise.resolve({ value: buffered, done: false });
		}
		if (this.closed) {
			return Promise.resolve({ value: undefined, done: true });
		}
		return new Promise<IteratorResult<AgentEvent, undefined>>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	/** Allow `for await (... of subscription)` syntax. */
	[Symbol.asyncIterator](): this {
		return this;
	}

	/**
	 * Conforms to `AsyncIterator.return(value?: TReturn)`. The optional
	 * `value` parameter is intentionally ignored — there is no caller-supplied
	 * return value for a generic event log, but accepting the argument keeps
	 * the signature compatible with `for await` runtimes that pass `undefined`
	 * on early exit.
	 *
	 * 兼容 `AsyncIterator.return(value?: TReturn)` 协议：`value` 参数刻意忽略，
	 * 事件日志没有调用方提供的返回值；接收该参数是为了与 `for await` 提前
	 * 退出时传递 `undefined` 的运行时保持签名一致。
	 */
	return(_value?: undefined): Promise<IteratorResult<AgentEvent, undefined>> {
		this.close();
		return Promise.resolve({ value: undefined, done: true });
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		// Drop any queued events that haven't been consumed — standard
		// async-iterator semantics: after close/return, no further values
		// are produced. Without this, a `for await` loop that closes mid-
		// iteration would still receive any events that landed in the
		// queue between the previous yield and the close call.
		this.queue.length = 0;
		// Snapshot-and-clear so the drain loop has no `undefined` case to
		// guard against and so any re-entrant close() (shouldn't happen, but
		// safe-by-construction) sees an empty waiters list.
		const pending = this.waiters;
		this.waiters = [];
		for (const waiter of pending) {
			waiter({ value: undefined, done: true });
		}
		this.onClose(this);
	}
}

export class EventBus {
	private readonly historyBuffer: (AgentEvent | undefined)[];
	private historyHead = 0;
	private historyCount = 0;
	private readonly subscribers = new Set<Subscriber>();
	private readonly historyCapacity: number;
	private readonly clock: () => Date;
	private nextSeq = 1;
	private readonly _epoch: string;

	constructor(options: EventBusOptions = {}) {
		const requested = options.historyCapacity ?? DEFAULT_HISTORY_CAPACITY;
		if (!Number.isInteger(requested) || requested < MIN_HISTORY_CAPACITY) {
			throw new Error(
				`historyCapacity must be an integer >= ${MIN_HISTORY_CAPACITY} (got ${requested})`,
			);
		}
		this.historyCapacity = requested;
		this.historyBuffer = new Array<AgentEvent | undefined>(requested);
		this.clock = options.clock ?? (() => new Date());
		this._epoch = options.epoch ?? generateEpoch();
	}

	/** Process-epoch UUID stamped onto every event this bus emits. */
	get epoch(): string {
		return this._epoch;
	}

	/**
	 * Append an event and fan it out to matching subscribers. Returns the
	 * stored `AgentEvent` so callers can record its `seq` if needed.
	 *
	 * 追加一条事件，fanout 给匹配的订阅者；返回入库的 `AgentEvent`，调用方
	 * 需要时可以读出它的 `seq`。
	 */
	emit(sessionId: string, payload: AgentEventPayload): AgentEvent {
		const event: AgentEvent = {
			seq: this.nextSeq,
			sessionId,
			ts: this.clock().toISOString(),
			payload,
			epoch: this._epoch,
		};
		this.nextSeq += 1;
		this.historyBuffer[this.historyHead] = event;
		this.historyHead = (this.historyHead + 1) % this.historyCapacity;
		if (this.historyCount < this.historyCapacity) {
			this.historyCount += 1;
		}
		// Iterate over a snapshot to defend against future maintainers who
		// might add subscriber-mutating code that runs synchronously during
		// `push` (e.g., a `push` that throws and triggers a cleanup hook
		// which removes the subscriber from `this.subscribers`). In the
		// current sync code path no such mutation occurs, so the snapshot
		// has no behavioural effect today; it is cheap defensive coding,
		// not an asserted invariant. There is no test that exercises the
		// snapshot path because no current call site can trigger mutation.
		for (const subscriber of [...this.subscribers]) {
			subscriber.push(event);
		}
		return event;
	}

	/**
	 * Synchronous snapshot of buffered events matching the filter. Used by
	 * tests and by `subscribe`'s replay phase.
	 *
	 * 同步快照：缓冲里匹配过滤条件的事件。测试和 `subscribe` 的重放阶段都用它。
	 */
	historySnapshot(options: SubscribeOptions = {}): readonly AgentEvent[] {
		const afterSeq = options.afterSeq;
		const sessionId = options.sessionId;
		const out: AgentEvent[] = [];
		// Walk from oldest to newest. When the buffer is partially full the
		// oldest entry is at index 0; once full, the oldest is at the write
		// cursor (because the cursor points at the slot the next emit will
		// overwrite).
		const start =
			this.historyCount < this.historyCapacity ? 0 : this.historyHead;
		for (let i = 0; i < this.historyCount; i += 1) {
			const idx = (start + i) % this.historyCapacity;
			const event = this.historyBuffer[idx];
			if (event == null) {
				continue;
			}
			if (afterSeq != null && event.seq <= afterSeq) {
				continue;
			}
			if (sessionId != null && event.sessionId !== sessionId) {
				continue;
			}
			out.push(event);
		}
		return out;
	}

	subscribe(options: SubscribeOptions = {}): AgentSubscription {
		// Strict epoch check: when the caller passes an `expectedEpoch` that
		// doesn't match our current `_epoch`, return a subscription that's
		// already closed and flagged. The caller's cursor is from a previous
		// agent-core process and must not be served live events from this
		// bus (the sequence numbers would be misleading). Replay history is
		// also skipped: the caller's cursor is meaningless against our log.
		if (
			options.expectedEpoch != null &&
			options.expectedEpoch !== this._epoch
		) {
			const subscriber = new Subscriber(
				options.sessionId,
				{ replayTruncated: false, epochMismatch: true },
				() => {
					/* nothing to remove — never added to subscribers set */
				},
			);
			subscriber.close();
			return subscriber;
		}
		const replayTruncated = this.isReplayTruncated(options);
		const subscriber = new Subscriber(
			options.sessionId,
			{ replayTruncated, epochMismatch: false },
			(sub) => {
				this.subscribers.delete(sub);
			},
		);
		this.subscribers.add(subscriber);
		// Push history into the subscriber's queue BEFORE returning so the
		// first `.next()` call drains history in seq order.
		for (const past of this.historySnapshot(options)) {
			subscriber.push(past);
		}
		return subscriber;
	}

	/**
	 * Number of live subscribers. Useful for tests and shutdown hooks within
	 * `@quilin/agent-core`; do not call from downstream packages.
	 *
	 * live 订阅者数量。`@quilin/agent-core` 内的测试与 shutdown 钩子可以用，
	 * 包外不要调用。
	 *
	 * @internal Reserved for internal `agent-core` use. The `_` prefix
	 *   signals "package-private" — downstream consumers must not call it.
	 */
	_subscriberCount(): number {
		return this.subscribers.size;
	}

	/**
	 * The next seq that will be assigned. Exposed for tests within
	 * `@quilin/agent-core`; production code outside the package should treat
	 * seq values as opaque cursors received via the event stream.
	 *
	 * 下一条事件将拿到的 seq。仅给 `@quilin/agent-core` 内部测试用；包外
	 * 生产代码应把 seq 视为不透明、只通过事件流接收。
	 *
	 * @internal Reserved for internal `agent-core` use.
	 */
	_peekNextSeq(): number {
		return this.nextSeq;
	}

	private isReplayTruncated(options: SubscribeOptions): boolean {
		const afterSeq = options.afterSeq;
		if (afterSeq == null) {
			return false;
		}
		// If the buffer is empty, the live stream will deliver everything
		// from here on — by definition not truncated.
		if (this.historyCount === 0) {
			return false;
		}
		const oldestIdx =
			this.historyCount < this.historyCapacity ? 0 : this.historyHead;
		const oldest = this.historyBuffer[oldestIdx];
		if (oldest == null) {
			return false;
		}
		return oldest.seq > afterSeq + 1;
	}
}

/**
 * Generate a process-epoch UUID. Uses `crypto.randomUUID()` when
 * available (Node 19+, all browsers we target) and falls back to a
 * timestamp + Math.random combo on older runtimes so unit tests don't
 * fail on environments that lack the Web Crypto global.
 *
 * `crypto.randomUUID()` 可用时直接用;否则用 ts + random fallback。
 */
function generateEpoch(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c != null && typeof c.randomUUID === "function") {
		return c.randomUUID();
	}
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 14).padEnd(12, "0");
	return `epoch-${ts}-${rand}`;
}
