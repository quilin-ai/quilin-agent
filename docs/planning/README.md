# Feature Planning & Progress Tracking

> **目的**：记录**中等粒度**（一个 feature / 一条需求）的多 phase 拆分和执行进度。会话和代码评审会过期，这里不过期。

## 与其他文档的边界

| 位置 | 粒度 | 例子 |
|---|---|---|
| `docs/implementation-plan.md` | 宏观迁移（Iter A→F） | "Iter A 完成 TS core + Python memory provider" |
| `docs/iterations/<iter>/` | 单个 iter 的详细规划 | Iter B 的工具架构细节 |
| `docs/adr/` | 已定稿的一次性架构决策 | "ADR-003: A2A vs 自建 gRPC" |
| **`docs/planning/<date>-<slug>.md`** | **一条 feature 的 phase 拆分 + 进度** | **"Reasoning Lifecycle: Phase 0-4"** |
| `docs/review/` | 单次 review / spec 报告 | "2026-04-21 prompt-cache spec" |
| `docs/research/` | 一次性调研产出 | DeepSeek reasoning probe |

## 什么时候在这里建文档

任何**跨 2+ commit 或需要暂停/恢复**的 feature 都必须在这里建一个 tracking doc：

- 划分成多个 phase 的实现工作
- 有前置调研 + 后续实施的 feature
- 依赖多个 PR 合并次序的变更

**不要在这里**写：已完成后回顾用的报告（去 review/）、一次性 ADR（去 adr/）、会话里的小改动。

## 必填字段

每个 tracking doc 顶部必须有：

- `status`: `planning` / `in-progress` / `blocked` / `done`
- `owner`: Claude / Codex / human
- `created`: YYYY-MM-DD
- `last_updated`: YYYY-MM-DD
- `phases`: 每个 phase 的 状态 / commit hash / owner / blocker
- `decisions`: 执行过程中产生的关键决策（特别是推翻之前假设的）
- `open_questions`: 待决问题
- `next_action`: 下一步要做什么

参考模板：[`_template.md`](./_template.md)

## 更新规则

- **每完成一个 phase**：更新 `status` + 填入 commit hash
- **每次关键决策 pivot**（比如"原计划推翻"）：在 `decisions` 加一条，写清楚 before / after / 证据
- **结束条件**：feature 全部合并后改 `status: done`，保留文档作为历史记录，不删除
