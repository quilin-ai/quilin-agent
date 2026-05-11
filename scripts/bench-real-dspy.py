"""Stage D real-DSPy GEPA benchmark (QUI-147 follow-up).

Runs a **2-arm A/B harness** against the **real** ``providers/optimizer``
``optimize()`` tool, so the DSPy GEPA compile loop (Genetic-Pareto
reflective prompt evolution; ICLR 2026 Oral) actually executes.

The two arms are:

- ``PromptRewrite (bench-only baseline)``: deterministic per-category
  heuristic mirror of the legacy TS PromptRewriteOptimizer. Kept as
  bench-internal infrastructure ONLY — it was removed as a user-config
  optimizer choice on 2026-05-12 (see
  ``docs/10-self-evolution/README.md`` §2.4).
- ``DSPy + GEPA``: the singular production optimizer.

Two judge-LM modes (``--mode`` flag):

- ``--mode dummy`` (default): ``dspy.utils.DummyLM`` judge, zero LLM cost.
  Validates DSPy code-path wiring. Reports to
  ``docs/10-self-evolution/dspy-validation-report.md``.
- ``--mode llm``: real LLM judge driven by ``QUILIN_OPTIMIZER_JUDGE_*``
  env vars. Requires ``--confirm-real-llm-cost`` flag to acknowledge
  the per-run cost. Reports to
  ``docs/10-self-evolution/dspy-validation-report-real-llm.md``.

The TS bench (``scripts/bench-self-evolution.ts``, mock mode) verifies
harness math; this Python bench verifies real DSPy code path. Two
scripts are kept for separation:

- TS mock: zero deps, fast, deterministic — runs in CI on every change.
- Python real: requires ``dspy-ai`` (now a hard dep of
  ``providers/optimizer``), exercises the real DSPy compiler.

Stage D real-DSPy GEPA benchmark（QUI-147 follow-up）。

跑 **2-arm A/B 框架**，调真实的 ``providers/optimizer`` ``optimize()`` 工具，
让 DSPy GEPA（Genetic-Pareto 反射式 prompt 进化；ICLR 2026 Oral）真跑起来。

两个 arm：

- ``PromptRewrite (bench-only baseline)``：确定性 per-category 启发式，
  镜像旧的 TS ``PromptRewriteOptimizer`` 逻辑。**只作为 bench 内部基础设施**
  保留，2026-05-12 已从用户可选 optimizer 中删除（见
  ``docs/10-self-evolution/README.md`` §2.4）。
- ``DSPy + GEPA``：生产唯一 optimizer。

通过 ``--mode`` 切换 judge LM：

- ``--mode dummy``（默认）：用 ``dspy.utils.DummyLM`` 当 judge，零成本，
  验证 DSPy 代码路径接线。报告写到 ``dspy-validation-report.md``。
- ``--mode llm``：真实 LLM 评委，读 ``QUILIN_OPTIMIZER_JUDGE_*`` env，
  需要 ``--confirm-real-llm-cost`` 显式确认烧钱。报告写到
  ``dspy-validation-report-real-llm.md``。

TS bench（``scripts/bench-self-evolution.ts``，mock 模式）验证 harness
数学；本 Python bench 验证真实 DSPy 代码路径。两个脚本分离保留，分工不同。

Usage:
    # `dspy-ai` is now a hard dep of providers/optimizer — `uv sync`
    # in providers/optimizer (no `--extra`) pulls it.
    # Dummy mode (no cost, validates wiring):
    uv --directory providers/optimizer run python \\
        ../../scripts/bench-real-dspy.py --seeds 3
    # Real-LLM mode (requires QUILIN_OPTIMIZER_JUDGE_API_KEY in env):
    uv --directory providers/optimizer run python \\
        ../../scripts/bench-real-dspy.py --mode llm \\
        --confirm-real-llm-cost --seeds 3
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Path bootstrap — script can run from anywhere; resolve repo paths.
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
TRAJECTORIES_PATH = REPO_ROOT / "docs" / "10-self-evolution" / "benchmark" / "trajectories.jsonl"
DEFAULT_OUTPUT_DUMMY = REPO_ROOT / "docs" / "10-self-evolution" / "dspy-validation-report.md"
DEFAULT_OUTPUT_LLM = REPO_ROOT / "docs" / "10-self-evolution" / "dspy-validation-report-real-llm.md"

# Make providers/optimizer importable when this script is run directly.
sys.path.insert(0, str(REPO_ROOT / "providers" / "optimizer" / "src"))


# ---------------------------------------------------------------------------
# Trajectory + Wilson + scoring (mirrors TS replay-harness logic)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Trajectory:
    id: str
    category: str
    task: str
    failure_signal: str
    ground_truth_fix_direction: str


def load_trajectories(path: Path) -> list[Trajectory]:
    """Load JSONL trajectories. Skips blank lines defensively."""
    out: list[Trajectory] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        record = json.loads(line)
        out.append(
            Trajectory(
                id=str(record["id"]),
                category=str(record.get("category", "unknown")),
                task=str(record.get("task", "")),
                failure_signal=str(record.get("failure_signal", "")),
                ground_truth_fix_direction=str(record.get("ground_truth_fix_direction", "")),
            )
        )
    return out


def dataset_sha256(path: Path) -> str:
    """Hash of the raw JSONL file — locks reproducibility per report."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


