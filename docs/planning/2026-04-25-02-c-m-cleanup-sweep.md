# Iter D 收口后 C+M Cleanup Sweep

> **状态**: ✅ 已闭合（commit `1023ab5`，2026-04-25）
> **日期**: 2026-04-25
> **owner**: Quilin Agent 团队
> **前置**: Iter D 全部主轴 ✅（`2026-04-25-01-iter-d-parallel-breakdown.md` §12 全部硬验收通过）

本计划是 `2026-04-23-01-iter-c-m-parallel-breakdown.md` §17 转出的 backlog 收口；只在 Iter D 收口后启动，避免 Newton（加 trace 列）/ Boyle（加 scratchpad table）变更与本 sweep 的拆分动作冲突。

---

## 1. 当前共识（启动前必须实证）

启动 sweep 前必须实证以下条件，否则推迟：

- Iter D Newton 已收口：`packages/agent-core/src/observability/**` 落地 + 五层 span 埋点完成 + `event_log.py` `trace_id/request_id/span_id` 列已加 + S1 同步实证通过
- Iter D Boyle 已收口：`providers/memory/src/omnimem/scratchpad.py` 落地 + MCP methods 通过 + 不污染 working/episodic
- Iter D Kelvin 已收口：`~/.quilin/config.toml` loader + `quilin config show/set` CLI 可用
- Iter D Curie 已收口：`crates/mesh-sdk/` stub + CI Rust job 绿
- 全量测试基线：`pnpm tsc --noEmit` exit 0 + `pnpm test` 通过 + `uv run pytest -q` 通过 + `cargo check` 通过

如任一条件未达成，本 sweep 不启动；改去 `2026-04-25-01` 收尾。

---

## 2. 不做事项

- 不在本 sweep 修改任何 ADR；范围严格限制在文档/代码可维护性。
- 不引入新行为、新接口、新依赖；只做拆分 + 文档反链。
- 不动 `store.py`：实证 `wc -l providers/memory/src/omnimem/store.py` = 491（§16.1 已拆完降至 491），低于 800 软线，无需再拆。
- 不动 M1.8 / S8：commit `23837d4` 已闭合，旧文档状态在 `2026-04-23-01` §15.2 / §15.7 / §17 已回写。

---

## 3. Sweep 任务

### 3.1 大文件拆分（实证 LOC 超 500，行为面较广）

**写边界**：仅 `providers/memory/src/omnimem/{kg,retriever}.py` + 对应 tests + 新拆出的子模块。**禁止**变更现有 public API；任何重命名走兼容 re-export。

| 任务 | 实证 LOC（启动前需复核） | DoD |
|---|---|---|
| `kg.py` 拆分 | 530 | 拆为 `kg.py`（核心 entity/edge schema + 公共 API）+ `kg_query.py`（递归 CTE / 子图查询）+ `kg_validation.py`（schema 验证）；原 `kg.py` 通过 re-export 维持兼容；目标主文件 ≤ 250 行 |
| `retriever.py` 拆分 | 535 | 拆为 `retriever.py`（核心融合调度）+ `retriever_bm25.py`（BM25 / FTS5 通道）+ `retriever_vector.py`（语义/向量通道）+ `retriever_kg.py`（KG 子图通道）；原 `retriever.py` 通过 re-export 维持兼容；目标主文件 ≤ 250 行 |

拆分纪律：

- 任一拆分 commit 前后必须跑 `cd providers/memory && uv run pytest -q` 全部通过、`uv run ruff check src tests` clean
- 现有 `MemoryClient.recall()` / `MemoryStore.search()` 等入口签名不变
- AMB 100k benchmark 不回归（p95 仍低于 `300ms` 硬门槛）
- 拆分理由直接写入子模块文件首行 docstring（不另开文档）

### 3.2 S8 文档/契约收口（仅在用户要求"完整冻结"时启动）

**默认跳过**：`UserProfile` dataclass + `schema_version=1` + `ProfileSignal` shape 已随 M1.7 commit `23837d4` 落地，schema 实证已冻结；`23-01` §17.1 已标 closed。

如用户要求 ADR-007 字段表与代码反链：

- 在 `docs/adr/adr-007-identity-files.md` §3.2 / §3.3 末尾追加"实证落点"段，链到 `providers/memory/src/omnimem/profile_store.py` 与 `tests/test_user_md_mirror.py`
- 不新写 schema；不修改 ADR 决策

### 3.3 不在本 sweep 范围

- M1.4 reranker event_log → OTel dual-emit：归 Iter D Newton 后半段（`2026-04-25-01` §4.1）
- M2.7 soul.md ContextAssembler 接入：归 Iter F prelude（`00-implementation-plan.md` Iter F 段）
- M1.1 / M0.9b L3a observer：资源 blocked，归 `00-implementation-plan.md` 待激活项段
- DockerSandbox / mesh-sdk 实质代码：归 Iter D 后期或 Iter F

---

## 4. 验收

- [x] `kg.py` 主文件 ≤ 250 行（实证 208）；新子模块：`kg_query.py` 179 / `kg_validation.py` 208
- [x] `retriever.py` 主文件 ≤ 250 行（实证 208）；新子模块：`retriever_bm25.py` 240 / `retriever_vector.py` 50 / `retriever_kg.py` 76
- [x] `cd providers/memory && uv run pytest -q` 全部通过（187 passed，coverage TOTAL 95.28% ≥ 95% 门槛）
- [x] `cd providers/memory && uv run ruff check src tests` clean
- [x] AMB 100k benchmark p95 ≤ `300ms`（实证 0.286ms，max 0.305ms）
- [x] public API 签名不变（`grep` 实证 `MemoryRetriever.recall` / `MemoryStore.search` diff 空，imports 通过 re-export 维持兼容）
- [x] `just test-all` 三语言全过：TS 717 + Python 187 + Rust 1
- [x] commit `1023ab5 refactor(memory): split kg and retriever modules (25-02 cleanup sweep)`

---

## 5. 协作

- 谁写代码谁 commit；本 sweep 单一切片，可由 Claude 或 Codex 任一执行
- 中文协作；状态声明实证；commit message 附 `wc -l` 拆分前后对比

---

## 6. References

- [`docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md`](./2026-04-23-01-iter-c-m-parallel-breakdown.md) §16.8 / §17.2 — 转出来源
- [`docs/planning/2026-04-25-01-iter-d-parallel-breakdown.md`](./2026-04-25-01-iter-d-parallel-breakdown.md) §13 — Iter D 收口后启动条件
- [`docs/planning/00-implementation-plan.md`](./00-implementation-plan.md) "Blocked / 待激活项" — sweep 后仍未归属的项
- [ADR-005 Memory Contracts](../adr/adr-005-memory-contracts.md) — 拆分时不得破坏的契约
