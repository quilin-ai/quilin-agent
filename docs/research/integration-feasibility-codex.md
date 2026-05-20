# 10 项升级接入可行性独立评估 / Integration Feasibility Independent Review

This document is Codex's independent feasibility review for the ten proposed memory-system upgrades. It is based on direct reads of the current quilin-mem SQLite schema, Python memory provider, TypeScript agent-core memory contracts, Web `/memory` routes, and `docs/03-memory` contracts.

本文是 Codex 对 10 项记忆系统升级方向的独立接入可行性评估。判断依据来自对当前 quilin-mem SQLite schema、Python memory provider、TypeScript agent-core 记忆契约、Web `/memory` 路由以及 `docs/03-memory` 契约的直接实证阅读。

## 结论先行 / Bottom Line

My independent view is: the ten upgrades are directionally compatible with Quilin, but they cannot all be described as "perfectly plug-in." Four can land with low or near-zero disruption if carefully scoped; four require explicit SQLite schema migrations or durable side tables; two carry real integration risk unless the design preserves existing wire contracts.

我的独立判断是：这 10 项升级方向整体和 Quilin 的架构方向兼容，但不能笼统说“完美接入”。其中 4 项可以在严格限定范围下低破坏或近似零破坏落地；4 项需要明确的 SQLite schema migration 或持久化侧表；2 项如果不保留现有 wire contract，会有真实集成风险。

The safest sequencing is: ship memory integrity evaluation first, then evidence/version provenance as an additive schema, then batch consolidation and retrieval safety on top of those contracts, and only then build daemon scheduling, procedural promotion, predictive warming, and visual UX.

最稳的顺序是：先做记忆完整性评测，再以 additive schema 落证据链/版本链，然后在这些契约上做批量整理与安全检索，最后再做 daemon 调度、操作步骤沉淀、前瞻预热和可视化 UX。

## 我跟 Claude 判断的 Diff / Diff From Claude's Classification

| Upgrade / 升级项 | Claude classification / Claude 判断 | Codex classification / Codex 判断 | Diff / 差异 |
|---|---|---|---|
| Memory Integrity Eval / 完整性评测 | Perfect / 完美 | Perfect / 完美 | Agree / 同意 |
| Durable Idle Runtime / quilin-daemon | Perfect / 完美 | Medium disruption / 中破坏 | Reclassify; startup, budget, and WriteAuthority are not plug-in / 重分类；启动、预算、WriteAuthority 不是纯插拔 |
| Procedural Pipeline / 操作步骤流水线 | Perfect / 完美 | Medium disruption / 中破坏 | Reclassify; must respect skill filesystem SSoT / 重分类；必须遵守 skill 文件系统唯一真源 |
| Portability + Resource UX / 反向导出+可视化 | Perfect / 完美 | Low disruption after prerequisites / 有前置依赖的低破坏 | Reclassify; visualizer depends on provenance schema / 重分类；可视化依赖证据链 schema |
| Safe Retrieval Gate / 安全检索门 | Low disruption / 低破坏 | Low disruption only if return type is preserved / 有条件低破坏 | Conditional agree / 有条件同意 |
| Batch Consolidation + Destructive Guard / 批量整理+破坏防护 | Low disruption / 低破坏 | Needs migration as a combined item / 组合项需迁移 | Reclassify; batch is local, guard changes delete semantics / 重分类；batch 局部，防护会改变删除语义 |
| Multi-Client + Project Scope / 多客户端+项目 | Low disruption / 低破坏 | Needs migration / 需迁移 | Reclassify; conflict fields and project scope need durable state / 重分类；冲突字段和项目 scope 需要持久状态 |
| Evidence + Versioned Truth / 证据+版本链 | Needs migration / 需迁移 | Needs migration / 需迁移 | Agree / 同意 |
| Foresight + Predictive Warmer / 前瞻记忆 | Needs migration / 需迁移 | Needs migration, avoid new layer enum / 需迁移，避免新增 layer enum | Agree with warning / 同意但加警告 |
| Salience + Taxonomy / 重要性多维 | Needs migration / 需迁移 | Breaking risk if replacing float / 替换 float 有破坏风险 | Reclassify severity / 重分类严重度 |

Count: I agree on 4 items, reclassify 6 items, and have 1 strong disagreement: `quilin-daemon` is not a perfect integration under the current code because idle budget is in-memory only and WriteAuthority lives in TypeScript.

数量：我同意 4 项，重分类 6 项，其中强反对 1 项：在当前代码下 `quilin-daemon` 不是完美接入，因为 idle budget 只有内存态，而 WriteAuthority 位于 TypeScript 侧。

## 当前架构关键证据 / Current Architecture Evidence

