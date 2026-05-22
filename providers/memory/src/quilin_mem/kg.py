from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .kg_query import subgraph_search_sync
from .kg_validation import (
    KG_BUSY_TIMEOUT_MS,
    KG_SCHEMA_COMPONENT,
    KG_SCHEMA_VERSION,
    KGEdge,
    KGSearchResult,
    ensure_schema,
    extract_entity_terms,
    format_datetime,
    get_schema_version,
    normalize_datetime,
    resolve_db_path,
    serialize_metadata,
    utcnow,
)


class TemporalKnowledgeGraph:
    def __init__(self, db_path: str | None = None) -> None:
        resolved_db_path = resolve_db_path(db_path)
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
        self._conn.execute(f"PRAGMA busy_timeout={KG_BUSY_TIMEOUT_MS}")
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
        resolved_valid_from = normalize_datetime(valid_from) or utcnow()
        resolved_valid_to = normalize_datetime(valid_to)
        if resolved_valid_to is not None and resolved_valid_to < resolved_valid_from:
            raise ValueError("valid_to must be greater than or equal to valid_from")

        edge_id = str(uuid4())
        self._last_add_edge_was_dedupe = False  # D.19 marker for backfill caller
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                # D.18 fix: dedupe same triple per memory_id.
                # Without this, repeated KG backfill from the same memory
                # record (LLM re-extracts same entities) caused unbounded
                # growth of identical (subject, predicate, object, memory_id)
                # rows. Real dogfood saw e.g. "孟孟 --[performed]--> QA test"
                # × 2 after running backfill twice on same record. KG was
                # never meant to store duplicate triples — collapse them.
                existing = self._conn.execute(
                    """
                    SELECT edge_id FROM kg_edges
                    WHERE subject = ?
                      AND predicate = ?
                      AND object = ?
                      AND COALESCE(memory_id, '') = COALESCE(?, '')
                      AND (valid_to IS NULL OR valid_to >= ?)
                    LIMIT 1
                    """,
                    (
                        subject,
                        predicate,
                        object,
                        memory_id,
                        resolved_valid_from.isoformat(),
                    ),
                ).fetchone()
                if existing is not None:
                    # D.19: mark that this call did not insert a new edge so
                    # backfill_kg_from_memory can avoid double-counting
                    # `edges_added` (real dogfood saw API report 8 added
                    # when DB delta was 0 — dedupe was absorbing them).
                    self._last_add_edge_was_dedupe = True
                    return existing[0]
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
                        format_datetime(resolved_valid_to),
                        memory_id,
                        float(weight),
                        serialize_metadata(metadata),
                        utcnow().isoformat(),
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
        filters: dict[str, Any] | None = None,
    ) -> list[KGSearchResult]:
        entities = extract_entity_terms(query)
        if not entities:
            return []

        return await self.subgraph_search(
            entities,
            max_hops=max_hops,
            limit=limit,
            as_of=as_of,
            filters=filters,
        )

    async def subgraph_search(
        self,
        entities: list[str] | tuple[str, ...],
        *,
        max_hops: int = 2,
        limit: int = 10,
        as_of: datetime | str | None = None,
        filters: dict[str, Any] | None = None,
    ) -> list[KGSearchResult]:
        return await asyncio.to_thread(
            self._subgraph_search_sync,
            list(entities),
            max_hops,
            limit,
            as_of,
            filters,
        )

    def _subgraph_search_sync(
        self,
        entities: list[str],
        max_hops: int,
        limit: int,
        as_of: datetime | str | None,
        filters: dict[str, Any] | None,
    ) -> list[KGSearchResult]:
        return subgraph_search_sync(
            self._conn,
            self._lock,
            entities,
            max_hops,
            limit,
            as_of,
            filters=filters,
        )

    async def dump_edges(
        self,
        *,
        limit: int = 500,
        as_of: datetime | str | None = None,
    ) -> list[dict[str, Any]]:
        """Bulk-read KG edges for viz / inspection (UX-4 Slice 3 backend).

        Returns up to `limit` edges as plain dicts, newest first by
        `created_at`. When `as_of` is provided, only edges whose
        `[valid_from, valid_to]` window contains that moment are returned.

        UX-4 Slice 3 后端:批量读 KG edges 给 /api/memory/graph 用。
        默认按 created_at 倒序取 limit 条;传 as_of 只返时序上该时刻有效的边。
        """
        return await asyncio.to_thread(self._dump_edges_sync, limit, as_of)

    def _dump_edges_sync(
        self,
        limit: int,
        as_of: datetime | str | None,
    ) -> list[dict[str, Any]]:
        effective_limit = max(1, min(int(limit), 2000))
        resolved_as_of = normalize_datetime(as_of)
        params: list[Any] = []
        where_clauses: list[str] = []
        if resolved_as_of is not None:
            where_clauses.append("valid_from <= ?")
            params.append(resolved_as_of.isoformat())
            where_clauses.append("(valid_to IS NULL OR valid_to >= ?)")
            params.append(resolved_as_of.isoformat())
        where = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
        params.append(effective_limit)
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT edge_id, subject, predicate, object,
                       valid_from, valid_to, memory_id, weight,
                       metadata_json, created_at
                FROM kg_edges
                {where}
                ORDER BY created_at DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [
            {
                "edge_id": row["edge_id"],
                "subject": row["subject"],
                "predicate": row["predicate"],
                "object": row["object"],
                "valid_from": row["valid_from"],
                "valid_to": row["valid_to"],
                "memory_id": row["memory_id"],
                "weight": float(row["weight"]),
                "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else None,
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def _ensure_schema(self) -> None:
        ensure_schema(self._conn)

    def _get_schema_version(self, component: str) -> int:
        return get_schema_version(self._conn, component)


__all__ = [
    "KGEdge",
    "KG_BUSY_TIMEOUT_MS",
    "KGSearchResult",
    "KG_SCHEMA_COMPONENT",
    "KG_SCHEMA_VERSION",
    "TemporalKnowledgeGraph",
    "extract_entity_terms",
]
