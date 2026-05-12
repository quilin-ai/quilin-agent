/**
 * AgentService bridge for the TUI — Slice A read-side wiring of
 * Candidate 1 (TUI ↔ AgentService integration follow-on to Task #22).
 *
 * Slice A scope (this file): expose an in-process `AgentService`
 * singleton + read-only helpers so the TUI's `/sessions` command can
 * list sessions started anywhere in the same process (TUI itself,
 * web routes via `apps/web/lib/agent-service-client.ts`, future
 * agent-mesh consumers). No write path yet — `createSession` /
 * `emitFromRunner` / status transitions land in Slice B+.
 *
 * Why a bridge module: keeping the AgentService wiring out of the
 * 3619-line `repl.ts` makes it independently testable and gives
 * future slices a clear surface to extend without churning the main
 * REPL closure.
 *
 * Slice A:read-only AgentService 读侧桥接。让 TUI `/sessions` 命令能列出
 * 进程内任何来源(TUI/web/agent-mesh)起的 session。写侧留给 Slice B+。
 */

import {
	AgentService,
	type AgentSession,
} from "../services/agent-service/index.js";

/**
 * In-process AgentService singleton. Kept on `globalThis` so the
 * same instance survives module-level reloads (e.g., hot reload in
 * dev tools) and so web routes that also touch globalThis can share
 * state when they happen to run in the same process.
 *
 * The web side stores its instance under
 * `__quilin_agent_service__`; we deliberately reuse the SAME key so
 * a single process — even with both TUI and web Next.js worker
 * embedded — sees one AgentService. If they're truly cross-process
 * (separate `bun run quilin` + `pnpm dev` invocations), each
 * process gets its own singleton and they don't share; that's the
 * intentional single-process assumption per Candidate 1 Slice E's
 * decision-1=(e) deferral.
 *
 * `globalThis` 上的 AgentService 单例。与 web 侧 (`apps/web/lib/
 * agent-service-client.ts`) **共用同一个 key**:同进程下 TUI 和 web 看见
 * 同一个 AgentService;真跨进程时各自独立(本 slice 不解决跨进程,
 * 见 Candidate 1 决策 1=(e) 推后)。
 */
declare global {
	var __quilin_agent_service__: AgentService | undefined;
}

/**
 * Default capacity for the EventBus history ring. Matches the web
 * client's value so the two ends agree on how far back they can
 * replay when they share a process.
 */
const DEFAULT_HISTORY_CAPACITY = 10_000;
/** Default maxSessions cap (matches the web client's MAX_SESSIONS=200). */
const DEFAULT_MAX_SESSIONS = 200;

/**
 * Get or lazily construct the process-wide `AgentService` singleton.
 *
 * Idempotent and safe to call multiple times from anywhere in the
 * TUI startup path. If the web side already constructed an instance
 * earlier in the same process, we reuse it (rather than fork two
 * services, which would defeat the cross-frontend visibility DoD).
 *
 * 取/懒构造进程级 AgentService 单例。同进程任何位置反复调用都得到同一个;
 * 若 web 已先构造,直接复用。
 */
export function getOrCreateAgentService(): AgentService {
	const cached = globalThis.__quilin_agent_service__;
	if (cached != null) return cached;
	const svc = new AgentService({
		maxSessions: DEFAULT_MAX_SESSIONS,
		eventBus: { historyCapacity: DEFAULT_HISTORY_CAPACITY },
	});
	globalThis.__quilin_agent_service__ = svc;
	return svc;
}

/**
 * List every AgentSession currently held by the in-process registry.
 * Used by the TUI `/sessions` command (Slice A) to render the
 * cross-origin session list.
 *
 * Returns a readonly view — callers must not mutate. The returned
 * snapshot is current at call-time; consumers wanting live updates
 * should `service.subscribe()` (Slice D wiring).
 *
 * 列进程内所有 AgentSession。`/sessions` 命令用。Readonly 快照。
 */
export function listAgentServiceSessions(
	service: AgentService,
): readonly AgentSession[] {
	return service.listSessions();
}

/**
 * Find a single session by id. Returns `null` if no such session
 * exists (matches AgentService's existing `getSession` contract).
 *
 * 按 id 查 session,无则 null。
 */
export function findAgentServiceSession(
	service: AgentService,
	id: string,
): AgentSession | null {
	return service.getSession(id);
}
