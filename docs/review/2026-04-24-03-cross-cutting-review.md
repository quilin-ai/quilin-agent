# Cross-Cutting Review — 2026-04-24

> 范围：cross-cutting 7 commits（ADR-005 skeleton / L3a v3 报告 + ADR-004 / planning progress docs §0.1/§11.2/§11.3 / TS memory adapter stub C0.2 / 03-memory §A.8 realign）
> Reviewer：Claude (Reviewer role)
> Commit 基线：56135ff（master HEAD，§15 任务书已 append 但本 review 不含 §15 实现）
> 触发：第三轮并行切片启动前全量 review

## 总评

- 文档/契约健康度：**0.86**
- BLOCKING findings：**0**
- HIGH findings：**1**
- MEDIUM findings：**3**
- LOW findings：**2**
- **可进入第三轮切片：YES**（HIGH-1 建议在 §15 收尾前补，不阻塞起跑）

七个 commit 的 LOC、commit hash、tsc/pytest 通过数与 §0.1 表格逐行实证一致；ADR-005 与 Python/TS 实现互通；ADR-004 阈值与 v3 报告无矛盾；O1–O9 在 §13 闭合，breakdown 不留开放问题。

## Findings（按重要性排序）

### [HIGH] d9ebdf3 ADR-005 在上游 spec 与 implementation plan 中"孤儿化"

- **What**：ADR-005 自称"规范源（normative）"，但 `docs/engineering/03-memory/README.md` 与 `docs/planning/00-implementation-plan.md` 全文 `grep "ADR-005\|adr-005"` **零命中**。Spec 层只引用 breakdown 文件，不引用 ADR-005，等于规范源没有反链。
- **Where**：`docs/adr/adr-005-memory-contracts.md:18` 自称权威；`docs/engineering/03-memory/README.md` 与 `docs/planning/00-implementation-plan.md` 缺反链。
- **Why it matters**：未来如 03-memory §MemoryStore 接口设计（line 645-720）与 ADR-005 §3.1 漂移，读者无从感知 ADR-005 才是规范源。违反 CLAUDE.md "状态声明实证纪律"对契约文档的要求。
- **Suggested fix**：在 §15 收尾的 docs sweep 里给 03-memory §A.8 / §MemoryStore 接口设计 + 00-implementation-plan.md Iter F Memory Depth 段加一行 `> 契约规范源：[ADR-005](../../adr/adr-005-memory-contracts.md)`。
- **Evidence**：
  - `grep -n "ADR-005\|adr-005" docs/architecture/glossary.md docs/engineering/03-memory/README.md docs/planning/00-implementation-plan.md` → 空输出
  - `docs/adr/adr-005-memory-contracts.md:18` "ADR-005 是规范源；与本文档冲突时以本文档为准。"

### [MEDIUM] c2f36c7 / b5a4b09 §0.1 row 71 "fused recall p95 0.174ms" 与 row 72 "M0.6 BM25 p95 < 100ms 门槛"无独立 benchmark artifact

- **What**：commit message 报 `fused recall p95 0.174ms / AMB harness p95 5.795ms`，但仓库根 `.benchmarks/` 是 untracked 目录（git status 显示 `?? .benchmarks/`），benchmark 报告未入版本控制。后续 reviewer 拿不到 raw output。
- **Where**：`docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md:71` + commit b5a4b09 message。
- **Why it matters**：M0 硬门槛"1000 条 p95 < 100ms"目前只能靠 commit message 自证，不可独立复算。属"声明 ✅ 但 evidence 不可重放"。
- **Suggested fix**：把 `providers/memory/benchmarks/` 下基线 JSON / pytest report 在 §15 docs sweep 时一并入 git（或在 README 里记录复跑命令）。
- **Evidence**：`git status` → `?? .benchmarks/`；`providers/memory/benchmarks/amb_baseline.py` 存在（217 LOC）但无落盘 artifact 在 git 中。

### [MEDIUM] 1f0bfe9 ADR-004 与 v3 报告对 "v3 escalation rate 28.2%" 含义解释不一致

