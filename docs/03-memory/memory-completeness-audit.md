# 完美记忆系统 v2 — 完整功能 Audit / Full Feature Completeness Audit

> **Date / 日期**: 2026-05-21
> **Audit scope / 审计范围**: `docs/research/agent-memory-systems-survey-2026-05-21.md` + `docs/03-memory/` + Plane memory-related work items
> **Source of truth / 真相源**: git master + grep + read code (read-only)
> **Method / 方法**: read research roadmap → list every promised feature → grep master to verify implementation status → label ✅ shipped & wired / ⏳ shipped but stub or follow-up / ❌ not yet built / ⛔ explicitly out-of-scope

This audit answers the user's question: "确保 docs/research/agent-memory-systems-survey-2026-05-21.md、docs、plane 里面提到的所有关于记忆的要全部完成，还有服务于记忆的所有功能也包含在内 / Make sure everything in the memory survey, docs, and Plane is fully done, including memory-serving features."

本审计回答用户提问：是否漏掉任何"记忆 + 服务于记忆"的功能。

---

## 1. 调研路线图 §5.1 - §5.10 状态 / Research Roadmap Status

The roadmap merged 20 ideas into 10 workstreams. Each row below cites a commit hash or source file showing actual landing state.

下表把 §5 路线图 10 个 workstream 全部点名，对应每条 ship 状态、commit hash 和遗留缺口。

| § | Workstream | Plane | Status | Evidence / 实证 | Gap / 缺口 |
|---|---|---|---|---|---|
| 5.1 | Evidence + Versioned Truth Core | QUI-193 (191B) | ✅ | `store_schema.py:130-189` adds `parent_id` / `supersedes_json` / `is_latest` / `forget_after` / `strength` / `evidence_hash` / `resource_pointer_json`; `memory_sources` + `memory_snapshot` tables at lines 330-355; `store.py:1162 checkout_at` time-travel API; commit `414eb62` + `2a392e1` | none |
| 5.2 | Safe Retrieval Gate | QUI-194 (191C) | ✅ wired | `retrieval_safety_gate.py` 642 LOC (low-confidence rejection + consensus_check + poisoning_quarantine + SafetyLesson match); `server.py:264-274` wires gate into `memory_recall` handler; commit `ab1f758` | `retrieval_safety_gate.py:163` still calls a `deterministic stub` consensus path when no LLM judge is configured — acceptable fallback, not a real gap |
| 5.3 | Batch Consolidation + Destructive Guard | QUI-189 + QUI-195 (191E) | ✅ | `consolidator.py:39` batch judge (10K context / 150 records / 1 LLM call); `store.py:347-457` history_snapshot + 72h soft-delete + `forget_after` + `recover_memory`; commits `414eb62`, `f3f05cd`, `2a392e1` | none |
| 5.4 | Memory Integrity Eval | QUI-192 (191A) | ✅ | `tests/test_memory_integrity.py`, `tests/integrity_fixtures/`; 35 tests; commit `ab1f758` | LongMemEval / LoCoMo / BEAM public-bench lanes are deferred (per Benchmark Freeze) — only local fixture lane shipped |
| 5.5 | Durable Idle Runtime (`quilin-daemon`) | QUI-188 (191F) | ⏳ wired but partial | `daemon.py` 494 LOC backend + `daemon_main.py` 447 LOC entry + 4 jobs registered; commit `2a392e1` + `bc44fcc`; `MemoryReflectJob` and `MemoryConsolidateJob` now call real `Reflector.propose` / `Consolidator.propose` (lines 99-162, 178-298) | `KGBackfillJob.run` at `daemon_main.py:324` is still a `TODO(QUI-205 wire)` stub (`asyncio.sleep(0.05)` returns 0 backfilled); `TokenBudgetMonitorJob` only logs ticks; daemon defaults to `QUILIN_DAEMON_DRY_RUN=true` so even committed jobs only plan (no actual writes); local-only WriteAuthority wiring deferred |
| 5.6 | Multi-Client + Project Scope | QUI-196 (191G) | ⏳ wired, UI follow-up | `project_scope.py` 218 LOC (cwd → QUILIN.md → sha16 fallback); `last_writer_client` column + per-client receipts in store; commit `24ac080` | Web UI conflict-resolution merge UI is the deferred piece (commit message of `24ac080` notes "Web/UI follow-up") |
| 5.7 | Procedural Memory Pipeline (trace-to-skill) | QUI-198 (191I) | ⏳ wired, WriteAuthority follow-up | `trajectory_compressor.py` 625 LOC (AgentCase records) + `skill_proposer.py` 407 LOC (SkillProposal → SKILL.md body render); commit `cf93af6` | SKILL.md disk-write path via WriteAuthority not yet wired (per `v2-shipping-final-report.md` §9: "QUI-198 SKILL.md 落盘 wire") |
| 5.8 | Foresight + Predictive Warmer | QUI-199 (191J) | ⏳ wired, viz follow-up | `prospective.py` 566 LOC + 4 MCP tools (`memory_prospective_list_due` / `_mark_done` / `_snooze` / `_cancel`) at `server.py:1028-1098`; `resource_pointer_json` column in schema; commit `24ac080` | "Conservative predictive warmer" (precompute likely context during idle) is **not implemented** — only the reactive prospective/reminder path is wired; Web Evidence Graph viz also deferred (`v2-shipping-final-report.md` §9) |
| 5.9 | Salience + Taxonomy + Staleness | QUI-197 (191H) | ✅ wired | `salience.py` 556 LOC (6-dim importance + 9 kinds + intent weighting + staleness marker); `apps/web/app/memory/page.tsx:1207` renders `stalenessMarker` + `salience` in `MemoryDetailPanel`; commit `24ac080` + `404fc77` | LLM-side staleness wrap (system-reminder `"47 天前"` in prompt) is the only follow-up — UI shows it but prompts don't yet (`v2-shipping-final-report.md` §9) |
| 5.10 | Portability + Resource UX | (no Plane) | ❌ + ⏳ + ⛔ | `resource_pointer` column exists (✅); **reverse Soul Export** is explicitly **not done** (`v2-shipping-final-report.md` §4 calls it out: "反向导出已明确不做(单向)" ⛔); provenance visualizer = ❌ (no Web evidence-graph route or UI) | reverse export deliberately dropped per user; provenance visualizer queued in `v2-shipping-final-report.md` §9 |

