# 交互 primitives Slice 3c — TUI integration plan

> 状态 / Status:**Plan(实施前)** · 下一 session 起步
> 写于 / Drafted:2026-05-15 autonomous run · 3a/3b 落地后
> 关联 / Related:`docs/07-safety-guardrails/interaction-primitives-spec.md` §11.3 · Slice 3a commit `7c48bc4` · Slice 3b commit `74e9f1e`

---

## 目标 / Goal

Web 端已经能完整渲染并响应 `ask_user_question` / `request_approval` / `aside` 三种交互事件。TUI 端(`packages/agent-core/src/repl.ts`)还没接 — 用 TUI 跑 agent 时,LLM 调 `ask_user_question` 工具会在 web 那边 emit 事件,但 TUI 用户看不到,只会卡 5 分钟超时。

本片把同一组事件接进 TUI 的 readline loop。

---

## 现状 / Current state

### TUI 已有(从 repl.ts 顶层 grep)

- readline 主 loop:从 stdin 读用户输入,传给 agent loop
- Subagent 状态显示
- ASCII 进度条
- Allow / deny / always-low / always-medium 已有(对 sandboxApproval 的 native flow,不是新交互 primitives)

### TUI 缺口

- 没监听 `ask_user_question` / `request_approval` / `aside` 事件
- 没把 user 通过 TUI 的回复回灌到 `pending-asks` 注册表(注:TUI 进程是不是和 web 同一进程?需要检查)

---

## 架构决策 / Architecture decision

**关键问题:TUI 跑在 agent-core 进程内,还是 web 进程内?**

- 如果跑在 agent-core 单独进程:`pending-asks` 在 web 进程,TUI 拿不到。需要走 IPC 或共享 SQLite。
- 如果 TUI 复用同一 Node 进程 + agent-service:可直接调 `registerAsk` / `resolveAsk`。

**实证手段 / How to verify:**
```bash
grep -rn "AgentService\|registerAsk\|emitFromRunner" packages/agent-core/src/repl.ts | head -10
```

如果 TUI 也用同一 `AgentService` 实例(很可能,因为 web 和 TUI 在 spec 里共用),那就是同进程,可以直接复用 pending-asks。

---

## 切分 / Slicing

### 3c.1 — TUI 事件订阅(~5M)

- 在 repl.ts 已有的 AgentService event subscription 上加 case branch:
  - `ask_user_question` → 渲染编号列表(`[1] A 方案 (更快)` / `[2] B 方案 (更稳)`)+ readline 提示
  - `request_approval` → 渲染 `Allow shell_exec(MEDIUM)? rm -rf .next/cache  [y/N/always-low/always-medium]`
  - `aside` → 用 muted italic 颜色直接 console.error 输出

### 3c.2 — TUI 用户回复回灌(~5M)

- readline 等到用户输入 → 解析(数字 / yes/no / always-*)→ 调 `resolveAsk(sessionId, askId, askToken, replyPayload)`
- askToken 哪里来:从 SSE 事件 payload 拿(同 web 路径)。TUI 也订阅到事件 → 把 askToken 缓存到 in-memory map (`askId → askToken`)

### 3c.3 — 边界 case + 测试(~5M)

- 用户 Ctrl-C → cancel readline → fire deny / timeout reply 给 pending-asks
- 同时收到多个 ask 事件 → 排队按顺序处理(不要并发提示)
- 单测:模拟事件 → readline mock 输入 → 验证 resolveAsk 调用形参

### 3c.4 — Cross-review + commit(~10M + CR)

按硬规则 2 fresh reviewer 0/0。

---

## Token 预算 / Token budget

~15-25M(主体实现 + 单测 + CR)。比 Slice 3a/3b 小,因为框架已经有了,只是 readline UX wire。

---

## 不在 scope / Out of scope

- TUI 端独立 epoch / 重连(TUI 单实例 process,不需要 reconnect)
- TUI 端的 InlineApproval "always allow" 持久化(同 web,session-scoped 内存 only)
- 给 TUI 加图标 / 颜色 / Markdown 渲染(已有 ASCII UI style 保持一致)