# Python's standard re does not support \p{L}; the TS replay-harness
# uses /[\p{L}\p{N}]+/u, which approximates to Latin letters / digits +
# the CJK Unified Ideographs block (U+4E00-U+9FFF) for our trajectories.
# This is good-enough for keyword overlap on the synthetic corpus; for
# wider Unicode coverage a future iteration can switch to the `regex`
# package or strip via `unicodedata.category`.
_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9一-鿿]+")


def tokenize(text: str) -> set[str]:
    """Tokenize for keyword-overlap scoring (mirrors TS replay-harness)."""
    return {tok.lower() for tok in _TOKEN_PATTERN.findall(text or "") if len(tok) >= 3}


def overlap_score(candidate: str, expected: str) -> float:
    """Recall-style lexical overlap: |E ∩ C| / |E|.

    Returns ``-1.0`` when there is no oracle (empty expected). The
    bench harness treats this sentinel as "exclude from denominator"
    rather than "auto-pass" — see ``passes()`` and ``run_seed_arm``.
    Inside DSPy's compile loop the same "no oracle" case would return
    1.0 (unsupervised optimization), but for benchmarking the right
    behavior is to drop the trajectory entirely.

    返回 ``-1.0`` 表示无 oracle（``expected`` 为空）。bench 把这条
    哨兵值当作"从分母里剔除"，不是"自动通过"。
    """
    expected_tokens = tokenize(expected)
    if not expected_tokens:
        return -1.0
    candidate_tokens = tokenize(candidate)
    return len(expected_tokens & candidate_tokens) / len(expected_tokens)


