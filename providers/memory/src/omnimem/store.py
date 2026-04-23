from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .types import (
    MemoryItem,
    MemoryLayer,
    MemoryRecord,
    MemoryTier,
    VALID_MEMORY_TIERS,
    validate_memory_layer,
)

ASCII_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+")
CJK_RUN_PATTERN = re.compile(r"[\u4e00-\u9fff]+")

RECALL_QUERY_EXPANSIONS = (
    (
        ("记得", "记住", "回忆", "想起", "以前", "之前"),
        {"记得", "记忆", "名字", "称呼", "身份", "用户"},
    ),
    (
        ("叫什么", "名字", "称呼", "我是谁", "是谁", "叫我"),
        {"名字", "称呼", "身份", "用户"},
    ),
)
FTS_SCHEMA_COMPONENT = "memory_records_fts"
FTS_SCHEMA_VERSION = 1
DEFAULT_MEMORY_METADATA = json.dumps({"schema_version": 1}, sort_keys=True)


@runtime_checkable
class MemoryStore(Protocol):
    async def add(self, memory: MemoryItem) -> str:
        ...

    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        ...

    async def get(self, memory_id: str) -> MemoryItem | None:
        ...

    async def update(self, memory_id: str, content: str) -> None:
        ...

    async def delete(self, memory_id: str) -> None:
        ...

    async def list_by_layer(
        self,
        layer: MemoryLayer,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemoryItem]:
        ...

    async def count(self, filters: dict[str, Any] | None = None) -> int:
        ...

    async def clear_layer(self, layer: MemoryLayer) -> int:
        ...


def _utcnow() -> datetime:
    return datetime.now(UTC)


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


def _extract_search_terms(text: str) -> set[str]:
    lowered = text.lower()
    return set(ASCII_TOKEN_PATTERN.findall(lowered)) | _extract_cjk_terms(text)


def _expand_query_terms(query: str) -> set[str]:
    terms = _extract_search_terms(query)
    for triggers, expansions in RECALL_QUERY_EXPANSIONS:
        if any(trigger in query for trigger in triggers):
            terms.update(expansions)

    return terms


def _build_keywords(content: str) -> str:
    return " ".join(sorted(_extract_search_terms(content)))


def _build_match_query(query: str) -> str | None:
    terms = sorted(term for term in _expand_query_terms(query) if term)
    if not terms:
        return None

    escaped_terms = []
    for term in terms:
        escaped = term.replace('"', '""')
        escaped_terms.append(f'"{escaped}"')

    return " OR ".join(escaped_terms)


def _validate_memory_tier(tier: str) -> MemoryTier:
    if tier not in VALID_MEMORY_TIERS:
        valid_tiers = ", ".join(VALID_MEMORY_TIERS)
        raise ValueError(f"Invalid memory tier: {tier}. Expected one of: {valid_tiers}")

    return tier


def _serialize_metadata(metadata: dict[str, object]) -> str:
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True)


def _deserialize_metadata(metadata_json: str | None) -> dict[str, object]:
    if not metadata_json:
        return json.loads(DEFAULT_MEMORY_METADATA)

    loaded = json.loads(metadata_json)
    if not isinstance(loaded, dict):
        return json.loads(DEFAULT_MEMORY_METADATA)

    if "schema_version" not in loaded:
        loaded["schema_version"] = 1

    return dict(loaded)


def _serialize_embedding(embedding: list[float] | None) -> str | None:
    if embedding is None:
        return None

    return json.dumps(embedding)


def _deserialize_embedding(embedding_json: str | None) -> list[float] | None:
    if not embedding_json:
        return None

    loaded = json.loads(embedding_json)
    if not isinstance(loaded, list):
        return None

    return [float(value) for value in loaded]


def _parse_datetime(raw_value: str | None) -> datetime:
    if not raw_value:
        return _utcnow()

    return datetime.fromisoformat(raw_value)


