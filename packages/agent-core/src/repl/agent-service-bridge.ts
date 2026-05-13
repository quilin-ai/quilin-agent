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

import type { LLMStreamEvent } from "../llm/types.js";
import {
	type AgentEvent,
	AgentService,
	type AgentSession,
} from "../services/agent-service/index.js";
import type { Message } from "../state/types.js";
import {
	type ReasoningDisplayMode,
	type ReplStreamRenderState,
	stringifyJson,
	summarizeInlineText,
	summarizeToolOutput,
} from "./render-shared.js";

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

/**
 * Register the TUI's resolved session id with the AgentService
 * (Candidate 1 Slice B — write-side wiring). Idempotent: if a
 * session with this id already exists in the registry — say because
 * the same id was used by an earlier `/resume` load, or because the
 * Web side already created it — we reuse the existing entry rather
 * than throwing on the registry's collision check.
 *
 * Returns the AgentSession (newly-created or pre-existing).
 *
 * Slice B:把 TUI 的 resolvedSessionId 写进 AgentService。idempotent —
 * 如果 web 先建过同 id session 或 /resume 已加载,直接复用。
 */
export function createTuiSession(
	service: AgentService,
	id: string,
	title?: string,
): AgentSession {
	const existing = service.getSession(id);
	if (existing != null) return existing;
	const safeTitle =
		title != null && title.length > 0 ? title.slice(0, 80) : undefined;
	return service.createSession({
		origin: "tui",
		id,
		...(safeTitle == null ? {} : { title: safeTitle }),
	});
}

/**
 * Patch a session's status with a defensive guard against the LRU
 * eviction race: `AgentService.setSessionStatus` throws if the
 * session is unknown (registry-side `update` throws on missing id),
 * which can happen when a high-volume process has evicted the
 * session out from under the TUI between turn boundaries. We catch
 * + log silently because the TUI doesn't have a sensible recovery
 * — the session is gone and the user is mid-turn; we don't want to
 * abort the in-flight LLM step on a metadata transition.
 *
 * Returns the updated `AgentSession` on success, or `null` when the
 * session is unknown (caller can decide whether to recreate).
 *
 * 安全 setSessionStatus:LRU 驱逐过期 session 时不抛,返 null 让调用方
 * 决定是否重建。
 */
export function markSessionStatus(
	service: AgentService,
	id: string,
	status: "idle" | "running" | "completed" | "failed",
): AgentSession | null {
	try {
		return service.setSessionStatus(id, status);
	} catch {
		return null;
	}
}

/**
 * Result of `createTurnEventPump`. The TUI plugs these into the
 * existing call sites:
 *   - `onLLMStreamEvent` wraps the `StreamingLLMClient` callback.
 *   - `onAssistantMessage` wraps the `runAgentLoop` hook.
 *   - `closePendingParts` is called at turn end (after `runAgentLoop`
 *     returns, before turn.completed) so any open text/reasoning
 *     parts are properly bracketed with their `_end` event even when
 *     `onAssistantMessage` didn't fire (e.g., tool-only turn).
 *
 * `createTurnEventPump` 的返回值。TUI 把这几个函数插进 StreamingLLMClient
 * callback / runAgentLoop hooks / 收尾。
 */
export interface TurnEventPumpHandle {
	readonly onLLMStreamEvent: (event: LLMStreamEvent) => void;
	readonly onAssistantMessage: (message: Message) => void;
	readonly closePendingParts: () => void;
}

