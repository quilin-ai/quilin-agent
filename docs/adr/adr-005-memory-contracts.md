# ADR-005: Memory Contracts — Iter C 与 Iter M 并行契约冻结

> **状态**: Proposed (Day 0 contract freeze)
> **日期**: 2026-04-23
> **决策者**: Quilin Agent 团队
> **前置**: [ADR-004](./adr-004-l3a-observer-strategy.md)（L3a Observer 策略决策）

---

## 1. 状态

Iter C（Planning）与 Iter M（Memory）并行启动前，必须冻结跨 TypeScript 与 Python 的 Memory 契约。本文档是三条并行契约的规范源：

- API 稳定性
- tier 语义兼容
- 异步感知

`docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md` 是执行清单；与本文档冲突时，以本文档为准。

本文不改变 ADR-004 的 L3a 策略。L3a 仍不计入 Memory M0 硬门槛；Memory M0 只冻结 L1 working、L2 episodic、FTS/BM25 与融合召回主路径所需契约。

---

## 2. Context

Planning M0 需要在 Memory 离线或部分异步能力失败时继续运行；Memory M0 需要在不等待 L3a、KG、reranker 的情况下提供稳定的 recall/store 形状。两条 track 的交汇点是统一 `MemoryItem` JSON wire shape。

当前风险来自三个方向：

1. **API 漂移**：Python `MemoryRecord` 只有 `id/content/tier`，不足以表达 03-memory §MemoryStore 接口设计中的统一模型；TS 侧尚无镜像类型。
2. **tier 语义漂移**：Planning 的运行态、checkpoint、复盘总结与 skill telemetry 如果写入错误 tier，会污染长期记忆或泄漏 skill 正文。
3. **异步失败混淆**：L3a/KG/index/reranker 是异步增强路径；失败不能阻塞 L2 verbatim，也不能被伪装成正常无 checkpoint。

---

## 3. Decision

### 3.1 契约 A：API 稳定性

冻结 Python `MemoryItem` 为 Memory wire model，字段为：

`id / content / content_type / layer / metadata / embedding / created_at / last_accessed / access_count / importance_score`

`layer` 枚举固定为：

`working | episodic | semantic | skill`

`metadata` 必须包含 `schema_version: int`，起始值为 `1`；可选字段包括 `source / score / staleness`。后续新增字段必须保持可选；删除或重命名字段必须走 planning 修订或 ADR。

冻结 Python `MemoryStore` Protocol，全 async，方法为：

`add / search / get / update / delete / list_by_layer / count / clear_layer`

`OmniMemStore` 保留为该 Protocol 的一个实现，并保留现有 `recall()` / `store()` 兼容入口。`MemoryRecord` 若迁移为 `MemoryItem`，必须保留类型别名或明确 deprecation，不允许破坏现有 recall/store 测试。

冻结 TS 镜像：

- `packages/agent-core/src/memory/types.ts` 提供 readonly `MemoryItem`、`MemoryLayer` 与 metadata 类型。
- `packages/agent-core/src/memory/client.ts` 提供 `MemoryClient` 与 `NullMemoryClient`。
- Memory 离线时，`NullMemoryClient.recall()` 返回空数组，`store()` 成功 no-op。

### 3.2 契约 B：tier 语义兼容

四层语义冻结如下：

| Tier | 允许写入 | 禁止写入 |
|---|---|---|
| working | 当前 plan 树、当前叶子、最近对话轮、session 内临时 scratch | 跨 session 的稳定策略 |
| episodic | 最终 plan、checkpoint、replan 历史、失败原因、调试轨迹 | 未经复盘的长期知识 |
| semantic | 复盘后的稳定策略、跨任务通用经验、明确用户偏好 | 运行中的 `PlanningState`、失败 plan 原文、临时工具结果 |
| skill | skill 的使用/成功/失败计数器 | skill 正文、触发 pattern、`SKILL.md` 内容 |

任何 semantic 写入必须带 `schema_version`、`source` 与稳定性说明字段（例如 `stability_reason`）。Planning 的运行中状态不得写入 semantic。

### 3.3 契约 C：异步感知

同步主路径：

- L1 working 写入
- L2 verbatim episodic 写入
- Planning checkpoint 写入 episodic

异步增强路径：

- L3a observer
- L3b KG
- L3c 向量/索引刷新
- reranker 训练信号

异步增强失败不得阻塞 L2 verbatim，不得阻塞 Planning，不得改变 recall/store 的基础兼容形状。`recall()` 可以返回带 `staleness` 标记的结果。

Planning checkpoint 必须 await 成功；失败时必须产生独立 `checkpoint_failed` 事件，字段为：

`run_id / phase / task_hash / error_code / ts`

不得用 `storageRef: null` 表示 checkpoint 失败，以免混淆"正常没有 checkpoint"与"checkpoint 写入失败"。

---

## 4. Consequences

### 正向后果

- Iter C 与 Iter M 可以并行推进，TS/Python 通过同一 fixture 验证 JSON 形状。
- Memory 离线或异步增强失败时，Planning M0 仍可运行。
- `MemoryItem` 成为后续 L1/L2/semantic/skill/user-profile 的统一 wire model。
- L3a 继续由 ADR-004 管理，不阻塞 Memory M0 主路径。

### 约束

- 核心类型文件必须保持小而稳定；本轮 TS 核心类型文件 LOC 不超过 250。
- 新字段只能可选演进；破坏性 schema 变化必须走 ADR 或 planning 修订。
- skill tier 只保存 telemetry，不保存 skill 正文或触发 pattern。
- semantic 写入必须经过复盘稳定化，不能直接保存运行态或失败原文。

### 后续工作

- M0.1 在 Python 侧落地 `MemoryItem`、`MemoryStore` Protocol 与 fixture。
- C0.2 在 TS 侧消费同一 fixture，冻结 `MemoryClient` no-op adapter。
- M0.4 保证 MCP `memory_recall` / `memory_store` wire shape 与 legacy tests 兼容。
- C1.6 落地 checkpoint 写入失败时的独立事件处理。

---

## 5. References

- [Iter C × Iter M 并行任务拆分](../planning/2026-04-23-01-iter-c-m-parallel-breakdown.md) — §3 三条契约冻结，§11.1 Day 0 顺序，§13 O1-O9 决议
- [03-memory](../engineering/03-memory/README.md) — §A.5 / §A.6 / User Profile Store / MemoryStore 接口设计
- [04-planning](../engineering/04-planning/README.md) — §2.1 v1.1 Main LLM direct + structural dispatch，§2.9.2 tier 写入矩阵
- [ADR-004](./adr-004-l3a-observer-strategy.md) — L3a Observer 策略与 Memory M0 非阻塞边界
- [agent-bridge.md](../../agent-bridge.md) — Claude ↔ Codex 协作协议与状态声明实证纪律