The core memory table is `memory_records`, with fixed columns and a `tier` CHECK constrained to four values: working, episodic, semantic, and skill. The table also stores `importance_score` as `REAL NOT NULL DEFAULT 0.5`; replacing it with JSON would break row deserialization and TypeScript memory clients. Evidence: `providers/memory/src/quilin_mem/store_schema.py:24`, `providers/memory/src/quilin_mem/store_schema.py:36`, `providers/memory/src/quilin_mem/types.py:8`, `providers/memory/src/quilin_mem/types.py:79`, `packages/agent-core/src/memory/types.ts:29`.

核心记忆表是 `memory_records`，字段固定，并且 `tier` CHECK 只允许 working、episodic、semantic、skill 四层。表里还把 `importance_score` 存成 `REAL NOT NULL DEFAULT 0.5`；如果直接替换为 JSON，会破坏 row 反序列化和 TypeScript 记忆客户端。实证位置：`providers/memory/src/quilin_mem/store_schema.py:24`、`providers/memory/src/quilin_mem/store_schema.py:36`、`providers/memory/src/quilin_mem/types.py:8`、`providers/memory/src/quilin_mem/types.py:79`、`packages/agent-core/src/memory/types.ts:29`。

The store layer already has additive migration helpers, which makes optional columns feasible. However, insert, row serialization, FTS candidate queries, `list_by_layer`, and delete behavior all assume the current shape. Evidence: `providers/memory/src/quilin_mem/store_schema.py:64`, `providers/memory/src/quilin_mem/store_records.py:16`, `providers/memory/src/quilin_mem/store_serialization.py:76`, `providers/memory/src/quilin_mem/store_search.py:118`, `providers/memory/src/quilin_mem/store.py:281`.

存储层已经有 additive migration helper，所以新增可选字段是可行的。但 insert、row serialization、FTS 候选查询、`list_by_layer` 和 delete 行为都假设当前形态。实证位置：`providers/memory/src/quilin_mem/store_schema.py:64`、`providers/memory/src/quilin_mem/store_records.py:16`、`providers/memory/src/quilin_mem/store_serialization.py:76`、`providers/memory/src/quilin_mem/store_search.py:118`、`providers/memory/src/quilin_mem/store.py:281`。

The retrieval contract returns `list[MemoryItem]`. A safety gate can be added without breaking callers only if it filters, annotates, or wraps outside this stable return type; changing it to a refusal object would ripple through memory recall, context assembly, tests, and Web consumers. Evidence: `providers/memory/src/quilin_mem/retriever.py:87`, `providers/memory/src/quilin_mem/retriever_bm25.py:25`, `providers/memory/src/quilin_mem/retriever_kg.py:46`.

检索契约返回 `list[MemoryItem]`。安全检索门只有在过滤、打 metadata 标记、或在外层 wrapper 实现时才不会破坏调用方；如果把返回值改成 refusal object，会影响 memory recall、上下文组装、测试和 Web 消费者。实证位置：`providers/memory/src/quilin_mem/retriever.py:87`、`providers/memory/src/quilin_mem/retriever_bm25.py:25`、`providers/memory/src/quilin_mem/retriever_kg.py:46`。

The current Web cleanup route and dedupe execution route call `quilin-mem/memory_delete` directly. The Python MCP server soft-deletes by setting `deleted=1` and removing FTS rows, but it does not expose a reversible delete workflow, impact preview, archive TTL, or Python-side WriteAuthority gate. Evidence: `apps/web/app/api/memory/route.ts:10`, `apps/web/app/api/memory/route.ts:245`, `apps/web/app/api/memory/dedupe/route.ts:215`, `providers/memory/src/quilin_mem/server.py:819`, `providers/memory/src/quilin_mem/store.py:281`.

当前 Web 清理路由和 dedupe 执行路由会直接调用 `quilin-mem/memory_delete`。Python MCP server 通过 `deleted=1` 并移除 FTS row 来软删，但还没有可逆删除流程、影响预览、归档 TTL 或 Python 侧 WriteAuthority gate。实证位置：`apps/web/app/api/memory/route.ts:10`、`apps/web/app/api/memory/route.ts:245`、`apps/web/app/api/memory/dedupe/route.ts:215`、`providers/memory/src/quilin_mem/server.py:819`、`providers/memory/src/quilin_mem/store.py:281`。

`WriteAuthority` currently lives in TypeScript agent-core. Python memory components have narrow protocols in places such as Reflector, but a standalone daemon cannot directly reuse TypeScript confirmation semantics without a bridge or host process. Evidence: `packages/agent-core/src/safety/write-authority.ts:19`, `packages/agent-core/src/safety/write-authority.ts:69`, `providers/memory/src/quilin_mem/reflector.py:77`, `providers/memory/src/quilin_mem/reflector.py:244`.

