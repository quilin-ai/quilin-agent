# Stage D — DSPy Validation Report (QUI-147)

> ⚠️ **DEPRECATED — HISTORICAL EVIDENCE ONLY (post 2026-05-12)** — The GEPA-only outcome in [README §2.4](./README.md) supersedes this report. The MIPROv2 −19.5% lift below (vs +14.6% under DeepSeek judge on the same code + dataset) is the canonical evidence that the bench's keyword-overlap scorer is judge-LM-sensitive, not a current production validation. Do not act on the decision-bucket recommendation in this file. ⚠️ **历史证据 —— 已弃用**：当前真相以 README §2.4 为准；MIPROv2 −19.5%（gpt-4o-mini）vs +14.6%（DeepSeek）是 bench 评委敏感性的关键证据。
>
> Pre-deprecation banner (preserved verbatim):

> 🔥 **REAL LLM JUDGE** — DSPy 3.2.1 actually invoked with a real LLM judge (`openrouter/openai/gpt-4o-mini`). MIPROv2 (Bayesian instruction search via `optuna`) and GEPA (Genetic-Pareto rollouts) get **real semantic feedback** during compile — this is the canonical lift measurement, not a code-path smoke test.

> 🔥 **真实 LLM 评委** —— DSPy 3.2.1 真实调用，judge 用真实 LLM（`openrouter/openai/gpt-4o-mini`）。MIPROv2（基于 `optuna` 的 Bayesian instruction 搜索）与 GEPA（Genetic-Pareto rollouts）在 compile loop 中**获得真实语义反馈** —— 本次是 lift 的正式测量，不再是代码路径冒烟测试。

## Reproducibility / 可复现性

- Trajectories path: `docs/10-self-evolution/benchmark/trajectories.jsonl`
- Dataset SHA-256: `39387d3c71cd9eb6c3937bade50a08938591b5368ef8db7da6c61ecfea6cc82b`
- Trajectories count: 50
- Seeds per arm: 3
- Pooled samples per arm: 150
- Bench script: `scripts/bench-real-dspy.py`
- Judge mode: `QUILIN_OPTIMIZER_JUDGE_MODE=llm` → real LLM (`openrouter/openai/gpt-4o-mini`)
- DSPy version: 3.2.1 (with optuna)

## Aggregate failure-rate table / 失败率聚合表

| Arm | Mean failure rate | 95% CI (Wilson) | Per-seed failure rates |
|---|---|---|---|
| PromptRewrite (baseline) | 82.0% | [75.1%, 87.3%] | 82.0%, 82.0%, 82.0% |
| DSPy + MIPROv2 | 98.0% | [94.3%, 99.3%] | 98.0%, 98.0%, 98.0% |
| DSPy + GEPA | 94.0% | [89.0%, 96.8%] | 94.0%, 94.0%, 94.0% |

## ASCII bar chart — failure rate (lower is better) / ASCII 条形图 —— 失败率（越低越好）

```
PromptRewrite (baseline)            | █████████████████████████████████░░░░░░░ 82.0%
DSPy + MIPROv2                      | ███████████████████████████████████████░ 98.0%
DSPy + GEPA                         | ██████████████████████████████████████░░ 94.0%
```

## Lift summary / Lift 总结

- Lift (MIPROv2 vs baseline): -19.5% relative failure-rate reduction
- Lift (GEPA vs baseline): -14.6% relative failure-rate reduction
- Best arm lift: -14.6%

Lift（MIPROv2 vs baseline）：-19.5% 相对失败率降幅；Lift（GEPA vs baseline）：-14.6% 相对失败率降幅。最优 arm lift = -14.6%。

## Per-FailureCategory breakdown / 按失败类型拆分

| Category | PromptRewrite (baseline) | DSPy + MIPROv2 | DSPy + GEPA |
|---|---|---|---|
| budget_exhaustion | 100.0% | 100.0% | 81.8% |
| missing_evidence | 100.0% | 100.0% | 100.0% |
| schema_violation | 92.9% | 92.9% | 100.0% |
| tool_error | 46.7% | 100.0% | 100.0% |
| unknown | 100.0% | 100.0% | 0.0% |

## Decision recommendation / 决策建议

- Bucket: **lift < 10%**
- Recommendation: Trigger Stage E follow-up (Trace optimizer / OPRO / PromptBreeder evaluation). 触发 Stage E follow-up 评估替代算法.

Decision branches per docs/10-self-evolution/README.md §2.4.0.1: lift ≥ 30% → DSPy default; 10–30% → DSPy opt-in; < 10% → trigger Stage E.

决策分支依据 docs/10-self-evolution/README.md §2.4.0.1：lift ≥ 30% → DSPy 转默认；10–30% → DSPy 仍 opt-in；< 10% → 触发 Stage E follow-up。

## Caveats / 限制说明

- Real-LLM judge (`openrouter/openai/gpt-4o-mini`) provides semantic feedback, but results are **deterministic across seeds** when the judge model runs at low temperature — Wilson CI is computed over pooled samples but per-seed variance may be zero. Treat the CI as a sample-size bound, not a randomness bound.
- 真实 LLM 评委（`openrouter/openai/gpt-4o-mini`）提供语义反馈，但 judge 在低温下**跨 seed 输出确定**时，per-seed 方差可能为零。Wilson CI 反映样本量界限，不反映随机性界限。
- Judge LM JSON-adapter failures (DeepSeek struggles with structured output) may inflate failure rates artificially; cross-validate with another judge model before treating absolute lift as canonical.
- Judge LM 的 JSON adapter 报错（DeepSeek 结构化输出弱）可能拉高失败率，把 lift 当正式数据前需要用另一个评委模型交叉验证。
- Replay scoring is keyword-overlap based; it does not re-execute the agent loop end-to-end.
- Replay 评分基于关键字重叠，没有完整重跑 agent loop。
- Synthetic 50-trajectory dataset (not real production traces). Real ≥200 prod-trace dataset is the canonical Stage D follow-up.
- 50 条合成 trajectory（非真实生产轨迹）。≥200 条真实 prod-trace 数据集是经典 Stage D follow-up。
