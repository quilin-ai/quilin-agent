# 代码基准目标证据包 / Coding Benchmark Target Evidence Pack

> Frozen note, 2026-05-02: this document is a historical evidence pack only. Iter E is frozen, `QUI-47` and `QUI-70` are canceled/Low, and no SWE-bench Pro, SWE-bench Verified, or local coding benchmark code may be added or modified unless the user explicitly asks for Benchmark work.
>
> 冻结说明，2026-05-02：本文只作为历史证据包保留。Iter E 已冻结，`QUI-47` 与 `QUI-70` 已取消并降为低优先级；除非用户明确要求 Benchmark 工作，不得新增或修改 SWE-bench Pro、SWE-bench Verified 或本地代码基准代码。

## 结论 / Decision

The earlier recommendation to treat SWE-bench Pro（更难的代码修复基准，面向长周期、多文件、企业级软件工程任务）public Resolve Rate / Pass@1 as the primary coding benchmark metric is frozen and no longer active project guidance. Existing evidence may be cited to explain past Iter E planning, but it does not authorize implementation work.

此前把 SWE-bench Pro（更难的代码修复基准，面向长周期、多文件、企业级软件工程任务）public Resolve Rate / Pass@1 作为主代码基准指标的建议已经冻结，不再是当前项目指导。现有证据只可用于解释过去的 Iter E planning，不授权任何实现工作。

