# Iter C × Iter M 并行任务拆分

> 日期：2026-04-23
> 状态：草稿收敛中（Draft for convergence）
> 背景：Memory 从 Iter F 抽出为独立 Iter M，与 Iter C（Planning）并行开工。
> 范围：任务拆分、依赖拓扑、契约冻结、L3a Arm L 分叉、idle-budget 边界、跨 track 同步点。
> 不做：不改运行时代码、不展开 spec 级细节、不给甘特图。

## 0. 实证基线

本计划基于以下已存在文档和实证状态：

| 事项 | 证据 |
|---|---|
| Iter C 尚未开工，主轴为 Planning Core | `docs/planning/00-implementation-plan.md` Iteration C |
| Planning v1.1 采用 Main LLM direct + 结构化分派 + 可选 audit 层 | `docs/engineering/04-planning/README.md` §2.1 / §五 |
| `PlanningState` 为事件溯源（event-sourced），checkpoint 写入 OmniMem episodic tier | `docs/engineering/04-planning/README.md` §2.6 |
| `PlanContext.memoryRecall` 从 OmniMem 拉取 | `docs/engineering/04-planning/README.md` §2.7 |
| Planning 对 working / episodic / semantic 有明确写入纪律 | `docs/engineering/04-planning/README.md` §2.9.2 |
| Memory M0/M1/M2 原归 Iter F Sprint 1/2/3 | `docs/engineering/03-memory/README.md` §A.8 |
| `MemoryStore` Protocol 已定义 | `docs/engineering/03-memory/README.md` §MemoryStore 接口设计 |
| L3a rule-first v2-r3 门槛失败：recall 21.4%、中文 recall 0% | `docs/engineering/03-memory/README.md` §A.7 |
| L3a rule-first v3 FPR 失败（10.2% vs ≤5% 门槛） | `docs/adr/adr-004-l3a-observer-strategy.md` §2.2 |
| ADR-004 已占用为 L3a Observer Strategy，决策为条件性 d2 ML-first | `docs/adr/adr-004-l3a-observer-strategy.md` §2.4 / §3 |
| ADR-004 Arm L 权威门槛：recall ≥60% / FPR ≤3% / p95 ≤50ms | `docs/adr/adr-004-l3a-observer-strategy.md` 145-146 行 |
| ADR-004 最新相关 commit | `1f0bfe9 docs(l3a): v3 observer spike report + ADR-004 decision` |
| Iter F 仍包含 Idle Evolution，默认关闭、需显式 opt-in | `docs/planning/00-implementation-plan.md` Iteration F |

### 0.1 当前执行进展（2026-04-23）

> 本节只记录已落地事实与实证，任务定义仍以 §4 / §5 / §9 / §11 为准。

#### Day 0 契约冻结（§11.1）— 已完成

| 任务 | 状态 | commit | 实证 |
|---|---|---|---|
| S0 契约冻结 | ✅ 完成 | `d9ebdf3 docs(adr): ADR-005 memory contracts skeleton` | `wc -l docs/adr/adr-005-memory-contracts.md` = `131` |
| C0.1 Planning 类型 | ✅ 完成 | `c1856c0 feat(planning): freeze LLMPlannerResponse / PlanningState contracts (C0.1)` | `pnpm tsc --noEmit` exit `0`；`pnpm test` 通过 |
| M0.1 Memory 契约 | ✅ 完成 | `cc125ca feat(memory): MemoryItem + MemoryStore Protocol + fixture (M0.1)` | `uv run pytest -q` 通过 |
| C0.2 TS Memory adapter | ✅ 完成 | `6b8544e feat(memory): TS memory adapter stub (C0.2)` | TS/Python fixture JSON shape 对齐测试通过 |
| M0.4 API 兼容性 | ✅ 完成 | `33e7466 feat(memory): MCP server recall/store compatibility (M0.4)` | `memory_store(layer=...)` 与 legacy `tier` 兼容测试通过 |

补充文档落点：`c2f36c7 docs(planning): add Iter C/M parallel breakdown` 将本计划纳入版本控制，并修正 ADR-005 规范源路径为 `docs/adr/adr-005-memory-contracts.md`。

#### 第一轮并行切片（§11.2）— 已完成

| 路线 | 任务 | 状态 | commits | 实证 |
|---|---|---|---|---|
| Iter C | C1.1 / C1.2 / C1.3 | ✅ 完成 | `49b48f5` / `144e829` / `7028e1b` | `cd packages/agent-core && pnpm tsc --noEmit` exit `0`；`pnpm test` = `388 passed`, `0 skipped` |
| Iter M | M0.2 / M0.3 / M0.5 | ✅ 完成 | `66fc714` / `a5640ac` / `1a3957d` | `cd providers/memory && uv run pytest -q` = `65 passed` |
| L3a | M0.7 / M0.9a | ✅ M0.7 完成；M0.9a blocked | `b515dfa` / `bb76f9f` | Observer no-op contract 测试通过；Arm L blocked：`ANTHROPIC_API_KEY` unset、`ollama` absent、`localhost:11434` 连接失败；1039 样本 dataset 存在 |
| 同步 | S1 / S2 | ✅ 初步对齐 | 同上 | S1：`MemoryItem.metadata.schema_version/source/score/staleness` 与 TS `MemoryClient.recall()` 已对齐；S2：episodic checkpoint metadata `run_id/event_seq/phase/task_hash/schema_version` 与独立 `checkpoint_failed` 事件字段已对齐 |

第一轮核心文件 LOC 实证：

| 文件 | LOC |
|---|---:|
| `packages/agent-core/src/planning/intent.ts` | `98` |
| `packages/agent-core/src/planning/budget.ts` | `199` |
| `packages/agent-core/src/planning/context.ts` | `59` |
| `providers/memory/src/omnimem/working.py` | `87` |
| `providers/memory/src/omnimem/episodic.py` | `166` |
| `providers/memory/src/omnimem/observer.py` | `157` |
| `docs/research/arm-l-observer-spike-report.md` | `161` |

#### 第二轮并行切片（§11.3）— 已完成（2026-04-24）

| 路线 | 任务 | 状态 | commits | 实证 |
|---|---|---|---|---|
| Iter C | C1.4 / C1.5 / C1.6 / C1.7 / C1.8 | ✅ 完成 | `726802a` / `8b7c183` / `8275b2b` / `e82bd1f` / `3357c91` | `cd packages/agent-core && pnpm tsc --noEmit` exit `0`；`pnpm test` = `410 passed`, `0 skipped` |
| Iter M | M0.6 / M0.8 / M0.10 | ✅ 完成 | `1797737` / `de3fb31` / `dce589a` | `cd providers/memory && uv run pytest -q` = `71 passed`；1000-row BM25 p95 `0.349ms`；fused recall p95 `0.174ms`；AMB harness p95 `5.795ms` |
| L3a | S4 Arm L Spike Gate | ✅ blocked gate 记录已形成；不是 pass/fail | `a1800c6` | `ANTHROPIC_API_KEY` unset（`test -n` exit `1`）；`ollama` absent（`command -v` exit `1`）；`localhost:11434/api/tags` curl exit `7`；1039 样本 dataset 已存在 |
| L3a | M0.9b | ✅ blocked/deferred 边界已冻结 | `a1800c6` | 不实现 ML-first 生产 observer；不把资源 blocked 误判为 d3 fail；继续沿用 M0.7 no-op contract；Memory M0 硬门槛仍排除 L3a |
| 同步 | 不含 L3a 的 M0 硬门槛验收 | ✅ 初步闭合 | 同上 | Planning M0 线性 mock 集成已通过；Memory M0 L1/L2 + FTS/BM25 + 融合召回 + AMB 替代证据已通过；LongMemEval 按 O3 记录为数据集 blocked |

第二轮核心文件 LOC 实证：

| 文件 | LOC |
|---|---:|
| `packages/agent-core/src/planning/planner.ts` | `65` |
| `packages/agent-core/src/planning/decompose.ts` | `157` |
| `packages/agent-core/src/planning/executor.ts` | `356` |
| `packages/agent-core/src/planning/termination.ts` | `292` |
| `packages/agent-core/src/planning/planning.integration.test.ts` | `215` |
| `providers/memory/src/omnimem/retriever.py` | `219` |
| `providers/memory/tests/test_retriever.py` | `164` |
| `providers/memory/tests/test_memory_baseline.py` | `43` |
| `providers/memory/benchmarks/amb_baseline.py` | `217` |
| `docs/research/arm-l-observer-spike-report.md` | `161` |

第二轮收口后的剩余风险：

- M0.9a 仍是资源 blocked，不是 Arm L pass/fail；解锁后仍需跑 Arm L 推理并产出 recall/FPR/p95/cost，再决定 M0.9b 的 ML-first 或 d3 opt-in/default-off 路径。
- S1 的 `MemoryItem.metadata.source/score/staleness/schema_version` 已由 M0.8 融合召回回填并有测试；`task_context?` 仍是后续 M1 task-aware ranking 的预留扩展位。
- S2 checkpoint 跨进程端到端联调已补齐：TS `LinearPlanExecutor` 触发 `checkpoint_saved`，经 MCP `memory_store` 写入 `uv run python -m omnimem`，再由 TS `memory_recall` 读回并校验 `stateSnapshot`；实证见 §16.5。
- LongMemEval 数据集未 vendored 到仓库，本轮按 O3 以 AMB 四轴离线 harness 作为 M0.10 替代证据。
- 第三方 MCP / Skills CLI config loader 仍未接入；底层 API 已有，CLI 产品路径需另开切片。

#### 第三轮并行切片（§15 方案 A 三路并行）— 已完成（2026-04-24）