- **What**：v3 报告 §6.1 把 28.2% escalation 当作"escalation policy now actually fires"（中性事实）；ADR-004 §4 把同一个数字升级为"违反零-LLM 主路径 spec 承诺"（决策依据）。两文都对，但读者从 ADR-004 跳到 v3 report 会觉得后者太轻描淡写。
- **Where**：`docs/research/rule-first-observer-v3-report.md:30/55/61-62` vs `docs/adr/adr-004-l3a-observer-strategy.md:142`。
- **Why it matters**：未来 ADR-006 起草人若先读 v3 report，可能漏掉 escalation = 隐式 LLM-first 这个判断。
- **Suggested fix**：v3 report §6.1 末尾补一行 cross-link：`> 即便 v4 把 FPR 压回 5%，28.2% escalation 仍违反零-LLM 主路径 spec 承诺，参见 ADR-004 §4。`
- **Evidence**：上述行号实测一致。

### [MEDIUM] 6b8544e TS `MemoryClient.recall()` 与 ADR-005 §3.1 形状已对齐，但 `MemoryRecallOptions.metadata` 类型为 `Record<string, unknown>` 不带 `schema_version`

- **What**：`packages/agent-core/src/memory/client.ts:6` 的 recall options 允许任意 metadata 过滤，但没有强制查询者声明 `schema_version` 兼容性。ADR-005 §3.1 写了"metadata 必须包含 schema_version"是面向 stored item，不面向 query；契约形式上不冲突，但开口比 ADR-005 字面要求更宽。
- **Where**：`packages/agent-core/src/memory/client.ts:3-7`。
- **Why it matters**：未来 schema 演进时，filter 端可能成为隐式破坏面（例如 v2 metadata 改字段，旧 filter 仍接受任意 key）。
- **Suggested fix**：可在 §15 第三轮收尾时增加 `MemoryRecallOptions.metadata` 的可选字段白名单注释，或在 ADR-005 §3.1 明确 "filter metadata 与 stored metadata 同 schema_version"。本期可 defer。
- **Evidence**：`Read packages/agent-core/src/memory/client.ts:1-26`；ADR-005 §3.1 line 48。

### [LOW] 8e14e9d 03-memory §A.8 改写到 Iter F，但 §A.7 line 203 仍写"M0 Sprint 1"作为 rule-first 失败的回退触发点

- **What**：§A.8 已改 Iter F Sprint 1/2/3；但 §A.7 line 203 老句子 "下一次 Sprint 若仍不过 40%，必须切 ML-first（新起 ADR-004）或把 L3a 降级为 opt-in" 还在，与 ADR-004 已起草、Arm L 改走 60% 的事实有时差。
- **Where**：`docs/engineering/03-memory/README.md:202-203`。
- **Why it matters**：阅读 §A.7 不跳到 ADR-004 的人，会以为 40% 仍是 active 门槛。
- **Suggested fix**：§A.7 加一行 `> 2026-04-23 更新：rule-first v3 已被 ADR-004 替换为条件性 d2 ML-first，门槛改为 recall ≥ 60% / FPR ≤ 3% / p95 ≤ 50ms。`
- **Evidence**：`grep -n` 上文输出 line 202-203。

### [LOW] L1/L2/L3a/L3b/L3c 缩写未在 glossary 中显式定义

- **What**：`docs/architecture/glossary.md` 只规范了 `working/episodic/semantic/skill` 小写词表；breakdown 与 ADR-005 大量使用 L1/L2/L3a/L3b/L3c 位置缩写。03-memory §二·A line 98-100/111-127 有图释但 glossary 未列。
- **Why it matters**：CLAUDE.md 说 "glossary 是规范术语源（CI 强制）"，新人读 §15 时 L3a/b/c 没有权威定义可查。
- **Suggested fix**：glossary 加一行：`L1=Working / L2=Verbatim Episodic / L3a=Observation / L3b=Temporal KG / L3c=Hybrid Retrieval`。
- **Evidence**：`grep -n "L3a\|L3b\|L3c"` 在 glossary.md 0 命中；在 03-memory.md 多处命中。

## 实证诚信专项（§0.1 行级对照）

