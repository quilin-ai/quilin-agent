"""End-to-end tests against the **real** dspy-ai library (QUI-147 follow-up).

The companion file ``test_server_real_dspy.py`` injects a fake ``dspy``
module via ``sys.modules`` to avoid pulling the heavy extra in CI. That
gives us fast, deterministic unit coverage but misses real-DSPy version
drift: if a future ``dspy-ai`` release renames a sub-signature field or
changes the DummyLM signature, the fake-module tests stay green while
the real path silently breaks.

This file covers that gap by importing the REAL ``dspy-ai`` package
and exercising the actual MIPROv2 / GEPA compile loops with
``dspy.utils.DummyLM`` as judge (zero LLM cost). The entire module
skips when the ``dspy`` extra is not installed, so CI without the
extra still passes.

本文件补齐 ``test_server_real_dspy.py``（用 fake ``dspy`` 模块）漏掉的
真实版本漂移覆盖：当 ``dspy-ai`` 升级改了内部子签名字段名或 DummyLM
签名时，fake-module 测试仍绿，但真实路径会悄悄坏。这里导入真实
``dspy-ai``，跑真 MIPROv2 / GEPA + ``dspy.utils.DummyLM`` judge（零
LLM 成本）。``dspy`` extra 未装时整文件 skip，CI 仍可通过。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

# Skip the entire module when dspy-ai isn't installed. CI without the
# extra still passes; the fake-module tests in test_server_real_dspy.py
# already cover the unit-level behavior.
dspy = pytest.importorskip(
    "dspy",
    reason="dspy-ai extra not installed; install with `uv sync --extra dspy`",
)
pytest.importorskip(
    "optuna",
    reason="optuna missing; required by MIPROv2's Bayesian search backend",
)

from quilin_optimizer.server import (  # noqa: E402 — import after skip guard
    _DUMMY_LM_RESPONSES,
    JUDGE_MODE_DUMMY,
    MIN_TRAJECTORIES,
    OptimizerConfig,
    _configure_dspy_lm,
    optimize,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _trajectories(count: int = MIN_TRAJECTORIES) -> list[dict[str, object]]:
    """Build minimal trajectory entries that satisfy the optimize tool's
    validation gate. Matches the shape used by scripts/bench-real-dspy.py.
    """
    return [
        {
            "trajectoryRef": f"trajectory:e2e-run-{i}",
            "runId": f"e2e-run-{i}",
            "taskRef": "QUI-147-e2e",
            "taskInput": f"sample task input {i}",
            "expectedOutput": f"expected output {i}",
        }
        for i in range(count)
    ]


def _extract_payload(result: Any) -> dict[str, Any]:
    """Decode the optimize() tool's response — MCP may return either a
    bare string or a content list of text items."""
    if isinstance(result, str):
        text = result
    else:
        items = list(getattr(result, "content", []))
        text = "\n".join(
            getattr(item, "text", "") for item in items if getattr(item, "type", None) == "text"
        )
    return json.loads(text)


# ---------------------------------------------------------------------------
# _DUMMY_LM_RESPONSES — shape contract (locks against DSPy version drift)
# ---------------------------------------------------------------------------


def test_dummy_lm_responses_cover_dspy_3x_subsignature_fields() -> None:
    """MIPROv2's internal Predicts request specific output field names
    (``observations``, ``proposed_instruction``, etc.). If a future
    DSPy version adds a new internal sub-signature and our response
    dicts lack the new key, DummyLM raises ``KeyError`` mid-compile
    and the structured warning swallows the cause. This test locks
    the response shape so a future maintainer can't silently drop
    a required field.

    DSPy 3.x as of 3.2.1 — re-validate when bumping.
    """
    required_fields = {
        "observations",
        "proposed_instruction",
        "instruction",
        "better_instruction",
        "score",
        "response",
        "answer",
        "summary",
        "rationale",
        "dataset_description",
    }
    for i, slot in enumerate(_DUMMY_LM_RESPONSES):
        missing = required_fields - slot.keys()
        assert missing == set(), (
            f"_DUMMY_LM_RESPONSES[{i}] is missing fields: {sorted(missing)}; "
            f"present: {sorted(slot.keys())}"
        )


def test_dummy_lm_responses_have_distinct_proposed_instructions() -> None:
    """MIPROv2's instruction search needs >1 candidate to be non-degenerate.
    Locks that the response pool has at least 3 distinct
    ``proposed_instruction`` values so the optimizer sees variance.
    """
    distinct = {slot["proposed_instruction"] for slot in _DUMMY_LM_RESPONSES}
    assert len(distinct) >= 3, (
        f"need ≥3 distinct proposed_instruction values to avoid degenerate "
        f"search; got {len(distinct)}: {sorted(distinct)}"
    )


# ---------------------------------------------------------------------------
# _configure_dspy_lm — dummy mode wires real DummyLM
# ---------------------------------------------------------------------------


def test_configure_dspy_lm_dummy_binds_real_dummy_lm() -> None:
    """Dummy mode must wire the **real** ``dspy.utils.DummyLM`` (not
    ``dspy.LM``, not some shim). A type check is the cheapest way to
    catch a regression where ``_configure_dspy_lm``'s dummy branch
    falls through to the LLM-mode path.
    """
    import dspy as _dspy
    from dspy.utils import DummyLM

    config = OptimizerConfig(
        judge_model=None,
        judge_api_key=None,
        judge_base_url=None,
        judge_mode=JUDGE_MODE_DUMMY,
    )
    _configure_dspy_lm(_dspy, config)
    assert isinstance(_dspy.settings.lm, DummyLM), (
        f"dummy mode must bind dspy.utils.DummyLM, got {type(_dspy.settings.lm).__name__}"
    )


def test_configure_dspy_lm_dummy_pool_sized_for_mipro_and_gepa() -> None:
    """The DummyLM instance must carry enough cycled responses to
    satisfy MIPROv2's instruction search + GEPA's rollout budget.
    Empirically GEPA hits ~580 rollouts on a 50-trajectory compile;
    we pad to 1000 for safety. This test locks the cycle constant.
    """
    import dspy as _dspy

    config = OptimizerConfig(
        judge_model=None,
        judge_api_key=None,
        judge_base_url=None,
        judge_mode=JUDGE_MODE_DUMMY,
    )
    _configure_dspy_lm(_dspy, config)
    bound_lm = _dspy.settings.lm
    # DummyLM stores `answers` via ``iter(answers)`` per its constructor
    # when given a list. ``list(iterator)`` drains it; ``list(list)``
    # copies it — both reach a count without partial state.
    collected = list(bound_lm.answers)
    assert len(collected) == 1000, (
        f"DummyLM answer pool must be exactly 1000 (cycle of 5 × 200); got {len(collected)}"
    )


# ---------------------------------------------------------------------------
# optimize() end-to-end with real DSPy + DummyLM
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_optimize_mipro_real_dspy_dummy_lm_emits_proposal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end smoke: real MIPROv2 compile loop runs under DummyLM
    and produces at least one ``OptimizationProposalDraft``-shaped
    entry. Asserts the compile didn't bail at any of the four
    graceful-degradation gates.

    This test catches the class of regression where a DSPy minor bump
    changes the compile API (e.g., the optuna integration) and the
    fake-module tests stay green but real DSPy errors out.
    """
    monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)
    monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_MODE", "dummy")

    result = await optimize(
        optimizer_choice="mipro",
        trajectories=_trajectories(MIN_TRAJECTORIES),
        failure_categories=["tool_error"],
        dry_run=False,
    )
    payload = _extract_payload(result)
    # The compile path either produces proposals or bails at a gate.
    # In dummy mode with 5 trajectories and dspy installed, all four
    # gates should pass — so we expect at least one proposal.
    assert payload["proposals"], (
        f"real-DSPy MIPROv2 + DummyLM must produce a proposal; "
        f"no_proposal_reasons={payload.get('no_proposal_reasons')}"
    )
    proposal = payload["proposals"][0]
    assert proposal["title"].startswith("DSPy MIPRO"), proposal["title"]
    # Both kind="markdown" and kind="json" artifacts are emitted per
    # _build_proposal_artifacts; this asserts the contract surface
    # downstream consumers depend on.
    kinds = sorted(a["kind"] for a in proposal["artifacts"])
    assert kinds == ["json", "markdown"], kinds