| 路线 | 任务 | 状态 | commit | 实证 |
|---|---|---|---|---|
| Halley (C-track) | C2.5 PlanReviewRecord writer + audit/goal-drift/replan | ✅ 完成 | `3b60904` | `wc -l packages/agent-core/src/planning/memory-writer.ts` = `223`；6 禁字段 NEGATIVE + sha256 stable id 测试通过 |
| Hooke (M-track) | M1.2 KG / M1.3 hybrid retriever / M1.4 event log + reranker / M1.5 semantic guard / M1.6 recall metadata | ✅ 完成 | `77e399a` | `cd providers/memory && uv run pytest -q` = `86 passed`；`event_log.py` = `439` LOC；`reranker.py` = `134` LOC；`retriever.py` 回填 `cache_key/block_version/source_layers`；planning_review + planning_state 双向 NEGATIVE 测试覆盖 |
| Pascal (Config-track) | CLI→env→.quilin→builtin 四级加载器 | ✅ 完成 | `4496cb4` | `wc -l packages/agent-core/src/config/loader.ts` = `398`；zod strict schema + builtin fallback 保留既有 REPL 行为 |
| Cross-cutting | ADR-005 反向链接（HIGH-1 闭合） | ✅ 完成 | `0b79520` | `docs/engineering/03-memory/README.md` + `docs/planning/00-implementation-plan.md` 已链接至 ADR-005 |
| 同步 | S3 PlanReviewRecord schema 冻结 | ✅ 对齐 | `77e399a` / `3b60904` | `store.py` 验证 `layer=semantic` + `content_type=json` + `schema_version=1` + `run_id` 对齐；TS writer 同轨字段 |
| Review gate | §16.6 Q2 follow-up third-slice review | ✅ 完成并修复 | `docs/review/2026-04-24-04-third-slice-review.md` | BLOCKING `0` / HIGH `0` / MEDIUM `1` / LOW `2`；MEDIUM/LOW 已修复或文档化；§16.6 gate 可闭合 |
| Direction 5 | lint sweep | ✅ 完成 | `a1276b8` | `just check` 通过；`just lint-py` 通过；`cd packages/agent-core && pnpm tsc --noEmit` exit `0`；`pnpm test` = `444 passed`；`cd providers/memory && uv run pytest -q` = `98 passed` |

第三轮核心文件 LOC 实证：

| 文件 | LOC |
|---|---:|
| `packages/agent-core/src/planning/memory-writer.ts` | `223` |
| `packages/agent-core/src/planning/audit.ts` | `99` |
| `packages/agent-core/src/planning/goal-drift.ts` | `152` |
| `packages/agent-core/src/planning/replan.ts` | `233` |
| `packages/agent-core/src/planning/decompose.ts` | `273` |
| `packages/agent-core/src/planning/state.ts` | `242` |
| `packages/agent-core/src/config/loader.ts` | `398` |
| `providers/memory/src/omnimem/retriever.py` | `493` |
| `providers/memory/src/omnimem/kg.py` | `477` |
| `providers/memory/src/omnimem/event_log.py` | `439` |
| `providers/memory/src/omnimem/reranker.py` | `134` |
| `providers/memory/src/omnimem/server.py` | `186` |
| `providers/memory/src/omnimem/store.py` | `1036` ⚠ 超 800 软线 — §16.1 follow-up |
| `providers/memory/tests/test_planning_integration.py` | `121` |

第三轮收口后的剩余风险与 follow-up → 见 §16；第三轮 review 发现的新增 follow-up 已处理：Halley fallback logger 失败不再破坏 advisory writer（已修）、Pascal explicit config 与 builtin REPL 的 registry/namespace 语义差异已文档化、Hooke KG duplicate seed 已去重。

## 1. 当前共识

- Memory 从 Iter F 抽出为独立 Iter M，与 Iter C 并行开工。
- 并行前唯一硬前置是三条契约冻结：API 稳定性、tier 语义兼容、异步感知。
- L3a 不阻塞 Planning，也不阻塞 Memory L1/L2/L3c/检索主路径。
- L3a 只阻塞 M0.9b、M1.1、M1.2 中 observation/KG 的子集。
- Memory M0 硬门槛剥离 L3a，只以 L1/L2 + FTS/BM25 + 融合召回为准。
- M0.7 只冻结 Observer 接口 + no-op 实现；M0.9a/M0.9b 等 Arm L 结果再走实现路径。
- Arm L 权威门槛以 ADR-004 为准（`recall ≥60% / FPR ≤3% / p95 ≤50ms`）；成本条件作为部署层 qualifier，由 ADR-006 定稿。
- Idle-budget 采用方案 C：Iter M M2 只交付 idle-budget stub + Consolidator dry-run/no-op，真实 idle loop 留到 Iter F。
- M1.4 Learnable Reranker 不等待 Iter D OTel，先用本地 SQLite event log 收集训练信号；Iter D OTel 就绪后再迁移或双写。
- ADR-004 已被占用；**Memory 契约升 ADR-005**（O2 已决），S0 冻结同一天起草 `adr-005-memory-contracts.md`；本计划是执行清单，ADR-005 是规范源。
- **ADR-007 起草 identity files 契约**（O8 已决），M1.7 落地前产出 draft；定 `.quilin/user.md` / `.quilin/soul.md` 的位置、格式、写入权、审批路径、git 入/出、跨项目共享策略。
- `user.md` 本期完整交付，归属 03-memory（UserProfile Store 的人可读投影）：M1.7 加 UserProfile Store + ProfileUpdater，M1.8 加 user.md 双向镜像。
- `soul.md` 本期只做读路径（M2.6 frontmatter schema → M2.7 静态加载），归属 10-self-evolution；**自进化写路径留到 Iter F**。02-context 作为读消费方，不是 owner。

## 2. 不做事项

- 不引入 LangGraph 或其他外部 planning runtime。
- 不在 Iter C 引入本地小分类器；Planning intent 仍是 Main LLM direct + 结构化分派。
- 不让 Planning 直接读写 `SKILL.md`。
- 不把运行中的 plan state 写入 semantic memory。
- 不在 Iter M 实现真实的 Idle Evolution loop。
- 不让 L3a Arm L 决策阻塞 L1/L2/FTS/BM25/融合召回。
- 不把 Learnable Reranker 绑定到 OTel 才能启动。
- **不在本期实现 `soul.md` 的写路径**（self-evolution propose + WriteAuthority 审批），本期仅做只读加载与 schema 冻结。
- 不把 `user.md` 设计成主真相源：SQLite 是真相源，`user.md` 是人可读镜像，回流走 ProfileSignal。

## 3. 并行前置：三条契约冻结

> **ADR-005 Memory Contracts（O2 决议）**：三条契约升 ADR-005，S0 冻结同一天起草 `docs/adr/adr-005-memory-contracts.md`。ADR-005 是**规范源**，本章节是**执行清单**；冲突时以 ADR-005 为准。

### 3.1 契约 A：API 稳定性

| 项 | 冻结内容 |
|---|---|
| Python 结构 | `MemoryItem` 字段、layer 枚举、metadata schema 版本、score/source/staleness 元数据 |
| Python Protocol | `MemoryStore.add/search/get/update/delete/list_by_layer/count/clear_layer` |
| OmniMem API | `store()`、`recall()`、`reflect()` |
| TS 结构 | `MemoryItem` 镜像类型、`PlanContext.memoryRecall: ReadonlyArray<MemoryItem>` |
| 向后兼容 | 新增字段只能是可选字段；删除/重命名字段必须走计划变更或 ADR |

落点：

| 文件 | 动作 |
|---|---|
| `providers/memory/src/omnimem/types.py` | 冻结 Python `MemoryItem` |
| `providers/memory/src/omnimem/store.py` | 冻结 `MemoryStore` Protocol |
| `packages/agent-core/src/memory/types.ts` | 新增 TS 镜像类型 |
| `packages/agent-core/src/memory/client.ts` | 新增 Memory client / no-op adapter |
| `docs/engineering/03-memory/README.md` | 同步 Protocol 表 |
| `docs/engineering/04-planning/README.md` | 同步 `PlanContext.memoryRecall` 契约 |
| `docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md` | 本文档作为并行期间的冻结源 |
| `docs/adr/adr-005-memory-contracts.md` | ADR-005 Memory Contracts 规范源；不再另建 `adr-005-iter-m-memory-contracts.md` |

验收标准：

| 标准 | 说明 |
|---|---|
| JSON fixture 往返 | Python `MemoryItem` 与 TS `MemoryItem` 使用同一 fixture 可互通 |
| 默认/离线路径 | Memory 离线时 Planning 仍可运行，`recall()` 返回空数组 |
| schema 版本 | Memory 结果 metadata 必须带 `schema_version` |
| 只允许可选字段演进 | 新字段必须可选，不破坏旧 fixture |

### 3.2 契约 B：Tier 语义兼容

| Tier | 允许写入 | 禁止写入 |
|---|---|---|
| working | 当前 plan 树、当前叶子、最近对话轮、session 内临时 scratch | 跨 session 的稳定策略 |
| episodic | 最终 plan、checkpoint、replan 历史、失败原因、调试轨迹 | 未经复盘的长期知识 |
| semantic | 复盘后的稳定策略、跨任务通用经验、明确用户偏好 | 运行中的 `PlanningState`、失败 plan 原文、临时工具结果 |
| skill | skill 的使用/成功/失败计数器 | skill 正文、触发 pattern、`SKILL.md` 内容 |

落点：

| 文件 | 动作 |
|---|---|
| `docs/engineering/04-planning/README.md` §2.9.2 | 更新 tier 写入矩阵 |
| `docs/engineering/03-memory/README.md` Layer 4 / MemoryStore 小节 | 更新 skill tier 单写方纪律 |
| `docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md` | 本计划冻结并行期间的 tier 语义 |
| `docs/adr/adr-005-memory-contracts.md` | ADR-005 Memory Contracts 规范源；跨 spec 冲突先修订此 ADR 或另起新 ADR 编号 |

验收标准：

| 标准 | 说明 |
|---|---|
| Planning 测试 | 运行中的 plan state 不能写入 semantic |
| Memory 测试 | skill tier 不能保存 skill 正文 |
| 集成测试 | checkpoint 写 episodic；只有稳定的复盘总结才能写 semantic |
| review 纪律 | 任何 semantic 写入必须带 `source`、`schema_version`、`stability_reason` |

### 3.3 契约 C：异步感知

