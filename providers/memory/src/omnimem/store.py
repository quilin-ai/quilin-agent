from __future__ import annotations

import asyncio
import os
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .store_filters import layer_filter, matches_filters
from .store_records import insert_memory
from .store_schema import FTS_SCHEMA_COMPONENT as _FTS_SCHEMA_COMPONENT
from .store_schema import FTS_SCHEMA_VERSION as _FTS_SCHEMA_VERSION
from .store_schema import (
    configure_connection,
    ensure_store_schema,
)
from .store_search import build_keywords as _search_build_keywords
from .store_search import candidate_rows, rebuild_fts_index, record_columns
from .store_serialization import deserialize_metadata as _deserialize_metadata
from .store_serialization import row_to_record as _row_to_record
from .store_serialization import validate_memory_tier as _validate_memory_tier
from .store_validation import validate_semantic_ingestion_contract
from .types import (
    MemoryItem,
    MemoryLayer,
    MemoryRecord,
    MemoryTier,
    validate_memory_layer,
)

FTS_SCHEMA_COMPONENT = _FTS_SCHEMA_COMPONENT
FTS_SCHEMA_VERSION = _FTS_SCHEMA_VERSION


@runtime_checkable
class MemoryStore(Protocol):
    async def add(self, memory: MemoryItem) -> str: ...

    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]: ...

    async def get(self, memory_id: str) -> MemoryItem | None: ...

    async def update(self, memory_id: str, content: str) -> None: ...

    async def delete(self, memory_id: str) -> None: ...

    async def list_by_layer(
        self,
        layer: MemoryLayer,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemoryItem]: ...

    async def count(self, filters: dict[str, Any] | None = None) -> int: ...

    async def clear_layer(self, layer: MemoryLayer) -> int: ...


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _build_keywords(content: str) -> str:
    return _search_build_keywords(content)