def passes(candidate: str, expected: str, threshold: float = 0.5) -> bool | None:
    """Return True/False on a real oracle, ``None`` when oracle is empty.

    ``None`` signals "skip this trajectory from the bench denominator";
    callers that ignore the sentinel will treat the no-oracle case as
    failure (safer default than auto-pass).
    """
    score = overlap_score(candidate, expected)
    if score < 0:
        return None
    return score >= threshold


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson 95% CI. Returns [lower, upper] in [0, 1].

    For total = 0, returns (0.0, 1.0) — no information.
    """
    if total == 0:
        return (0.0, 1.0)
    p_hat = successes / total
    z2 = z * z
    denom = 1.0 + z2 / total
    center = (p_hat + z2 / (2 * total)) / denom
    margin = z * math.sqrt(p_hat * (1 - p_hat) / total + z2 / (4 * total * total)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


# ---------------------------------------------------------------------------
# Baseline arm: PromptRewrite-style heuristic (mirrors TS PromptRewriteOptimizer)
# ---------------------------------------------------------------------------


# Per-category heuristic prompts. Mirrors the deterministic templates the
# TS PromptRewriteOptimizer emits for each FailureCategory cluster — they
# describe the right fix direction at a high level. The keyword-overlap
# scorer rewards prompts whose tokens overlap with the trajectory's
# ground_truth_fix_direction.
_BASELINE_PROMPTS: dict[str, str] = {
    "tool_error": "Add a preflight check before invoking shell commands; verify command exists and inputs are valid.",
    "schema_violation": "Validate output shape against the expected schema before responding; reject mismatches.",
    "budget_exhaustion": "Cap retry count and monitor remaining token budget; exit cleanly when budget is near.",
    "missing_evidence": "Cite a verified source URL before stating any external fact; mark unverified claims explicitly.",
    "unknown": "Re-anchor on the original task before each subtask; abort planning drift early.",
}


def baseline_arm_proposal(category: str) -> str:
    return _BASELINE_PROMPTS.get(category, _BASELINE_PROMPTS["unknown"])


# ---------------------------------------------------------------------------
# DSPy arm: real ``optimize()`` with ``QUILIN_OPTIMIZER_JUDGE_MODE=dummy``
# ---------------------------------------------------------------------------


def _trajectory_to_optimize_input(traj: Trajectory) -> dict[str, object]:
    """Shape a single trajectory for the optimize() tool."""
    return {
        "trajectoryRef": f"trajectory:{traj.id}",
        "runId": traj.id,
        "taskRef": "QUI-147-bench",
        "taskInput": traj.task,
        "expectedOutput": traj.ground_truth_fix_direction,
    }


async def dspy_arm_proposal(
    optimize_fn,
    trajectories: list[Trajectory],
) -> str:
    """Call optimize() once across the trajectory cluster (GEPA implicit
    post 2026-05-12), extract the optimized prompt from the returned
    proposal.

    Returns empty string on graceful-degradation paths so the scorer
    treats DSPy as "no useful proposal" rather than crashing.
    """
    payload = await optimize_fn(
        trajectories=[_trajectory_to_optimize_input(t) for t in trajectories],
        failure_categories=sorted({t.category for t in trajectories}),
        dry_run=False,
    )
    text = payload if isinstance(payload, str) else "\n".join(
        getattr(item, "text", "")
        for item in getattr(payload, "content", [])
        if getattr(item, "type", None) == "text"
    )
    decoded = json.loads(text)
    proposals = decoded.get("proposals", [])
    if not proposals:
        return ""
    # Each proposal has multiple artifacts; the one with kind="markdown"
    # carries the human-readable optimized prompt + few-shot examples.
    # The kind="json" artifact serializes the same content plus internal
    # metadata (optimizer_choice, trajectory refs, failure_categories);
    # mixing JSON serialization into the candidate string adds spurious
    # token overlap with ground-truth-fix-direction (e.g. the substring
    # "tool_error" appearing in `"failure_categories": ["tool_error"]`),
    # so we ONLY use the markdown artifact for scoring.
    #
    # Reviewer A QUI-147 round-3 caught this — earlier code looked up
    # `artifactType` (a field that doesn't exist on the server side, so
    # the lookup always fell through to a concatenation fallback that
    # mixed markdown + JSON). The server uses the field name `kind`.
    artifacts = proposals[0].get("artifacts", [])
    md_artifact = next(
        (a for a in artifacts if a.get("kind") == "markdown"),
        None,
    )
    if md_artifact and isinstance(md_artifact.get("content"), str):
        return md_artifact["content"]
    # Defensive fallback when the server omits the markdown artifact —
    # should not happen in practice for dspy proposals. Prefer empty
    # candidate over JSON-contaminated text.
    return ""


# ---------------------------------------------------------------------------
# Per-seed run
# ---------------------------------------------------------------------------


@dataclass
class ArmResult:
    arm: str
    pass_count: int = 0
    fail_count: int = 0
    per_category: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return self.pass_count + self.fail_count

    @property
    def failure_rate(self) -> float:
        if self.total == 0:
            return 0.0
        return self.fail_count / self.total


async def run_seed_arm(
    arm_name: str,
    optimize_fn,
    trajectories: list[Trajectory],
    seed: int,
    *,
    is_dspy_arm: bool = False,
) -> ArmResult:
    """Score every trajectory for one arm × one seed.

    For the DSPy GEPA arm we call optimize() ONCE per seed (the optimizer
    consumes the whole training set), then score each trajectory's
    ground-truth against the single emitted proposal. For baseline we
    pick the per-category heuristic.
    """
    result = ArmResult(arm=arm_name)
    os.environ["QUILIN_OPTIMIZER_SEED"] = str(seed)  # passes through to compile

    if not is_dspy_arm:
        # Baseline arm — per-category heuristic, no LM call.
        for traj in trajectories:
            candidate = baseline_arm_proposal(traj.category)
            outcome = passes(candidate, traj.ground_truth_fix_direction)
            _record(result, traj.category, outcome)
        return result

    proposal_text = await dspy_arm_proposal(optimize_fn, trajectories)
    for traj in trajectories:
        outcome = passes(proposal_text, traj.ground_truth_fix_direction)
        _record(result, traj.category, outcome)
    return result


def _record(result: ArmResult, category: str, outcome: bool | None) -> None:
    """Record one trajectory outcome.

    ``outcome=None`` means "no oracle, skip from denominator" — the
    trajectory contributes neither pass nor fail. This prevents empty
    ``ground_truth_fix_direction`` entries from silently inflating
    pass-rate (which would happen if `overlap_score` returned 1.0 for
    no-oracle case).
    """
    bucket = result.per_category.setdefault(category, {"pass": 0, "fail": 0})
    if outcome is None:
        return  # excluded from this arm's denominator
    if outcome:
        result.pass_count += 1
        bucket["pass"] += 1
    else:
        result.fail_count += 1
        bucket["fail"] += 1


# ---------------------------------------------------------------------------
# Pool seeds + render report
# ---------------------------------------------------------------------------


@dataclass
class ArmAggregate:
    arm: str
    per_seed: list[ArmResult]

    @property
    def pooled_pass(self) -> int:
        return sum(r.pass_count for r in self.per_seed)

    @property
    def pooled_fail(self) -> int:
        return sum(r.fail_count for r in self.per_seed)

    @property
    def pooled_total(self) -> int:
        return self.pooled_pass + self.pooled_fail

    @property
    def pooled_failure_rate(self) -> float:
        if self.pooled_total == 0:
            return 0.0
        return self.pooled_fail / self.pooled_total

    @property
    def pooled_ci(self) -> tuple[float, float]:
        return wilson_interval(self.pooled_fail, self.pooled_total)

    @property
    def per_seed_failure_rates(self) -> list[float]:
        return [r.failure_rate for r in self.per_seed]

    @property
    def pooled_per_category(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for r in self.per_seed:
            for cat, bucket in r.per_category.items():
                pooled = out.setdefault(cat, {"pass": 0, "fail": 0})
                pooled["pass"] += bucket["pass"]
                pooled["fail"] += bucket["fail"]
        return out


def relative_lift(baseline_rate: float, candidate_rate: float) -> float:
    """Same semantics as TS bench: -Infinity when baseline=0 + candidate>0."""
    if baseline_rate <= 0:
        if candidate_rate > 0:
            return float("-inf")
        return 0.0
    return (baseline_rate - candidate_rate) / baseline_rate


def fmt_pct(rate: float) -> str:
    if rate == float("-inf"):
        return "−∞"
    return f"{rate * 100:.1f}%"


def fmt_lift(lift: float) -> str:
    if lift == float("-inf"):
        return "−∞ (regression from perfect baseline)"
    return f"{lift * 100:.1f}%"


def render_report(
    aggregates: list[ArmAggregate],
    *,
    trajectory_count: int,
    seeds: int,
    dataset_sha: str,
    judge_mode: str,
    judge_model: str = "(default)",
) -> str:
    baseline = next(a for a in aggregates if "baseline" in a.arm.lower())
    arms_lookup = {a.arm: a for a in aggregates}
    gepa = arms_lookup.get("DSPy + GEPA")

    lift_gepa = (
        relative_lift(baseline.pooled_failure_rate, gepa.pooled_failure_rate)
        if gepa
        else 0.0
    )
    best_lift = lift_gepa

    def bucket_for(lift: float) -> str:
        if lift >= 0.30:
            return "lift ≥ 30%"
        if lift >= 0.10:
            return "10% ≤ lift < 30%"
        return "lift < 10%"

    bucket = bucket_for(best_lift)

    def bar(rate: float, width: int = 40) -> str:
        filled = round(rate * width)
        return "█" * filled + "░" * (width - filled)

    rows = [
        f"| {a.arm} | {fmt_pct(a.pooled_failure_rate)} | [{fmt_pct(a.pooled_ci[0])}, {fmt_pct(a.pooled_ci[1])}] | "
        f"{', '.join(fmt_pct(r) for r in a.per_seed_failure_rates)} |"
        for a in aggregates
    ]

    chart_rows = [
        f"{a.arm:<35} | {bar(a.pooled_failure_rate)} {fmt_pct(a.pooled_failure_rate)}"
        for a in aggregates
    ]

    cat_set: set[str] = set()
    for a in aggregates:
        cat_set.update(a.pooled_per_category.keys())
    cat_order = sorted(cat_set)
    cat_rows = []
    for cat in cat_order:
        cells = []
        for a in aggregates:
            bucket_cat = a.pooled_per_category.get(cat, {"pass": 0, "fail": 0})
            total = bucket_cat["pass"] + bucket_cat["fail"]
            rate = bucket_cat["fail"] / total if total else 0.0
            cells.append(fmt_pct(rate))
        cat_rows.append(f"| {cat} | " + " | ".join(cells) + " |")

    # Reviewer B QUI-147 round-3 caught: dummy-mode runs MUST NOT
    # trigger the §2.4.0.1 decision ladder, because DummyLM provides
    # content-free judge signal — the lift bucket is meaningless.
    # Override the recommendation in dummy mode regardless of bucket.
    if judge_mode == "dummy":
        bucket = "suppressed (DummyLM mode)"
        decision_recommend = (
            "Decision suppressed — this run uses dspy.utils.DummyLM, which provides "
            "deterministic but content-free judge signal. The §2.4.0.1 lift ladder "
            "(≥ 30% / 10–30% / < 10%) only applies when the judge is a real LLM. "
            "Real-LLM bench is the actual gate; this run only verifies the DSPy "
            "framework wiring. 决策暂缓 —— 本次跑用 DummyLM，judge 信号没有语义内容，"
            "§2.4.0.1 的 lift 阈值仅在真实 LLM judge 下有效。本次跑只验证 DSPy "
            "框架接线，正式决策需要真实 LLM bench。"
        )
    else:
        # Decision-ladder strings are kept as informational signals only.
        # Post 2026-05-12 GEPA-only refactor the *picking* decision is
        # closed (GEPA is the singular optimizer per
        # docs/10-self-evolution/README.md §2.4); this bench now measures
        # the *size* of GEPA's contribution rather than choosing among
        # alternatives. The bucket text still ladder-grades the lift for
        # operator readability.
        decision_recommend = (
            "GEPA lift exceeds 30% — strong contribution. GEPA 贡献显著（lift ≥ 30%）。"
            if best_lift >= 0.30
            else "GEPA lift in the moderate 10–30% band. GEPA 贡献中等（10% ≤ lift < 30%）。"
            if best_lift >= 0.10
            else "GEPA lift below 10% — investigate whether the scoring metric or dataset is masking signal (see §2.4 historical context for the keyword-overlap fragility). GEPA lift 低于 10% —— 检查评分指标或数据集是否压制了信号。"
        )

    if judge_mode == "dummy":
        banner_en = (
            "✅ **REAL DSPy CODE PATH** — DSPy 3.2.1 actually invoked. The "
            "GEPA compiler (Genetic-Pareto reflective prompt evolution; "
            "ICLR 2026 Oral) executes its full compile loop. Judge LM is "
            "`dspy.utils.DummyLM` (zero LLM cost, deterministic). Real-LLM "
            "benchmarking remains user-initiated; this report exercises "
            "the real DSPy framework with a deterministic stub judge so "
            "`dspy_compile_starting` and the entire optimizer pipeline run "
            "in production-like conditions."
        )
        banner_zh = (
            "✅ **真实 DSPy 代码路径** —— DSPy 3.2.1 真实调用。GEPA 编译器"
            "（Genetic-Pareto 反射式 prompt 进化；ICLR 2026 Oral）的完整 "
            "compile loop 都在运行。Judge LM 用 `dspy.utils.DummyLM`（零 LLM "
            "成本，确定性）。真实 LLM benchmark 仍由用户触发；本报告用确定性 "
            "stub judge 让 `dspy_compile_starting` 和整个 optimizer pipeline "
            "在接近生产的条件下跑起来。"
        )
        judge_mode_line = "`QUILIN_OPTIMIZER_JUDGE_MODE=dummy` → `dspy.utils.DummyLM`"
        caveats_block = (
            "- DummyLM provides deterministic but **content-free** judge signal — "
            "DSPy's compile loops run end-to-end but cannot meaningfully optimize "
            "without real semantic feedback. Resulting \"optimized prompts\" tend "
            "to revert toward the seed instruction. This is by-design for "
            "cost-free real-code-path benchmarking; it is NOT a substitute for "
            "real-LLM validation.\n"
            "- DummyLM 提供确定性但**没有语义内容**的 judge 信号 —— DSPy compile loop "
            "端到端运行，但缺乏真实语义反馈无法有效优化。生成的\"优化后 prompt\"倾向回退到种子指令。"
            "这是无成本测试真实代码路径的有意设计，**不能替代真实 LLM 验证**。"
        )
    else:
        banner_en = (
            "🔥 **REAL LLM JUDGE** — DSPy 3.2.1 actually invoked with a real "
            f"LLM judge (`{judge_model}`). The GEPA compiler (Genetic-Pareto "
            "reflective prompt evolution; ICLR 2026 Oral) gets **real "
            "semantic feedback** during compile — this is the canonical lift "
            "measurement, not a code-path smoke test."
        )
        banner_zh = (
            f"🔥 **真实 LLM 评委** —— DSPy 3.2.1 真实调用，judge 用真实 LLM（`{judge_model}`）。"
            "GEPA 编译器（Genetic-Pareto 反射式 prompt 进化；ICLR 2026 Oral）在 compile "
            "loop 中**获得真实语义反馈** —— 本次是 lift 的正式测量，不再是代码路径冒烟测试。"
        )
        judge_mode_line = f"`QUILIN_OPTIMIZER_JUDGE_MODE=llm` → real LLM (`{judge_model}`)"
        caveats_block = (
            f"- Real-LLM judge (`{judge_model}`) provides semantic feedback, but "
            "results are **deterministic across seeds** when the judge model "
            "runs at low temperature — Wilson CI is computed over pooled samples "
            "but per-seed variance may be zero. Treat the CI as a sample-size "
            "bound, not a randomness bound.\n"
            f"- 真实 LLM 评委（`{judge_model}`）提供语义反馈，但 judge 在低温下"
            "**跨 seed 输出确定**时，per-seed 方差可能为零。Wilson CI 反映样本量界限，"
            "不反映随机性界限。\n"
            "- Judge LM JSON-adapter failures (DeepSeek struggles with structured "
            "output) may inflate failure rates artificially; cross-validate with "
            "another judge model before treating absolute lift as canonical.\n"
            "- Judge LM 的 JSON adapter 报错（DeepSeek 结构化输出弱）可能拉高失败率，"
            "把 lift 当正式数据前需要用另一个评委模型交叉验证。"
        )

    return f"""# Stage D — DSPy Validation Report (QUI-147)

