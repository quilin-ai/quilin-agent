# Iter E3b — BFCL v4 non-live + live AST/relevance slice

> **状态**: Day 0 ready（spike + reassessment 已 commit；待启动）
> **日期**: 2026-04-26
> **owner**: Quilin Agent 团队
> **前置**:
> - E3a CLOSED ✅（commit `bc9e008`，R5 Faraday）
> - Roadmap reassessment ✅（commit `b338e03`）
> - E3b Day 0 re-spike ✅（commit `50c40f4`）
> - ADR-010 v3 dataset enum: `swe-bench-lite | swe-bench-verified | gaia | bfcl-v4`（保留 `bfcl-v4` 不细分）

---

## 0. 实证基线

### 0.1 入场状态（HEAD `50c40f4`）

- 分支 `master`；工作树 clean（除 `benchmarks/coverage/` 自动生成产物）
- E3a 全部 5 轮 review chain 闭合：Raman → Maxwell → Hertz → Boltzmann → Faraday
- benchmarks 测试基线：268 passed / 1 skipped；Branch 95.45% / Lines 97.61%（双入口）
- `just test-all` 三语言绿；AMB 100k p95 ≤ 300ms 不回归
- DockerSandbox MVP 稳定；cache sha256 manifest + lockfile 双因子稳定（R4 Boltzmann 修复）

### 0.2 进度记录区

| 轮次 | 任务 | 状态 | commit | 实证 |
|---|---|---|---|---|
| Day 0 spike | BFCL v4 现状 + 路径 + category enum + 范围决议 | ✅ closed | `50c40f4` | 269 行；4 选 1 决议：直接实现 non-live + live AST slice |
| Day 0 plan | 本 plan + 4 轨道并行边界 | ✅ closed | `fa2a837` | reassessment + spike 的执行清单 |
| Iter E3b first-cut | BFCL v4 loader + AST scorer + submission adapter + fetch CLI + runner.collect 分支 | ✅ closed | `d4fd62a` | 14 files +2287/-20；benchmarks 302 passed；Branch 95.23 双入口；just test-all 三语言绿；AMB p95 0.273ms ≤ 300ms |
| Iter E3b R1 review | R1 独立 subagent (Lorentz) | ✅ closed | `d0d02e3` | 1 BLOCKING（multi-file submission 永不落盘）+ 1 HIGH（scorer 缺 Java/JS type converter）+ 1 MEDIUM（ADR-010 §3.1 doc-drift） |
| Iter E3b R1 fix | SubmissionAdapter 加 optional serializeFiles + multi-file fallback / Java/JS type converter port from pinned f7cf735 / ADR-010 §3.1 sync | ✅ closed | `c8e221f` | 9 files +890/-12；benchmarks 310 passed / 1 skipped；Branch 95.35（default）/ 95.49（runner-loader）；just test-all TS717+Py187+Rust1 全绿；AMB p95 0.268ms ≤ 300ms |
| Iter E3b R2 review | R2 独立 subagent (新名字，不复用 Lorentz / E3a R1-R5 reviewers) | ⏳ 待启动 | — | R1 fix 后第二轮 confirm close；期望 close E3b |
| Iter E3b R1 fix | 按 R1 finding 修复 | ⏳ 待启动 | — | review 后 |
| Iter E3b 收口 | review chain 闭合 + 95% 覆盖率 + just test-all 三语言绿 + DockerSandbox smoke pass | ⏳ 待启动 | — | review 通过后 |

---

## 1. 当前共识（spike + reassessment 已锁定）

- **范围**：BFCL v4 **non-live + live AST/relevance** slice（不含 multi-turn / agentic / hallucination）
- **不声称 full v4 parity**：submission 必须标 `partial_eval=true` + `official_parity=false`
- **Dataset enum**：保留 `bfcl-v4`，不细分；category subset 通过 `task.metadata.category` + `task.metadata.general_category` 标注
- **路径契约**（按 spike + CHANGELOG）：
  - 任务源：`bfcl_eval/data/<general_category>/BFCL_v4_<category>.json`
  - submission output：`submissions/bfcl-v4/<run_id>/result/<model>/<general_category>/BFCL_v4_<category>_result.json`
  - score 计算：本地复用 hand-rolled AST scorer（leaderboard 提交时官方再 score）
- **Scorer 类型**：tool-call AST 比对（function name + arg name + arg value 类型 + arg required-set 匹配）
- **复用，不新增**：runner / DockerSandbox / cache / scorer registry / submission registry / fetch CLI
- **不实现**：multi-turn / agentic / memory backend / web-search / hallucination

---

## 2. 不做事项