| 项 | 冻结内容 |
|---|---|
| 同步路径 | L1 working 写入 + L2 verbatim episodic 写入 |
| 异步路径 | L3a observer、L3b KG、L3c 向量/索引刷新、reranker 训练信号 |
| 失败语义 | 异步路径失败不阻塞 L2 verbatim，不阻塞 Planning |
| 召回语义 | `recall()` 可以返回带 stale 标记的结果 |
| checkpoint 语义 | checkpoint 写 episodic 必须 await 成功，或写入明确的失败事件 |
| OTel 前的可观测性 | Iter M M1.4 先用本地 SQLite event log；Iter D OTel 就绪后迁移或双写 |

落点：

| 文件 | 动作 |
|---|---|
| `docs/engineering/03-memory/README.md` §A.5 / §A.6 | 明确异步写/读语义 |
| `docs/engineering/04-planning/README.md` §2.6 | 明确 checkpoint 失败处理 |
| `providers/memory/src/omnimem/event_log.py` | M1.4 本地 event log |
| `providers/memory/src/omnimem/retriever.py` | recall 结果的 staleness/source 元数据 |
| `packages/agent-core/src/planning/state.ts` | checkpoint 失败事件 |

验收标准：

| 标准 | 说明 |
|---|---|
| 故障注入 | L3a/KG/reranker 失败不影响 Planning M0 端到端 |
| 新鲜度元数据 | recall 结果带 source/layer/score/staleness |
| checkpoint 失败 | checkpoint 失败要产生重试/错误事件，不能静默丢失 |
| 本地 event log | M1.4 不依赖 OTel 也能收集检索/引用样本 |

## 4. Iter C 任务拆分

颗粒度目标：每个任务 ≤ 2–3 天。

### 4.1 C0 契约与骨架

| ID | 任务 | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|---|
| C0.1 | Planning 类型契约冻结 | `packages/agent-core/src/planning/types.ts`；`packages/agent-core/src/planning/state.ts`；`packages/agent-core/src/planning/state.test.ts` | `applyEvent()` 纯函数回放通过；`PlanningState` 只读；核心类型 LOC ≤ 250 | 三契约冻结 | C1.1、C1.2、M0.5 |
| C0.2 | Planning 侧 Memory adapter stub | `packages/agent-core/src/memory/types.ts`；`packages/agent-core/src/memory/client.ts`；`packages/agent-core/src/memory/client.test.ts` | TS/Python fixture shape 对齐；no-op client 支持 `recall/store`；Memory 离线不影响 Planning | C0.1、M0.1 | C1.3、M0.4 |
| C0.3 | Planning 模块导出 | `packages/agent-core/src/planning/index.ts`；必要时更新 package export | 现有 Vitest 全部通过；不出现误导出的内部符号 | C0.1 | C1.x 系列任务 |

### 4.2 C1 M0 线性 Planning MVP

| ID | 任务 | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|---|
| C1.1 | 意图结构化分派 | `packages/agent-core/src/planning/intent.ts`；`intent.test.ts` | 简单问答不触发 planning；tool call / planSketch / clarification 响应 shape 分类正确；单测零 LLM 调用 | C0.1 | C1.4 |
| C1.2 | 预算账本与步数预算 | `packages/agent-core/src/planning/budget.ts`；`budget.test.ts` | token/turn/retry 预算扣减可确定；超预算返回 terminal 决策；边界值已覆盖 | C0.1 | C1.5、C1.6 |
| C1.3 | PlanContext 组装桥接 | `packages/agent-core/src/planning/context.ts`；context 桥接测试 | `conversationHistory/memoryRecall/skillCatalog/budget` 可组装；Memory 离线时返回空 recall | C0.2；M0.4 可选 | C1.4、S1 |
| C1.4 | Main LLM direct deliberate 封装 | `packages/agent-core/src/planning/planner.ts`；`planner.test.ts` | mock LLM 一次产出 answer/tool_calls/clarification/planSketch；`classifyIntent(response)` 纯函数测试通过 | C1.1、C1.3 | C1.5 |
| C1.5 | 线性优先分解器 | `packages/agent-core/src/planning/decompose.ts`；`decompose.test.ts` | 复用 `planSketch`；max steps/depth 生效；step 带 action/preconditions/effects/writeScope/risk | C1.2、C1.4 | C1.6、C3.1 |
| C1.6 | M0 Executor 状态循环 | `packages/agent-core/src/planning/executor.ts`；`executor.test.ts` | ≤ 20 步的线性任务 mock 端到端通过；每步产生 `AgentEvent`；失败写入 tool/repair 事件；**checkpoint 失败走独立 `checkpoint_failed` 事件**（O5 已决：含 `run_id/phase/task_hash/error_code/ts`，不用 `storageRef: null`） | C1.5 | C1.7、C1.8 |
| C1.7 | 终止条件检测器 | `packages/agent-core/src/planning/termination.ts`；`termination.test.ts` | 覆盖 Success / MaxSteps / UserInterrupt / DeadLoop；dead loop fixture 命中 | C1.6 | C1.8 |
| C1.8 | Iter C M0 集成场景 | `packages/agent-core/src/planning/planning.integration.test.ts` | “搜索竞品 → 整理表格 → 生成建议” mock scenario 通过；Skills `skill_view` 按需加载；只支持 L-Rearrange | C1.6、C1.7 | C2.1 |

M0 验收门槛：

| 门槛 | 目标 |
|---|---|
| 功能 | 多步任务端到端跑通，≤ 20 步 |
| 意图 | 简单问答不触发 planning |
| Skills | `skill_view` 按需加载验证通过 |
| Memory | working + episodic 可用；semantic 写入不启用 |
| 重规划 | 只支持 L-Rearrange / 本地修复 |
| 测试 | Planning 单测 + M0 集成测试全部通过 |

### 4.3 C2 M1 Audit 层 + L-Redecompose

| ID | 任务 | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|---|
| C2.1 | Audit 层（仅观测） | `packages/agent-core/src/planning/audit.ts`；`audit.test.ts` | audit 不改变决策；记录 `intentHint/confidence`；一致率 metric fixture 可计算 | C1.4 | C2.5 |
| C2.2 | 本地修复与 L-Rearrange | `packages/agent-core/src/planning/replan.ts`；`replan.test.ts` | tool 失败 / 前置条件缺失 / 重试耗尽 都能触发正确 patch；不调用 G-Replan | C1.6 | C2.3 |
| C2.3 | L-Redecompose 局部重分解 | 扩展 `replan.ts` 与 `decompose.ts` | 局部子树替换；不重写全局 plan；事件回放后状态一致 | C2.2 | C2.4 |
| C2.4 | 目标漂移检测器 | `packages/agent-core/src/planning/goal-drift.ts`；`goal-drift.test.ts` | drift 触发覆盖率 100%；默认阈值 0.65 可配置；drift 事件可写 episodic | C1.2、C2.3 | C2.5 |
| C2.5 | M1 语义复盘写入 hook | `packages/agent-core/src/planning/memory-writer.ts`；memory writer 测试 | 只把复盘后的稳定策略写入 semantic；运行中状态不写 semantic；Memory 不可用时降级为 event log | C2.1、C2.4、M1.5 | S3 |

M1 验收门槛：

| 门槛 | 目标 |
|---|---|
| Audit | `intentHint` 与结构化意图一致率可收集，baseline 目标 ≥ 85% |
| 重规划 | L-Redecompose + 目标漂移检测通过 |
| Memory | semantic 只接收 opt-in 的稳定复盘总结 |
| 测试 | 目标漂移检测覆盖率 100% |

### 4.4 C3 M2 DAG + PlanAndExecute + 委派 + 成本路由

| ID | 任务 | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|---|
| C3.1 | DAG plan 表示 | `packages/agent-core/src/planning/dag.ts`；`dag.test.ts` | 线性 plan 可无损提升为 DAG；独立写集判定；环检测 | C1.5 | C3.2、C3.4 |
| C3.2 | PlanAndExecute 策略 | `packages/agent-core/src/planning/strategy.ts`；`strategy.test.ts` | > 20 步时自动候选 PlanAndExecute；用户 override 生效；ReAct/CoT 兼容 M0 | C3.1 | C3.3 |
| C3.3 | G-Replan 全局重规划 | 扩展 `packages/agent-core/src/planning/replan.ts` | 全局重规划触发率可记录；回放一致；生产目标发生率 < 5%，先作为 metric 观测 | C3.2 | C3.5 |
| C3.4 | 规则式委派策略接口 | `packages/agent-core/src/planning/delegation.ts`；`delegation.test.ts` | 四个触发条件全部满足才委派；无共享写集；不下放高风险写操作 | C3.1、06-multi-agent 接口草案 | C3.5、S5 |
| C3.5 | M2 长任务集成 | 扩展 `planning.integration.test.ts` | 50+ 步的长任务 mock 端到端；至少 1 次委派 mock；G-Replan fixture 通过 | C3.3、C3.4 | Iter E 就绪 |
| C3.6 | 成本路由探索性门控 | `packages/agent-core/src/planning/cost-router.ts` 或决策备忘 | 默认不影响 Main LLM direct；若启用，单位任务 LLM 成本相对 M1 baseline 下降 ≥ 20%，否则明确延后到 Iter E | C2.1 的 metric | Iter E 成本工作 |

M2 验收门槛：

| 门槛 | 目标 |
|---|---|
| 长任务 | 50+ 步端到端 mock scenario |
| 委派 | 至少 1 次规则式委派 mock |
| DAG | 并行/writeScope 判定通过 |
| 成本路由 | 上线则成本下降 ≥ 20%；不上线则写明延后原因 |

## 5. Iter M 任务拆分

颗粒度目标：每个任务 ≤ 2–3 天。

### 5.1 M0 契约 + L1/L2 + FTS/BM25 + 融合召回