`WriteAuthority` 当前位于 TypeScript agent-core。Python 记忆组件在 Reflector 等局部位置有窄协议，但独立 daemon 不能不经桥接就直接复用 TypeScript 确认语义。实证位置：`packages/agent-core/src/safety/write-authority.ts:19`、`packages/agent-core/src/safety/write-authority.ts:69`、`providers/memory/src/quilin_mem/reflector.py:77`、`providers/memory/src/quilin_mem/reflector.py:244`。

The skill layer has a hard single-source-of-truth rule: `~/.quilin/skills/**/SKILL.md` is owned by 13-skills, while 03-memory only mirrors usage/success counters. A procedural memory pipeline must propose or promote skills through that path, not store executable procedure bodies in memory. Evidence: `docs/03-memory/README.md:423`, `docs/03-memory/README.md:425`, `docs/03-memory/README.md:445`, `packages/agent-core/src/skills/manager.ts:101`.

技能层有硬性唯一真源规则：`~/.quilin/skills/**/SKILL.md` 由 13-skills 维护，03-memory 只镜像 usage/success counter。操作步骤流水线必须通过该路径提出或晋升 skill，不能把可执行 procedure body 存在 memory 里。实证位置：`docs/03-memory/README.md:423`、`docs/03-memory/README.md:425`、`docs/03-memory/README.md:445`、`packages/agent-core/src/skills/manager.ts:101`。

## 逐项独立评估 / Per-Upgrade Independent Review

### 1. 证据+版本链 / Evidence + Versioned Truth Core

Classification: needs migration. This is the right foundational upgrade, but it is not a pure module addition. The current store updates records in place and soft-deletes by a single `deleted` bit. A versioned truth core needs additive fields such as `version`, `parent_id`, `supersedes_json`, `is_latest`, `source_event_id`, and `evidence_hash`, plus likely side tables such as `memory_sources`, `memory_observations`, or `memory_snapshots`.

分类：需迁移。这是正确的基础升级，但不是纯新增模块。当前 store 会原地 update，并用单个 `deleted` bit 软删。版本化真相核心需要 additive 字段，例如 `version`、`parent_id`、`supersedes_json`、`is_latest`、`source_event_id`、`evidence_hash`，并且大概率需要 `memory_sources`、`memory_observations`、`memory_snapshots` 等侧表。

Integration path: update `store_schema.py`, `store_records.py`, `store_serialization.py`, `store_search.py`, `store.py`, `types.py`, Consolidator metadata, Reflector commit metadata, and Web display only after the back end is stable. Existing interfaces can survive if all new fields are optional and `MemoryItem` still round-trips the old payload.

接入路径：需要改 `store_schema.py`、`store_records.py`、`store_serialization.py`、`store_search.py`、`store.py`、`types.py`、Consolidator metadata、Reflector commit metadata，并且后端稳定后再接 Web 展示。如果所有新字段可选、`MemoryItem` 仍能 round-trip 旧 payload，则现有接口可保留。

Regression risk: medium. The existing pytest suite directly creates legacy `memory_records` tables and asserts delete/FTS behavior; these tests will regress if `is_latest` or evidence filters are applied without default backfill. Evidence: `providers/memory/tests/test_store.py:591`, `providers/memory/src/quilin_mem/store_search.py:118`, `providers/memory/src/quilin_mem/store.py:240`.

回归风险：中等。现有 pytest 会直接创建旧版 `memory_records` 表并断言 delete/FTS 行为；如果没有默认 backfill 就加 `is_latest` 或 evidence filter，会导致回归。实证位置：`providers/memory/tests/test_store.py:591`、`providers/memory/src/quilin_mem/store_search.py:118`、`providers/memory/src/quilin_mem/store.py:240`。

Relation to existing issues: this should be the first real schema epic under QUI-191, before visualizer, destructive guard, and memory time travel. It complements QUI-187 reflection/consolidation rather than conflicting with it.

与既有立项关系：这应该作为 QUI-191 下第一个真实 schema epic，早于 visualizer、破坏防护和 memory time travel。它复用 QUI-187 的 reflection/consolidation，不与其冲突。

### 2. 安全检索门 / Safe Retrieval Gate

Classification: low disruption if implemented as a gate around current retrieval, medium disruption if it changes return types. The current retrieval stack returns `list[MemoryItem]` and callers expect normal memory rows. A safe design should quarantine low-consensus results, attach metadata such as `retrieval_confidence` and `quarantine_reason`, or return fewer records; it should not replace recall with a new union type.

