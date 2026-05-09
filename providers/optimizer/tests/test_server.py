"""Tests for the Stage A placeholder optimizer MCP server.

These tests cover the contract that the TS-side ``DspyOfflineOptimizer``
relies on. Stage C will add coverage for the real DSPy pipeline; until
then we only verify:

1. ``create_server()`` registers the ``optimize`` tool.
2. The tool responds with a deterministic stub matching the
   ``OfflineOptimizerResult`` shape.
3. Validation rejects malformed inputs without crashing the server.

下列测试覆盖 TS 端 ``DspyOfflineOptimizer`` 依赖的契约。Stage C 将补充
真实 DSPy 流程的覆盖；当前阶段只验证：
1. ``create_server()`` 注册了 ``optimize`` 工具；
2. 工具返回与 ``OfflineOptimizerResult`` 形状一致的确定性占位；
3. 输入校验拒绝非法输入且不会让 server 崩溃。
"""

from __future__ import annotations

import json

import pytest

from quilin_optimizer.server import (
    OPTIMIZER_ID,
    OPTIMIZER_MODE,
    SCHEMA_VERSION,
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
async def test_optimize_tool_round_trip_with_valid_inputs() -> None:
    server = create_server()
    handler = server._tool_manager.get_tool("optimize")
    assert handler is not None

    raw = await handler.run(
        {
            "trajectories": [
                {
                    "trajectoryRef": "trajectory:run-001",
                    "runId": "run-001",
                    "taskRef": "QUI-118",
                },
                {
                    "trajectoryRef": "trajectory:run-002",
                    "runId": "run-002",
                },
            ],
            "failure_categories": ["tool_error", "schema_violation"],
            "dry_run": False,
        }
    )
    payload = json.loads(_extract_text(raw))

    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["optimizer_id"] == OPTIMIZER_ID
    assert payload["mode"] == OPTIMIZER_MODE
    assert payload["stage"] == "A"
    assert payload["dry_run"] is False
    assert payload["no_proposal_reasons"] == []
    assert isinstance(payload["created_at"], str)
    assert payload["created_at"].endswith("Z")

    assert len(payload["proposals"]) == 1
    proposal = payload["proposals"][0]
    assert proposal["title"].startswith("DSPy placeholder")
    assert proposal["riskPreview"]["level"] == "medium"
    assert proposal["riskPreview"]["touchesRuntime"] is False
    assert proposal["riskPreview"]["requiresHumanReview"] is True
    assert proposal["metadata"]["optimizer_id"] == OPTIMIZER_ID
    assert proposal["metadata"]["application_mode"] == "proposal_only"
    assert proposal["metadata"]["stage"] == "A"
    assert proposal["metadata"]["trajectory_refs"] == [
        "trajectory:run-001",
        "trajectory:run-002",
    ]
    assert proposal["metadata"]["failure_categories"] == [
        "tool_error",
        "schema_violation",
    ]
    assert len(proposal["artifacts"]) == 2
    kinds = sorted(a["kind"] for a in proposal["artifacts"])
    assert kinds == ["json", "markdown"]
    for artifact in proposal["artifacts"]:
        assert artifact["sourceRefs"] == [
            "trajectory:run-001",
            "trajectory:run-002",
        ]
        assert isinstance(artifact["contentHash"], str)
        assert len(artifact["contentHash"]) == 64
    assert proposal["evidenceHashes"] == [a["contentHash"] for a in proposal["artifacts"]]


@pytest.mark.asyncio
async def test_optimize_returns_no_failure_detected_when_trajectories_empty() -> None:
    raw = await optimize(trajectories=[], failure_categories=["tool_error"])
    payload = json.loads(raw)

    assert payload["proposals"] == []
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
    raw = await optimize(
        trajectories=[{"trajectoryRef": "trajectory:run-y", "runId": "run-y"}],
        failure_categories=["tool_error"],
        dry_run=True,
    )
    payload = json.loads(raw)

    assert payload["dry_run"] is True
    assert payload["proposals"][0]["metadata"]["dry_run"] is True


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
async def test_optimize_wraps_unexpected_errors_as_operation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Generic exceptions inside ``_optimize`` are wrapped, not leaked."""
    from quilin_optimizer import server as server_module

    def _explode(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("boom")

    monkeypatch.setattr(server_module, "_build_placeholder_proposal", _explode)

    with pytest.raises(OptimizerOperationError, match="optimize failed"):
        await optimize(
            trajectories=[{"trajectoryRef": "t", "runId": "r"}],
            failure_categories=["tool_error"],
        )


@pytest.mark.asyncio
async def test_optimize_is_deterministic_for_repeated_inputs() -> None:
    payload1 = json.loads(
        await optimize(
            trajectories=[
                {"trajectoryRef": "trajectory:a", "runId": "a"},
                {"trajectoryRef": "trajectory:b", "runId": "b"},
            ],
            failure_categories=["tool_error"],
        )
    )
    payload2 = json.loads(
        await optimize(
            trajectories=[
                {"trajectoryRef": "trajectory:a", "runId": "a"},
                {"trajectoryRef": "trajectory:b", "runId": "b"},
            ],
            failure_categories=["tool_error"],
        )
    )

    # created_at differs between calls; everything else is deterministic.
    payload1.pop("created_at")
    payload2.pop("created_at")
    assert payload1 == payload2
