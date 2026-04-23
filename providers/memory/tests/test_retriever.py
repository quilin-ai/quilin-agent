from __future__ import annotations

import time

from omnimem.retriever import MemoryRetriever
from omnimem.store import OmniMemStore
from omnimem.types import MemoryItem


async def test_bm25_fts_retriever_returns_episodic_without_vectors() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.add(
        MemoryItem(
            content="Decision: use SQLite FTS5 BM25 for local memory recall",
            layer="episodic",
            metadata={"schema_version": 1, "source": "checkpoint-writer"},
        )
    )
    await store.add(
        MemoryItem(
            content="Unrelated scratch note about terminal colors",
            layer="episodic",
        )
    )
    await store.add(
        MemoryItem(
            content="Working note also mentions SQLite FTS5",
            layer="working",
        )
    )

    results = await MemoryRetriever(store).retrieve_bm25("SQLite BM25", limit=5)

    assert [item.content for item in results] == [
        "Decision: use SQLite FTS5 BM25 for local memory recall"
    ]
    result = results[0]
    assert result.embedding is None
    assert result.layer == "episodic"
    assert result.metadata["schema_version"] == 1
    assert result.metadata["source"] == "bm25_fts"
    assert result.metadata["memory_source"] == "checkpoint-writer"
    assert result.metadata["layer"] == "episodic"
    assert result.metadata["staleness"] == "fresh"
    assert 0.0 < result.metadata["score"] <= 1.0


async def test_bm25_fts_retriever_respects_layer_and_metadata_filters() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.add(
        MemoryItem(
            content="checkpoint alpha database migration",
            layer="episodic",
            metadata={"schema_version": 1, "session_id": "session-1"},
        )
    )
    await store.add(
        MemoryItem(
            content="checkpoint beta database migration",
            layer="episodic",
            metadata={"schema_version": 1, "session_id": "session-2"},
        )
    )

    results = await MemoryRetriever(store).retrieve_bm25(
        "database migration",
        filters={"metadata": {"session_id": "session-2"}},
    )

    assert [item.content for item in results] == ["checkpoint beta database migration"]


async def test_bm25_fts_retriever_p95_under_100ms_with_1000_items() -> None:
    store = OmniMemStore(db_path=":memory:")
    for index in range(1_000):
        marker = "target_quilin_latency" if index == 777 else "filler"
        await store.add(
            MemoryItem(
                content=f"episodic memory {index} {marker} deterministic local fixture",
                layer="episodic",
            )
        )

    retriever = MemoryRetriever(store)
    for _ in range(5):
        assert await retriever.retrieve_bm25("target_quilin_latency")

    durations_ms: list[float] = []
    for _ in range(30):
        started_at = time.perf_counter()
        results = await retriever.retrieve_bm25("target_quilin_latency")
        durations_ms.append((time.perf_counter() - started_at) * 1_000)
        assert results[0].content.startswith("episodic memory 777")

    p95_ms = sorted(durations_ms)[int(len(durations_ms) * 0.95) - 1]
    assert p95_ms < 100, f"1000-row BM25 recall p95={p95_ms:.3f}ms"