分类：如果作为当前 retrieval 外层 gate 实现，则低破坏；如果改变返回类型，则中破坏。当前检索栈返回 `list[MemoryItem]`，调用方也期望普通 memory row。安全设计应隔离低共识结果、附加 `retrieval_confidence` 和 `quarantine_reason` 等 metadata，或减少返回条数；不应把 recall 改成新的 union type。

Integration path: add a `RetrievalSafetyGate` module used after BM25/vector/KG fusion and before context injection. The gate can reuse existing retrieval metadata because `MemoryMetadata` already allows arbitrary optional fields. It should also add tests for poisoning, contradiction, and low-confidence rejection.

接入路径：新增 `RetrievalSafetyGate` 模块，在 BM25/vector/KG fusion 之后、上下文注入之前调用。该 gate 可以复用现有 retrieval metadata，因为 `MemoryMetadata` 已允许任意可选字段。还需要加 poisoning、矛盾和低置信拒绝测试。

Schema migration: not required for M0. A later durable quarantine list may add a side table, but the first implementation can be stateless and metadata-only.

schema migration：M0 不需要。后续如果要持久化 quarantine list，可以加侧表，但第一版可以是无状态、metadata-only。

Regression risk: low if the public return type remains unchanged. High if `MemoryRetriever.retrieve` stops returning `list[MemoryItem]`. Evidence: `providers/memory/src/quilin_mem/retriever.py:87`, `packages/agent-core/src/memory/local-client.ts:56`, `packages/agent-core/src/context/default-sections.ts:236`.

回归风险：如果 public return type 不变则低；如果 `MemoryRetriever.retrieve` 不再返回 `list[MemoryItem]` 则高。实证位置：`providers/memory/src/quilin_mem/retriever.py:87`、`packages/agent-core/src/memory/local-client.ts:56`、`packages/agent-core/src/context/default-sections.ts:236`。

### 3. 批量整理+破坏防护 / Batch Consolidation + Destructive Guard

Classification: needs migration as a combined item. Batch LLM judging alone is low disruption because `ConsolidationProposal.to_wire_dict()` can keep the existing MCP wire shape. Destructive guard is not low disruption because delete execution currently calls `memory_delete` directly and the store has only a `deleted` bit.

分类：作为组合项需迁移。单独的批量 LLM judge 是低破坏，因为 `ConsolidationProposal.to_wire_dict()` 可以保持现有 MCP wire shape。但破坏防护不是低破坏，因为 delete 执行当前会直接调用 `memory_delete`，而 store 只有一个 `deleted` bit。

Integration path: replace pairwise LLM judging inside `consolidator.py` with batch cluster judging while preserving `memory_consolidate_plan` output. Then add delete staging fields such as `archived_at`, `archive_expires_at`, `delete_reason`, or a `memory_delete_jobs` table before changing Web execution.

接入路径：先在 `consolidator.py` 内把 per-pair LLM judge 换成 batch cluster judge，同时保持 `memory_consolidate_plan` 输出不变。然后在改变 Web 执行路径前，增加 `archived_at`、`archive_expires_at`、`delete_reason` 等字段或 `memory_delete_jobs` 表。

Existing tests likely affected: `test_consolidator_dedupe.py`, `test_reflector.py`, Web `memory-dedupe-route.test.ts`, and `memory-route-delete.test.ts`. The Web route asserts every delete id hits `memory_delete`, so a staging/undo workflow changes tests by design. Evidence: `apps/web/tests/unit/app/memory-dedupe-route.test.ts:228`, `apps/web/app/api/memory/dedupe/route.ts:215`, `providers/memory/src/quilin_mem/server.py:845`.

可能受影响的测试：`test_consolidator_dedupe.py`、`test_reflector.py`、Web `memory-dedupe-route.test.ts`、`memory-route-delete.test.ts`。Web route 现在断言每个 delete id 都会打到 `memory_delete`，所以 staging/undo workflow 会按设计改变测试。实证位置：`apps/web/tests/unit/app/memory-dedupe-route.test.ts:228`、`apps/web/app/api/memory/dedupe/route.ts:215`、`providers/memory/src/quilin_mem/server.py:845`。

Relation to QUI-189: batch judge directly implements QUI-189. The destructive guard should be a separate child issue because it changes data lifecycle and needs WriteAuthority plus rollback semantics.

与 QUI-189 关系：batch judge 直接对应 QUI-189。破坏防护应拆成单独子 issue，因为它改变数据生命周期，并需要 WriteAuthority 与 rollback 语义。

### 4. 完整性评测 / Memory Integrity Evaluation

Classification: perfect integration. This can be added as a benchmark/eval harness without changing runtime behavior. It should measure write precision, contradiction rate, source traceability, retrieval abstention, consolidation safety, and actor-scoped provenance.

