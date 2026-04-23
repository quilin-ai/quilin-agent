from __future__ import annotations

import json

import pytest

from omnimem.server import create_server
from omnimem.store import OmniMemStore


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


def _decode_call_tool_result(result: object) -> dict[str, object]:
    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


async def test_store_accepts_planning_review_semantic_record() -> None:
    store = OmniMemStore(db_path=":memory:")
    run_id = "run-review-1"

    record = await store.store(
        json.dumps(_planning_review_payload(run_id)),
        tier="semantic",
        metadata={
            "schema_version": 1,
            "source": "planning_review",
            "run_id": run_id,
        },
        content_type="json",
    )

    assert record.layer == "semantic"
    assert record.content_type == "json"
    assert record.metadata["source"] == "planning_review"
    assert record.metadata["run_id"] == run_id


async def test_store_rejects_running_planning_state_payloads_for_semantic() -> None:
    store = OmniMemStore(db_path=":memory:")
    payload = _planning_review_payload("run-review-2")
    payload["events"] = [{"type": "checkpoint"}]

    with pytest.raises(ValueError, match="PlanningState"):
        await store.store(
            json.dumps(payload),
            tier="semantic",
            metadata={
                "schema_version": 1,
                "source": "planning_review",
                "run_id": "run-review-2",
            },
            content_type="json",
        )


async def test_store_rejects_planning_state_source_for_semantic() -> None:
    store = OmniMemStore(db_path=":memory:")

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
            },
            content_type="json",
        )


async def test_memory_store_tool_accepts_planning_review_schema_fields() -> None:
    store = OmniMemStore(db_path=":memory:")
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
                    "schema_version": 1,
                    "source": "planning_review",
                    "run_id": run_id,
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
    assert recall_result["records"][0]["metadata"]["source"] == "planning_review"  # type: ignore[index]
    assert recall_result["records"][0]["metadata"]["run_id"] == run_id  # type: ignore[index]
