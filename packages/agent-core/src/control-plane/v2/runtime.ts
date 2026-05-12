/**
 * Runtime adapter for the v2 control-plane API.
 *
 * Routes never reach into the agent-core internals directly. Instead they
 * accept a `V2Runtime` whose methods marshal live runtime state into the
 * v2 wire shapes defined in `schemas.ts`. This keeps each route handler
 * tiny, testable in isolation (just stub the runtime), and decouples the
 * v2 API surface from the deeper data layer that powers
 * `/api/dashboard/*` (which stays running unchanged).
 *
 * v2 控制面路由从不直接访问 agent-core 内部，而是经 V2Runtime 这层
 * 适配器；每个 method 把运行时状态映射到 schemas.ts 定义的对外协议。
 * 这样每个路由处理函数都很薄、可以独立单测（stub runtime），且 v2
 * 表层与 /api/dashboard/* 共用的数据层解耦。
 */

import type {
	AgentSummary,
	AuthorizePost,
	Config,
	ConfigPatch,
	MCPRegistry,
	MemoryEntry,
	MemoryTiers,
	RuntimeSnapshot,
	SessionDetail,
	SessionsListResponseT,
	SkillsCatalog,
	SseEvent,
	ToolsCatalog,
} from "./schemas.js";

/**
 * Pagination/filter options accepted by `listSessions`. The cursor is an
 * opaque string the runtime issues; the v2 API echoes it back.
 *
 * listSessions 接收的分页/过滤参数。cursor 由 runtime 自定义。
 */
export interface ListSessionsOptions {
	readonly limit?: number;
	readonly cursor?: string | null;
}

export interface ListMemoryRecentOptions {
	readonly tier?: "working" | "episodic" | "semantic" | "skill";
	readonly limit?: number;
}

/**
 * Result of a config write — separated from the bare value so the API
 * can surface CRITICAL-write rejections without throwing.
 *
 * config 写入结果——把 CRITICAL 拒绝与异常区分开，方便 API 直接返回。
 */
export type ConfigWriteResult =
	| { readonly kind: "ok"; readonly config: Config }
	| {
			readonly kind: "forbidden";
			readonly code: "forbidden_critical_write";
			readonly message: string;
			readonly detail?: unknown;
	  };

/**
 * Result of an authorize POST — `ok` if the request was found and the
 * decision was applied, otherwise a structured error matching the spec
 * §4.13 codes.
 *
 * 授权 POST 结果——找到并处理记为 ok，否则返回结构化错误码。
 */
export type AuthorizeResult =
	| { readonly kind: "ok" }
	| {
			readonly kind: "not_found";
			readonly code: "session_not_found" | "agent_not_found";
			readonly message: string;
	  }
	| {
			readonly kind: "expired";
			readonly code: "auth_request_expired";
			readonly message: string;
	  }
	| {
			readonly kind: "already_resolved";
			readonly code: "auth_request_already_resolved";
			readonly message: string;
	  };

/**
 * Subscriber callback for SSE event streams. The runtime invokes it for
 * every observability event; v2 SSE handlers translate the call into
 * `data: <json>\n\n` writes. The returned `unsubscribe` MUST be safe to
 * call multiple times.
 *
 * SSE 订阅回调。runtime 每接到一个事件就调用一次，v2 SSE handler 负责
 * 把它转写成 `data: <json>\n\n`。unsubscribe 必须可重复调用。
 */
export type SseSubscriber = (event: SseEvent) => void;

export interface SseSubscribeOptions {
	readonly sessionId: string;
	readonly agentId?: string;
	readonly lastEventId?: string;
}

export interface SseSubscription {
	readonly unsubscribe: () => void;
	/**
	 * Optional immediate replay of events that occurred after
	 * `lastEventId` (when the client provided one) before the live
	 * stream resumes. Implementations may return an empty array.
	 *
	 * 客户端提供 lastEventId 时，可选的回放：返回断点之后的事件。
	 */
	readonly backlog?: readonly {
		readonly id: string;
		readonly event: SseEvent;
	}[];
}

/**
 * Single facade consumed by every v2 route handler. Implementations can
 * back individual methods with the existing runtime providers, with
 * stub data during tests, or with a mock during the integration test.
 *
 * v2 路由统一访问的运行时适配器。各方法可分别由真实 provider、测试
 * stub 或 mock 提供，方便单测/集成测试。
 */
export interface V2Runtime {
	getRuntimeSnapshot(): Promise<RuntimeSnapshot> | RuntimeSnapshot;

	listSessions(
		options: ListSessionsOptions,
	): Promise<SessionsListResponseT> | SessionsListResponseT;

	getSession(
		id: string,
	): Promise<SessionDetail | null> | (SessionDetail | null);

	listMemoryTiers(): Promise<MemoryTiers> | MemoryTiers;

	listMemoryRecent(
		options: ListMemoryRecentOptions,
	): Promise<readonly MemoryEntry[]> | readonly MemoryEntry[];

	listSkills(): Promise<SkillsCatalog> | SkillsCatalog;

	listTools(): Promise<ToolsCatalog> | ToolsCatalog;

	listMcp(): Promise<MCPRegistry> | MCPRegistry;

	getConfig(): Promise<Config> | Config;

	writeConfig(
		patch: ConfigPatch,
	): Promise<ConfigWriteResult> | ConfigWriteResult;

	listAgents(): Promise<readonly AgentSummary[]> | readonly AgentSummary[];

	authorize(input: AuthorizePost): Promise<AuthorizeResult> | AuthorizeResult;

	subscribeSse(
		options: SseSubscribeOptions,
		subscriber: SseSubscriber,
	): SseSubscription | Promise<SseSubscription>;
}
