# AgentService（智能体服务）/ AgentService

> Status: **Slice 1 implemented; slices 2–5 pending / Slice 1 已实现，2–5 待办**
> Owner: Rayson Meng
> Spec date: 2026-05-12
> Last touched: 2026-05-12 (in cross-review; see §Review history)
> Related: QUI-154 (Web UI rebuild), follow-on QUI-15X (this design)

## 目标 / Goal

The goal is **one agent-core process, one shared state, multiple frontends**. A session started in the TUI must be observable in the Web UI in real time, and vice versa. The TUI and the Web are two views over the same in-process `AgentService`.

目标是 **同一个 agent-core 进程，同一份共享 state，多个前端**。在 TUI 起的 session 必须能在 Web UI 实时看到，反之亦然。TUI 和 Web 只是同一份 in-process `AgentService` 的两个视图。

This document is the design source for the work tracked by the new Linear/Plane issue *Unify TUI and Web behind a single AgentService*. Each slice in the [Slicing](#slicing--切分) section lands as its own commit batch with the [cross-review hard rule](../../CLAUDE.md#cross-code-review-循环硬规则--hard-rule) applied.

本文档是 Linear/Plane 新 issue *Unify TUI and Web behind a single AgentService* 的设计源。每个 [切分](#slicing--切分) 切片各自走一组 commit，并适用 [cross review 硬规则](../../CLAUDE.md#cross-code-review-循环硬规则--hard-rule)。

## 非目标 / Non-goals

- **Multi-process state sharing.** This design assumes one agent-core process per user. Cross-process state sharing (e.g., one daemon serving multiple machines) is out of scope.
- **Replacing `runAgentLoop`.** The AgentService is a thin façade that calls `runAgentLoop`; it does not replace it.
- **New tool / memory / skill surface.** All shared subsystems (tools, memory, skills, MCP, config) keep their current interfaces.

- **多进程 state 共享。** 本设计假设单用户单 agent-core 进程，不考虑跨进程 state 共享（例如同一 daemon 服务多机）。
- **替换 `runAgentLoop`。** AgentService 是 `runAgentLoop` 的薄外壳，不替换它。
- **改造工具 / 记忆 / skill 表面。** 所有共享子系统（tools, memory, skills, MCP, config）保留现有接口。

## 现状 / Current state

Right now the TUI (`packages/agent-core/src/repl.ts`, ~3500 LOC) directly calls `runAgentLoop`. The Web (`apps/web/app/api/chat/route.ts`) bypasses `agent-core` entirely and uses the Vercel AI SDK with its own inline tool definitions. There is **no shared in-process state** between the two. The `/api/v2/*` control-plane API exposes session/memory/skills snapshots but has no chat endpoint and no event subscription beyond observability metrics.

现在 TUI（`packages/agent-core/src/repl.ts`，约 3500 行）直接调用 `runAgentLoop`。Web（`apps/web/app/api/chat/route.ts`）完全绕开 `agent-core`，用 Vercel AI SDK + 内联工具自跑。两者之间**没有共享 in-process state**。`/api/v2/*` 控制面 API 暴露 session / memory / skills 快照，但没有 chat 端点，也没有 observability 指标以外的事件订阅。

## 架构 / Architecture

```
agent-core process (single)
┌────────────────────────────────────────────────────────────────────┐
│                         AgentService (singleton)                   │
│                                                                    │
│   ┌──────────────────┐    ┌──────────────────┐                    │
│   │ SessionRegistry  │    │   EventBus       │                    │
│   │ Map<id, Session> │    │ bounded history  │                    │
│   │                  │    │ + fanout         │                    │
│   └──────────────────┘    └──────────────────┘                    │
│                                                                    │
│   Shared deps (injected once at startup):                          │
│   • LLM client    • Tools    • Memory    • Skills    • MCP        │
│   • Config        • Observer bridge                                │
│                                                                    │
│   chat(sessionId, message)  → AsyncIterable<AgentEvent>            │
│      ↓                                                             │
│      runAgentLoop(...)  → hooks fan into EventBus                  │
└────────────────────────────────────────────────────────────────────┘
        ▲                                              ▲
        │ in-process                                   │ HTTP / SSE
        │                                              │
   ┌──────────┐                            ┌────────────────────────┐
   │   TUI    │                            │  ControlPlaneServer    │
   │ ReplDvr  │                            │  /api/v2/chat (SSE)    │
   │ (slice 2)│                            │  /api/v2/events (SSE)  │
   └──────────┘                            └────────────────────────┘
                                                       ▲
                                                       │ HTTP / SSE proxy
                                                       │
                                                ┌────────────┐
                                                │  Next.js   │
                                                │  /api/chat │
                                                │  (slice 4) │
                                                └────────────┘
```

Both the TUI and the Web are clients of the same `AgentService` instance. The TUI consumes it in-process. The Web consumes it through a thin SSE proxy that the existing `apps/web/app/api/proxy/[...path]/route.ts` already supports.

TUI 和 Web 都是同一个 `AgentService` 实例的客户端。TUI 进程内直接消费，Web 通过现有的 `apps/web/app/api/proxy/[...path]/route.ts` SSE 代理消费。

## API surface（slice 1） / API surface (slice 1)

Slice 1 lands the in-memory plumbing only. It is fully testable without touching `runAgentLoop`. The `chat()` method is introduced as a type but its body comes in slice 2.

Slice 1 只落 in-memory 管线，不动 `runAgentLoop` 也能完整测。`chat()` 方法在 slice 1 已经入类型，但 body 留给 slice 2。

```typescript
export type SessionStatus = "idle" | "running" | "completed" | "failed";
export type SessionOrigin = "tui" | "web" | "api";

export interface AgentSession {
  readonly id: string;
  readonly title: string;            // first user-message snippet, or "(new session)"
  readonly origin: SessionOrigin;
  readonly status: SessionStatus;
  readonly turnCount: number;
  readonly createdAt: string;        // ISO
  readonly lastActiveAt: string;     // ISO
}

export interface AgentEvent {
  readonly seq: number;              // monotonic across the entire service instance
  readonly sessionId: string;
  readonly ts: string;               // ISO
  readonly payload: AgentEventPayload;
}

export type AgentEventPayload =
  | { readonly type: "session.created"; readonly session: AgentSession }
  | { readonly type: "session.updated"; readonly session: AgentSession }
  | { readonly type: "turn.started"; readonly turnIndex: number; readonly userText: string }
  | { readonly type: "llm.text"; readonly turnIndex: number; readonly delta: string }
  | { readonly type: "llm.reasoning"; readonly turnIndex: number; readonly delta: string }
  | { readonly type: "tool.call"; readonly turnIndex: number; readonly toolCallId: string;
      readonly toolName: string; readonly input?: unknown }
  | { readonly type: "tool.result"; readonly turnIndex: number; readonly toolCallId: string;
      readonly toolName: string; readonly output: unknown; readonly isError?: boolean }
  | { readonly type: "assistant.message"; readonly turnIndex: number; readonly content: string }
  | { readonly type: "turn.completed"; readonly turnIndex: number }
  | { readonly type: "session.completed" }
  | { readonly type: "session.failed"; readonly error: string };

export interface SubscribeOptions {
  readonly sessionId?: string;       // omit = all sessions
  readonly afterSeq?: number;        // replay events from history with seq > afterSeq, then live
}

export interface SubscriptionInfo {
  readonly replayTruncated: boolean; // true if afterSeq predates the oldest buffered event
}

export interface AgentSubscription
  extends AsyncIterableIterator<AgentEvent, undefined> {
  close(): void;
  return(value?: undefined): Promise<IteratorResult<AgentEvent, undefined>>;
  readonly info: SubscriptionInfo;   // side-channel captured at subscribe time
}

// AgentService is a CLASS (not an interface) — single in-process singleton.
export class AgentService {
  constructor(options?: AgentServiceOptions);
  createSession(input: { readonly origin: SessionOrigin; readonly title?: string }): AgentSession;
  getSession(id: string): AgentSession | null;
  listSessions(): readonly AgentSession[];
  subscribe(options?: SubscribeOptions): AgentSubscription;

  // Introduced as a typed stub in slice 1; full implementation in slice 2.
  // chat(input: { sessionId: string; userText: string }): AsyncIterable<AgentEvent>;

  // @internal helpers (slice 2 / 3 consume; downstream packages must not).
  _patchSession(id: string, patch: SessionPatch): AgentSession;
  _emit(sessionId: string, payload: AgentEventPayload): void;
  _getEventBus(): EventBus;
  _getSessionRegistry(): SessionRegistry;
}

// EventBus is also a class. Its `historySnapshot(options?)` returns a frozen
// view of the buffered events matching the filter — used by `subscribe`'s
// replay phase and by tests. Not part of the consumer-facing surface but
// exported so slice 2/3 / tests can read state.
```

### Key invariants / 关键不变量

- **Monotonic seq.** `AgentEvent.seq` is strictly increasing across all events from one `AgentService` instance. This is the resume cursor for SSE reconnects.
- **Bounded history.** `EventBus` keeps a ring buffer of the last *N* events (default 5_000). Replay older than that returns the oldest still-buffered seq plus a `replay_truncated` marker (slice 1 returns the truncation flag inline).
- **No mutation of `AgentSession`.** Every update creates a new object (per `coding-style.md` immutability rule). `SessionRegistry.update(id, patch)` returns the new snapshot.

- **seq 单调递增。** `AgentEvent.seq` 在同一个 `AgentService` 实例的所有事件中严格递增；SSE 断线重连用它做断点。
- **历史有上限。** `EventBus` 维护一个最近 *N* 条事件的环形缓冲（默认 5_000）。请求更早的会回到最老的可用 seq，并附 `replay_truncated` 标记（slice 1 行内返回截断标记）。
- **`AgentSession` 不可变。** 每次更新返回新对象（遵循 `coding-style.md` 不可变规则）。`SessionRegistry.update(id, patch)` 返回新快照。

## Slicing / 切分

Each slice ships independently with passing tests and a green cross-review.

每个 slice 各自独立 ship，附测试通过 + cross review 0 issue。

### Slice 1 — In-memory plumbing（in-memory 管线）

**Scope.** New directory `packages/agent-core/src/services/agent-service/` with `types.ts`, `event-bus.ts`, `session-registry.ts`, `index.ts`. Full unit tests. **No changes to `repl.ts`, control-plane, or web.**

**Acceptance.** 95% coverage on the four files; `biome check` + `tsc --noEmit` clean; two fresh subagent reviews report zero real issues.

**范围。** 在 `packages/agent-core/src/services/agent-service/` 下新增 `types.ts` / `event-bus.ts` / `session-registry.ts` / `index.ts`，配齐单测。**不动 `repl.ts`、控制面、web。**

**验收。** 四个文件 95% 覆盖；`biome check` + `tsc --noEmit` 干净；两个 fresh subagent review 报 0 真实 issue。

### Slice 2 — `runAgentLoop` integration（接 runAgentLoop）

**Scope.** Implement `AgentService.chat()`. Wire `runAgentLoop` hooks into `EventBus.emit`. Wrap the LLM client with `StreamingLLMClient` so token deltas reach `EventBus` as `llm.text` events. **No changes to `repl.ts` or web yet.** Add an integration test that drives a fake LLM through `chat()` and asserts the event sequence.

**范围。** 实现 `AgentService.chat()`，把 `runAgentLoop` 的 hooks 转给 `EventBus.emit`。用 `StreamingLLMClient` 包 LLM client，让 token delta 进 `EventBus` 成为 `llm.text` 事件。**还不动 `repl.ts` 和 web。** 加一个 fake-LLM 集成测试，断言事件序列。

### Slice 3 — Control-plane chat route（控制面 chat 路由）

**Scope.** Extend `V2Runtime` with an `agentService` accessor (or add a sibling `ChatRuntime` interface — to be decided in slice 3's planning). Add `routes/chat.ts` (POST → SSE) and `routes/events.ts` (GET → SSE subscribe). Wire through `router.ts` and `handler.ts`. Bootstrap the AgentService instance in the agent-core CLI entry so the control-plane has something to delegate to.

**范围。** 在 `V2Runtime` 加 `agentService` 访问点（或并列一个 `ChatRuntime` 接口，slice 3 规划时定）。加 `routes/chat.ts`（POST → SSE）和 `routes/events.ts`（GET → SSE 订阅）。串过 `router.ts` 和 `handler.ts`。在 agent-core CLI 入口初始化 AgentService 单例供控制面调用。

### Slice 4 — Web proxy + delete duplicate（Web 代理 + 删重复）

**Scope.** Rewrite `apps/web/app/api/chat/route.ts` as a thin proxy to `/api/v2/chat`. Delete the now-unused tool definitions and subagent registry from `apps/web/lib/agent-registry.ts` (or trim it to a thin client of the control-plane). Update the existing web tests.

**范围。** `apps/web/app/api/chat/route.ts` 改成 `/api/v2/chat` 的薄代理。删 `apps/web/lib/agent-registry.ts` 里现在用不到的 tool 定义和 subagent registry（或瘦身成控制面的薄客户端）。更新 web 现有测试。

### Slice 5 — TUI as a client（TUI 改造为客户端）

**Scope.** Refactor `repl.ts` to call `AgentService.chat()` instead of `runAgentLoop` directly. The TUI also subscribes to `AgentService.subscribe()` to see web-originated sessions in its session list and switch into them. This slice is the largest by LOC; it lands last so the rest of the system is already exercising the AgentService.

**范围。** 把 `repl.ts` 改成调 `AgentService.chat()` 而不是直接调 `runAgentLoop`。TUI 也订阅 `AgentService.subscribe()`，以便在 session list 看到 web 发起的 session 并切入。这个 slice LOC 最大，放最后，让前面 slice 把 AgentService 都跑过一遍再动它。

## 风险与权衡 / Risks and trade-offs

- **State explosion in long-running processes.** The EventBus ring buffer is bounded, but `SessionRegistry` is not. A long-running agent-core could accumulate thousands of sessions in memory. Slice 1 keeps it simple (one in-memory `Map`); slice 3 or later will add an LRU eviction policy backed by the existing `Checkpoint` interface for cold storage.
- **TUI rewrite scope.** Slice 5 is intrusive. We may discover that `repl.ts` has assumptions that don't fit a client-of-singleton model (e.g., synchronous tool approval prompts). The mitigation is to land slices 1–4 first, prove the model on the web side, then take slice 5 with full empirical evidence.
- **Single-LLM bottleneck.** If multiple sessions chat concurrently, they share one `LLMClient`. The current `LLMClient` is stateless per-call but the upstream API may rate-limit. Out of scope for this design; the existing observability surface already exposes provider attempts.

- **长跑进程的 state 膨胀。** EventBus 环形缓冲有上限，但 `SessionRegistry` 没有。长跑 agent-core 可能在内存里堆几千个 session。slice 1 保持简单（一个 in-memory `Map`），slice 3 或之后加 LRU + 现有 `Checkpoint` 接口做冷存。
- **TUI 改写规模。** Slice 5 侵入较大。可能发现 `repl.ts` 有不适合"单例客户端"模型的假设（例如同步的 tool approval 弹窗）。缓解办法是先 ship slice 1–4，在 web 侧把模型证起来，再带着实证去做 slice 5。
- **单 LLM 客户端瓶颈。** 多个 session 并发 chat 会共用一个 `LLMClient`。当前 `LLMClient` 每次调用无状态，但上游 API 可能限流。本设计不解决这个问题；现有 observability 表面已暴露 provider attempts。

## 验证 / Verification

- **Slice 1.** Unit tests at 95% coverage; lint + typecheck clean; cross review 0/0.
- **Slice 2.** Add integration test that runs a fake LLM emitting a known token sequence and a fake tool, asserts `AgentEvent` sequence matches expectations.
- **Slice 3.** Integration test: `curl -N localhost:PORT/api/v2/chat` followed by `curl -N /api/v2/events?session=ID` shows the same event stream.
- **Slice 4.** Existing `apps/web` Playwright tests still pass after the proxy rewrite. Manual smoke: start agent-core, start web, send a message, verify SSE deltas reach the browser.
- **Slice 5.** TUI session list shows web-originated sessions. Web `/sessions` page shows TUI-originated sessions. Switching into a session from either side shows full history.

- **Slice 1。** 95% 单测覆盖；lint + typecheck 干净；cross review 0/0。
- **Slice 2。** 加集成测试：fake LLM 吐已知 token 序列 + fake tool，断言 `AgentEvent` 序列符合预期。
- **Slice 3。** 集成测试：`curl -N localhost:PORT/api/v2/chat` 后跟 `curl -N /api/v2/events?session=ID` 看到同一条事件流。
- **Slice 4。** proxy 改写后 `apps/web` 现有 Playwright 测试照过。手测：起 agent-core、起 web、发消息，看 SSE delta 到浏览器。
- **Slice 5。** TUI session list 显示 web 起的 session；Web `/sessions` 页显示 TUI 起的 session；任一侧切入都能看到完整历史。

## Review history / 评审历史

Slice 1 converged after four cross-review rounds (8 reviewer agents total, all `typescript-reviewer`). Per CLAUDE.md's cross-review hard rule, two consecutive fresh reviewers must both report 0 real issues before landing. Round 4 (reviewers G and H) reported 0/0; the loop is closed.

Slice 1 经过 4 轮 cross review（共 8 个 `typescript-reviewer` subagent）收敛。按 CLAUDE.md 硬规则，连续两个新派 reviewer 都报告 0 真实 issue 才能落库；第 4 轮（reviewer G、H）报 0/0，循环结束。

| Round | Reviewers | Real issues found | Outcome |
|-------|-----------|-------------------|---------|
| 1 | A (types/logic), B (integration/safety) | 8 (2 HIGH, 5 MEDIUM, 1 LOW) | Fixed |
| 2 | C (verify A/B fixes), D (fresh sweep) | 6 (3 MEDIUM, 3 LOW) | Fixed |
| 3 | E (verify D fixes), F (fresh sweep) | 2 (1 MEDIUM, 1 LOW) | Fixed |
| 4 | G (verify F fixes), H (fresh sweep) | 0 | **Converged** |

The trajectory 8 → 6 → 2 → 0 was driven by structurally distinct issue classes (API surface → encapsulation → annotation consistency → none), not nitpick drift; reviewer G's round 4 assessment explicitly validated this.

### Cycle 1 (2026-05-12) — Slice 1 cross review

Slice 1 went through two parallel `typescript-reviewer` subagents (Reviewer A on types/logic/coverage, Reviewer B on integration drift/safety/API). Real issues fixed in-place: H1 (`LLMStreamEvent` → `AgentEventPayload` mapping table documented in `types.ts`), H2/M2 (internal helpers renamed with `_` prefix and `@internal` JSDoc), M1 (`history_snapshot` → `historySnapshot`), M3 (seq cross-process caveat documented), M4 (ring buffer changed to O(1) fixed-size + write cursor), Reviewer A MEDIUM (`AgentSubscription.return` signature now accepts optional `value?: undefined`), Reviewer A LOW (unreachable defensive guards removed). Round 2 found 6 more (M2 `_emit` doesn't touch `lastActiveAt` — documented + tested; M3 over-confident comment rewritten; M4/L1/L2/L3 design-doc API drift fixed). Round 3 found 2 more (M1 `EventBus._peekNextSeq`/`_subscriberCount` got `@internal` rename to match the AgentService pattern; L1 doc status line updated). Deferred items (recorded here so they don't get lost across slices):

Slice 1 经过两个并行 `typescript-reviewer` subagent 审核（A 看类型/逻辑/覆盖，B 看集成漂移/安全/API）。当场修复的真实 issue 见上一段。Round 2 又找出 6 个（M2 `_emit` 不会 touch `lastActiveAt`——文档明示 + 加测试；M3 过度乐观注释改写；M4/L1/L2/L3 设计文档 API 漂移修复）。Round 3 再找出 2 个（M1 `EventBus._peekNextSeq`/`_subscriberCount` 加 `@internal` 重命名对齐 AgentService 约定；L1 doc 状态行更新）。下列条目延后处理，记在这里防丢：

- **`turn.failed` payload variant** (Reviewer A RECOMMEND). Slice 2 will know whether `runAgentLoop` distinguishes turn-level failures from session-level failures; add the variant then if needed.
- **`turn.failed` 事件变体**（A RECOMMEND）。Slice 2 接 `runAgentLoop` 时再判断是否需要单独区分 turn 级失败。
- **`subscribe()` ordering robustness for async future** (Reviewer A SUSPECT). Current code adds the subscriber to the set before pushing history; in sync JS that's safe, but a future async `subscribe` (e.g., loading history from cold storage) would need a barrier. Re-evaluate in slice 3 when adding the SSE route.
- **`subscribe()` 异步演进的顺序鲁棒性**（A SUSPECT）。当前同步实现没问题；如果 slice 3 把 history 改成从冷存异步加载，需要补屏障。
- **Session count alert threshold** (Reviewer B R1). `SessionRegistry` has no eviction. Slice 3 should add a `console.warn` (or structlog-equivalent) when the registry passes ~1000 sessions so operators see it before memory pressure manifests.
- **Session 数量告警**（B R1）。`SessionRegistry` 无淘汰；slice 3 加日志，超过 ~1000 session 时提醒运维。
- **`maxReplayEvents` cap parameter** (Reviewer B R2). `EventBus.subscribe` pushes the entire matching history synchronously. For a reconnecting SSE client with a stale `afterSeq` on a busy bus, that's thousands of events. Slice 3's SSE route can add a per-replay cap to bound the initial spike.
- **`maxReplayEvents` 上限**（B R2）。slice 3 的 SSE 路由再加 per-replay 上限，避免重连时一次性推入数千条事件。
