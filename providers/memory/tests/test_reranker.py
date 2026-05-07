from __future__ import annotations

from datetime import UTC, datetime, timedelta

from quilin_mem.event_log import RetrievalEventLog
from quilin_mem.reranker import DEFAULT_SOURCE_PRIORS, LearnableReranker
from quilin_mem.types import MemoryItem


def _candidate(
    memory_id: str,
    *,
    source: str,
    score: float,
    last_accessed: datetime,
    graph_distance: int | None = None,
) -> MemoryItem:
    metadata: dict[str, object] = {
        "schema_version": 1,
        "source": source,
        "score": score,
        "source_layers": ["semantic" if source == "vector_semantic" else "episodic"],
    }
    if graph_distance is not None:
        metadata["graph_distance"] = graph_distance

    return MemoryItem(
        id=memory_id,
        content=f"candidate {memory_id}",
        layer="semantic" if source == "vector_semantic" else "episodic",
        metadata=metadata,
        created_at=last_accessed,
        last_accessed=last_accessed,
    )


async def test_reranker_uses_fixed_weights_without_event_log() -> None:
    now = datetime(2026, 4, 24, tzinfo=UTC)
    newer = _candidate(
        "memory-new",
        source="vector_semantic",
        score=0.8,
        last_accessed=now,
    )
    older = _candidate(
        "memory-old",
        source="bm25_fts",
        score=0.5,
        last_accessed=now - timedelta(days=30),
    )

    reranked = await LearnableReranker().rerank("query", [older, newer])

    assert [item.id for item in reranked] == ["memory-new", "memory-old"]
    assert reranked[0].metadata["retrieval_score"] == 0.8
    assert reranked[0].metadata["reranker_rank"] == 1
    assert reranked[0].metadata["reranker_score"] >= reranked[1].metadata["reranker_score"]


async def test_reranker_uses_citation_history_as_positive_signal() -> None:
    now = datetime(2026, 4, 24, tzinfo=UTC)
    common = _candidate(
        "memory-common",
        source="bm25_fts",
        score=0.6,
        last_accessed=now,
    )
    cited = _candidate(
        "memory-cited",
        source="bm25_fts",
        score=0.6,
        last_accessed=now,
    )
    event_log = RetrievalEventLog(db_path=":memory:")
    event_ids = await event_log.record_retrieval("run-1", "query", [common, cited])
    await event_log.mark_cited("run-1", [event_ids[1]])

    reranked = await LearnableReranker(event_log).rerank("query", [common, cited])

    assert [item.id for item in reranked] == ["memory-cited", "memory-common"]


def test_reranker_has_direct_recall_prior() -> None:
    assert DEFAULT_SOURCE_PRIORS["direct_recall"] == 0.35


async def test_reranker_prefers_shorter_graph_distance_when_scores_match() -> None:
    now = datetime(2026, 4, 24, tzinfo=UTC)
    close = _candidate(
        "memory-close",
        source="kg_subgraph",
        score=0.4,
        last_accessed=now,
        graph_distance=1,
    )
    far = _candidate(
        "memory-far",
        source="kg_subgraph",
        score=0.4,
        last_accessed=now,
        graph_distance=3,
    )

    reranked = await LearnableReranker().rerank("query", [far, close])

    assert [item.id for item in reranked] == ["memory-close", "memory-far"]