| ID | 任务 | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|---|
| M0.1 | Memory 契约冻结 | `providers/memory/src/omnimem/types.py`；`store.py`；`providers/memory/tests/fixtures/memory_item.json` | Python dataclass / TS type JSON 往返通过；layer 枚举固定；新增字段必须可选 | 三契约冻结 | M0.2、C0.2 |
| M0.2 | 现有 SQLite store 加固 | 扩展 `providers/memory/tests/test_store.py` | CRUD、软删除、layer 过滤、分页、count 全部覆盖；现有测试不退化 | M0.1 | M0.3、M0.5 |
| M0.3 | L1 WorkingMemory 实现 | `providers/memory/src/omnimem/working.py`；`test_working.py` | keep-recent-k；FIFO 淘汰；淘汰项生成 episodic 候选；单文件 LOC ≤ 200 | M0.1 | M0.5、C1.3 |
| M0.4 | MCP/API recall/store 兼容性 | `providers/memory/src/omnimem/server.py`；`test_server.py` | `store(layer=working/episodic/semantic)` 与 `recall(query)` shape 稳定；TS client fixture 可消费 | M0.1、C0.2 | C1.8、S1 |
| M0.5 | L2 原文 episodic store | `providers/memory/src/omnimem/episodic.py`；`test_episodic.py` | 原文保存不压缩；FTS 搜索支持 session/user/time 过滤；Planning checkpoint 可存取 | M0.2、M0.3 | M0.6、C2.4、S2 |
| M0.6 | L3c BM25/FTS 基线检索器 | `providers/memory/src/omnimem/retriever.py`；`test_retriever.py` | 不依赖向量时 BM25/FTS 召回可用；1000 条 `recall()` p95 < 100ms | M0.5 | M0.8、M1.3 |
| M0.7 | Observer 接口 + no-op 实现 | `providers/memory/src/omnimem/observer.py`；`test_observer_contract.py` | 冻结 `observe(turn) -> ObservationCandidate[]`；默认 no-op；Planning 不依赖 | M0.1 | M0.9a、M0.9b |
| M0.8 | 融合重排 v0 | 扩展 `retriever.py` | working 直拼 + episodic/BM25 排序；RRF / 简单加权评分可确定；返回 source/layer/score | M0.6 | M0.10、M1.3 |
| M0.9a | Arm L（tier-1 小模型）spike 执行 | `.spike/observer-arm-l/` 或 ADR 批准的 spike 路径；spike 报告 | 复用 1039 数据集；输出 recall/FPR/p95/cost；门槛按 ADR-004 145-146 行（`recall ≥ 60% / FPR ≤ 3% / p95 ≤ 50ms`）；成本条件由 ADR-006 定稿 | M0.7、ADR-004 | S4、M0.9b |
| M0.9b | L3a 生产实现路径 | `observer.py`；实现测试；可选 ADR-006 | Arm L 过 → ML-first observer；Arm L 实测未过 → d3 opt-in no-op/默认关闭；**Arm L 资源 blocked → 当前 blocked/deferred，不实现生产 observer**；不影响 M0 硬门槛 | M0.9a | M1.1 |
| M0.10 | M0 AMB/LongMemEval 基线测评 | `providers/memory/tests/test_memory_baseline.py` 或 `providers/memory/benchmarks/amb_baseline.py` | AMB 四轴输出 accuracy/speed/cost/usability（**硬门槛**）；LongMemEval ≥ 85%（**目标门槛**，O3 已决：数据集不可用时写 blocked 原因 + 以 AMB 四轴作为替代证据） | M0.8；M0.9b 可选 | M1 |

M0 硬门槛：

| 门槛 | 目标 |
|---|---|
| 范围 | L1 Working + L2 原文 + FTS/BM25 + 融合召回 |
| 明确排除 | L3a 最终实现、KG、Consolidator |
| 精度 | LongMemEval 目标 ≥ 85%，数据集不可用需记录 blocked 原因 |
| 延迟 | 1000 条 `recall()` p95 < 100ms |
| 兼容 | Planning M0 能通过 `MemoryClient.recall()` 消费 |
| 异步 | Observer no-op / 失败不影响 L1/L2/召回 |
| 测试 | `providers/memory` 单测 + server 测试 + 基线测试全部通过 |

### 5.2 M1 时序 KG + 混合检索 + Reranker 信号

| ID | 任务 | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|---|
| M1.1 | L3a 生产 ingestion | 扩展 `observer.py`、`server.py`；ingestion 测试 | observation 写入独立异步队列；失败不阻塞 L2；Arm L 未过时默认关闭 | M0.9b | M1.2 |
| M1.2 | L3b 懒加载时序 KG schema | `providers/memory/src/omnimem/kg.py`；`test_kg.py` | SQLite 边带 `valid_from/valid_to`；递归 CTE 支持 hop-N；默认懒加载，不 eager 抽取 | M0.5；M1.1 可选 | M1.3 |
| M1.3 | 混合检索 v1 | 扩展 `retriever.py` | BM25 + 语义/向量占位 + KG 子图 + RRF；缺向量/缺 KG 都能优雅降级；LongMemEval ≥ 92%（O3 目标门槛，blocked 时以 AMB 替代） | M0.8、M1.2 | M1.4 |
| M1.4 | 可学习 Reranker 本地 event log | `providers/memory/src/omnimem/event_log.py`；`reranker.py`；测试 | 本地 SQLite 记录检索/引用正样本；event log 字段默认存 `query_hash + top-N retrieval metadata`，**原始 query 走 opt-in**（O6 已决，`query_raw` nullable，需 `--persist-raw-query` 显式开启）；不依赖 OTel；logistic regression 可先用固定权重；成本相对 M0 ≤ 1.3× | M1.3 | M2.4、Iter D OTel 迁移 |
| M1.5 | Planning 语义复盘 ingestion | `providers/memory/tests/test_planning_integration.py`；schema 支持 | 接收 `source=planning_review/schema_version/run_id`；拒绝运行中的 `PlanningState` 写入 semantic | M1.3、C2.5 | S3 |
| M1.6 | Prompt 缓存失效元数据 | 扩展 memory 结果元数据 | 召回结果带 `cache_key/block_version/source_layers`；即使没有缓存实现，Context 层也能消费 | M1.3、02-context 对齐 | M2 |
| M1.7 | UserProfile Store + ProfileUpdater | `providers/memory/src/omnimem/profile_store.py`；`profile_updater.py`；`test_profile_store.py` | `UserProfile` dataclass 落盘 SQLite；`ProfileUpdater.apply_signal/bulk_apply/reset` 单写入口；其他领域只能 `emit_profile_signal` 发候选；写入审计 `who/when/why/diff`；`schema_version=1` | M0.1、M0.5 | M1.8、S8 |
| M1.8 | user.md 双向镜像 | 扩展 `profile_store.py`；`test_user_md_mirror.py`；`.quilin/user.md` fixture；根 `.gitignore` 新增 `.quilin/user.md` | `UserProfile.export_markdown(path)` 导出稳定 YAML frontmatter + 自由 body；**敏感字段白名单默认不导出**（O9 已决：真实姓名/联系方式/位置/tokens/生日仅 SQLite；`--include-sensitive` 显式解锁单次）；`sync_from_markdown(path)` 回读走 ProfileSignal，不直写；diff 可审计 | M1.7 | M2 |

M1 验收门槛：

| 门槛 | 目标 |
|---|---|
| 检索 | 混合检索 LongMemEval 目标 ≥ 92% |
| 成本 | 相对 M0 ≤ 1.3× |
| KG | 懒加载时序 KG 可查询，不强制 eager 抽取 |
| Reranker | 本地 SQLite event log 可训练/回放，不依赖 OTel |
| Planning 集成 | 稳定复盘总结可写 semantic；运行中状态被拒绝 |
| User Profile | UserProfile Store 可读写；单写入口 ProfileUpdater；user.md 双向镜像可 export/sync，回流走 ProfileSignal |

### 5.3 M2 归档 + Idle Stub + Consolidator Dry-Run + 用户画像

| ID | 任务 | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|---|
| M2.1 | L2 冷热归档 schema | `providers/memory/src/omnimem/archive.py`；`test_archive.py` | 年龄/熵值策略可配置；冷区压缩可用 zstd stub；容量目标支持 10 万条/用户的 schema | M1.3 | M2.5 |
| M2.2 | Idle-budget 接口 stub | `providers/memory/src/omnimem/idle_budget.py`；`test_idle_budget.py` | `acquire(task, estimated_tokens) -> lease/denied`；默认拒绝；不实现完整的 `--idle-evolve` | Idle 方案 C 决策 | M2.3 |
| M2.3 | Consolidator dry-run/no-op | `providers/memory/src/omnimem/consolidator.py`；`test_consolidator.py` | 默认 dry-run；输出提议动作；不默认写 semantic/skill（除非走 WriteAuthority 路径）；真实 idle loop 延后到 Iter F | M2.2、M1.4 | Iter F 自我进化 |
| M2.4 | 按用户检索权重画像 | `providers/memory/src/omnimem/retrieval_profile.py`；`test_retrieval_profile.py` | 按用户权重持久化（独立于 M1.7 UserProfile，仅存检索权重）；默认回落到全局权重；权重更新不破坏测试中的召回确定性 | M1.4、M1.7、M2.1 | M2.5 |
| M2.5 | M2 规模/性能门槛 | benchmark 扩展 | 10 万条/用户 fixture 下 p95 召回 < 300ms（**硬门槛**）；LongMemEval ≥ 95%（O3 目标门槛，blocked 时以 AMB 四轴替代并写决策记录） | M2.1、M2.3、M2.4 | Iter E/F 就绪 |
| M2.6 | soul.md frontmatter schema | `providers/memory/src/omnimem/soul_schema.py`；`test_soul_schema.py`；`docs/engineering/10-self-evolution/soul-md-schema.md`（新增） | YAML frontmatter 冻结字段：`schema_version/persona_name/core_values/communication_style/created_at/last_updated_by`；body 为自由 Markdown；schema 变更走 ADR | Iter A、10-self-evolution spec | M2.7、S9 |
| M2.7 | soul.md 静态加载（只读） | `providers/memory/src/omnimem/soul_loader.py`；`test_soul_loader.py`；`.quilin/soul.md` fixture；02-context ContextAssembler 接入 | 启动期读 `.quilin/soul.md` 到内存；ContextAssembler 拼入稳定前缀，利于 prompt cache；文件缺失时安全回退到默认人格；**本期只读不写** | M2.6、Iter A ContextAssembler | Iter F 自进化写路径 |

M2 验收门槛：