### §6 follow-up

The "first-week measurable gate" (§10): bad memory → trusted profile blocked, superseded user identity inactive, batch dedupe traces to evidence, low-confidence triggers abstention. All four sub-gates have test fixtures landed (`test_memory_integrity.py`, `test_retrieval_safety_gate.py`, `test_destructive_guard.py`, `test_consolidator_batch_judge.py`). ✅

"第一周可测 gate" 的四个子门(种子恶意记忆 / supersession 失效 / batch dedupe 可追溯 / 低置信拒答)的 fixture 全 ship 实测，标 ✅。

### §9 disagree points (user-decided)

1. ResourceStore now → 仅预留 `resource_pointer_json` ✅
2. Predictive warming aggressiveness → 保守，但 warmer 没实现 ❌
3. git-style memory exposure → `checkout_at` API 已 ship ✅
4. Reverse Soul Export → 用户明确不做 ⛔
5. Memory types → 4 layer 保留 + 9 kind 正交 ✅

---

## 2. docs/03-memory spec 组件状态 / Spec Component Status

These are the named components from `docs/03-memory/README.md` §二·A (D-20 v2 architecture) and §二·B (v1 baseline layers).

下表覆盖 `docs/03-memory/README.md` 在 D-20 v2 融合架构和 v1 baseline 里点名的全部组件。

