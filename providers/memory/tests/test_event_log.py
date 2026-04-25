from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from omnimem.event_log import (
    CitationStats,
    RetrievalEventLog,
    TraceContext,
    hash_query,
    parse_traceparent,
)
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
    event_ids = await event_log.record_retrieval("run-cite", "database migration", results)

    updated = await event_log.mark_cited("run-cite", [event_ids[1]])
    stats = await event_log.citation_stats(["memory-1", "memory-2"])

    assert updated == 1
    assert stats["memory-1"].citation_rate == 0.0
    assert stats["memory-2"].citation_rate == 1.0


async def test_event_log_marks_citations_by_event_id_not_memory_id() -> None:
    event_log = RetrievalEventLog(db_path=":memory:")
    results = [_retrieved_item("memory-1", source="bm25_fts", layer="episodic", score=0.9)]
    first_event_ids = await event_log.record_retrieval("run-cite", "query one", results)
    await event_log.record_retrieval("run-cite", "query two", results)

    updated = await event_log.mark_cited("run-cite", [first_event_ids[0]])
    cited_events = await event_log.list_events(run_id="run-cite", cited_only=True)
    stats = await event_log.citation_stats(["memory-1"])

    assert updated == 1
    assert [event.event_id for event in cited_events] == first_event_ids
    assert stats["memory-1"].impressions == 2
    assert stats["memory-1"].citations == 1


async def test_event_log_persists_trace_columns_and_dual_emits_span_events() -> None:
    emitted: list[tuple[str, dict[str, object]]] = []
    event_log = RetrievalEventLog(
        db_path=":memory:",
        top_n=1,
        span_event_sink=lambda name, attributes: emitted.append((name, attributes)),
    )
    trace_context = TraceContext(
        trace_id="a" * 32,
        span_id="b" * 16,
        request_id="request-1",
    )

    event_ids = await event_log.record_retrieval(
        "run-trace",
        "database migration",
        [_retrieved_item("memory-1", source="bm25_fts", layer="episodic", score=0.9)],
        trace_context=trace_context,
    )
    await event_log.mark_cited(
        "run-trace",
        event_ids,
        trace_context=trace_context,
    )
    events = await event_log.list_events(run_id="run-trace")

    assert events[0].trace_id == "a" * 32
    assert events[0].span_id == "b" * 16
    assert events[0].request_id == "request-1"
    assert [event_name for event_name, _attributes in emitted] == [
        "memory.retrieval_sample",
        "memory.citation_sample",
    ]
    assert emitted[0][1]["trace.trace_id"] == "a" * 32
    assert emitted[0][1]["memory.rank.index"] == 1


async def test_event_log_dual_emit_failure_does_not_block_sqlite_write() -> None:
    def failing_sink(_name: str, _attributes: dict[str, object]) -> None:
        raise RuntimeError("otel unavailable")

    event_log = RetrievalEventLog(
        db_path=":memory:",
        top_n=1,
        span_event_sink=failing_sink,
    )

    event_ids = await event_log.record_retrieval(
        "run-fallback",
        "database migration",
        [_retrieved_item("memory-1", source="bm25_fts", layer="episodic", score=0.9)],
    )
    events = await event_log.list_events(run_id="run-fallback")

    assert len(event_ids) == 1
    assert [event.event_id for event in events] == event_ids


async def test_event_log_lifecycle_and_empty_boundaries(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("QUILIN_ENV", "test")
    async with RetrievalEventLog(top_n=1) as event_log:
        assert await event_log.record_retrieval("run-empty", "query", [], top_n=0) == []
        assert await event_log.mark_cited("run-empty", ["", ""]) == 0
        assert await event_log.citation_stats(["", ""]) == {}
        await event_log.reset()

    await event_log.close()

    with pytest.raises(ValueError, match="top_n"):
        RetrievalEventLog(db_path=":memory:", top_n=0)

    db_path = tmp_path / "nested" / "events.db"
    monkeypatch.delenv("QUILIN_ENV", raising=False)
    monkeypatch.setenv("OMNIMEM_EVENT_LOG_PATH", str(db_path))
    file_event_log = RetrievalEventLog()
    await file_event_log.close()

    assert db_path.exists()


async def test_event_log_object_span_sink_and_source_layer_fallbacks() -> None:
    class RecordingSpan:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict[str, object]]] = []

        def add_event(self, name: str, attributes: dict[str, object]) -> None:
            self.events.append((name, attributes))

    sink = RecordingSpan()
    event_log = RetrievalEventLog(
        db_path=":memory:",
        top_n=2,
        span_event_sink=sink,
    )
    kg_item = MemoryItem(
        id="kg-memory",
        content="knowledge graph fact",
        layer="semantic",
        metadata={"schema_version": 1, "source": "kg_subgraph", "score": 0.8},
        created_at=datetime(2026, 4, 24, tzinfo=UTC),
    )
    default_item = MemoryItem(
        id="working-memory",
        content="plain fact",
        layer="working",
        metadata={"schema_version": 1, "score": 0.4},
        created_at=datetime(2026, 4, 24, tzinfo=UTC),
    )

    await event_log.record_retrieval("run-source", "query", [kg_item, default_item])
    events = await event_log.list_events(run_id="run-source")
    await event_log.close()

    assert [event.source_layer for event in events] == ["kg", "working"]
    assert [name for name, _attributes in sink.events] == [
        "memory.retrieval_sample",
        "memory.retrieval_sample",
    ]


def test_event_log_parse_and_stats_boundary_helpers() -> None:
    assert parse_traceparent(None) is None
    assert CitationStats(memory_id="memory-1", impressions=0, citations=0).citation_rate == 0.0


def test_parse_traceparent_extracts_w3c_trace_context() -> None:
    trace_context = parse_traceparent(
        f"00-{'a' * 32}-{'b' * 16}-01",
        request_id="request-1",
    )

    assert trace_context is not None
    assert trace_context.trace_id == "a" * 32
    assert trace_context.span_id == "b" * 16
    assert trace_context.request_id == "request-1"
    assert trace_context.traceparent == f"00-{'a' * 32}-{'b' * 16}-01"
    assert parse_traceparent("bad-traceparent") is None
