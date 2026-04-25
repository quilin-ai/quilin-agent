# Iter E3 — GAIA + BFCL v4 Day 0

> **状态**: Day 0 spike 待开工（autonomous mode）
> **日期**: 2026-04-26
> **owner**: Quilin Agent 团队
> **前置**:
> - Iter E1 ✅（best-effort guard + plan §17 残余归属稳定）
> - Iter E2 ✅（DockerSandbox MVP + Verified loader + R1-R4 review chain：commits `7ae93d7` → `4cd94b5`）
> - ADR-010 v3 dataset enum 扩展为 `swe-bench-lite | swe-bench-verified | gaia | bfcl-v4`（本 plan 同 commit 修订）

本计划开 Iter E3，覆盖 plan §Iteration E §E3 列出的两个 pinned leaderboard。复用 Iter E1/E2 已落地的 runner / DockerSandbox / cache / scorer registry / submission registry，**不**新增 runner 实现，只加两个 dataset loader + 两个 scorer + 两个 submission adapter。

---

## 0. 实证基线

### 0.1 入场状态（HEAD `4cd94b5`）

- 分支：`master`；工作树：本计划 + ADR-010 §3.1 修订 untracked，待本轮提交；其他 clean
- 依赖：Iter E1/E2 全部 land，benchmarks 198 tests / Branches 95.81% / strict 95.45% / local 95.63% / `just test-all` 三语言绿 / AMB p95 ≤ 300ms / Docker smoke macOS structured skip / Linux CI smoke gate fail-closed 已生效
- Iter E2 review chain 闭合：R1-R4 共 4 轮独立 subagent + 主线 reconcile
- 复用：runner 5 阶段生命周期；DockerSandbox MVP（`--network none` + 4 类 mount + timeout cleanup + 16MB output cap）；cache sha256 manifest + `requested_max_rows` partial-vs-full 区分；scorer/submission registry；fetch CLI HF endpoint allowlist + `--unsafe-rows-base-url` test-only escape

### 0.2 进度记录区

| 轮次 | 任务 | 状态 | commit | 实证 |
|---|---|---|---|---|
| Day 0 | 本 plan + ADR-010 §3.1 enum 扩 `gaia` + `bfcl-v4` | ⏳ 本轮待 commit | — | — |
| Iter E3 第一轮 | GAIA loader + scorer + submission adapter；BFCL v4 loader + scorer + submission adapter | ⏳ 待启动 | — | spike 后启动 |
| Iter E3 review | R1 独立 subagent + 主线 reconcile | ⏳ 待启动 | — | 第一轮收口后 |
| Iter E3 收口 | review chain 闭合 + DockerSandbox 内 GAIA/BFCL smoke 通过 + 95% 覆盖率 + just test-all 三语言绿 | ⏳ 待启动 | — | review 通过后 |

---

## 1. 当前共识

- **不新增 runner / sandbox**：复用 E2 的 DockerSandbox MVP；GAIA/BFCL 任务 5 阶段走同一 lifecycle
- **每 leaderboard 独立 scorer + adapter**：scorer registry / submission registry 已稳定，新增不影响既有
- **dataset 枚举严格对齐 ADR-010 §3.1**：4 值 literal union；新加要修 ADR
- **Memory 降级延续**：per-task working set + FTS5；不用 4 层 OmniMem（同 E2）
- **GAIA submission**：HuggingFace `gaia-benchmark/leaderboard` 接受 jsonl `{task_id, model_answer, reasoning_trace}`（spike 时核实最新格式）
- **BFCL v4 submission**：BFCL 官方 GitHub eval 接受 csv/jsonl `{id, model, model_response}`（spike 时核实）

---

## 2. 不做事项

- 不在 Iter E3 实现 LocalSandbox / CloudSandbox（仍 defer Iter F）
- 不实现 OmniMem 4 层（仍 §E2 决议）
- 不启动 E4 aspirational benchmark
- 不在本 Iter 修改 runner / sandbox / wire schema 顶层契约（除 dataset enum 扩 4 值）
- 不引入新的 cost-tracking 或 OTel attribute（复用 Iter D ADR-008）

---

## 3. Day 0 spike（本轮启动前必出）

派给 Codex 主线 spike 报告，落点 `docs/research/2026-04-26-02-gaia-bfcl-spike.md`：

