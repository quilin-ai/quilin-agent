# Iter E1 Restart — Benchmark Harness Infra

> **状态**: Draft（Day 0 待开工）
> **日期**: 2026-04-25
> **owner**: Quilin Agent 团队
> **前置**: Iter D 主轴 ✅（HEAD `b0ef213`）；25-02 cleanup sweep ✅（`1023ab5`）；ADR-010 Benchmark Harness Wire Schema

本计划重启 Iter E1（之前 E1-a `2bb25d7` + E1-b `1298f3d` 已被 `1eecb84` / `d538736` 显式 revert）。规范源以 ADR-010 为准；与本文档冲突时以 ADR-010 为准。

---

## 0. 实证基线

### 0.1 入场状态（HEAD `b0ef213`）

- 分支：`master`
- 工作树：本计划 + ADR-010 三份文档为 untracked，待本轮提交；其他文件 clean
- 相关分支：`iter-e-parked`（HEAD 祖先，`HEAD..iter-e-parked` 空，不能 merge）
- 旧 E1 commit 历史（已 revert，仅作设计参考）：
  - `2bb25d7 feat(benchmarks): bootstrap E1-a workspace + SWE-bench Lite dataset fetcher`
  - `1298f3d feat(benchmarks): land E1-b SWE-bench Lite task-loader + iterator`
  - `1eecb84` / `d538736` 两个 revert
- master 当前 `benchmarks/` 状态：仅 `node_modules` 残留，无 tracked 源码
- Iter D 已落地、可被 E1 复用：
  - OTel cost/latency tracking（ADR-008，`agent.turn.cost_usd` / `total_latency_ms`）
  - Boyle scratchpad（per-task working set；`scratchpad_write/read/clear` MCP）
  - Kelvin user-config（ADR-009，可加 `benchmarks.*` namespace）

### 0.2 进度记录区

> 后续每轮切片落地后回填 commit hash 与实证。

| 轮次 | 任务 | 状态 | commit | 实证 |
|---|---|---|---|---|
| Day 0 | ADR-010 + 本 plan + ADR-009 §3.4 加 `benchmarks` namespace | ✅ 完成 | `8254f70` | 3 files / 359 insertions |
| 选择性 restore | `benchmarks/` workspace（package/tsconfig/vitest）+ `scripts/fetch-benchmark.ts` 339 LOC + `src/wire/{task,run,result,cost,index}.ts` 139 LOC + 4 个 wire test 240 LOC + `pnpm-workspace.yaml` + `index.ts` 加 `runAgentLoop / AgentLoopConfig / LoopHooks` export | ✅ 完成 | `b7e8e2f` | benchmarks vitest = 4 files / 45 tests passed；coverage lines/branches/functions/statements 全 100%；tsc 0；biome 0；root pnpm install OK；agent-core tsc 0；`just test-all` = TS 717 + Python 187 + Rust 1 不回归；Python TOTAL 95.28% 不回归；code-review-graph risk 0 |
| Iter E1 第一轮（Pasteur runner + Galois dataset + Lavoisier scorer + Mendeleev submission） | 4 路并行 | ⏳ 待启动 | — | Codex 派任务书 |

---

## 1. 当前共识

- iter-e-parked 不可 merge（旧祖先；merge 会 -32513 行回滚 Iter C/D）
- 选择性 restore：以 `2bb25d7` / `1298f3d` 为设计参考，但代码按 ADR-010 重写 + 接入 Iter D 产物
- 不复用 22-10/11/12 旧 planning docs；本 plan 是新单一规范源
- ADR-010 是跨 leaderboard 通用契约，新增 leaderboard 只加 scorer + adapter
- Memory 降级：E2 baseline per-task working set + FTS5，不用 4 层（§E2 已决）
- DockerSandbox defer Iter F；本 Iter 用 per-task scratchpad + tmpdir + cwd containment

---

## 2. 不做事项

