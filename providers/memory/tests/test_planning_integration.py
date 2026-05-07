from __future__ import annotations

import json

import pytest

from quilin_mem.server import create_server
from quilin_mem.store import QuilinMemStore


def _planning_review_payload(run_id: str) -> dict[str, object]:
    return {
        "run_id": run_id,
        "source": "planning_review",
        "schema_version": 1,
        "summary": "Stable strategy: summarize risks before execution.",
        "stable_strategy": {
            "approach": "summarize-first",
            "steps": ["summarize", "execute"],
        },
    }


def _planning_review_metadata(run_id: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "source": "planning_review",
        "run_id": run_id,
        "stability_reason": "Validated stable review summary.",
    }


def _decode_call_tool_result(result: object) -> dict[str, object]:
    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


async def _assert_planning_review_rejected(
    store: QuilinMemStore,
    payload: dict[str, object],
    *,
    metadata: dict[str, object],
    tier: str = "semantic",
    content_type: str = "json",
    match: str = "planning_review",
) -> None:
    with pytest.raises(ValueError, match=match):
        await store.store(
            json.dumps(payload),
            tier=tier,
            metadata=metadata,
            content_type=content_type,
        )

    assert await store.count({"layer": "semantic"}) == 0


async def test_store_accepts_planning_review_semantic_record() -> None:
    store = QuilinMemStore(db_path=":memory:")
    run_id = "run-review-1"

    record = await store.store(
        json.dumps(_planning_review_payload(run_id)),
        tier="semantic",
        metadata=_planning_review_metadata(run_id),
        content_type="json",
    )

    assert record.layer == "semantic"
    assert record.content_type == "json"
    assert record.metadata["source"] == "planning_review"
    assert record.metadata["run_id"] == run_id


async def test_store_rejects_running_planning_state_payloads_for_semantic() -> None:
    store = QuilinMemStore(db_path=":memory:")
    payload = _planning_review_payload("run-review-2")
    payload["events"] = [{"type": "checkpoint"}]

    with pytest.raises(ValueError, match="PlanningState"):
        await store.store(
            json.dumps(payload),
            tier="semantic",
            metadata={
                **_planning_review_metadata("run-review-2"),
            },
            content_type="json",
        )

    assert await store.count({"layer": "semantic"}) == 0


@pytest.mark.parametrize(
    ("runtime_key", "runtime_value"),
    [
        ("checkpoints", [{"phase": "review"}]),
        ("phase", "review"),
        ("budget", {"remaining_tokens": 1000}),
        ("currentLeafId", "leaf-1"),
        ("plan", {"steps": ["draft", "review"]}),
    ],
)
async def test_store_rejects_forbidden_planning_runtime_keys_for_semantic(
    runtime_key: str,
    runtime_value: object,
) -> None:
    store = QuilinMemStore(db_path=":memory:")
    run_id = f"run-review-forbidden-{runtime_key}"
    payload = _planning_review_payload(run_id)
    payload[runtime_key] = runtime_value

    await _assert_planning_review_rejected(
        store,
        payload,
        metadata={
            **_planning_review_metadata(run_id),
        },
        match="PlanningState",
    )


async def test_store_rejects_planning_review_outside_semantic_layer() -> None:
    store = QuilinMemStore(db_path=":memory:")
    run_id = "run-review-episodic"

    await _assert_planning_review_rejected(
        store,
        _planning_review_payload(run_id),
        metadata={
            **_planning_review_metadata(run_id),
        },
        tier="episodic",
        match="semantic layer",
    )


async def test_store_rejects_planning_review_text_content_type() -> None:
    store = QuilinMemStore(db_path=":memory:")
    run_id = "run-review-text"

    await _assert_planning_review_rejected(
        store,
        _planning_review_payload(run_id),
        metadata={
            **_planning_review_metadata(run_id),
        },
        content_type="text",
        match="content_type=json",
    )


