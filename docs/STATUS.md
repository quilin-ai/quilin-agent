# 当前状态 / Quilin Agent Status

This status snapshot was updated on 2026-05-18 / 本状态快照更新于 2026-05-18。

This file is the only global progress entry point under `docs/`. Component-level current facts live in each `docs/<component>/README.md`. Historical snapshots are traced through git history. Task management and backlog tracking live in Plane; this file keeps only current-state snapshots.

本文件是 `docs/` 下唯一的全局进度入口。组件级当前事实写在各 `docs/<component>/README.md`。历史快照通过 git history 追溯。任务管理与 backlog 统一迁移到 Plane；本文件只保留当前状态快照。

## 2026-05-21 完美记忆系统 v2 落地进度 / Perfect Memory System v2 Shipping Progress

实测速度修正:第一周 5/5 milestone 6 小时完成(原估 9-10 联合日),实际加速 **~10-15x**。原因:4 agent 并行(Claude 主线 + Codex 主线 + 各自 subagent)+ 严格 cross-review 无返工。

Speed correction (measured): Week 1 5/5 milestones shipped in 6 hours (estimated 9-10 joint-days), actual **~10-15x speedup**. Cause: 4-agent parallelism (Claude main + Codex main + their subagents) + strict cross-review with zero rework.

**已 ship(2026-05-21)**:

| Commit | 工单 | 范围 | LOC |
|---|---|---|---|
| `ab1f758` | QUI-192 + QUI-194 + 7 调研 docs | 完整性评测 + 安全检索门 + 1880 行调研 | 5126 |
| `414eb62` | QUI-189 + QUI-193 | 批量 LLM 整理 + 证据+版本链+时光回溯(8 字段 + 3 侧表) | 3062 |
| `767f52a` | QUI-22 | L3a working→episodic 自动升级(18 测试) | 1123 |
| `cf93af6` | QUI-198 | 操作步骤流水线 trajectory_compressor + skill_proposer(46 测试) | 1904 |
| `150c955` | Playwright fix | memory-crud-and-dedupe e2e 4 个 test code bug | 6 |
| **累计** | **6 工单** | 4 commit / 7000+ 行 / 95%+ coverage | **11221** |

**进行中**:
- ⏳ QUI-195 破坏防护(72h 软删 + 撤销 + 影响预览 + 历史快照事件流) — Codex 主线,已修 10 个 REAL,Reviewer I 找最新 legacy migration REAL 修中
- ⏳ QUI-188 quilin-daemon 持久后台服务 — Codex subagent 完成 8 测试,等 QUI-195 合 commit

**计划中**:
- 📋 QUI-196 多客户端 + 项目范围(第二周,等 QUI-195 schema)
- 📋 QUI-197 重要性多维 + 类型 + 过期感知(第三周,等 QUI-195 schema)
- 📋 QUI-199 前瞻 + 证据可视化 + 资源指针(第四周)
- 📋 QUI-200 SafetyLessonStore SQLite-backed(QUI-194 follow-up)

**Cross-review 投入**:
- 累计派出 **35+ reviewer subagent**(跨 6 个已 ship 工单 + QUI-195/188 进行中)
- 累计修过 **24+ REAL**(QUI-193 8 轮 12 REAL / QUI-195 10 轮 10 REAL / QUI-189 3 REAL / QUI-194 2 REAL / QUI-198 3 REAL / QUI-22 3 REAL)
- 严格执行硬规则:**连续 2 fresh × 0 REAL × 2** 才 commit

## 2026-05-21 完美记忆系统 v2 调研 + Roadmap / Perfect Memory System v2 Roadmap

用户原话："我要做一个能打爆所有竞品的记忆系统"。完成 **14 个竞品仓库**（mem0/letta/zep/mempalace/agentmemory/MemMachine/EverOS/gbrain/TencentDB/claude-mem/hermes-agent/codex/openclaw/claude-code）+ **24 篇论文** + **9 个评测榜**调研，Claude × Codex 双视角协商产出 unified roadmap。

User said: "I want a memory system that crushes all competitors." Completed survey of **14 competitor repos** + **24 papers** + **9 benchmarks**. Claude × Codex twin-perspective collaboration produced unified roadmap.

**调研产物（docs/research/）**:
- `agent-memory-systems-survey-2026-05-21.md`（315 行 unified report，含 HTML 可视化版）
- `competitor-analysis-codex.md`（205 行 Codex 视角）+ `external-survey-codex.md`（296 行）
- `quilin-mem-competitive-strategy-claude.md`（576 行 Claude 视角）+ `external-survey-claude.md`（494 行）
- `integration-feasibility-codex.md`（298 行 Codex 独立接入可行性 verify）

**Plane epic + 子工单**：
- **QUI-191** epic 完美记忆系统 v2（Backlog）
- 8 个新子工单 QUI-192 ~ QUI-199（详见 [docs/03-memory/README.md](03-memory/README.md) 顶部 v2 roadmap section）
- 复用 3 个既有：QUI-188 (idle daemon) + QUI-189 (batch judge) + QUI-190 (temporal-aware)
- Close 2 个：QUI-186（状态漂移→Done）+ QUI-15（Cancelled，Graphiti 部分 superseded by D-20，HippoRAG/trajectory 移到 QUI-194/198）

**Quilin 已超前业界 3 项**（14 竞品都没）：
1. WriteAuthority 全局门禁
2. 4 客户端共享记忆（命令行 / 终端 / 网页 / Mac App）
3. 灵魂导入（反向导出已明确不做）

**核心策略**：不为了层级而加层级，交付"受治理的记忆操作系统"— append-only evidence + actor-scoped provenance + 时态有效期 + 版本链 + soft-delete rollback + 检索 hybrid 且谨慎 + 后台智能通过 quilin-daemon 跑。

