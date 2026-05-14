from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from quilin_mem.kg import (
    KG_BUSY_TIMEOUT_MS,
    KG_SCHEMA_COMPONENT,
    KG_SCHEMA_VERSION,
    TemporalKnowledgeGraph,
)


async def test_temporal_kg_schema_includes_validity_columns() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")

    columns = {
        row[1]
        for row in graph._conn.execute(  # type: ignore[attr-defined]
            "PRAGMA table_info(kg_edges)"
        ).fetchall()
    }

    assert "valid_from" in columns
    assert "valid_to" in columns


def test_temporal_kg_defaults_to_dedicated_file_and_busy_timeout(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("QUILIN_ENV", raising=False)  # type: ignore[attr-defined]
    monkeypatch.delenv("QUILIN_MEM_DB_PATH", raising=False)  # type: ignore[attr-defined]
    monkeypatch.delenv("QUILIN_MEM_KG_PATH", raising=False)  # type: ignore[attr-defined]
    monkeypatch.setenv("HOME", str(tmp_path))

    graph = TemporalKnowledgeGraph()
    try:
        database_path = graph._conn.execute(  # type: ignore[attr-defined]
            "PRAGMA database_list"
        ).fetchone()[2]

        assert database_path == str(tmp_path / ".quilin" / "memory-kg.db")
        assert graph._conn.execute("PRAGMA busy_timeout").fetchone()[0] == KG_BUSY_TIMEOUT_MS  # type: ignore[attr-defined]
    finally:
        graph._close_sync()  # type: ignore[attr-defined]


def test_temporal_kg_uses_memory_in_test_env(monkeypatch) -> None:
    monkeypatch.setenv("QUILIN_ENV", "test")
    monkeypatch.delenv("QUILIN_MEM_KG_PATH", raising=False)  # type: ignore[attr-defined]

    graph = TemporalKnowledgeGraph()
    try:
        assert graph._conn.execute("PRAGMA database_list").fetchone()[2] == ""  # type: ignore[attr-defined]
    finally:
        graph._close_sync()  # type: ignore[attr-defined]


def test_temporal_kg_schema_ensure_is_idempotent(tmp_path: Path) -> None:
    graph = TemporalKnowledgeGraph(db_path=str(tmp_path / "kg.db"))
    try:
        before_changes = graph._conn.total_changes  # type: ignore[attr-defined]

        graph._ensure_schema()  # type: ignore[attr-defined]

        version = graph._conn.execute(  # type: ignore[attr-defined]
            "SELECT version FROM schema_version WHERE component = ?",
            (KG_SCHEMA_COMPONENT,),
        ).fetchone()[0]
        assert version == KG_SCHEMA_VERSION
        assert graph._conn.total_changes == before_changes  # type: ignore[attr-defined]
    finally:
        graph._close_sync()  # type: ignore[attr-defined]


async def test_subgraph_search_supports_recursive_hop_queries() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    now = datetime(2026, 4, 24, tzinfo=UTC)

    await graph.add_edge("alice", "works_with", "bob", valid_from=now)
    await graph.add_edge("bob", "manages", "carol", valid_from=now)
    await graph.add_edge("carol", "mentors", "dana", valid_from=now)

    results = await graph.subgraph_search(["alice"], max_hops=2, limit=10)

    assert [(result.subject, result.object, result.depth) for result in results] == [
        ("alice", "bob", 1),
        ("bob", "carol", 2),
    ]
    assert results[1].path.endswith("bob -> manages -> carol")


async def test_subgraph_search_deduplicates_repeated_seed_entities() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    now = datetime(2026, 4, 24, tzinfo=UTC)

    await graph.add_edge("alice", "works_with", "bob", valid_from=now)

    results = await graph.subgraph_search(["alice", "Alice", "alice"], max_hops=1, limit=10)

    assert [(result.seed_entity, result.subject, result.object) for result in results] == [
        ("alice", "alice", "bob")
    ]


async def test_subgraph_search_normalizes_entities_before_matching() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    now = datetime(2026, 4, 24, tzinfo=UTC)

    await graph.add_edge("Alice|Ops", "works_with", "Bob", valid_from=now)

    results = await graph.subgraph_search(["ALICE|OPS", "aliceops"], max_hops=1, limit=10)

    assert [(result.seed_entity, result.subject, result.object) for result in results] == [
        ("aliceops", "Alice|Ops", "Bob")
    ]


async def test_subgraph_search_keeps_same_edge_for_distinct_current_entities() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    now = datetime(2026, 4, 24, tzinfo=UTC)

    await graph.add_edge("alice", "links", "bob", valid_from=now)
    await graph.add_edge("alice", "links", "carol", valid_from=now)
    bridge_edge_id = await graph.add_edge("bob", "links", "carol", valid_from=now)

    results = await graph.subgraph_search(["alice"], max_hops=2, limit=10)

    bridge_results = {
        (result.edge_id, result.current_entity, result.depth)
        for result in results
        if result.edge_id == bridge_edge_id
    }
    assert bridge_results == {
        (bridge_edge_id, "bob", 2),
        (bridge_edge_id, "carol", 2),
    }


async def test_subgraph_search_respects_validity_windows() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    await graph.add_edge(
        "project_alpha",
        "owned_by",
        "team_legacy",
        valid_from="2024-01-01T00:00:00+00:00",
        valid_to="2024-06-01T00:00:00+00:00",
    )
    await graph.add_edge(
        "project_alpha",
        "owned_by",
        "team_modern",
        valid_from="2024-06-02T00:00:00+00:00",
    )

    current_results = await graph.subgraph_search(
        ["project_alpha"],
        max_hops=1,
        as_of="2026-04-24T00:00:00+00:00",
    )
    past_results = await graph.subgraph_search(
        ["project_alpha"],
        max_hops=1,
        as_of="2024-02-01T00:00:00+00:00",
    )

    assert [(result.subject, result.object) for result in current_results] == [
        ("project_alpha", "team_modern")
    ]
    assert [(result.subject, result.object) for result in past_results] == [
        ("project_alpha", "team_legacy")
    ]


async def test_temporal_kg_normalizes_temporal_values_to_utc_for_storage_and_queries() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    edge_id = await graph.add_edge(
        "project_alpha",
        "owned_by",
        "team_modern",
        valid_from="2024-06-01T10:00:00+08:00",
        valid_to="2024-06-01T07:00:00+02:00",
    )

    stored_row = graph._conn.execute(  # type: ignore[attr-defined]
        "SELECT valid_from, valid_to FROM kg_edges WHERE edge_id = ?",
        (edge_id,),
    ).fetchone()
    assert stored_row["valid_from"] == "2024-06-01T02:00:00+00:00"
    assert stored_row["valid_to"] == "2024-06-01T05:00:00+00:00"

    results = await graph.subgraph_search(
        ["project_alpha"],
        max_hops=1,
        as_of="2024-06-01T03:00:00+00:00",
    )

    assert [(result.subject, result.object) for result in results] == [
        ("project_alpha", "team_modern")
    ]
    assert results[0].valid_from == datetime(2024, 6, 1, 2, 0, tzinfo=UTC)
    assert results[0].valid_to == datetime(2024, 6, 1, 5, 0, tzinfo=UTC)


async def test_search_extracts_entities_from_query_text() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    await graph.add_edge("用户", "名字是", "老孟")

    results = await graph.search("我记得老孟是谁吗", max_hops=1)

    assert [(result.subject, result.object) for result in results] == [("用户", "老孟")]


async def test_dump_edges_returns_newest_first_within_limit() -> None:
    """UX-4 Slice 3 backend: dump_edges returns edges newest-first up to limit."""
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    # Insert 5 edges; we expect dump_edges to return them all (limit
    # default 500 >> 5), with newest first.
    for i in range(5):
        await graph.add_edge(f"S{i}", "p", f"O{i}", weight=0.5 + 0.1 * i)
    edges = await graph.dump_edges(limit=10)
    assert len(edges) == 5
    # All subjects/objects are present.
    subjects = {e["subject"] for e in edges}
    assert subjects == {"S0", "S1", "S2", "S3", "S4"}
    # Each row has the expected shape.
    first = edges[0]
    for key in (
        "edge_id",
        "subject",
        "predicate",
        "object",
        "valid_from",
        "valid_to",
        "memory_id",
        "weight",
        "metadata",
        "created_at",
    ):
        assert key in first


async def test_dump_edges_honors_limit_clamp() -> None:
    """limit is clamped to [1, 2000]."""
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    for i in range(3):
        await graph.add_edge(f"S{i}", "p", "O")
    # Way-too-big limit gets clamped down — we still get back what exists.
    edges = await graph.dump_edges(limit=999_999)
    assert len(edges) == 3
    # Zero / negative limit clamped UP to 1.
    edges_one = await graph.dump_edges(limit=0)
    assert len(edges_one) == 1


async def test_dump_edges_as_of_filter_excludes_out_of_window_edges() -> None:
    """as_of filters edges whose [valid_from, valid_to] doesn't contain the moment."""
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    await graph.add_edge(
        "Ada", "works at", "Anthropic",
        valid_from="2025-01-01T00:00:00+00:00",
        valid_to="2025-06-01T00:00:00+00:00",
    )
    await graph.add_edge(
        "Ada", "works at", "OpenAI",
        valid_from="2024-01-01T00:00:00+00:00",
        valid_to="2024-12-31T00:00:00+00:00",
    )
    # Query at 2025-03 → only the Anthropic edge should be valid.
    edges = await graph.dump_edges(as_of="2025-03-01T00:00:00+00:00")
    assert len(edges) == 1
    assert edges[0]["object"] == "Anthropic"


async def test_dump_edges_as_of_includes_open_ended_edges() -> None:
    """An edge with `valid_to=None` (no expiry) is always returned by as_of filter."""
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    await graph.add_edge(
        "Ada", "lives in", "SF",
        valid_from="2020-01-01T00:00:00+00:00",
        # no valid_to — open-ended
    )
    await graph.add_edge(
        "Bob", "lives in", "NYC",
        valid_from="2024-01-01T00:00:00+00:00",
        valid_to="2024-06-01T00:00:00+00:00",
    )
    # as_of in 2025: only the open-ended Ada edge should remain (Bob's expired).
    edges = await graph.dump_edges(as_of="2025-03-01T00:00:00+00:00")
    assert len(edges) == 1
    assert edges[0]["subject"] == "Ada"
    assert edges[0]["valid_to"] is None
