from __future__ import annotations

import time
from datetime import UTC, datetime

from omnimem.kg import TemporalKnowledgeGraph
from omnimem.retriever import MemoryRetriever
from omnimem.store import OmniMemStore
from omnimem.types import MemoryItem
from omnimem.working import WorkingMemory


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


async def test_fused_retrieval_prepends_working_then_ranked_episodic() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.add(
        MemoryItem(
            content="episodic decision quilin_m0_database use Postgres",
            layer="episodic",
        )
    )
    await store.add(
        MemoryItem(
            content="episodic background database comparison",
            layer="episodic",
        )
    )
    working = WorkingMemory(k=3)
    await working.push(
        MemoryItem(
            content="current scratch: inspect retriever metadata",
            layer="working",
        )
    )

    results = await MemoryRetriever(store, working=working).retrieve(
        "quilin_m0_database database",
        limit=3,
    )

    assert [item.content for item in results] == [
        "current scratch: inspect retriever metadata",
        "episodic decision quilin_m0_database use Postgres",
        "episodic background database comparison",
    ]
    assert results[0].metadata["source"] == "working_direct"
    assert results[0].metadata["layer"] == "working"
    assert results[0].metadata["score"] == 1.0
    assert results[0].metadata["cache_key"].startswith("memory-recall:")
    assert results[0].metadata["block_version"] == "memory-recall-v1"
    assert results[0].metadata["source_layers"] == ["working"]
    assert results[1].metadata["source"] == "bm25_fts"
    assert results[1].metadata["layer"] == "episodic"
    assert results[1].metadata["score"] >= results[2].metadata["score"]
    assert results[1].metadata["cache_key"] == results[0].metadata["cache_key"]
    assert results[1].metadata["block_version"] == "memory-recall-v1"
    assert results[1].metadata["source_layers"] == ["episodic"]


async def test_fused_retrieval_applies_task_context_filters_to_episodic() -> None:
    store = OmniMemStore(db_path=":memory:")
    await store.add(
        MemoryItem(
            content="checkpoint alpha replay target",
            layer="episodic",
            metadata={"schema_version": 1, "session_id": "session-1"},
        )
    )
    await store.add(
        MemoryItem(
            content="checkpoint beta replay target",
            layer="episodic",
            metadata={"schema_version": 1, "session_id": "session-2"},
        )
    )

    results = await MemoryRetriever(store).recall(
        "checkpoint replay target",
        {"session_id": "session-2"},
    )

    assert [item.content for item in results] == ["checkpoint beta replay target"]
    assert results[0].metadata["source"] == "bm25_fts"
    assert results[0].metadata["layer"] == "episodic"
    assert results[0].metadata["cache_key"].startswith("memory-recall:")
    assert results[0].metadata["block_version"] == "memory-recall-v1"
    assert results[0].metadata["source_layers"] == ["episodic"]


class StubVectorStore:
    def __init__(self, results: list[MemoryItem]) -> None:
        self._results = results

    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, object] | None = None,
    ) -> list[MemoryItem]:
        del query, filters
        return self._results[:limit]


async def test_hybrid_retrieval_fuses_bm25_vector_and_kg_results() -> None:
    store = OmniMemStore(db_path=":memory:")
    now = datetime(2026, 4, 24, tzinfo=UTC)
    episodic = MemoryItem(
        id="memory-episodic-1",
        content="database migration playbook for quilin",
        layer="episodic",
        created_at=now,
        last_accessed=now,
    )
    semantic = MemoryItem(
        id="memory-semantic-1",
        content="semantic preference: summarize migration risk first",
        layer="semantic",
        created_at=now,
        last_accessed=now,
    )
    await store.add(episodic)
    await store.add(semantic)

    working = WorkingMemory(k=3)
    await working.push(
        MemoryItem(
            content="working scratch about migration rollout",
            layer="working",
            created_at=now,
            last_accessed=now,
        )
    )
    vector = StubVectorStore([episodic, semantic])
    kg = TemporalKnowledgeGraph(db_path=":memory:")
    await kg.add_edge(
        "migration",
        "depends_on",
        "approval",
        valid_from=now,
        memory_id="memory-semantic-1",
    )

    results = await MemoryRetriever(
        store,
        working=working,
        vector=vector,
        kg=kg,
    ).retrieve("migration rollout", limit=4)

    assert results[0].content == "working scratch about migration rollout"
    assert results[0].metadata["source"] == "working_direct"
    assert results[0].metadata["source_layers"] == ["working"]

    hybrid_item = next(item for item in results if item.id == "memory-episodic-1")
    assert hybrid_item.metadata["source"] == "hybrid_rrf"
    assert hybrid_item.metadata["source_layers"] == ["episodic"]

    semantic_item = next(item for item in results if item.id == "memory-semantic-1")
    assert semantic_item.metadata["source_layers"] == ["semantic"]
    assert semantic_item.metadata["cache_key"] == results[0].metadata["cache_key"]
    assert semantic_item.metadata["block_version"] == "memory-recall-v1"

    kg_item = next(item for item in results if item.metadata["source"] == "kg_subgraph")
    assert kg_item.content == "migration depends_on approval"
    assert kg_item.metadata["source_layers"] == ["kg"]
    assert kg_item.metadata["graph_distance"] == 1
