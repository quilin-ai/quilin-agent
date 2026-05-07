from __future__ import annotations

import asyncio
import sqlite3
import time
import uuid
from pathlib import Path

import pytest

from quilin_mem import store as store_module
from quilin_mem.store import MemoryStore, QuilinMemStore
from quilin_mem.store_search import MAX_EXPANDED_QUERY_TERMS, expand_query_terms
from quilin_mem.types import MemoryItem

SEMANTIC_METADATA = {
    "schema_version": 1,
    "source": "test_fixture",
    "stability_reason": "fixture stability",
}


async def test_store_returns_record_with_uuid() -> None:
    store = QuilinMemStore(db_path=":memory:")
    record = await store.store("hello world")
    assert record.content == "hello world"
    assert record.tier == "working"
    # Verify the id is a valid UUID
    uuid.UUID(record.id)


async def test_store_with_custom_tier() -> None:
    store = QuilinMemStore(db_path=":memory:")
    record = await store.store(
        "important fact",
        tier="semantic",
        metadata=dict(SEMANTIC_METADATA),
    )
    assert record.content == "important fact"
    assert record.tier == "semantic"
    uuid.UUID(record.id)


async def test_store_generates_unique_ids() -> None:
    store = QuilinMemStore(db_path=":memory:")
    r1 = await store.store("first")
    r2 = await store.store("second")
    assert r1.id != r2.id


async def test_quilin_mem_store_implements_memory_store_protocol() -> None:
    store = QuilinMemStore(db_path=":memory:")
    assert isinstance(store, MemoryStore)


async def test_add_get_update_delete_and_count_contract() -> None:
    store = QuilinMemStore(db_path=":memory:")
    memory = MemoryItem(
        content="remember this",
        layer="episodic",
        metadata={"schema_version": 1, "source": "test"},
    )

    memory_id = await store.add(memory)
    fetched = await store.get(memory_id)
    assert fetched is not None
    assert fetched.id == memory.id
    assert fetched.content == memory.content
    assert fetched.access_count == 1
    assert fetched.last_accessed >= memory.last_accessed

    await store.update(memory_id, "remember that")
    updated = await store.get(memory_id)
    assert updated is not None
    assert updated.content == "remember that"
    assert updated.access_count == 2
    assert updated.embedding is None
    assert await store.count({"layer": "episodic"}) == 1

    await store.delete(memory_id)
    assert await store.get(memory_id) is None
    assert await store.count({"layer": "episodic"}) == 0


async def test_delete_is_soft_and_removes_deleted_rows_from_queries() -> None:
    store = QuilinMemStore(db_path=":memory:")
    memory = MemoryItem(
        content="checkpoint result",
        layer="episodic",
        metadata={"schema_version": 1, "session_id": "session-1"},
    )

    memory_id = await store.add(memory)
    await store.delete(memory_id)

    assert await store.get(memory_id) is None
    assert await store.recall("checkpoint") == []
    assert await store.search("checkpoint", filters={"layer": "episodic"}) == []
    assert await store.list_by_layer("episodic") == []
    assert await store.count({"layer": "episodic"}) == 0

    row = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT deleted FROM memory_records WHERE id = ?",
        (memory_id,),
    ).fetchone()
    assert row[0] == 1

    fts_row = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT COUNT(*) FROM memory_records_fts WHERE id = ?",
        (memory_id,),
    ).fetchone()
    assert fts_row[0] == 0


async def test_search_list_by_layer_and_clear_layer() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store("working note", tier="working")
    await store.store(
        "semantic insight",
        tier="semantic",
        metadata={
            "schema_version": 1,
            "source": "reflection",
            "stability_reason": "human reflection",
        },
    )
    await store.store(
        "semantic backup",
        tier="semantic",
        metadata=dict(SEMANTIC_METADATA),
    )

    semantic_results = await store.search("semantic", filters={"layer": "semantic"})
    assert [item.content for item in semantic_results] == [
        "semantic insight",
        "semantic backup",
    ]

    listed = await store.list_by_layer("semantic", limit=10, offset=0)
    assert [item.layer for item in listed] == ["semantic", "semantic"]

    cleared = await store.clear_layer("semantic")
    assert cleared == 2
    assert await store.count({"layer": "semantic"}) == 0


