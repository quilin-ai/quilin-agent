# TUI ↔ AgentService Integration / TUI 与 AgentService 集成

This document captures how the TUI (`packages/agent-core/src/repl.ts`) and the in-process `AgentService` (`packages/agent-core/src/services/agent-service/`) talk to each other after Task #29 (Candidate 1) Slices A through F landed. It complements [agent-service.md](./agent-service.md) (which covers the service API itself) by focusing on the **integration surface and lifecycle** from the TUI's perspective.

本文档描述 TUI（`packages/agent-core/src/repl.ts`）与进程内 `AgentService`（`packages/agent-core/src/services/agent-service/`）在 Task #29（候选 1）Slice A–F 落地之后的协作方式。它与 [agent-service.md](./agent-service.md)（聚焦服务 API 本身）互补，本文聚焦 TUI 视角下的**集成面与生命周期**。

## 1. The single in-process singleton / 单一进程内单例

The TUI and the web routes share **one** `AgentService` instance keyed under `globalThis.__quilin_agent_service__`. The TUI bridge's `getOrCreateAgentService()` and the web client's lookup hit the same key, so when both run inside one Node/Bun process the cross-frontend session list, history snapshot, and live event bus are unified. When the user starts the TUI and the web app as separate processes, each gets its own instance — the single-process assumption is intentional (per Slice E's decision-1 deferral).

TUI 与 web 路由共用**同一个** `AgentService` 实例，挂在 `globalThis.__quilin_agent_service__` 上。TUI 桥的 `getOrCreateAgentService()` 与 web 客户端通过同一 key 查找，因此在同一个 Node/Bun 进程里跑时，跨前端的 session 列表、history 快照、live 事件总线是统一的。当用户分别起独立的 TUI 与 web 进程时，两端各自一份实例——这是有意为之的单进程假设（见 Slice E 的决策 1=(e) 推后）。

## 2. Bridge surface / 桥接面

`packages/agent-core/src/repl/agent-service-bridge.ts` keeps the AgentService wiring out of the 3.8k-line `repl.ts`. It exposes a focused surface:

- **Read-side**: `listAgentServiceSessions`, `findAgentServiceSession` — used by the `/sessions` slash command to surface the in-process session table without leaking the `AgentService` instance.
- **Write-side (per session)**: `createTuiSession`, `markSessionStatus` — idempotent registration + safe status transitions (the `markSessionStatus` helper swallows LRU-eviction throws so mid-turn evictions don't crash the REPL).
- **Write-side (per turn)**: `createTurnEventPump` — translates `StreamingLLMClient` `LLMStreamEvent`s into the structured `AgentEventPayload` variants and emits them on the bus.
- **Read-side (replay)**: `renderAgentEvent`, `runRenderSubscription` — the symmetric direction; translates `AgentEvent`s back into render side-effects for the `/sessions <id>` replay command.

`packages/agent-core/src/repl/agent-service-bridge.ts` 把 AgentService 的接线从 3.8k 行的 `repl.ts` 里剥出来，暴露一个聚焦的对外面：

- **读侧**：`listAgentServiceSessions`、`findAgentServiceSession` — `/sessions` 斜杠命令用，列出进程内 session 表却不泄漏 `AgentService` 实例。
- **写侧（每 session）**：`createTuiSession`、`markSessionStatus` — 幂等注册 + 安全状态切换（`markSessionStatus` 会吞掉 LRU 驱逐的抛错，避免 turn 中途驱逐导致 REPL 崩溃）。
- **写侧（每 turn）**：`createTurnEventPump` — 把 `StreamingLLMClient` 的 `LLMStreamEvent` 翻译成结构化 `AgentEventPayload` 并打到总线上。
- **读侧（重放）**：`renderAgentEvent`、`runRenderSubscription` — 对偶方向；把 `AgentEvent` 翻译回渲染副作用，给 `/sessions <id>` 重放命令用。

## 3. Live render path / Live 渲染路径

Live turns render **inline** through `renderStreamEvent` (still inside `repl.ts`), driven by the `StreamingLLMClient` callback. This is the planner-authorized conservative path: the alternative — making subscription the sole render source — risked a microtask race between `streamText`'s synchronous text-delta emissions and the subscription consumer's async drain. Inline render is synchronous with the LLM stream, which is the only way to keep stdout ordering correct without an explicit drain barrier.

Live turn 用 `StreamingLLMClient` 回调驱动的内联 `renderStreamEvent`（仍在 `repl.ts` 中）。这是 planner 授权的保守路径：替代方案——让订阅成为唯一渲染源——会让 `streamText` 同步发出的 text-delta 与订阅消费者异步 drain 之间出现微任务竞争。内联渲染与 LLM 流同步，没有显式 drain 屏障也能保证 stdout 顺序正确。

In parallel with the inline render, the `createTurnEventPump` (Slice C) emits the same events to the AgentService bus so admin probes, cross-frontend consumers, and the Slice D replay path all see the same event history.

与内联渲染并行，`createTurnEventPump`（Slice C）把同样的事件打到 AgentService 总线上，所以 admin probe、跨前端消费方、Slice D 的重放路径看到的是同一份事件历史。

## 4. `/sessions <id>` replay / `/sessions <id>` 重放

The TUI `/sessions <id>` command uses `historySnapshot({ sessionId })` (synchronous) + `renderAgentEvent` to dump a chosen session's recorded events to stdout/stderr. The replay is deterministic — order matches recording order exactly, no microtask boundaries between events. It works for sessions of any origin (TUI / web / API), so a user investigating a web chat from the TUI sees the same visual output the web user saw live, modulo the streaming animation.

TUI 的 `/sessions <id>` 命令用同步的 `historySnapshot({ sessionId })` + `renderAgentEvent` 把所选 session 的历史事件 dump 到 stdout/stderr。重放确定性强——顺序与录制顺序完全一致，事件之间没有微任务边界。任意来源的 session（TUI / web / API）都能重放，所以从 TUI 调查 web 会话时，用户看到的视觉输出与 web 用户的 live 视图等价（除了流式动画无重放对应）。

The `runRenderSubscription` primitive (also Slice D) is a long-running subscription wrapper built for future view-mode UX (where the TUI would live-track a chosen session's events). It is tested in `agent-service-bridge.test.ts` but is **not** wired into `/sessions <id>` in Slice D — the synchronous `historySnapshot` path is sufficient for the "look back at this session" semantic and avoids the subscription concurrency surface entirely.

`runRenderSubscription` 原语（同样 Slice D）是为未来的"view-mode"UX（TUI 实时跟随选中 session 的事件）准备的长期订阅包装器。已在 `agent-service-bridge.test.ts` 测过，但 Slice D 没有把它接到 `/sessions <id>` 上——同步 `historySnapshot` 路径对"回看一个 session"的语义已经够用，且完全避开了订阅并发面。

## 5. Lifecycle per TUI turn / 每 TUI turn 的生命周期

```
user input → /sessions list / replay branch?  ─yes→ branch handler runs, continue
            ↓ no
            messages.push({ role: "user", content })
            markSessionStatus(svc, sid, "running")
            emit {turn.started, turnIndex, userText}
            pump = createTurnEventPump({service, sessionId, turnIndex})
            ╭─ await runAgentLoop(…)  ─→ StreamingLLMClient callback fires:
            │                            renderStreamEvent(event, …)       ← inline live render
            │                            pump.onLLMStreamEvent(event)      ← emits llm.* on bus
            │                          onAssistantMessage hook fires:
            │                            finalizeStreamRender(state)       ← inline newline
            │                            pump.onAssistantMessage(message)  ← emits assistant.message
            ↓
            emit {turn.completed, turnIndex}
            (catch) markSessionStatus(svc, sid, "failed")
            (finally) pump.closePendingParts()
                      if status was "running": markSessionStatus(svc, sid, "idle")
```

A failed turn emits `markSessionStatus → failed` plus the in-flight pump's `closePendingParts` (so any open `llm.text_start` / `llm.reasoning_start` are properly closed with their `_end` event). The session itself stays in the registry; the next user input transitions it back to `running`.

失败的 turn 会发 `markSessionStatus → failed`，并触发 pump 的 `closePendingParts`（让中途打开的 `llm.text_start` / `llm.reasoning_start` 能用对应 `_end` 事件闭合）。session 本身留在 registry 中，下一次用户输入会把它切回 `running`。

## 6. Where to look next / 下一步该看哪里

| Concern / 关注点 | File / 文件 |
|---|---|
| Service API + history buffer / 服务 API + 历史缓冲 | [agent-service.md](./agent-service.md) |
| Live render translation / Live 渲染翻译 | `packages/agent-core/src/repl.ts` `renderStreamEvent` |
| Replay render translation / 重放渲染翻译 | `packages/agent-core/src/repl/agent-service-bridge.ts` `renderAgentEvent` |
| Per-turn pump / 每 turn pump | `packages/agent-core/src/repl/agent-service-bridge.ts` `createTurnEventPump` |
| Shared render helpers / 共享渲染辅助 | `packages/agent-core/src/repl/render-shared.ts` |
| Web-side mirror / Web 端镜像 | `apps/web/lib/sse-translator.ts` (forward + reverse pump) |
| Cross-frontend integration test / 跨前端集成测试 | `packages/agent-core/src/services/agent-service/integration.test.ts` |
| Web meta + LRU + reconnect / Web 元数据 + LRU + 重连 | `apps/web/lib/web-session-meta.ts` |