- 不在 Iter E3b 实现 LocalSandbox / CloudSandbox（Iter F）
- 不实现 OmniMem 4 层（Iter F）
- 不启动 E3c (multi-turn) / E3c2 (agentic) / E4 (hallucination)
- 不在本 Iter 修改 runner / sandbox / wire schema 顶层契约（仅 `task.metadata.{category, general_category}` 字段扩展）
- 不引入新 cost-tracking / OTel attribute（复用 ADR-008）
- **不替换 framework**（保留 hand-rolled AST scorer + submission adapter）

---

## 3. Iter E3b 第一轮任务

按 Iter E3a 同样节奏（Pasteur runner 不动；只动 dataset/scorer/submission）：

| 轨道 | 范围 | 写边界 |
|---|---|---|
| **Bohr**（BFCL v4 loader） | `benchmarks/src/datasets/bfcl-v4.ts` + tests | `benchmarks/src/datasets/bfcl-v4*` |
| **Hilbert**（AST scorer） | `benchmarks/src/scorers/bfcl-v4-ast.ts` + tests | `benchmarks/src/scorers/bfcl-v4-ast*` |
| **Pasteur**（submission adapter） | `benchmarks/src/submissions/bfcl-v4-jsonl.ts` + tests | `benchmarks/src/submissions/bfcl-v4*` |
| **Mendeleev**（fetch CLI 扩展）| `benchmarks/scripts/fetch-benchmark.ts` BFCL endpoint allowlist + 数据 fetch | `benchmarks/scripts/fetch-benchmark.ts` BFCL section |

跨轨道同步点：

| 同步点 | 内容 |
|---|---|
| S-e3b-allowlist | fetch-benchmark.ts 加 BFCL official repo raw GitHub allowlist (`raw.githubusercontent.com/ShishirPatil/gorilla/...`) |
| S-e3b-cache | 复用 `cache.ts` `requested_max_rows` 协议 + sha256 manifest（R2/R3/R4 lockfile 全保留）|
| S-e3b-scorer-registry | bfcl-v4-ast scorer 注册到 Lavoisier registry，不破坏 swe-bench-patch-apply / gaia-exact-match |
| S-e3b-submission-registry | bfcl-v4-jsonl adapter 注册到 Mendeleev registry |
| S-e3b-runner | runner.collect dataset-aware：BFCL v4 走 strict JSON `{ tool_calls: [...] }` schema，与 GAIA strict JSON 同模式 |
| S-e3b-prompt-sanitization | inputs 不含 host_path（沿用 E3a R2 HIGH-1 修复模式）|

---

## 4. 节奏估算

| 阶段 | 轮数 | 备注 |
|---|---|---|
| Day 0 spike | 1 | 已 land `50c40f4` |
| Day 0 plan（本 plan）| 1 | 本轮 |
| Iter E3b 第一轮（Bohr + Hilbert + Pasteur + Mendeleev）| 2-3 | 4 模块并行 |
| Iter E3b R1 review + fix（按 E3a 经验，可能 R1-R3 链）| 1-3 | review chain |
| Iter E3b 收口 | 1 | 全实证 |
| **Iter E3b 总计** | **5-8 轮** | 比 E3a 短（runner 不动，复用度高） |

---

## 5. 验收

### Iter E3b 硬验收

- [ ] BFCL v4 non-live + live AST/relevance loader + scorer + submission 端到端：跑 1 题 fixture（DockerSandbox 内）从 setup → score → submission
- [ ] benchmarks 测试覆盖率 ≥ 95%（双入口顺序复跑）
- [ ] just test-all 三语言绿
- [ ] AMB 100k p95 ≤ 300ms 不回归
- [ ] R1 review BLOCKING/HIGH = 0；MEDIUM ≤ 1 仅文档
- [ ] submission flag `partial_eval=true` + `official_parity=false` 在 result + manifest 双向标记
- [ ] non-live + live AST scorer 与 BFCL 官方 `evaluator.py` AST 匹配语义对齐（grep upstream + 写测试）

---

## 6. References

- [Iter E3 plan](./2026-04-26-02-iter-e3-gaia-bfcl.md)
- [Roadmap reassessment 2026-04-26](./2026-04-26-03-roadmap-reassess-2026-04.md)
- [BFCL v4 re-spike](../research/2026-04-26-06-bfcl-v4-respike.md)
- [ADR-010 Benchmark wire schema](../adr/adr-010-benchmark-harness-wire-schema.md)
- [ADR-011 DockerSandbox MVP](../adr/adr-011-docker-sandbox-mvp.md)
- [E3a R5 close commit](../../bc9e008)
- [BFCL official repo (pinned f7cf735)](https://github.com/ShishirPatil/gorilla/tree/f7cf735/berkeley-function-call-leaderboard)
- [BFCL v4 leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)
