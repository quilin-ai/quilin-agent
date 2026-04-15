from __future__ import annotations

import json

from omnimem.server import _store, memory_recall, memory_store


async def test_memory_store_tool_returns_id() -> None:
    # Reset shared store for test isolation
    _store.reset()
    result_json = await memory_store("test content")
    result = json.loads(result_json)
    assert "id" in result
    assert isinstance(result["id"], str)
    assert len(result["id"]) > 0


async def test_memory_store_tool_with_tier() -> None:
    _store.reset()
    result_json = await memory_store("important", tier="long")
    result = json.loads(result_json)
    assert "id" in result


async def test_memory_recall_tool_returns_records() -> None:
    _store.reset()
    await memory_store("hello world")
    await memory_store("hello there")
    await memory_store("goodbye")

    result_json = await memory_recall("hello")
    result = json.loads(result_json)
    assert "records" in result
    assert len(result["records"]) == 2
    for record in result["records"]:
        assert "id" in record
        assert "content" in record
        assert "tier" in record


async def test_memory_recall_tool_empty_query() -> None:
    _store.reset()
    await memory_store("alpha")
    await memory_store("beta")

    result_json = await memory_recall("")
    result = json.loads(result_json)
    assert len(result["records"]) == 2


async def test_memory_recall_tool_no_match() -> None:
    _store.reset()
    await memory_store("apple")

    result_json = await memory_recall("banana")
    result = json.loads(result_json)
    assert result["records"] == []


async def test_roundtrip_store_then_recall() -> None:
    """Store a record and recall it, verifying the full wire schema."""
    _store.reset()

    store_result = json.loads(await memory_store("my memory", tier="mid"))
    stored_id = store_result["id"]

    recall_result = json.loads(await memory_recall("my memory"))
    records = recall_result["records"]
    assert len(records) == 1
    assert records[0] == {"id": stored_id, "content": "my memory", "tier": "mid"}


async def test_memory_recall_error_path(monkeypatch: object) -> None:
    """memory_recall should return error JSON when store.recall raises."""
    _store.reset()

    async def _raise_on_recall(query: str) -> list:
        raise RuntimeError("database connection lost")

    monkeypatch.setattr(_store, "recall", _raise_on_recall)  # type: ignore[attr-defined]

    result_json = await memory_recall("anything")
    result = json.loads(result_json)
    assert "error" in result
    assert "database connection lost" in result["error"]


async def test_memory_store_error_path(monkeypatch: object) -> None:
    """memory_store should return error JSON when store.store raises."""
    _store.reset()

    async def _raise_on_store(content: str, tier: str = "short") -> None:
        raise RuntimeError("disk full")

    monkeypatch.setattr(_store, "store", _raise_on_store)  # type: ignore[attr-defined]

    result_json = await memory_store("test content")
    result = json.loads(result_json)
    assert "error" in result
    assert "disk full" in result["error"]