> {banner_en}

> {banner_zh}

## Reproducibility / 可复现性

- Trajectories path: `docs/10-self-evolution/benchmark/trajectories.jsonl`
- Dataset SHA-256: `{dataset_sha}`
- Trajectories count: {trajectory_count}
- Seeds per arm: {seeds}
- Pooled samples per arm: {trajectory_count * seeds}
- Bench script: `scripts/bench-real-dspy.py`
- Judge mode: {judge_mode_line}
- DSPy version: 3.2.1
- Optimizer: DSPy GEPA (singular post 2026-05-12; see README §2.4)

## Aggregate failure-rate table / 失败率聚合表

| Arm | Mean failure rate | 95% CI (Wilson) | Per-seed failure rates |
|---|---|---|---|
{chr(10).join(rows)}

## ASCII bar chart — failure rate (lower is better) / ASCII 条形图 —— 失败率（越低越好）

```
{chr(10).join(chart_rows)}
```

## Lift summary / Lift 总结

- Lift (GEPA vs baseline): {fmt_lift(lift_gepa)} relative failure-rate reduction

Lift（GEPA vs baseline）：{fmt_lift(lift_gepa)} 相对失败率降幅。

## Per-FailureCategory breakdown / 按失败类型拆分

| Category | {' | '.join(a.arm for a in aggregates)} |
|---|{'|'.join('---' for _ in aggregates)}|
{chr(10).join(cat_rows)}