| 门槛 | 目标 |
|---|---|
| 容量 | 10 万条/用户 fixture |
| 延迟 | p95 召回 < 300ms |
| 精度 | LongMemEval 目标 ≥ 95%；未达需记录原因与决策 |
| Consolidator | 只做 dry-run/no-op，不执行真实 idle loop |
| Idle | 默认拒绝；真实 `--idle-evolve` 留到 Iter F |
| 画像 | 按用户权重可持久化与回放 |
| soul.md 只读 | 启动期能把 `.quilin/soul.md` 加载入 prompt 稳定前缀；文件缺失可安全回退；frontmatter schema 冻结；**写路径不做** |

## 6. L3a 决策处理

ADR-004 已占用为 L3a Observer Strategy。当前不再是开放 d1/d2/d3 三选一，而是：

```text
ADR-004：d2 条件性 ML-first
  → 先跑 Arm L spike
  → Arm L PASS：采用 ML-first L3a 生产路径
  → Arm L FAIL：回退到 d3 opt-in / 默认关闭
  → ADR-006（可选）：记录 Arm L 结果 + 最终实现策略
```

其中 **Arm L** 指 ADR-004 §2.3 提出的 **tier-1 小模型方案**（小型 LLM，例如 Haiku 3.5/4.5、Qwen 2.5 3B、Llama 3.2 3B 中的一个），用于在 rule-first 失败后作为 Observer 的默认实现路径进行决策。名字来自 decision tree 的 "arm"（分支），后缀 L 代表 LLM；不是"左手"的意思。

### 6.1 Arm L 门槛

**权威源：ADR-004 §2.4 d2（145-146 行）**

| 指标 | 门槛 | 来源 |
|---|---|---|
| recall | ≥ 60% | ADR-004 line 145 |
| FPR | ≤ 3% | ADR-004 line 145 |
| p95 延迟 | ≤ 50ms | ADR-004 line 145 |
| 成本 | **部署层 qualifier**（O4 已决）：本地部署默认用开源小模型；云部署接受付费 API；不作为硬门槛否决 Arm L spike 结论 | ADR-006 记录部署口径 |

说明：早期讨论曾出现 `recall ≥ 85% / FPR ≤ 5% / cost ~$0` 的版本，其来源是 `04-planning` §Q2 的"离线/本地小分类器"门槛，与 ADR-004 Arm L 门槛不是同一口径。本计划 M0.9a 一律以 ADR-004 的 `60/3/50` 为准执行。若 Arm L 必须使用付费 API，成本口径由 ADR-006 记录为部署层 qualifier。

### 6.2 任务影响面

| 分类 | 任务 | 依赖 |
|---|---|---|
| 不受 Arm L 阻塞 | C0–C3 全部 Planning 任务 | 无 |
| 不受 Arm L 阻塞 | M0.1–M0.8、M0.10 除 L3a 外的基线 | 无 |
| 仅接口 | M0.7 | 可立即开工 |
| 受 Arm L 结果阻塞 | M0.9b | 依赖 M0.9a；当前 M0.9a 资源 blocked，因此 M0.9b blocked/deferred |
| 部分阻塞 | M1.1 | ingestion 路径取决于 ML-first 还是 opt-in |
| 部分阻塞 | M1.2 | KG schema 可先开工；observation 源绑定需等 |
| 部分影响 | M1.3 | 检索的优雅降级可先开工；observation 打分需等 |
| 不阻塞 | M2.1–M2.5 | 不直接依赖 Arm L；仅在画像将来使用 observation 信号时才间接相关 |

### 6.3 M0.9 拆分

| ID | 目的 | 产出 |
|---|---|---|
| M0.9a | 跑 Arm L spike | `.spike/observer-arm-l/`、结果 JSON/日志、spike 报告 |
| M0.9b | 实现最终 L3a 路径 | Arm L 过则 ML-first；Arm L 实测失败则 opt-in / 默认关闭 no-op；Arm L 资源 blocked 时 deferred |

### 6.4 S4 重命名

- 旧名：L3a Decision Gate
- 新名：Arm L Spike Gate

S4 内容：

| 项 | 决策 |
|---|---|
| Arm L 门槛结果 | pass/fail/blocked（按 ADR-004 `60/3/50`；blocked 不是 pass/fail） |
| ADR 状态 | 是否需要 ADR-006；当前资源 blocked 不足以定稿 ADR-006 |
| M0.9b 实现路径 | ML-first、d3 opt-in / 默认关闭，或资源 blocked 时 blocked/deferred |
| 03-memory 更新 | L3a 默认行为 |
| 07-safety 更新 | 仅当 opt-in 路径改变权限语义时 |

当前 S4 记录（M0.9a `bb76f9f` 后复核）：

| 项 | 记录 |
|---|---|
| Gate 判定 | **blocked**，不是 pass/fail |
| 资源证据 | `test -n "$ANTHROPIC_API_KEY"` exit `1`；`command -v ollama` exit `1`；`curl -sSf http://localhost:11434/api/tags` exit `7` |
| 数据集证据 | `docs/research/fixtures/rule-first-observer/dataset.json` 可读，`1039` 样本 |
| M0.9b 当前状态 | **blocked/deferred**；不实现 ML-first 生产 observer；不引入 LLM API 调用 |
| 默认行为 | 保持 M0.7 `NoOpMemoryObserver` contract；observer 失败/no-op 不影响 L1/L2/召回 |

解除 blocker 后必须重跑：

| 类型 | 命令或输出 |
|---|---|
| API 资源检查 | `test -n "$ANTHROPIC_API_KEY"`，只记录 set/unset 或 exit code，不打印 secret |
| 本地资源检查 | `command -v ollama`；`curl -sSf http://localhost:11434/api/tags` |
| Arm L 推理 | 对 1039 样本跑 ADR 批准的 `.spike/observer-arm-l/` 或等价管线 |
| 指标 | recall、FPR、p95 latency、cost；前三项按 ADR-004 `60/3/50` 判定，cost 只作部署 qualifier |

## 7. Idle-Budget 决策

推荐：选 C。

| 选项 | 决策 | 原因 |
|---|---|---|
| A：把最小 idle-budget 拉进 Iter M | 否 | 会把 10-self-evolution 的 opt-in、每日预算、透明汇报、WriteAuthority 审核路径都拉进 Iter M，范围过大 |
| B：M2 跳过 Consolidator | 可接受但非首选 | 最安全，但把所有集成风险都推到 Iter F |
| C：M2 先做接口 stub，Iter F 再填真实实现 | **推荐** | 冻结接口但不实现真实 idle loop，Iter M 范围可控 |

### 7.1 Iter M M2 边界

Iter M M2 包含：

| 包含 | 排除 |
|---|---|
| `IdleBudgetProvider` 接口 | 真实的 `--idle-evolve on` CLI |
| 默认拒绝 / no-op 的 budget provider | 每日 token 预算账务 |
| `Consolidator.propose()` dry-run | 后台调度器 |
| 提议动作的 schema | 自动 scaffold / memory 写入 |
| 证明没有 gate 就不写入的测试 | 完整的 10-self-evolution loop |

### 7.2 Consolidator 写入纪律

- Consolidator dry-run 可以提议复盘、KG 修剪、verbatim 重压缩等动作。
- Consolidator 默认不得写 semantic/skill。
- 未来任何真实写入都必须走 WriteAuthority 并显式 opt-in。
- `origin:"idle"` 仍然属于 Iter F 范畴。

## 8. M1.4 的 OTel 依赖决策

M1.4 Learnable Reranker 需要检索/引用的正样本。Iter D OTel 还没就绪，所以 M1.4 不能依赖 OTel。

选定路径：先用本地 SQLite event log。

| 选项 | 决策 | 原因 |
|---|---|---|
| a：现在用本地 SQLite event log，之后迁移 | **推荐** | 保持 Iter M 独立；足够支撑 logistic regression 的训练信号 |
| b：把 M1.4 推迟到 OTel 就绪 | 否 | 会让 Iter M 依赖 Iter D，破坏并行 |

### 8.1 M1.4 本地 Event Log 契约

| 字段 | 用途 |
|---|---|
| `event_id` | 稳定行 id |
| `run_id` | 与 Planning 的 run 对接 |
| `query_hash` | **默认存**（O6 已决）；避免把敏感完整 query 写入训练日志 |
| `query_raw` | **nullable，opt-in**（O6 已决）；仅在 `--persist-raw-query` 或 config flag 开启时写入 |
| `memory_id` | 被检索的条目 |
| `rank` | 检索排名 |
| `score` | 检索分数 |
| `source_layer` | working/episodic/semantic/kg |
| `was_cited` | 正样本标签 |
| `timestamp` | 排序与时间衰减 |
| `schema_version` | 迁移安全 |

Iter D OTel 迁移路径：

| 阶段 | 行为 |
|---|---|
| Iter M | SQLite event log 为单一真相源 |
| Iter D | 从同一事件生产者增加 OTel span/event 导出 |
| Iter D 之后 | 决定 SQLite 是继续作为训练库，还是降级为派生缓存 |

## 9. 跨 Track 同步点