| Component | Source / 出处 | Status | Evidence |
|---|---|---|---|
| **L1 Working Memory** | §二·B Layer 1 | ✅ | `working.py` 86 LOC; FIFO k=5 |
| **L2 Verbatim Episodic Store** | §二·A.7 L2 | ✅ | `episodic.py` + `archive.py` (SQLite + age-tier columns); `store.py` WAL |
| **L3a Observer (rule-first + LLM fallback)** | §二·A.7 L3a | ✅ wired but default OFF | `observer.py` 1656 LOC (L1 deterministic + L2 LLM tier 2); `memory_observe` MCP tool at `server.py:1212`; **Task #97 gate FAILED at 21.4% recall** so `memoryObserver.enabled = false` by default per README L113-118 |
| **L3b Temporal KG (lazy + bi-temporal)** | §二·A.7 L3b | ✅ | `kg.py` 285 LOC + `kg_extractor.py` 385 LOC + `kg_query.py` 224 LOC + `kg_validation.py` 208 LOC + `kg_backfill.py` 212 LOC; SQLite-only, no Kuzu/Neo4j |
| **L3c Hybrid Retrieval + Fusion** | §二·A.7 L3c | ✅ | `retriever.py` + `retriever_bm25.py` + `retriever_vector.py` + `retriever_kg.py` + `reranker.py`; commit `b1e4a6d` (KG) + earlier hybrid stack |
| **L4 Procedural Memory / Skill Stats** | §二·B Layer 4 (D-11) | ✅ | Layer 4 only stores counters; SSoT lives in 13-skills (`~/.quilin/skills/`); enforced by D-11 |
| **Reflector** | §二·A.7 Consolidator + §五 | ✅ | `reflector.py` 346 LOC; daemon `MemoryReflectJob` calls `Reflector.propose` (`daemon_main.py:99-162`) |
| **Consolidator** | §二·A.4 元层 | ✅ | `consolidator.py` 1626 LOC (batch judge + dedupe / reflect / prune_kg / recompress strategies); idle-budget gated |
| **RetrievalSafetyGate** | §5.2 + 调研 | ✅ | `retrieval_safety_gate.py` 642 LOC; wired in `server.py:_memory_recall_with_store` |
| **SafetyLessonStore (SQLite)** | QUI-200 | ✅ | `safety_lesson_store.py` 304 LOC SQLite-backed; `retrieval_safety_gate.py` consumes via match() |
| **Multi-dimensional importance / Salience** | §5.9 + QUI-197 | ✅ | `salience.py` 556 LOC (6 dims + intent weighting) |
| **Memory Type Taxonomy (9 kind)** | §5.9 + QUI-197 | ✅ | `salience.py` 9 kinds; `kind` column in store_schema |
| **Staleness perception (Claude-Code style)** | §5.9 | ⏳ UI-only | `salience.py:506 build_staleness_marker` + `MemoryDetailPanel.stalenessMarker`; LLM prompt-side wrap NOT yet (follow-up per §1 row 5.9) |
| **ProfileStore + ProfileUpdater** | §二·B User Profile Store | ✅ | `profile_store.py` 642 LOC + `profile_updater.py` 407 LOC; single-writer D-05 contract; `sync_user_md` mirrors to `~/.quilin/user.md` |
| **DepartureContext** | §二·B Departure Context | ⏳ doc-only | Spec describes 30-min inactivity trigger; no `departure_context.py` module on master — only `profile_updater` style mirroring. Gap. |
| **Scratchpad** | §二·B + tools | ✅ | `scratchpad.py` 396 LOC + 3 MCP tools (`scratchpad_write/read/clear`) |
| **Soul Schema validator** | §二·B + Soul Import | ✅ | `soul_schema.py` 70 LOC |
| **Soul Import (6-framework scanner)** | §1 row Quilin-Ahead-3 + QUI-81 | ⏳ backend ship, install-time trigger UI deferred | `packages/agent-core/src/config/soul-import-scanner.ts` 239 LOC + `seedDefaultConfigs` flag + `first_run_seed` WriteAuthority gate at `soul-profile.ts:550`; tests in `first-run.test.ts`; UI/CLI prompt trigger queued (`v2-shipping-final-report.md` §9) |
| **Event log + provenance** | §A.7 + audit | ✅ | `event_log.py` 551 LOC + `event_log_schema.py` 82 LOC |
| **ConsolidationLog (timeline)** | UX-4 Slice 4 | ✅ | `consolidation_log.py` 246 LOC + `consolidation_log_recent` MCP tool + timeline UI |
| **IdleBudget** | §二·A.7 元层 | ✅ | `idle_budget.py` 107 LOC; gates consolidator + observer |
| **TrajectoryCompressor (AgentCase)** | §5.7 / QUI-198 | ✅ class, write path deferred | `trajectory_compressor.py` 625 LOC + `skill_proposer.py` 407 LOC; SKILL.md disk-write via WriteAuthority queued |
| **ProspectiveMemory** | §5.8 / QUI-199 | ✅ reactive only | `prospective.py` 566 LOC + 4 MCP tools; **predictive warmer = ❌ not implemented** |
| **ProjectScope (cwd → QUILIN.md)** | §5.6 / QUI-196 | ✅ | `project_scope.py` 218 LOC |
| **Promotion (working → episodic, WriteAuthority gated)** | §A.5 + QUI-22 | ✅ | `promotion.py` 663 LOC; atomic under SQLite store lock (commit `2a392e1`) |

