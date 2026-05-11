# Stage D — DSPy Validation Report (QUI-147)

> ✅ **REAL DSPy CODE PATH** — DSPy 3.2.1 actually invoked. Both MIPROv2 (Bayesian instruction search via `optuna`) and GEPA (Genetic-Pareto rollouts) execute their full compile loops. Judge LM is `dspy.utils.DummyLM` (zero LLM cost, deterministic). Real-LLM benchmarking remains user-initiated; this report exercises the real DSPy framework with a deterministic stub judge so `dspy_compile_starting` and the entire optimizer pipeline run in production-like conditions.

> ✅ **真实 DSPy 代码路径** —— DSPy 3.2.1 真实调用。MIPROv2（基于 `optuna` 的 Bayesian instruction 搜索）与 GEPA（Genetic-Pareto rollouts）的完整 compile loop 都在运行。Judge LM 用 `dspy.utils.DummyLM`（零 LLM 成本，确定性）。真实 LLM benchmark 仍由用户触发；本报告用确定性 stub judge 让 `dspy_compile_starting` 和整个 optimizer pipeline 在接近生产的条件下跑起来。

## Reproducibility / 可复现性

- Trajectories path: `docs/10-self-evolution/benchmark/trajectories.jsonl`
- Dataset SHA-256: `39387d3c71cd9eb6c3937bade50a08938591b5368ef8db7da6c61ecfea6cc82b`
- Trajectories count: 50
- Seeds per arm: 3
- Pooled samples per arm: 150
- Bench script: `scripts/bench-real-dspy.py`
- Judge mode: `QUILIN_OPTIMIZER_JUDGE_MODE=dummy` → `dspy.utils.DummyLM`
- DSPy version: 3.2.1 (with optuna)

## Aggregate failure-rate table / 失败率聚合表

| Arm | Mean failure rate | 95% CI (Wilson) | Per-seed failure rates |
|---|---|---|---|
| PromptRewrite (baseline) | 82.0% | [75.1%, 87.3%] | 82.0%, 82.0%, 82.0% |
| DSPy + MIPROv2 | 100.0% | [97.5%, 100.0%] | 100.0%, 100.0%, 100.0% |
| DSPy + GEPA | 100.0% | [97.5%, 100.0%] | 100.0%, 100.0%, 100.0% |

## ASCII bar chart — failure rate (lower is better) / ASCII 条形图 —— 失败率（越低越好）

```
PromptRewrite (baseline)            | █████████████████████████████████░░░░░░░ 82.0%
DSPy + MIPROv2                      | ████████████████████████████████████████ 100.0%
DSPy + GEPA                         | ████████████████████████████████████████ 100.0%
```

## Lift summary / Lift 总结

- Lift (MIPROv2 vs baseline): -22.0% relative failure-rate reduction
- Lift (GEPA vs baseline): -22.0% relative failure-rate reduction
- Best arm lift: -22.0%

Lift（MIPROv2 vs baseline）：-22.0% 相对失败率降幅；Lift（GEPA vs baseline）：-22.0% 相对失败率降幅。最优 arm lift = -22.0%。

## Per-FailureCategory breakdown / 按失败类型拆分

| Category | PromptRewrite (baseline) | DSPy + MIPROv2 | DSPy + GEPA |
|---|---|---|---|
| budget_exhaustion | 100.0% | 100.0% | 100.0% |
| missing_evidence | 100.0% | 100.0% | 100.0% |
| schema_violation | 92.9% | 100.0% | 100.0% |
| tool_error | 46.7% | 100.0% | 100.0% |
| unknown | 100.0% | 100.0% | 100.0% |

## Decision recommendation / 决策建议

- Bucket: **suppressed (DummyLM mode)**
- Recommendation: Decision suppressed — this run uses dspy.utils.DummyLM, which provides deterministic but content-free judge signal. The §2.4.0.1 lift ladder (≥ 30% / 10–30% / < 10%) only applies when the judge is a real LLM. Real-LLM bench is the actual gate; this run only verifies the DSPy framework wiring. 决策暂缓 —— 本次跑用 DummyLM，judge 信号没有语义内容，§2.4.0.1 的 lift 阈值仅在真实 LLM judge 下有效。本次跑只验证 DSPy 框架接线，正式决策需要真实 LLM bench。

Decision branches per docs/10-self-evolution/README.md §2.4.0.1: lift ≥ 30% → DSPy default; 10–30% → DSPy opt-in; < 10% → trigger Stage E.

决策分支依据 docs/10-self-evolution/README.md §2.4.0.1：lift ≥ 30% → DSPy 转默认；10–30% → DSPy 仍 opt-in；< 10% → 触发 Stage E follow-up。

## Caveats / 限制说明

- DummyLM provides deterministic but **content-free** judge signal — DSPy's compile loops run end-to-end but cannot meaningfully optimize without real semantic feedback. Resulting "optimized prompts" tend to revert toward the seed instruction. This is by-design for cost-free real-code-path benchmarking; it is NOT a substitute for real-LLM validation.
- DummyLM 提供确定性但**没有语义内容**的 judge 信号 —— DSPy compile loop 端到端运行，但缺乏真实语义反馈无法有效优化。生成的"优化后 prompt"倾向回退到种子指令。这是无成本测试真实代码路径的有意设计，**不能替代真实 LLM 验证**。
- Replay scoring is keyword-overlap based; it does not re-execute the agent loop end-to-end.
- Replay 评分基于关键字重叠，没有完整重跑 agent loop。
- Synthetic 50-trajectory dataset (not real production traces). Real ≥200 prod-trace dataset is the canonical Stage D follow-up.
- 50 条合成 trajectory（非真实生产轨迹）。≥200 条真实 prod-trace 数据集是经典 Stage D follow-up。