def _row_to_record(row: sqlite3.Row) -> MemoryRecord:
    return MemoryRecord(
        id=row["id"],
        content=row["content"],
        content_type=row["content_type"],
        layer=_validate_memory_tier(row["tier"]),
        metadata=_deserialize_metadata(row["metadata_json"]),
        embedding=_deserialize_embedding(row["embedding_json"]),
        created_at=_parse_datetime(row["created_at"]),
        last_accessed=_parse_datetime(row["last_accessed"]),
        access_count=int(row["access_count"]),
        importance_score=float(row["importance_score"]),
    )


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
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._ensure_store_schema()

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
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._insert_memory_locked(memory)

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
            rows = self._candidate_rows(query, filters)
            items = [_row_to_record(row) for row in rows]
            filtered = [item for item in items if self._matches_filters(item, filters)]

        return filtered[:effective_limit]

    async def get(self, memory_id: str) -> MemoryItem | None:
        return await asyncio.to_thread(self._get_sync, memory_id)

    def _get_sync(self, memory_id: str) -> MemoryItem | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT
                    id,
                    content,
                    tier,
                    content_type,
                    metadata_json,
                    embedding_json,
                    created_at,
                    last_accessed,
                    access_count,
                    importance_score
                FROM memory_records
                WHERE id = ? AND deleted = 0
                """,
                (memory_id,),
            ).fetchone()

        return None if row is None else _row_to_record(row)

    async def update(self, memory_id: str, content: str) -> None:
        await asyncio.to_thread(self._update_sync, memory_id, content)

    def _update_sync(self, memory_id: str, content: str) -> None:
        with self._lock:
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
                """
                SELECT
                    id,
                    content,
                    tier,
                    content_type,
                    metadata_json,
                    embedding_json,
                    created_at,
                    last_accessed,
                    access_count,
                    importance_score
                FROM memory_records
                WHERE tier = ? AND deleted = 0
                ORDER BY rowid ASC
                LIMIT ? OFFSET ?
                """,
                (resolved_layer, max(limit, 0), max(offset, 0)),
            ).fetchall()

        return [_row_to_record(row) for row in rows]

    async def count(self, filters: dict[str, Any] | None = None) -> int:
        return await asyncio.to_thread(self._count_sync, filters)

    def _count_sync(self, filters: dict[str, Any] | None = None) -> int:
        layer_filter = self._layer_filter(filters)
        if filters and any(key in filters for key in ("metadata", "content_type")):
            items = self._search_sync("", limit=1_000_000, filters=filters)
            return len(items)

        with self._lock:
            if layer_filter is None:
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
                    (layer_filter,),
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
            rows = self._candidate_rows(query, None)

        return [_row_to_record(row) for row in rows]

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
            validate_memory_layer(layer)
            if layer is not None
            else _validate_memory_tier(tier)
        )
        record = MemoryRecord(
            content=content,
            content_type=content_type,
            layer=resolved_layer,
            metadata=metadata,
            embedding=embedding,
            importance_score=importance_score,
        )
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._insert_memory_locked(record)

        return record

    def _insert_memory_locked(self, memory: MemoryItem) -> None:
        metadata_json = _serialize_metadata(dict(memory.metadata))
        embedding_json = _serialize_embedding(memory.embedding)
        created_at = memory.created_at.isoformat()
        last_accessed = memory.last_accessed.isoformat()
        self._conn.execute(
            """
            INSERT INTO memory_records (
                id,
                content,
                tier,
                content_type,
                metadata_json,
                embedding_json,
                created_at,
                last_accessed,
                access_count,
                importance_score,
                deleted
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                memory.id,
                memory.content,
                memory.layer,
                memory.content_type,
                metadata_json,
                embedding_json,
                created_at,
                last_accessed,
                memory.access_count,
                memory.importance_score,
            ),
        )
        self._conn.execute(
            """
            INSERT INTO memory_records_fts (id, content, keywords)
            VALUES (?, ?, ?)
            """,
            (memory.id, memory.content, _build_keywords(memory.content)),
        )

    def _ensure_store_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_records (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tier TEXT NOT NULL CHECK (
                    tier IN ('working', 'episodic', 'semantic', 'skill')
                ),
                content_type TEXT NOT NULL DEFAULT 'text',
                metadata_json TEXT NOT NULL DEFAULT '{"schema_version":1}',
                embedding_json TEXT,
                created_at TEXT NOT NULL,
                last_accessed TEXT NOT NULL,
                access_count INTEGER NOT NULL DEFAULT 0,
                importance_score REAL NOT NULL DEFAULT 0.5,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
            )
            """
        )
        self._ensure_memory_record_columns()
        self._conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
                id UNINDEXED,
                content,
                keywords,
                tokenize = 'unicode61'
            )
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
        self._ensure_fts_schema()
        self._conn.commit()

    def _ensure_memory_record_columns(self) -> None:
        columns = {
            row["name"] for row in self._conn.execute("PRAGMA table_info(memory_records)")
        }
        additions = (
            (
                "content_type",
                "ALTER TABLE memory_records ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text'",
            ),
            (
                "metadata_json",
                """
                ALTER TABLE memory_records
                ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{"schema_version":1}'
                """,
            ),
            (
                "embedding_json",
                "ALTER TABLE memory_records ADD COLUMN embedding_json TEXT",
            ),
            (
                "created_at",
                "ALTER TABLE memory_records ADD COLUMN created_at TEXT",
            ),
            (
                "last_accessed",
                "ALTER TABLE memory_records ADD COLUMN last_accessed TEXT",
            ),
            (
                "access_count",
                "ALTER TABLE memory_records ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "importance_score",
                """
                ALTER TABLE memory_records
                ADD COLUMN importance_score REAL NOT NULL DEFAULT 0.5
                """,
            ),
            (
                "deleted",
                "ALTER TABLE memory_records ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            ),
        )
        for column_name, statement in additions:
            if column_name in columns:
                continue

            self._conn.execute(statement)

        timestamp = _utcnow().isoformat()
        self._conn.execute(
            """
            UPDATE memory_records
            SET content_type = 'text'
            WHERE content_type IS NULL OR content_type = ''
            """
        )
        self._conn.execute(
            """
            UPDATE memory_records
            SET metadata_json = ?
            WHERE metadata_json IS NULL OR trim(metadata_json) = ''
            """,
            (DEFAULT_MEMORY_METADATA,),
        )
        self._conn.execute(
            """
            UPDATE memory_records
            SET created_at = ?
            WHERE created_at IS NULL OR created_at = ''
            """,
            (timestamp,),
        )
        self._conn.execute(
            """
            UPDATE memory_records
            SET last_accessed = created_at
            WHERE last_accessed IS NULL OR last_accessed = ''
            """,
        )
        self._conn.execute(
            """
            UPDATE memory_records
            SET access_count = 0
            WHERE access_count IS NULL
            """
        )
        self._conn.execute(
            """
            UPDATE memory_records
            SET importance_score = 0.5
            WHERE importance_score IS NULL
            """
        )
        self._conn.execute(
            """
            UPDATE memory_records
            SET deleted = 0
            WHERE deleted IS NULL
            """
        )

    def _rebuild_fts_index(self) -> None:
        self._conn.execute("DELETE FROM memory_records_fts")
        self._conn.execute(
            """
            INSERT INTO memory_records_fts (id, content, keywords)
            SELECT id, content, ''
            FROM memory_records
            WHERE deleted = 0
            """
        )
        rows = self._conn.execute(
            """
            SELECT id, content
            FROM memory_records
            WHERE deleted = 0
            ORDER BY rowid ASC
            """
        ).fetchall()
        for row in rows:
            self._conn.execute(
                """
                UPDATE memory_records_fts
                SET keywords = ?
                WHERE id = ?
                """,
                (_build_keywords(row["content"]), row["id"]),
            )

    def _ensure_fts_schema(self) -> None:
        if self._get_schema_version(FTS_SCHEMA_COMPONENT) >= FTS_SCHEMA_VERSION:
            return

        self._rebuild_fts_index()
        self._conn.execute(
            """
            INSERT INTO schema_version (component, version)
            VALUES (?, ?)
            ON CONFLICT(component) DO UPDATE SET version = excluded.version
            """,
            (FTS_SCHEMA_COMPONENT, FTS_SCHEMA_VERSION),
        )

    def _get_schema_version(self, component: str) -> int:
        row = self._conn.execute(
            "SELECT version FROM schema_version WHERE component = ?",
            (component,),
        ).fetchone()
        if row is None:
            return 0

        return int(row["version"])

    def _candidate_rows(
        self,
        query: str,
        filters: dict[str, Any] | None,
    ) -> list[sqlite3.Row]:
        layer_filter = self._layer_filter(filters)
        if not query:
            if layer_filter is None:
                return self._conn.execute(
                    """
                    SELECT
                        id,
                        content,
                        tier,
                        content_type,
                        metadata_json,
                        embedding_json,
                        created_at,
                        last_accessed,
                        access_count,
                        importance_score
                    FROM memory_records
                    WHERE deleted = 0
                    ORDER BY rowid ASC
                    """
                ).fetchall()

            return self._conn.execute(
                """
                SELECT
                    id,
                    content,
                    tier,
                    content_type,
                    metadata_json,
                    embedding_json,
                    created_at,
                    last_accessed,
                    access_count,
                    importance_score
                FROM memory_records
                WHERE deleted = 0 AND tier = ?
                ORDER BY rowid ASC
                """,
                (layer_filter,),
            ).fetchall()

        rows = self._recall_with_fts(query, layer_filter)
        if rows:
            return rows

        like_query = f"%{query.lower()}%"
        if layer_filter is None:
            return self._conn.execute(
                """
                SELECT
                    id,
                    content,
                    tier,
                    content_type,
                    metadata_json,
                    embedding_json,
                    created_at,
                    last_accessed,
                    access_count,
                    importance_score
                FROM memory_records
                WHERE deleted = 0 AND lower(content) LIKE ?
                ORDER BY rowid ASC
                """,
                (like_query,),
            ).fetchall()

        return self._conn.execute(
            """
            SELECT
                id,
                content,
                tier,
                content_type,
                metadata_json,
                embedding_json,
                created_at,
                last_accessed,
                access_count,
                importance_score
            FROM memory_records
            WHERE deleted = 0 AND tier = ? AND lower(content) LIKE ?
            ORDER BY rowid ASC
            """,
            (layer_filter, like_query),
        ).fetchall()

    def _layer_filter(self, filters: dict[str, Any] | None) -> MemoryLayer | None:
        if not filters:
            return None

        raw_layer = filters.get("layer", filters.get("tier"))
        if raw_layer is None:
            return None

        return validate_memory_layer(str(raw_layer))

    def _matches_filters(
        self,
        item: MemoryItem,
        filters: dict[str, Any] | None,
    ) -> bool:
        if not filters:
            return True

        raw_layer = filters.get("layer", filters.get("tier"))
        if raw_layer is not None and item.layer != validate_memory_layer(str(raw_layer)):
            return False

        content_type = filters.get("content_type")
        if content_type is not None and item.content_type != content_type:
            return False

        metadata_filters = filters.get("metadata")
        if isinstance(metadata_filters, dict):
            for key, value in metadata_filters.items():
                if item.metadata.get(key) != value:
                    return False

        return True

    def _recall_with_fts(
        self,
        query: str,
        layer_filter: MemoryLayer | None,
    ) -> list[sqlite3.Row]:
        match_query = _build_match_query(query)
        if match_query is None:
            return []

        if layer_filter is None:
            return self._conn.execute(
                """
                SELECT
                    mr.id,
                    mr.content,
                    mr.tier,
                    mr.content_type,
                    mr.metadata_json,
                    mr.embedding_json,
                    mr.created_at,
                    mr.last_accessed,
                    mr.access_count,
                    mr.importance_score
                FROM memory_records_fts fts
                JOIN memory_records mr ON mr.id = fts.id
                WHERE memory_records_fts MATCH ? AND mr.deleted = 0
                ORDER BY bm25(memory_records_fts), mr.rowid ASC
                """,
                (match_query,),
            ).fetchall()

        return self._conn.execute(
            """
            SELECT
                mr.id,
                mr.content,
                mr.tier,
                mr.content_type,
                mr.metadata_json,
                mr.embedding_json,
                mr.created_at,
                mr.last_accessed,
                mr.access_count,
                mr.importance_score
            FROM memory_records_fts fts
            JOIN memory_records mr ON mr.id = fts.id
            WHERE memory_records_fts MATCH ?
              AND mr.deleted = 0
              AND mr.tier = ?
            ORDER BY bm25(memory_records_fts), mr.rowid ASC
            """,
            (match_query, layer_filter),
        ).fetchall()