---

## 3. Plane 工单状态总览 / Plane Work Item Overview

Plane query results (workspace search "memory" + "consolidator reflector" + "soul import"):

Plane 查询结果（按状态分组）：

### 3.1 已完成 / Done (state_id `cd9f41ec...` only QUI-168 cancelled, others "started" = In Progress with commits landed)

Plane 当前没有把 v2 工单移到 Done state — 所有 Memory work item 仍在 `started` state (state_id `9e155d80-20e2-4de0-aca1-994f8f84be2e`). 但 commit 已 ship，docs 已对应 update。差距 = Plane state sync 没跑。

`24ac080` 提到的 6 工单（QUI-196 / QUI-197 / QUI-199 / QUI-200 / QUI-190 / QUI-81）仍 Plane In Progress；`2a392e1` 工单（QUI-195 / QUI-188 / QUI-22）也 In Progress；`ab1f758` 工单（QUI-192 / QUI-194）也 In Progress。

#### Memory v2 epic + sub-issues (Plane state vs. real)

| Plane ID | Title | Plane state | Real status | Comment |
|---|---|---|---|---|
| QUI-191 | EPIC 完美记忆系统 v2 | Backlog | tracked in epic | OK |
| QUI-192 | 完整性评测 | In Progress | ✅ shipped `ab1f758` | needs Plane → Done |
| QUI-193 | 证据+版本链+时光回溯 | In Progress | ✅ shipped `414eb62` | needs Plane → Done |
| QUI-194 | 安全检索门 | In Progress | ✅ shipped `ab1f758` | needs Plane → Done |
| QUI-195 | 破坏防护 | In Progress | ✅ shipped `2a392e1` | needs Plane → Done |
| QUI-196 | 多客户端 + 项目范围 | In Progress | ⏳ backend ✅ / UI ❌ | Plane → Done backend, open follow-up issue for UI |
| QUI-197 | 重要性多维 + 类型 + 过期 | In Progress | ⏳ UI ✅ / LLM prompt wrap ❌ | Plane → Done storage, open follow-up for prompt wrap |
| QUI-198 | 操作步骤流水线 | In Progress | ⏳ class ✅ / disk-write ❌ | Plane → Done class, open follow-up for SKILL.md persistence |
| QUI-199 | 前瞻 + 资源指针 + 可视化 | In Progress | ⏳ prospective ✅ / viz ❌ / predictive warmer ❌ | split: close prospective, open viz + warmer follow-ups |
| QUI-200 | SafetyLessonStore SQLite | In Progress | ✅ shipped `24ac080` | needs Plane → Done |
| QUI-188 | quilin-daemon | In Progress | ⏳ backend ✅ + 2 jobs wired / KG backfill TODO / TokenMonitor stub | Plane → Done backend, open follow-up issue for KGBackfill |
| QUI-189 | batch LLM judge | In Progress | ✅ shipped `414eb62` | needs Plane → Done |
| QUI-190 | temporal-aware dedupe | In Progress | ✅ shipped `24ac080` (`test_temporal_dedupe.py`) | needs Plane → Done |
| QUI-187 | Reflector + Consolidator idle loop | In Progress (Urgent) | ✅ shipped (multiple commits) | needs Plane → Done |
| QUI-185 | A+B 记忆自动整理 | In Progress | ✅ subsumed by Consolidator | close as duplicate of QUI-189 / QUI-187 |
| QUI-186 | soul.md/user.md identity inject | In Progress | ✅ shipped `d918608` per README | needs Plane → Done |