- 不在本 Iter 实现 DockerSandbox / CloudSandbox（留 Iter F）
- 不实现 OmniMem 4 层 benchmark 路径（plan §E2 已决）
- 不在本 Iter 启动 GAIA / BFCL（E1 完成后 E2 再做 SWE-bench Verified；GAIA / BFCL 留 E3）
- 不实现 Aspirational benchmark（τ-bench / WebArena / OSWorld 等留 E4 选择性）
- 不重做 cost-tracking（复用 Iter D OTel）
- 不引入新 ADR（除 ADR-010 + ADR-009 §3.4 修订）

---

## 3. Day 0 契约冻结

参见 [ADR-010](../adr/adr-010-benchmark-harness-wire-schema.md) 全文。Day 0 必产出：

1. `docs/adr/adr-010-benchmark-harness-wire-schema.md`（新）
2. `docs/planning/2026-04-25-03-iter-e1-restart.md`（本 plan）
3. `docs/adr/adr-009-config-cascade.md` §3.4 顶层 namespace 表加 `benchmarks`（修订，不破坏现有 namespace）

---

## 4. 选择性 restore 任务

**写边界**：
- ✅ `benchmarks/` workspace（新建，参照 `2bb25d7` 设计但代码重写）
  - `benchmarks/package.json` + `tsconfig.json` + `vitest.config.ts`
  - `benchmarks/scripts/fetch-benchmark.ts`（CLI，sha256 manifest，分页 + retry，按 ADR-010 §3.4）
  - `benchmarks/src/wire/{task,run,result,cost}.ts`（zod schema for ADR-010 §3.1/§3.3）
- ✅ `pnpm-workspace.yaml` 加 `benchmarks` 进 workspace
- ✅ `packages/agent-core/src/index.ts` 仅补 `runAgentLoop / AgentLoopConfig / LoopHooks` public export（不动其他 wire）
- ❌ 禁止：动 Iter D 已 land 的 observability/config/scratchpad 代码；动 `providers/memory/**`；引入 DockerSandbox

**DoD**：
- `cd benchmarks && pnpm tsc --noEmit` exit 0
- `cd benchmarks && pnpm exec vitest run` 测试全过
- `cd benchmarks && pnpm exec biome check src` clean
- `pnpm install` 在根目录跑通（workspace 注册成功）
- `cd packages/agent-core && pnpm tsc --noEmit` exit 0（index.ts 新 export 不破 strict）
- 测试覆盖率 ≥ 95%（新 wire schema 文件）

---

## 5. Iter E1 并行轨道（restore 完成后启动）

| 轨道 | 范围 | 写边界 |
|---|---|---|
| **Pasteur**（runner 主轴） | `benchmarks/src/runner/**`：实现 ADR-010 §3.2 5 阶段生命周期 + §3.8 OTel cost/latency 抽取 | `benchmarks/src/runner/**` + tests |
| **Galois**（dataset/loader） | `benchmarks/src/datasets/**`：实现 ADR-010 §3.4 cache 协议；至少 SWE-bench-lite loader（参考 E1-a 设计但重写） | `benchmarks/src/datasets/**` + tests |
| **Lavoisier**（scorer） | `benchmarks/src/scorers/**`：实现 ADR-010 §3.5 协议 + SWE-bench patch-apply scorer | `benchmarks/src/scorers/**` + tests |
| **Mendeleev**（submission adapter） | `benchmarks/src/submissions/**`：实现 ADR-010 §3.6 协议 + SWE-bench Verified jsonl adapter | `benchmarks/src/submissions/**` + tests |

**跨轨道同步点**：

| 同步点 | 触达轨道 | 内容 |
|---|---|---|
| S-bench-task | Pasteur ↔ Galois | BenchmarkTask wire schema |
| S-bench-cost | Pasteur ↔ Iter D OTel | OTel attribute 名映射（`llm.cost_usd` / `llm.tokens_input` 等） |
| S-bench-config | Mendeleev / Galois ↔ Kelvin | `benchmarks.{output_dir, submissions_dir, cache_dir, network_whitelist}` |
| S-bench-cache | Galois ↔ Lavoisier | sha256 manifest 加载契约 |
| S-bench-scorer-registry | Lavoisier ↔ Pasteur | scorer registry 注册路径 |

