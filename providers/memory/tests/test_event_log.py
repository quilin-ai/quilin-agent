from __future__ import annotations

from datetime import UTC, datetime

from omnimem.event_log import RetrievalEventLog, hash_query
from omnimem.types import MemoryItem


def _retrieved_item(
    memory_id: str,
    *,
    source: str,
    layer: str,
    score: float,
) -> MemoryItem:
    now = datetime(2026, 4, 24, tzinfo=UTC)
    return MemoryItem(
        id=memory_id,
        content=f"content for {memory_id}",
        layer=layer,  # type: ignore[arg-type]
        metadata={
            "schema_version": 1,
            "source": source,
            "score": score,
            "staleness": "fresh",
            "cache_key": "memory-recall:test",
            "block_version": "memory-recall-v1",
            "source_layers": [layer],
        },
        created_at=now,
        last_accessed=now,
    )


async def test_event_log_defaults_to_query_hash_and_top_n_metadata() -> None:
    event_log = RetrievalEventLog(db_path=":memory:", top_n=2)
    results = [
        _retrieved_item("memory-1", source="bm25_fts", layer="episodic", score=0.9),
        _retrieved_item("memory-2", source="vector_semantic", layer="semantic", score=0.7),
    ]

    event_ids = await event_log.record_retrieval("run-1", "database migration", results)
    events = await event_log.list_events(run_id="run-1")

    assert len(event_ids) == 2
    assert [event.event_id for event in events] == event_ids
    assert all(event.query_hash == hash_query("database migration") for event in events)
    assert all(event.query_raw is None for event in events)
    assert events[0].metadata["cache_key"] == "memory-recall:test"
    assert events[0].metadata["block_version"] == "memory-recall-v1"
    assert "content" not in events[0].metadata


async def test_event_log_persists_raw_query_only_when_opted_in() -> None:
    event_log = RetrievalEventLog(
        db_path=":memory:",
        persist_raw_query=True,
        top_n=1,
    )

    await event_log.record_retrieval(
        "run-raw",
        "remember the secret codename",
        [_retrieved_item("memory-3", source="bm25_fts", layer="episodic", score=0.6)],
    )
    events = await event_log.list_events(run_id="run-raw")

    assert [event.query_raw for event in events] == ["remember the secret codename"]


async def test_event_log_marks_citations_and_returns_stats() -> None:
    event_log = RetrievalEventLog(db_path=":memory:")
    results = [
        _retrieved_item("memory-1", source="bm25_fts", layer="episodic", score=0.9),
        _retrieved_item("memory-2", source="vector_semantic", layer="semantic", score=0.7),
    ]
    await event_log.record_retrieval("run-cite", "database migration", results)

    updated = await event_log.mark_cited("run-cite", ["memory-2"])
    stats = await event_log.citation_stats(["memory-1", "memory-2"])

    assert updated == 1
    assert stats["memory-1"].citation_rate == 0.0
    assert stats["memory-2"].citation_rate == 1.0