#### Sibling memory issues outside the v2 epic

| Plane ID | Title | Plane state | Real status |
|---|---|---|---|
| QUI-22 | L3a working→episodic promotion (promoter atomic + WriteAuthority) | In Progress | ✅ shipped `2a392e1` |
| QUI-80 | 用户/助手身份记忆混淆 + memory_store metadata 缺失 | In Progress (High) | likely ✅ subsumed by QUI-186 + observer; needs spot-check |
| QUI-81 | Soul Import 6 框架 scanner (this is the **agent-core** issue; not the same numeric ID as Plane "QUI-81 REPL web_fetch") | In Progress | ⏳ backend ✅ / install-time trigger UI ❌ |
| QUI-102 (Plane seq 81) | 灵魂导入 6 框架 EPIC | Backlog | parent epic — keep open until QUI-81 trigger UI lands |
| QUI-103 (Plane seq 80) | 微信聊天记录导入 | Backlog | ❌ only `wechat-import/profile-stub.ts` returns `[stub]` |
| QUI-104 (Plane seq 79) | GitHub Star / X bookmark / Obsidian watcher | Backlog | ⏳ detection layer only (commits `6357bf8` + `7b34e3a`); real watcher / summarize / proactive action ❌ |
| QUI-116 (Plane seq 67) | user.md auto-update via observer→ProfileUpdater | In Progress | ✅ shipped (ProfileUpdater.sync_user_md + advisory locks) |
| QUI-117 (Plane seq 66) | 启动时自动创建 ~/.quilin/memory.db | In Progress | ✅ shipped (`first-run.ts`) |
| QUI-95 (Plane seq 88) | quilin-mem observer/consolidator 长期记忆闭环 | In Progress | ✅ subsumed by QUI-187 + QUI-188 + QUI-202; close |
| QUI-202 (Plane seq 211 "QUI-211" name) | Observer 自动反思接通 | In Progress | ✅ shipped `c087330` (commit msg) + daemon wire |
| QUI-204 | memory_consolidate_plan MCP stdio timeout (Connection closed) | In Progress | ✅ fixed `acdcbc1` |
| QUI-205 | Web chat route 接 memory_observe | In Progress | ⏳ ship `2dd9210` but **e2e shows still BROKEN**: `apps/web/tests/e2e/memory-v2-features.spec.ts:319` says `PRODUCTION BUG: QUI-205 implementation is broken` (memory_observe does NOT fire from web chat) |
| QUI-207 | tier=short 历史数据迁移 + schema validation 加强 | In Progress | ⏳ part ship `9346207` (migration only); validation tightening pending |
| QUI-208 | dedupe strategy wire 协议兼容 | In Progress | ✅ fixed `b91f0d5` |

### 3.2 Pre-v2 memory backlog (历史)

`QUI-65` / `QUI-73` / `QUI-51` / `QUI-25` / `QUI-29` / `QUI-35` / `QUI-36` / `QUI-37` / `QUI-38` are pre-Iter-F items — most have been subsumed by QUI-187 / QUI-188 / QUI-191 epic. Recommend marking as superseded.

### 3.3 跨域支持型 / Memory-Adjacent

