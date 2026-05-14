/**
 * AgentService singleton for the web process. Lazily constructs one
 * `AgentService` per Next.js worker, cached on `globalThis` so hot
 * reload doesn't churn the in-memory session/event state.
 *
 * Why dynamic import: `@quilin/agent-core`'s dist bundle has an
 * `import.meta.url` reference to its observability dashboard assets,
 * which Turbopack's static analysis can't resolve. The same pattern
 * applied to `tools-loader` / `skills-loader` works here too.
 *
 * AgentService 单例(每个 Next.js worker 一个),globalThis 缓存让 hot
 * reload 不擦掉 session/event 状态。动态 import 是因为 agent-core dist
 * 里有 import.meta.url,Turbopack 静态分析会失败。
 *
 * Task #22 Phase 2.
 */

/**
 * Local mirrors of `@quilin/agent-core`'s exported types. agent-core
 * ships JS only (no `.d.ts` in dist), and the chat route + loaders
 * already follow this pattern. Keep these in sync with
 * `packages/agent-core/src/services/agent-service/types.ts`.
 */

export type SessionStatus = "idle" | "running" | "completed" | "failed";
export type SessionOrigin = "tui" | "web" | "api";

export interface AgentSession {
	readonly id: string;
	readonly title: string;
	readonly origin: SessionOrigin;
	readonly status: SessionStatus;
	readonly turnCount: number;
	readonly createdAt: string;
	readonly lastActiveAt: string;
	/** Task #30: parent session id when this session is a spawned subagent. */
	readonly parentId?: string;
	/** Task #30: task description for spawned subagents. */
	readonly task?: string;
}

