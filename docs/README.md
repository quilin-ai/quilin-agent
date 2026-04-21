# `docs/` — 文档地图

> **目的**：帮你在 7 个子目录里快速找到"该去哪写 / 该去哪查"。**每一份文档只能落在一个子目录里**；跨分类的 cross-ref 用链接，不复制内容。

## TL;DR — 三个常用入口

| 你想做什么 | 去哪 |
|---|---|
| 看总路线图（Iter A→F） | [`planning/00-implementation-plan.md`](planning/00-implementation-plan.md) |
| 看一个 Iter 正在做什么 | [`iterations/NN-iter-*/plan.md`](iterations/) |
| 查术语 / 缩写 / 数量 | [`architecture/glossary.md`](architecture/glossary.md)（**CI 强制**，写新词之前先读） |

## 子目录索引

| 目录 | 里面是什么 | **该写**什么 | **不该写**什么 | 怎么查 |
|---|---|---|---|---|
| [`adr/`](adr/) | 已定稿的架构决策（ADR-001, ADR-002, …） | 一次性、已拍板、要长期生效的技术决策 | 进行中的讨论、phase 状态、代码细节 | 编号查找 `adr-###-slug.md` |
| [`architecture/`](architecture/) | 架构总览 / Harness / 术语表 / benchmark roadmap | 跨领域的顶层概念、全景图、规范术语 | 单领域实现细节（→ `engineering/`）、迭代进度（→ `iterations/`） | 从 `architecture/overview.md` 出发导航 |
| [`engineering/`](engineering/) | 13 个领域 spec（`01-llm-integration/` … `13-skills/`） | 单领域的**规范 spec**（接口、数据结构、策略、风险） | phase 状态（→ `iterations/`）、一次性决策（→ `adr/`）、review 结论（→ `review/`） | 按编号读对应 `README.md` |
| [`planning/`](planning/) | 规划文档：总路线图 + 单 feature 的 phase 拆分 | `00-implementation-plan.md` 宏观路线；`YYYY-MM-DD-NN-slug.md` 单 feature tracking（含 `threat_surface_delta` frontmatter） | 已完成回顾（→ `review/`）、spec（→ `engineering/`）、ADR（→ `adr/`） | 读 [`planning/README.md`](planning/README.md) + 按日期 + 编号排序 |
| [`iterations/`](iterations/) | 每个 Iter 一个目录：`NN-iter-*/plan.md` | Iter 内部的执行 plan（目标、范围、验证、产出） | 跨 Iter 的全景（→ `planning/00-implementation-plan.md`） | 按前缀顺序 `00-phase-0` → `06-iter-f-scaleout` |
| [`research/`](research/) | 一次性调研材料（Claude Code / Codex / OpenClaw / Hermes / skill loading…） | 深度调研产出、对比表、probe 报告 | 决策本身（→ `adr/`）、spec（→ `engineering/`） | 按主题 / 日期文件名 |
| [`review/`](review/) | 架构 / spec / PR review 报告 | ultra-review、phase review、opus revisit 等**一次完成的评审快照** | 进行中的 planning（→ `planning/`） | 按 `YYYY-MM-DD-<topic>.md` |

## 写入规则（3 条硬约束）

1. **顺序前缀强制**
   - `planning/`：`00-` 是总路线图；feature tracking 用 `YYYY-MM-DD-NN-slug.md`（同日多篇 `01` / `02` 递增）
   - `iterations/`：固定 `00-phase-0` → `06-iter-f-scaleout`，不要改
2. **Cross-ref 用链接**：跨目录引用只写 markdown 链接，不要把同一内容粘到第二个地方。
3. **术语以 `architecture/glossary.md` 为准**：写到术语表之外的词（OmniMem tier casing、`skill_view`、Iter 阶段名…）会被 `scripts/lint-glossary.py` CI 拦住。

## 查阅约定

- **默认从 `planning/00-implementation-plan.md` 进入**（路线图）→ 想看细节就点进 `iterations/` 或 `engineering/`。
- **新 session 接续**：读 `planning/` 最新的 `YYYY-MM-DD-NN-handoff.md`（或 pre-phase checklist）。
- **被 review 挂起的改动**：去 `review/` 找对应日期 + topic 的报告。
- **找不到**：先 `grep -r 'keyword' docs/`，或问术语表。