| §0.1 行 | 声明 | 实测 | 结果 |
|---|---|---|---|
| row 37 S0 ADR-005 = 131 | `wc -l docs/adr/adr-005-memory-contracts.md` | `131` | ✅ |
| row 40 C0.2 commit `6b8544e` | `git show 6b8544e` 含 `memory/types.ts` (30) + `client.ts` (26) + `client.test.ts` (93) | 全部存在 | ✅ |
| row 49 第一轮 TS `388 passed` | `c1856c0/49b48f5/144e829/7028e1b` 全部 commit 存在 | ✅ | ✅ |
| row 50 第一轮 Py `65 passed` | `66fc714/a5640ac/1a3957d` 全部存在 | ✅ | ✅ |
| row 51 M0.7 `b515dfa` + M0.9a `bb76f9f` | git log 命中 | ✅ | ✅ |
| row 70 第二轮 TS `410 passed` | `726802a/8b7c183/8275b2b/e82bd1f/3357c91` 全部存在；本地 `pnpm tsc --noEmit` exit 0 | ✅ | ✅ |
| row 71 第二轮 Py `71 passed` + p95 数字 | `1797737/de3fb31/dce589a` 存在；p95 数字仅见 commit message，无 git artifact | ⚠ MEDIUM-1 | partial |
| row 72-73 S4 `a1800c6` Arm L blocked | git show 含资源探测原文 | ✅ | ✅ |
| row 80-89 LOC 表 | `wc -l` 八个 TS 文件 + 八个 Py 文件 100% 命中 | ✅ | ✅ |

无假阳性 ✅。

## ADR-005 / ADR-004 一致性 traceability matrix

| 契约 | ADR-005 §| Python 实现 | TS 镜像 | MCP server | 评价 |
|---|---|---|---|---|---|
| API 稳定 (`MemoryItem` 字段) | §3.1 line 40-48 | `providers/memory/src/omnimem/types.py:57-110` | `packages/agent-core/src/memory/types.ts:19-30` | `server.py:23-54` 通过 `OmniMemStore.recall/store` | ✅ 三端字段顺序、layer 枚举、metadata schema_version 均对齐 |
| layer 枚举 `working/episodic/semantic/skill` | §3.1 line 44 | `types.py:9 Literal` + `VALID_MEMORY_LAYERS` | `types.ts:1 MemoryLayer` | server 通过 layer/tier 双兼容入口 | ✅ |
| `MemoryStore` Protocol 8 方法 | §3.1 line 50-52 | `store.py:41-78` Protocol + `260-470` SQLite 实现 | TS 仅 `MemoryClient` (recall/store) — 是 ADR-005 §3.1 line 59-60 明示的 wire-shape mirror，不要求 Protocol 完整镜像 | server 暴露 `memory_recall/memory_store` | ✅（差异在 ADR 里点名了） |
| tier 语义矩阵 | §3.2 line 64-72 | 由 §A.6/§2.9.2 spec 约束，未在代码层强校验 | 同上 | 同上 | ✅ 文档级闭合；运行时校验留 M1.5 ingestion 时增强 |
| 异步感知 + checkpoint_failed 事件字段 | §3.3 line 92-96 | `executor.ts` mock 已实现 (C1.6 commit 8275b2b) | TS executor.ts `356 LOC` | 未跨进程联调 (§0.1 row 95 已自陈) | ✅ 边界已声明 |
| Arm L 阈值 60/3/50 | ADR-005 不含 | — | — | ADR-004 line 145 + breakdown §6.1 line 393-398 + S4 commit a1800c6 三处一致 | ✅ |

## Glossary 漂移检测

| 偏离项 | 严重度 | 处置 |
|---|---|---|
| L1/L2/L3a/L3b/L3c 位置缩写未列入 glossary | LOW | LOW-2 finding |
| ADR-005 在 03-memory + 00-implementation-plan 0 反链 | HIGH | HIGH-1 finding |
| 03-memory §A.7 line 203 仍提"40% 门槛" | LOW | LOW-1 finding |

## 整改建议

**§15 第三轮收尾前必须先修**：
- HIGH-1：在 03-memory + 00-implementation-plan 加 ADR-005 反链（一次性 docs PR，5 分钟）。

**可与 §15 三路并行 sweep 一起补**：
- MEDIUM-1：把 benchmark JSON 落盘到 git（`providers/memory/benchmarks/.gitignore` 收紧）。
- MEDIUM-2：v3 report §6.1 加 ADR-004 cross-link。
- LOW-1 / LOW-2：03-memory §A.7 时差 + glossary L1/L2/L3 缩写。

**可 defer**：
- MEDIUM-3：MemoryRecallOptions.metadata 收紧白名单 — 等 M1.6 cache_key/block_version 元数据落地时一起做，本期 over-engineering。

第三轮可立即开工；docs HIGH-1 由 docs-track（Claude）在 §15 收尾 sweep 时闭合，不阻塞 C-track / M-track / Config-track 起跑。
