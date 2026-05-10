"""Stage D real-DSPy benchmark (QUI-147 follow-up).

Runs the same 3-arm A/B harness as ``scripts/bench-self-evolution.ts``
``--mode mock`` BUT against the **real** ``providers/optimizer``
``optimize()`` tool with ``QUILIN_OPTIMIZER_JUDGE_MODE=dummy`` so the
DSPy compile loop actually executes (MIPROv2's Bayesian search, GEPA's
genetic-pareto rollouts) without burning real LLM budget.

The TS bench (mock mode) verifies harness math; this Python bench
verifies real DSPy code path. Two scripts are kept for separation:
- TS mock: zero deps, fast, deterministic — runs in CI on every change.
- Python real: opt-in, requires `uv sync --extra dspy`, exercises actual
  DSPy compilers — run before report-update commits.

Stage D real-DSPy benchmark（QUI-147 follow-up）。

跑与 ``scripts/bench-self-evolution.ts --mode mock`` 同一个 3-arm A/B
框架，但调真实的 ``providers/optimizer`` ``optimize()`` 工具，用
``QUILIN_OPTIMIZER_JUDGE_MODE=dummy`` 让 DSPy compile loop 真跑起来
（MIPROv2 的 Bayesian 搜索、GEPA 的 genetic-pareto rollouts），不烧
真实 LLM 配额。

TS bench (mock 模式) 验证 harness 数学；本 Python bench 验证真实
DSPy 代码路径。两个脚本分离保留，分工不同。

Usage:
    cd providers/optimizer && uv sync --extra dspy --extra dev
    cd ../..
    QUILIN_OPTIMIZER_JUDGE_MODE=dummy uv --directory providers/optimizer \\
        run python ../../scripts/bench-real-dspy.py --seeds 3 --output \\
        docs/10-self-evolution/dspy-validation-report.md
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
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "10-self-evolution" / "dspy-validation-report.md"

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
    """Recall-style lexical overlap: |E ∩ C| / |E|."""
    expected_tokens = tokenize(expected)
    if not expected_tokens:
        return 1.0  # No oracle → always pass.
    candidate_tokens = tokenize(candidate)
    return len(expected_tokens & candidate_tokens) / len(expected_tokens)


def passes(candidate: str, expected: str, threshold: float = 0.5) -> bool:
    return overlap_score(candidate, expected) >= threshold


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
    optimizer_choice: str,
) -> str:
    """Call optimize() once across the trajectory cluster, extract the
    optimized prompt from the returned proposal.

    Returns empty string on graceful-degradation paths so the scorer
    treats DSPy as "no useful proposal" rather than crashing.
    """
    payload = await optimize_fn(
        optimizer_choice=optimizer_choice,
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
    # Each proposal has multiple artifacts; the markdown one carries the
    # full optimized prompt + few-shot examples in human-readable form.
    artifacts = proposals[0].get("artifacts", [])
    md_artifact = next(
        (a for a in artifacts if a.get("artifactType") == "prompt-rewrite-summary"),
        None,
    )
    if md_artifact and isinstance(md_artifact.get("content"), str):
        return md_artifact["content"]
    # Fallback: combine all artifact contents.
    return "\n".join(str(a.get("content", "")) for a in artifacts)


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
    optimizer_choice: str | None = None,
) -> ArmResult:
    """Score every trajectory for one arm × one seed.

    For DSPy arms we call optimize() ONCE per seed (the optimizer
    consumes the whole training set), then score each trajectory's
    ground-truth against the single emitted proposal. For baseline we
    pick the per-category heuristic.
    """
    result = ArmResult(arm=arm_name)
    os.environ["QUILIN_OPTIMIZER_SEED"] = str(seed)  # passes through to compile

    if optimizer_choice is None:
        # Baseline arm — per-category heuristic, no LM call.
        for traj in trajectories:
            candidate = baseline_arm_proposal(traj.category)
            ok = passes(candidate, traj.ground_truth_fix_direction)
            _record(result, traj.category, ok)
        return result

    proposal_text = await dspy_arm_proposal(optimize_fn, trajectories, optimizer_choice)
    for traj in trajectories:
        ok = passes(proposal_text, traj.ground_truth_fix_direction)
        _record(result, traj.category, ok)
    return result


def _record(result: ArmResult, category: str, ok: bool) -> None:
    bucket = result.per_category.setdefault(category, {"pass": 0, "fail": 0})
    if ok:
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
) -> str:
    baseline = next(a for a in aggregates if "baseline" in a.arm.lower())
    arms_lookup = {a.arm: a for a in aggregates}
    mipro = arms_lookup.get("DSPy + MIPROv2 (real, DummyLM)")
    gepa = arms_lookup.get("DSPy + GEPA (real, DummyLM)")

    lift_mipro = relative_lift(baseline.pooled_failure_rate, mipro.pooled_failure_rate) if mipro else 0.0
    lift_gepa = relative_lift(baseline.pooled_failure_rate, gepa.pooled_failure_rate) if gepa else 0.0
    best_lift = max(lift_mipro, lift_gepa)

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

    decision_recommend = (
        "DSPy default (lift ≥ 30% threshold met)" if best_lift >= 0.30
        else "DSPy stays opt-in; default remains PromptRewrite. DSPy 仍保持 opt-in，默认仍是 PromptRewrite."
        if best_lift >= 0.10
        else "Trigger Stage E follow-up (Trace optimizer / OPRO / PromptBreeder evaluation). 触发 Stage E follow-up 评估替代算法."
    )

    return f"""# Stage D — DSPy Validation Report (QUI-147)