分类：完美接入。这可以作为 benchmark/eval harness 新增，不改变 runtime 行为。它应测写入精度、矛盾率、source traceability、检索拒答、整理安全性和 actor-scoped provenance。

Integration path: add datasets and tests under memory research or provider test areas, with a command that runs against an isolated temp database. Do not use the frozen benchmark domain unless the user explicitly unfreezes it; keep this as memory-specific evaluation, not global benchmark infrastructure.

接入路径：在 memory research 或 provider test 区域新增 dataset 和测试命令，并始终使用隔离临时数据库。不要触碰 frozen benchmark domain，除非用户明确解冻；这应是 memory-specific evaluation，不是全局 benchmark infrastructure。

Schema migration: none. Existing 453+ pytest should not regress if the eval is opt-in and uses temp paths. It will expose defects but should not change runtime code.

schema migration：无。如果 eval 默认 opt-in 并使用临时路径，现有 453+ pytest 不应回归。它会暴露缺陷，但不应改变 runtime code。

Relation to current roadmap: this is the best first milestone because it gives a scoreboard before larger schema work. It also prevents "perfect memory" from becoming a feature pile without measured integrity.

与当前 roadmap 关系：这是最适合第一周做的 milestone，因为它在大 schema 改动前提供记分牌，也避免“完美记忆”变成无评测的功能堆叠。

### 5. 持久 Idle Runtime / Durable Idle Runtime (`quilin-daemon`)

Classification: medium disruption, not perfect. The idea is architecturally sound, but current code does not have durable job state, scheduler leases, cross-process shutdown semantics, or a direct bridge from Python jobs to TypeScript WriteAuthority.

分类：中破坏，不是完美接入。这个方向架构上合理，但当前代码没有持久 job state、scheduler lease、跨进程 shutdown 语义，也没有从 Python job 到 TypeScript WriteAuthority 的直接桥。

Integration path: add a daemon process with plugin-style idle jobs, durable `idle_jobs` or `idle_runs` tables, and a budget provider that is not just in-memory. The daemon must start default-off, not block chat/web startup, and communicate failures through structured logs and status APIs.

接入路径：新增 daemon process，支持 plugin-style idle jobs、持久 `idle_jobs` 或 `idle_runs` 表，以及不只是内存态的 budget provider。daemon 必须默认关闭，不能阻塞 chat/web 启动，并通过结构化日志和状态 API 汇报失败。

Existing evidence: `IdleBudgetProvider` defaults to `enabled=False`, `token_budget=0`, and tracks usage in memory. That is fine for manual preview but insufficient for a long-running daemon. Evidence: `providers/memory/src/quilin_mem/idle_budget.py:47`, `providers/memory/src/quilin_mem/server.py:328`.

现有实证：`IdleBudgetProvider` 默认 `enabled=False`、`token_budget=0`，并在内存里计数。这对手动 preview 足够，但不足以支撑长期运行 daemon。实证位置：`providers/memory/src/quilin_mem/idle_budget.py:47`、`providers/memory/src/quilin_mem/server.py:328`。

Regression risk: medium. `just dev`, web MCP spawning, and local development must not hang if the daemon is absent or unhealthy. This should be a separate runtime issue with smoke tests for disabled mode, startup ordering, and cancellation.

回归风险：中等。如果 daemon 不存在或异常，`just dev`、web MCP spawn、本地开发都不能卡死。这应作为独立 runtime issue，覆盖 disabled mode、启动顺序和 cancellation 的 smoke tests。

### 6. 多客户端+项目 Scope / Multi-Client + Project Scope

Classification: needs migration. Project-aware retrieval can start as metadata filters, but true multi-client conflict resolution needs durable writer identity, project identity, modified epoch, and probably optimistic concurrency.

分类：需迁移。项目感知检索可以从 metadata filter 起步，但真正的多客户端冲突解决需要持久 writer identity、project identity、modified epoch，并且大概率需要 optimistic concurrency。

Integration path: add optional fields such as `project_id`, `workspace_root_hash`, `last_writer_client`, `updated_at_epoch`, and `write_epoch`, or side tables for client sessions and conflicts. Retrieval can boost current `cwd` or `QUILIN.md` matches without changing the four memory layers.

接入路径：新增可选字段，例如 `project_id`、`workspace_root_hash`、`last_writer_client`、`updated_at_epoch`、`write_epoch`，或为 client session / conflict 加侧表。检索可以基于当前 `cwd` 或 `QUILIN.md` 做 boost，而不改变四层 memory layer。

Existing code already has project notions in profile and skills, but not in `memory_records`. Profile scope is only `project` or `global_projection`, and Web memory records expose tier/layer/content without project conflict metadata. Evidence: `providers/memory/src/quilin_mem/profile_store.py:16`, `apps/web/app/memory/page.tsx:37`, `apps/web/app/api/memory/route.ts:34`.

