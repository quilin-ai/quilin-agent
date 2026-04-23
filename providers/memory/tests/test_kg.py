from __future__ import annotations

from datetime import UTC, datetime

from omnimem.kg import TemporalKnowledgeGraph


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


async def test_search_extracts_entities_from_query_text() -> None:
    graph = TemporalKnowledgeGraph(db_path=":memory:")
    await graph.add_edge("用户", "名字是", "老孟")

    results = await graph.search("我记得老孟是谁吗", max_hops=1)

    assert [(result.subject, result.object) for result in results] == [("用户", "老孟")]
