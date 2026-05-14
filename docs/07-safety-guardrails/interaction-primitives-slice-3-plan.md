# 交互 primitives Slice 3 实施计划 / Implementation plan

> 状态 / Status:**Plan(实施前)** · 下一阶段启动
> 写于 / Drafted:2026-05-15 autonomous run · profile-pure-markdown 落地后
> 关联 / Related:`docs/07-safety-guardrails/interaction-primitives-spec.md` §3-§7 · web 端 wire 与 UI 已完成于 `5ec2192` / `44edf95`

---

## 现状实证 / What's already wired

English: Web side is fully ready. Agent-core side has zero of the slice 3 work yet.

中文:web 侧 100% ready,agent-core 侧 0% — 这一片要把两边接上。

### Web side (DONE)

| 模块 | 文件 | 状态 |
|---|---|---|
| Event payload types `ask_user_question` / `request_approval` / `aside` | `apps/web/lib/agent-service-client.ts:121-150` | ✅ Forward-declared |
| SSE 翻译 payload → data-* chunks | `apps/web/lib/sse-translator.ts` | ✅ |
| Pending-ask 注册表 + 超时 fallback | `apps/web/lib/pending-asks.ts` | ✅ Globalthis-cached map |
| `POST /api/chat/answer` endpoint | `apps/web/app/api/chat/answer/route.ts` | ✅ |
| InlineQuestion UI | `apps/web/components/chat/InlineQuestion.tsx` | ✅ single/multi/free_text + countdown |
| InlineApproval UI | `apps/web/components/chat/InlineApproval.tsx` | ✅ allow/deny + always-allow |
| AsidePart UI | `apps/web/components/chat/AsidePart.tsx` | ✅ Muted italic |
| ConversationView dispatcher | `apps/web/components/chat/ConversationView.tsx` | ✅ |

### Agent-core side (MISSING)

| 缺口 | 描述 |
|---|---|
| `ask_user_question` builtin tool | 无。需要新建 `packages/agent-core/src/tools/builtin/ask-user-question.ts` |
| Event emission hook | `EventBus.emit(sessionId, {type: "ask_user_question", ...})` 没人调用 |
| `WriteAuthority.confirm` web hook 注入 | `apps/web/lib/agent-service-client.ts` 创建 AgentService 时没传 `confirm` hook |
| Pending-ask 注入 | tool 实现需要 await `registerAsk(...)` — 但 tool 跑在 agent-core 包里,`registerAsk` 在 web 包里;需要依赖注入(`ask-user-question` 工厂接收一个 `awaitAsk` 函数) |
| Tests | tool 单测 + AgentService integration 测试 |

---

## 切片建议 / Slicing

### ~~3a — `ask_user_question` 工具 + 事件 emit~~ ✅ 已完成 commit `7c48bc4`

English: Build the tool as a `ToolWithMetadata` factory that takes a `(askId) => Promise<reply>` dependency injection. Tool execution:

1. Generate `askId = randomUUID()`.
2. Call `eventBus.emit(sessionId, {type: "ask_user_question", askId, question, mode, options, defaultId, timeoutMs})`.
3. `await deps.awaitAsk(askId)` — returns the user reply.
4. Format reply into a tool-result string the LLM can read (e.g., `User selected: option-2 ("Use library X")`).

中文:工厂模式接受 `awaitAsk` 依赖注入。Tool execute 流程:生成 askId → emit 事件 → await 用户回复 → 把回复格式化成 LLM 可读字符串返回。

依赖 / Deps:
- `packages/agent-core/src/services/agent-service/event-bus.ts` (already exported)
- `packages/agent-core/src/tools/types.ts` `ToolWithMetadata` + `ToolResult`
- No runtime dependency on `apps/web/lib/pending-asks.ts` — only the type signature `(askId: string, kind: ...) => Promise<reply>` flows in via DI.

测试 / Tests:
- Spy on `awaitAsk` returning `{kind: "user_answered_question", answer: {mode: "single", selectedId: "a"}}` → tool returns formatted string containing "a".
- Timeout reply (`{mode: "timeout"}`) → tool returns "user did not answer within Xs" error result.
- Multi-select / free_text shapes covered.

### ~~3b path A — `request_approval` tool~~ ✅ 已完成 commit `74e9f1e`(advisory 实现)

> 路径 B(server-side WriteAuthority wrapper)仍 pending,延后到独立 iter。

### 3b legacy plan(原文供参考)

**架构发现 / Architecture discovery 2026-05-15:** chat 路由直接用 AI SDK
`streamText`,**不走 agent-core 的 runAgentLoop / WriteAuthority**。Slice 3b
两条路:

- (路径 A,简单) 把 `request_approval` 实现成跟 `ask_user_question` 同构的
  独立工具(`makeRequestApprovalTool(...)`)。LLM 在调用敏感工具前主动调
  `request_approval` 拿到 user_decision,本地判断后决定要不要执行。
  优点:不动现有架构;缺点:依赖 LLM 自律,易绕过。
- (路径 B,正确) 给现有 web 工具(`shell_exec` / `file_write` / `spawn_subagent`
  写入路径等)套一层 WriteAuthority wrapper,wrapper 内部走 confirm hook,
  hook 调 `registerAsk` 等用户裁定。
  优点:架构干净,LLM 无法绕过;缺点:需要识别哪些工具是"敏感",分类需要
  跟现有 RiskLevel / sandboxPolicy 对齐。

推荐:**先实现路径 A 拿到完整 wire 实证,再下一个 Iter 做路径 B**。理由是
路径 A 是 2 文件的小改动可以快速 ship + 在 web UI 真实跑通 InlineApproval;
路径 B 涉及给每个 web 工具加 metadata + risk 分类,更适合做完 Slice 3 整片
之后再设计。

English: When the web process constructs the `AgentService` (in `agent-service-client.ts`), it needs to:

1. Pass an `awaitAsk` function = `({sessionId, askId, kind, timeoutMs}) => registerAsk({sessionId, askId, kind, timeoutMs})` to the `ask_user_question` tool factory.
2. Pass a `WriteAuthority.confirm` hook that:
   - Emits `{type: "request_approval", askId: randomUUID(), tool, riskLevel, summary, detail, origin}` via the event bus.
   - Awaits `registerAsk(...)` for a `user_decision` reply.
   - Returns `decision === "allow"` (or `allow_always_*`).

3. For sub-toolset wiring, the AgentLoopConfig.tools array gets `createAskUserQuestionTool({ awaitAsk })` plus existing built-ins.

中文:Web 进程构造 AgentService 时把 `awaitAsk` 闭包绑到工具实例,把 confirm hook 绑到 WriteAuthority。两者共享同一个 web 端 `registerAsk`。

依赖:
- `apps/web/lib/agent-service-client.ts` (the singleton factory)
- agent-service 的 createAgentService API 接受 `tools` / `writeAuthorityOptions`(待加 / 已有,需要 grep 实证)

测试:
- vitest integration:跑一个 fake session,调用 ask_user_question 工具,POST /api/chat/answer 回复,验证 tool 返回值。
- WriteAuthority 路径:fake critical write 请求 → expect `request_approval` 事件出现 → POST allow → write 成功。

### 3c — Cross-review + commit(~10M token + 5轮 review)

按硬规则:
- 派 2 个新 reviewer:类型/逻辑/round-trip 一个,集成漂移/安全/向后兼容一个。
- 任一发现 REAL → 修复 → 再开 2 个新 reviewer
- 直到 2 个新 reviewer 报 0 REAL 才能 commit/push。

---

## 不在 scope / Out of scope

- TUI 端集成(Slice 4 — `packages/agent-core/src/repl.ts` readline 渲染编号列表)。
- `request_approval` 自动 `always_*` 的状态持久化(目前内存,session-scoped 即可,持久化下个 Iter)。
- 多并发 ask 的优先级队列(目前 FIFO 自然处理就好)。
- `aside` event 的 emit 路径(planner / reflection 内部 narrative,Slice 3 不实现,Slice 4 + 再做)。

---

## Token 预算 / Token budget

- 3a tool 实现 + 单测:~12M
- 3b web 注入 + integration test:~10M
- 3c cross-review 5 轮 × 2 reviewer:~50M(经验值,profile-markdown 这次用了 ~50M cross-review)
- **总计 ~70-75M**(单 session window 内可完成,token 余量需 ≥ 80M)

---

## 协议 / Protocol

- TypeScript:`pnpm --filter @quilin/agent-core exec vitest run` + `pnpm --filter @quilin/web exec vitest run` 全过。
- tsc:`pnpm --filter @quilin/agent-core exec tsc --noEmit` + 同 web 包退出 0。
- biome:`pnpm exec biome check apps/web packages/agent-core` 0 错。
- Cross-review:per `CLAUDE.md` 硬规则,**2 fresh reviewer 连续 0 REAL** 才能 commit。
- Playwright(UI 改动收尾):web 端没有新 UI 改(组件 Slice 2 已落),但要跑一遍 `apps/web` e2e 看交互流不破。