现有代码已经有 profile 和 skills 的 project 概念，但 `memory_records` 没有。Profile scope 只有 `project` / `global_projection`，Web memory record 只暴露 tier/layer/content，不含项目冲突 metadata。实证位置：`providers/memory/src/quilin_mem/profile_store.py:16`、`apps/web/app/memory/page.tsx:37`、`apps/web/app/api/memory/route.ts:34`。

Relation to QUI-186: user/soul profile prompt injection can consume project-aware signals, but it does not solve shared DB conflicts. Treat this as a storage and synchronization upgrade, not a prompt-section-only change.

与 QUI-186 关系：user/soul profile prompt injection 可以消费 project-aware signal，但不能解决共享 DB 冲突。应把它当成存储与同步升级，而不是 prompt section 小改。

### 7. 操作步骤流水线 / Procedural Memory Pipeline

Classification: medium disruption. The target is valuable, but it crosses memory observation, self-evolution proposals, and the 13-skills filesystem source of truth. It is not safe to implement by adding procedure bodies to `memory_records`.

分类：中破坏。目标很有价值，但它横跨 memory observation、self-evolution proposal 和 13-skills 文件系统唯一真源。不能简单把 procedure body 加进 `memory_records`。

Integration path: store only trace summaries, success/failure statistics, and skill candidate references in memory; generate SKILL.md proposals through the approved skill management path with WriteAuthority. The `SkillsManager` already scans project/user roots and watches changes, so the pipeline should feed that mechanism rather than bypass it.

接入路径：memory 只存 trace summary、成功/失败统计、skill candidate reference；通过已批准的 skill 管理路径和 WriteAuthority 生成 SKILL.md 提案。`SkillsManager` 已经扫描 project/user roots 并 watch 变更，所以流水线应喂给这个机制，而不是绕过它。

Schema migration: not necessarily in `memory_records`, but likely a new `procedure_candidates` or `skill_maturity` table is needed. If the design only emits proposals and stores metadata, core memory schema can remain stable.

schema migration：不一定要改 `memory_records`，但大概率需要新的 `procedure_candidates` 或 `skill_maturity` 表。如果设计只产出 proposal 并存 metadata，核心 memory schema 可以保持稳定。

Regression risk: medium. The risk is not test failure in current memory code; it is architectural drift against the 03-memory/13-skills ownership boundary. Evidence: `docs/03-memory/README.md:425`, `docs/03-memory/README.md:445`, `packages/agent-core/src/skills/manager.ts:297`.

回归风险：中等。风险不在当前 memory 测试必然失败，而在架构上偏离 03-memory/13-skills 的所有权边界。实证位置：`docs/03-memory/README.md:425`、`docs/03-memory/README.md:445`、`packages/agent-core/src/skills/manager.ts:297`。

### 8. 前瞻记忆+预测预热 / Foresight + Predictive Warmer

Classification: needs migration, with a strong warning: do not add a fifth `MemoryLayer` unless the team is ready for a cross-language enum and UI migration. The safer path is a separate `foresight_items` table or metadata on episodic/semantic records.

分类：需迁移，并且强警告：除非团队准备做跨语言 enum 与 UI migration，否则不要新增第五个 `MemoryLayer`。更安全路径是单独 `foresight_items` 表，或在 episodic/semantic 记录上加 metadata。

Integration path: add fields such as `kind`, `due_at`, `expires_at`, `warm_query`, `warm_status`, and `warm_result_ref`, preferably in a side table. The predictive warmer should be scheduled by the idle runtime and should write only proposals or cached retrieval bundles until WriteAuthority and budget are satisfied.

接入路径：新增 `kind`、`due_at`、`expires_at`、`warm_query`、`warm_status`、`warm_result_ref` 等字段，最好放在侧表。预测预热应由 idle runtime 调度，并且在满足 WriteAuthority 与预算之前只写 proposal 或 cached retrieval bundle。

Existing constraints: both Python and TypeScript declare only four memory layers, and the Web memory page has a fixed tier order and labels. Adding `foresight` as a layer would touch Python types, SQLite CHECK, TS types, Web grouping, and tests. Evidence: `providers/memory/src/quilin_mem/types.py:8`, `packages/agent-core/src/memory/types.ts:1`, `apps/web/app/memory/page.tsx:37`.

现有约束：Python 和 TypeScript 都只声明四层 memory layer，Web memory page 也有固定 tier order 和 labels。把 `foresight` 加成 layer 会触及 Python types、SQLite CHECK、TS types、Web grouping 和测试。实证位置：`providers/memory/src/quilin_mem/types.py:8`、`packages/agent-core/src/memory/types.ts:1`、`apps/web/app/memory/page.tsx:37`。

