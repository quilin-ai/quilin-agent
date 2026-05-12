/**
 * SessionRegistry — in-memory map of session id → AgentSession snapshot.
 *
 * SessionRegistry —— session id → AgentSession 快照的 in-memory map。
 *
 * Updates are immutable: `update` returns a new `AgentSession` and replaces
 * the stored reference. Callers observe changes through the EventBus rather
 * than by holding a mutable reference.
 *
 * 更新不可变：`update` 返回一个新的 `AgentSession` 并替换内部引用。调用方
 * 通过 EventBus 感知变更，不应该持有可变引用。
 */

import type {
	AgentSession,
	CreateSessionInput,
	SessionStatus,
} from "./types.js";

export interface SessionRegistryOptions {
	readonly idGen?: () => string;
	readonly clock?: () => Date;
	readonly defaultTitle?: string;
}

export const DEFAULT_SESSION_TITLE = "(new session)";

/**
 * Patch fields a caller can apply to an existing session. Every field is
 * optional; omitted fields stay at their previous value.
 *
 * 调用方对已有 session 的可选 patch；省略的字段保持原值。
 */
export interface SessionPatch {
	readonly title?: string;
	readonly status?: SessionStatus;
	readonly turnCount?: number;
	readonly touch?: boolean;
}

export class SessionRegistry {
	private readonly sessions = new Map<string, AgentSession>();
	private readonly idGen: () => string;
	private readonly clock: () => Date;
	private readonly defaultTitle: string;
	private idCounter = 0;

	constructor(options: SessionRegistryOptions = {}) {
		this.idGen = options.idGen ?? (() => this.fallbackId());
		this.clock = options.clock ?? (() => new Date());
		this.defaultTitle = options.defaultTitle ?? DEFAULT_SESSION_TITLE;
	}

	create(input: CreateSessionInput): AgentSession {
		const id = input.id ?? this.idGen();
		if (this.sessions.has(id)) {
			throw new Error(`session id collision: ${id}`);
		}
		const nowIso = this.clock().toISOString();
		const session: AgentSession = {
			id,
			title: input.title ?? this.defaultTitle,
			origin: input.origin,
			status: "idle",
			turnCount: 0,
			createdAt: nowIso,
			lastActiveAt: nowIso,
		};
		this.sessions.set(id, session);
		return session;
	}

	get(id: string): AgentSession | null {
		return this.sessions.get(id) ?? null;
	}

	list(): readonly AgentSession[] {
		return [...this.sessions.values()];
	}

	/** Number of registered sessions. / 已注册 session 数量。 */
	size(): number {
		return this.sessions.size;
	}

	/**
	 * Apply an immutable patch and return the new snapshot. Throws if the
	 * session is unknown so callers can distinguish "session missing" from
	 * "session unchanged".
	 *
	 * 应用一个不可变 patch，返回新的快照。未知 session 抛错，调用方可以
	 * 区分"找不到 session"与"无变化"。
	 */
	update(id: string, patch: SessionPatch): AgentSession {
		const existing = this.sessions.get(id);
		if (existing == null) {
			throw new Error(`unknown session: ${id}`);
		}
		const next: AgentSession = {
			...existing,
			...(patch.title == null ? {} : { title: patch.title }),
			...(patch.status == null ? {} : { status: patch.status }),
			...(patch.turnCount == null ? {} : { turnCount: patch.turnCount }),
			...(patch.touch === true
				? { lastActiveAt: this.clock().toISOString() }
				: {}),
		};
		this.sessions.set(id, next);
		return next;
	}

	/**
	 * Remove a session by id. Returns `true` if it existed and was deleted,
	 * `false` if it wasn't registered. Does not emit any event — callers
	 * that need to notify subscribers of cancellation should emit a
	 * `session.failed` / `session.completed` via the EventBus *before*
	 * calling `delete`, otherwise subscribers may never see termination.
	 *
	 * 按 id 删除 session。返回是否真的删了。本方法不发事件,调用方需要通知
	 * 订阅者时应在 delete 前先 emit `session.failed` / `session.completed`。
	 */
	delete(id: string): boolean {
		return this.sessions.delete(id);
	}

	/**
	 * Evict the oldest-by-`lastActiveAt` sessions until the registry size
	 * is at or below `cap`. Returns the evicted ids in eviction order
	 * (oldest first). Like `delete`, this does NOT emit anything — the
	 * caller should arrange the appropriate `session.failed` / `session.completed`
	 * events before invoking eviction when subscribers are still listening.
	 *
	 * Cap below 0 is treated as 0 (evict everything). Cap >= current size
	 * is a no-op and returns `[]`.
	 *
	 * 按 lastActiveAt 升序驱逐,直到 size <= cap。返回被驱逐的 id 列表
	 * (按驱逐顺序)。不发事件,调用方负责通知订阅者。
	 */
	evictLruIfOver(cap: number): readonly string[] {
		const target = Math.max(0, cap);
		if (this.sessions.size <= target) return [];
		const ordered = [...this.sessions.entries()].sort(
			([, a], [, b]) =>
				new Date(a.lastActiveAt).getTime() - new Date(b.lastActiveAt).getTime(),
		);
		const toEvict = this.sessions.size - target;
		const evicted: string[] = [];
		for (let i = 0; i < toEvict && i < ordered.length; i += 1) {
			const entry = ordered[i];
			if (entry == null) continue;
			const [id] = entry;
			if (this.sessions.delete(id)) {
				evicted.push(id);
			}
		}
		return evicted;
	}

	private fallbackId(): string {
		this.idCounter += 1;
		const counter = this.idCounter.toString(36);
		const ms = this.clock().getTime().toString(36);
		return `sess_${ms}_${counter}`;
	}
}