async def test_search_supports_layer_alias_metadata_and_content_type_filters() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store(
        "checkpoint alpha",
        tier="episodic",
        metadata={
            "schema_version": 1,
            "session_id": "session-1",
            "user_id": "user-1",
        },
        content_type="json",
    )
    await store.store(
        "checkpoint beta",
        tier="episodic",
        metadata={
            "schema_version": 1,
            "session_id": "session-2",
            "user_id": "user-1",
        },
        content_type="text",
    )
    await store.store("checkpoint working", tier="working")

    filtered = await store.search(
        "checkpoint",
        filters={
            "tier": "episodic",
            "metadata": {"session_id": "session-1", "user_id": "user-1"},
            "content_type": "json",
        },
    )

    assert [item.content for item in filtered] == ["checkpoint alpha"]


async def test_search_updates_access_signals_for_returned_items() -> None:
    store = QuilinMemStore(db_path=":memory:")
    record = await store.store("checkpoint alpha", tier="episodic")

    results = await store.search("checkpoint", filters={"layer": "episodic"})

    assert [item.content for item in results] == ["checkpoint alpha"]
    assert results[0].access_count == 1
    assert results[0].last_accessed >= record.last_accessed

    persisted = await store.get(record.id)
    assert persisted is not None
    assert persisted.access_count == 2


async def test_list_by_layer_supports_pagination_in_row_order() -> None:
    store = QuilinMemStore(db_path=":memory:")
    for index in range(5):
        await store.store(
            f"semantic-{index}",
            tier="semantic",
            metadata={
                "schema_version": 1,
                "source": "test_fixture",
                "stability_reason": f"fixture stability {index}",
            },
        )

    first_page = await store.list_by_layer("semantic", limit=2, offset=0)
    second_page = await store.list_by_layer("semantic", limit=2, offset=2)
    third_page = await store.list_by_layer("semantic", limit=2, offset=4)

    assert [item.content for item in first_page] == ["semantic-0", "semantic-1"]
    assert [item.content for item in second_page] == ["semantic-2", "semantic-3"]
    assert [item.content for item in third_page] == ["semantic-4"]


async def test_count_respects_layer_metadata_and_content_type_filters() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store(
        "session one json",
        tier="episodic",
        metadata={"schema_version": 1, "session_id": "session-1"},
        content_type="json",
    )
    await store.store(
        "session one text",
        tier="episodic",
        metadata={"schema_version": 1, "session_id": "session-1"},
        content_type="text",
    )
    await store.store(
        "session two json",
        tier="episodic",
        metadata={"schema_version": 1, "session_id": "session-2"},
        content_type="json",
    )
    await store.store(
        "semantic json",
        tier="semantic",
        content_type="json",
        metadata=dict(SEMANTIC_METADATA),
    )

    assert await store.count({"layer": "episodic"}) == 3
    assert (
        await store.count(
            {
                "layer": "episodic",
                "metadata": {"session_id": "session-1"},
            }
        )
        == 2
    )
    assert (
        await store.count(
            {
                "layer": "episodic",
                "metadata": {"session_id": "session-1"},
                "content_type": "json",
            }
        )
        == 1
    )


async def test_count_uses_sql_filters_without_materializing_search(monkeypatch: object) -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store(
        "checkpoint alpha",
        tier="episodic",
        metadata={"schema_version": 1, "session_id": "session-1"},
        content_type="json",
    )
    await store.store(
        "checkpoint beta",
        tier="episodic",
        metadata={"schema_version": 1, "session_id": "session-2"},
        content_type="json",
    )

    def fail_search(*_args: object, **_kwargs: object) -> list[MemoryItem]:
        raise AssertionError("count must not materialize records through search")

    monkeypatch.setattr(store, "_search_sync", fail_search)  # type: ignore[attr-defined]

    assert (
        await store.count(
            {
                "layer": "episodic",
                "metadata": {"session_id": "session-1"},
                "content_type": "json",
            }
        )
        == 1
    )


async def test_recall_empty_query_returns_all() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store("alpha")
    await store.store("beta")
    await store.store("gamma")
    results = await store.recall("")
    assert len(results) == 3


