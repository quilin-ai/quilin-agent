# 研究笔记：OpenHands Software Agent SDK 的 event-sourced 架构

**日期**：2026-04-20
**来源**：arXiv 2511.03690（All Hands AI, Nov 2025）
**status**：研究笔记 / 未决策（prior-art 输入给 ADR-001）
**用途**：为 Quilin `agent-core` 自建 Agent Loop 提供参考基线；不是要 fork，是要**学其模式**。

## 一句话总结

OpenHands 新版 SDK 把 agent loop 重构成**无状态 agent + 事件流（event-sourced）+ 4 包分离**的模式，在 Claude Sonnet 4.5 上跑出 **SWE-bench Verified 72% + GAIA 67.9%** 的成绩。这是 2026-04 公开 agent runtime 里最接近 Quilin 设计目标的 prior-art。

## 关键架构决策

### 1. Stateless Agent + Event-Sourced State

**OpenHands 做法**：
- `Agent` 本身无可变状态，每次 `step(conversation, tools) → event[]` 都是纯函数
- 真正的 state 存在 `Conversation` 的 event stream 里（append-only）
- Checkpoint / resume / replay 天然可行，只要 replay event stream

**对 Quilin 的启示**：
- 我们当前 ADR-001 定了 "<200 LOC Agent Loop"，但 state 存储策略未明确
- OpenHands 证明 event-sourced 可在 200-400 LOC 内实现；作为 benchmark
- 与 08-observability 的 trace 天然对齐（每个 event 就是一个 span）
- 与 10-self-evolution 的 trajectory analyzer 天然对齐（trajectory == event stream）

### 2. 四包分离

```
@openhands/sdk          # Agent + Conversation（纯函数）
@openhands/tools        # Tool definitions（与 SDK 解耦）
@openhands/workspace    # Sandbox / Runtime adapters
@openhands/server       # Remote execution layer
```

**对 Quilin 的启示**：
- 我们 packages/agent-core 目前是单包；长期看 tool registry 和 sandbox 应该分离
- 避免了 Quilin 当前 05-tool ↔ loop.ts ↔ sandbox 三者的隐式耦合

### 3. 显式 Confirmation Policy

OpenHands 把 "是否确认" 做成 policy plug-in（不是硬编码在 agent loop）。
**对 Quilin 的启示**：
- 我们 07 §2.6.4 WriteAuthority 已经是 policy（✅ 一致）
- 但 `packages/agent-core/src/loop.ts` 内的确认逻辑应该改成调用 policy，不要 inline

### 4. 接口层隔离

OpenHands SDK 可被 CLI / REST / Slackbot / VSCode 共用，因为 Agent 不绑定 I/O。
**对 Quilin 的启示**：
- 我们 09-deployment-runtime 已经规划 CLI + WebUI + IM，但 `agent-core` 当前可能过早绑定 CLI 形态；要验证

## 值得直接借鉴的模式

| # | 模式 | 落地到 Quilin 哪里 |
|---|-----|-------------------|
| 1 | Event stream 是 state truth | `packages/agent-core/src/state/event-stream.ts`（新建） |
| 2 | Agent.step() 纯函数 | loop.ts 重构 |
| 3 | `conversation.replay(events)` | checkpoint 恢复，08 observability 配合 |
| 4 | 4 包分离 | 未来 pnpm workspace 拆 tools/workspace/server |
| 5 | Confirmation as policy | 已由 WriteAuthority 实现 ✅ |

## 不适用 / 需要警惕的部分

- **Workspace 远程执行**：OpenHands 支持远程 sandbox，我们 Iter B 只做本地 exec；延后
- **Session manager**：OpenHands 的 multi-session server 偏产品形态；我们在 WebUI Dashboard 领域（08）自己做
- **Tools 注册表形态**：他们用 TypedDict-like schema；我们有 MCP + 4-type action space（D-07）差异大，别照搬

## 得分的必要条件（论文实验）

- 模型：Claude Sonnet 4.5
- Tools：file_edit / bash / think（最小集）
- Prompting：最小 system prompt，避免大段指令
- Budget：每个 SWE-bench Verified task ≤50 step

**对我们的启示**：SWE-bench Verified top-10 不需要复杂 skill / memory，**简单 loop + 好 tools + Claude Sonnet 4.5** 就能到 72%。Iter E2 的 75% 目标和这个基线自洽。

## Next action

- [ ] 把 "event-sourced state" 加进 ADR-001 的 "后续细化" 清单
- [ ] 在 loop.ts 实现前，先 spike event-stream 抽象层（50-80 LOC，不进 master 之前做 POC）
- [ ] 对比本 note 每条和 02-context ContextAssembler 的 state 模型，看有没有冲突

## 参考

- [arXiv 2511.03690 — OpenHands SDK](https://arxiv.org/abs/2511.03690)
- [docs.openhands.dev/sdk](https://docs.openhands.dev/sdk)
- [All Hands AI blog](https://www.all-hands.dev/blog)
