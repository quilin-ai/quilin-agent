"""Tests for the Stage C real-DSPy optimizer MCP server.

Stage A placeholder tests have been migrated to the Stage C contract:
    - ``OPTIMIZER_ID`` is now ``"dspy"`` (was ``"dspy-stub"``).
    - ``stage`` is now ``"C"`` (was ``"A"``).
    - Happy-path proposal generation requires DSPy + judge key + ≥5 trajectories;
      smaller inputs return structured ``no_proposal_reasons`` instead.

Stage A 占位测试已迁移到 Stage C 契约：
    - ``OPTIMIZER_ID`` 现在是 ``"dspy"``（原 ``"dspy-stub"``）。
    - ``stage`` 现在是 ``"C"``（原 ``"A"``）。
    - happy-path 提案生成需要 DSPy + judge key + ≥5 条轨迹；
      不达条件时返回结构化 ``no_proposal_reasons``。

These tests focus on input validation + graceful-degradation contract;
real DSPy compile coverage lives in ``test_server_real_dspy.py``.

本文件聚焦输入校验 + 优雅降级契约；
真实 DSPy 编译路径覆盖在 ``test_server_real_dspy.py``。
"""

from __future__ import annotations

import json

import pytest

from quilin_optimizer.server import (
    OPTIMIZER_ID,
    OPTIMIZER_MODE,
    SCHEMA_VERSION,
    OptimizerConfig,
    OptimizerOperationError,
    create_server,
    optimize,
)


def _extract_text(raw: object) -> str:
    """Pull the JSON string out of a FastMCP tool result payload."""
    if isinstance(raw, str):
        return raw

    if hasattr(raw, "content"):
        items = list(getattr(raw, "content", []))
        text_parts = [
            getattr(item, "text", "") for item in items if getattr(item, "type", None) == "text"
        ]
        joined = "\n".join(part for part in text_parts if part)
        if joined:
            return joined

    if isinstance(raw, list | tuple):
        for item in raw:
            if isinstance(item, str):
                return item
            text = getattr(item, "text", None)
            if isinstance(text, str):
                return text

    raise AssertionError(f"unexpected FastMCP tool result shape: {raw!r}")


def test_create_server_registers_optimize_tool() -> None:
    server = create_server()
    tool_names = sorted(t.name for t in server._tool_manager.list_tools())
    assert tool_names == ["optimize"]


def test_main_invokes_mcp_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """``main()`` should configure logging and start the stdio transport."""
    from quilin_optimizer import server as server_module

    invocations: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def _fake_run(*args: object, **kwargs: object) -> None:
        invocations.append((args, kwargs))

    monkeypatch.setattr(server_module.mcp, "run", _fake_run)
    server_module.main()

    assert len(invocations) == 1
    assert invocations[0][1] == {"transport": "stdio"}


@pytest.mark.asyncio
async def test_optimize_returns_no_failure_detected_when_trajectories_empty() -> None:
    raw = await optimize(trajectories=[], failure_categories=["tool_error"])
    payload = json.loads(raw)

    assert payload["proposals"] == []
    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["optimizer_id"] == OPTIMIZER_ID
    assert payload["mode"] == OPTIMIZER_MODE
    assert payload["stage"] == "C"
    codes = [reason["code"] for reason in payload["no_proposal_reasons"]]
    assert codes == ["no_failure_detected"]


@pytest.mark.asyncio
async def test_optimize_returns_insufficient_signal_when_categories_empty() -> None:
    raw = await optimize(
        trajectories=[{"trajectoryRef": "trajectory:run-x", "runId": "run-x"}],
        failure_categories=[],
    )
    payload = json.loads(raw)

    assert payload["proposals"] == []
    codes = [reason["code"] for reason in payload["no_proposal_reasons"]]
    assert codes == ["insufficient_signal"]
    assert payload["no_proposal_reasons"][0]["evidenceRefs"] == ["trajectory:run-x"]


@pytest.mark.asyncio
async def test_optimize_dry_run_flag_is_forwarded_to_metadata() -> None:
    """Even on the no-proposal path, ``dry_run`` must round-trip."""
    raw = await optimize(
        trajectories=[],
        failure_categories=["tool_error"],
        dry_run=True,
    )
    payload = json.loads(raw)

    assert payload["dry_run"] is True


@pytest.mark.asyncio
async def test_optimize_rejects_non_dict_trajectory() -> None:
    with pytest.raises(OptimizerOperationError, match="must be an object"):
        await optimize(
            trajectories=["not-a-dict"],
            failure_categories=["tool_error"],
        )


@pytest.mark.asyncio
async def test_optimize_rejects_missing_trajectory_ref() -> None:
    with pytest.raises(OptimizerOperationError, match="trajectoryRef must be non-empty"):
        await optimize(
            trajectories=[{"runId": "run-z"}],
            failure_categories=["tool_error"],
        )