**预计工时**：~25-30 联合日（≈ 25-50 周个人开发）。落地顺序：第一周完整性评测 + 证据链 + 安全检索门 + 批量整理 → 第二周破坏防护 + 多客户端 → 第三周 quilin-daemon + 重要性多维 → 第四周+ 操作步骤流水线 + 前瞻+可视化。

## 2026-05-15/18 Iter F web 收尾 / Iter F web close-out

Iter F web/UX 整轮已完成。详细 ship 清单见 [`docs/STATUS-iter-F-autonomous-2026-05-15.md`](STATUS-iter-F-autonomous-2026-05-15.md)（含 commit hash 表）。本次收尾包含：

Iter F web/UX is fully closed out. Full ship list with commit hashes lives in [`docs/STATUS-iter-F-autonomous-2026-05-15.md`](STATUS-iter-F-autonomous-2026-05-15.md). This close-out covers:

- **Chat 持久化 / Chat persistence**：4 slice 全部完成（SQLite schema + read/write + 重启恢复 + DELETE + 原子 seq 分配 + localStorage 迁移）。
- **交互 primitives / Interaction primitives**：4 slice 全部完成（`ask_user_question` + `request_approval` Path A + `wrapToolWithApproval` Path B server-side gate（已 wrap `shell_exec`）+ `narrate_aside` 旁白工具 + TUI 原生 readline 集成）。spec 见 `docs/07-safety-guardrails/interaction-primitives-spec.md`（已标 ✅）。
- **UX-4 KG-based 记忆重做 / KG memory rebuild**：4 slice 全部完成（`kg_extractor.py` LLM 三元组抽取 + 反幻觉/反注入、`memory_backfill_kg` MCP 工具、`/api/memory/graph` endpoint + 知识图谱 reactflow viz、`consolidation_log` SQLite + timeline UI）。plan 见 `docs/03-memory/ux4-kg-rebuild-plan.md`（已标 ✅）。
- **热重载 / Hot reload**：MCP 服务 `.py` 源码 watcher、SKILL.md watcher、`~/.claude.json` watcher 全部 auto-invalidate tool catalog，且带 mid-flight defer 计数器避免子进程被中途 disconnect。
- **数据完整性 / Data integrity**：Task #14（user.md TS/Python 写 race 修复）+ Task #15（per-ask 128-bit capability token auth）+ Task #16（跨语言 file lock：Python fcntl + TS proper-lockfile）。
- **Profile self-evolution**：Task #12/#13 —— agent 自动把会话观察 append 到 user.md / soul.md，user.md 切换为纯 markdown（去 YAML frontmatter）。
- **UX-5 + UX-6 + 流式 UX**：Profile 文件查看器（user.md/soul.md/QUILIN.md），移动端 nav rail + composer safe-area，per-block streaming state（只有 trailing block 显示「正在输出」）。
- **Iter-close cross-review polish**：4 轮 cross-review，每轮 2 个 fresh subagent reviewer，共 7 fix（Skill watcher leak、LLM-controlled summary XSS 截断、mid-flight invalidate counter、abort listener accumulation、sync throw handling、subagent path wrap、dead try/catch cleanup）。Round 4 收敛（2 个新 reviewer 都报 0 REAL）。1 个 Round 3 报错（invalidate race）经实证为 false positive，rebuttal 写进 commit `f06d5ad` message。
- **稳定 3008 后端 / Stable 3008 backend**：`QUILIN_STABLE_BUILD=1` 触发 `distDir: .next-stable-3008/`，让 `pnpm build:stable-3008` 不再 clobber dev 的 `.next/`；同时修了 3 个 typed-routes `<Link href={...}>` build-time 错误。Mac app 测试用。