/**
 * Create a per-turn event pump that translates the TUI's
 * `LLMStreamEvent` callbacks + `runAgentLoop` `onAssistantMessage`
 * hook into structured `AgentEventPayload` events on the in-process
 * AgentService event bus.
 *
 * Translation table (mirrors `docs/00-core-loop/agent-service.md`
 * §"Slice 2 mapping" + Web's `pumpFullStreamIntoAgentService`):
 *
 * | Source                          | Emitted AgentEventPayload    |
 * |---------------------------------|------------------------------|
 * | `text` (first in turn)          | `llm.text_start` then `llm.text` |
 * | `text` (subsequent)             | `llm.text`                   |
 * | `reasoning` (first in turn)     | `llm.reasoning_start` then `llm.reasoning` |
 * | `reasoning` (subsequent)        | `llm.reasoning`              |
 * | `tool-call-start`               | (dropped — buffered)         |
 * | `tool-call-args-delta`          | (dropped — buffered)         |
 * | `tool-call-end`                 | `tool.call` (with assembled input) |
 * | `tool-result`                   | `tool.result`                |
 * | `onAssistantMessage(message)`   | closes pending text/reasoning + emits `assistant.message` |
 *
 * Text/reasoning part ids are derived from `turnIndex` + a stable
 * suffix so multiple turns in the same session don't collide. The
 * Web side picks ids dynamically from the AI SDK's `text-start`
 * chunks; the TUI's `LLMStreamEvent` doesn't carry part ids, so we
 * synthesize them.
 *
 * **Eviction safety**: every `service.emitFromRunner` call is
 * guarded — `emitFromRunner` throws on unknown sessionId (LRU
 * eviction race). The pump swallows that silently so a mid-turn
 * eviction doesn't crash the REPL.
 *
 * 每个 turn 一个 pump。把 LLMStreamEvent + onAssistantMessage 翻译成
 * AgentEventPayload。textPartId / reasoningPartId 用 turnIndex 派生,
 * 多 turn 不冲突。emit 失败(LRU evict)静默吞掉。
 */
export function createTurnEventPump(opts: {
	readonly service: AgentService;
	readonly sessionId: string;
	readonly turnIndex: number;
}): TurnEventPumpHandle {
	const { service, sessionId, turnIndex } = opts;
	// Part-id segment counters. Each time a text/reasoning part is
	// CLOSED within the same turn (e.g. interrupted by a tool-call),
	// the counter advances so the next text/reasoning that opens uses
	// a FRESH id like `text-1-2`. This keeps the spec contract
	// "textPartId uniquely identifies one *_start..._end bracket"
	// (docs/00-core-loop/agent-service.md line 202) intact, and
	// matches Web's `pumpFullStreamIntoAgentService` step-scoped id
	// pattern so a future cross-frontend rebuild back to AI SDK SSE
	// chunks doesn't see colliding text-start ids in the same turn.
	//
	// 同 turn 内 text/reasoning part 关闭后再开 → counter 递增 → 拿新 id,
	// 不复用 → 满足 textPartId 唯一性契约,与 web pump 步级 id 模式一致。
	let textSegment = 0;
	let reasoningSegment = 0;
	let textPartId = `text-${turnIndex}-${textSegment}`;
	let reasoningPartId = `reasoning-${turnIndex}-${reasoningSegment}`;
	let textOpen = false;
	let reasoningOpen = false;

	function safeEmit(
		payload: Parameters<AgentService["emitFromRunner"]>[1],
		touchActivity = false,
	): void {
		try {
			service.emitFromRunner(sessionId, payload, { touchActivity });
		} catch {
			/* LRU evicted; session is gone — TUI continues with checkpoint */
		}
	}

	function closeText(): void {
		if (!textOpen) return;
		safeEmit({ type: "llm.text_end", turnIndex, textPartId });
		textOpen = false;
		// Advance the segment counter so the next text part within the
		// same turn (after a tool-call interrupt) opens with a fresh
		// id. Recompute textPartId eagerly so a subsequent `text` delta
		// uses the new value.
		textSegment += 1;
		textPartId = `text-${turnIndex}-${textSegment}`;
	}

	function closeReasoning(): void {
		if (!reasoningOpen) return;
		safeEmit({
			type: "llm.reasoning_end",
			turnIndex,
			reasoningPartId,
		});
		reasoningOpen = false;
		reasoningSegment += 1;
		reasoningPartId = `reasoning-${turnIndex}-${reasoningSegment}`;
	}

	return {
		onLLMStreamEvent(event: LLMStreamEvent): void {
			switch (event.type) {
				case "text": {
					if (!textOpen) {
						safeEmit({ type: "llm.text_start", turnIndex, textPartId });
						textOpen = true;
					}
					safeEmit({
						type: "llm.text",
						turnIndex,
						delta: event.delta,
						textPartId,
					});
					break;
				}
				case "reasoning": {
					if (!reasoningOpen) {
						safeEmit({
							type: "llm.reasoning_start",
							turnIndex,
							reasoningPartId,
						});
						reasoningOpen = true;
					}
					safeEmit({
						type: "llm.reasoning",
						turnIndex,
						delta: event.delta,
						reasoningPartId,
					});
					break;
				}
				case "tool-call-end": {
					// Close any open text/reasoning so the wire stays
					// well-formed: `*_start ... *_end` always bracket.
					closeText();
					closeReasoning();
					const payload: Parameters<AgentService["emitFromRunner"]>[1] = {
						type: "tool.call",
						turnIndex,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						...(event.input === undefined ? {} : { input: event.input }),
					};
					safeEmit(payload, true);
					break;
				}
				case "tool-result": {
					const payload: Parameters<AgentService["emitFromRunner"]>[1] = {
						type: "tool.result",
						turnIndex,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						output: event.output,
						...(event.isError === true ? { isError: true } : {}),
					};
					safeEmit(payload, true);
					break;
				}
				// tool-call-start / tool-call-args-delta: dropped per spec
				// (`docs/00-core-loop/agent-service.md` slice 2 mapping
				// notes: buffered, only the assembled `tool-call-end`
				// becomes a `tool.call` event).
				default:
					break;
			}
		},
		onAssistantMessage(message: Message): void {
			closeText();
			closeReasoning();
			const content =
				typeof message.content === "string" ? message.content : "";
			safeEmit({ type: "assistant.message", turnIndex, content }, true);
		},
		closePendingParts(): void {
			closeText();
			closeReasoning();
		},
	};
}