| 同步点 | 时机 | 必须对齐的内容 | 相关任务 | 错过的风险 |
|---|---|---|---|---|
| S0 契约冻结 | Iter C/M 开工前 | `MemoryItem` JSON shape、layer 枚举、异步失败语义、checkpoint `storageRef` 语义 | C0.1、C0.2、M0.1 | TS/Python 实现漂移 |
| S1 recall 签名同步 | C1.3 前、M0.4 后 | `MemoryStore.recall(query, task_context?) -> MemoryItem[]`；元数据 `layer/source/score/staleness/schema_version` | C1.3、M0.4、M0.8 | Planning 的 context 注入会挂 |
| S2 checkpoint/episodic schema 同步 | C1.6 前、M0.5 后 | checkpoint 元数据：`run_id/event_seq/phase/task_hash/schema_version`；**失败事件独立**（`checkpoint_failed` with `error_code/ts`，O5 已决） | C1.6、M0.5 | pause/resume/debug 无法恢复 |
| S3 semantic 写入纪律同步 | C2.5 / M1.5 前 | Planning 复盘总结 schema；运行中状态禁止写 semantic | C2.5、M1.5 | semantic tier 被污染 |
| S4 Arm L Spike Gate | M0.9a 后、M0.9b / M1.1 前 | Arm L 结果或 blocked gate 记录；是否需要 ADR-006；ML-first vs opt-in vs blocked/deferred 路径；阈值以 ADR-004 `60/3/50` 为准 | M0.9a、M0.9b、M1.1 | 把资源 blocked 误当 pass/fail，导致 L3a 默认行为被提前定稿 |
| S5 DAG/委派元数据同步 | C3.4 前、M1.6 后 | DAG 子任务/writeScope/riskLevel 元数据；委派的 parent/child run id | C3.1、C3.4、M1.6 | 多 Agent 轨迹无法召回或归因 |
| S6 Idle Stub 边界 | M2.2 前 | `IdleBudgetProvider` stub 范围；真实 idle loop 留到 Iter F | M2.2、M2.3、10-self-evolution spec | Iter M 吞掉 Self-Evolution 的范围 |
| S7 Iter E 就绪 | C3.5 / M2.5 后 | Planning 轨迹、Memory 召回 metric、可观测性 hook | C3.5、M2.5、08-observability | Iter E 仍然没有可测量的 Agent |
| S8 UserProfile schema 冻结 | M1.7 前 | `UserProfile` 字段、`ProfileSignal` shape、`schema_version=1`、ProfileUpdater 写入审计记录格式、user.md frontmatter 字段集 | M1.7、M1.8 | 后续 schema 漂移、user.md 镜像无法双向同步 |
| S9 soul.md schema 冻结 | M2.6 前 | `.quilin/soul.md` frontmatter 字段、schema_version 机制、10-self-evolution 写路径的只读/写入边界（本期只读） | M2.6、M2.7 | Iter F 写路径起动时语义漂移 |

## 10. 依赖拓扑

```text
契约冻结
  → C0 Planning 类型
  → C0 Memory adapter
  → M0 Memory Protocol
  → M0 Store/Working/Episodic/召回

Planning 路线：
C0.1 → C1.1/C1.2 → C1.4/C1.5 → C1.6 → C1.8
C1.6 → C2.2 → C2.3 → C2.4 → C2.5
C1.5 → C3.1 → C3.2 → C3.3
C3.1 → C3.4 → C3.5

Memory 路线：
M0.1 → M0.2 → M0.3/M0.5 → M0.6 → M0.8 → M0.10
M0.1 → M0.7 → M0.9a → S4 → M0.9b → M1.1
M0.5 → M1.2 → M1.3 → M1.4 → M2.4
M1.3 → M2.1 → M2.5
Idle 方案 C → M2.2 → M2.3

Identity 路线（本期新增）：
M0.1 + M0.5 → M1.7（UserProfile Store）→ S8 → M1.8（user.md 镜像）
Iter A ContextAssembler → M2.6（soul.md schema）→ S9 → M2.7（soul.md 只读加载）

跨路线：
M0.4 → C1.3 → C1.8
M0.5 → C1.6 checkpoint 写入
C2.5 ↔ M1.5 语义复盘 ingestion
C3.4 ↔ M1.6 委派元数据
M1.7 → M2.4（检索权重画像复用 user_id 维度）
M2.2 / M2.3 ↔ Iter F 自我进化
M2.6 / M2.7 ↔ Iter F soul.md 写路径
```

## 11. 建议执行顺序

### 11.1 第 0 天冻结

| 顺序 | 任务 |
|---|---|
| 1 | S0 契约冻结 |
| 2 | C0.1 Planning 类型 |
| 3 | M0.1 Memory 契约 |
| 4 | C0.2 TS Memory adapter |
| 5 | M0.4 API 兼容性 |

### 11.2 第一轮并行切片

| 路线 | 任务 |
|---|---|
| Iter C | C1.1、C1.2、C1.3 |
| Iter M | M0.2、M0.3、M0.5 |
| L3a | M0.7，随后 M0.9a spike |
| 同步 | S1、S2 |

### 11.3 第二轮并行切片

| 路线 | 任务 |
|---|---|
| Iter C | C1.4、C1.5、C1.6、C1.7、C1.8 |
| Iter M | M0.6、M0.8、M0.10 |
| L3a | S4 blocked gate 记录；M0.9b blocked/deferred，待 Arm L 实测后再实现 |
| 同步 | 不含 L3a 的 M0 硬门槛验收 |

### 11.4 M1 切片

| 路线 | 任务 |
|---|---|
| Iter C | C2.1–C2.5 |
| Iter M | M1.1–M1.6 |
| Identity | M1.7 UserProfile Store → M1.8 user.md 镜像 |
| 同步 | S3；S8 UserProfile schema；M1.4 本地 event log（不依赖 OTel） |

### 11.5 M2 切片

| 路线 | 任务 |
|---|---|
| Iter C | C3.1–C3.6 |
| Iter M | M2.1–M2.5 |
| Identity | M2.6 soul.md schema → M2.7 soul.md 只读加载 |
| 同步 | S5、S6、S7、S9 soul.md schema |

## 12. 验收汇总

### Iter C 验收

| 里程碑 | 验收 |
|---|---|
| C M0 | 多步任务 ≤ 20 步端到端；简单问答绕过 planning；`skill_view` 工作；只用 working/episodic memory |
| C M1 | Audit 观测 baseline；L-Redecompose；目标漂移覆盖率 100%；semantic 只接收稳定复盘总结 |
| C M2 | 50+ 步任务；DAG；G-Replan；至少 1 次委派 mock；成本路由要么证明成本下降 ≥ 20%，要么明确延后 |

### Iter M 验收

| 里程碑 | 验收 |
|---|---|
| M M0 | L1 + L2 + FTS/BM25 + 融合召回；1000 条 p95 < 100ms；LongMemEval 目标 ≥ 85%；L3a / M0.9b blocked 不计入硬门槛 |
| M M1 | 懒加载 KG + 混合检索；Reranker 用本地 SQLite event log；LongMemEval 目标 ≥ 92%；成本 ≤ M0 × 1.3；**UserProfile Store + user.md 双向镜像可用** |
| M M2 | 冷热归档；idle-budget stub；Consolidator dry-run；按用户画像；10 万条/用户 p95 < 300ms；LongMemEval 目标 ≥ 95%；**soul.md 静态加载进 ContextAssembler（只读）** |

## 13. 已决议事项

2026-04-23 用户拍板，O1–O9 全部闭合。执行中若出现新情况（spike 数据、benchmark 结果）需改变决策，走 ADR 或 planning 修订，不再复开 O 编号。

| ID | 原问题 | 决议 | 落实位置 |
|---|---|---|---|
| **O1** | ADR-006 调整 Arm L 阈值后如何回写本计划 | **采纳**：ADR-006 publish 时同步更新本计划 §6.1 与 S4；变更提交 commit message 必须同时引用 ADR-006 commit hash 与本文件 diff 行号。作为 Iter M **标准流程**，不再当 O。 | §6.1 脚注、S4 描述 |
| **O2** | Memory 契约升 ADR-005？ | **升**。三条契约（API 稳定性 / tier 语义兼容 / 异步感知）跨 TS+Python 双实现、影响 Iter C/M/E 三期，权重足够升 ADR。**Action**：S0 冻结同一天起草 `adr-005-memory-contracts.md`。 | §3 三条契约加"升 ADR-005"；§14 |
| **O3** | LongMemEval 数据集算硬门槛还是目标门槛？ | **目标门槛**。数据集可用性不稳定（upstream 评估），blocked 时允许以 AMB 四轴（accuracy/speed/cost/usability）结果代替，并在 M0.10 交付物中写 blocked 原因 + 替代证据。 | M0.10 / M1.3 / M2.5 验收标准 |
| **O4** | Arm L 付费 API 成本算硬门槛还是部署层 qualifier？ | **部署层 qualifier**。Arm L 技术决策以 ADR-004 的 `60/3/50` 为准；成本由**部署形态**（本地开源 vs 云付费）兜底，不反过来否决 spike 结论。本地部署默认用开源小模型，云部署接受付费 API。 | §6.1 成本行；ADR-006 草稿 |
| **O5** | Planning checkpoint 失败语义 | **独立 `checkpoint_failed` 事件**。理由：事件溯源友好，`storageRef: null` 会把"正常无 checkpoint"和"失败"混淆。事件含 `run_id / phase / task_hash / error_code / ts`。 | C1.6 交付物、S2 |
| **O6** | Reranker event log 存原始 query 还是 hash？ | **默认 `query_hash + top-N retrieval metadata`；原始 query 走 opt-in**。用户显式开启后才存明文（`--persist-raw-query` 或 config flag），默认隐私安全。schema 保留 `query_raw` nullable 字段以便开启后兼容。 | M1.4 交付物、§8 event log 字段表 |
| **O7** | soul.md 写路径归 10-self-evolution 还是拆 14-identity？ | **归 10-self-evolution，不拆新领域**。identity 的改变本身就是"自我进化"的一部分，架构上合并更简单；WriteAuthority 与 scaffold patch propose 复用 10 的基础设施。 | §1 共识、§5.3 M2.6 交付物、§14 |
| **O8** | 起草 ADR-007 identity files？ | **起草**。M1.7 落地前产出 `adr-007-identity-files.md` draft，定 `.quilin/user.md` 与 `.quilin/soul.md` 的**位置、格式、写入权、审批路径、git 入/出、跨项目共享策略**。draft 即可，final 审批可延到 Iter F 起动前。 | §14、新任务 ADR-007 |
| **O9** | user.md 可否导出敏感字段？ | **默认不导出**。敏感字段白名单（真实姓名、联系方式、位置、tokens/secrets、生日等）保留 SQLite 原值，**不写入 user.md Markdown**。用户可通过 `--include-sensitive` flag 显式解锁单次导出。`.quilin/user.md` 默认加入 `.gitignore`。 | M1.8 交付物、`.gitignore` 约定、ADR-007 条款 |

## 14. 最终建议

在 S0 契约冻结后，Iter C 与 Iter M 即可并行推进。

工作分工建议：

