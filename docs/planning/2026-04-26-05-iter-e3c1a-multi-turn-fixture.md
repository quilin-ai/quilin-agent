# Iter E3c1a — BFCL v4 multi-turn fixture-trajectory adapter

> **状态**: Day 0 ready（spike + reassessment 已 commit；待启动）
> **日期**: 2026-04-26
> **owner**: Quilin Agent 团队
> **前置**:
> - E3a CLOSED ✅（commit `bc9e008`，R5 Faraday）
> - E3b CLOSED ✅（commit `5c5ca2a`，R2 Schrödinger）
> - Roadmap reassessment ✅（commit `b338e03`）
> - E3b Day 0 spike ✅（commit `50c40f4`）
> - E3c1 multi-turn re-spike ✅（commit `0b6638e`）

---

## 0. 实证基线

### 0.1 入场状态（HEAD `0b6638e`）

- 分支 `master`；工作树 clean
- E3a + E3b review chains 闭合
- benchmarks 测试基线：310 passed / 1 skipped；Branch 95.35% / Lines 97.94%（双入口）
- `just test-all` 三语言绿；AMB 100k p95 ≤ 300ms
- DockerSandbox MVP 稳定

### 0.2 进度记录区

| 轮次 | 任务 | 状态 | commit | 实证 |
|---|---|---|---|---|
| Day 0 spike | BFCL multi-turn 形态 + stateful evaluator + 4 选 1 决议 | ✅ closed | `0b6638e` | 314 行；staged E3c1（拆 E3c1a fixture + E3c1b stateful runner）|
| Day 0 plan | 本 plan + E3c1a 写边界 | 🔄 本轮 | — | — |
| Iter E3c1a first-cut | loader + official checker adapter + fixture submission | ⏳ 待启动 | — | 消费预录 official trajectories；不实现 stateful runtime |
| Iter E3c1a R1 review | R1 独立 subagent (新名字，不复用 Lorentz/Schrödinger/E3a R1-R5) | ⏳ 待启动 | — | first-cut 后第一轮交叉 review |
| Iter E3c1a R1 fix（如需）| 按 R1 finding 修复 | ⏳ 待启动 | — | review 后 |
| Iter E3c1a 收口 | review chain 闭合 + 95% 覆盖率 + just test-all 三语言绿 | ⏳ 待启动 | — | review 通过后 |

E3c1b（stateful runner）和 E3c2（agentic web-search/memory）独立 sub-iter，不在本 plan 范围。

---

## 1. 当前共识（spike + reassessment 已锁定）

- **范围**：E3c1a = **fixture-trajectory adapter** ONLY
  - loader：BFCL multi-turn task JSON（`{initial_config, involved_classes, possible_answer}`）
  - submission adapter：消费预录的 official `result/<model>/multi_turn/BFCL_v4_multi_turn_*_result.json` trajectories（turn→step 嵌套数组 + token/latency）
  - scorer adapter：调用官方 Python checker（不 reimplement TS 复刻 backend）
- **不实现**（留 E3c1b）：
  - stateful runner（Python backend object 实例化 + turn-by-turn 执行）
  - tool-runtime（per-turn function dispatch + state mutation）
- **不实现**（留 E3c2 / E4）：
  - web-search / memory backend
  - agentic full pipeline
  - hallucination

- **Scorer 策略**：在 DockerSandbox 内调 BFCL official `multi_turn_checker.py` 作为 Python adapter；不 TS 复刻 stateful logic
- **复用，不新增**：runner / DockerSandbox / cache / scorer registry / submission registry / fetch CLI（与 E3b 同模式）
- **Submission**：multi-file 复用 E3b 的 `serializeFiles?` 接口（output to `result/<model>/multi_turn/BFCL_v4_multi_turn_*_result.json`）
- **Dataset enum**：保留 `bfcl-v4`，不细分；category 走 `task.metadata.{category, general_category}`（与 E3b 同）

---

## 2. 不做事项

- 不在 Iter E3c1a 实现 stateful runner / tool-runtime（→ E3c1b）
- 不在 Iter E3c1a 实现 web-search / memory backend（→ E3c2 或 E4）
- 不实现 OmniMem 4 层（→ Iter F）
- 不重写 E3a / E3b 已闭合代码
- 不替换 framework（保留 hand-rolled adapter）
- 不破坏 wire schema 顶层契约（仅 `task.metadata` 扩 `multi_turn` 标记）

---

## 3. Iter E3c1a 第一轮任务

按 E3a/E3b 同样节奏（runner.collect 不动；只动 dataset/scorer/submission/fetch CLI）：