async def test_recall_substring_match() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store("The quick brown fox")
    await store.store("A lazy dog")
    await store.store("Quick thinking")
    results = await store.recall("quick")
    assert len(results) == 2
    contents = [r.content for r in results]
    assert "The quick brown fox" in contents
    assert "Quick thinking" in contents


async def test_recall_case_insensitive() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store("Hello World")
    await store.store("HELLO THERE")
    await store.store("goodbye")
    results = await store.recall("hello")
    assert len(results) == 2
    contents = [r.content for r in results]
    assert "Hello World" in contents
    assert "HELLO THERE" in contents


async def test_recall_no_match_returns_empty() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store("apple")
    await store.store("banana")
    results = await store.recall("cherry")
    assert len(results) == 0


async def test_recall_empty_store() -> None:
    store = QuilinMemStore(db_path=":memory:")
    results = await store.recall("anything")
    assert len(results) == 0


async def test_recall_returns_copies() -> None:
    """Recall should return a new list, not a reference to the internal list."""
    store = QuilinMemStore(db_path=":memory:")
    await store.store("item")
    results = await store.recall("")
    results.clear()
    # Internal list should be unaffected
    results2 = await store.recall("")
    assert len(results2) == 1


async def test_reset_clears_all_records() -> None:
    """reset() should clear all stored records."""
    store = QuilinMemStore(db_path=":memory:")
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

    store = QuilinMemStore(db_path=":memory:")
    await store.store("test content")
    results = await store.recall("test")
    assert len(results) == 1
    with pytest.raises(AttributeError):
        results[0].content = "mutated"  # type: ignore[misc]


async def test_store_persists_records_across_instances(tmp_path: Path) -> None:
    db_path = tmp_path / "quilin-mem.db"

    writer = QuilinMemStore(db_path=str(db_path))
    await writer.store(
        "remember me",
        tier="semantic",
        metadata=dict(SEMANTIC_METADATA),
    )

    reader = QuilinMemStore(db_path=str(db_path))
    results = await reader.recall("remember")

    assert results == [
        next(
            record for record in await writer.recall("remember") if record.content == "remember me"
        )
    ]


async def test_store_creates_fts_table() -> None:
    store = QuilinMemStore(db_path=":memory:")

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
    store = QuilinMemStore(db_path=":memory:")
    await store.store("用户的名字是老孟")

    results = await store.recall("名字")

    assert [record.content for record in results] == ["用户的名字是老孟"]


async def test_recall_expands_generic_memory_queries_for_fts() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store("用户的名字是老孟")

    results = await store.recall("记得")

    assert [record.content for record in results] == ["用户的名字是老孟"]


async def test_update_revalidates_semantic_contracts() -> None:
    store = QuilinMemStore(db_path=":memory:")
    run_id = "run-semantic-update"
    record = await store.store(
        """
        {"run_id":"run-semantic-update","source":"planning_review","schema_version":1,
        "summary":"Stable strategy","stable_strategy":{"approach":"summarize-first"}}
        """.replace("\n", ""),
        tier="semantic",
        metadata={
            "schema_version": 1,
            "source": "planning_review",
            "run_id": run_id,
            "stability_reason": "Validated stable review summary.",
        },
        content_type="json",
    )

    with pytest.raises(ValueError, match="PlanningState"):
        await store.update(
            record.id,
            """
            {"runId":"run-live","phase":"executing","events":[],"checkpoints":[]}
            """.replace("\n", ""),
        )

    persisted = await store.get(record.id)
    assert persisted is not None
    assert "Stable strategy" in persisted.content


async def test_expand_query_terms_caps_the_match_term_count() -> None:
    query = " ".join(f"term_{index}" for index in range(MAX_EXPANDED_QUERY_TERMS + 20))

    terms = expand_query_terms(query)

    assert len(terms) == MAX_EXPANDED_QUERY_TERMS


async def test_recall_falls_back_to_like_when_fts_returns_no_results() -> None:
    store = QuilinMemStore(db_path=":memory:")
    await store.store("用户的名字是老孟")

    results = await store.recall("孟")

    assert [record.content for record in results] == ["用户的名字是老孟"]


