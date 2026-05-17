# Agent 交互 Primitive 设计 / Agent Interaction Primitives Design

> 状态:✅ **已实施 / Shipped** · Iter F 收尾 2026-05-15/18
> 实施 commit:`5ec2192`（wire 骨架）+ `44edf95`（UI 组件）+ `7c48bc4`（ask_user_question tool）+ `74e9f1e`（request_approval Path A）+ `b7c0f02`（TUI-native ask/approval tools）+ `43e5f76`+`9b605e6`（Path B server-side gate on shell_exec）+ `83b81d5`（narrate_aside tool）+ `f06d5ad`（iter-close polish:Skill watcher leak / summary XSS truncate / mid-flight invalidate / listener teardown / sync throw / subagent path wrap)
> 触发来源:用户指令 2026-05-13/14 — 实际使用时发现 agent 说"需要交互式确认"但 web/TUI 没有对应的协议通道
> 关联待办:`docs/15-introspection/web-ux-backlog.md` UX-3(旁白 channel,本 spec 已实现统一 wire);`docs/07-safety-guardrails/README.md` §2.6 WriteAuthority gate(本 spec 已把它从 readline-only 升级成跨前端 wire-driven primitive)

> Status: ✅ **Shipped** · Iter F close-out 2026-05-15/18
> Shipping commits: `5ec2192` (wire skeleton) + `44edf95` (UI components) + `7c48bc4` (ask_user_question tool) + `74e9f1e` (request_approval Path A) + `b7c0f02` (TUI-native ask/approval tools) + `43e5f76`+`9b605e6` (Path B server-side gate on shell_exec) + `83b81d5` (narrate_aside tool) + `f06d5ad` (iter-close polish)
> Trigger: user directive 2026-05-13/14 — real usage surfaced "agent says 'requires interactive confirmation' but the web/TUI has no wire channel for it"
> Related: `docs/15-introspection/web-ux-backlog.md` UX-3 (aside channel; unified wire shipped); `docs/07-safety-guardrails/README.md` §2.6 WriteAuthority gate (now wire-driven cross-frontend, no longer readline-only)

---

## 1. 问题陈述 / Problem Statement

English: The current Quilin agent has no way to ask the user a structured question, present a multi-choice menu, or request inline approval through either web or TUI in a uniform way. The closest primitives are:

中文:目前的 Quilin agent 在 web 和 TUI 上**没有任何统一的方式**结构化提问 / 列多选选项 / 内联请求批准。最接近的两个 primitive 是:

| Existing primitive 现有 primitive | Where 在哪里 | What it does 干什么 | Gap 差距 |
|---|---|---|---|
| `WriteAuthority` confirm hook | `packages/agent-core/src/safety/write-authority.ts` | y/N approval for write/exec tools | TUI only(readline 阻塞);web 端没接入;只支持 binary,不能多选 |
| TUI readline `Allow? [y/N/always-low/always-medium]` | `packages/agent-core/src/repl.ts:2524` | Inline TUI prompt | 只在 TUI;阻塞 readline 不是 stream-aware,跟主对话流冲突 |
| Streaming text/tool parts | AI SDK v6 SSE | Agent → user 单向输出 | 没有反向通道,agent 无法等用户的结构化输入 |

English: This blocks four product capabilities outright:

中文:这个 gap 直接挡住了四个产品能力:

1. **澄清式提问 / Clarification questions** — agent 不确定用户意图时,目前只能在 text 里写"请告诉我 X 还是 Y",用户用自由文本回,agent 再解析。结构化选项 + 单击响应做不到。
2. **批准 critical 操作 / Critical-operation approval** — `shell_exec` / `file_write` 跨项目根 / `git push --force` / 数据库迁移 / scaffold patch 等 CRITICAL 操作需要用户当场点 allow/deny。web 上完全没接(用户报告的"write request requires interactive confirmation" 错误就是这个 gap 的暴露);TUI 上是阻塞 readline,跟流式回答冲突。
3. **多选场景 / Multi-choice scenarios** — "用 A 还是 B 还是 C 方案?" / "你要的是这五个文件里的哪一个?" 都得让 agent 自己组织成 markdown 列表然后让用户复制回答,体验糟。
4. **`旁白 / aside` channel** — UX-3 backlog 项。agent 的元层叙述("我正在考虑 X / 我接下来 Y") 与主回答混在 text part 里污染输出。它在 wire 设计上跟 ask/approval 共享同一个 AgentEvent 扩展点,放一起设计才不重复劳动。

---

## 2. 范围 / Scope

### In scope(本 spec 必交付)

English:
1. Three new AgentEvent types: `ask_user_question`, `request_approval`, `aside`.
2. Two user-reply event types: `user_answered_question`, `user_decision`.
3. A new agent-core tool `ask_user_question(question, mode, options?)` callable by the LLM.
4. Refactor `WriteAuthority.confirm` to emit a `request_approval` event when the host provides a wire-driven confirm hook (web), keeping the legacy readline path as a TUI-specific implementation of the same interface.
5. Wire mapping: each new AgentEvent → AI SDK v6 UIMessage custom data part with a stable type name.
6. Web UI:
   - `<InlineQuestion>` component rendering single-select / multi-select / free-form input
   - `<InlineApproval>` component with allow/deny + "always-allow this risk level" options
   - `<AsidePart>` de-emphasized rendering
   - POST `/api/chat/answer` endpoint receiving the user's reply with `(sessionId, askId, answer)` shape
7. TUI:
   - When the agent emits `ask_user_question`, the REPL renders a structured prompt (still readline-based but with multi-option support beyond y/N)
   - `request_approval` keeps the existing readline gate, now sourced from the same primitive
8. Resumption semantics: an ask suspends the streaming agent. The agent waits for the answer event before continuing. Timeout policy: 5 minutes default, configurable per ask.
9. Audit: every `request_approval` decision is logged via the existing `WriteAuthority.auditLog` hook.
10. Test plan covering primitive emission, web answer round-trip, TUI fallback, timeout, reconnect-mid-ask.

中文:
1. 三个新 AgentEvent 类型:`ask_user_question`、`request_approval`、`aside`。
2. 两个用户回复事件类型:`user_answered_question`、`user_decision`。
3. agent-core 加新工具 `ask_user_question(question, mode, options?)` 给 LLM 主动调。
4. 重构 `WriteAuthority.confirm`:宿主提供 wire-driven confirm hook 时(web 端)发 `request_approval` 事件;TUI 保留 readline 路径作为同一接口的特化实现。
5. Wire 映射:每个新 AgentEvent → AI SDK v6 UIMessage 自定义 data part(类型名稳定)。
6. Web UI:
   - `<InlineQuestion>` 组件渲染 单选 / 多选 / 自由文本输入
   - `<InlineApproval>` 组件含 allow/deny + "本次会话以下都自动 allow 这个风险等级" 选项
   - `<AsidePart>` 弱视觉权重渲染
   - 新 POST `/api/chat/answer` endpoint 收用户回复,shape `(sessionId, askId, answer)`
7. TUI:
   - agent 发 `ask_user_question` 时,REPL 渲染结构化 prompt(还是 readline 但支持多选不只是 y/N)
   - `request_approval` 保留现有 readline gate,改成从同一 primitive 来
8. 暂停语义:发出 ask 后流式 agent 暂停,等用户回复事件再继续。超时默认 5 分钟,每个 ask 可配。
9. 审计:每条 `request_approval` 决策通过现有 `WriteAuthority.auditLog` 钩子记日志。
10. 测试计划覆盖 primitive 发出、web 端回复闭环、TUI 回退、超时、ask 期间重连。

### Out of scope(本 spec 不做)