| 领域 | 建议 |
|---|---|
| 契约来源 | ADR-005（O2 已决，S0 同日起草）+ 本计划 + 03-memory + 04-planning §2.9.2；ADR-005 为规范源 |
| L3a | 沿用 ADR-004 的条件性 d2；M0.9a 跑 Arm L spike；当前 S4 记录为资源 blocked，M0.9b blocked/deferred；解除 blocker 并实测后再选 ML-first 或 opt-in/默认关闭 |
| Arm L 门槛 | 以 ADR-004 `recall ≥ 60% / FPR ≤ 3% / p95 ≤ 50ms` 为准；成本条件由 ADR-006 定稿 |
| M0 硬门槛 | 只算 L1/L2 + FTS/BM25 + 融合召回；L3a 排除 |
| Idle-budget | 方案 C；Iter M M2 只做 stub/dry-run，真实 loop 留到 Iter F |
| Reranker 信号 | 先用本地 SQLite event log；Iter D 再迁移到 OTel |
| 必要同步 | S0–S9，重点 S1 召回签名、S2 checkpoint schema、S3 semantic 写入纪律、S5 DAG/委派元数据、S8 UserProfile schema、S9 soul.md schema |
| Identity files | `user.md` 本期完整交付（M1.7/M1.8，归 03-memory）；`soul.md` 本期只做只读加载 + schema 冻结（M2.6/M2.7，归 10-self-evolution），**自进化写路径留 Iter F** |
| ADR-007 | **已决采纳（O8）**：M1.7 落地前产出 `adr-007-identity-files.md` draft，定 identity files 位置/格式/写入权/审批路径/git 入出/跨项目共享；final 审批可延到 Iter F 起动前 |
| 全局决议 | §13 已决议事项 O1–O9 全部闭合；执行中若出现改变决策的证据，走 ADR 或 planning 修订，不再复开 O 编号 |

## 15. 第三轮并行切片（方案 A 三路并行）任务书

起草日期：2026-04-24。执行起点：commit `b5a4b09`（§11.3 闭合后 master 干净，27 commits ahead of origin/master）。

### 15.1 本轮方案

**方案 A：三路并行 = C-track ∥ M-track ∥ Config-track**，docs-track 由 Claude 串行跟进不进 packages/providers。

本轮不触发契约变更；ADR-005 已冻结，本轮执行以 ADR-005 为规范源。

### 15.2 本轮 In-scope / Out-of-scope

| 条目 | 状态 | 理由 |
|---|---|---|
| C2.1–C2.5（Audit + L-Rearrange + L-Redecompose + goal-drift + semantic writer hook） | ✅ In-scope | §11.4 主干，依赖 C1.x 已全部就绪 |
| M1.2–M1.6（KG schema + 混合检索 v1 + reranker event log + planning ingestion + cache 元数据） | ✅ In-scope | §11.4 主干，依赖 M0.5/M0.8 已就绪 |
| Config-track CONFIG.1–CONFIG.4（Capability Config Loader） | ✅ In-scope（本轮新增） | 关闭 §11.3 row 97 剩余风险：第三方 MCP / Skills CLI config loader 未接入 |
| M1.1（L3a 生产 ingestion） | ⏸ Defer | Arm L 资源 blocked（ANTHROPIC_API_KEY unset / ollama absent，S4 已记录）；解锁再启 |
| M1.7（UserProfile Store + ProfileUpdater） | ⏸ Defer | ADR-007 draft 未产出（O8 已决需先产 draft） |
| M1.8（user.md 双向镜像） | ⏸ Defer | 依赖 M1.7 |
| S8 UserProfile schema 同步 | ⏸ Defer | 依赖 M1.7/M1.8 |
| 方向 4（Arm L 1039 样本 gate） | ⏸ Blocked | 外部资源未就绪 |
| 方向 5（lint/coverage 独立门禁 sweep） | ⏸ Defer to 收尾 | sweep 改动面大，和 in-flight 三路 track 会 merge 打架；留到本轮全部 commit 后单独一轮 |

### 15.3 写边界（硬隔离，不可越界）

| Track | 允许写入 | 禁止写入 |
|---|---|---|
| **C-track** | `packages/agent-core/src/planning/**`（新增 audit.ts / replan.ts / goal-drift.ts / memory-writer.ts 及其测试） | 非 planning 子目录；`providers/memory/**`；`docs/**`；`src/index.ts`（除非通过 docs-track 协调） |
| **M-track** | `providers/memory/src/omnimem/**`（新增 kg.py / event_log.py / reranker.py 及扩展 retriever.py / server.py）；`providers/memory/tests/**`；`providers/memory/benchmarks/**` | `packages/agent-core/**`；`docs/**`；`.spike/**` |
| **Config-track** | `packages/agent-core/src/config/**`（新建目录：types.ts / schema.ts / loader.ts + 测试）；`packages/agent-core/src/index.ts`（仅限 wire config 进 `main()`）；新增 fixture `packages/agent-core/src/test/fixtures/capabilities.*` | `packages/agent-core/src/planning/**`（C-track 专属）；`providers/memory/**`；`docs/**` |
| **docs-track（Claude）** | `docs/**`（planning 回写、engineering spec 同步、ADR 追加）；本任务书自身 | `packages/**`；`providers/**`；`scripts/**`（除非用户显式指派） |

两 track 若必须触碰同一文件（例如 C2.5 和 M1.5 都要 touch fixture），必须先在 AgentBridge 上对齐 schema + 拍定 owner，owner 写、另一方 read-only consume。

### 15.4 任务明细

#### C-track（packages/agent-core/src/planning/**）

| ID | 交付物 | 验收标准（契约来源：§4.3） | 依赖 | 解锁 |
|---|---|---|---|---|
| C2.1 | `audit.ts` + `audit.test.ts` | audit 不改决策；记录 `intentHint/confidence`；一致率 metric fixture 可计算 | C1.4（已完成） | C2.5 |
| C2.2 | `replan.ts` + `replan.test.ts`（L-Rearrange 本地修复） | tool 失败 / 前置条件缺失 / 重试耗尽都能触发正确 patch；不调用 G-Replan | C1.6（已完成） | C2.3 |
| C2.3 | 扩展 `replan.ts` + `decompose.ts`（L-Redecompose） | 局部子树替换；不重写全局 plan；事件回放后状态一致 | C2.2 | C2.4 |
| C2.4 | `goal-drift.ts` + `goal-drift.test.ts` | drift 触发覆盖率 100%；默认阈值 0.65 可配置；drift 事件可写 episodic | C1.2（已完成）、C2.3 | C2.5 |
| C2.5 | `memory-writer.ts` + memory writer 测试 | 只把复盘后的稳定策略写入 semantic；运行中状态不写 semantic；Memory 不可用时降级为 event log；schema 与 M1.5 对齐 | C2.1、C2.4、M1.5 | S3 闭合 |

#### M-track（providers/memory/**）

| ID | 交付物 | 验收标准（契约来源：§5.2） | 依赖 | 解锁 |
|---|---|---|---|---|
| M1.2 | `kg.py` + `test_kg.py` | SQLite 边带 `valid_from/valid_to`；递归 CTE 支持 hop-N；默认懒加载，不 eager 抽取 | M0.5（已完成） | M1.3 |
| M1.3 | 扩展 `retriever.py` + 测试 | BM25 + 语义/向量占位 + KG 子图 + RRF；缺向量/缺 KG 都能优雅降级；LongMemEval ≥ 92%（O3 目标门槛，blocked 时以 AMB 替代） | M0.8（已完成）、M1.2 | M1.4 |
| M1.4 | `event_log.py` + `reranker.py` + 测试 | 本地 SQLite 记录检索/引用正样本；默认存 `query_hash + top-N retrieval metadata`，`query_raw` nullable 且 opt-in（O6）；不依赖 OTel；logistic regression 可先用固定权重；成本相对 M0 ≤ 1.3× | M1.3 | M2.4、Iter D OTel 迁移 |
| M1.5 | `test_planning_integration.py` + schema 支持 | 接收 `source=planning_review/schema_version/run_id`；拒绝运行中的 `PlanningState` 写入 semantic；schema 与 C2.5 对齐 | M1.3、C2.5 | S3 闭合 |
| M1.6 | 扩展 memory 结果元数据 | 召回结果带 `cache_key/block_version/source_layers`；即使没有缓存实现，Context 层也能消费 | M1.3 | M2 |

#### Config-track（packages/agent-core/src/config/** + 有限 wire）

背景：当前 `src/index.ts`（229 行）硬编码 OmniMem MCP，未实例化 `SkillsManager`；第三方 MCP / Skills CLI 接入路径缺失（§11.3 row 97）。

| ID | 交付物 | 验收标准 | 依赖 | 解锁 |
|---|---|---|---|---|
| CONFIG.1 | `packages/agent-core/src/config/types.ts` + `schema.ts`（zod） | `CapabilitiesConfig` 类型冻结：`mcpServers: Record<string, McpServerConfig>`、`skills: SkillsConfig`、`schema_version: 1`；zod schema 往返 JSON 稳定；新字段必须可选 | 无 | CONFIG.2 |
| CONFIG.2 | `packages/agent-core/src/config/loader.ts` + `loader.test.ts` | 默认搜索顺序：CLI `--config path` → `$QUILIN_CONFIG_PATH` → `.quilin/capabilities.{yaml,json}` → 内置默认（仅 OmniMem，向后兼容现状）；文件缺失 / schema 不通过走 fail-fast 明确错误；不 fallback 静默 | CONFIG.1 | CONFIG.3 |
| CONFIG.3 | 改 `src/index.ts`（仅限 `main()` wire）+ `SkillsManager` 与 `MCPClientManager` 按 config 实例化 | 现有 410 个 TS 测试 + 71 个 Py 测试全部不退化；无 config 文件时行为等价于当前（OmniMem 硬编码） | CONFIG.2 | CONFIG.4 |
| CONFIG.4 | `src/config/loader.integration.test.ts` + fixture `capabilities.yaml` / `capabilities.json` | 两个 fixture 端到端加载并实例化 SkillsManager + 一个 stub MCP；测试不启动真实子进程（走 mock） | CONFIG.3 | 产品可用 CLI |

### 15.5 S-sync 同步点

