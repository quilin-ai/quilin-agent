# Planning-Track Review — 2026-04-24

> 范围：C0.1 – C1.8（9 commits, packages/agent-core/src/planning/** + 相关契约）
> Reviewer：Claude (Reviewer role)
> Commit 基线：`56135ff docs(planning): append §15 third-slice task book`
> 触发：第三轮并行切片启动前全量 review
> 实证基础：`pnpm tsc --noEmit` exit `0`；`pnpm test --run src/planning` = `9 files / 49 tests passed`；`wc -l` 全量复核

## 总评
- 风险总评分（0-1）：**0.18**（low）
- BLOCKING findings：**0**
- HIGH findings：**1**（S2 跨进程未真实联调，§11.3 row 95 已显式记录为已知缺口，不算契约违反）
- MEDIUM findings：**3**
- LOW findings：**4**
- 可进入第三轮切片：**YES**

理由：契约 A/B/C 三条全部以测试方式落地（fixture JSON 往返、tier 写入约束、checkpoint_failed 独立事件 + storageRef 不出现）。`applyEvent` 纯函数 + ReadonlyArray 类型契约由 `expectTypeOf` 静态强制。所有 commit message 的 LOC 与测试通过数与实测吻合（见证据表）。唯一未闭合的 S2 跨进程端到端联调在 §11.3 已显式记录为下一轮工作，不阻塞第三轮 C2.x / D-track 启动。

## Findings

### [HIGH] e82bd1f / 8275b2b checkpoint cross-process not exercised
- **What**：`checkpoint_failed` schema 已严格冻结并由 unit test 验证（`executor.test.ts:156-198`），但所有 checkpointWriter 都是 `vi.fn` 内联 throw 的 stub，没有真实 `providers/memory` MCP 端到端验证。
- **Where**：`packages/agent-core/src/planning/executor.test.ts:156-198`；`providers/memory/tests/test_store.py` 无 cross-process checkpoint 测试。
- **Why it matters**：契约 C 验收标准要求 "checkpoint 失败要产生重试/错误事件，不能静默丢失"；目前只验证了 TS 端的事件 emit，没有验证 OmniMem MCP 实际写入 episodic tier 的 wire roundtrip。§11.3 row 95 已记录此事实，因此**不构成 blocker**。
- **Suggested fix**：在第三轮 C2.x 或 M0.11 阶段加一条 integration test：起 `omnimem` MCP server，executor 走真 `MCPClientManager`，故意触发写失败（例如 stub server 返回错误），验证 `checkpoint_failed` payload 与 `recall(layer="episodic")` 没有出现 storageRef。
- **Evidence**：`grep "checkpoint" providers/memory/tests/` 只命中 `test_store.py` 的字面量字符串，无 cross-process 测试；breakdown §0.1 第二轮表格 row 95 原话 "尚未和 providers/memory 做真实跨进程端到端联调"。

### [MEDIUM] 8275b2b executor.ts 接近 400 行单文件阈值
- **What**：`executor.ts` 356 LOC，是 planning/ 子目录最大文件，且包含 1 个 class + 9 个 helper（`createTaskHash` 暴露顶层、`toErrorCode` / `cloneSnapshot` 为内部）。
- **Where**：`packages/agent-core/src/planning/executor.ts`。
- **Why it matters**：尚在 common/coding-style.md 800 行硬上限以下，但已超过 200-400 line typical 区间高位；后续 G-Replan / DAG / preflight extension 加进来很容易破 500。
- **Suggested fix**：在 C2.x 引入 G-Replan 之前，把 `writeCheckpoint` / `executeTool` / `createToolCall` / `toErrorCode` 抽到 `executor/internal.ts` 或 `executor/checkpoint.ts`；保留 `LinearPlanExecutor` 作为薄编排层。
- **Evidence**：`wc -l packages/agent-core/src/planning/executor.ts` = `356`；同目录第二大 `termination.ts` = `292`。

### [MEDIUM] 144e829 budget terminal dimension priority 隐含约定未在契约里记录
- **What**：`TERMINAL_DIMENSION_ORDER = [step, turn, retry, token]`（`budget.ts:63-68`）。当多维度同时超限时，错误归因优先级是产品决定，且 04-planning spec / ADR-005 都未记录此优先级；测试 `evaluateBudget.uses a stable exceeded-dimension order` 锁死了 step > token，但只有代码作为唯一真相源。
- **Where**：`packages/agent-core/src/planning/budget.ts:63-68` + `budget.test.ts:175-201`。
- **Why it matters**：04-planning §2.4 BudgetPressure 与 termination reason `MaxSteps` / `TurnBudgetExceeded` / `RetryBudgetExceeded` / `ResourceExhausted` 是 observability 标签；如果上层把 `MaxSteps` 当成 "用户写的 step 太多" 的 UX 提示，但实际是 token 先爆只是被 step 优先级 mask，会造成误诊。
- **Suggested fix**：在 04-planning §2.4 或 ADR-005 §3.3 增补一段 "Budget exceeded dimension priority" 表，并把 `budget.ts:63-68` 的常量加上 spec 行号注释。
- **Evidence**：`grep -n "TerminalReason\|MaxSteps\|TurnBudgetExceeded" docs/engineering/04-planning/README.md` 只描述各自语义，未规定多维同时超限时的归因。

### [MEDIUM] 8b7c183 decomposePlan 静默丢弃超 maxDepth 的 step
- **What**：`decomposePlan` 在 `eligibleSteps = normalizedSteps.filter(...maxDepth)` 后，再走 `slice(0, maxSteps)`；`omittedSteps` 同时统计被深度过滤掉的 + 被步数截断的。但 `truncated: true` 不区分两种丢弃原因，主 LLM 后续如果想 retry 拿不到精确反馈。
- **Where**：`packages/agent-core/src/planning/decompose.ts:140-156`。
- **Why it matters**：M0 mock 场景 OK，但 M1 进入 G-Replan 后 planner 需要知道是 "depth 触顶" 还是 "step 触顶" 来决定是否抬高 budget。
- **Suggested fix**：拆分返回字段：`omittedByDepth` / `omittedBySteps`；或在 `DecomposeResult` 加一个 `truncationReason: "depth" | "steps" | "both" | null`。
- **Evidence**：`Read decompose.ts:140-156` 显示二者合并为单一 `omittedSteps`；`decompose.test.ts:75-94` 的断言只检查 `omittedSteps: 2` 的合计。

### [LOW] c1856c0 spec 说 events: ReadonlyArray<AgentEvent>，实现叫 PlanningEvent
- **What**：04-planning §2.6 写 `events: ReadonlyArray<AgentEvent>`（`README.md:497`），实现是 `PlanningEvent`。
- **Where**：`packages/agent-core/src/planning/state.ts:114` vs `docs/engineering/04-planning/README.md:497`。
- **Why it matters**：纯命名漂移，不影响功能。但跨 spec / 代码搜索时容易误以为是两个类型。
- **Suggested fix**：在 spec §2.6 加一行 "实现命名为 `PlanningEvent`，别名 `AgentEvent` 留给 06-multi-agent 总事件 bus"，或反向把实现改名（前者代价更小）。
- **Evidence**：`grep -n "AgentEvent" docs/engineering/04-planning/README.md` = `497`；planning/ 全无 `AgentEvent`。

### [LOW] 7028e1b context.ts 错误吞下 + 无日志
- **What**：`recallMemory` 用 `try { client.recall } catch { NullMemoryClient().recall }`，错误被静默消化。
- **Where**：`packages/agent-core/src/planning/context.ts:32-45`。
- **Why it matters**：契约 C 要求 Memory 离线时 Planning 仍能跑，行为正确；但 common/coding-style.md "ALWAYS handle errors comprehensively / Log detailed error context" 要求至少 logger.warn。当前完全静默，运维难以发现 OmniMem 抖动。
- **Suggested fix**：注入 logger（默认 noop）打 `logger.warn({ err }, 'memory recall fell back to NullMemoryClient')`。也保护测试现有 fall-back 路径不变。
- **Evidence**：`Read context.ts:32-45` 显示 `catch {}` 空 block；`grep "logger" packages/agent-core/src/planning/` 无命中。

### [LOW] 8275b2b createToolCall arguments 浅拷贝
- **What**：`createToolCall` 用 `{ ...(step.arguments ?? {}) }` 做浅拷贝；嵌套对象仍然共享引用。
- **Where**：`packages/agent-core/src/planning/executor.ts:103-111`。
- **Why it matters**：上游 SubTask.arguments 是 `Readonly<Record<string, unknown>>`，TS 静态保证表层 readonly，但运行时下游 tool handler 修改嵌套对象会污染原 step。M0 内部 mock OK，第三方 tool 接入后是潜在 surprise。
- **Suggested fix**：用 `structuredClone(step.arguments ?? {})`，或在 executor 文档里写 "tool handler 必须把 arguments 当 deeply readonly"。
- **Evidence**：`Read executor.ts:103-111`。

### [LOW] e82bd1f termination DEAD_LOOP_FIXTURE 是 production 模块的常量
- **What**：`DEAD_LOOP_FIXTURE` 121 行 fixture 数组放在 `termination.ts`（production 模块），而不是 `termination.fixtures.ts`。
- **Where**：`packages/agent-core/src/planning/termination.ts:60-181`。
- **Why it matters**：让 `termination.ts` 变成 292 行，其中 ~120 行是测试数据；增加 prod bundle 体积（~5KB），且模糊"代码 vs fixture"边界。
- **Suggested fix**：把 fixture 抽到 `termination.fixtures.ts`，从测试文件 import。
- **Evidence**：`wc -l termination.ts` = `292`，去掉 fixture 后约 170 行；`grep "DEAD_LOOP_FIXTURE" packages/agent-core/src` 只在 `termination.test.ts` 命中一次。

## Contract cross-check 表

| 契约 | 来源 | 实现位置 | 实测结论 |
|---|---|---|---|
| A: PlanContext.memoryRecall = ReadonlyArray<MemoryItem> | ADR-005 §3.1 / 04-planning §2.7 | `context.ts:8-15` + `client.test.ts` JSON fixture roundtrip | ✅ 形状对齐，离线返回空数组 |
| A: 新增字段必须可选 | ADR-005 §3.1 | `types.ts` SubTask `skillHint?/arguments?/depth?/writeScope?/risk?` | ✅ |
| B: 运行中 PlanningState 不进 semantic | 04-planning §2.9.2 | 实现没有 semantic 写入路径；executor 只 emit checkpoint 事件 | ✅ 被动满足（无写入接口） |
| B: writeScope 枚举 | breakdown §3.2 | `types.ts:17-22` `none/working/episodic/semantic/skill` | ✅（多了 "none" 是合理的 sentinel，spec 没禁止） |
| C: checkpoint await 成功 | ADR-005 §3.3 | `executor.ts:317-340` `await this.options.checkpointWriter(...)` | ✅ |
| C: checkpoint_failed 字段 = run_id/phase/task_hash/error_code/ts | ADR-005 §3.3 | `state.ts:30-36` + `executor.ts:341-354` | ✅ snake_case 与 ADR 一致 |
| C: 不得用 storageRef: null | ADR-005 §3.3 | `executor.test.ts:197` `expect(JSON.stringify(failedEvent)).not.toContain("storageRef")` | ✅ 主动负向断言 |
| Intent 四分类 | 04-planning §2.1 | `types.ts:3-7` | ✅ 完全一致 |
| applyEvent 纯函数 | 04-planning §2.6 | `state.test.ts:81-105` `next !== initial`、`initial.events !== next.events` | ✅ |

## 证据抽样（commit message LOC/测试声明 vs 实测）

| Commit | 声明 | 实测 | 差异 |
|---|---|---|---|
| c1856c0 | types.ts 73 / state.ts 218 | types.ts 76 / state.ts 224 | +3 / +6（C1.5、C1.2 后续追加，符合时序） |
| 49b48f5 | intent.ts 98 / intent.test.ts 185 / 376 passed | intent.ts 98 / intent.test.ts 186 / 11 tests now pass | +1 行（trailing newline 调整） |
| 144e829 | budget.ts 199 / budget.test.ts 202 / 385 passed | 一致 / 9 tests | ✅ |
| 7028e1b | context.ts 59 / context.test.ts 129 / 388 passed | 一致 / 3 tests | ✅ |
| 726802a | planner.ts 52 / planner.test.ts 158 / 394 passed | planner.ts 65 / planner.test.ts 185（C1.5 增补 27+15） | 时序一致 |
| 8b7c183 | decompose.ts 157 / decompose.test.ts 135 / 400 passed | 一致 / 5 tests | ✅ |
| 8275b2b | executor.ts 356 / executor.test.ts 224 / 405 passed | 一致 / 5 tests | ✅ |
| e82bd1f | termination.ts 292 / termination.test.ts 164 / 409 passed | 一致 / 4 tests | ✅ |
| 3357c91 | integration.test.ts 215 / 410 passed | 一致 / 1 test | ✅ |
| 全量重测 | — | `pnpm tsc --noEmit` exit `0`；planning/ 49 tests passed in 171ms | ✅ |
| 边界 | "不写到 planning/ 以外" | C0.2 改了 memory/，C0.3 / C1.x 改了 src/index.ts re-export，**未越界** | ✅ |

## Unblock / 整改建议

### 第三轮切片开工**前**必修（无）
没有 BLOCKING / 必修项。

### 第三轮切片**并行可补**（建议本轮内闭合）
- HIGH: 在 C2.x 或 M0.11 加 1 条 cross-process checkpoint integration test，把 §11.3 row 95 升级为已闭合事实。
- MEDIUM: budget terminal priority 写进 04-planning §2.4 或 ADR-005，避免上层 UX 误诊。
- MEDIUM: `decomposePlan` 增加 `truncationReason`，给 G-Replan 留接口。

### 可 defer 到 C2 完成后再处理
- MEDIUM: `executor.ts` 拆分为 `executor/`+`checkpoint.ts`（在 G-Replan 落地前最佳时机）。
- LOW × 4：context warn log、createToolCall structuredClone、DEAD_LOOP_FIXTURE 抽离、AgentEvent vs PlanningEvent 命名对齐。

## 抽样实证 Disclosure

本次 review 实地复核：
- 9 commit 的 `git show --stat` 全量读取。
- planning/ 目录全部 18 文件（9 src + 9 test）的 `wc -l` 与文件内容。
- ADR-005 §3.1/3.2/3.3 全文。
- 04-planning §2.6 / §2.7 / §2.9.2。
- Iter C/M parallel breakdown §0.1 / §3 / §11.2 / §11.3。
- `pnpm tsc --noEmit` 与 `pnpm test --run src/planning` 当场跑通，9 文件 49 测试全部通过，171ms。

未抽查项（不影响本轮结论）：providers/memory python 侧实际 store/recall fixture 内容（仅核对了 §11.2 已记录的 65 / 71 passed 数字）；Vercel AI SDK 接入端的 Planner 真实 LLM 调用（M0 全部 mock，符合 §4.2 验收）。