Relation to QUI-188: this should be a consumer job of the future idle scheduler, not a scheduler primitive. It should also be disabled by default until token budget accounting is durable.

与 QUI-188 关系：这应是未来 idle scheduler 的 consumer job，而不是 scheduler primitive。在 token budget 持久化之前也应默认关闭。

### 9. 重要性多维+分类体系 / Salience + Taxonomy

Classification: breaking risk if implemented as `importance_score` float-to-JSON replacement. It becomes a normal migration only if we keep the scalar field as backward-compatible aggregate and add new optional JSON fields.

分类：如果实现成 `importance_score` float → JSON 替换，则有破坏风险。只有在保留 scalar 字段作为向后兼容 aggregate、并新增可选 JSON 字段时，它才是普通 migration。

Integration path: keep `importance_score: float` unchanged and add `salience_json`, `taxonomy_json`, or `importance_components_json`. Retrieval, archiving, local TS memory, and tests can continue using the scalar score while new rankers consume the richer vector.

接入路径：保持 `importance_score: float` 不变，新增 `salience_json`、`taxonomy_json` 或 `importance_components_json`。检索、归档、本地 TS memory 和测试继续使用 scalar score，新 ranker 再消费更丰富的向量。

Regression evidence: Python `MemoryItem` coerces `importance_score` to float, row serialization casts it to float, archive policy compares it numerically, and the TS local client maps it to local score. Evidence: `providers/memory/src/quilin_mem/types.py:113`, `providers/memory/src/quilin_mem/store_serialization.py:87`, `providers/memory/src/quilin_mem/archive.py:45`, `packages/agent-core/src/memory/local-client.ts:9`.

回归实证：Python `MemoryItem` 会把 `importance_score` 强制转成 float，row serialization 会 cast 成 float，archive policy 会数值比较，TS local client 会映射成 local score。实证位置：`providers/memory/src/quilin_mem/types.py:113`、`providers/memory/src/quilin_mem/store_serialization.py:87`、`providers/memory/src/quilin_mem/archive.py:45`、`packages/agent-core/src/memory/local-client.ts:9`。

Relation to safe retrieval: multi-dimensional salience should feed the safety gate and ranker, but it should not be a prerequisite for the first safety gate. Start additive and preserve the old aggregate score.

与安全检索关系：多维 salience 应喂给安全检索门和 ranker，但不应成为第一版安全门的前置条件。先 additive，保留旧 aggregate score。

### 10. 可移植性+资源 UX / Portability + Resource UX

Classification: low disruption after prerequisites, not perfect as a combined item. Reverse export of user/soul/project memory can be new code. A provenance visualizer and resource memory become meaningfully useful only after evidence/version/source links exist.

分类：有前置依赖的低破坏，不应作为组合项称为完美接入。user/soul/project memory 的反向导出可以是新代码。但 provenance visualizer 和 resource memory 只有在 evidence/version/source link 存在后才真正有意义。

Integration path: implement export as a read-only projection from profile files, memory records, and skill catalog. Add resource pointers through metadata first; only introduce a full `resource_store` table when actual binary/document lifecycle needs search, dedupe, and retention policies.

接入路径：先把 export 实现成从 profile files、memory records、skill catalog 读取的只读投影。资源指针先通过 metadata 加入；只有当真实二进制/文档生命周期需要搜索、去重和保留策略时，再引入完整 `resource_store` 表。

Existing fit: Soul Import and profile parsing already support user/soul/project files, and Web already has a memory page plus profile-file endpoints. However, the current memory page only shows tiered records, not source chains or resource graphs. Evidence: `packages/agent-core/src/config/soul-profile.ts:212`, `apps/web/app/api/profile-files/route.ts:2`, `apps/web/app/memory/page.tsx:121`.

现有匹配点：Soul Import 和 profile parsing 已支持 user/soul/project 文件，Web 也已经有 memory page 与 profile-file endpoints。但当前 memory page 只展示分层 records，不展示 source chain 或 resource graph。实证位置：`packages/agent-core/src/config/soul-profile.ts:212`、`apps/web/app/api/profile-files/route.ts:2`、`apps/web/app/memory/page.tsx:121`。

Regression risk: low for export, medium for visualizer if it tries to infer provenance from current sparse metadata. The visualizer should be staged behind the evidence/version epic.

回归风险：export 低；如果 visualizer 试图从当前稀疏 metadata 推断 provenance，则中等。Visualizer 应排在 evidence/version epic 后。

## 与 QUI-186/187/188/189/190 的关系 / Relation to Existing Follow-Ups

QUI-186 already added user and soul prompt sections, which gives memory output a direct path into context. The new roadmap should not rewrite those sections; it should feed them safer, better-scored, better-provenanced memory.