// ─────────────────────────────────────────────────────────────────────
// Slice D — Subscription-driven replay rendering
//
// `renderAgentEvent` is the AgentEvent → visible side-effect translator:
// the symmetric counterpart to the inline `renderStreamEvent` in
// `repl.ts` that handles `LLMStreamEvent`. The inline path stays the
// authoritative renderer for live turns (the StreamingLLMClient
// callback fires synchronously and writes to stdout/stderr before any
// subscription consumer could drain queued microtasks — see Slice D
// timing analysis in `docs/00-core-loop/agent-service.md`). This path
// powers the `/sessions <id>` command, which dumps a chosen session's
// AgentService history via the synchronous `historySnapshot` so the
// replay order is deterministic and free of microtask races.
//
// `runRenderSubscription` is the long-running subscription primitive
// the planner spec called out. It's not on the `/sessions <id>` hot
// path in Slice D (that path uses `historySnapshot` for determinism),
// but it's the foundation for any future "live view-mode" UX. Slice D
// ships it tested so later slices can wire it in without re-deriving
// the subscription/abort/close lifecycle.
//
// Slice D 渲染层:
//   - renderAgentEvent: AgentEvent → 渲染副作用(stdout/stderr)
//   - runRenderSubscription: 长期 subscription 原语,Slice D 只测原语,
//     /sessions <id> 用 historySnapshot 同步重放避免微任务排序漂移
// ─────────────────────────────────────────────────────────────────────

/**
 * Context for `renderAgentEvent`. stdout/stderr are injected so the
 * function is unit-testable against capture streams; displayMode and
 * renderState mirror the live-render path's parameters so visual
 * output stays in lock-step across the two paths.
 *
 * `renderAgentEvent` 上下文。stdout/stderr 通过参数注入,便于测试;
 * displayMode/renderState 与 live 渲染路径同形,保证视觉一致。
 */
