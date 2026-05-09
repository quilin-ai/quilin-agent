# Stage D — DSPy Validation Report (QUI-147)

> ⚠️ **MOCKED BENCHMARK DISCLOSURE** — This report is generated from a fully mocked benchmark run. No real LLM was invoked; DSPy MIPROv2 / GEPA arms use a deterministic mock MCP client that simulates ~80% (MIPRO) / ~70% (GEPA) ground-truth keyword coverage. Replay scoring uses keyword-overlap heuristics, not full agent re-execution. Numbers below are illustrative of the harness wiring, not production validation. Real-LLM benchmarking is deferred to a follow-up task.

> ⚠️ **MOCK 数据声明** —— 本报告基于完全 mock 的 benchmark 运行。没有调用真实 LLM；DSPy MIPROv2 / GEPA 通路使用确定性 mock MCP client（MIPRO 模拟 ~80%，GEPA ~70% 地面真相关键字覆盖率）。Replay 评分用关键字重叠启发式，没有完整重跑 agent。下方数字仅展示 harness 接线是否正确，不能代表生产级验证。真实 LLM benchmarking 推后到 follow-up 任务。

## Reproducibility / 可复现性

- Trajectories path: `docs/10-self-evolution/benchmark/trajectories.jsonl`
- Dataset SHA-256: `39387d3c71cd9eb6c3937bade50a08938591b5368ef8db7da6c61ecfea6cc82b`
- Trajectories count: 50
- Seeds per arm: 3

## Aggregate failure-rate table / 失败率聚合表

| Arm | Mean failure rate | 95% CI (Wilson) | Per-seed failure rates |
|---|---|---|---|
| PromptRewrite (baseline) | 24.0% | [17.9%, 31.4%] | 24.0%, 24.0%, 24.0% |
| DSPy + MIPROv2 (mocked) | 19.3% | [13.8%, 26.4%] | 18.0%, 20.0%, 20.0% |
| DSPy + GEPA (mocked) | 27.3% | [20.8%, 35.0%] | 28.0%, 28.0%, 26.0% |

## ASCII bar chart — failure rate (lower is better) / ASCII 条形图 —— 失败率（越低越好）

```
PromptRewrite (baseline)     | ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 24.0%
DSPy + MIPROv2 (mocked)      | ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 19.3%
DSPy + GEPA (mocked)         | ███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 27.3%
```

## Lift summary / Lift 总结

- Lift (MIPROv2 vs baseline): 19.4% relative failure-rate reduction
- Lift (GEPA vs baseline): -13.9% relative failure-rate reduction
- Best arm lift: 19.4%

Lift（MIPROv2 vs baseline）：19.4% 相对失败率降幅；Lift（GEPA vs baseline）：-13.9% 相对失败率降幅。最优 arm lift = 19.4%。

## Per-FailureCategory breakdown / 按失败类型拆分

| Category | baseline | MIPROv2 | GEPA |
|---|---|---|---|
| tool_error | 73.3% | 11.1% | 22.2% |
| schema_violation | 7.1% | 21.4% | 21.4% |
| budget_exhaustion | 0.0% | 27.3% | 39.4% |
| missing_evidence | 0.0% | 22.2% | 33.3% |
| unknown | 0.0% | 0.0% | 0.0% |

## Decision recommendation / 决策建议

- Bucket: **10% ≤ lift < 30%**
- Recommendation: DSPy stays opt-in; default remains PromptRewrite. DSPy 仍保持 opt-in，默认仍是 PromptRewrite。

Decision branches per docs/10-self-evolution/README.md §2.4.0.1: lift ≥ 30% → DSPy default; 10–30% → DSPy opt-in; < 10% → trigger Stage E.

决策分支依据 docs/10-self-evolution/README.md §2.4.0.1：lift ≥ 30% → DSPy 转默认；10–30% → DSPy 仍 opt-in；< 10% → 触发 Stage E follow-up。

## Caveats / 限制说明

- Mock arms are deterministic and intentionally skewed in favor of MIPROv2 / GEPA to verify the harness math; real DSPy lift may be lower or higher.
- Replay scoring is keyword-overlap based; it does not re-execute the agent loop end-to-end.
- Dataset is synthetic (50 entries) — production validation needs real prod traces.

- Mock arm 是确定性的并刻意偏向 MIPROv2 / GEPA，仅用于验证 harness 数学；真实 DSPy lift 会更低或更高。
- Replay 评分基于关键字重叠，不会端到端重跑 agent loop。
- 数据集是合成的（50 条）—— 生产级验证需要真实 prod trace。