QUI-186 已经加入 user/soul prompt sections，为 memory output 进入上下文提供了直接路径。新 roadmap 不应重写这些 sections，而应给它们喂更安全、更高评分、更有证据链的记忆。

QUI-187 delivered Reflector and Consolidator integration. Batch consolidation is a direct optimization of that path. Evidence/version, destructive guard, and WriteAuthority-backed delete should be built around the existing `memory_consolidate_plan` tool rather than introducing a parallel dedupe helper.

QUI-187 已交付 Reflector 与 Consolidator 集成。批量整理是这条路径的直接优化。证据链、破坏防护、WriteAuthority-backed delete 应围绕现有 `memory_consolidate_plan` tool 建设，而不是引入平行 dedupe helper。

QUI-188 idle scheduler should be treated as infrastructure for Observer, Reflector, Consolidator, predictive warmer, and self-evolution proposal jobs. It should not own memory semantics.

QUI-188 idle scheduler 应作为 Observer、Reflector、Consolidator、predictive warmer 和 self-evolution proposal jobs 的基础设施，而不应拥有 memory 语义。

QUI-189 batch LLM judge is safe if the consumer-facing MCP wire shape remains unchanged. It becomes risky only when combined with destructive execution semantics.

QUI-189 batch LLM judge 在 consumer-facing MCP wire shape 不变时是安全的。它只有在和 destructive execution 语义合并时才变成高风险。

QUI-190 safety work should prioritize write integrity and retrieval abstention before adding more memory tiers. A system that remembers less but refuses poisoned memory is stronger than one that remembers everything with no gate.

QUI-190 safety 工作应优先做写入完整性和检索拒答，再考虑加更多 memory tier。一个记得少但会拒绝污染记忆的系统，比一个无门槛记住所有东西的系统更强。

## 推荐落地顺序 / Recommended Landing Order

1. Memory Integrity Eval: pure-new, no schema risk, gives a scoreboard.
2. Evidence + Versioned Truth Core: additive migration and provenance backbone.
3. Safe Retrieval Gate: preserve `list[MemoryItem]`, add abstention/quarantine metadata.
4. Batch Consolidation: keep `memory_consolidate_plan` wire shape stable.
5. Destructive Guard: staged delete, undo window, WriteAuthority, durable audit.
6. Multi-Client + Project Scope: project/writer metadata and conflict resolution.
7. Durable Idle Runtime: default-off daemon with persistent budgets and run state.
8. Salience + Taxonomy: additive JSON components, scalar compatibility.
9. Procedural Pipeline: trace-to-skill proposal, never skill body in memory.
10. Foresight + Resource UX: side tables and visualizations after provenance lands.

1. 完整性评测：纯新增，无 schema 风险，先给系统建立记分牌。
2. 证据+版本链：additive migration，建立 provenance backbone。
3. 安全检索门：保留 `list[MemoryItem]`，新增拒答/quarantine metadata。
4. 批量整理：保持 `memory_consolidate_plan` wire shape 稳定。
5. 破坏防护：staged delete、undo window、WriteAuthority、durable audit。
6. 多客户端+项目 Scope：项目/写入者 metadata 与冲突解决。
7. 持久 Idle Runtime：默认关闭 daemon，持久预算与 run state。
8. 重要性多维+分类：additive JSON components，保留 scalar 兼容。
9. 操作步骤流水线：trace-to-skill proposal，绝不把 skill body 存 memory。
10. 前瞻+资源 UX：等 provenance 落地后再做侧表与可视化。

## 总结：能不能完美接入？ / Can It Plug In Perfectly?

No, not all ten can plug in perfectly today. The roadmap is compatible with Quilin, but "perfect integration" only applies to the eval harness and a few carefully scoped read-only projections. The real memory v2 requires deliberate schema evolution, preserved wire contracts, and cross-runtime authority/budget design.

不能，今天不能说 10 项都能完美接入。这个 roadmap 和 Quilin 兼容，但“完美接入”只适用于 eval harness 和少数限定范围的只读投影。真正的 memory v2 需要有意识的 schema 演进、稳定的 wire contract，以及跨运行时的 authority/budget 设计。

The main architectural rule is: do not add layers or replace fields when optional metadata or side tables can carry the new capability. Quilin's advantage is local-first safety, WriteAuthority, multi-client context, and Soul Import portability; preserving those boundaries is more important than copying competitor taxonomies verbatim.

核心架构规则是：能用可选 metadata 或侧表承载能力时，不要新增 layer 或替换字段。Quilin 的优势是 local-first safety、WriteAuthority、多客户端上下文和 Soul Import 可移植性；保住这些边界，比照搬竞品 taxonomy 更重要。