export interface RenderAgentEventCtx {
	readonly stdout: { write: (chunk: string) => unknown };
	readonly stderr: { write: (chunk: string) => unknown };
	readonly displayMode: ReasoningDisplayMode;
	readonly renderState: ReplStreamRenderState;
}

/**
 * Translate an `AgentEvent` into render side-effects. Mirrors the
 * inline `renderStreamEvent` from `repl.ts` so the visual output of a
 * replay matches what a user would have seen live. Events without a
 * direct visual counterpart (turn / session lifecycle, llm.*_start /
 * llm.*_end brackets, llm.text_start / llm.text_end which only frame
 * deltas) are silently no-op.
 *
 * The `assistant.message` event triggers a trailing-newline finalize
 * pass equivalent to the live path's `finalizeStreamRender(state)`:
 * if the replayed reply emitted text without a closing `\n`, append
 * one so subsequent render output (the closing replay banner, or the
 * next prompt) does not concatenate onto the reply's last character.
 *
 * AgentEvent → 渲染副作用。与 live 路径 renderStreamEvent 对偶。无视觉
 * 对应的 event(lifecycle / *_start/*_end 框架)静默 no-op。
 * assistant.message 触发与 live 一致的 finalize(确保末尾换行)。
 */
export function renderAgentEvent(
	event: AgentEvent,
	ctx: RenderAgentEventCtx,
): void {
	const { payload } = event;
	switch (payload.type) {
		case "llm.text": {
			// Reply content goes to stdout — same channel as the inline
			// live-render path. An empty final delta is a common provider
			// pattern to flush state; ignore it for the trailing-newline
			// flag (otherwise `"".endsWith("\n") === false` would clobber
			// a previously-true flag and cause the finalize pass to write
			// a stray `\n`).
			ctx.stdout.write(payload.delta);
			if (payload.delta.length > 0) {
				ctx.renderState.hasEmittedText = true;
				ctx.renderState.lastTextEndedWithNewline = payload.delta.endsWith("\n");
			}
			break;
		}
		case "llm.reasoning": {
			if (ctx.displayMode === "verbose") {
				ctx.stderr.write(payload.delta);
				break;
			}
			if (!ctx.renderState.thinkingShown) {
				ctx.renderState.thinkingShown = true;
				ctx.stderr.write("💭 [thinking...]\n");
			}
			break;
		}
		case "tool.call": {
			// Live path reconstructs `inputText` from buffered
			// `tool-call-args-delta` chunks; in replay we only have the
			// already-assembled `input` from the `tool.call` event, so
			// stringify it here. This is the same JSON shape Slice C's
			// pump emits, so a replay of a recorded turn produces the
			// same icon line a live user would have seen — modulo the
			// streaming animation that has no replay equivalent.
			const inputText =
				payload.input == null ? "" : stringifyJson(payload.input);
			ctx.stderr.write(
				`\n🔧 calling ${payload.toolName}(${summarizeInlineText(inputText)})\n`,
			);
			break;
		}
		case "tool.result": {
			ctx.stderr.write(
				`\n${payload.isError === true ? "⚠️" : "✅"} ${payload.toolName} → ${summarizeToolOutput(payload.output)}\n`,
			);
			break;
		}
		case "assistant.message": {
			// Replay equivalent of the live `finalizeStreamRender`. The
			// live path fires it from the `onAssistantMessage` hook
			// (inside runAgentLoop, synchronous after streamText
			// completion); the replay path fires it when the recorded
			// assistant.message event is encountered.
			if (
				ctx.renderState.hasEmittedText &&
				!ctx.renderState.lastTextEndedWithNewline
			) {
				ctx.stdout.write("\n");
			}
			ctx.renderState.hasEmittedText = false;
			ctx.renderState.lastTextEndedWithNewline = false;
			// Reset `thinkingShown` at the turn boundary so subsequent
			// turns within a single `/sessions <id>` replay each get
			// their own `💭 [thinking...]` line in collapsed mode. The
			// live path resets implicitly because each turn allocates a
			// fresh `createStreamRenderState()`; the replay path runs
			// against ONE state across the whole history dump, so
			// without this reset only the first turn's reasoning is
			// visible (Slice D Reviewer A MEDIUM #1).
			ctx.renderState.thinkingShown = false;
			break;
		}
		// Lifecycle / bracketing events: intentionally no-op. The live
		// path's `renderStreamEvent` doesn't render `text-start` /
		// `text-end` / `reasoning-start` / `reasoning-end` either; we
		// mirror that so replay output matches.
		case "llm.text_start":
		case "llm.text_end":
		case "llm.reasoning_start":
		case "llm.reasoning_end":
		case "turn.started":
		case "turn.step_started":
		case "turn.step_completed":
		case "turn.completed":
		case "session.created":
		case "session.updated":
		case "session.completed":
		case "session.failed":
			break;
	}
}