## Decision recommendation / 决策建议

- Bucket: **{bucket}**
- Recommendation: {decision_recommend}

Decision branches per docs/10-self-evolution/README.md §2.4.0.1: lift ≥ 30% → DSPy default; 10–30% → DSPy opt-in; < 10% → trigger Stage E.

决策分支依据 docs/10-self-evolution/README.md §2.4.0.1：lift ≥ 30% → DSPy 转默认；10–30% → DSPy 仍 opt-in；< 10% → 触发 Stage E follow-up。

## Caveats / 限制说明

{caveats_block}
- Replay scoring is keyword-overlap based; it does not re-execute the agent loop end-to-end.
- Replay 评分基于关键字重叠，没有完整重跑 agent loop。
- Synthetic 50-trajectory dataset (not real production traces). Real ≥200 prod-trace dataset is the canonical Stage D follow-up.
- 50 条合成 trajectory（非真实生产轨迹）。≥200 条真实 prod-trace 数据集是经典 Stage D follow-up。
"""


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


async def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Stage D real-DSPy benchmark (QUI-147). Supports both dummy "
            "(DummyLM, default, zero LLM cost) and llm (real judge LM, "
            "requires --confirm-real-llm-cost) modes."
        ),
    )
    parser.add_argument("--seeds", type=int, default=3, help="Seeds per arm (default 3).")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help=(
            "Report output path. Defaults to dspy-validation-report.md "
            "(dummy mode) or dspy-validation-report-real-llm.md (llm mode)."
        ),
    )
    parser.add_argument(
        "--trajectories",
        type=Path,
        default=TRAJECTORIES_PATH,
        help=f"Trajectories JSONL path (default: {TRAJECTORIES_PATH}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run all arms but do not write the report file.",
    )
    parser.add_argument(
        "--mode",
        choices=["dummy", "llm"],
        default="dummy",
        help=(
            "Judge LM mode. 'dummy' (default) = zero-cost DummyLM, validates "
            "code path. 'llm' = real API spend, requires --confirm-real-llm-cost "
            "and QUILIN_OPTIMIZER_JUDGE_API_KEY in env."
        ),
    )
    parser.add_argument(
        "--confirm-real-llm-cost",
        action="store_true",
        help=(
            "Required when --mode=llm. Acknowledges that the bench will issue "
            "real LLM calls (thousands per run) and incur cost on the configured "
            "judge model."
        ),
    )
    args = parser.parse_args()

    # Resolve --output default based on --mode (post-parse so we know args.mode).
    # Splitting paths prevents an llm-mode rerun from silently overwriting the
    # dummy-mode canonical report (and vice versa). HIGH issue caught by
    # Round-1 Reviewer B QUI-152 E-1 follow-up.
    if args.output is None:
        args.output = DEFAULT_OUTPUT_LLM if args.mode == "llm" else DEFAULT_OUTPUT_DUMMY

    if args.seeds <= 0 or args.seeds > 100:
        print(f"ERROR: --seeds must be 1..100 (got {args.seeds})", file=sys.stderr)
        return 2

    if not args.trajectories.exists():
        print(f"ERROR: trajectories file not found: {args.trajectories}", file=sys.stderr)
        return 2

    if args.mode == "llm":
        if not args.confirm_real_llm_cost:
            print(
                "ERROR: --mode=llm requires --confirm-real-llm-cost to unlock "
                "real-API spend",
                file=sys.stderr,
            )
            return 2
        if not os.environ.get("QUILIN_OPTIMIZER_JUDGE_API_KEY"):
            print(
                "ERROR: --mode=llm requires QUILIN_OPTIMIZER_JUDGE_API_KEY in "
                "env (set in .env or export)",
                file=sys.stderr,
            )
            return 2
        # Activate real LLM mode for the entire bench. Don't strip the key;
        # the server.py judge LM constructor reads it through OptimizerConfig.
        os.environ["QUILIN_OPTIMIZER_JUDGE_MODE"] = "llm"
        print(
            f"  ⚠ real-LLM mode unlocked: model="
            f"{os.environ.get('QUILIN_OPTIMIZER_JUDGE_MODEL', '(default)')} "
            f"base_url={os.environ.get('QUILIN_OPTIMIZER_JUDGE_BASE_URL', '(litellm default)')}",
            file=sys.stderr,
        )
    else:
        # Default safety: force dummy judge mode for the entire bench.
        # Override any preset so a developer can't accidentally burn real
        # LLM budget by exporting JUDGE_MODE=llm before invoking the bench.
        os.environ["QUILIN_OPTIMIZER_JUDGE_MODE"] = "dummy"
        # Strip any real API key so a leaked env can't be picked up.
        os.environ.pop("QUILIN_OPTIMIZER_JUDGE_API_KEY", None)

    # Lazy import to keep the script importable without dspy installed
    # (e.g., for --help on a fresh checkout).
    from quilin_optimizer.server import optimize  # noqa: PLC0415

    trajectories = load_trajectories(args.trajectories)
    dataset_sha = dataset_sha256(args.trajectories)
    print(f"loaded {len(trajectories)} trajectories from {args.trajectories}", file=sys.stderr)
    print(f"dataset sha-256: {dataset_sha}", file=sys.stderr)

    # 2-arm comparison post 2026-05-12 GEPA-only refactor. The MIPROv2 arm
    # was deleted along with the singular-optimizer decision in
    # docs/10-self-evolution/README.md §2.4. PromptRewrite is bench-only
    # baseline (not user-selectable).
    arm_specs: list[tuple[str, bool]] = [
        ("PromptRewrite (bench-only baseline)", False),
        ("DSPy + GEPA", True),
    ]

    aggregates: list[ArmAggregate] = []
    for arm_name, is_dspy_arm in arm_specs:
        per_seed_results: list[ArmResult] = []
        for seed in range(args.seeds):
            print(f"  arm={arm_name!r} seed={seed} starting...", file=sys.stderr)
            result = await run_seed_arm(
                arm_name,
                optimize,
                trajectories,
                seed,
                is_dspy_arm=is_dspy_arm,
            )
            print(
                f"  arm={arm_name!r} seed={seed} done: "
                f"{result.pass_count} pass / {result.fail_count} fail "
                f"({fmt_pct(result.failure_rate)})",
                file=sys.stderr,
            )
            per_seed_results.append(result)
        aggregates.append(ArmAggregate(arm=arm_name, per_seed=per_seed_results))

    report = render_report(
        aggregates,
        trajectory_count=len(trajectories),
        seeds=args.seeds,
        dataset_sha=dataset_sha,
        judge_mode=os.environ.get("QUILIN_OPTIMIZER_JUDGE_MODE", "dummy"),
        judge_model=os.environ.get("QUILIN_OPTIMIZER_JUDGE_MODEL", "(default)"),
    )

    if args.dry_run:
        sys.stdout.write(report)
        return 0

    args.output.write_text(report, encoding="utf-8")
    print(f"\nreport written to {args.output}", file=sys.stderr)
    print("\n=== summary ===", file=sys.stderr)
    for a in aggregates:
        print(
            f"{a.arm}: pooled {fmt_pct(a.pooled_failure_rate)} "
            f"[{fmt_pct(a.pooled_ci[0])}, {fmt_pct(a.pooled_ci[1])}] "
            f"per-seed {[fmt_pct(r) for r in a.per_seed_failure_rates]}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