下一轮顺序（用户 2026-05-18 决策，见 [QUI-46](https://linear.app/quilin-agent/issue/QUI-46) comment）：Iter J 收尾 → Iter F web LOW（[QUI-157](https://linear.app/quilin-agent/issue/QUI-157)）→ Iter F Scale-Out runtime（[QUI-158](https://linear.app/quilin-agent/issue/QUI-158)/[QUI-159](https://linear.app/quilin-agent/issue/QUI-159)/[QUI-160](https://linear.app/quilin-agent/issue/QUI-160)）→ Iter G1 P0 三件套（[QUI-162](https://linear.app/quilin-agent/issue/QUI-162)/[QUI-163](https://linear.app/quilin-agent/issue/QUI-163)/[QUI-164](https://linear.app/quilin-agent/issue/QUI-164)）→ Iter L+0 EDD（[QUI-135](https://linear.app/quilin-agent/issue/QUI-135)）。

Next-iter order (user decision 2026-05-18, see [QUI-46](https://linear.app/quilin-agent/issue/QUI-46) comment): Iter J close-out → Iter F web LOW residual → Iter F Scale-Out runtime → Iter G1 P0 triple → Iter L+0 EDD.

## 2026-05-18 Iter J 收尾 / Iter J Ecosystem & Connectivity close-out

Iter J 5/5 全部 ship 到 master。14 个 commit 落地，18 轮 cross-review 收敛（其中 QUI-171 Stage 3 状态机走了 8 轮交叉审）。Anthropic + OpenAI 双 quota fresh reviewer 并行 30+ 次。

Iter J 5/5 fully shipped to master. 14 commits landed, 18 cross-review rounds converged (QUI-171 Stage 3 state machine took 8 rounds). 30+ fresh reviewer subagent invocations across Anthropic + OpenAI quotas.

| Issue | Commits | 内容 / Content |
|---|---|---|
| **[QUI-133](https://linear.app/quilin-agent/issue/QUI-133)** web_browse userinfo guard | `f53526f` | `<Link href="https://user:pass@...">` 凭证泄漏 fix + TC-06 e2e deterministic stub |
| **[QUI-166](https://linear.app/quilin-agent/issue/QUI-166)** MCP Stage 2 Prompts + Elicitation | `46bd315` + `15cd822` + `3625e9c` | client `prompts/list` + `prompts/get` + server-initiated elicitation + injection-scanner + url 白名单 + schema bounds + sha256-16 matchedText fingerprint + frozen array tamper guard |
| **[QUI-170](https://linear.app/quilin-agent/issue/QUI-170)** progressive disclosure + agentskills registry | `693a160` + `5edde63` + `a5eef44` | Jaccard-like skill chunk surfacing + agentskills.io client + SSRF/OOM guards (`url-guard.ts`) + verifier throw catch + fetchWithTimeout |
| **[QUI-104](https://linear.app/quilin-agent/issue/QUI-104)/[QUI-103](https://linear.app/quilin-agent/issue/QUI-103)** integrations detection skeletons | `6357bf8` + `7b34e3a` | GitHub Stars + X bookmarks + Obsidian + WeChat parser MVP（WeakMap-private token，无明文泄漏）—— 仅 detection 层，主体 watcher + LLM 分析 + 写记忆未做 |
| **[QUI-171](https://linear.app/quilin-agent/issue/QUI-171)** Quilin-as-server Stage 3 骨架 | `d2ec82a` + `83100d5` + `d41bc0b` + `51272b0` + `948e8e0` | stdio MCP server（不开 HTTP）暴露 4 工具 + 3 资源 + 白名单 enforcement + zod 入参 validation + 完整连接状态机（connect/close/onclose interleaving / failed transport cleanup / pending connect identity）+ peer 可控错误回显 C0+C1 控制字符过滤 |

QUI-103 / QUI-104 仅 detection 骨架 ship，整 issue 保持 Backlog 因为 watcher 主体 + LLM 分析 + 写记忆未做。其他 4 个 issue 已 Done。

QUI-103 / QUI-104 stay Backlog because only detection skeleton shipped; watcher + LLM analysis + memory-write paths remain pending. Other 4 issues marked Done.

Iter J 完整 ship 后 Iter J 项目下还剩 backlog issue：QUI-62 SandboxRouter（实质已落但 issue 仍是 In Progress，前期 Plane 状态滞后已修；现 Done）、QUI-102 Soul Import（独立大 issue，未碰），以及 QUI-133/166/170 的 follow-up 余项（HTTP transport / A2A federation / Skill signing 都是 Stage 4-5 范围）。

After Iter J close-out, Iter J project's residual backlog includes: QUI-62 SandboxRouter (substantively shipped earlier, status synced this round), QUI-102 Soul Import (large independent issue, not touched), and QUI-133/166/170 follow-up tails (HTTP transport / A2A federation / Skill signing are Stage 4-5 scope).

## 当前焦点 / Current Focus

Iter E（Benchmark Ascent，基准冲刺）is frozen as of 2026-05-02. Benchmark is now the lowest project priority, and no Iter may add or modify Benchmark code unless the user explicitly asks for Benchmark work.

截至 2026-05-02，Iter E（Benchmark Ascent，基准冲刺）已冻结。Benchmark 现在是全项目最低优先级；除非用户明确要求 Benchmark 工作，任何 Iter 都不得新增或修改 Benchmark 代码。

Existing Benchmark code remains part of the current repository state. It is not active roadmap scope: `benchmarks/` contains 62 tracked TS/Python source and test files under `src/` and `scripts/`, while `providers/memory/benchmarks/` contains the existing offline memory benchmark harness files. These files may be read as historical/current implementation evidence, but they are not a license to continue Benchmark implementation.

已有 Benchmark 代码仍是当前仓库状态的一部分，但不再是活跃路线图范围：`benchmarks/` 在 `src/` 和 `scripts/` 下有 62 个 TS/Python 源码与测试文件，`providers/memory/benchmarks/` 下有既有离线 memory benchmark harness 文件。这些文件可以作为历史/当前实现证据读取，但不能作为继续推进 Benchmark 实现的许可。

Current local evidence from 2026-05-07 commands:

2026-05-07 命令实证如下：

- `list_graph_stats_tool` reports 329 indexed files, 4,641 nodes, and 50,914 edges.
- `list_graph_stats_tool` 报告已索引 329 个文件、4,641 个节点、50,914 条边。
- `wc -l packages/agent-core/src/loop.ts` reports 452 LOC; the core loop has grown beyond the original `<200 LOC` contract, with the full loop system spanning `loop.ts` (452) + `loop-tool-calls.ts` (565) + `loop-types.ts` (85) = 1,102 LOC.
- `wc -l packages/agent-core/src/loop.ts` 报告 452 LOC；核心循环已超出最初 `<200 LOC` 契约，整个 loop 体系横跨 `loop.ts` (452) + `loop-tool-calls.ts` (565) + `loop-types.ts` (85) = 1,102 LOC。
- `rg --files packages/agent-core/src -g '*.ts' | wc -l` reports 258 TypeScript files.
- `rg --files packages/agent-core/src -g '*.ts' | wc -l` 报告 258 个 TypeScript 文件。
- `pnpm --dir packages/agent-core test` reports 129 test files and 1,711 tests, all passing.
- `pnpm --dir packages/agent-core test` 报告 129 个测试文件、1,711 个测试，全部通过。
- `pnpm --dir packages/agent-core exec tsc --noEmit --project tsconfig.json` exits cleanly.
- `pnpm --dir packages/agent-core exec tsc --noEmit --project tsconfig.json` 零错误退出。
- `rg --files providers/memory/src providers/memory/tests -g '*.py' | wc -l` reports 55 Python files.
- `rg --files providers/memory/src providers/memory/tests -g '*.py' | wc -l` 报告 55 个 Python 文件。
- `rg --files crates/mesh-sdk | wc -l` reports 3 Rust files/config entries.
- `rg --files crates/mesh-sdk | wc -l` 报告 3 个 Rust 文件/配置项。
- `rg --files benchmarks/src benchmarks/scripts -g '*.ts' -g '*.py' | wc -l` reports 62 Benchmark TS/Python source and test files.
- `rg --files benchmarks/src benchmarks/scripts -g '*.ts' -g '*.py' | wc -l` 报告 62 个 Benchmark TS/Python 源码与测试文件。
- `rg --files providers/memory/benchmarks | wc -l` reports 4 memory benchmark harness files.
- `rg --files providers/memory/benchmarks | wc -l` 报告 4 个 memory benchmark harness 文件。

### 2026-05-20 实证刷新 / 2026-05-20 Evidence Refresh

After Iter F web close-out (2026-05-15) and Iter J 5/5 close-out (2026-05-18), the working tree at commit `dfe85ad` (2026-05-18 19:45) shows the following deltas relative to the 2026-05-07 snapshot:

经过 Iter F web 收尾（2026-05-15）与 Iter J 5/5 收尾（2026-05-18），当前工作树（commit `dfe85ad`，2026-05-18 19:45）相对 2026-05-07 快照的差异如下：

- `rg --files packages/agent-core/src -g '*.ts' | wc -l` reports **405** TypeScript source files (up from 258, +57%).
- `rg --files packages/agent-core/src -g '*.ts' | wc -l` 报告 **405** 个 TypeScript 源文件（原 258 个，+57%）。
- `rg --files packages/agent-core -g '*.test.ts' | wc -l` reports **186** test files (up from 129, +44%).
- `rg --files packages/agent-core -g '*.test.ts' | wc -l` 报告 **186** 个测试文件（原 129 个，+44%）。
- `wc -l packages/agent-core/src/loop.ts + loop-tool-calls.ts + loop-types.ts` reports **1,198** LOC (517 + 565 + 116, up from 1,102).
- `wc -l packages/agent-core/src/loop.ts + loop-tool-calls.ts + loop-types.ts` 报告 **1,198** LOC（517 + 565 + 116，原 1,102）。
- `rg --files providers/memory/src providers/memory/tests -g '*.py' | wc -l` reports **62** Python files (up from 55).
- `rg --files providers/memory/src providers/memory/tests -g '*.py' | wc -l` 报告 **62** 个 Python 文件（原 55 个）。
- `rg --files crates -g '*.rs' -g 'Cargo.toml' | wc -l` reports **7** entries: `mesh-sdk` (3) + new **`quilin-bridge`** (4: `Cargo.toml`, `src/lib.rs`, `src/supervisor.rs`, `src/bin/uniffi-bindgen.rs`). The Mac-native bridge is currently `untracked` in git; tracking issue is [QUI-179](https://plane.so/quilin-agent/projects).
- `rg --files crates -g '*.rs' -g 'Cargo.toml' | wc -l` 报告 **7** 个条目：`mesh-sdk`（3）+ 新增 **`quilin-bridge`**（4 个文件：`Cargo.toml`、`src/lib.rs`、`src/supervisor.rs`、`src/bin/uniffi-bindgen.rs`）。Mac 原生桥目前在 git 中是 `untracked` 状态，跟踪 issue 为 [QUI-179](https://plane.so/quilin-agent/projects)。
- `git log --since='30 days ago' --oneline | wc -l` reports **538** commits in the last 30 days.
- `git log --since='30 days ago' --oneline | wc -l` 报告过去 30 天共 **538** 个 commit。
- `benchmarks/` and `providers/memory/benchmarks/` file counts are unchanged (62 + 4), consistent with the Benchmark freeze.
- `benchmarks/` 与 `providers/memory/benchmarks/` 文件数量保持不变（62 + 4），与基准冻结一致。

The growth concentrates in Iter F web (chat persistence + interaction primitives + UX-4 KG rebuild + hot reload) and Iter J (MCP Stage 2 + progressive disclosure + integrations detection + Quilin-as-server Stage 3 skeleton). The `<200 LOC` Core Loop contract is now formally broken; loop体系 spans 1,198 LOC across 3 files.

增长集中在 Iter F web（聊天持久化 + 交互 primitives + UX-4 KG 重做 + 热重载）与 Iter J（MCP Stage 2 + 渐进披露 + integrations detection + Quilin-as-server Stage 3 骨架）。`<200 LOC` Core Loop 契约正式被打破；整个 loop 体系横跨 3 个文件，共 1,198 LOC。

Planning artifacts not previously indexed in this STATUS or in component READMEs:

之前未在本 STATUS 与组件 README 中索引的规划产物：

- `docs/research/2026-05-13-sota-survey/` — 2026-05 SOTA 调研集合（前沿 agent 项目对照）。Git 状态：`untracked`。
- `docs/research/2026-05-13-sota-survey/` — 2026-05 SOTA research collection (frontier agent project comparison). Git status: `untracked`.
- `docs/research/2026-05-18-quilin-as-server/` — Quilin 作为 MCP server 的 Stage 3 设计调研，对应 QUI-171。Git 状态：已 tracked，但尚未在 STATUS 中索引。
- `docs/research/2026-05-18-quilin-as-server/` — Quilin-as-MCP-server Stage 3 design research, paired with QUI-171. Git status: tracked, but not previously indexed in STATUS.
- `crates/quilin-bridge/` — **Mac 客户端连接 agent server 的 Rust↔Swift 桥**（UniFFI 0.28 生成 Swift 绑定），编译成 `libquilin_bridge.dylib` 后链接进独立仓库 `~/repo/quilin-agent-mac-app`（Mac UI 壳，开发中）。Mac 客户端在架构上和 web 客户端等价：都是壳，都连同一个 quilin-agent server。当前 git 中尚未提交：`Cargo.toml` 已加 `quilin-bridge` 进 workspace `members`（未提交修改），`Cargo.lock` 已多 ~670 行 UniFFI 依赖链（未提交修改），`crates/quilin-bridge/` 源码目录尚未 `git add`。方向已收敛为正式入库（不是实验），由 [QUI-179](https://plane.so/quilin-agent/projects) 跟踪 commit 时机与 09 Deployment Runtime 文档章节安排。
- `crates/quilin-bridge/` — **Rust↔Swift bridge connecting the Mac client to the agent server** (UniFFI 0.28 generates the Swift binding), compiled to `libquilin_bridge.dylib` and linked into the separate repo `~/repo/quilin-agent-mac-app` (Mac UI shell, in development). The Mac client is architecturally peer with the web client: both are thin shells connecting to the same quilin-agent server. Not yet committed to git: `Cargo.toml` has `quilin-bridge` added to workspace `members` (uncommitted change), `Cargo.lock` has ~670 lines of UniFFI dependency chain (uncommitted change), `crates/quilin-bridge/` source tree is not yet `git add`-ed. Direction has converged to formal inclusion (not exploration); [QUI-179](https://plane.so/quilin-agent/projects) tracks commit timing and the 09 Deployment Runtime documentation section.

Plane has been updated to match this freeze: the `Iter E 基准冲刺 / Benchmark Ascent` project is `Canceled` and `Low`; unfinished Benchmark issues `QUI-6`, `QUI-7`, `QUI-8`, `QUI-43`, `QUI-47`, and `QUI-70` are `Canceled` and `Low`. The available Plane MCP exposes cancel/update rather than hard-delete, so cancellation is the active-queue removal mechanism used for this session.

Plane 已同步这次冻结：`Iter E 基准冲刺 / Benchmark Ascent` project 已标记为 `Canceled` 与 `Low`；未完成 Benchmark issue `QUI-6`、`QUI-7`、`QUI-8`、`QUI-43`、`QUI-47`、`QUI-70` 已标记为 `Canceled` 与 `Low`。本 session 可用的 Plane MCP 暴露 cancel/update 而不是 hard-delete，因此本次用取消作为移出活跃队列的机制。

## 迭代状态 / Iteration State

| Iter | 状态 | 当前含义 | 证据 |
|---|---:|---|---|
| Phase 0 PoC | closed | Agent Loop + quilin-mem MCP + REPL baseline，v0.0.3。 | `packages/agent-core/src/loop.ts` + `providers/memory/src/quilin_mem/server.py` |
| Iter A Grounded Context | closed | Context assembly、prompt builder、temporal awareness、memory bridge，v0.1.0-iter-a。 | `docs/02-context/README.md` |
| Iter B Tools + Skills + Safety | closed | Tool substrate、READ-ONLY default safety policy、Skills M0/M1 activation。 | `docs/05-tool/README.md` + `docs/13-skills/README.md` + `docs/07-safety-guardrails/README.md` |
| Iter C Planning Core | closed | Planning + inference strategy，与 memory 抽离并行完成。 | `docs/04-planning/README.md` |
| Iter M Memory | closed | quilin-mem 主体切片完成；L3a observer 仍 blocked/deferred。 | `docs/03-memory/README.md` |
| Iter D Operability | closed | Observability、config、scratchpad、Rust `mesh-sdk` stub、CI 和 coverage gate。 | `docs/08-observability/README.md` + `crates/mesh-sdk/Cargo.toml` |
| Iter E Benchmark Ascent | frozen / canceled | Existing code remains in-tree; all unfinished Benchmark planning and implementation work is canceled in Plane. | `docs/14-benchmark-harness/README.md` + `QUI-6` / `QUI-7` / `QUI-8` / `QUI-43` / `QUI-47` / `QUI-70` |
| Iter F0 Frontier Assimilation | closed | 2026-05 前沿调研吸收完毕，可执行的方向已拆到具体 Iter F+ / G / H / I / J 实现 issue。 | Plane `Iter F0：前沿方案吸收` project (completed 2026-05-07) |
| Iter F web/UX 收尾 | closed | Chat 持久化 + 交互 primitives + UX-4 KG + 热重载 + iter-close polish + stable 3008 build。33+ commit、4 轮 cross-review 收敛 0/0、tsc 0 / vitest 414 全过。 | `docs/STATUS-iter-F-autonomous-2026-05-15.md` + commits `5ec2192`..`9d65c6a` |
| Iter F Scale-Out runtime | open / 下一轮主攻 | 非阻塞 Supervisor、Agent Mesh runtime、Context production gates 仍是 backlog。 | [QUI-158](https://linear.app/quilin-agent/issue/QUI-158) + [QUI-159](https://linear.app/quilin-agent/issue/QUI-159) + [QUI-160](https://linear.app/quilin-agent/issue/QUI-160) |
| Iter J 生态与连接 | 5/5 收尾 2026-05-18 | 本轮目标 5 个 worktree 全 ship（web_browse userinfo / MCP Stage 2 client / progressive disclosure + registry / integrations 骨架 / Quilin-as-server Stage 3 骨架）。18 轮 cross-review，QUI-171 走了 8 轮。SandboxRouter (QUI-62) 早期已 ship。 | 见上方 `2026-05-18 Iter J 收尾` 段落含 commit hash |

| Iter | Status | Current Meaning | Evidence |
|---|---:|---|---|
| Phase 0 PoC | closed | Agent Loop + quilin-mem MCP + REPL baseline, v0.0.3. | `packages/agent-core/src/loop.ts` + `providers/memory/src/quilin_mem/server.py` |
| Iter A Grounded Context | closed | Context assembly, prompt builder, temporal awareness, memory bridge, v0.1.0-iter-a. | `docs/02-context/README.md` |
| Iter B Tools + Skills + Safety | closed | Tool substrate, READ-ONLY default safety policy, Skills M0/M1 activation. | `docs/05-tool/README.md` + `docs/13-skills/README.md` + `docs/07-safety-guardrails/README.md` |
| Iter C Planning Core | closed | Planning + inference strategy, completed alongside memory decoupling. | `docs/04-planning/README.md` |
| Iter M Memory | closed | Main quilin-mem slices completed; L3a observer remains blocked/deferred. | `docs/03-memory/README.md` |
| Iter D Operability | closed | Observability, config, scratchpad, Rust `mesh-sdk` stub, CI, and coverage gate. | `docs/08-observability/README.md` + `crates/mesh-sdk/Cargo.toml` |
| Iter E Benchmark Ascent | frozen / canceled | Existing code remains in-tree; all unfinished Benchmark planning and implementation work is canceled in Plane. | `docs/14-benchmark-harness/README.md` + `QUI-6` / `QUI-7` / `QUI-8` / `QUI-43` / `QUI-47` / `QUI-70` |
| Iter F0 Frontier Assimilation | closed | 2026-05 frontier research assimilated; actionable directions split into concrete Iter F+/G/H/I/J implementation issues. | Plane `Iter F0：前沿方案吸收` project (completed 2026-05-07) |
| Iter F web/UX close-out | closed | Chat persistence + interaction primitives + UX-4 KG + hot reload + iter-close polish + stable 3008 build. 33+ commits, 4 cross-review rounds converged 0/0, tsc 0 / 414 vitest pass. | `docs/STATUS-iter-F-autonomous-2026-05-15.md` + commits `5ec2192`..`9d65c6a` |
| Iter F Scale-Out runtime | open / next focus | Non-blocking supervisor, Agent Mesh runtime, Context production gates remain backlog. | [QUI-158](https://linear.app/quilin-agent/issue/QUI-158) + [QUI-159](https://linear.app/quilin-agent/issue/QUI-159) + [QUI-160](https://linear.app/quilin-agent/issue/QUI-160) |
| Iter J Ecosystem & Connectivity | 5/5 close-out 2026-05-18 | All 5 targeted worktrees shipped (web_browse userinfo / MCP Stage 2 client / progressive disclosure + registry / integrations detection skeletons / Quilin-as-server Stage 3 skeleton). 18 cross-review rounds total, QUI-171 took 8 rounds. SandboxRouter (QUI-62) shipped earlier. | See `2026-05-18 Iter J 收尾` section above for commit hashes |

## 基准冻结 / Benchmark Freeze

The frozen Benchmark implementation surface is: dataset loading, runner/scorer/submission wiring, DockerSandbox slices, GAIA/BFCL/SWE-bench loaders, and memory-provider offline benchmark scripts. These are preserved as current code facts, not active work items.

已冻结的 Benchmark 实现面包括：数据集加载、runner/scorer/submission wiring、DockerSandbox 切片、GAIA/BFCL/SWE-bench loader，以及 memory provider 的离线 benchmark scripts。它们保留为当前代码事实，不再是活跃工作项。

| Unit | 状态 | 当前处理 | 证据 |
|---|---:|---|---|
| E1 Harness Infra | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E2 SWE-bench Verified + DockerSandbox | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3a GAIA validation loader/scorer | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3b BFCL AST slice | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3c1a BFCL multi-turn fixture | historical closed | Existing code remains; no new work. | `docs/14-benchmark-harness/README.md` |
| E3c1b1 BFCL stateful worker | `QUI-5` done; `QUI-6` canceled | No R2 or follow-up unless user asks. | `QUI-5` / `QUI-6` |
| E3c1b2 BFCL runner adapter | `QUI-7` canceled | Do not implement unless user asks. | `QUI-7` |
| Coding benchmark target | `QUI-47` / `QUI-70` canceled | Do not choose or implement replacement unless user asks. | `QUI-47` / `QUI-70` |
| E4 aspirational benchmarks | `QUI-8` canceled | Do not reassess unless user asks. | `QUI-8` |

## 2026-05-02 组件规划快照 / 2026-05-02 Component Planning Snapshot

The latest Plane migration and component planning sweep produced bilingual deferred-runtime plans across the main component families. The purpose of these files is to define runtime boundaries, trigger gates, and evidence requirements; they are not proof that every runtime path has landed.

最新一轮 Plane 迁移与组件规划整理，已经为主要组件族产出中英双语 deferred-runtime plans（延后运行时规划）。这些文件的用途是定义运行时边界、触发门槛和证据要求；它们不是所有运行时代码都已落地的证明。

Current planning artifacts include LLM provider production gates, Context relevance/compression gates, Memory observer and depth gates, Planning production routing gates, Tools runtime gates, Multi-Agent supervisor gates, Safety production threat-model gates, Observability trace/evaluation-data gates, Deployment runtime gates, Self-Evolution trajectory-to-patch gates, Agent Mesh deferred runtime gates, Skills runtime/platformization gates, Conversation Engineering restart gates, and the Iter F launch gate.

当前规划产物覆盖 LLM provider（模型供应商）生产门槛、Context（上下文）相关性/压缩门槛、Memory（记忆）观察器与深记忆门槛、Planning（规划）生产路由门槛、Tools（工具）运行时门槛、Multi-Agent（多 Agent）监督者门槛、Safety（安全）生产威胁模型门槛、Observability（可观测性）trace/evaluation-data（追踪/评估数据）门槛、Deployment（部署）运行时门槛、Self-Evolution（自进化）trajectory-to-patch（从运行轨迹生成补丁建议）门槛、Agent Mesh（Agent 互联）延后运行时门槛、Skills（技能）运行时/平台化门槛、Conversation Engineering（对话工程）重启门槛，以及 Iter F 启动门槛。

The cross-review posture is now: benchmark（standardized capability evaluation，标准化能力评测）is frozen for code work unless the user asks, and component readiness must be proven with local evidence first.

交叉复核口径现在是：除非用户明确要求，Benchmark 代码工作已冻结；组件就绪必须先用本地实证证明。

## 组件状态 / Component State

| 组件 | 状态 |
|---|---|
| [00 Core Loop](00-core-loop/README.md) | 自研 TS loop 体系 1,198 LOC（`loop.ts` 517 + `loop-tool-calls.ts` 565 + `loop-types.ts` 116，2026-05-20 实证）；实时追加输入、`/resume` + `/resume latest` 会话恢复、auto-checkpoint recovery 已实现；hook 体系（onTurnComplete/onIdle/onToolResult/onAssistantMessage）完善。 |
| [01 LLM Integration](01-llm-integration/README.md) | AI SDK v6 client、`ThinkingMode`、provider-aware options、reasoning/tool stream extraction、cache usage basics 已实现；DeepSeek 全链路完整；Provider live matrix 已实现（API Key/OAuth 凭证状态，脱敏）；Anthropic/OpenAI/Gemini provider 均为 blocked/candidate。 |
| [02 Context](02-context/README.md) | Prompt/session assembly、token budgeting、temporal awareness、memory bridge、injection scanner、skills catalog/restore wiring、compression、cache stability、Conversation Engineering 6 层架构 + 7 种预设风格已实现。 |
| [03 Memory](03-memory/README.md) | quilin-mem MCP（断连自动重连）、四层 memory、SQLite/FTS5+Bun 内置后端、KG/vector retrieval hooks、profile store、scratchpad、consolidator auto_schedule、L3a observer（flash 驱动）激活、user.md 自动同步。**2026-05-15 新增**：UX-4 KG 重做 4 slice 全 ship（`kg_extractor.py` LLM 三元组抽取 + `memory_backfill_kg` MCP + `/api/memory/graph` reactflow viz + `consolidation_log` SQLite + timeline UI），`memory_delete` 工具供 agent 清理重复记忆，profile self-evolution（user.md/soul.md 自动追加观察）+ 纯 markdown 迁移 + 跨语言 file lock（fcntl + proper-lockfile）。 |
| [04 Planning](04-planning/README.md) | Main-LLM direct planning + audit/strategy contracts 已实现；tiny classifier 不是默认路径。 |
| [05 Tool](05-tool/README.md) | 10 built-in tools（file_read/write/list、shell_exec（sandbox auto/on/off）、web_fetch、skill_search（remote）、skill_view、skill_manage（merge）、image_describe、video_summarize、audio_transcribe、mcp_search）、MCP bridge、DockerSandbox（auto-detect + executeAuto）。**2026-05-15 新增**：MCP 服务 `.py` 源码 / SKILL.md / `~/.claude.json` 三类 watcher 全部 auto-invalidate tool catalog，且带 mid-flight defer 计数器避免子进程被中途 disconnect；交互 primitives 4 个 LLM-callable 工具（`ask_user_question`、`request_approval` Path A、`narrate_aside`、`wrapToolWithApproval` Path B server-side gate（已 wrap `shell_exec`）；SandboxRouter contracts + DockerSandbox adapter Done (QUI-62)。 |
| [06 Multi-Agent](06-multi-agent/README.md) | InProcessSupervisorRuntime 已实现：子 Agent 生命周期（append/send/interrupt/pause/resume/cancel）、heartbeat/stale 检测、recovery context 保留、`/agents` REPL 展示；mesh 分布式是后续。 |
| [07 Safety Guardrails](07-safety-guardrails/README.md) | auto 默认模式（低中风险自动批）、`--yolo` 全自动、四级 WriteAuthority（auto/ask/yolo/read_only）、ActionVerifier、MetaVerifier、secret redaction、SSRF guard。**2026-05-15 新增**：交互 primitives wire-driven WriteAuthority（升级 readline-only → 跨前端 web/TUI 统一）；Path B server-side gate `wrapToolWithApproval` 已 wrap `shell_exec`，per-session 白名单（high/critical 永不可白名单化）、per-ask 128-bit capability token auth（task #15）、defensive truncate（MAX_SUMMARY=1000, MAX_DETAIL=4000）。spec 见 `docs/07-safety-guardrails/interaction-primitives-spec.md`（已 ✅）。 |
| [08 Observability](08-observability/README.md) | Span/Metrics/Logs、Prometheus、JSON file exporter、SQLite 持久化 observability DB、Web Dashboard（/dashboard HTML 看板 + Web Chat）、Control Plane API（/snapshot、/sessions、/traces）。 |
| [09 Deployment Runtime](09-deployment-runtime/README.md) | CLI（`quilin config show/set/service install`）、TOML config cascade、hot reload、first-run welcome、`/resume` + `/resume latest`、`/mcp`、systemd/launchd 开机自启、soul.md/user.md 配置文件。 |
| [10 Self-Evolution](10-self-evolution/README.md) | `self-evolution/` 14 个 TS 文件已落地（trajectory-store / failure-analyzer / patch-proposal / proposal-store / offline-optimizer / sanitize / jsonl-path / hash），`skill_manage` + WriteAuthority、ProfileStore/Updater、idle runner（每日配额控制）已就绪；🚧 Offline Optimizer 仍为 `local-noop`，**完整 trajectory→patch→人工审核闭环尚未串通**（基础设施已就绪，人工审核环节待接，见 QUI-12 / QUI-94），idle_evolution 运行时激活待验证。以 docs/10-self-evolution/README.md 自评为准。 |
| [11 Agent Mesh](11-agent-mesh/README.md) | Rust `crates/mesh-sdk` stub + CI wiring 已实现；runtime mesh 是 Iter F。 |
| [13 Skills](13-skills/README.md) | SKILL.md catalog、`skill_view`、CRUD + merge、guard、restore、watcher、`skill_search`（本地+远程 skills.sh）、provenance 签名验证已闭合到 M2。**2026-05-15 新增**：dev mode 下 SKILL.md 编辑 auto-watch + 自动 invalidate web 端 tool catalog（`QUILIN_SKILL_HOT_RELOAD=off` 可关）；iter-close polish 修复了旧 SkillsManager 监听器在 rebuild 时不释放的内存泄漏（`f06d5ad`）。 |
| [14 Benchmark Harness](14-benchmark-harness/README.md) | Existing harness code remains in-tree; component is frozen/read-only for future implementation unless the user asks. |
| [15 Introspection](15-introspection/README.md) | Step 2 设计文档已落地（Iter L+3，QUI-151 总入口）；元思考 / 反思链路尚未实现，spec 作为实施前 review gate。 |
| [16 Soul Import](16-soul-import/README.md) | Bilingual spec 已落地（2026-05-12）；6 框架扫描 + QUILIN.md 生成器 + body 填充由 [QUI-102](https://linear.app/quilin-agent/issue/QUI-102) 承接，artifact schema 已由 QUI-108 / `soul-profile.ts` 实现（`1d57d08`）。 |
| [17 Multi Client](17-multi-client/README.md) | 4 个客户端壳的现状快照（2026-05-20 新增）：**CLI**(`quilin` 命令)~85%、**REPL TUI**(`packages/agent-core/src/repl.ts` + slash 命令 + 交互 primitives 集成) ~80%、**Web**(`apps/web/` Next.js，8 API route + 7 page + Playwright E2E + SQLite chat 持久化 + UX-4 KG viz) ~80%、**Mac App**(独立仓库 `~/repo/quilin-agent-mac-app/`，SwiftUI + UniFFI + `crates/quilin-bridge/`) ~15%。所有壳共享同一个 agent server，通过 stdio MCP / HTTP / SSE / UniFFI FFI 连接。跟踪 [QUI-181](https://plane.so/quilin-agent/projects)。 |

## 任务追踪 / Task Tracking

Plane is the task-management source. Docs only keep current-state snapshots and architecture facts.

Plane 是任务管理源；docs 只保留状态快照与架构事实。

- Frozen Iter E: Plane project [Iter E 基准冲刺 / Benchmark Ascent](https://linear.app/quilin-agent/project/iter-e-benchmark-ascent-110aa1c9aae3) is canceled and low priority.
- 已冻结 Iter E：Plane project [Iter E 基准冲刺 / Benchmark Ascent](https://linear.app/quilin-agent/project/iter-e-benchmark-ascent-110aa1c9aae3) 已取消并降为低优先级。
- Runtime scale-out governance: Plane project [Iter F 规模化 / Scale-Out](https://linear.app/quilin-agent/project/iter-f-scale-out-8731e6ced529) remains the broad future lane, with Benchmark code frozen unless requested.
- Runtime scale-out 治理：Plane project [Iter F 规模化 / Scale-Out](https://linear.app/quilin-agent/project/iter-f-scale-out-8731e6ced529) 仍是宽泛后续通道；除非用户要求，Benchmark 代码冻结。
- Verification baseline: Plane project [验证基线：前沿证据包 / Verification Baseline: Frontier Evidence Pack](https://linear.app/quilin-agent/project/验证基线前沿证据包-verification-baseline-frontier-evidence-pack-6babd4eb3b39) is low priority while Benchmark lanes are frozen.
- 验证基线：Plane project [验证基线：前沿证据包 / Verification Baseline: Frontier Evidence Pack](https://linear.app/quilin-agent/project/验证基线前沿证据包-verification-baseline-frontier-evidence-pack-6babd4eb3b39) 在 Benchmark lane 冻结期间为低优先级。
- Execution logging discipline: Plane [QUI-78](https://linear.app/quilin-agent/issue/QUI-78/流程所有执行空闲探索与交叉-review-必须记录到-linear-require-linear-records-for-execution) requires main-agent and subagent implementation, research, review, and exploration work to be recorded in Plane first; research results must also land in relevant component docs.
- 执行记录纪律：Plane [QUI-78](https://linear.app/quilin-agent/issue/QUI-78/流程所有执行空闲探索与交叉-review-必须记录到-linear-require-linear-records-for-execution) 要求主 agent / subagent 的实现、调研、review、探索都先记录到 Plane；调研结果还要落到相关组件 docs。
- Plane free-plan budget discipline: the current Plane free plan allows at most 250 issues; follow-up sub-tasks, subagent logs, probes, and reviews should use comments on existing issues first. Do not bulk-create near 200 issues, and do not create new issues after 225 without explicit user approval.
- Plane 免费额度纪律：当前 Plane 免费版最多 250 个 issue；后续子任务、subagent 日志、调研记录和 review 优先写到已有 issue 的 comment，达到 200 个 issue 前不做批量新建，达到 225 个 issue 后未经用户明确批准不再新建。
- Component-level deferred work: Plane project [组件延后工作 / Component Deferred Work](https://linear.app/quilin-agent/project/component-deferred-work-922b3c51ce07)
- 组件级 deferred work：Plane project [组件延后工作 / Component Deferred Work](https://linear.app/quilin-agent/project/component-deferred-work-922b3c51ce07)
- Global future roadmap: Plane project [未来规划总览 / Global Roadmap](https://linear.app/quilin-agent/project/未来规划总览-global-roadmap-58896094ed5c)
- 全局未来规划：Plane project [未来规划总览 / Global Roadmap](https://linear.app/quilin-agent/project/未来规划总览-global-roadmap-58896094ed5c)
