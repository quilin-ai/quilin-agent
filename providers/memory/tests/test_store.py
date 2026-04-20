from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

from omnimem import store as store_module
from omnimem.store import OmniMemStore


async def test_store_returns_record_with_uuid() -> None:
    store = OmniMemStore(db_path=":memory:")
    record = await store.store("hello world")
    assert record.content == "hello world"
    assert record.tier == "working"
    # Verify the id is a valid UUID
    uuid.UUID(record.id)


async def test_store_with_custom_tier() -> None:
    store = OmniMemStore(db_path=":memory:")
    record = await store.store("important fact", tier="semantic")
    assert record.content == "important fact"
    assert record.tier == "semantic"
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

    await store.reset()
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
    await writer.store("remember me", tier="semantic")

    reader = OmniMemStore(db_path=str(db_path))
    results = await reader.recall("remember")

    assert results == [
        next(
            record
            for record in await writer.recall("remember")
            if record.content == "remember me"
        )
    ]


async def test_store_creates_fts_table() -> None:
    store = OmniMemStore(db_path=":memory:")

    table_names = {
        row[0]
        for row in store._conn.execute(  # type: ignore[attr-defined]
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            """
        ).fetchall()
    }

    assert "memory_records_fts" in table_names


async def test_recall_uses_fts_for_cjk_tokens() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.store("用户的名字是老孟")

    results = await store.recall("名字")

    assert [record.content for record in results] == ["用户的名字是老孟"]


async def test_recall_expands_generic_memory_queries_for_fts() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.store("用户的名字是老孟")

    results = await store.recall("记得")

    assert [record.content for record in results] == ["用户的名字是老孟"]


async def test_recall_falls_back_to_like_when_fts_returns_no_results() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.store("用户的名字是老孟")

    results = await store.recall("孟")

    assert [record.content for record in results] == ["用户的名字是老孟"]


async def test_store_defaults_to_quilin_home_db(
    monkeypatch: object,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))  # type: ignore[attr-defined]
    monkeypatch.setenv("QUILIN_ENV", "dev")  # type: ignore[attr-defined]
    monkeypatch.delenv("OMNIMEM_DB_PATH", raising=False)  # type: ignore[attr-defined]

    store = OmniMemStore()
    await store.store("home default path")

    assert (tmp_path / ".quilin" / "memory.db").exists()


async def test_store_rejects_invalid_tier() -> None:
    import pytest

    store = OmniMemStore(db_path=":memory:")

    with pytest.raises(ValueError, match="Invalid memory tier"):
        await store.store("bad tier", tier="short")  # type: ignore[arg-type]


async def test_store_offloads_blocking_db_work_from_event_loop(
    monkeypatch: object,
) -> None:
    store = OmniMemStore(db_path=":memory:")
    original_build_keywords = store_module._build_keywords

    def slow_build_keywords(content: str) -> str:
        time.sleep(0.05)
        return original_build_keywords(content)

    monkeypatch.setattr(store_module, "_build_keywords", slow_build_keywords)  # type: ignore[attr-defined]

    observed: list[str] = []

    async def heartbeat() -> None:
        await asyncio.sleep(0.01)
        observed.append("tick")

    await asyncio.gather(store.store("alpha"), heartbeat())

    assert observed == ["tick"]


async def test_store_closes_via_async_context_manager() -> None:
    import pytest

    async with OmniMemStore(db_path=":memory:") as store:
        await store.store("alpha")

    with pytest.raises(Exception):
        await store.reset()


async def test_reset_offloads_blocking_db_work_from_event_loop(
    monkeypatch: object,
) -> None:
    store = OmniMemStore(db_path=":memory:")
    original_reset_sync = store._reset_sync  # type: ignore[attr-defined]

    def slow_reset_sync() -> None:
        time.sleep(0.05)
        original_reset_sync()

    monkeypatch.setattr(store, "_reset_sync", slow_reset_sync)  # type: ignore[attr-defined]

    observed: list[str] = []

    async def heartbeat() -> None:
        await asyncio.sleep(0.01)
        observed.append("tick")

    await asyncio.gather(store.reset(), heartbeat())

    assert observed == ["tick"]


async def test_store_keeps_main_and_fts_counts_aligned_under_concurrency() -> None:
    store = OmniMemStore(db_path=":memory:")

    await asyncio.gather(
        *[store.store(f"concurrent-{index}") for index in range(100)]
    )

    main_count = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT COUNT(*) FROM memory_records"
    ).fetchone()[0]
    fts_count = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT COUNT(*) FROM memory_records_fts"
    ).fetchone()[0]

    assert main_count == 100
    assert fts_count == main_count