1. **GAIA dataset 结构**：HuggingFace `gaia-benchmark/GAIA` validation 子集；level 1/2/3 任务比例；file_attachments 处理（多模态 + 文件）
2. **BFCL v4 dataset 结构**：BFCL 官方 GitHub `gorilla-llm/Berkeley-Function-Calling-Leaderboard` v4 任务类型（single function / multi function / parallel / multi-turn / live）；任务格式
3. **GAIA scorer**：exact-match 还是 LLM-as-judge？官方要求是哪个？
4. **BFCL scorer**：多种任务类型如何统一打分（结构化 tool call AST 比对）
5. **submission 格式**：两个 leaderboard 各自的官方 submission 包结构 + 上传 endpoint（GAIA HuggingFace Spaces / BFCL GitHub PR or CLI）
6. **fetch CLI 扩展面**：HF endpoint allowlist 是否需加 `gaia-benchmark/*`；BFCL 是 GitHub raw 还是 dataset？allowlist 修订
7. **DockerSandbox 兼容**：GAIA file attachments 进 cache mount 是否可行；BFCL multi-turn 是否需要状态保留（DockerSandbox 当前 stateless）

spike 输出：4 选 1 决议（直接实现 / 拆 sub-iter / 部分降级 / abandon）。

---

## 4. Iter E3 第一轮任务（spike 后启动）

按 Iter E2 同样节奏（Pasteur runner 不动；只动 dataset/scorer/submission）：

| 轨道 | 范围 | 写边界 |
|---|---|---|
| **Bohr**（GAIA loader + scorer + submission） | `benchmarks/src/datasets/gaia.ts` + `benchmarks/src/scorers/gaia-exact-match.ts` + `benchmarks/src/submissions/gaia-jsonl.ts` + tests | `benchmarks/src/{datasets,scorers,submissions}/gaia*` + tests |
| **Hilbert**（BFCL v4 loader + scorer + submission）| `benchmarks/src/datasets/bfcl-v4.ts` + `benchmarks/src/scorers/bfcl-tool-call-match.ts` + `benchmarks/src/submissions/bfcl-csv.ts` + tests | `benchmarks/src/{datasets,scorers,submissions}/bfcl*` + tests |

跨轨道同步点：

| 同步点 | 内容 |
|---|---|
| S-e3-enum | ADR-010 §3.1 zod enum 加 `gaia` + `bfcl-v4` 两路一起改 |
| S-e3-cache | 两轨道复用 `cache.ts` `requested_max_rows` 协议 + sha256 manifest |
| S-e3-fetch-allowlist | HF endpoint allowlist 加 `gaia-benchmark/*`；BFCL endpoint 同步 |
| S-e3-scorer-registry | 两 scorer 注册到 Lavoisier registry，不破坏 E2 swe-bench-patch-apply |
| S-e3-submission-registry | 两 adapter 注册到 Mendeleev registry |

---

## 5. 节奏估算

| 阶段 | 轮数 | 备注 |
|---|---|---|
| Day 0（本 plan + ADR-010 enum 扩） | 1 | 本轮 |
| Spike（GAIA + BFCL 数据结构 + scorer 设计 + submission 格式） | 1 | Codex 主线 |
| Iter E3 第一轮（Bohr + Hilbert 并行） | 2-3 | 4 模块并行 |
| Iter E3 R1 review + fix（按 E2 经验，可能 R1-R3 链） | 2-3 | review 是质量护栏 |
| Iter E3 收口 | 1 | 全实证 |
| **Iter E3 总计** | **6-9 轮** | 与 Iter E2 量级一致 |

---

## 6. 验收

### Iter E3 硬验收

- [ ] GAIA loader + scorer + submission 端到端：跑 1 题 fixture（DockerSandbox 内）从 setup → score → submission
- [ ] BFCL v4 loader + scorer + submission 端到端：同上
- [ ] benchmarks 测试覆盖率 ≥ 95%（双入口顺序复跑）
- [ ] just test-all 三语言绿
- [ ] AMB 100k p95 ≤ 300ms 不回归
- [ ] R1 review BLOCKING/HIGH = 0；MEDIUM ≤ 1 仅文档

---

## 7. References

- [ADR-010 Benchmark Harness Wire Schema](../adr/adr-010-benchmark-harness-wire-schema.md)
- [ADR-011 DockerSandbox MVP](../adr/adr-011-docker-sandbox-mvp.md)
- [Iter E1 restart plan](./2026-04-25-03-iter-e1-restart.md)
- [Iter E2 SWE-bench Verified plan](./2026-04-26-01-iter-e2-swe-bench-verified.md)
- [00-implementation-plan §Iteration E §E3](./00-implementation-plan.md)
- GAIA benchmark：`https://huggingface.co/datasets/gaia-benchmark/GAIA` + `https://huggingface.co/spaces/gaia-benchmark/leaderboard`
- BFCL v4：`https://github.com/ShishirPatil/gorilla` + `https://gorilla.cs.berkeley.edu/leaderboard.html`
