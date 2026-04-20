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
| 2 | Thinking enablement + streaming display | ⏳ pending | Codex | — | 不碰 replay，只做 enable + 展示 |
| 3 | Reasoning carry-over via cache-adapter | ⏳ pending (blocked by #2) | Codex | — | provider-tagged ReasoningPart + adapter 出站分派 |
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

### Phase 2 — Thinking enablement + streaming display ⏳

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
- **依赖**：Phase 2 完成
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
  interface ReasoningPart {
    readonly provider: "deepseek" | "anthropic" | "openai-chat" | "openai-responses";
    readonly text?: string;              // DeepSeek reasoning_content / Anthropic thinking / OpenAI summary
    readonly signature?: string;         // Anthropic only
    readonly encryptedContent?: string;  // OpenAI Responses only
    readonly itemId?: string;            // OpenAI Responses only
  }
  ```
- **理由**：避免 Anthropic signature / OpenAI encrypted_content / itemId 在 round-trip 中有损
- **对应 Phase**：Phase 2 定义 + Phase 3 使用

### 2026-04-21 — OpenAI Responses API 拆到 Phase 3.1

- **Before**：Phase 3 v1 包 Chat + Responses 两条路
- **After**：Phase 3 v1 只做 Chat（和 DeepSeek + Anthropic），Responses 单独起 Phase 3.1
- **理由**：Responses 是独立 adapter，接口形态不同，合一起风险面太大

### 2026-04-21 — Temporal 方案 B（时段移到 precise）

- **Before**：方案 A（全部冻结到 sessionStartTime，包括时段）
- **After**：方案 B（日期桶冻结 sessionStartTime；时段在 precise decoration 每轮实时）
- **理由**：长 session 跨 00:00 概率高，"now 是什么时段"应是事实不应冻结；日期桶冻结则语义诚实

## Open Questions

- [ ] DeepSeek doc/runtime drift：当前 runtime 宽松是否是 model-version 或 region-specific？需监控
- [ ] Phase 3 Anthropic：malformed-signature 的具体 error body 是什么（凭证到位后补）
- [ ] OpenAI Chat 对注入 reasoning-like 字段是 400 还是静默忽略（凭证到位后补）
- [ ] REPL `/verbose` 应该是 per-session 还是 per-invocation？

## Blockers

- ❌ **Anthropic / OpenAI API key 缺失** — 用户已确认无法补，Phase 3 Anthropic adapter 合并前置门禁会在凭证到位后跑

## Next Action

- **Codex**：开干 Phase 2（#107）
- **Claude**：起草 02-context README 增补（8-13 落盘 + 1-13 重新分组），独立小 PR 交 Codex 执行