class OmniMemStore:
    def __init__(self, db_path: str | None = None) -> None:
        if db_path is None:
            if os.environ.get("QUILIN_ENV") == "test":
                db_path = ":memory:"
            else:
                db_path = os.environ.get(
                    "OMNIMEM_DB_PATH",
                    str(Path.home() / ".quilin" / "memory.db"),
                )

        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(
            db_path,
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._closed = False
        configure_connection(self._conn)
        ensure_store_schema(
            self._conn,
            build_keywords=_build_keywords,
            now=_utcnow,
            rebuild_fts_index=self._rebuild_fts_index,
        )

    async def __aenter__(self) -> OmniMemStore:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()

    async def reset(self) -> None:
        await asyncio.to_thread(self._reset_sync)

    def _reset_sync(self) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute("DELETE FROM memory_records")
                self._conn.execute("DELETE FROM memory_records_fts")

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        if self._closed:
            return

        with self._lock:
            self._conn.commit()
            self._conn.close()
            self._closed = True

    async def add(self, memory: MemoryItem) -> str:
        return await asyncio.to_thread(self._add_sync, memory)

    def _add_sync(self, memory: MemoryItem) -> str:
        validate_semantic_ingestion_contract(
            layer=memory.layer,
            content_type=memory.content_type,
            metadata=dict(memory.metadata),
            content=memory.content,
        )
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                insert_memory(self._conn, memory, build_keywords=_build_keywords)

        return memory.id

    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        return await asyncio.to_thread(self._search_sync, query, limit, filters)

    def _search_sync(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        effective_limit = max(limit, 0)
        with self._lock:
            rows = candidate_rows(
                self._conn,
                query=query,
                layer_filter=layer_filter(filters),
            )
            items = [_row_to_record(row, now=_utcnow) for row in rows]
            filtered = [item for item in items if matches_filters(item, filters)]
            returned = filtered[:effective_limit]
            if returned:
                accessed_at = _utcnow()
                self._mark_accessed_locked([item.id for item in returned], accessed_at)
                return [self._with_access_signal(item, accessed_at) for item in returned]

        return filtered[:effective_limit]

    async def get(self, memory_id: str) -> MemoryItem | None:
        return await asyncio.to_thread(self._get_sync, memory_id)

    def _get_sync(self, memory_id: str) -> MemoryItem | None:
        with self._lock:
            row = self._conn.execute(
                f"""
                SELECT {record_columns()}
                FROM memory_records
                WHERE id = ? AND deleted = 0
                """,
                (memory_id,),
            ).fetchone()
            if row is None:
                return None

            record = _row_to_record(row, now=_utcnow)
            accessed_at = _utcnow()
            self._mark_accessed_locked([memory_id], accessed_at)
            return self._with_access_signal(record, accessed_at)

    async def update(self, memory_id: str, content: str) -> None:
        await asyncio.to_thread(self._update_sync, memory_id, content)

    def _update_sync(self, memory_id: str, content: str) -> None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT tier, content_type, metadata_json
                FROM memory_records
                WHERE id = ? AND deleted = 0
                """,
                (memory_id,),
            ).fetchone()
            if row is None:
                return

            validate_semantic_ingestion_contract(
                layer=validate_memory_layer(row["tier"]),
                content_type=row["content_type"],
                metadata=_deserialize_metadata(row["metadata_json"]),
                content=content,
            )
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute(
                    """
                    UPDATE memory_records
                    SET content = ?, embedding_json = NULL
                    WHERE id = ? AND deleted = 0
                    """,
                    (content, memory_id),
                )
                self._conn.execute(
                    """
                    UPDATE memory_records_fts
                    SET content = ?, keywords = ?
                    WHERE id = ?
                    """,
                    (content, _build_keywords(content), memory_id),
                )

    async def delete(self, memory_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, memory_id)

    def _delete_sync(self, memory_id: str) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute(
                    """
                    UPDATE memory_records
                    SET deleted = 1
                    WHERE id = ? AND deleted = 0
                    """,
                    (memory_id,),
                )
                self._conn.execute(
                    "DELETE FROM memory_records_fts WHERE id = ?",
                    (memory_id,),
                )

    async def list_by_layer(
        self,
        layer: MemoryLayer,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemoryItem]:
        return await asyncio.to_thread(self._list_by_layer_sync, layer, limit, offset)

    def _list_by_layer_sync(
        self,
        layer: MemoryLayer,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemoryItem]:
        resolved_layer = validate_memory_layer(layer)
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT {record_columns()}
                FROM memory_records
                WHERE tier = ? AND deleted = 0
                ORDER BY rowid ASC
                LIMIT ? OFFSET ?
                """,
                (resolved_layer, max(limit, 0), max(offset, 0)),
            ).fetchall()

        return [_row_to_record(row, now=_utcnow) for row in rows]

    async def count(self, filters: dict[str, Any] | None = None) -> int:
        return await asyncio.to_thread(self._count_sync, filters)

    def _count_sync(self, filters: dict[str, Any] | None = None) -> int:
        resolved_layer_filter = layer_filter(filters)
        if filters and any(
            key in filters
            for key in ("metadata", "content_type", "created_after", "created_before")
        ):
            items = self._search_sync("", limit=1_000_000, filters=filters)
            return len(items)

        with self._lock:
            if resolved_layer_filter is None:
                row = self._conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM memory_records
                    WHERE deleted = 0
                    """
                ).fetchone()
            else:
                row = self._conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM memory_records
                    WHERE deleted = 0 AND tier = ?
                    """,
                    (resolved_layer_filter,),
                ).fetchone()

        return int(row[0]) if row is not None else 0

    async def clear_layer(self, layer: MemoryLayer) -> int:
        return await asyncio.to_thread(self._clear_layer_sync, layer)

    def _clear_layer_sync(self, layer: MemoryLayer) -> int:
        resolved_layer = validate_memory_layer(layer)
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                cursor = self._conn.execute(
                    """
                    UPDATE memory_records
                    SET deleted = 1
                    WHERE tier = ? AND deleted = 0
                    """,
                    (resolved_layer,),
                )
                self._conn.execute(
                    """
                    DELETE FROM memory_records_fts
                    WHERE id IN (
                        SELECT id
                        FROM memory_records
                        WHERE tier = ? AND deleted = 1
                    )
                    """,
                    (resolved_layer,),
                )

        return int(cursor.rowcount or 0)

    async def recall(self, query: str) -> list[MemoryRecord]:
        return await asyncio.to_thread(self._recall_sync, query)

    def _recall_sync(self, query: str) -> list[MemoryRecord]:
        with self._lock:
            rows = candidate_rows(self._conn, query=query, layer_filter=None)

        return [_row_to_record(row, now=_utcnow) for row in rows]

    async def store(
        self,
        content: str,
        tier: MemoryTier = "working",
        *,
        layer: MemoryLayer | None = None,
        metadata: dict[str, object] | None = None,
        content_type: str = "text",
        embedding: list[float] | None = None,
        importance_score: float = 0.5,
    ) -> MemoryRecord:
        return await asyncio.to_thread(
            self._store_sync,
            content,
            tier,
            layer,
            metadata,
            content_type,
            embedding,
            importance_score,
        )

    def _store_sync(
        self,
        content: str,
        tier: MemoryTier = "working",
        layer: MemoryLayer | None = None,
        metadata: dict[str, object] | None = None,
        content_type: str = "text",
        embedding: list[float] | None = None,
        importance_score: float = 0.5,
    ) -> MemoryRecord:
        resolved_layer = (
            validate_memory_layer(layer) if layer is not None else _validate_memory_tier(tier)
        )
        resolved_metadata = dict(metadata or {})
        validate_semantic_ingestion_contract(
            layer=resolved_layer,
            content_type=content_type,
            metadata=resolved_metadata,
            content=content,
        )
        record = MemoryRecord(
            content=content,
            content_type=content_type,
            layer=resolved_layer,
            metadata=resolved_metadata,
            embedding=embedding,
            importance_score=importance_score,
        )
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                insert_memory(self._conn, record, build_keywords=_build_keywords)

        return record

    def _rebuild_fts_index(self) -> None:
        rebuild_fts_index(self._conn, build_keywords_func=_build_keywords)

    def _mark_accessed_locked(self, memory_ids: list[str], accessed_at: datetime) -> None:
        if not memory_ids:
            return

        self._conn.execute("BEGIN IMMEDIATE")
        with self._conn:
            self._conn.executemany(
                """
                UPDATE memory_records
                SET last_accessed = ?, access_count = access_count + 1
                WHERE id = ? AND deleted = 0
                """,
                [(accessed_at.isoformat(), memory_id) for memory_id in memory_ids],
            )

    @staticmethod
    def _with_access_signal(record: MemoryItem, accessed_at: datetime) -> MemoryItem:
        return MemoryItem(
            id=record.id,
            content=record.content,
            content_type=record.content_type,
            layer=record.layer,
            metadata=dict(record.metadata),
            embedding=record.embedding,
            created_at=record.created_at,
            last_accessed=accessed_at,
            access_count=record.access_count + 1,
            importance_score=record.importance_score,
        )
