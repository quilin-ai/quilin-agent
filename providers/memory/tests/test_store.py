from __future__ import annotations

import uuid
from pathlib import Path

from omnimem.store import OmniMemStore


async def test_store_returns_record_with_uuid() -> None:
    store = OmniMemStore(db_path=":memory:")
    record = await store.store("hello world")
    assert record.content == "hello world"
    assert record.tier == "short"
    # Verify the id is a valid UUID
    uuid.UUID(record.id)


async def test_store_with_custom_tier() -> None:
    store = OmniMemStore(db_path=":memory:")
    record = await store.store("important fact", tier="long")
    assert record.content == "important fact"
    assert record.tier == "long"
    uuid.UUID(record.id)


async def test_store_generates_unique_ids() -> None:
    store = OmniMemStore(db_path=":memory:")
    r1 = await store.store("first")
    r2 = await store.store("second")
    assert r1.id != r2.id


async def test_recall_empty_query_returns_all() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.store("alpha")
    await store.store("beta")
    await store.store("gamma")
    results = await store.recall("")
    assert len(results) == 3


async def test_recall_substring_match() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.store("The quick brown fox")
    await store.store("A lazy dog")
    await store.store("Quick thinking")
    results = await store.recall("quick")
    assert len(results) == 2
    contents = [r.content for r in results]
    assert "The quick brown fox" in contents
    assert "Quick thinking" in contents


async def test_recall_case_insensitive() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.store("Hello World")
    await store.store("HELLO THERE")
    await store.store("goodbye")
    results = await store.recall("hello")
    assert len(results) == 2
    contents = [r.content for r in results]
    assert "Hello World" in contents
    assert "HELLO THERE" in contents


async def test_recall_no_match_returns_empty() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.store("apple")
    await store.store("banana")
    results = await store.recall("cherry")
    assert len(results) == 0


async def test_recall_empty_store() -> None:
    store = OmniMemStore(db_path=":memory:")
    results = await store.recall("anything")
    assert len(results) == 0


async def test_recall_returns_copies() -> None:
    """Recall should return a new list, not a reference to the internal list."""
    store = OmniMemStore(db_path=":memory:")
    await store.store("item")
    results = await store.recall("")
    results.clear()
    # Internal list should be unaffected
    results2 = await store.recall("")
    assert len(results2) == 1


async def test_reset_clears_all_records() -> None:
    """reset() should clear all stored records."""
    store = OmniMemStore(db_path=":memory:")
    await store.store("alpha")
    await store.store("beta")
    results = await store.recall("")
    assert len(results) == 2

    store.reset()
    results_after = await store.recall("")
    assert len(results_after) == 0


async def test_recall_records_are_immutable() -> None:
    """Returned records should be frozen — mutation raises AttributeError."""
    import pytest

    store = OmniMemStore(db_path=":memory:")
    await store.store("test content")
    results = await store.recall("test")
    assert len(results) == 1
    with pytest.raises(AttributeError):
        results[0].content = "mutated"  # type: ignore[misc]


async def test_store_persists_records_across_instances(tmp_path: Path) -> None:
    db_path = tmp_path / "omnimem.db"

    writer = OmniMemStore(db_path=str(db_path))
    await writer.store("remember me", tier="long")

    reader = OmniMemStore(db_path=str(db_path))
    results = await reader.recall("remember")

    assert results == [
        next(
            record
            for record in await writer.recall("remember")
            if record.content == "remember me"
        )
    ]
