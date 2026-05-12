# Linear/Plane issue draft — Unify TUI and Web behind a single AgentService

> 用法 / Usage: 把下面的 "Title" 和 "Description" 复制进 Linear（QUI workspace）或 Plane（QUILI project）新建 issue。设计文档源在 [docs/00-core-loop/agent-service.md](./agent-service.md)。

---

## Title

`feat(agent-core): unify TUI and Web behind a single in-process AgentService`

## Suggested labels

`Feature`, `agent-core`, `web`, `tui`, `architecture`

## Suggested priority

High（接续 QUI-154 Phase 1b，是 Web ↔ TUI 共享状态的前置条件）

## Description

### Why / 为什么

The TUI (`repl.ts`) and the Web UI (`apps/web/app/api/chat/route.ts`) currently each own their own chat loop with no shared in-process state. The Web UI uses the Vercel AI SDK and inline tool definitions, completely bypassing `agent-core`. As a result, a session started in the TUI is invisible to the Web, and vice versa. The user's stated requirement is **one process, one shared state**: TUI and Web are two views over the same backend (tools, memory, skills, MCP, config, *and* live sessions).

TUI（`repl.ts`）和 Web UI（`apps/web/app/api/chat/route.ts`）目前各自跑一套 chat loop，**没有** 共享 in-process state。Web UI 直接用 Vercel AI SDK + 内联工具，完全绕开 `agent-core`。所以 TUI 起的 session Web 看不到，反过来也是。用户要求 **同一进程、同一份共享 state**：TUI 和 Web 只是同一份后端（工具、记忆、skill、MCP、config，以及 live session）的两个视图。

### What / 做什么

Introduce an in-process `AgentService` singleton inside `agent-core` that owns:

- `SessionRegistry` — single source of truth for live and recent sessions.
- `EventBus` — bounded, monotonic event log with fanout to subscribers; SSE-ready.
- `chat(sessionId, message)` — thin façade calling `runAgentLoop` with the shared LLM/tools/memory/skills/MCP/config, forwarding events into `EventBus`.

The TUI and the control-plane HTTP server both consume this singleton. The Web hits a new `/api/v2/chat` control-plane route (SSE) plus a `/api/v2/events` cross-session subscription endpoint.

在 `agent-core` 内引入一个 in-process `AgentService` 单例：

- `SessionRegistry` — live 和最近 session 的唯一真相源。
- `EventBus` — 有上限、单调递增的事件日志，fanout 给订阅者；可直接转 SSE。
- `chat(sessionId, message)` — `runAgentLoop` 的薄外壳，注入共享的 LLM/工具/记忆/skill/MCP/config，把事件转给 `EventBus`。

TUI 和控制面 HTTP server 都消费这个单例。Web 走新的 `/api/v2/chat` 控制面路由（SSE）+ `/api/v2/events` 跨 session 订阅端点。

### Slicing / 切分

详见 [docs/00-core-loop/agent-service.md §Slicing](./agent-service.md#slicing--切分)。

- **Slice 1** — In-memory plumbing：`types.ts` + `event-bus.ts` + `session-registry.ts` + `index.ts` 骨架 + 单测。不动 `repl.ts`/控制面/web。
- **Slice 2** — `AgentService.chat()` 实现 + `StreamingLLMClient` 包装 + fake LLM 集成测试。
- **Slice 3** — 控制面加 `/api/v2/chat` + `/api/v2/events`；agent-core CLI 启动时注入 AgentService 单例。
- **Slice 4** — Web `/api/chat` 改 proxy；删除 `apps/web/lib/agent-registry.ts` 里的重复 tool 定义。
- **Slice 5** — `repl.ts` 改成 AgentService 客户端，订阅 EventBus 渲染终端，看见 web 起的 session。

### Acceptance / 验收

- 每个 slice 单独 commit，附 `biome check` + `tsc --noEmit` + `vitest` 结果。
- 每个 slice 走 [CLAUDE.md cross review 硬规则](../../CLAUDE.md#cross-code-review-循环硬规则--hard-rule)：2 个 fresh subagent 报 0 真实 issue 才能落库。
- 落完 slice 5 后做端到端手测：TUI 起 session A，Web `/sessions` 看见 A；Web 起 session B，TUI session list 看见 B；任一侧切入都能看到完整 message 历史和 live 流。

### Out of scope / 非目标

- 多进程 state 共享（daemon 服务多机）。
- 替换 `runAgentLoop`。
- 改造 tool / memory / skill 表面。

### Risk / 风险

- **TUI 改写规模**：slice 5 侵入大。缓解：前 4 个 slice ship 完拿到实证再动 TUI。
- **State 膨胀**：长跑 agent-core session 堆内存。slice 1 不解；slice 3 或之后加 LRU + Checkpoint 冷存。
- **单 LLM 客户端**：并发 session 共用一个 client，上游可能限流。本 issue 不解。