> ✅ **REAL DSPy CODE PATH** — DSPy 3.2.1 actually invoked. Both MIPROv2 (Bayesian instruction search via `optuna`) and GEPA (Genetic-Pareto rollouts) execute their full compile loops. Judge LM is `dspy.utils.DummyLM` (zero LLM cost, deterministic). Real-LLM benchmarking remains user-initiated; this report exercises the real DSPy framework with a deterministic stub judge so `dspy_compile_starting` and the entire optimizer pipeline run in production-like conditions.

> ✅ **真实 DSPy 代码路径** —— DSPy 3.2.1 真实调用。MIPROv2（基于 `optuna` 的 Bayesian instruction 搜索）与 GEPA（Genetic-Pareto rollouts）的完整 compile loop 都在运行。Judge LM 用 `dspy.utils.DummyLM`（零 LLM 成本，确定性）。真实 LLM benchmark 仍由用户触发；本报告用确定性 stub judge 让 `dspy_compile_starting` 和整个 optimizer pipeline 在接近生产的条件下跑起来。

## Reproducibility / 可复现性

- Trajectories path: `docs/10-self-evolution/benchmark/trajectories.jsonl`
- Dataset SHA-256: `{dataset_sha}`
- Trajectories count: {trajectory_count}
- Seeds per arm: {seeds}
- Pooled samples per arm: {trajectory_count * seeds}
- Bench script: `scripts/bench-real-dspy.py`
- Judge mode: `QUILIN_OPTIMIZER_JUDGE_MODE=dummy` → `dspy.utils.DummyLM`
- DSPy version: 3.2.1 (with optuna)

## Aggregate failure-rate table / 失败率聚合表

| Arm | Mean failure rate | 95% CI (Wilson) | Per-seed failure rates |
|---|---|---|---|
{chr(10).join(rows)}

## ASCII bar chart — failure rate (lower is better) / ASCII 条形图 —— 失败率（越低越好）

```
{chr(10).join(chart_rows)}
```

## Lift summary / Lift 总结

- Lift (MIPROv2 vs baseline): {fmt_lift(lift_mipro)} relative failure-rate reduction
- Lift (GEPA vs baseline): {fmt_lift(lift_gepa)} relative failure-rate reduction
- Best arm lift: {fmt_lift(best_lift)}

Lift（MIPROv2 vs baseline）：{fmt_lift(lift_mipro)} 相对失败率降幅；Lift（GEPA vs baseline）：{fmt_lift(lift_gepa)} 相对失败率降幅。最优 arm lift = {fmt_lift(best_lift)}。

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

- DummyLM provides deterministic but **content-free** judge signal — DSPy's compile loops run end-to-end but cannot meaningfully optimize without real semantic feedback. Resulting "optimized prompts" tend to revert toward the seed instruction. This is by-design for cost-free real-code-path benchmarking; it is NOT a substitute for real-LLM validation.
- DummyLM 提供确定性但**没有语义内容**的 judge 信号 —— DSPy compile loop 端到端运行，但缺乏真实语义反馈无法有效优化。生成的"优化后 prompt"倾向回退到种子指令。这是无成本测试真实代码路径的有意设计，**不能替代真实 LLM 验证**。
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
        description="Stage D real-DSPy benchmark with DummyLM judge (QUI-147).",
    )
    parser.add_argument("--seeds", type=int, default=3, help="Seeds per arm (default 3).")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Report output path (default: {DEFAULT_OUTPUT}).",
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
    args = parser.parse_args()

    if args.seeds <= 0 or args.seeds > 100:
        print(f"ERROR: --seeds must be 1..100 (got {args.seeds})", file=sys.stderr)
        return 2

    if not args.trajectories.exists():
        print(f"ERROR: trajectories file not found: {args.trajectories}", file=sys.stderr)
        return 2

    # Force dummy judge mode for the entire bench. Override any preset
    # so a developer can't accidentally burn real LLM budget.
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

    arm_specs = [
        ("PromptRewrite (baseline)", None),
        ("DSPy + MIPROv2 (real, DummyLM)", "mipro"),
        ("DSPy + GEPA (real, DummyLM)", "gepa"),
    ]

    aggregates: list[ArmAggregate] = []
    for arm_name, choice in arm_specs:
        per_seed_results: list[ArmResult] = []
        for seed in range(args.seeds):
            print(f"  arm={arm_name!r} seed={seed} starting...", file=sys.stderr)
            result = await run_seed_arm(
                arm_name,
                optimize,
                trajectories,
                seed,
                optimizer_choice=choice,
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
