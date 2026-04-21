---
title: Post-push code-review-graph review — commits b967d1c / 0464377 / 117b879
date: 2026-04-21
reviewer: Claude (code-review-graph + 人工核验)
base: 6fdda11
scope: 3 个 commit（docs restructure + Gate A/C.2 + pre-phase-3 checklist）
risk_score: 0.60 (中等)
status: done
---

# Post-push graph review

## Scope

| Commit | 内容 | 代码影响 |
|---|---|---|
| `b967d1c` | docs/ 重组（planning + iterations 顺序前缀）+ superpowers 删除 | 纯文档 |
| `0464377` | Gate A.1 loop.ts 212 LOC + Gate A.2 skill_view + Gate C.2 bun-types | 18 files |
| `117b879` | Pre-phase-3 checklist 更新 | 纯文档 |

共 **57 changed files**，49 functions/classes，32 test gaps（含假阳性），整体风险 **0.60**。

## Top 5 review priorities（按图谱 risk_score 排序）

| # | 函数 | 风险 | 文件 | 我的结论 |
|---|---|---|---|---|
| 1 | `sanitizeReasoningParts` | 0.60 | `reasoning-sanitizer.ts` | ✅ 有测试，逻辑正确 |
| 2 | `stripReasoningFromMessage` | 0.60 | `reasoning-sanitizer.ts` | ✅ 有测试，immutable |
| 3 | `stripReasoningFromMessages` | 0.60 | `reasoning-sanitizer.ts` | ✅ map 实现正确 |
| 4 | `buildOutboundPrompt` | 0.55 | `prompt-session-assembler.ts` | ⚠️ **缺独立单测**（test_gap 真阳性）|
| 5 | `executeToolCalls` | 0.55 | `loop-tool-calls.ts` | ✅ 由 `loop.test.ts` 集成覆盖 |

## 架构正确性 ✅

`loop.ts` 212 LOC（契约 `<220`），只做编排：
- turn loop / turn count / token budget / checkpoint save（turn_start, assistant_response, assistant_tool_calls）
- 副作用全委托：
  - context rebuild → `ContextManager`
  - outbound prompt → `PromptSessionAssembler`（可选）
  - reasoning sanitize/strip → `reasoning-sanitizer`
  - tool 执行 → `loop-tool-calls.executeToolCalls`
  - checkpoint → `state/checkpoint-writer`

**职责边界清晰**，没有功能漏洞。

## 安全性 ✅ 好于 Phase 2 入口

### 1. Reasoning 双重 strip（`loop.ts:107` + `loop.ts:117`）

```
outboundTranscript = stripReasoningFromMessages(workingMessages)  // 第一次
outboundRequest = assembler.buildOutboundRequest({ transcript: outboundTranscript })
outboundMessages = stripReasoningFromMessages(outboundRequest.messages)  // 第二次（防御性）
```

第二次 strip 是防御性的：`PromptSessionAssembler` 构造的 messages 只有 system + user/tool，理论上没 reasoning，但防御性 re-strip 防止上游契约漂移。

### 2. Reasoning sanitize 存储前扫描（`loop.ts:160`）

```
const storedThinking = sanitizeReasoningParts(response.thinking);
```

在写入 assistant message 之前 scan，本地存储是已清理的副本，符合 Phase 2 "sanitize on store" 契约。

### 3. Tool output consecutive-block 熔断（`loop-tool-calls.ts:75-78`）

`consecutiveBlockedToolOutputs >= 3` 抛 `AgentLoopError`，参数 + 返回值跨调用传递（loop.ts:66 init, L200-209 pass-through）— **跨 turn 语义保持**。

## 发现的问题

### D-01（LOW）`reasoning-sanitizer.ts:17` source 字段 log-injection 理论风险

```
const source = `reasoning:${part.provider}`;
```

`part.provider` 类型是 `string`，未验证。如果 LLM 响应里 `provider: "anthropic\n[fake log line]"`，会破坏 JSON logger 的结构。

**实际风险低**：
- `provider` 通常由 client 层设置，不是 LLM content
- 仅影响 log 格式，不影响 prompt / 不影响 security boundary

**建议**：不 block，记录即可；如果 Iter D 引入 log aggregation，再加 `provider` sanitizer。

### D-02（LOW）`executeToolCalls` checkpoint 保留 blocked content

L60-73：即使 `hasBlockedThreat`，仍 push + save checkpoint（`sanitizedContent` 已 redact 但 message 存在）。

- redact 后内容已被替换为 `[REDACTED: <pattern>]`，resume 时 LLM 看到的是脱敏文本 — **实际安全**
- 这是既有设计，不是本次 diff 引入

**不建议修改**。

### D-03（MEDIUM）`prompt-session-assembler.ts` 缺独立单测

- `buildOutboundPrompt` / `buildOutboundRequest` / `buildOutboundMessages` 三个公开方法都没独立测试
- 当前被 `loop.test.ts` 间接覆盖，但：
  - `rawTranscript[0]?.role === "system"` 裁剪逻辑的边界（空 transcript / 无 system / system+user+tool）没显式测试
  - `decoratePreciseTemporalUserInput` 在 turnKind + 末消息 role 组合下的触发条件没显式断言

**建议**：Iter B 收束前新增 `prompt-session-assembler.test.ts`，估工 30 min。

### D-04（LOW）`loop.ts:121-126` 缩进异常

```
			const response = await llm.chat(
```

比周围代码多 1 个 tab（使用 3-tab 而非 2-tab）。Biome/prettier 可能捕获。

**建议**：Task A 合流时顺手修。

### D-05（INFO）test_gap 假阳性

图谱 flag 以下为 test_gap，但实际有独立测试：
- `sanitizeReasoningParts` / `stripReasoningFromMessage` / `stripReasoningFromMessages` → `reasoning-sanitizer.test.ts` (2 tests, 45 lines)
- `createSkillViewTool` / `execute` → `skill-view.test.ts` (4 tests, 90 lines)
- `saveCheckpointState` / `buildCheckpointState` → `checkpoint-writer.test.ts` (2 tests, 55 lines)

**原因**：graph 的 prod↔test 映射没连上（可能是 import 边检测问题）。

**行动**：不 block；如果影响频繁误报，后续让 Codex 跑 `run_postprocess_tool` 重算。

## 测试 & Build

- `pnpm --filter @quilin/agent-core test`：**266/267 绿**（唯一红灯 web-fetch 老债，见 `docs/planning/2026-04-21-06-ai-sdk-type-debt.md` Cluster 2）
- `pnpm --filter @quilin/agent-core exec tsc --noEmit`：**89 errors**，全部属于 Cluster 1-4 既有债，见上文档

## 最终评价

| 维度 | 评分 | 备注 |
|---|---|---|
| 架构 | ✅ A | loop.ts 减行干净，职责边界清晰 |
| 安全 | ✅ A | 双重 strip + sanitize on store + consecutive-block 熔断 |
| 测试 | 🟡 B+ | reasoning-sanitizer / skill-view / checkpoint-writer 都有新测试；唯 prompt-session-assembler 缺单测（D-03） |
| 代码风格 | 🟡 B+ | loop.ts:121 缩进异常（D-04）|

**结论**：3 个 commit 可以留在 origin/master，无需 revert；D-03 / D-04 作为 Task A 窗口内的**顺手清理项**。

## Next Action

1. 本文档合入后转 Task A（Cluster 2/3/4 tsc errors，26 个）
2. Task A 顺手修 D-04（缩进）
3. Task A 如有余量，补 D-03 `prompt-session-assembler.test.ts`
4. D-01 / D-02 不 block，记录即可