| 同步点 | 时机 | 对齐内容 | 责任方 |
|---|---|---|---|
| **S3 semantic 写入纪律** | C2.5 和 M1.5 任一方启动前 | `PlanReviewRecord` schema：`run_id / source=planning_review / schema_version / summary / stable_strategy`；运行中 `PlanningState` 禁写 semantic | C2.5 与 M1.5 owner 在 AgentBridge 对齐后由任一方 owner fixture，另一方 consume |
| **M1.4 event log schema** | M1.4 启动前 | `query_hash`、top-N retrieval metadata 字段；`query_raw` nullable；opt-in flag `--persist-raw-query`（O6） | M-track owner |
| ~~S8 UserProfile schema~~ | 本轮 defer | M1.7/M1.8 defer，S8 不进本轮 | — |

### 15.6 验收门禁（每 track 收口前必跑）

| 门禁 | 命令 | 通过标准 |
|---|---|---|
| TS 类型 | `cd packages/agent-core && pnpm tsc --noEmit` | exit 0 |
| TS 测试 | `cd packages/agent-core && pnpm test` | 全部 passed，无新 skipped |
| Py 测试 | `cd providers/memory && uv run pytest -q` | 全部 passed |
| LOC 实证 | `wc -l <交付文件>` | 每个任务 commit message 附 LOC 片段 |
| Phase ✅ 声明 | commit hash + 测试通过数 + tsc exit code | 引用到 §0.1 表格 |

### 15.7 Blocked / Deferred 闭口条件

| 条目 | 解除条件 |
|---|---|
| M1.1 | Arm L spike 拿到 recall/FPR/p95 数据；`ANTHROPIC_API_KEY` 或 ollama 任一可用 |
| M1.7 / M1.8 / S8 | `docs/adr/adr-007-identity-files.md` draft 产出（O8） |
| 方向 4 Arm L gate | 同 M1.1 |
| 方向 5 lint sweep | ✅ 已完成：`a1276b8`；`just check` + `just lint-py` + TS/Python 全量测试通过 |

### 15.8 执行纪律

- **Codex 派 subagent**：三路分别独立 subagent，默认 `run_in_background: true`；主线程保持响应
- **谁写代码谁 commit**：C-track 的 commit author 是 Codex；Config-track 由 Codex 执行，Claude 不参与 packages/ 内代码写入；docs-track commit 由 Claude
- **协作语言中文**：AgentBridge 协作消息中文
- **状态声明实证纪律**：LOC 声明 → `wc -l`；代码缺失 → `Glob` + `Grep`；phase ✅ → commit hash + 测试通过数 + tsc/lint 结果；commit message 附实证片段
- **收尾回写**：三路各自完成后，Claude 在 §0.1 追加"第三轮并行切片（§15）"表格，登记 commits + 实证；然后才启动方向 5

### 15.9 启动序列

1. 任务书（本节）由用户拍板后 Claude commit 到 master
2. Codex 从 §15.4 读取三路任务，启动 3 个 subagent（run_in_background）
3. 主线程保持响应；Claude 对每个 subagent 完成提交做 review（状态实证 + detect_changes）
4. S3 同步点：C2.5 与 M1.5 任一方启动前，两 track owner 在 AgentBridge 对齐 schema fixture
5. 三路全部闭合 → docs-track 回写 §0.1 + 第三轮切片行 → commit → 提醒用户开新 session 跑方向 5（lint sweep）

## 16. Follow-up（本轮后续任务）

> 第三轮切片（§15）落地后的遗留事项。每条都有明确触发条件与 DoD；不要在本文档里继续追加定义,改到各自 follow-up task 或新开 planning doc。

### 16.1 `providers/memory/src/omnimem/store.py` 拆分（SOFT-1）

- **现状**：`wc -l providers/memory/src/omnimem/store.py` = `1036`，超 800 软线 236 行。本轮为避免 M1.2-M1.5 功能 commit 混入纯机械重构而延后。
- **建议切分**（Codex 提案）：
  - `store_schema.py`：schema migration + `_ensure_schema` + `PRAGMA` 设置。
  - `store_validation.py`：`_validate_planning_review_payload` + `_validate_semantic_ingestion_contract` + forbidden keys 常量。
  - `store.py`：保留 CRUD + FTS + recall + MCP-facing API。
- **DoD**：拆后 `uv run pytest -q` 仍 `86 passed`；三个文件 LOC 都 ≤ 400；public API 签名不变（`store.MemoryStore.store()` / `recall()` / etc.）。
- **Trigger**：下一轮独立开一个小 slice，不要塞进 M1.6 / M1.7 功能 commit。

### 16.2 `test_planning_integration.py` NEGATIVE 分支扩展（SOFT-2）

- **现状**：本轮覆盖 4 条路径（POSITIVE / planning_review+events / planning_state+events / MCP round-trip）；6 禁字段里只个别枚举，layer/content_type/schema_version 不匹配尚未单独 NEGATIVE。
- **建议补齐**（预计 +8 条）：
  - 6 禁字段各单独一条 `planning_review` NEGATIVE（checkpoints / phase / budget / currentLeafId / plan 各一）——events 已覆盖。
  - `layer="episodic"` + `source="planning_review"` 应拒。
  - `content_type="text"` + `source="planning_review"` 应拒。
  - `schema_version=2`（未知版本）应拒。
  - `run_id` missing / mismatch 与 payload 应拒。
- **DoD**：每条都验证 `raises ValueError` + 未写入 SQLite。
- **Trigger**：M1.6 / M1.7 开始前或 §16.1 拆分时顺便补。

### 16.3 Benchmark 数据目录结构（SOFT-3）

- **现状**：`.benchmarks/e1a-smoke/` 存放 SWE-bench-Lite manifest + test.jsonl 作为 **input dataset**（M0.9a Arm L spike 残留），本轮未 commit。
- **决策项**：区分 input dataset / output artifact 目录，避免混存：
  - 建议 `providers/memory/benchmarks/datasets/` 放 input（如需纳入版本控制，考虑 Git LFS 或 manifest-only 记录 + 下载脚本）。
  - 建议 `providers/memory/benchmarks/.output/` 放运行产物，默认 `.gitignore`。
- **DoD**：新规则写入 `providers/memory/benchmarks/README.md`；现有 `.benchmarks/` 迁移或保留 `.gitignore` 决定成文。
- **Trigger**：Arm L Spike 解锁 / LongMemEval 数据接入任一事件触发。

### 16.4 `packages/agent-core/src/config/loader.ts` YAML 解析器（SOFT-4）

- **现状**：`wc -l` = `398`，包含一个手写 minimal YAML parser（§parseYamlLike）。MVP 够用但不覆盖 YAML 1.2 完整语法（多行字符串、anchor、flow sequence 等）。
- **状态**：✅ 已闭合（决策：方案 A）。
- **决策**：保留当前手写 minimal YAML parser，仅作为 capability config loader 的受限配置格式解析器使用；不引入新的 `yaml` npm 依赖，不拆分 / 重构 `loader.ts`。
- **受限 YAML 子集**：仅支持 capability config fixture 需要的简单 mapping、缩进对象、布尔值、整数、inline string array（如 `["a", "b"]`）。
- **明确不支持**：YAML 1.2 完整语法，包括但不限于多行字符串、anchor / alias、复杂 flow collection、tag、merge key、非字符串复杂 key。需要这些语法时必须改用 JSON，或另开任务评估引入正式 YAML parser。
- **后续 Trigger**：真实项目 config 写入出现受限 parser 覆盖不了的边角问题，或用户配置需求明确要求 YAML 1.2 语义时，再重新评估方案 B；届时需补测试并保持 integration test 集通过。

### 16.5 S2 跨进程 checkpoint 端到端联调（HIGH-from-Planning-review）

- **状态**：✅ 已闭合。
- **原现状**：Planning review 指出 S2 checkpoint 只在 TS executor mock 内通过，未和 `providers/memory` 的 SQLite store 做真实跨进程联调。
- **DoD 实证**：新增 `packages/agent-core/src/tools/mcp-client.test.ts` 用例 `persists planning checkpoints through MCP OmniMem and recalls state snapshots`，覆盖 TS `LinearPlanExecutor` 触发 `checkpoint_saved` → MCP `memory_store` → `uv run python -m omnimem` Python 进程持久化 → TS `memory_recall` 读回并校验 `stateSnapshot`。
- **验证**：`cd packages/agent-core && pnpm exec biome check src/tools/mcp-client.test.ts` 通过；`cd packages/agent-core && pnpm test src/tools/mcp-client.test.ts` = `16 passed`（含新增跨进程 checkpoint 用例）。

### 16.6 Review 补齐本轮新代码（Q2 follow-up）

- **状态**：✅ 已完成。Review 文档：`docs/review/2026-04-24-04-third-slice-review.md`。
- **结论**：BLOCKING `0` / HIGH `0` / MEDIUM `1` / LOW `2`；MEDIUM/LOW 已修复或文档化；§16.6 gate 可闭合，不阻塞下一轮切片。
- **原现状**：`docs/review/2026-04-24-{01,02,03}-*.md` 覆盖 C0.1-C1.8 / M0.1-M0.10 / cross-cutting 7 commits，**不含**本轮 §15 新代码（Pascal `4496cb4` / Hooke `77e399a` / Halley `3b60904`）。
- **DoD**：已新开 `docs/review/2026-04-24-04-third-slice-review.md`，覆盖三路 commits，重点审计：
  - Halley: `memory-writer.ts` 6 禁字段 + sha256 id stability + MCP error fallback；`audit.ts` / `goal-drift.ts` / `replan.ts` 对 ADR-004 L3a 阈值的引用；`state.ts` 新增 3 种 event 的 reducer 纯性。
  - Hooke: `retriever.py` RRF 融合正确性、`kg.py` 递归 CTE SQL 语义、`store.py` semantic guard 覆盖路径、§16.1 拆分前状态。
  - Pascal: `loader.ts` 四级优先级 + `buildCapabilitiesRuntime` REPL wire 的回退语义。
- **Trigger**：已满足；本 follow-up 收尾前完成 review，未静默进入下一轮切片。
- **新增 follow-up**：已处理。Halley fallback logger 失败不再破坏 advisory writer；Pascal explicit config registry/namespace 行为已文档化；Hooke KG duplicate seed 已去重。