/**
 * Long-running subscription primitive: drains the AgentService event
 * bus for a given sessionId in the background and invokes `onEvent`
 * for each event delivered. Returns a handle whose `close()` stops
 * the drain and returns a Promise that resolves once the background
 * task has unwound.
 *
 * Optional `afterSeq` lets callers replay history starting from a
 * specific seq cursor (mirrors `AgentService.subscribe.afterSeq`).
 * Optional `abortSignal` allows external code to tear the
 * subscription down without holding the handle (e.g., from a
 * higher-level lifecycle owner).
 *
 * Errors thrown by `onEvent` are swallowed so a single bad render
 * doesn't kill the subscription — matches the live path's tolerance
 * for callback failures.
 *
 * Slice D 起的长期 subscription 原语。后台 drain + onEvent。close()
 * 同步停止 drain。afterSeq 用于历史 cursor;abortSignal 让外部生命周期
 * 拥有方关流。onEvent 抛错被吞,避免一次渲染失败带垮整个订阅。
 */
export interface RunRenderSubscriptionOptions {
	readonly service: AgentService;
	readonly sessionId: string;
	readonly onEvent: (event: AgentEvent) => void;
	readonly afterSeq?: number;
	readonly abortSignal?: AbortSignal;
}

export interface RenderSubscriptionHandle {
	/**
	 * Stop the subscription. Idempotent; second call is a no-op.
	 * Returns a Promise that resolves when the background drain task
	 * has fully unwound (so callers can await teardown).
	 *
	 * 停止订阅。幂等。返回 Promise,resolve 后台 drain 任务结束。
	 */
	readonly close: () => Promise<void>;
}

export function runRenderSubscription(
	opts: RunRenderSubscriptionOptions,
): RenderSubscriptionHandle {
	const subscribeOptions: Parameters<AgentService["subscribe"]>[0] = {
		sessionId: opts.sessionId,
		...(opts.afterSeq == null ? {} : { afterSeq: opts.afterSeq }),
	};
	const sub = opts.service.subscribe(subscribeOptions);

	let closed = false;

	// Wire abortSignal → sub.close() so external lifecycle owners can
	// tear the subscription down without holding the handle. If the
	// signal is already aborted at construction time, close
	// immediately so the drain loop bails on first iteration.
	if (opts.abortSignal != null) {
		if (opts.abortSignal.aborted) {
			closed = true;
			sub.close();
		} else {
			opts.abortSignal.addEventListener(
				"abort",
				() => {
					if (closed) return;
					closed = true;
					sub.close();
				},
				{ once: true },
			);
		}
	}

	const drainPromise = (async () => {
		try {
			for await (const event of sub) {
				if (closed) break;
				try {
					opts.onEvent(event);
				} catch {
					/* swallow render failure — keep subscription alive */
				}
			}
		} catch {
			/* subscription threw — stop draining */
		}
	})();

	return {
		async close() {
			if (closed) {
				await drainPromise.catch(() => undefined);
				return;
			}
			closed = true;
			sub.close();
			await drainPromise.catch(() => undefined);
		},
	};
}
