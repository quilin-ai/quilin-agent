"""Tests for the Stage C real-DSPy optimizer happy path + degradation modes.

These tests inject a fake ``dspy`` module via ``sys.modules`` so the
real ``dspy-ai`` extra does NOT need to be installed during CI. The
fake covers MIPROv2, GEPA, ``Example``, ``Predict``, ``Signature``,
``LM``, and ``settings``; tests assert that the server wires them up
correctly and that the compiled program output is decoded into the
contract-shape proposal.

测试通过 ``sys.modules`` 注入伪造的 ``dspy`` 模块，使得真实
``dspy-ai`` extra 在 CI 中**无需**安装。伪造模块覆盖 MIPROv2、GEPA、
``Example``、``Predict``、``Signature``、``LM``、``settings``；
测试断言 server 正确装配并把编译产物解码成契约要求的提案形状。
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest

from quilin_optimizer.server import (
    MIN_TRAJECTORIES,
    OptimizerConfig,
    optimize,
)

# ---------------------------------------------------------------------------
# Fake DSPy module factory
# ---------------------------------------------------------------------------


class _FakeExample:
    def __init__(self, **kwargs: object) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)
        self._inputs: tuple[str, ...] = ()

    def with_inputs(self, *inputs: str) -> _FakeExample:
        self._inputs = inputs
        return self


class _FakeSignature:
    instructions: str = "default-fake-instructions"


class _FakePredict:
    def __init__(self, signature: type[_FakeSignature]) -> None:
        # Modeled after dspy.Predict: each program owns a signature
        # instance with mutable ``instructions`` and a list of demos.
        self.signature: Any = types.SimpleNamespace(instructions=signature.instructions)
        self.demos: list[Any] = []

    def predictors(self) -> list[Any]:
        return [self]


class _FakeCompiledProgram:
    def __init__(
        self,
        instructions: str,
        demos: list[_FakeExample],
    ) -> None:
        self.signature = types.SimpleNamespace(instructions=instructions)
        self.demos = demos

    def predictors(self) -> list[Any]:
        return [self]


def _make_fake_dspy(
    *,
    compiled_instructions: str = "Optimized: be concise.",
    compiled_demos: list[_FakeExample] | None = None,
    compile_raises: Exception | None = None,
    expose_mipro: bool = True,
    expose_gepa: bool = True,
    lm_raises: Exception | None = None,
) -> types.ModuleType:
    """Construct a fake ``dspy`` module for injection into ``sys.modules``."""
    fake = types.ModuleType("dspy")

    fake.Example = _FakeExample
    fake.Signature = _FakeSignature

    # InputField / OutputField are accessed as ``dspy.InputField()`` in
    # _build_dspy_program; they only need to be called and ignored.
    fake.InputField = MagicMock(return_value=object())
    fake.OutputField = MagicMock(return_value=object())

    fake.Predict = _FakePredict

    class _LM:
        def __init__(self, model: str, **kwargs: object) -> None:
            if lm_raises is not None:
                raise lm_raises
            self.model = model
            self.kwargs = kwargs

    fake.LM = _LM

    settings = MagicMock()
    fake.settings = settings

    class _CompilerBase:
        def __init__(self, *, metric: Any, auto: str = "light") -> None:
            self.metric = metric
            self.auto = auto

        def compile(self, program: Any, trainset: list[Any]) -> Any:
            if compile_raises is not None:
                raise compile_raises
            demos = compiled_demos if compiled_demos is not None else trainset
            return _FakeCompiledProgram(compiled_instructions, list(demos))

    if expose_mipro:
        fake.MIPROv2 = _CompilerBase
    if expose_gepa:
        fake.GEPA = _CompilerBase

    return fake


@pytest.fixture
def fake_dspy(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    """Inject a happy-path fake ``dspy`` module into ``sys.modules``.

    Cleanup is automatic: monkeypatch restores ``sys.modules`` on teardown.
    """
    module = _make_fake_dspy()
    monkeypatch.setitem(sys.modules, "dspy", module)
    return module


@pytest.fixture
def configured_judge_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", "sk-fake-test-key")
    monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_MODEL", "openai/gpt-4o-mini")


def _trajectories(count: int = MIN_TRAJECTORIES) -> list[dict[str, object]]:
    return [
        {
            "trajectoryRef": f"trajectory:run-{i}",
            "runId": f"run-{i}",
            "taskRef": "QUI-146",
            "taskInput": f"task input {i}",
            "expectedOutput": f"expected output {i}",
        }
        for i in range(count)
    ]


# ---------------------------------------------------------------------------
# Happy path: MIPROv2 (default optimizer_choice)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mipro_happy_path_returns_proposal_with_optimized_prompt(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error", "schema_violation"],
    )
    payload = json.loads(raw)

    assert payload["proposals"], f"expected ≥1 proposal, got: {payload}"
    proposal = payload["proposals"][0]
    assert proposal["title"] == "DSPy MIPRO optimization proposal"
    assert proposal["riskPreview"]["level"] == "medium"
    assert proposal["riskPreview"]["touchesRuntime"] is False
    assert proposal["riskPreview"]["requiresHumanReview"] is True
    assert proposal["metadata"]["optimizer_choice"] == "mipro"
    assert proposal["metadata"]["stage"] == "C"
    assert proposal["metadata"]["application_mode"] == "proposal_only"

    artifacts = proposal["artifacts"]
    assert len(artifacts) == 2
    kinds = sorted(a["kind"] for a in artifacts)
    assert kinds == ["json", "markdown"]

    # The optimized prompt from the fake compiler must appear in both
    # the markdown body AND the JSON payload.
    markdown_artifact = next(a for a in artifacts if a["kind"] == "markdown")
    assert "Optimized: be concise." in markdown_artifact["content"]

    json_artifact = next(a for a in artifacts if a["kind"] == "json")
    decoded = json.loads(json_artifact["content"])
    assert decoded["optimized_prompt"] == "Optimized: be concise."
    assert decoded["optimizer_choice"] == "mipro"
    assert isinstance(decoded["few_shot_examples"], list)
    assert len(decoded["few_shot_examples"]) == MIN_TRAJECTORIES


@pytest.mark.asyncio
async def test_mipro_explicit_choice_matches_default(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """``optimizer_choice="mipro"`` must produce identical structure to default."""
    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
        optimizer_choice="mipro",
    )
    payload = json.loads(raw)
    assert payload["optimizer_choice"] == "mipro"
    assert payload["proposals"][0]["metadata"]["optimizer_choice"] == "mipro"


# ---------------------------------------------------------------------------
# Happy path: GEPA
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gepa_happy_path_returns_proposal_with_gepa_branding(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
        optimizer_choice="gepa",
    )
    payload = json.loads(raw)

    assert payload["optimizer_choice"] == "gepa"
    proposal = payload["proposals"][0]
    assert proposal["title"] == "DSPy GEPA optimization proposal"
    assert proposal["metadata"]["optimizer_choice"] == "gepa"


# ---------------------------------------------------------------------------
# Graceful degradation: dspy-ai not installed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dspy_extra_not_installed_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """When ``import dspy`` fails, return empty proposals + structured reason.

    We force the failure by patching ``importlib.import_module`` to raise
    ``ImportError`` for the ``dspy`` module name (and only that name).
    """
    real_import = importlib.import_module

    def _fake_import(name: str, *args: object, **kwargs: object) -> Any:
        if name == "dspy":
            raise ImportError("No module named 'dspy'")
        return real_import(name, *args, **kwargs)

    # Also evict any previously-imported fake dspy so the lazy import
    # function actually re-attempts the import.
    monkeypatch.delitem(sys.modules, "dspy", raising=False)
    monkeypatch.setattr(
        "quilin_optimizer.server.importlib.import_module",
        _fake_import,
    )

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
    )
    payload = json.loads(raw)

    assert payload["proposals"] == []
    codes = [r["code"] for r in payload["no_proposal_reasons"]]
    assert codes == ["insufficient_signal"]
    msg = payload["no_proposal_reasons"][0]["message"]
    assert "dspy-ai" in msg
    assert "uv sync --extra dspy" in msg


# ---------------------------------------------------------------------------
# Graceful degradation: training set < MIN_TRAJECTORIES
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_training_set_too_small_returns_structured_warning(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    raw = await optimize(
        trajectories=_trajectories(count=MIN_TRAJECTORIES - 1),
        failure_categories=["tool_error"],
    )
    payload = json.loads(raw)

    assert payload["proposals"] == []
    codes = [r["code"] for r in payload["no_proposal_reasons"]]
    assert codes == ["insufficient_signal"]
    msg = payload["no_proposal_reasons"][0]["message"]
    assert f"at least {MIN_TRAJECTORIES}" in msg
    # Evidence refs must be sanitized into a plain list of strings.
    assert isinstance(payload["no_proposal_reasons"][0]["evidenceRefs"], list)


# ---------------------------------------------------------------------------
# Graceful degradation: compile failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dspy_compile_exception_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """A DSPy compile() exception must NOT crash the server.

    Instead we expect an empty proposal list with a sanitized
    ``insufficient_signal`` reason.
    """
    fake = _make_fake_dspy(compile_raises=RuntimeError("simulated compile error"))
    monkeypatch.setitem(sys.modules, "dspy", fake)

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
        optimizer_choice="mipro",
    )
    payload = json.loads(raw)

    assert payload["proposals"] == []
    codes = [r["code"] for r in payload["no_proposal_reasons"]]
    assert codes == ["insufficient_signal"]
    msg = payload["no_proposal_reasons"][0]["message"]
    assert "compile failed" in msg
    # The exception detail ("simulated compile error") MUST NOT leak
    # into the user-visible message — only the sanitized prefix shows.
    assert "simulated compile error" not in msg


# ---------------------------------------------------------------------------
# Graceful degradation: compiler not exposed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_mipro_compiler_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    fake = _make_fake_dspy(expose_mipro=False)
    monkeypatch.setitem(sys.modules, "dspy", fake)

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
        optimizer_choice="mipro",
    )
    payload = json.loads(raw)
    assert payload["proposals"] == []
    msg = payload["no_proposal_reasons"][0]["message"]
    assert "MIPROv2" in msg


@pytest.mark.asyncio
async def test_missing_gepa_compiler_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    fake = _make_fake_dspy(expose_gepa=False)
    monkeypatch.setitem(sys.modules, "dspy", fake)

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
        optimizer_choice="gepa",
    )
    payload = json.loads(raw)
    assert payload["proposals"] == []
    msg = payload["no_proposal_reasons"][0]["message"]
    assert "GEPA" in msg


# ---------------------------------------------------------------------------
# Graceful degradation: judge LM construction failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lm_construction_failure_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    fake = _make_fake_dspy(lm_raises=ValueError("invalid model id sk-leak-attempt"))
    monkeypatch.setitem(sys.modules, "dspy", fake)

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
    )
    payload = json.loads(raw)

    assert payload["proposals"] == []
    msg = payload["no_proposal_reasons"][0]["message"]
    assert "failed to configure DSPy judge LM" in msg
    # The original ValueError message MUST NOT leak through the sanitize layer.
    assert "sk-leak-attempt" not in msg


# ---------------------------------------------------------------------------
# Malformed compiled output
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compiled_program_with_no_instructions_returns_proposal_with_empty_prompt(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """If DSPy returns a program without ``signature.instructions``, fall
    back to an empty prompt — the proposal is still emitted (the markdown
    artifact says ``(empty — DSPy compiler returned no instruction text)``).
    """
    fake = _make_fake_dspy(compiled_instructions="")
    monkeypatch.setitem(sys.modules, "dspy", fake)

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
    )
    payload = json.loads(raw)

    assert payload["proposals"], payload
    artifacts = payload["proposals"][0]["artifacts"]
    markdown = next(a for a in artifacts if a["kind"] == "markdown")
    assert "(empty" in markdown["content"]


@pytest.mark.asyncio
async def test_compiled_program_returning_none_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """A None compile() result is a malformed contract; surface as warning."""
    fake = _make_fake_dspy()
    # Override compile() on the compiler class to return None.
    original_mipro_cls = fake.MIPROv2

    class _NoneCompiler(original_mipro_cls):
        def compile(self, program: Any, trainset: list[Any]) -> Any:
            return None

    fake.MIPROv2 = _NoneCompiler
    monkeypatch.setitem(sys.modules, "dspy", fake)

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
    )
    payload = json.loads(raw)
    assert payload["proposals"] == []
    msg = payload["no_proposal_reasons"][0]["message"]
    assert "no compiled program" in msg


# ---------------------------------------------------------------------------
# Judge metric behavior
# ---------------------------------------------------------------------------


def test_judge_metric_returns_one_for_exact_match() -> None:
    from quilin_optimizer.server import _build_judge_metric

    metric = _build_judge_metric(OptimizerConfig(None, "sk-x", None))
    example = types.SimpleNamespace(response="hello world")
    prediction = types.SimpleNamespace(response="hello world")
    assert metric(example, prediction) == 1.0


def test_judge_metric_returns_zero_for_empty_candidate() -> None:
    from quilin_optimizer.server import _build_judge_metric

    metric = _build_judge_metric(OptimizerConfig(None, "sk-x", None))
    example = types.SimpleNamespace(response="hello world")
    prediction = types.SimpleNamespace(response="")
    assert metric(example, prediction) == 0.0


def test_judge_metric_returns_one_when_no_oracle() -> None:
    from quilin_optimizer.server import _build_judge_metric

    metric = _build_judge_metric(OptimizerConfig(None, "sk-x", None))
    example = types.SimpleNamespace(response="")
    prediction = types.SimpleNamespace(response="any candidate")
    assert metric(example, prediction) == 1.0


def test_judge_metric_returns_partial_overlap() -> None:
    from quilin_optimizer.server import _build_judge_metric

    metric = _build_judge_metric(OptimizerConfig(None, "sk-x", None))
    example = types.SimpleNamespace(response="alpha beta gamma")
    prediction = types.SimpleNamespace(response="alpha delta")
    score = metric(example, prediction)
    assert 0.0 < score < 1.0


# ---------------------------------------------------------------------------
# Few-shot extraction edge cases
# ---------------------------------------------------------------------------


def test_extract_few_shot_examples_handles_program_without_demos() -> None:
    from quilin_optimizer.server import _extract_few_shot_examples

    program = types.SimpleNamespace()
    assert _extract_few_shot_examples(program) == []


def test_extract_few_shot_examples_handles_extraction_exception() -> None:
    from quilin_optimizer.server import _extract_few_shot_examples

    class _Boom:
        @property
        def demos(self) -> list[Any]:
            raise RuntimeError("boom")

        def predictors(self) -> list[Any]:
            raise RuntimeError("boom")

    assert _extract_few_shot_examples(_Boom()) == []


def test_extract_optimized_prompt_handles_program_without_signature() -> None:
    from quilin_optimizer.server import _extract_optimized_prompt

    program = types.SimpleNamespace()
    assert _extract_optimized_prompt(program) == ""


def test_extract_optimized_prompt_handles_extraction_exception() -> None:
    from quilin_optimizer.server import _extract_optimized_prompt

    class _Boom:
        @property
        def signature(self) -> Any:
            raise RuntimeError("boom")

        def predictors(self) -> list[Any]:
            raise RuntimeError("boom")

    assert _extract_optimized_prompt(_Boom()) == ""


def test_extract_optimized_prompt_falls_back_to_predictors() -> None:
    """When ``program.signature`` is missing, walk ``predictors()``."""
    from quilin_optimizer.server import _extract_optimized_prompt

    nested_predictor = types.SimpleNamespace(
        signature=types.SimpleNamespace(instructions="from-predictor")
    )
    program = types.SimpleNamespace(predictors=lambda: [nested_predictor])
    assert _extract_optimized_prompt(program) == "from-predictor"


def test_extract_few_shot_examples_falls_back_to_predictors() -> None:
    """When top-level ``demos`` is missing, walk predictors."""
    from quilin_optimizer.server import _extract_few_shot_examples

    demo = types.SimpleNamespace(task="t1", response="r1")
    nested_predictor = types.SimpleNamespace(demos=[demo])
    program = types.SimpleNamespace(predictors=lambda: [nested_predictor])
    assert _extract_few_shot_examples(program) == [{"task": "t1", "response": "r1"}]


# ---------------------------------------------------------------------------
# Trajectory enrichment fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_optimize_accepts_enriched_trajectory_fields(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """``taskInput`` / ``expectedOutput`` are optional and should pass through."""
    trajectories = [
        {
            "trajectoryRef": f"trajectory:run-{i}",
            "runId": f"run-{i}",
            "taskInput": f"input-{i}",
            "expectedOutput": f"output-{i}",
        }
        for i in range(MIN_TRAJECTORIES)
    ]
    raw = await optimize(
        trajectories=trajectories,
        failure_categories=["tool_error"],
    )
    payload = json.loads(raw)
    assert payload["proposals"], payload


@pytest.mark.asyncio
async def test_optimize_rejects_non_string_task_input() -> None:
    with pytest.raises(Exception, match="taskInput must be a string"):
        await optimize(
            trajectories=[
                {
                    "trajectoryRef": "trajectory:r",
                    "runId": "r",
                    "taskInput": 42,
                }
            ],
            failure_categories=["tool_error"],
        )


@pytest.mark.asyncio
async def test_optimize_rejects_non_string_expected_output() -> None:
    with pytest.raises(Exception, match="expectedOutput must be a string"):
        await optimize(
            trajectories=[
                {
                    "trajectoryRef": "trajectory:r",
                    "runId": "r",
                    "expectedOutput": 99,
                }
            ],
            failure_categories=["tool_error"],
        )


# ---------------------------------------------------------------------------
# explicit OptimizerConfig override
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_optimize_accepts_explicit_config_override(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An explicit ``config`` arg must override env vars."""
    monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)

    config = OptimizerConfig(
        judge_model="custom/model",
        judge_api_key="sk-explicit-override",
        judge_base_url=None,
    )
    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
        config=config,
    )
    payload = json.loads(raw)
    assert payload["proposals"], payload


# ---------------------------------------------------------------------------
# MCP tool surface
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_optimize_tool_round_trip_via_mcp_handler(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """Round-trip the call through the FastMCP tool manager."""
    from quilin_optimizer.server import create_server

    server = create_server()
    handler = server._tool_manager.get_tool("optimize")
    assert handler is not None

    raw = await handler.run(
        {
            "trajectories": [
                {
                    "trajectoryRef": f"trajectory:run-{i}",
                    "runId": f"run-{i}",
                    "taskInput": f"task-{i}",
                    "expectedOutput": f"output-{i}",
                }
                for i in range(MIN_TRAJECTORIES)
            ],
            "failure_categories": ["tool_error"],
            "dry_run": False,
            "optimizer_choice": "gepa",
        }
    )

    if isinstance(raw, str):
        text = raw
    else:
        # Same extractor logic as test_server.py
        items = list(getattr(raw, "content", []))
        text = "\n".join(
            getattr(item, "text", "") for item in items if getattr(item, "type", None) == "text"
        )
    payload = json.loads(text)
    assert payload["optimizer_choice"] == "gepa"
    assert payload["proposals"][0]["metadata"]["optimizer_choice"] == "gepa"