Linear [QUI-47](https://linear.app/quilin-agent/issue/QUI-47/iter-e重评-swe-bench-verified-退役后的代码基准目标-reassess-coding-benchmark) has been canceled and lowered in priority under the Benchmark freeze. Do not replace the coding benchmark target, implement a SWE-bench Pro loader, or extend scoring semantics unless the user explicitly restarts Benchmark work.

Linear [QUI-47](https://linear.app/quilin-agent/issue/QUI-47/iter-e重评-swe-bench-verified-退役后的代码基准目标-reassess-coding-benchmark) 已按 Benchmark 冻结取消并降级。除非用户明确重启 Benchmark 工作，不得替换代码基准目标、实现 SWE-bench Pro loader，或扩展评分语义。

## 一手来源 / Primary Sources

OpenAI published "Why SWE-bench Verified no longer measures frontier coding capabilities" on 2026-02-23. The article says OpenAI stopped reporting SWE-bench Verified because remaining score movement increasingly reflects flawed tests and training exposure rather than real-world coding improvement, and it recommends reporting SWE-bench Pro until newer uncontaminated evaluations are available.

OpenAI 于 2026-02-23 发布 "Why SWE-bench Verified no longer measures frontier coding capabilities"。该文说明 OpenAI 已停止报告 SWE-bench Verified，因为剩余分数变化越来越多反映测试缺陷与训练暴露，而不是真实世界代码能力提升；在新的去污染评测可用前，OpenAI 建议报告 SWE-bench Pro。

The official SWE-bench repository and documentation define SWE-bench as applying generated patches to real repositories in Docker and judging resolution with fail-to-pass tests plus pass-to-pass regression tests. The official dataset guide lists SWE-bench Verified as a 500-instance expert-verified subset, and the original paper describes the full benchmark as 2,294 GitHub issue / pull request problems across 12 Python repositories.

SWE-bench 官方仓库和文档把 SWE-bench 定义为：在 Docker 中把模型生成的 patch（代码补丁）应用到真实仓库，并用 fail-to-pass（原本失败、修复后应通过）测试与 pass-to-pass（修复前后都应通过的回归）测试判断是否解决。官方数据集指南把 SWE-bench Verified 列为 500 个专家验证样本；原始论文说明完整基准包含来自 12 个 Python 仓库的 2,294 个 GitHub issue / pull request 问题。

The SWE-bench Pro paper, official repository, Scale public leaderboard, and Hugging Face dataset card describe SWE-bench Pro as a contamination-resistant, long-horizon benchmark with 1,865 human-verified and augmented problems across 41 maintained repositories. Its public set has 731 open instances, and the primary metric is Resolve Rate / Pass@1: a task is resolved only when issue-specific fail-to-pass tests pass and pass-to-pass regression tests keep passing.

SWE-bench Pro 论文、官方仓库、Scale 公开榜单和 Hugging Face 数据卡把 SWE-bench Pro 描述为 contamination-resistant（降低训练数据污染风险）的 long-horizon benchmark（长周期任务基准），包含 41 个活跃维护仓库中的 1,865 个经人工验证和增强的问题。它的 public set（公开集）有 731 个开放样本；主指标是 Resolve Rate / Pass@1（一次提交解决率）：只有当 issue-specific fail-to-pass 测试通过、pass-to-pass 回归测试继续通过时，任务才算 resolved（已解决）。

## 候选对比 / Candidate Comparison

| Candidate | Evidence-based role | Strength | Limitation | Quilin decision |
|---|---|---|---|---|
| SWE-bench Pro public | Historical candidate | Harder, less saturated, lower contamination risk, official Resolve Rate semantics | Public split still not perfect; private/held-out sets are not fully accessible | Frozen reference only; no implementation without user request |
| SWE-bench Verified | Historical/legacy candidate | Historical continuity, existing Quilin loader, broad ecosystem familiarity | OpenAI says it is no longer suitable for frontier reporting because of flawed tests and contamination | Frozen reference only; no implementation without user request |
| Quilin local coding slice | Historical internal diagnostic candidate | Measures Quilin-specific repo tasks, safety gates, docs/code workflow, and agent collaboration patterns | Not a public benchmark; high risk of local overfitting unless task creation is governed | Frozen reference only; no implementation without user request |

| 候选 | 基于证据的角色 | 优势 | 限制 | Quilin 决策 |
|---|---|---|---|---|
| SWE-bench Pro public（公开集） | 历史候选 | 更难、更不饱和、污染风险更低，且有官方 Resolve Rate（解决率）语义 | 公开集仍不完美；private / held-out（私有 / 保留）集合不能完全访问 | 仅作冻结参考；无用户明确要求不得实现 |
| SWE-bench Verified | 历史/遗留候选 | 有历史连续性、Quilin 已有 loader（加载器）、生态熟悉度高 | OpenAI 说明它因测试缺陷与污染不再适合前沿能力汇报 | 仅作冻结参考；无用户明确要求不得实现 |
| Quilin 本地代码切片 | 历史内部诊断候选 | 衡量 Quilin 自身仓库任务、安全门、文档/代码工作流和 Agent 协作模式 | 不是公开基准；若任务治理不足，本地过拟合风险高 | 仅作冻结参考；无用户明确要求不得实现 |

SWE-bench Pro was previously considered the best primary target because it directly addressed the two risks that caused SWE-bench Verified retirement: benchmark saturation/contamination and insufficient task complexity. That assessment is now historical and must not be converted into work.

SWE-bench Pro 曾被认为最适合作为主目标，因为它回应了 SWE-bench Verified 退役的两个风险：benchmark saturation / contamination（基准饱和 / 训练数据污染）以及任务复杂度不足。该判断现在只是历史记录，不得转化为工作项。

SWE-bench Verified still matters because Quilin already has local implementation surface for it: the dataset enum includes `swe-bench-verified`, the loader records the 500-row expectation, and the submission adapter emits SWE-bench-compatible JSONL. However, the current local scorer only checks whether a patch applies with `git apply --check`, so it is not yet equivalent to official SWE-bench resolution semantics.

SWE-bench Verified 仍有价值，因为 Quilin 已经有对应本地实现面：dataset enum（数据集枚举）包含 `swe-bench-verified`，loader（加载器）记录 500 行预期，submission adapter（提交适配器）输出 SWE-bench 兼容 JSONL。不过当前本地 scorer（评分器）只用 `git apply --check` 检查 patch 是否可应用，因此还不等价于官方 SWE-bench 的解决判定语义。

The Quilin local coding slice should be built from curated Quilin tasks whose prompts, base commits, expected tests, acceptance notes, and hidden validation scripts are versioned separately from model-visible context. It should answer "does Quilin improve on its own engineering workflows?" rather than "does Quilin lead the public coding leaderboard?"

Quilin 本地代码切片应来自经筛选的 Quilin 任务，且 prompt（题面）、base commit（起始提交）、expected tests（预期测试）、acceptance notes（验收说明）和 hidden validation scripts（隐藏验证脚本）要与模型可见上下文分开版本化。它回答的问题应是“Quilin 是否提升了自身工程工作流”，而不是“Quilin 是否领先公开代码榜单”。

## 历史主指标设计 / Historical Primary Metric Design

The historical primary-metric design was SWE-bench Pro public Resolve Rate / Pass@1, reported as `resolved / completed / submitted / total` plus a percentage. This is not an active implementation requirement.

历史主指标设计是 SWE-bench Pro public Resolve Rate / Pass@1，用 `resolved / completed / submitted / total` 加百分比汇报。这不是当前实现要求。

If the user later restarts Benchmark work, any renewed report would need the exact dataset source, split, benchmark repository commit or release, Docker image strategy, scaffold/runtime version, model identifier, run date, and whether the run used the public leaderboard submission path or a local reproduction.

如果用户未来重启 Benchmark 工作，任何新报告都需要包含精确的数据源、split（数据切分）、基准仓库 commit 或 release、Docker image（容器镜像）策略、scaffold/runtime（脚手架 / 运行时）版本、模型标识、运行日期，以及本次运行是公开榜单提交还是本地复现。

## 历史回归指标设计 / Historical Regression Metric Design

The historical release-regression design was SWE-bench Verified full-set Resolve Rate using official SWE-bench harness semantics, not the current local `git apply --check` approximation. This is not an active release gate.

历史发布回归设计是使用官方 SWE-bench harness（评测运行器）语义的 SWE-bench Verified 全量 Resolve Rate，而不是当前本地 `git apply --check` 近似值。这不是当前发布门槛。

The historical local Quilin coding-slice idea reported two regression numbers: task resolve rate and regression-free rate. It remains frozen unless the user explicitly requests local Benchmark work.

历史 Quilin 本地代码切片想法会报告两个回归数字：task resolve rate（任务解决率）和 regression-free rate（无回归率）。除非用户明确要求本地 Benchmark 工作，否则该想法保持冻结。

## 报告格式 / Reporting Format

The historical report shape below is preserved only for context. It must not be used as an implementation task unless the user explicitly restarts Benchmark work.

下方历史报告形态只为上下文保留。除非用户明确重启 Benchmark 工作，不得把它用作实现任务。

```json
{
  "benchmark": "swe-bench-pro-public",
  "metric": "resolve_rate_pass_at_1",
  "resolved": 0,
  "completed": 0,
  "submitted": 0,
  "total": 731,
  "resolve_rate": 0,
  "dataset_source": "ScaleAI/SWE-bench_Pro",
  "dataset_split": "test/public",
  "benchmark_repo": "scaleapi/SWE-bench_Pro-os",
  "benchmark_commit": "<commit-or-release>",
  "model": "<model-id>",
  "scaffold": "<agent-runtime-id>",
  "quilin_commit": "<git-commit>",
  "run_id": "<stable-run-id>",
  "started_at": "<iso-8601>",
  "finished_at": "<iso-8601>",
  "cost_usd": 0,
  "latency_ms": 0,
  "artifacts": {
    "predictions": "<path-or-url>",
    "results": "<path-or-url>",
    "traces": "<path-or-url>",
    "failure_sample": "<path-or-url>"
  },
  "notes": [
    "Report whether this is official submission, local reproduction, CI smoke, or internal local slice."
  ]
}
```

For public reporting, use three labels: `primary` for SWE-bench Pro public, `legacy-regression` for SWE-bench Verified, and `internal-diagnostic` for Quilin local coding slice. Do not blend them into one aggregate score.

公开汇报时使用三个标签：`primary` 表示 SWE-bench Pro public，`legacy-regression` 表示 SWE-bench Verified，`internal-diagnostic` 表示 Quilin 本地代码切片。不要把三者混成一个总分。

## 本地实现差距 / Local Implementation Gaps

Local evidence from 2026-05-02 shows the current benchmark task schema only enumerates `swe-bench-lite`, `swe-bench-verified`, `gaia`, and `bfcl-v4`; it does not yet enumerate SWE-bench Pro. The runner also only marks those four datasets as runnable.

2026-05-02 的本地实证显示，当前 benchmark task schema（基准任务结构）只枚举了 `swe-bench-lite`、`swe-bench-verified`、`gaia` 和 `bfcl-v4`，尚未枚举 SWE-bench Pro。runner（运行器）也只把这四个数据集标为 runnable（可运行）。

Local evidence: `benchmarks/src/wire/task.ts` lines 5-10 define the dataset enum, and `benchmarks/src/runner/runner.ts` lines 164-169 define the runnable dataset set. `rg -n "SWE_BENCH_PRO|swe-bench-pro|SWE-bench Pro|swe-bench_Pro|ScaleAI/SWE-bench_Pro" benchmarks docs packages providers` found only the current docs mention in `docs/14-benchmark-harness/README.md`, not an implementation.

本地实证：`benchmarks/src/wire/task.ts` 第 5-10 行定义数据集枚举，`benchmarks/src/runner/runner.ts` 第 164-169 行定义可运行数据集集合。`rg -n "SWE_BENCH_PRO|swe-bench-pro|SWE-bench Pro|swe-bench_Pro|ScaleAI/SWE-bench_Pro" benchmarks docs packages providers` 只发现 `docs/14-benchmark-harness/README.md` 里的当前文档提及，没有发现实现。

Local evidence also shows the current SWE-bench scorer is a patch-application check, not a full official resolve-rate scorer. `benchmarks/src/scorers/swe-bench-patch-apply.ts` lines 39-92 construct a scorer around an injected `git apply --check` executor and mark success when that check exits zero.

本地实证还显示，当前 SWE-bench scorer 是 patch application check（补丁可应用性检查），不是完整官方 resolve-rate scorer（解决率评分器）。`benchmarks/src/scorers/swe-bench-patch-apply.ts` 第 39-92 行围绕注入的 `git apply --check` executor 构造评分器，并在该检查返回 0 时标记成功。

## QUI-47 冻结状态 / QUI-47 Frozen State

QUI-47 is canceled and low priority. It should not move to a replacement decision, loader implementation, submission adapter, or official scorer path unless the user explicitly requests Benchmark work.

QUI-47 已取消并降为低优先级。除非用户明确要求 Benchmark 工作，它不得推进替代决策、loader 实现、submission adapter 或官方 scorer path。

The only current accepted action is to leave this evidence pack as a frozen historical reference and keep current project status in [STATUS.md](../STATUS.md) and [Benchmark Harness](README.md).

当前唯一接受动作是把本证据包保留为冻结历史参考，并以 [STATUS.md](../STATUS.md) 与 [Benchmark Harness](README.md) 作为当前项目状态源。

## 参考链接 / References

- OpenAI, 2026-02-23: [Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- OpenAI, 2024-08: [Introducing SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/)
- SWE-bench official repository: [SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench)
- SWE-bench official evaluation docs: [Evaluation Guide](https://www.swebench.com/SWE-bench/guides/evaluation/)
- SWE-bench official dataset docs: [SWE-bench Datasets](https://www.swebench.com/SWE-bench/guides/datasets/)
- SWE-bench paper: [SWE-bench: Can Language Models Resolve Real-World GitHub Issues?](https://arxiv.org/abs/2310.06770)
- SWE-bench Pro paper: [SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?](https://arxiv.org/abs/2509.16941)
- SWE-bench Pro official repository: [scaleapi/SWE-bench_Pro-os](https://github.com/scaleapi/SWE-bench_Pro-os)
- SWE-bench Pro dataset card: [ScaleAI/SWE-bench_Pro](https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro)
- SWE-bench Pro public leaderboard: [SWE-Bench Pro Public Dataset](https://labs.scale.com/leaderboard/swe_bench_pro_public)
