from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

ASCII_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+")
CJK_RUN_PATTERN = re.compile(r"[\u4e00-\u9fff]+")

KG_SCHEMA_COMPONENT = "temporal_kg"
KG_SCHEMA_VERSION = 1


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _resolve_db_path(db_path: str | None) -> str:
    if db_path is not None:
        return db_path

    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"

    return os.environ.get(
        "OMNIMEM_DB_PATH",
        str(Path.home() / ".quilin" / "memory.db"),
    )


def _serialize_metadata(metadata: dict[str, object] | None) -> str:
    return json.dumps(metadata or {}, ensure_ascii=False, sort_keys=True)


def _deserialize_metadata(metadata_json: str | None) -> dict[str, object]:
    if not metadata_json:
        return {}

    loaded = json.loads(metadata_json)
    return dict(loaded) if isinstance(loaded, dict) else {}


def _format_datetime(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _parse_datetime(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def _normalize_datetime(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value)
    raise TypeError("temporal bounds must be datetime or ISO 8601 strings")


def _extract_cjk_terms(text: str) -> set[str]:
    terms: set[str] = set()
    for run in CJK_RUN_PATTERN.findall(text):
        if len(run) <= 3:
            terms.add(run)

        for size in (2, 3):
            if len(run) < size:
                continue
            for index in range(len(run) - size + 1):
                terms.add(run[index : index + size])

    return terms


def extract_entity_terms(text: str) -> list[str]:
    lowered = text.casefold()
    terms = set(ASCII_TOKEN_PATTERN.findall(lowered)) | _extract_cjk_terms(text)
    return sorted(term for term in terms if term)


@dataclass(slots=True, frozen=True)
class KGEdge:
    edge_id: str
    subject: str
    predicate: str
    object: str
    valid_from: datetime
    valid_to: datetime | None
    memory_id: str | None
    weight: float
    metadata: dict[str, object]


@dataclass(slots=True, frozen=True)
class KGSearchResult:
    edge_id: str
    seed_entity: str
    current_entity: str
    subject: str
    predicate: str
    object: str
    depth: int
    path: str
    valid_from: datetime
    valid_to: datetime | None
    memory_id: str | None
    weight: float
    metadata: dict[str, object]


class TemporalKnowledgeGraph:
    def __init__(self, db_path: str | None = None) -> None:
        resolved_db_path = _resolve_db_path(db_path)
        if resolved_db_path != ":memory:":
            Path(resolved_db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(
            resolved_db_path,
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._closed = False
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._ensure_schema()

    async def __aenter__(self) -> TemporalKnowledgeGraph:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        if self._closed:
            return

        with self._lock:
            self._conn.commit()
            self._conn.close()
            self._closed = True

    async def reset(self) -> None:
        await asyncio.to_thread(self._reset_sync)

    def _reset_sync(self) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute("DELETE FROM kg_edges")

    async def add_edge(
        self,
        subject: str,
        predicate: str,
        object: str,
        *,
        valid_from: datetime | str | None = None,
        valid_to: datetime | str | None = None,
        memory_id: str | None = None,
        weight: float = 1.0,
        metadata: dict[str, object] | None = None,
    ) -> str:
        return await asyncio.to_thread(
            self._add_edge_sync,
            subject,
            predicate,
            object,
            valid_from,
            valid_to,
            memory_id,
            weight,
            metadata,
        )

    def _add_edge_sync(
        self,
        subject: str,
        predicate: str,
        object: str,
        valid_from: datetime | str | None,
        valid_to: datetime | str | None,
        memory_id: str | None,
        weight: float,
        metadata: dict[str, object] | None,
    ) -> str:
        resolved_valid_from = _normalize_datetime(valid_from) or _utcnow()
        resolved_valid_to = _normalize_datetime(valid_to)
        if resolved_valid_to is not None and resolved_valid_to < resolved_valid_from:
            raise ValueError("valid_to must be greater than or equal to valid_from")

        edge_id = str(uuid4())
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO kg_edges (
                        edge_id,
                        subject,
                        predicate,
                        object,
                        valid_from,
                        valid_to,
                        memory_id,
                        weight,
                        metadata_json,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        edge_id,
                        subject,
                        predicate,
                        object,
                        resolved_valid_from.isoformat(),
                        _format_datetime(resolved_valid_to),
                        memory_id,
                        float(weight),
                        _serialize_metadata(metadata),
                        _utcnow().isoformat(),
                    ),
                )

        return edge_id

    async def search(
        self,
        query: str,
        *,
        max_hops: int = 2,
        limit: int = 10,
        as_of: datetime | str | None = None,
    ) -> list[KGSearchResult]:
        entities = extract_entity_terms(query)
        if not entities:
            return []

        return await self.subgraph_search(
            entities,
            max_hops=max_hops,
            limit=limit,
            as_of=as_of,
        )

    async def subgraph_search(
        self,
        entities: list[str] | tuple[str, ...],
        *,
        max_hops: int = 2,
        limit: int = 10,
        as_of: datetime | str | None = None,
    ) -> list[KGSearchResult]:
        return await asyncio.to_thread(
            self._subgraph_search_sync,
            list(entities),
            max_hops,
            limit,
            as_of,
        )

    def _subgraph_search_sync(
        self,
        entities: list[str],
        max_hops: int,
        limit: int,
        as_of: datetime | str | None,
    ) -> list[KGSearchResult]:
        if max_hops < 1:
            raise ValueError("max_hops must be at least 1")

        effective_limit = max(limit, 0)
        if effective_limit == 0:
            return []

        seeds = [entity.casefold() for entity in entities if entity]
        if not seeds:
            return []

        resolved_as_of = _normalize_datetime(as_of)
        temporal_condition = "1 = 1"
        temporal_params: list[object] = []
        if resolved_as_of is not None:
            temporal_condition = "e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?)"
            temporal_value = resolved_as_of.isoformat()
            temporal_params = [temporal_value, temporal_value]

        placeholders = ", ".join(["(?)"] * len(seeds))
        next_entity_expr = """
            CASE
                WHEN LOWER(e.subject) = LOWER(graph.current_entity) THEN e.object
                ELSE e.subject
            END
        """
        visited_expr = f"'|' || LOWER({next_entity_expr}) || '|'"
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
                    CASE
                        WHEN LOWER(e.subject) = seed.seed_entity THEN e.object
                        ELSE e.subject
                    END AS current_entity,
                    e.subject || ' -> ' || e.predicate || ' -> ' || e.object AS path,
                    '|' || LOWER(e.subject) || '|' || LOWER(e.object) || '|' AS visited
                FROM kg_edges e
                JOIN seed
                  ON LOWER(e.subject) = seed.seed_entity
                  OR LOWER(e.object) = seed.seed_entity
                WHERE {temporal_condition}

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
                    graph.path
                        || ' => '
                        || e.subject
                        || ' -> '
                        || e.predicate
                        || ' -> '
                        || e.object AS path,
                    graph.visited || LOWER({next_entity_expr}) || '|' AS visited
                FROM graph
                JOIN kg_edges e
                  ON LOWER(e.subject) = LOWER(graph.current_entity)
                  OR LOWER(e.object) = LOWER(graph.current_entity)
                WHERE graph.depth < ?
                  AND {temporal_condition}
                  AND instr(graph.visited, {visited_expr}) = 0
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

        params: list[object] = [*seeds, *temporal_params, max_hops, *temporal_params, query_limit]
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()

        seen: set[tuple[str, str]] = set()
        results: list[KGSearchResult] = []
        for row in rows:
            dedupe_key = (row["edge_id"], row["seed_entity"])
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            results.append(
                KGSearchResult(
                    edge_id=row["edge_id"],
                    seed_entity=row["seed_entity"],
                    current_entity=row["current_entity"],
                    subject=row["subject"],
                    predicate=row["predicate"],
                    object=row["object"],
                    depth=int(row["depth"]),
                    path=row["path"],
                    valid_from=_parse_datetime(row["valid_from"]) or _utcnow(),
                    valid_to=_parse_datetime(row["valid_to"]),
                    memory_id=row["memory_id"],
                    weight=float(row["weight"]),
                    metadata=_deserialize_metadata(row["metadata_json"]),
                )
            )
            if len(results) >= effective_limit:
                break

        return results

    def _ensure_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kg_edges (
                edge_id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                predicate TEXT NOT NULL,
                object TEXT NOT NULL,
                valid_from TEXT NOT NULL,
                valid_to TEXT,
                memory_id TEXT,
                weight REAL NOT NULL DEFAULT 1.0,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            )
            """
        )
        self._conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_kg_edges_subject_object
            ON kg_edges(subject, object)
            """
        )
        self._conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_kg_edges_validity
            ON kg_edges(valid_from, valid_to)
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_version (
                component TEXT PRIMARY KEY,
                version INTEGER NOT NULL
            )
            """
        )
        self._conn.execute(
            """
            INSERT INTO schema_version (component, version)
            VALUES (?, ?)
            ON CONFLICT(component) DO UPDATE SET version = excluded.version
            """,
            (KG_SCHEMA_COMPONENT, KG_SCHEMA_VERSION),
        )
        self._conn.commit()


__all__ = [
    "KGEdge",
    "KGSearchResult",
    "KG_SCHEMA_COMPONENT",
    "KG_SCHEMA_VERSION",
    "TemporalKnowledgeGraph",
    "extract_entity_terms",
]