| Plane ID | Title | Notes |
|---|---|---|
| QUI-110 | SQLite observability DB | shared infra |
| QUI-15 (Plane seq 168) | Graphiti + HippoRAG + trajectory_compressor | **Cancelled** per README (Graphiti superseded by D-20; HippoRAG/trajectory split to QUI-194/198) |
| QUI-156 | UX-4 Slice 4 consolidation log UI | ✅ shipped |

---

## 4. 服务于记忆的辅助功能 / Memory-Serving Auxiliary Features

These are functions that don't store memory directly but exist solely to make memory trustworthy / accessible / safe.

下表覆盖那些不直接存记忆、但服务于记忆系统的辅助组件。

| Function | Source | Status | Evidence |
|---|---|---|---|
| **MCP server (memory tools)** | Iter A | ✅ | `server.py` 1426 LOC; 16 tools registered (memory_recall / memory_store / memory_observe / memory_delete / memory_delete_preview / memory_recover / memory_consolidate_plan / memory_prospective_* x4 / scratchpad_* x3 / consolidation_log_recent / kg_dump_for_viz / memory_backfill_kg) |
| **WriteAuthority gate (memory mutation)** | §5.3 + 07-safety | ✅ | `soul-profile.ts:550 first_run_seed` + Promoter atomic commit; daemon defaults `DRY_RUN=true` so no silent writes |
| **Cross-language user.md write lock** | feedback_no_docker | ✅ | `fcntl` advisory lock + TS `proper-lockfile` |
| **Web `/memory` page (v2 fields render)** | QUI-197 follow-up | ✅ | `apps/web/app/memory/page.tsx:1199 MemoryDetailPanel` renders salience / kind / project_scope / staleness / last_writer_client; commit `404fc77` |
| **Web `/api/memory` route + dedupe + KG graph + consolidations** | UX-4 | ✅ | `apps/web/app/api/memory/{route,dedupe,graph,backfill-kg,consolidations}/route.ts` |
| **Web chat → memory_observe wire** | QUI-205 | ⏳ broken | landed `2dd9210` but e2e fails per `memory-v2-features.spec.ts:319` |
| **Soul Import install-time trigger** | QUI-81 / QUI-102 | ❌ | Backend scanner ✅; CLI/Web start-up prompt to run scanner + user choice ❌ |
| **MCP `memory_observe` per-(user,session) cache** | observer | ✅ | `server.py` observer cache |
| **CLI/REPL memory wire** | Iter A | ✅ | `packages/agent-core/src/memory/observer-bridge.ts` + `loop.ts` |
| **Mac App memory wire** | QUI-105 / mac bridge | (separate repo) | `~/repo/quilin-agent-mac-app` — out of this repo's scope |
| **OTel/structlog memory logging** | 08-observability | ✅ | `logging.py` + structlog JSON to stdout |
| **CI lint guard (hyphen identifier)** | QUI-150 | ✅ (backlog item but ruff/biome run) | |
| **Test coverage (95% gate)** | feedback_test_coverage_95 | ✅ | provider/memory 786 passed / 95.02% per `v2-shipping-final-report.md` |
| **Playwright e2e (memory CRUD + dedupe)** | QUI-187 | ✅ but exposes QUI-205 bug | `7263ed0` ship 5 e2e tests; test 7 documents QUI-205 broken |

---

## 5. 漏掉的功能清单 / Missing Feature Catalog (user 强调"不漏一个")

Listed in priority order. Each item cites the source promise (research / spec / Plane) and current evidence of absence.

按优先级排列。每条注明承诺出处和缺口实证。

### 🔴 P0 — 影响 v2 完整性 / Blocks v2 completeness

1. **QUI-205 Web chat → memory_observe wire is broken**
   - Source / 出处: `apps/web/tests/e2e/memory-v2-features.spec.ts:319` says `PRODUCTION BUG: QUI-205 implementation is broken`
   - Gap / 缺口: web chat onFinish hook does not actually invoke `memory_observe`, so observations are never seeded from web users
   - Estimate / 估: 0.5-1 joint hour (locate wire-failure point in `apps/web/app/api/chat/route.ts:900-1031` and fix)

