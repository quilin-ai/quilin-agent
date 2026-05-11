"""Tests for the Stage C real-DSPy GEPA optimizer happy path + degradation modes.

These tests inject a fake ``dspy`` module via ``sys.modules`` so the
real ``dspy-ai`` package does NOT need to be loaded during these unit
tests (the e2e file `test_server_real_dspy_e2e.py` covers the real
package). The fake covers GEPA, ``Example``, ``Predict``,
``Signature``, ``LM``, and ``settings``; tests assert that the server
wires them up correctly and that the compiled program output is
decoded into the contract-shape proposal.

测试通过 ``sys.modules`` 注入伪造的 ``dspy`` 模块，让单元测试不用真
``dspy-ai`` 包（真包覆盖在 e2e 文件 `test_server_real_dspy_e2e.py`）。
伪造模块覆盖 GEPA、``Example``、``Predict``、``Signature``、``LM``、
``settings``；测试断言 server 正确装配并把编译产物解码成契约要求的
提案形状。
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
    JUDGE_MODE_DUMMY,
    JUDGE_MODE_LLM,
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

    # Mirror dspy.utils.DummyLM for the ``judge_mode = "dummy"`` path.
    # Real DummyLM cycles through a list of canned responses; the
    # construction signature `DummyLM(answers: list[str])` is what the
    # server calls — we only need to verify it is constructed and bound
    # to ``settings.lm`` when dummy mode is active.
    class _DummyLM:
        def __init__(self, answers: list[str]) -> None:
            self.answers = list(answers)

    utils_mod = types.ModuleType("dspy.utils")
    utils_mod.DummyLM = _DummyLM
    fake.utils = utils_mod

    settings = MagicMock()
    fake.settings = settings

    # ``dspy.context(lm=...)`` is the per-call LM activation API the
    # compile path uses (instead of process-global
    # ``settings.configure``). We model it as a contextmanager that
    # writes ``settings.lm`` on enter and restores on exit — that
    # matches what real DSPy does for our compile-path consumers.
    # Tests that previously asserted on ``settings.configure(lm=...)``
    # via the legacy ``_configure_dspy_lm`` wrapper still work because
    # the wrapper still calls ``settings.configure``.
    from contextlib import contextmanager

    @contextmanager
    def _fake_context(lm: Any = None) -> Any:
        previous = getattr(settings, "lm", None)
        settings.lm = lm
        try:
            yield
        finally:
            settings.lm = previous

    fake.context = _fake_context

    class _CompilerBase:
        # GEPA in DSPy 3.x requires an explicit `reflection_lm` kwarg in
        # addition to metric / auto. We accept (and ignore) it here so
        # the fake matches the real signature without per-compiler shims.
        def __init__(
            self,
            *,
            metric: Any,
            auto: str = "light",
            reflection_lm: Any = None,
        ) -> None:
            self.metric = metric
            self.auto = auto
            self.reflection_lm = reflection_lm

        def compile(self, program: Any, trainset: list[Any]) -> Any:
            if compile_raises is not None:
                raise compile_raises
            demos = compiled_demos if compiled_demos is not None else trainset
            return _FakeCompiledProgram(compiled_instructions, list(demos))

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
    # Lock JUDGE_MODE to llm explicitly. LiteLLM (now a hard transitive
    # dep via dspy-ai) calls load_dotenv() on import, which can leak the
    # project's .env QUILIN_OPTIMIZER_JUDGE_MODE value (commonly "dummy"
    # for local-dev convenience) into the test process — making any
    # test that expects the llm-mode path silently take the dummy path.
    monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_MODE", "llm")
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
# Happy path: GEPA (the singular optimizer)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gepa_happy_path_returns_proposal_with_optimized_prompt(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error", "schema_violation"],
    )
    payload = json.loads(raw)

    assert payload["proposals"], f"expected ≥1 proposal, got: {payload}"
    assert payload["optimizer_choice"] == "gepa"
    proposal = payload["proposals"][0]
    assert proposal["title"] == "DSPy GEPA optimization proposal"
    assert proposal["riskPreview"]["level"] == "medium"
    assert proposal["riskPreview"]["touchesRuntime"] is False
    assert proposal["riskPreview"]["requiresHumanReview"] is True
    assert proposal["metadata"]["optimizer_choice"] == "gepa"
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
    assert decoded["optimizer_choice"] == "gepa"
    assert isinstance(decoded["few_shot_examples"], list)
    assert len(decoded["few_shot_examples"]) == MIN_TRAJECTORIES


# ---------------------------------------------------------------------------
# Graceful degradation: dspy-ai import fails (broken venv)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dspy_import_failure_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """When ``import dspy`` fails, return empty proposals + structured reason.

    Post 2026-05-12 GEPA-only refactor: dspy-ai is a HARD dep, so this
    branch should only fire on a broken venv. We force the failure by
    patching ``importlib.import_module`` to raise ``ImportError`` for
    the ``dspy`` module name (and only that name).
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
    assert "reinstall" in msg


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
async def test_missing_gepa_compiler_returns_structured_warning(
    monkeypatch: pytest.MonkeyPatch,
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    fake = _make_fake_dspy(expose_gepa=False)
    monkeypatch.setitem(sys.modules, "dspy", fake)

    raw = await optimize(
        trajectories=_trajectories(),
        failure_categories=["tool_error"],
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
    original_gepa_cls = fake.GEPA

    class _NoneCompiler(original_gepa_cls):
        def compile(self, program: Any, trainset: list[Any]) -> Any:
            return None

    fake.GEPA = _NoneCompiler
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


@pytest.mark.asyncio
async def test_optimize_tool_legacy_optimizer_choice_kwarg_is_ignored(
    fake_dspy: types.ModuleType,  # noqa: ARG001
    configured_judge_env: None,  # noqa: ARG001
) -> None:
    """External MCP consumers upgrading across the 2026-05-12 GEPA-only
    refactor may still pass the deleted ``optimizer_choice`` kwarg.
    FastMCP silently drops the unknown kwarg, GEPA runs implicitly, and
    the response's ``optimizer_choice`` field always reports ``gepa``.
    This locks the wire-protocol contract so a future FastMCP version
    that flips to strict-validation will fail this test instead of
    breaking external consumers without warning.
    """
    from quilin_optimizer.server import create_server

    server = create_server()
    handler = server._tool_manager.get_tool("optimize")
    assert handler is not None

    # Pass the DELETED optimizer_choice kwarg — must NOT raise.
    raw = await handler.run(
        {
            "trajectories": [
                {"trajectoryRef": f"trajectory:run-{i}", "runId": f"run-{i}"}
                for i in range(MIN_TRAJECTORIES)
            ],
            "failure_categories": ["tool_error"],
            "dry_run": False,
            "optimizer_choice": "mipro",
        }
    )

    text = raw if isinstance(raw, str) else "\n".join(
        getattr(item, "text", "")
        for item in getattr(raw, "content", [])
        if getattr(item, "type", None) == "text"
    )
    payload = json.loads(text)
    # Response still reports GEPA — the legacy kwarg is dropped, not
    # honored. If FastMCP ever flips to strict validation, this test
    # will fail at `handler.run(...)` and we'll know to handle the
    # migration intentionally.
    assert payload["optimizer_choice"] == "gepa", (
        "response should report GEPA regardless of legacy optimizer_choice "
        f"kwarg; got {payload.get('optimizer_choice')!r}"
    )


# ---------------------------------------------------------------------------
# Dummy-LM judge mode (zero-cost real-DSPy code path benchmarking)
# ---------------------------------------------------------------------------


class TestDummyJudgeMode:
    """Tests for ``QUILIN_OPTIMIZER_JUDGE_MODE=dummy`` — DummyLM judge."""

    def test_optimizer_config_judge_mode_defaults_to_llm(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # No env override → default mode is "llm".
        monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_MODE", raising=False)
        config = OptimizerConfig.from_env({})
        assert config.judge_mode == JUDGE_MODE_LLM

    def test_optimizer_config_reads_dummy_mode_from_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)
        config = OptimizerConfig.from_env({"QUILIN_OPTIMIZER_JUDGE_MODE": "dummy"})
        assert config.judge_mode == JUDGE_MODE_DUMMY

    def test_optimizer_config_unknown_mode_falls_back_to_llm(self) -> None:
        # Defensive: a typo / future-mode env value silently maps to "llm"
        # rather than crashing the server. Combined with is_ready() this
        # means a misconfigured mode + missing key still reports the
        # standard "judge_api_key_missing" reason.
        config = OptimizerConfig.from_env({"QUILIN_OPTIMIZER_JUDGE_MODE": "made-up-mode"})
        assert config.judge_mode == JUDGE_MODE_LLM

    def test_optimizer_config_is_ready_true_for_dummy_without_api_key(self) -> None:
        config = OptimizerConfig(
            judge_model=None,
            judge_api_key=None,
            judge_base_url=None,
            judge_mode=JUDGE_MODE_DUMMY,
        )
        assert config.is_ready() is True

    def test_optimizer_config_is_ready_false_for_llm_without_api_key(self) -> None:
        config = OptimizerConfig(
            judge_model=None,
            judge_api_key=None,
            judge_base_url=None,
            judge_mode=JUDGE_MODE_LLM,
        )
        assert config.is_ready() is False

    @pytest.mark.asyncio
    async def test_optimize_dummy_mode_runs_real_dspy_compile_path(
        self,
        fake_dspy: types.ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Dummy mode requires NO API key — the whole point is zero-cost
        # real-DSPy benchmarking. Setting only the mode env should let
        # the optimizer reach the compile path.
        monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)
        monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_MODE", "dummy")

        result = await optimize(
            trajectories=_trajectories(),
            failure_categories=["tool_error"],
            dry_run=False,
        )
        # Extract textual payload (mirrors other tests' helper logic).
        if isinstance(result, str):
            text = result
        else:
            items = list(getattr(result, "content", []))
            text = "\n".join(
                getattr(item, "text", "") for item in items if getattr(item, "type", None) == "text"
            )
        payload = json.loads(text)

        # Compile path must reach a real proposal — no insufficient_signal
        # bailout. This proves dummy mode actually exercises the DSPy
        # compile loop instead of short-circuiting at the readiness gate.
        assert payload["proposals"], (
            "dummy mode should produce real proposals, not bail at readiness gate; "
            f"no_proposal_reasons={payload.get('no_proposal_reasons')}"
        )
        assert payload["proposals"][0]["title"].startswith("DSPy GEPA")

    @pytest.mark.asyncio
    async def test_optimize_dummy_mode_binds_dummy_lm_to_dspy_settings(
        self,
        fake_dspy: types.ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # In dummy mode the compile path must bind a DummyLM (not a
        # real dspy.LM). The compile path uses ``with dspy.context(lm=lm):``
        # for per-call scoping (NOT ``dspy.settings.configure``) — this
        # dodges DSPy 3.x's "configure can only be called from same async
        # task" RuntimeError under pytest-asyncio's per-test event loops.
        # The fake module's ``_fake_context`` writes ``settings.lm`` on
        # enter; we use a side-effect probe to capture what was bound
        # because the context manager restores ``settings.lm`` on exit
        # so it's gone by the time the test resumes.
        monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)
        monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_MODE", "dummy")

        # Snapshot the LM bound inside the context block. The fake's
        # `_fake_context` writes `settings.lm` on enter and restores on
        # exit; we patch the compiler's `compile()` to record what
        # `settings.lm` was while the LM was active.
        captured_lm: list[Any] = []
        original_compile = fake_dspy.GEPA.compile

        def _recording_compile(self: Any, program: Any, trainset: list[Any]) -> Any:
            # Inside compile(), the per-call context block is active.
            captured_lm.append(getattr(fake_dspy.settings, "lm", None))
            return original_compile(self, program, trainset)

        monkeypatch.setattr(fake_dspy.GEPA, "compile", _recording_compile)

        await optimize(
            trajectories=_trajectories(),
            failure_categories=["tool_error"],
            dry_run=False,
        )

        assert captured_lm, "compile() must have run inside dspy.context(lm=...) block"
        bound_lm = captured_lm[-1]
        # The bound LM is a DummyLM instance — it has the canned answers
        # list we hand it in `_DUMMY_LM_RESPONSES`. Real `dspy.LM` would
        # have a `.model` string; DummyLM has `.answers` list.
        assert hasattr(bound_lm, "answers"), (
            f"dummy mode should bind a DummyLM (with .answers), got {type(bound_lm).__name__}"
        )
        # The server cycles 5 templates × 200 = 1000 responses (locked
        # by DUMMY_LM_ANSWER_BUDGET constant) to cover GEPA's rollouts
        # (which empirically use up to ~580 LM calls per 50-trajectory
        # compile). Locking the exact size catches a regression where
        # the budget constant is tuned down silently.
        from quilin_optimizer.server import DUMMY_LM_ANSWER_BUDGET

        assert (
            isinstance(bound_lm.answers, list) and len(bound_lm.answers) == DUMMY_LM_ANSWER_BUDGET
        ), (
            f"dummy mode must cycle to exactly {DUMMY_LM_ANSWER_BUDGET} responses; "
            f"got {len(bound_lm.answers)}"
        )

    @pytest.mark.asyncio
    async def test_optimize_dummy_mode_no_api_key_no_warning(
        self,
        fake_dspy: types.ModuleType,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # Negative regression: in llm mode without a key, the server
        # logs "judge_api_key_missing" and returns insufficient_signal.
        # In dummy mode it must NOT emit that warning.
        monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)
        monkeypatch.setenv("QUILIN_OPTIMIZER_JUDGE_MODE", "dummy")

        await optimize(
            trajectories=_trajectories(),
            failure_categories=["tool_error"],
            dry_run=False,
        )

        api_key_warnings = [
            record for record in caplog.records if "judge_api_key_missing" in record.getMessage()
        ]
        assert not api_key_warnings, (
            f"dummy mode must not emit judge_api_key_missing warning; got {api_key_warnings}"
        )

    def test_judge_metric_accepts_gepa_multi_arg_signature(self) -> None:
        # DSPy 3.x calls the metric with multiple signatures depending on
        # the evaluation context. The 3-arg form (example, prediction,
        # trace=None) is the most common; the 5-arg form (gold, pred,
        # trace, pred_name, pred_trace) appears under GEPA's pareto
        # evaluation. The metric must accept BOTH via *args/**kwargs
        # without raising TypeError.
        from quilin_optimizer.server import OptimizerConfig, _build_judge_metric

        config = OptimizerConfig(
            judge_model=None,
            judge_api_key=None,
            judge_base_url=None,
            judge_mode=JUDGE_MODE_DUMMY,
        )
        metric = _build_judge_metric(config)

        class _Example:
            def __init__(self, response: str) -> None:
                self.response = response

        example = _Example("expected response text with shared keywords")
        prediction = _Example("expected response text")

        # 3-arg shape: (example, prediction, trace=None)
        score_3arg = metric(example, prediction)
        assert isinstance(score_3arg, float) and 0.0 <= score_3arg <= 1.0, (
            f"3-arg call must return a float in [0,1]; got {score_3arg!r}"
        )

        # GEPA 5-arg shape: (gold, pred, trace, pred_name, pred_trace)
        score_5arg = metric(example, prediction, None, "pred_main", object())
        assert isinstance(score_5arg, float) and 0.0 <= score_5arg <= 1.0, (
            f"GEPA 5-arg call must return a float in [0,1]; got {score_5arg!r}"
        )

        # Same inputs → same score regardless of compiler-shape extras.
        assert score_3arg == score_5arg, (
            "metric must be deterministic across argument-shape variants"
        )

    # Note on the missing log-content test: a previous draft asserted on
    # the `dspy_compile_starting` info log via capfd, but structlog's
    # ``PrintLoggerFactory(file=sys.stderr)`` caches a stderr handle
    # reference at configure-time, so subsequent writes go to the
    # original FD even after pytest swaps sys.stderr for capture. The
    # log line IS emitted (visible in pytest's "Captured stderr call"
    # section) but cannot be reliably read back via fixtures. The
    # behavioral assertions on `settings.configure(lm=DummyLM)` already
    # cover the wire that matters.