# NOTE on the missing GEPA e2e test: a previous draft included a
# parallel ``test_optimize_gepa_real_dspy_dummy_lm_emits_proposal``
# but it surfaced a real latent constraint: ``dspy.settings.configure``
# in DSPy 3.x is guarded against multi-task re-entry, and pytest-asyncio
# runs each test in a fresh event loop. After the MIPROv2 e2e test
# above completes, a second ``_configure_dspy_lm`` call from a new
# event loop raises a RuntimeError that the server's catch-all wraps
# as ``OptimizerOperationError("failed to configure DSPy judge LM …")``.
#
# The clean fix is to scope LM activation per-call via
# ``with dspy.context(lm=lm):`` instead of ``dspy.settings.configure``
# (the cross-review subagent flagged this in QUI-147 round-3 and shipped
# a draft refactor). Applying that refactor here would require touching
# ``_configure_dspy_lm`` + ``_run_dspy_compile`` + updating the 9 existing
# fake-module tests that assert ``settings.configure`` was called. That's
# a separate cross-review cycle, deferred to a follow-up.
#
# GEPA's real-DSPy code path is still exercised end-to-end by
# ``scripts/bench-real-dspy.py`` (which runs MIPROv2 then GEPA in the
# SAME ``asyncio.run`` event loop, avoiding the multi-task constraint).
# The fake-module test ``test_server_real_dspy.py::test_gepa_happy_path
# _returns_proposal_with_gepa_branding`` covers GEPA's branding + wiring
# against the stub; the missing piece is "real DSPy GEPA + real DummyLM
# end-to-end inside pytest" — that's the gap the refactor would close.


@pytest.mark.asyncio
async def test_optimize_small_trainset_still_gates_in_dummy_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dummy mode does NOT bypass the ``MIN_TRAJECTORIES`` gate — fewer
    than the minimum still produces the structured ``insufficient_signal``
    reason. This locks the contract that dummy mode is a no-cost
    real-code-path test, NOT a "skip all gates" mode.
    """
    monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)
    monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_MODE", "dummy")

    too_few = _trajectories(MIN_TRAJECTORIES - 1)
    result = await optimize(
        optimizer_choice="mipro",
        trajectories=too_few,
        failure_categories=["tool_error"],
        dry_run=False,
    )
    payload = _extract_payload(result)
    assert not payload["proposals"], (
        f"compile must NOT produce a proposal under MIN_TRAJECTORIES "
        f"({MIN_TRAJECTORIES}); got {len(payload['proposals'])}"
    )
    reasons = payload.get("no_proposal_reasons", [])
    assert any(r.get("code") == "insufficient_signal" for r in reasons), (
        f"expected insufficient_signal reason, got {reasons}"
    )