English:
- **Cross-session ask** — an ask must be answered in the same session it was emitted. Carrying open asks across sessions is a multi-session UX problem.
- **Voice / non-text inputs** — text and option-button replies only.
- **Approval persistence across processes** — if the Node process restarts during an ask, the ask is lost and the agent re-asks on next turn. Persisting open asks to SQLite is deferred.
- **Permission templates / policies** — "always allow `ls`" / "auto-deny anything in `/etc`" are part of the `WriteAuthority.mode` mechanism that's already implemented; this spec does not add per-pattern policy editing.

中文:
- **跨 session 的 ask** —— ask 必须在它被发出的同一 session 内回答。把 open ask 跨 session 传递是多 session UX 问题。
- **语音 / 非文本输入** —— 只支持文本和选项按钮回复。
- **跨进程的 approval 持久化** —— Node 进程在 ask 期间重启,这个 ask 就丢,agent 下一轮重问。把 open ask 持久化到 SQLite 留到后续。
- **批准模板 / 策略** —— "始终 allow `ls`" / "自动拒绝 `/etc` 下的写" 是现有 `WriteAuthority.mode` 机制管的事;本 spec 不加 per-pattern 策略编辑。

---

## 3. AgentEvent 类型与 wire / AgentEvent Types & Wire

### 3.1 三个新 AgentEvent 类型 / Three new AgentEvent types

```ts
// packages/agent-core/src/services/agent-service/types.ts

export type AgentEventPayload =
    | { kind: "text-delta"; ... }       // existing
    | { kind: "tool-call"; ... }         // existing
    | { kind: "tool-result"; ... }       // existing
    // NEW:
    | {
        kind: "ask_user_question";
        readonly askId: string;          // ULID, used for the reply
        readonly question: string;       // markdown allowed
        readonly mode: "single" | "multi" | "free_text";
        readonly options?: ReadonlyArray<{
            readonly id: string;
            readonly label: string;
            readonly description?: string;
        }>;
        readonly defaultId?: string;     // pre-selected option id
        readonly timeoutMs?: number;     // 0 → no timeout (use server default 5min)
    }
    | {
        kind: "request_approval";
        readonly askId: string;          // ULID
        readonly tool: string;           // 'shell_exec', 'file_write', ...
        readonly riskLevel: "low" | "medium" | "high" | "critical";
        readonly summary: string;        // one-line natural-language description
        readonly detail?: string;        // optional full payload
        readonly origin: "user" | "agent" | "idle";
    }
    | {
        kind: "aside";
        readonly text: string;           // markdown allowed
        readonly weight?: "low" | "normal";  // "low" by default — italic / dim
    };

export type AgentReplyPayload =
    | {
        kind: "user_answered_question";
        readonly askId: string;
        readonly answer:
            | { mode: "single"; selectedId: string }
            | { mode: "multi"; selectedIds: ReadonlyArray<string> }
            | { mode: "free_text"; text: string }
            | { mode: "timeout" };
      }
    | {
        kind: "user_decision";
        readonly askId: string;
        readonly decision: "allow" | "deny" | "allow_always_low" | "allow_always_medium";
        readonly reason?: string;
      };
```

### 3.2 SSE wire 映射 / SSE wire mapping

English: AI SDK v6 supports custom data parts via `data-{name}` chunk types. We map each AgentEvent to a UIMessage custom part:

中文:AI SDK v6 通过 `data-{name}` chunk 类型支持自定义 data part。我们把每个 AgentEvent 映射到一个 UIMessage 自定义 part:

| AgentEvent kind | UIMessage part type | Notes |
|---|---|---|
| `ask_user_question` | `data-ask` | client renders InlineQuestion |
| `request_approval` | `data-approval` | client renders InlineApproval |
| `aside` | `data-aside` | client renders AsidePart |

English: `sse-translator.ts` extends `payloadToChunk` to emit these. Each part carries its `askId` so the client can correlate the eventual reply, and so the same component can render once (no React key conflicts on re-renders).

