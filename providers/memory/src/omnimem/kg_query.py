from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from typing import Any

from .kg_validation import (
    KGSearchResult,
    normalize_datetime,
    normalize_entity,
    search_result_from_row,
)


def subgraph_search_sync(
    conn: sqlite3.Connection,
    lock: threading.Lock,
    entities: list[str],
    max_hops: int,
    limit: int,
    as_of: datetime | str | None,
    filters: dict[str, Any] | None = None,
) -> list[KGSearchResult]:
    if max_hops < 1:
        raise ValueError("max_hops must be at least 1")

    effective_limit = max(limit, 0)
    if effective_limit == 0:
        return []

    normalized_entities = (normalize_entity(entity) for entity in entities)
    seeds = sorted({entity for entity in normalized_entities if entity})
    if not seeds:
        return []

    temporal_condition, temporal_params = _temporal_filter(as_of)
    metadata_condition, metadata_params = _metadata_filter(filters)
    placeholders = ", ".join(["(?)"] * len(seeds))
    subject_key_expr = "LOWER(TRIM(REPLACE(e.subject, '|', '')))"
    object_key_expr = "LOWER(TRIM(REPLACE(e.object, '|', '')))"
    initial_current_entity_expr = f"""
        CASE
            WHEN {subject_key_expr} = seed.seed_entity THEN e.object
            ELSE e.subject
        END
    """
    initial_current_entity_key_expr = f"""
        CASE
            WHEN {subject_key_expr} = seed.seed_entity THEN {object_key_expr}
            ELSE {subject_key_expr}
        END
    """
    next_entity_expr = """
        CASE
            WHEN LOWER(TRIM(REPLACE(e.subject, '|', ''))) = graph.current_entity_key
                THEN e.object
            ELSE e.subject
        END
    """
    next_entity_key_expr = f"""
        CASE
            WHEN {subject_key_expr} = graph.current_entity_key THEN {object_key_expr}
            ELSE {subject_key_expr}
        END
    """
    query_limit = effective_limit * max(max_hops, 1) * max(len(seeds), 1) * 4
    sql = f"""
        WITH RECURSIVE
        seed(seed_entity) AS (
            VALUES {placeholders}
        ),
        graph AS (
            SELECT
                e.edge_id,
                e.subject,
                e.predicate,
                e.object,
                e.valid_from,
                e.valid_to,
                e.memory_id,
                e.weight,
                e.metadata_json,
                1 AS depth,
                seed.seed_entity AS seed_entity,
                {initial_current_entity_expr} AS current_entity,
                {initial_current_entity_key_expr} AS current_entity_key,
                e.subject || ' -> ' || e.predicate || ' -> ' || e.object AS path,
                json_array(seed.seed_entity, {initial_current_entity_key_expr}) AS visited
            FROM kg_edges e
            JOIN seed
              ON {subject_key_expr} = seed.seed_entity
              OR {object_key_expr} = seed.seed_entity
            WHERE {temporal_condition}
              AND {metadata_condition}

            UNION ALL

            SELECT
                e.edge_id,
                e.subject,
                e.predicate,
                e.object,
                e.valid_from,
                e.valid_to,
                e.memory_id,
                e.weight,
                e.metadata_json,
                graph.depth + 1 AS depth,
                graph.seed_entity AS seed_entity,
                {next_entity_expr} AS current_entity,
                {next_entity_key_expr} AS current_entity_key,
                graph.path
                    || ' => '
                    || e.subject
                    || ' -> '
                    || e.predicate
                    || ' -> '
                    || e.object AS path,
                json_insert(graph.visited, '$[#]', {next_entity_key_expr}) AS visited
            FROM graph
            JOIN kg_edges e
              ON {subject_key_expr} = graph.current_entity_key
              OR {object_key_expr} = graph.current_entity_key
            WHERE graph.depth < ?
              AND {temporal_condition}
              AND {metadata_condition}
              AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(graph.visited)
                  WHERE json_each.value = {next_entity_key_expr}
              )
        )
        SELECT
            edge_id,
            seed_entity,
            current_entity,
            subject,
            predicate,
            object,
            depth,
            path,
            valid_from,
            valid_to,
            memory_id,
            weight,
            metadata_json
        FROM graph
        ORDER BY depth ASC, weight DESC, edge_id ASC
        LIMIT ?
    """

    params: list[object] = [
        *seeds,
        *temporal_params,
        *metadata_params,
        max_hops,
        *temporal_params,
        *metadata_params,
        query_limit,
    ]
    with lock:
        rows = conn.execute(sql, params).fetchall()

    return _dedupe_results(rows, effective_limit)


def _temporal_filter(as_of: datetime | str | None) -> tuple[str, list[object]]:
    resolved_as_of = normalize_datetime(as_of)
    if resolved_as_of is None:
        return "1 = 1", []

    temporal_value = resolved_as_of.isoformat()
    return "e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?)", [
        temporal_value,
        temporal_value,
    ]


def _metadata_filter(filters: dict[str, Any] | None) -> tuple[str, list[object]]:
    if not filters:
        return "1 = 1", []

    metadata_filters = filters.get("metadata")
    if not isinstance(metadata_filters, dict) or not metadata_filters:
        return "1 = 1", []

    predicates: list[str] = []
    params: list[object] = []
    for key, value in sorted(metadata_filters.items()):
        predicates.append("json_extract(e.metadata_json, ?) = ?")
        params.extend((_metadata_json_path(str(key)), _metadata_value(value)))

    return " AND ".join(predicates), params


def _metadata_json_path(key: str) -> str:
    escaped_key = key.replace("\\", "\\\\").replace('"', '\\"')
    return f'$."{escaped_key}"'


def _metadata_value(value: object) -> object:
    if isinstance(value, bool):
        return int(value)
    if value is None or isinstance(value, int | float | str):
        return value

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _dedupe_results(rows: list[sqlite3.Row], effective_limit: int) -> list[KGSearchResult]:
    seen: set[tuple[str, str]] = set()
    results: list[KGSearchResult] = []
    for row in rows:
        dedupe_key = (row["edge_id"], row["current_entity"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        results.append(search_result_from_row(row))
        if len(results) >= effective_limit:
            break

    return results