@pytest.mark.asyncio
async def test_optimize_rejects_missing_run_id() -> None:
    with pytest.raises(OptimizerOperationError, match="runId must be non-empty"):
        await optimize(
            trajectories=[{"trajectoryRef": "trajectory:abc", "runId": ""}],
            failure_categories=["tool_error"],
        )


@pytest.mark.asyncio
async def test_optimize_rejects_too_many_trajectories() -> None:
    too_many = [{"trajectoryRef": f"trajectory:{i}", "runId": f"run-{i}"} for i in range(257)]
    with pytest.raises(
        OptimizerOperationError,
        match="trajectories must contain at most 256 items",
    ):
        await optimize(trajectories=too_many, failure_categories=["x"])


@pytest.mark.asyncio
async def test_optimize_rejects_too_many_failure_categories() -> None:
    with pytest.raises(
        OptimizerOperationError,
        match="failure_categories must contain at most 32 items",
    ):
        await optimize(
            trajectories=[{"trajectoryRef": "t", "runId": "r"}],
            failure_categories=[f"cat-{i}" for i in range(33)],
        )


@pytest.mark.asyncio
async def test_optimize_rejects_overlong_string_field() -> None:
    overlong = "x" * 1025
    with pytest.raises(OptimizerOperationError, match="must be at most"):
        await optimize(
            trajectories=[{"trajectoryRef": overlong, "runId": "run-x"}],
            failure_categories=["tool_error"],
        )


@pytest.mark.asyncio
async def test_optimize_rejects_invalid_optimizer_choice() -> None:
    with pytest.raises(OptimizerOperationError, match="optimizer_choice must be one of"):
        await optimize(
            trajectories=[{"trajectoryRef": "t", "runId": "r"}],
            failure_categories=["tool_error"],
            optimizer_choice="random_invalid_choice",
        )


@pytest.mark.asyncio
async def test_optimize_rejects_non_string_optimizer_choice() -> None:
    with pytest.raises(OptimizerOperationError, match="optimizer_choice must be a string"):
        await optimize(
            trajectories=[{"trajectoryRef": "t", "runId": "r"}],
            failure_categories=["tool_error"],
            optimizer_choice=123,
        )


@pytest.mark.asyncio
async def test_optimize_wraps_unexpected_errors_as_operation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Generic exceptions inside ``_optimize`` are wrapped, not leaked."""
    from quilin_optimizer import server as server_module

    async def _explode(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("boom")

    monkeypatch.setattr(server_module, "_optimize", _explode)

    with pytest.raises(OptimizerOperationError, match="optimize failed"):
        await optimize(
            trajectories=[{"trajectoryRef": "t", "runId": "r"}],
            failure_categories=["tool_error"],
        )


def test_optimizer_config_from_env_reads_all_three_keys() -> None:
    config = OptimizerConfig.from_env(
        env={
            "QUILIN_OPTIMIZER_JUDGE_MODEL": "openai/gpt-4o",
            "QUILIN_OPTIMIZER_JUDGE_API_KEY": "sk-fake",
            "QUILIN_OPTIMIZER_JUDGE_BASE_URL": "https://example.com/v1",
        }
    )
    assert config.judge_model == "openai/gpt-4o"
    assert config.judge_api_key == "sk-fake"
    assert config.judge_base_url == "https://example.com/v1"
    assert config.is_ready() is True


def test_optimizer_config_is_not_ready_without_api_key() -> None:
    config = OptimizerConfig.from_env(env={})
    assert config.is_ready() is False
    assert config.judge_api_key is None


def test_optimizer_config_treats_empty_string_as_missing() -> None:
    config = OptimizerConfig.from_env(env={"QUILIN_OPTIMIZER_JUDGE_API_KEY": ""})
    assert config.is_ready() is False


@pytest.mark.asyncio
async def test_optimize_with_no_judge_key_returns_insufficient_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the judge API key is missing, fall back to a structured warning.

    Injects a minimal fake ``dspy`` module so the lazy-import gate
    succeeds and the judge-key gate is the one that fires.
    """
    import sys
    import types

    fake_dspy = types.ModuleType("dspy")
    monkeypatch.setitem(sys.modules, "dspy", fake_dspy)

    monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_API_KEY", raising=False)
    monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_MODEL", raising=False)
    monkeypatch.delenv("QUILIN_OPTIMIZER_JUDGE_BASE_URL", raising=False)

    raw = await optimize(
        trajectories=[
            {"trajectoryRef": f"trajectory:run-{i}", "runId": f"run-{i}"} for i in range(6)
        ],
        failure_categories=["tool_error"],
    )
    payload = json.loads(raw)

    assert payload["proposals"] == []
    codes = [reason["code"] for reason in payload["no_proposal_reasons"]]
    assert codes == ["insufficient_signal"]
    message = payload["no_proposal_reasons"][0]["message"]
    assert "QUILIN_OPTIMIZER_JUDGE_API_KEY" in message
    # API key value must NEVER appear in the message body.
    assert "sk-" not in message