export type AgentEventPayload =
	| { readonly type: "session.created"; readonly session: AgentSession }
	| { readonly type: "session.updated"; readonly session: AgentSession }
	| {
			readonly type: "turn.started";
			readonly turnIndex: number;
			readonly userText: string;
			readonly messageId?: string;
	  }
	| {
			readonly type: "turn.step_started";
			readonly turnIndex: number;
			readonly stepIndex: number;
	  }
	| {
			readonly type: "turn.step_completed";
			readonly turnIndex: number;
			readonly stepIndex: number;
			readonly finishReason?: string;
	  }
	| {
			readonly type: "llm.text_start";
			readonly turnIndex: number;
			readonly textPartId: string;
	  }
	| {
			readonly type: "llm.text";
			readonly turnIndex: number;
			readonly delta: string;
			readonly textPartId?: string;
	  }
	| {
			readonly type: "llm.text_end";
			readonly turnIndex: number;
			readonly textPartId: string;
	  }
	| {
			readonly type: "llm.reasoning_start";
			readonly turnIndex: number;
			readonly reasoningPartId: string;
	  }
	| {
			readonly type: "llm.reasoning";
			readonly turnIndex: number;
			readonly delta: string;
			readonly reasoningPartId?: string;
	  }
	| {
			readonly type: "llm.reasoning_end";
			readonly turnIndex: number;
			readonly reasoningPartId: string;
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
	| {
			readonly type: "turn.completed";
			readonly turnIndex: number;
			readonly finishReason?: string;
	  }
	| { readonly type: "session.completed" }
	| { readonly type: "session.failed"; readonly error: string }
	// Iter F 交互 primitives — forward-declared on the web side ahead of
	// agent-core support so the wire/translator/UI can land in parallel.
	// Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3.
	| {
			readonly type: "ask_user_question";
			readonly askId: string;
			readonly question: string;
			readonly mode: "single" | "multi" | "free_text";
			readonly options?: ReadonlyArray<{
				readonly id: string;
				readonly label: string;
				readonly description?: string;
			}>;
			readonly defaultId?: string;
			readonly timeoutMs?: number;
	  }
	| {
			readonly type: "request_approval";
			readonly askId: string;
			readonly tool: string;
			readonly riskLevel: "low" | "medium" | "high" | "critical";
			readonly summary: string;
			readonly detail?: string;
			readonly origin: "user" | "agent" | "idle";
	  }
	| {
			readonly type: "aside";
			readonly text: string;
			readonly weight?: "low" | "normal";
	  };

/**
 * Iter F 交互 primitives reply payloads — user → agent direction.
 * Delivered via POST /api/chat/answer (not over SSE, which is one-way).
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3.3.
 */
export type AgentReplyPayload =
	| {
			readonly kind: "user_answered_question";
			readonly askId: string;
			readonly answer:
				| { readonly mode: "single"; readonly selectedId: string }
				| { readonly mode: "multi"; readonly selectedIds: ReadonlyArray<string> }
				| { readonly mode: "free_text"; readonly text: string }
				| { readonly mode: "timeout" };
	  }
	| {
			readonly kind: "user_decision";
			readonly askId: string;
			readonly decision: "allow" | "deny" | "allow_always_low" | "allow_always_medium";
			readonly reason?: string;
	  };

export interface AgentEvent {
	readonly seq: number;
	readonly sessionId: string;
	readonly ts: string;
	readonly payload: AgentEventPayload;
	readonly epoch: string;
}

export interface SubscribeOptions {
	readonly sessionId?: string;
	readonly afterSeq?: number;
	readonly expectedEpoch?: string;
}

export interface SubscriptionInfo {
	readonly replayTruncated: boolean;
	readonly epochMismatch: boolean;
}

export interface AgentSubscription extends AsyncIterableIterator<AgentEvent, undefined> {
	close(): void;
	return(value?: undefined): Promise<IteratorResult<AgentEvent, undefined>>;
	readonly info: SubscriptionInfo;
}

export interface CreateSessionInput {
	readonly origin: SessionOrigin;
	readonly title?: string;
	/** Optional explicit session id; collides → throws. */
	readonly id?: string;
	/** Task #30: parent session id (subagent spawn). */
	readonly parentId?: string;
	/** Task #30: task description (subagent spawn). */
	readonly task?: string;
}

export interface EmitFromRunnerOptions {
	readonly touchActivity?: boolean;
}

export interface AgentServiceLike {
	createSession(input: CreateSessionInput): AgentSession;
	getSession(id: string): AgentSession | null;
	listSessions(): readonly AgentSession[];
	subscribe(options?: SubscribeOptions): AgentSubscription;
	currentEpoch(): string;
	/** Seq the next emitted event will receive. Caller-side "from now on" cursor. */
	currentSeq(): number;
	emitFromRunner(
		sessionId: string,
		payload: AgentEventPayload,
		options?: EmitFromRunnerOptions,
	): void;
	setSessionStatus(id: string, status: SessionStatus): AgentSession;
	deleteSession(id: string): boolean;
	getEventCount(sessionId: string): number;
}

interface AgentServiceCtor {
	new (options?: {
		readonly eventBus?: { readonly historyCapacity?: number };
		readonly maxSessions?: number;
	}): AgentServiceLike;
}

declare global {
	var __quilin_agent_service__: AgentServiceLike | undefined;
	/**
	 * In-flight construction promise. Lives on `globalThis` (not module
	 * scope) so Next.js HMR module reloads can't accidentally fork two
	 * concurrent constructions — without this, an HMR cycle that
	 * re-evaluates this module would reset module-scope state while the
	 * cached singleton still satisfies the first caller's `cached`
	 * check; a second caller post-reload would then see no inflight,
	 * import a fresh `AgentService`, and overwrite the global.
	 *
	 * 用 globalThis 保存 inflight,避免 HMR 重置 module-scope 时两个 caller
	 * 同时构造、最后写入者覆盖。对齐 tools-loader 的 race-prevention 模式。
	 */
	var __quilin_agent_service_inflight__: Promise<AgentServiceLike> | undefined;
}

/**
 * Cap on concurrent sessions in the web process. Matches the
 * `MAX_SESSIONS=200` invariant the previous `chat-session-store.ts` had,
 * so the migration to AgentService doesn't silently relax the
 * memory ceiling.
 *
 * Web 端 session 上限,对齐旧 chat-session-store 的 200,避免迁移时悄悄放宽。
 */
const WEB_MAX_SESSIONS = 200;

/**
 * Lazy load + cache. Two concurrent callers coalesce on the same
 * in-flight promise (kept on `globalThis` so HMR can't split the
 * race), and only the first one drives construction. Subsequent
 * callers either get the cached instance directly or await the
 * in-flight promise.
 */
export async function getAgentService(): Promise<AgentServiceLike> {
	const cached = globalThis.__quilin_agent_service__;
	if (cached != null) return cached;
	const inflight = globalThis.__quilin_agent_service_inflight__;
	if (inflight != null) return inflight;
	const buildPromise = buildAgentService();
	globalThis.__quilin_agent_service_inflight__ = buildPromise;
	try {
		return await buildPromise;
	} finally {
		// Only clear the inflight slot if it's still pointing at *our*
		// promise. A separate concurrent call that started after this
		// one resolved would have its own promise stored — don't stomp
		// on that.
		if (globalThis.__quilin_agent_service_inflight__ === buildPromise) {
			globalThis.__quilin_agent_service_inflight__ = undefined;
		}
	}
}

async function buildAgentService(): Promise<AgentServiceLike> {
	const mod = (await import(
		/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ "@quilin/agent-core"
	)) as { AgentService: AgentServiceCtor };
	const svc = new mod.AgentService({
		maxSessions: WEB_MAX_SESSIONS,
		eventBus: { historyCapacity: 10_000 },
	});
	globalThis.__quilin_agent_service__ = svc;
	return svc;
}

/**
 * Synchronous accessor for code paths that have already awaited
 * `getAgentService()` once at module init. Throws when the singleton
 * hasn't been constructed yet — callers must `await getAgentService()`
 * first.
 *
 * 同步访问器:调用前必须已经 await 过 getAgentService() 一次。
 */
export function getAgentServiceSync(): AgentServiceLike {
	const cached = globalThis.__quilin_agent_service__;
	if (cached == null) {
		throw new Error(
			"AgentService not yet initialized; await getAgentService() at least once first.",
		);
	}
	return cached;
}