中文:`sse-translator.ts` 在 `payloadToChunk` 里加这三种映射。每个 part 带 `askId` 让客户端关联后续回复,组件渲染一次(不会有 React key 冲突)。

### 3.3 用户回复路径 / User-reply path

English: Replies do **not** flow through SSE (the SSE channel is server → client only). Instead, a new endpoint:

中文:回复**不走 SSE**(SSE 是 server → client 单向)。新加一个 endpoint:

```
POST /api/chat/answer
Content-Type: application/json

{
    "sessionId": "draft-mp406k7d",
    "epoch": 7,
    "reply": {
        "kind": "user_answered_question",
        "askId": "01J9...",
        "answer": { "mode": "single", "selectedId": "yes" }
    }
}

→ 200 OK { "delivered": true }
   or 410 Gone { "error": "ask expired" } if past timeout / ask cancelled
```

English: The handler looks up the in-memory pending-ask registry by `(sessionId, askId)`, validates the epoch, and resolves the Promise the agent runner is awaiting. The agent then resumes streaming on the original SSE connection (the next chunk after the `data-ask` part is the agent's continuation after seeing the answer).

中文:Handler 在内存的 pending-ask 注册表里按 `(sessionId, askId)` 查,验 epoch,resolve agent runner 正在 await 的那个 Promise。Agent 在原 SSE 连接上继续流(在 `data-ask` part 之后的下一块 chunk 就是 agent 看到回答后的续答)。

---

## 4. agent-core tool 设计 / agent-core tool design

### 4.1 `ask_user_question` 工具 / `ask_user_question` tool

English: Exposed to the LLM via the standard tool catalog. Signature:

中文:通过标准 tool 目录暴露给 LLM。签名:

```ts
const askUserQuestion = tool({
    description:
        "Ask the user a structured question before proceeding. Use when you need clarification, " +
        "want to offer a choice between alternatives, or need to confirm an interpretation. " +
        "DO NOT use for routine acknowledgement or filler.",
    inputSchema: z.object({
        question: z.string().min(1).max(2000),
        mode: z.enum(["single", "multi", "free_text"]),
        options: z
            .array(
                z.object({
                    id: z.string(),
                    label: z.string(),
                    description: z.string().optional(),
                }),
            )
            .min(2)
            .max(8)
            .optional(),
        defaultId: z.string().optional(),
        timeoutMs: z.number().int().min(10_000).max(600_000).optional(),
    }),
    execute: async (args, { signal, runtime }) => {
        // The runtime knows how to deliver an ask_user_question event +
        // await the corresponding user_answered_question reply. Web
        // sessions use the wire-driven path; TUI sessions use the
        // readline fallback.
        const reply = await runtime.askUserQuestion(args, { signal });
        return { ok: true, ...reply.answer };
    },
});
```

English: LLM call examples:

中文:LLM 调用例:

```ts
// Single choice
ask_user_question({
    question: "我看到两个候选实现 — 你想用哪个?",
    mode: "single",
    options: [
        { id: "react-server", label: "React Server Components", description: "Next.js 15 默认,SSR 友好" },
        { id: "client-only", label: "纯客户端组件", description: "更简单但首屏慢" },
    ],
});

// Free text
ask_user_question({
    question: "这是要查 2025 年还是 2026 年的发布?",
    mode: "free_text",
});

// Multi
ask_user_question({
    question: "把哪几个文件加进 commit?",
    mode: "multi",
    options: [
        { id: "route.ts", label: "apps/web/app/api/chat/route.ts" },
        { id: "spec.ts", label: "apps/web/tests/e2e/capability-assessment.spec.ts" },
        { id: "doc.md", label: "docs/15-introspection/web-e2e-capability-assessment.md" },
    ],
});
```

### 4.2 `WriteAuthority` 改造 / `WriteAuthority` refactor

English: `WriteAuthority.confirm` currently takes `(request) => Promise<boolean>`. We extend it:

中文:`WriteAuthority.confirm` 当前签名 `(request) => Promise<boolean>`。扩展成:

```ts
export interface WriteAuthorityOptions {
    mode?: AuthorityMode;
    confirm?: (request: WriteRequest, ctx: ConfirmContext) => Promise<UserDecision>;
    auditLog?: (record: AuditRecord) => void | Promise<void>;
    actor?: string;
}

export interface ConfirmContext {
    readonly askId: string;       // pre-generated ULID
    readonly signal?: AbortSignal;
}

export type UserDecision =
    | { kind: "allow" }
    | { kind: "deny"; reason?: string }
    | { kind: "allow_always"; riskLevel: "low" | "medium" };
```

English: Web's confirm hook emits a `request_approval` AgentEvent and awaits the matching `user_decision` reply. TUI's confirm hook stays readline-based but now returns the richer `UserDecision` (translating `always-low` etc. to the new shape).

中文:Web 的 confirm hook 发 `request_approval` AgentEvent 然后 await 配对的 `user_decision` 回复。TUI 的 confirm hook 仍是 readline,但现在返回更丰富的 `UserDecision`(把现有的 `always-low` 等翻译成新 shape)。

---

## 5. Web UI 组件 / Web UI Components

### 5.1 `<InlineQuestion>` — `data-ask` 部分

English: Rendered inline inside the assistant turn at the position the `data-ask` part appears in `message.parts[]`. Visual:

中文:渲染在 assistant turn 内 `data-ask` part 出现的位置。视觉:

```
┌─ 麒麟 · question ───────────────────┐
│ 我看到两个候选实现 — 你想用哪个?           │
│                                      │
│ ○ React Server Components            │
│   Next.js 15 默认, SSR 友好           │
│ ○ 纯客户端组件                        │
│   更简单但首屏慢                       │
│                                      │
│ [    提交 · submit    ] (倒计时 4:32) │
└──────────────────────────────────────┘
```

English: After submission, the component re-renders as a read-only "回答 · answer" summary with the chosen option highlighted. POSTs to `/api/chat/answer`.

中文:提交后组件改成只读"回答 · answer"摘要,选中项高亮。POST 到 `/api/chat/answer`。

### 5.2 `<InlineApproval>` — `data-approval` 部分

English: Similar layout. Allow / deny buttons + an "allow always for medium-risk in this session" toggle. Visual:

中文:类似布局。Allow / deny 按钮 + 一个"本会话同等风险等级自动放行"开关。视觉:

```
┌─ 麒麟 · approval needed (medium) ───┐
│ 工具: shell_exec                     │
│ 摘要: 运行 ls -la ~/Desktop          │
│ ▼ 详情                                │
│ command: ls -la ~/Desktop/...        │
│ timeoutMs: 5000                      │
│                                      │
│ [ 允许 · allow ]  [ 拒绝 · deny ]    │
│ ☐ 本会话同等风险等级自动放行           │
└──────────────────────────────────────┘
```

### 5.3 `<AsidePart>` — `data-aside` 部分

English: Italic, slightly muted color, with a thin left rule. No interactive controls. Renders Streamdown content.

中文:斜体,稍弱颜色,左侧细竖线。无交互。Streamdown 渲染。

---

## 6. TUI 集成 / TUI Integration

English: The REPL's existing readline loop is upgraded to handle the three new event kinds:

中文:REPL 现有的 readline 循环升级以处理三种新 event:

- `ask_user_question` mode `single` → 显示编号列表,等用户输入数字(`1` / `2` / ...) 或 option id
- `ask_user_question` mode `multi` → 等逗号分隔的数字列表(`1,3,5`)
- `ask_user_question` mode `free_text` → 普通 readline,直到用户回车
- `request_approval` → 复用现有 `Allow? [y/N/always-low/always-medium]` 提示,把回答翻译成 `UserDecision`
- `aside` → 立即打印,前缀 `~ ` 加颜色淡化(类似 git log 的 commit 元信息行)

English: The TUI maintains the same "ask suspends the stream" semantic. Background subagent activity continues to log via separate panes; the main REPL pauses awaiting user input on the ask.

中文:TUI 维持"ask 暂停主流"的语义。后台 subagent 活动通过独立 pane 继续 log;主 REPL 在 ask 时暂停等用户输入。

---

## 7. 暂停 / 超时 / 重连 / Pause / Timeout / Reconnect

### 7.1 暂停 / Pause

English: When the agent calls `ask_user_question` or triggers a `WriteAuthority` confirm:

中文:Agent 调用 `ask_user_question` 或触发 `WriteAuthority` confirm 时:

1. Runtime registers `(sessionId, askId)` in the in-memory `pending-ask` map with a Promise resolver.
2. Runtime emits the AgentEvent to the wire(client renders the inline widget;TUI prints prompt).
3. Runtime awaits the Promise. The `streamText` invocation pauses(no new tool call resolves until the user answers).
4. **Backpressure**:Concurrent SSE chunks for other parts of the same turn(e.g. parallel subagent updates)continue to flow — only the main agent's tool-execution loop blocks.

### 7.2 超时 / Timeout

English: Default 5 min. On timeout:

中文:默认 5 分钟。超时时:

1. Runtime resolves the pending Promise with `{ mode: "timeout" }`(for asks)或 `{ kind: "deny", reason: "timeout" }`(for approvals)。
2. Agent's tool returns indicating no user input;the LLM decides next step(usually narrate "用户没回应,我先继续 / I'll continue without confirmation, here's what I'd do").
3. Web 客户端的 `<InlineQuestion>` 组件超时后变成只读 + 显示"超时 · timed out",且不再接受输入。

### 7.3 重连(同 sessionId,ask 还在 pending)/ Reconnect mid-ask

English: User closes the tab and reopens `/?session=<id>`. The new tab fetches history(post-§web-session-persistence:from SQLite,otherwise from localStorage)。Among the historical `message.parts[]` there's a `data-ask` part with status `pending`。The component renders again with active submit buttons。User submits → POST 到 `/api/chat/answer` with the same `askId` → 命中后端 pending-ask map → 解开原 runner 的 Promise。

中文:用户关 tab 重开 `/?session=<id>`。新 tab 拉历史(web 持久化落地后从 SQLite,否则 localStorage)。历史 `message.parts[]` 里有一个状态为 `pending` 的 `data-ask` part。组件再次渲染,提交按钮活跃。用户提交 → POST `/api/chat/answer` 带同样的 `askId` → 命中后端 pending-ask map → 解开原 runner 的 Promise。

English: **Constraint**: this only works if the Node process didn't restart between the ask emission and the reconnect. If it did, the pending-ask map is empty, the POST returns 410 Gone, and the client shows the ask as expired. Recovery: agent's next turn re-asks (since it sees the previous question went unanswered in the message log).

中文:**约束**:Node 进程在 ask 发出和重连之间没重启才行。重启了,pending-ask map 是空的,POST 返回 410 Gone,客户端把 ask 显示为已失效。恢复:agent 下一轮重新问(它看消息日志知道上一个问题没被回答)。

---

## 8. 审计 / Audit

English: Every `request_approval` decision flows through the existing `WriteAuthority.auditLog` hook. We add two fields:

中文:每条 `request_approval` 决策走现有 `WriteAuthority.auditLog` 钩子。加两个字段:

```ts
export interface AuditRecord {
    readonly timestamp: number;
    readonly request: WriteRequest;
    readonly decision: WriteDecision;
    readonly actor: string;
    // NEW:
    readonly askId: string;
    readonly source: "tui-readline" | "web-wire" | "auto-policy" | "timeout";
}
```

English: `ask_user_question` events are NOT audit-logged by default (they're conversational not authorization). A future "session audit replay" feature may opt into logging asks.

中文:`ask_user_question` 事件默认**不**进 audit log(它是对话不是授权)。未来"会话审计回放"功能可以选择 opt-in 记录 asks。

---

## 9. 测试计划 / Test Plan

| # | 场景 / Scenario | 验收 / Acceptance |
|---|---|---|
| T1 | LLM 调 `ask_user_question` mode=single,web 端用户点选项,agent 收到回答 | Round trip <1s; agent's next tool call uses the chosen option |
| T2 | mode=multi:用户选 2 个选项 | `selectedIds` 含 2 个 id |
| T3 | mode=free_text:用户输入自由文本 | `text` 字段透传 |
| T4 | `WriteAuthority` triggered by `shell_exec` on web → `<InlineApproval>` rendered | Submit allow → tool runs;deny → tool returns approval-denied error |
| T5 | TUI 模式跑 T1 | readline 弹出编号列表;输入 `2` 等价于点第二个选项 |
| T6 | TUI 模式跑 T4 | 现有 `Allow? [y/N/always-low/...]` 行为不变,UserDecision shape 正确 |
| T7 | Ask 超时 | 5 分钟后 web 组件变只读;agent 继续(narrates timeout) |
| T8 | Ask 期间用户关 tab 重开 | 历史里 `data-ask` 重新渲染,active;答回去能命中 pending-ask map |
| T9 | Ask 期间 server 重启 | 重开后 POST 返回 410;client 显示 expired;agent 下一轮重问 |
| T10 | 用户取消(close inline X)| POST cancel reply;agent 收到 `{ mode: "timeout" }` 等价处理 |
| T11 | `aside` 事件渲染 | `<AsidePart>` 出现在对话流中,弱视觉权重,Streamdown 渲染 markdown |
| T12 | Audit log for approval | 每条 `request_approval` 决策产出 `AuditRecord`,含 askId + source |
| T13 | E2E:agent 同一 turn 内连发 ask + approval | 两个 inline widget 都渲染,UI 不串位;独立 askId |
| T14 | 跨语言一致性:同一 ask 在 TUI 和 web 都能回答(单 session 不同时,但同 sessionId 重连) | 第一份 ask 在 TUI 答完后,web 重连看到 answered 状态;反之亦然 |

English: Web tests in `apps/web/tests/e2e/interaction-primitives.spec.ts`(Playwright);TUI tests in `packages/agent-core/src/repl.test.ts`;cross-runtime integration in `apps/web/tests/integration/ask-roundtrip.spec.ts`。

中文:Web 测试在 `apps/web/tests/e2e/interaction-primitives.spec.ts`(Playwright);TUI 测试在 `packages/agent-core/src/repl.test.ts`;跨 runtime 集成在 `apps/web/tests/integration/ask-roundtrip.spec.ts`。

---

## 10. 风险与已知约束 / Risks & Known Constraints

English:
- **In-memory pending-ask map.** Process restart drops all open asks. Acceptable trade-off; persisting open asks to SQLite is deferred.
- **LLM over-asks.** If the LLM calls `ask_user_question` for trivial things, user gets prompt fatigue. System prompt must include guidance: "use only for genuine ambiguity, not as filler". Add a usage counter that nudges the LLM ("you've asked 3 times this turn — consider proceeding with reasonable assumptions").
- **Browser concurrent answers.** User opens two tabs of the same session and both render the inline ask. First POST wins; second gets 410 Gone with `already_answered`. Document this UX.
- **`always_allow` scope.** "Allow always for this session" is per `(sessionId, riskLevel)` — does not bleed across sessions or risk levels. Document the boundary.
- **Latency in tool turn.** Inserting an ask in the middle of a tool-calling turn means the LLM waits up to 5 min. Latency-sensitive use cases need a streaming-friendly fallback (continue with default, ask is async).

中文:
- **In-memory pending-ask map。** 进程重启,所有 open ask 都丢。可接受 trade-off;持久化 open ask 到 SQLite 留到后续。
- **LLM 滥问。** LLM 拿琐碎事情触发 ask 会让用户疲劳。System prompt 要加引导:"只用于真实有歧义的场景,不要做 filler"。加一个调用计数器轻推 LLM("本轮你已经问了 3 次 — 考虑用合理假设继续")。
- **浏览器并发回答。** 用户开两个 tab 同 session,两边都渲染同一个 ask。第一份 POST 赢,第二份返回 410 Gone 带 `already_answered`。UX 上明示这条。
- **`always_allow` 作用域。** "本会话同等风险等级自动放行" 是 per `(sessionId, riskLevel)`,不跨 session,不跨 risk level。文档里写明边界。
- **工具回合内的延迟。** 在 tool-calling 回合中间塞 ask,意味着 LLM 等最多 5 分钟。对延迟敏感的用例需要流式友好的 fallback(用默认继续,ask 异步发)。

---

## 11. 实施排期(切片建议) / Implementation Slicing

### Slice 1 — Wire 与 agent-core(~3 day)

- AgentEvent 三个新类型 + 两个 reply 类型
- `ask_user_question` 工具
- `WriteAuthority.confirm` 签名扩展
- Runtime pending-ask map + Promise plumbing
- TUI readline 整合(单选 / 多选 / free_text)
- Unit tests T1, T5(模拟 web runtime),T6, T11(emit-only)

### Slice 2 — Web wire + POST endpoint(~2 day)

- `sse-translator.ts` 加三种 part 映射
- `/api/chat/answer` endpoint + pending-ask 集成
- 错误路径:410 Gone, epoch mismatch
- Integration test T8, T9

### Slice 3 — Web UI(~3 day)

- `<InlineQuestion>` / `<InlineApproval>` / `<AsidePart>` 组件
- 嵌入 ConversationView 的 part 渲染
- 倒计时 + 提交后只读
- E2E test T1, T2, T3, T4, T7, T10, T11, T13

### Slice 4 — Audit + 整理(~1 day)

- `AuditRecord` 新字段
- 跨 runtime test T14
- 文档更新:`07-safety-guardrails/README.md`、`docs/STATUS.md`

Cumulative: ~9 person-days. Each slice goes behind `QUILIN_INTERACTION_PRIMITIVES=on/off` flag.

累计 ~9 人天。每个切片走 `QUILIN_INTERACTION_PRIMITIVES=on/off` flag。

---

## 12. 验收门槛 / Acceptance Gate

English: "Done" only when:
1. All 14 tests in §9 pass.
2. Cross-review loop closes (2 fresh reviewers, 0 REAL each).
3. `docs/07-safety-guardrails/README.md` §2.6 updated to reference this spec as the canonical implementation.
4. `docs/STATUS.md` reflects landed status.
5. UX-3(`docs/15-introspection/web-ux-backlog.md`)closed by virtue of `<AsidePart>` shipping.
6. The web e2e capability assessment spec(`capability-assessment.spec.ts`)gets two new cases that exercise `ask_user_question` and `request_approval` round-trip — adds these to Iter F definition-of-done。

中文:"完成"只在以下都满足时:
1. §9 的 14 个测试全过。
2. Cross-review loop 收敛(2 个新 reviewer, 各 0 REAL)。
3. `docs/07-safety-guardrails/README.md` §2.6 更新,引用本 spec 作为权威实现。
4. `docs/STATUS.md` 更新落地状态。
5. UX-3(`docs/15-introspection/web-ux-backlog.md`)随 `<AsidePart>` 上线一并关闭。
6. Web e2e capability assessment spec(`capability-assessment.spec.ts`)新加两个测试覆盖 `ask_user_question` 和 `request_approval` 闭环 — 这两项加入 Iter F 验收清单。