@pytest.mark.parametrize(
    ("metadata", "payload", "match"),
    [
        (
            {
                **_planning_review_metadata("run-review-schema"),
                "schema_version": 2,
            },
            _planning_review_payload("run-review-schema"),
            "metadata.schema_version",
        ),
        (
            {
                **_planning_review_metadata("run-review-payload-schema"),
            },
            {
                **_planning_review_payload("run-review-payload-schema"),
                "schema_version": 2,
            },
            "payload.schema_version",
        ),
        (
            {"schema_version": 1, "source": "planning_review", "stability_reason": "validated"},
            _planning_review_payload("run-review-missing-metadata"),
            "metadata.run_id",
        ),
        (
            _planning_review_metadata("run-review-metadata"),
            _planning_review_payload("run-review-payload"),
            "payload.run_id",
        ),
    ],
)
async def test_store_rejects_invalid_planning_review_schema_and_run_id(
    metadata: dict[str, object],
    payload: dict[str, object],
    match: str,
) -> None:
    store = QuilinMemStore(db_path=":memory:")

    await _assert_planning_review_rejected(
        store,
        payload,
        metadata=metadata,
        match=match,
    )


async def test_store_rejects_planning_state_source_for_semantic() -> None:
    store = QuilinMemStore(db_path=":memory:")

    with pytest.raises(ValueError, match="planning_state"):
        await store.store(
            json.dumps(
                {
                    "run_id": "run-review-state",
                    "source": "planning_state",
                    "schema_version": 1,
                    "events": [{"type": "checkpoint"}],
                }
            ),
            tier="semantic",
            metadata={
                "schema_version": 1,
                "source": "planning_state",
                "run_id": "run-review-state",
                "stability_reason": "invalid runtime payload",
            },
            content_type="json",
        )


@pytest.mark.parametrize(
    "metadata",
    [
        {"schema_version": 1},
        {"schema_version": 1, "source": "checkpoint", "stability_reason": "checkpoint snapshot"},
    ],
)
async def test_store_rejects_runtime_planning_state_even_without_planning_source(
    metadata: dict[str, object],
) -> None:
    store = QuilinMemStore(db_path=":memory:")

    with pytest.raises(ValueError, match="PlanningState"):
        await store.store(
            json.dumps(
                {
                    "runId": "run-live",
                    "phase": "executing",
                    "events": [],
                    "checkpoints": [],
                }
            ),
            tier="semantic",
            metadata=metadata,
            content_type="json",
        )

    assert await store.count({"layer": "semantic"}) == 0


async def test_memory_store_tool_accepts_planning_review_schema_fields() -> None:
    store = QuilinMemStore(db_path=":memory:")
    server = create_server(store)
    run_id = "run-review-3"

    store_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_store",
            {
                "content": json.dumps(_planning_review_payload(run_id)),
                "layer": "semantic",
                "content_type": "json",
                "metadata": {
                    **_planning_review_metadata(run_id),
                },
            },
        )
    )
    recall_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_recall",
            {"query": "Stable strategy"},
        )
    )

    assert store_result["id"] == recall_result["records"][0]["id"]  # type: ignore[index]
    assert recall_result["records"][0]["content_type"] == "json"  # type: ignore[index]
    assert recall_result["records"][0]["metadata"]["source"] == "direct_recall"  # type: ignore[index]
    assert recall_result["records"][0]["metadata"]["memory_source"] == "planning_review"  # type: ignore[index]
    assert recall_result["records"][0]["metadata"]["run_id"] == run_id  # type: ignore[index]


async def test_store_rejects_semantic_records_without_stability_reason() -> None:
    store = QuilinMemStore(db_path=":memory:")

    with pytest.raises(ValueError, match="stability_reason"):
        await store.store(
            json.dumps(_planning_review_payload("run-review-missing-stability")),
            tier="semantic",
            metadata={
                "schema_version": 1,
                "source": "planning_review",
                "run_id": "run-review-missing-stability",
            },
            content_type="json",
        )