| 轨道 | 范围 | 写边界 |
|---|---|---|
| **Bohr-mt**（multi-turn loader） | `benchmarks/src/datasets/bfcl-v4-multi-turn.ts` + tests | `benchmarks/src/datasets/bfcl-v4-multi-turn*` |
| **Hilbert-mt**（official checker adapter）| `benchmarks/src/scorers/bfcl-v4-multi-turn.ts` + tests + `benchmarks/scripts/bfcl-multi-turn-checker.py` (Python checker wrapper) | `benchmarks/src/scorers/bfcl-v4-multi-turn*` + `benchmarks/scripts/bfcl-multi-turn-checker.py` |
| **Pasteur-mt**（multi-turn submission adapter）| `benchmarks/src/submissions/bfcl-v4-multi-turn-jsonl.ts` + tests | `benchmarks/src/submissions/bfcl-v4-multi-turn*` |
| **Mendeleev-mt**（fetch CLI 扩展） | `benchmarks/scripts/fetch-benchmark.ts` BFCL multi-turn endpoint allowlist + 数据 fetch | 仅 `benchmarks/scripts/fetch-benchmark.ts` BFCL multi-turn section |

跨轨道同步点：

| 同步点 | 内容 |
|---|---|
| S-e3c1a-allowlist | fetch-benchmark.ts 加 BFCL multi-turn JSON 路径 allowlist |
| S-e3c1a-cache | 复用 sha256 manifest + lockfile（无新代码）|
| S-e3c1a-scorer-registry | bfcl-v4-multi-turn scorer 注册到 Lavoisier registry |
| S-e3c1a-submission-registry | bfcl-v4-multi-turn-jsonl adapter 注册到 Mendeleev registry |
| S-e3c1a-python-checker | Python checker wrapper 与 DockerSandbox 集成（输入 stdin/output stdout）|
| S-e3c1a-prompt-sanitization | 沿用 E3a R2 sanitization allowlist 模式 |

---

## 4. 节奏估算

| 阶段 | 轮数 | 备注 |
|---|---|---|
| Day 0 spike | 1 | 已 land `0b6638e` |
| Day 0 plan（本 plan）| 1 | 本轮 |
| Iter E3c1a 第一轮（4 模块并行）| 1-2 | 复用度高，比 E3b 短 |
| Iter E3c1a R1 review + fix（按经验）| 1-2 | review chain |
| Iter E3c1a 收口 | 1 | 全实证 |
| **Iter E3c1a 总计** | **4-6 轮** | 比 E3b 短（无 stateful runtime 新代码）|

---

## 5. 验收

### Iter E3c1a 硬验收

- [ ] BFCL multi-turn loader：解析 BFCL_v4_multi_turn JSON（initial_config / involved_classes / possible_answer）
- [ ] Python checker adapter：DockerSandbox 内调用 official `multi_turn_checker.py` 处理 fixture trajectories
- [ ] Submission：消费预录 trajectories 输出到 `result/<model>/multi_turn/BFCL_v4_multi_turn_*_result.json`，复用 E3b serializeFiles? 接口
- [ ] benchmarks 测试覆盖率 ≥ 95%（双入口顺序复跑）
- [ ] just test-all 三语言绿
- [ ] AMB 100k p95 ≤ 300ms 不回归
- [ ] R1 review BLOCKING/HIGH = 0；MEDIUM ≤ 1 仅文档
- [ ] submission flag `partial_eval=true` + `official_parity=false` + `stateful_eval=false`（区分 E3c1a vs E3c1b）

---

## 6. 可能的风险

- **Python checker subprocess**：DockerSandbox 内 spawn Python checker 的延迟与 stdout 解析；可能 ≥ 100ms per task。需保证不因 subprocess noise 破坏 AMB 性能 gate（AMB 不涉及 subprocess，理论无关）
- **fixture archive 数据完整性**：HuanzhiMao/BFCL-Result 是公共 archive，可能与 official `f7cf735` 不同步；spike 已确认 archive 有完整 multi-turn fixtures，但 cache invalidation 需要 sha256 严格匹配
- **stateful_eval=false flag**：必须在 manifest + result file + summary 三处一致标记；否则 E3c1b 落地后会与 E3c1a output 混淆

---

## 7. References

- [Iter E3 plan](./2026-04-26-02-iter-e3-gaia-bfcl.md)
- [Iter E3b plan + close](./2026-04-26-04-iter-e3b-bfcl-ast.md)
- [Roadmap reassessment 2026-04-26](./2026-04-26-03-roadmap-reassess-2026-04.md)
- [BFCL v4 re-spike (E3b)](../research/2026-04-26-06-bfcl-v4-respike.md)
- [BFCL v4 multi-turn re-spike (this iter)](../research/2026-04-26-07-bfcl-v4-multi-turn-respike.md)
- [E3b R2 close commit](../../5c5ca2a)
- [BFCL multi-turn checker @ f7cf735](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py)
- [BFCL multi-turn utils @ f7cf735](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py)
- [BFCL eval runner @ f7cf735](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/eval_runner.py)
- [HuanzhiMao/BFCL-Result archive](https://github.com/HuanzhiMao/BFCL-Result)