---

## 6. 节奏估算

| 阶段 | 轮数 | 备注 |
|---|---|---|
| Day 0（ADR-010 + plan + ADR-009 §3.4 修订）| 1 | 单线 |
| 选择性 restore（benchmarks workspace + index.ts export）| 1 | Codex 主线 |
| Iter E1 第一轮（Pasteur + Galois + Lavoisier + Mendeleev）| 2-3 | 4 轨道并行 |
| Iter E1 review gate（独立 subagent，类似 R1）| 1 | review + fix pass |
| **Iter E1 总计** | **5-7 轮** | 95% 覆盖率 / OTel 抽取 / sandbox 边界 |
| Iter E2 SWE-bench Verified 跑通 + 提交 | 5-8 | 500 题 + harness 调优 |
| Iter E3 GAIA + BFCL v4 | 3-5 | 共享 E1 harness |
| Iter E4（aspirational，可选）| 视情况 | E2/E3 稳定度决定 |

---

## 7. 验收

### Iter E1 硬验收

- [ ] `benchmarks/` workspace 在 root `pnpm install` 后可独立 `pnpm test` / `pnpm tsc --noEmit` / `pnpm exec biome check src`
- [ ] `runAgentLoop` 从 `@quilin/agent-core` import 无类型错误
- [ ] runner 跑 SWE-bench-lite 1 task 端到端：setup → agent loop → collect → score → cleanup 全部走通
- [ ] runner 从 OTel 抽出的 cost/latency 与 OTel exporter 输出一致（测试断言）
- [ ] sha256 manifest verify on load：tamper / schema_version mismatch 必须拒载
- [ ] sandbox 边界：尝试写 `~/.quilin/secret.txt` / `/etc/hosts` / 主仓库根目录的 task 必须被拒
- [ ] Submission jsonl 包格式与 SWE-bench Verified 官方 spec 一致（测试 fixture 比对）
- [ ] 测试覆盖率 ≥ 95%（vitest config thresholds 95，与 packages/agent-core 一致）
- [ ] AMB 100k recall 不回归（E1 不碰 memory 实现，理论无影响；保险起见 review gate 跑一次）
- [ ] `just test-all` 三语言全过
- [ ] R1 review（独立 subagent）BLOCKING/HIGH 0；MEDIUM ≤ 1

### 软验收

- [ ] benchmarks workspace LOC 不超 1500（runner + 4 轨道源码合计）
- [ ] 第一个 SWE-bench Verified jsonl submission 包能上传到官方（不论排名）

---

## 8. 协作

- Codex 主线做选择性 restore（`benchmarks/` workspace + index.ts export）
- Iter E1 4 轨道按 Iter D 同样 subagent 派发节奏（Codex 派 worker，主线复核）
- 谁写代码谁 commit 摘要给 Claude，Claude 主线 commit 附 Co-authored-by
- 中文协作；状态实证；plan §0.2 增量回写
- 95% 覆盖率门槛沿用 Iter D（feedback_test_coverage_95.md）

---

## 9. References

- [ADR-010 Benchmark Harness Wire Schema](../adr/adr-010-benchmark-harness-wire-schema.md)
- [ADR-008 Observability Span Schema](../adr/adr-008-observability-span-schema.md)
- [ADR-009 Config Cascade](../adr/adr-009-config-cascade.md)
- [00-implementation-plan §Iteration E](./00-implementation-plan.md)
- [Iter D 并行任务拆分](./2026-04-25-01-iter-d-parallel-breakdown.md)（Iter E 节奏参照）
- 历史参考 commit：`2bb25d7` E1-a / `1298f3d` E1-b（已 revert，仅设计参考）
