---
title: Reasoning Lifecycle — Thinking Enablement, Display, Carry-Over
status: in-progress
owner: Claude (plan) + Codex (impl)
created: 2026-04-21
last_updated: 2026-04-21
---

# Reasoning Lifecycle

## 目标

让 Quilin 对现代 reasoning 模型（DeepSeek-R1 / Claude extended thinking / OpenAI o-series）提供完整的 thinking 生命周期：

1. **真启用 thinking** —— `thinkingMode` 不能只是 type 占位，要真的下发给 provider
2. **展示给用户** —— REPL 能看到 thinking 过程 + tool call 进度
3. **回传下一轮** —— thinking 作为高密度上下文，下一轮带回去避免重复思考

顺带修一个时间桶边界 bug（跨 00:00 日期漂移）。

## Phases

| # | 名称 | 状态 | Owner | Commit | 备注 |
|---|---|---|---|---|---|
| 0 | Reasoning carry-over probe | ✅ completed | Codex | `487d146` | DeepSeek live + Anthropic/OpenAI 文档；DeepSeek runtime 证据推翻 "strip reasoning" 假设 |
| 1 | Temporal boundary fix (方案 B) | ✅ completed | Codex | `487d146` | 日期桶冻结 sessionStartTime，时段移到 precise decoration |
| 2 | Thinking enablement + streaming display | ✅ completed | Codex | — | provider-aware thinking enablement + `fullStream` REPL display；不碰 replay |
| 3 | Reasoning carry-over via cache-adapter | ⏳ pending | Codex | — | provider-tagged ReasoningPart + adapter 出站分派 |
| 3.1 | OpenAI Responses API adapter | ⏳ pending (deferred) | Codex | — | 单独起一批，不混入 Phase 3 v1 |
| 4 | Reasoning lifecycle tests + docs | ⏳ pending (blocked by #2, #3) | Codex | — | 每 provider 独立 spec + E2E + 01-llm-integration 补 §Reasoning Lifecycle |

### Phase 0 — Reasoning carry-over probe ✅

- **做什么**：对 DeepSeek-R1 / Claude 3.7+ extended thinking / OpenAI o-series 验证 thinking 回传规则、payload 形态、是否真省 reasoning tokens
- **产出**：[`docs/research/2026-04-21-reasoning-carry-over-probe.md`](../research/2026-04-21-reasoning-carry-over-probe.md)
- **证据强度**：DeepSeek = live probe；Anthropic/OpenAI = 文档 + SDK（凭证缺失，runtime 未验证）
- **关键发现**：见下方 Decisions

### Phase 1 — Temporal boundary fix (方案 B) ✅

- **做什么**：日期桶用 `sessionStartTime`（语义：本 session 起始日），时段（morning/afternoon/...）从 per_session bucket 移到每轮 user 输入的 precise decoration
- **产出**：`packages/agent-core/src/context/temporal.ts` + test
- **验证**：`bunx vitest run src/context/temporal.test.ts src/context/prompt-session-assembler.test.ts` → 12/12 pass

### Phase 2 — Thinking enablement + streaming display ✅

- **做什么**：
  1. `llm/client.ts` 按 provider 下发 thinking 配置（DeepSeek 切 `deepseek-reasoner` model id；Anthropic `providerOptions.anthropic.thinking`；OpenAI `reasoningEffort`）
  2. `StreamingLLMClient` 从 `textStream` 切到 `fullStream`，分派 `reasoning-*` / `text-*` / `tool-call-*` / `tool-result-*` 事件
  3. `LLMResponse.thinking` 真实填充
  4. `state/types.ts Message` 新增 `reasoning?: ReasoningPart[]`（按 Phase 3 约定的 provider-tagged 结构，Phase 2 只存、不回传）
  5. REPL 事件化回调：💭 thinking（默认折叠）+ 🔧 calling tool + 正文流式
  6. REPL 命令：`/think on|off|auto`、`/verbose`、`/collapse`
- **不做什么**：
  - ❌ 回传 reasoning 给下一轮（Phase 3）
  - ❌ cache-adapter 出站转换（Phase 3）
  - ❌ checkpoint schema migration（Phase 3）
  - ❌ OpenAI Responses API 支持（Phase 3.1）
- **依赖**：Phase 0 完成（provider policy 已决定）
- **验证**：REPL 开 `/think on` 跑 DeepSeek-R1 能看到 thinking + tool call 过程
  - 单测：`src/llm/client.test.ts`、`src/repl.test.ts`、`src/loop.test.ts` 已补 Phase 2 coverage
  - 2026-04-21 review fix 后：`src/state/checkpoint.test.ts`、`src/llm/cache-adapter.test.ts`、`src/context/injection-scanner.test.ts` 追加 blocker coverage
  - 包级：`pnpm --filter @quilin/agent-core test` 当前是 `245/246`，唯一红灯保持为 `src/tools/builtin/web-fetch.test.ts`
  - Live probe：
    - `/think on` + DeepSeek-R1：折叠态 `💭 [thinking...]` 出现
    - `/verbose`：reasoning 文本实际流出
    - tool progress：`🔧 calling ...` / `✅ ... → ...` 在真实会话出现

#### Phase 2 post-review status (2026-04-21)

- **已关闭 blocker**：`C-01 / C-02 / C-03 / H-01 / H-02 / H-03`
  - `C-01`：loop 出站前先 strip reasoning，`cache-adapter` 也有契约测试兜底
  - `C-02`：checkpoint 升 `schemaVersion: 2`，保存/加载都 sanitize reasoning，Phase 2 不持久化 signature / encryptedContent
  - `C-03`：reasoning 进入 message state 前也走 `scanExternalContext`
  - `H-01`：非流路径优先消费 AI SDK `result.reasoning`，`reasoningText` 仅作 fallback
  - `H-02`：streaming reasoning 改为按 block 保序累积，不再把多 block 压扁成一条 string
  - `H-03`：`ReasoningPart` 改为 strict discriminated union，运行时也不再 materialize 半残 Anthropic / OpenAI Responses part
- **本批不处理，留给后续 commit**：`H-04 / H-05 / H-06 / H-07 / M-01 / M-02 / M-03 / M-04 / M-05 / L-01 / L-02 / L-03`
- **验证快照**：
  - `pnpm --filter @quilin/agent-core exec vitest run src/state/checkpoint.test.ts src/llm/client.test.ts src/loop.test.ts src/llm/cache-adapter.test.ts src/context/injection-scanner.test.ts` → `67/67`
  - `pnpm --filter @quilin/agent-core test` → `245/246`，唯一失败保持为 `src/tools/builtin/web-fetch.test.ts`
  - `pnpm --filter @quilin/agent-core exec tsc --noEmit` 当前被本地环境阻塞：`Cannot find type definition file for 'bun-types'`

#### Phase 2 second-batch status (2026-04-21)

- **已修 / 已缓解**：`H-04 / H-05 / H-06 / H-07(partial) / M-01 / M-02 / M-04 / M-05 / L-02`
  - `H-04`：`StreamingLLMClient` 现在对 `fullStream` 的 `error` chunk 直接抛错，不再把截断响应当成功
  - `H-05`：DeepSeek thinking 导致 effective model 切到 `deepseek-reasoner` 时会 `console.warn`，REPL 也新增 `/status` 可见 base/effective model
  - `H-06`：OpenAI 路径在 `thinkingBudget` 无法精确映射时会 warn，一次性说明已退化为 `reasoningEffort`
  - `H-07`：WriteAuthority confirm 期间输入的 slash-command 现在会排队到下一轮，不再被确认提示吞掉；**但无 active prompt 的原始 TTY 预缓冲仍未单独拦截**
  - `M-01`：REPL 出错后会 reset `streamRenderState`
  - `M-02`：tool-name 未知时先缓冲 `tool-input-delta`，拿到真实 toolName 后再补发，不再冒名 `tool`
  - `M-04`：`buildProviderOptions` 收紧成 typed result（`providerOptions + warnings`），不再裸回 `Record<string, unknown>`
  - `M-05`：`/clear` 会一起 reset `streamRenderState`
  - `L-02`：`summarizeToolOutput` 改为 `isRecord` 守卫，不再靠裸断言
- **仍留给后续**：`L-01 / L-03`
  - `L-01`：stderr 多通道区分（reasoning / error / normal chrome）还没拆
  - `L-03`：`startRepl` 结构化拆分还没做，这轮优先修 correctness / UX race
- **验证快照**：
  - `pnpm --filter @quilin/agent-core exec vitest run src/llm/client.test.ts src/repl.test.ts src/loop.test.ts src/state/checkpoint.test.ts src/llm/cache-adapter.test.ts src/context/injection-scanner.test.ts` → `85/85`
  - `pnpm --filter @quilin/agent-core test` → `255/256`，唯一失败保持为 `src/tools/builtin/web-fetch.test.ts`
  - `pnpm --filter @quilin/agent-core exec biome check ...` → green
  - `pnpm --filter @quilin/agent-core exec tsc --noEmit` 仍被本地环境 `bun-types` 缺失阻塞，未纳入通过证据

### Phase 3 — Reasoning carry-over via cache-adapter ⏳

- **做什么**：
  - `cache-adapter.ts` 新增出站方向 `adaptOutgoingReasoning(messages, provider)`
  - Provider policy 初始值：
    - DeepSeek: `replay-supported`（默认开，可 `--deepseek.replay=off` runtime toggle）
    - Anthropic: `signature-preserving`（必开，signature 强校验）
    - OpenAI Chat: `replay: "none"`（不做 raw replay）
    - OpenAI Responses: 拆到 Phase 3.1
  - Checkpoint SQLite schema migration：存 reasoning part
  - 上层 loop / REPL / Checkpoint 完全不感知 provider 差异
- **Anthropic 合并前置门禁**（凭证到位后跑）：
  - [ ] intact signature replay 成功
  - [ ] missing signature 触发预期 error body（记录实际错误码 + 字段名）
  - [ ] 二轮 thinking usage 下降
- **Phase 2 review 追加前置门禁**（来自 [`docs/review/2026-04-21-phase-2-review.md`](../review/2026-04-21-phase-2-review.md)）：
  - [x] **C-01**：`cache-adapter` 有契约测试断言 `Message.reasoning` 不进 outbound `ModelMessage`
  - [x] **C-02**：checkpoint 序列化不含 Anthropic `signature` / `encryptedContent`（Phase 2 直接 strip `reasoning`）
  - [x] **H-02**：多 reasoning block 保持顺序 + 每 block 独立 `ReasoningPart`（per-block signature 可恢复）
  - [x] **H-03**：`ReasoningPart` 改为真正 discriminated union（provider narrow → 字段 required）
- **依赖**：Phase 2 完成 + 上述 4 条前置门禁绿
- **验证**：集成测试 + 每 provider spec

### Phase 3.1 — OpenAI Responses API adapter ⏳ (deferred)

- 独立 Phase，不混入 Phase 3 v1
- 走 `previous_response_id` + encrypted reasoning item

### Phase 4 — Tests + docs ⏳

- 每 provider 独立 `llm/client.reasoning.test.ts`（mock fixture）
- E2E `repl.reasoning.test.ts`
- 更新 `docs/engineering/01-llm-integration/README.md` §Reasoning Lifecycle
- Checkpoint migration 测试
- 依赖：Phase 2 + Phase 3 完成

## Decisions

### 2026-04-21 — DeepSeek 默认策略翻转：strip → replay-supported

- **Before**：原计划 Phase 3 对 DeepSeek 剔除 `reasoning_content`（基于官方文档："放回输入会 400"）
- **After**：DeepSeek 默认 `replay-supported`，可 runtime toggle
- **证据**：
  - Live probe（Codex，DEEPSEEK_API_KEY 可用）
  - 非工具二轮：replay accepted，`reasoning_tokens` 270→208
  - **Tool-use continuation：replay accepted，`reasoning_tokens` 63→14（−78%）**
  - 3 组 temp=0 paired：均值 140→63.3（−55%）
  - DeepSeek `reasoning_model` / `thinking_mode` 两份官方文档互相冲突，且与 runtime 都不一致 → 需要 runtime toggle 而不是硬编码
- **对应 Phase**：Phase 3 provider policy 初始值

### 2026-04-21 — ReasoningPart 用 provider-tagged 子结构

- **Before**：`Message.reasoning?: string`（单一字段）
- **After**：
  ```ts
  type ReasoningPart =
    | { readonly provider: "deepseek"; readonly text: string }
    | { readonly provider: "anthropic"; readonly text: string; readonly signature: string }
    | { readonly provider: "openai-chat"; readonly text: string }
    | { readonly provider: "openai-responses"; readonly itemId: string; readonly encryptedContent: string; readonly text?: string };
  ```
- **理由**：避免 Anthropic signature / OpenAI encrypted_content / itemId 在 round-trip 中有损；同时让 provider narrowing 真正收紧到 required 字段，Phase 3 adapter 不需要靠 `!` 非空断言
- **对应 Phase**：Phase 2 定义 + Phase 3 使用

### 2026-04-21 — OpenAI Responses API 拆到 Phase 3.1

- **Before**：Phase 3 v1 包 Chat + Responses 两条路
- **After**：Phase 3 v1 只做 Chat（和 DeepSeek + Anthropic），Responses 单独起 Phase 3.1
- **理由**：Responses 是独立 adapter，接口形态不同，合一起风险面太大

### 2026-04-21 — Temporal 方案 B（时段移到 precise）

- **Before**：方案 A（全部冻结到 sessionStartTime，包括时段）
- **After**：方案 B（日期桶冻结 sessionStartTime；时段在 precise decoration 每轮实时）
- **理由**：长 session 跨 00:00 概率高，"now 是什么时段"应是事实不应冻结；日期桶冻结则语义诚实

### 2026-04-21 — OpenAI Chat `thinkingMode` 映射到 `reasoningEffort`

- **After**：
  - `thinkingMode: "enabled"` → `providerOptions.openai.reasoningEffort = "high"`
  - `thinkingMode: "auto"` → `providerOptions.openai.reasoningEffort = "medium"`
  - `thinkingMode: "disabled"` → 不下发 `reasoningEffort`
- **理由**：
  - OpenAI Chat 没有与 `thinkingBudget` 一一对应的公开预算语义，Phase 2 不做伪精确映射
  - `enabled` 表示用户显式要 reasoning，默认给最强档；`auto` 表示平衡延迟与质量，给中档
  - 预算映射如果要做，应在后续拿到真实 usage/latency 数据后单独校准

## Open Questions

- [ ] DeepSeek doc/runtime drift：当前 runtime 宽松是否是 model-version 或 region-specific？需监控
- [ ] Phase 3 Anthropic：malformed-signature 的具体 error body 是什么（凭证到位后补）
- [ ] Phase 3 Anthropic：AI SDK / provider metadata 是否还会暴露 `redactedData` 或等价字段，需在 live probe 时锁定最终 shape，避免 replay adapter 误删 provider 保留位
- [ ] OpenAI Chat 对注入 reasoning-like 字段是 400 还是静默忽略（凭证到位后补）
- [ ] REPL `/verbose` 应该是 per-session 还是 per-invocation？
- [ ] Live REPL 曾观测到一次 `/verbose` 会话首个 reasoning delta 前仍出现折叠占位；直接 `StreamingLLMClient` probe 未复现，需在 Phase 3 前再做一次交互复核
- [ ] 本地 `tsc --noEmit` 因缺 `bun-types` 失败；需要在后续 CI / dev env 对齐后再把 typecheck 纳入 reasoning lifecycle 的完成证据

## Blockers

- ❌ **Anthropic / OpenAI API key 缺失** — 用户已确认无法补，Phase 3 Anthropic adapter 合并前置门禁会在凭证到位后跑

## Next Action

- **Claude**：基于 Phase 2 first-batch fix 落独立 commit / PR，描述引用本 tracking doc + [`docs/review/2026-04-21-phase-2-review.md`](../review/2026-04-21-phase-2-review.md)
- **Codex**：等待 merge 后选择下一步
  - Option A：继续 Phase 2 second batch（`H-04..H-07 + M-01..M-05`，倾向）
  - Option B：切到 B3b Phase 0（见 [`docs/planning/2026-04-21-skills-b3b-activation.md`](./2026-04-21-skills-b3b-activation.md)）