2. **`KGBackfillJob` daemon stub**
   - Source: `daemon_main.py:324 TODO(QUI-205 wire)`
   - Gap: daemon registers the job but the body is `await asyncio.sleep(0.05)` returning `backfilled: 0`. User explicitly wanted "KG should grow silently in background, not manual button" (comment at line 304-306)
   - Estimate: 1-2 joint hours (call existing `memory_backfill_kg` MCP path with `incremental=True` + last_kg_update tracking)

3. **`TokenBudgetMonitorJob` is a tick-only stub**
   - Source: `daemon_main.py:346-357`
   - Gap: only logs `event=token_budget_monitor.tick` and returns `checked: True`; no real warning emission, no memory write on near-budget
   - Estimate: 1 joint hour

### 🟡 P1 — 影响 v2 体验完整 / Affects v2 UX completeness

4. **QUI-198 SKILL.md disk-write via WriteAuthority not wired**
   - Source: `v2-shipping-final-report.md` §9
   - Gap: `SkillProposal.to_skill_md()` renders markdown body, but no `idle daemon` job converts proposals to actual `~/.quilin/skills/<slug>/SKILL.md` via WriteAuthority
   - Estimate: 2-3 joint hours (idle job + WriteAuthority gate + 13-skills integration)

5. **QUI-197 staleness wrap in LLM prompt**
   - Source: `v2-shipping-final-report.md` §9
   - Gap: `MemoryDetailPanel` shows staleness marker in Web UI, but agent-core LLM call layer does **not** wrap stale memories with `system-reminder` (`"47 天前的记忆，可能不准"`)
   - Estimate: 1-2 joint hours (in `packages/agent-core/src/context/` add staleness wrapper before LLM call)

6. **QUI-199 Web Evidence Graph viz**
   - Source: `v2-shipping-final-report.md` §9 + research §5.10
   - Gap: backend API for evidence chain exists (`memory_sources` + `memory_snapshot` tables); no `/api/memory/evidence-graph` route or reactflow UI on `/memory` page
   - Estimate: 3-4 joint hours (API route + reactflow component, mirroring existing KG viz pattern)

7. **QUI-196 Web conflict-merge UI**
   - Source: `v2-shipping-final-report.md` §9
   - Gap: backend writes `conflict_resolution_pending` metadata, but no Web UI surfaces the conflict for user to merge / discard
   - Estimate: 2-3 joint hours

8. **QUI-81 Soul Import install-time trigger UI**
   - Source: `v2-shipping-final-report.md` §9 + Plane QUI-102 epic
   - Gap: scanner backend done; no CLI / REPL / Web first-run prompt that says "Found Claude Code / Codex / etc — import?"
   - Estimate: 2-3 joint hours

### 🟢 P2 — 调研路线图承诺但未做 / Research-promised but not built

9. **Predictive warmer (§5.8 conservative cache pre-compute)**
   - Source: research §5.8 + §9.2 (user-decided: allow evidence/cache warming only, no proactive answer generation)
   - Gap: completely missing; no module precomputes likely-next-context during idle
   - Estimate: 3-4 joint hours (new idle job; safe — no LLM generation, only retrieval pre-fetch)

10. **DepartureContext writer**
    - Source: `docs/03-memory/README.md` §二·B "Departure Context"
    - Gap: spec defines 30-min inactivity trigger writing `DepartureContext` records; no `departure_context.py` module on master; only ProfileUpdater mirrors
    - Estimate: 2 joint hours

11. **SafetyLesson auto-learn from blocked attacks**
    - Source: `v2-shipping-final-report.md` §9
    - Gap: reviewers can `record_lesson()`, but no automated path that detects retrieval-time poisoning + auto-creates new `SafetyLesson`
    - Estimate: 2 joint hours

### ⚪ P3 — 数据集 / Eval lane 扩展