async def test_store_defaults_to_quilin_home_db(
    monkeypatch: object,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))  # type: ignore[attr-defined]
    monkeypatch.setenv("QUILIN_ENV", "dev")  # type: ignore[attr-defined]
    monkeypatch.delenv("QUILIN_MEM_DB_PATH", raising=False)  # type: ignore[attr-defined]

    store = QuilinMemStore()
    await store.store("home default path")

    assert (tmp_path / ".quilin" / "memory.db").exists()


@pytest.mark.parametrize("legacy_tier", ["short", "long"])
async def test_store_rejects_invalid_tier(legacy_tier: str) -> None:
    store = QuilinMemStore(db_path=":memory:")

    with pytest.raises(ValueError, match="Invalid memory tier"):
        await store.store("bad tier", tier=legacy_tier)  # type: ignore[arg-type]


async def test_store_offloads_blocking_db_work_from_event_loop(
    monkeypatch: object,
) -> None:
    store = QuilinMemStore(db_path=":memory:")
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
    import sqlite3

    import pytest

    async with QuilinMemStore(db_path=":memory:") as store:
        await store.store("alpha")

    with pytest.raises(sqlite3.ProgrammingError):
        await store.reset()


async def test_reset_offloads_blocking_db_work_from_event_loop(
    monkeypatch: object,
) -> None:
    store = QuilinMemStore(db_path=":memory:")
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
    store = QuilinMemStore(db_path=":memory:")

    await asyncio.gather(*[store.store(f"concurrent-{index}") for index in range(100)])

    main_count = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT COUNT(*) FROM memory_records"
    ).fetchone()[0]
    fts_count = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT COUNT(*) FROM memory_records_fts"
    ).fetchone()[0]

    assert main_count == 100
    assert fts_count == main_count


async def test_store_rebuilds_fts_once_for_legacy_db_without_schema_version(
    monkeypatch: object,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "legacy.db"
    legacy = sqlite3.connect(db_path)
    legacy.execute(
        """
        CREATE TABLE memory_records (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            tier TEXT NOT NULL CHECK (
                tier IN ('working', 'episodic', 'semantic', 'skill')
            )
        )
        """
    )
    legacy.execute(
        """
        CREATE VIRTUAL TABLE memory_records_fts USING fts5(
            id UNINDEXED,
            content,
            keywords,
            tokenize = 'unicode61'
        )
        """
    )
    legacy.execute(
        "INSERT INTO memory_records (id, content, tier) VALUES (?, ?, ?)",
        ("legacy-1", "remember me", "working"),
    )
    legacy.commit()
    legacy.close()

    rebuild_calls: list[str] = []
    original_rebuild = store_module.QuilinMemStore._rebuild_fts_index

    def tracking_rebuild(self: QuilinMemStore) -> None:
        rebuild_calls.append("rebuild")
        original_rebuild(self)

    monkeypatch.setattr(store_module.QuilinMemStore, "_rebuild_fts_index", tracking_rebuild)  # type: ignore[attr-defined]

    first = QuilinMemStore(db_path=str(db_path))
    version_row = first._conn.execute(  # type: ignore[attr-defined]
        "SELECT version FROM schema_version WHERE component = ?",
        (store_module.FTS_SCHEMA_COMPONENT,),
    ).fetchone()
    assert version_row[0] == store_module.FTS_SCHEMA_VERSION
    await first.close()

    second = QuilinMemStore(db_path=str(db_path))
    await second.close()

    assert rebuild_calls == ["rebuild"]


async def test_close_commits_before_closing_connection(tmp_path: Path) -> None:
    db_path = tmp_path / "close-commit.db"
    store = QuilinMemStore(db_path=str(db_path))
    await store.store("persist me")
    real_conn = store._conn  # type: ignore[attr-defined]

    class TrackingConnection:
        def __init__(self, conn: sqlite3.Connection) -> None:
            self._conn = conn
            self.commit_calls = 0
            self.close_calls = 0

        def commit(self) -> None:
            self.commit_calls += 1
            self._conn.commit()

        def close(self) -> None:
            self.close_calls += 1
            self._conn.close()

    tracking = TrackingConnection(real_conn)
    store._conn = tracking  # type: ignore[attr-defined]

    await store.close()

    assert tracking.commit_calls == 1
    assert tracking.close_calls == 1