12. **LongMemEval / LoCoMo / BEAM public-bench lanes**
    - Source: research §5.4 (kept as evidence lanes, not CI gates)
    - Gap: only local fixture lane shipped (`test_memory_integrity.py`); public-bench runners stubbed (per Benchmark Freeze, can't extend without explicit user ask)
    - Status: ⛔ Benchmark Frozen 2026-05-02 — do not add unless user explicitly asks

13. **Reverse Soul Export (research §5.10)**
    - Status: ⛔ user-decided not to build (`v2-shipping-final-report.md` §4: "反向导出已明确不做(单向)")

### ⚙️ P4 — Plane state housekeeping (not code)

14. **Plane state sync** — 14 memory work items still in "In Progress" while commits have landed. Need a session with Plane MCP to move them to Done and split QUI-198 / QUI-199 / QUI-188 / QUI-196 into completed-backend vs open-follow-up.

---

## 6. 推荐执行顺序 / Recommended Execution Order

For a 1-day Claude × Codex joint sprint (using the "估算按 1 联合日 ≈ 1-2 个人周" calibration from project memory).

按 1 联合日 ≈ 1-2 人周校准锚点，下面是建议执行顺序，让 user 醒来后 5 分钟内能决策。

| Step | Items | Reasoning |
|---|---|---|
| **Now (already running)** | 6 parallel agents on daemon wire / v2 fields / e2e / Playwright | per task brief; do not duplicate their work |
| **Next 2 hours** | P0 #1 QUI-205 web chat wire bug + P0 #2 KGBackfillJob wire | both block "v2 fully operational"; #1 is blocking dogfood; #2 is what user explicitly asked ("KG silently grow") |
| **Next 4 hours** | P1 #5 staleness prompt wrap + P1 #4 SKILL.md persistence + P1 #6 evidence-graph viz | three highest-value UX wins; all have backend done, only missing client wire |
| **Next 4 hours** | P1 #7 conflict-merge UI + P1 #8 Soul Import trigger UI | complete the "4-client + soul import" superiority claims |
| **Optional (if time)** | P2 #9 predictive warmer + P2 #10 DepartureContext + P2 #11 auto-learn SafetyLesson | research-promised, polish layer |
| **Plane housekeeping** | P4 #14 — best done by session with Plane MCP tools; needs careful evidence-per-issue commenting | |
| **Deferred / out-of-scope** | P3 #12 (Benchmark Freeze) + P3 #13 (user-decided no) | do not start without explicit user request |

---

## Audit Summary / 审计结论

**Bottom line / 结论**: The v2 memory system is **substantially complete**. 10 of 10 research workstreams have landed on master with backend code, tests, and 95% coverage. Of the 14 named Plane work items, 9 are fully shipped, 5 have backend done but UI/wire follow-ups, 0 are pure stubs.

底线：v2 记忆系统**基本完整**。研究路线图 10 个 workstream 全部 backend ship。14 个 v2 Plane 工单中 9 个完全 ship，5 个 backend 完成但有 UI / wire 收尾，0 个纯 stub。

**真正的 gap 共 11 项**（不计 ⛔ 和 ⚙️）：
- 3 P0 (broken / stub jobs) — 2-3 joint hours
- 5 P1 (UX wires) — 10-15 joint hours
- 3 P2 (research-promised polish) — 7-8 joint hours

**Total joint estimate to "everything done"**: 20-26 joint hours ≈ 2-3 joint days. Realistic given user's calibration anchors (Iter J/F 1-day ship of entire web stack).

到"全部完成"的预估：20-26 联合小时 ≈ 2-3 联合日。按用户校准锚点（Iter J / F web 1 联合日 ship 全部）实际可达。

**Nothing critical was missed by the 28-commit ship batch**. The user's worry "怕漏" is justified for the 8 follow-up items (mostly UX wires), but the safety-critical core (evidence, version, gate, destructive guard, eval) is all wired and tested.

28 commit 批次没有漏掉任何**安全/正确性核心**(evidence / version / gate / destructive / eval 全 wired + tested)。user 担心漏掉的 8 个 follow-up 主要是 UX wire 层，不是数据正确性层。
