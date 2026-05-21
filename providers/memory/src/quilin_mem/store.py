from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .retrieval_profile import RetrievalProfileStore
from .store_filters import coerce_filter_datetime, layer_filter, matches_filters
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
from .store_serialization import serialize_metadata as _serialize_metadata
from .store_serialization import validate_memory_tier as _validate_memory_tier
from .store_validation import validate_semantic_ingestion_contract
from .store_versioning import (
    DestructiveImpactPreview,
    MemoryObservation,
    MemorySnapshot,
    MemorySource,
    MemoryVersionInfo,
    coerce_metadata,
    dumps_json,
    new_id,
    row_to_observation,
    row_to_snapshot,
    row_to_source,
    row_to_version_info,
    stable_hash,
    values_for_json,
)
from .types import (
    MemoryItem,
    MemoryLayer,
    MemoryRecord,
    MemoryTier,
    memory_item_with,
    validate_memory_layer,
)

FTS_SCHEMA_COMPONENT = _FTS_SCHEMA_COMPONENT
FTS_SCHEMA_VERSION = _FTS_SCHEMA_VERSION
HISTORY_SNAPSHOT_LABEL_PREFIX = "__history__:"
DEFAULT_RECOVERY_WINDOW = timedelta(days=7)
DEFAULT_CONFLICT_WINDOW = timedelta(seconds=30)


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

    async def update(
        self,
        memory_id: str,
        content: str,
        *,
        last_writer_client: str | None = None,
        last_writer_session_id: str | None = None,
        project_scope: str | None = None,
    ) -> None: ...

    async def delete(self, memory_id: str) -> None: ...

    async def preview_delete(self, memory_id: str) -> DestructiveImpactPreview: ...

    async def recover_memory(
        self,
        memory_id: str,
        *,
        recovery_window: timedelta = DEFAULT_RECOVERY_WINDOW,
    ) -> bool: ...

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


def _count_metadata_value(value: object) -> object:
    if isinstance(value, bool):
        return int(value)
    if value is None or isinstance(value, int | float | str):
        return value

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _metadata_json_path(key: str) -> str:
    escaped_key = key.replace("\\", "\\\\").replace('"', '\\"')
    return f'$."{escaped_key}"'


def _candidate_limit(limit: int, filters: dict[str, Any] | None) -> int | None:
    if not filters:
        return limit

    non_layer_filters = set(filters) - {"layer", "tier"}
    return None if non_layer_filters else limit


class QuilinMemStore:
    def __init__(
        self,
        db_path: str | None = None,
        *,
        retrieval_profile_store: RetrievalProfileStore | None = None,
    ) -> None:
        if db_path is None:
            if os.environ.get("QUILIN_ENV") == "test":
                db_path = ":memory:"
            else:
                db_path = os.environ.get(
                    "QUILIN_MEM_DB_PATH",
                    str(Path.home() / ".quilin" / "memory.db"),
                )

        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(
            db_path,
            check_same_thread=False,
            isolation_level=None,
        )
        self._db_path = db_path
        self._retrieval_profiles = retrieval_profile_store
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._closed = False
        configure_connection(self._conn)
        ensure_store_schema(
            self._conn,
            now=_utcnow,
            rebuild_fts_index=self._rebuild_fts_index,
        )

    @property
    def retrieval_profiles(self) -> RetrievalProfileStore:
        if self._retrieval_profiles is None:
            self._retrieval_profiles = RetrievalProfileStore(self._db_path)
        return self._retrieval_profiles

    async def __aenter__(self) -> QuilinMemStore:
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
                self._conn.execute("DELETE FROM memory_sources")
                self._conn.execute("DELETE FROM memory_observations")
                self._conn.execute("DELETE FROM memory_snapshot")

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        if self._closed:
            return

        with self._lock:
            self._conn.commit()
            self._conn.close()
            if self._retrieval_profiles is not None:
                self._retrieval_profiles.close()
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
            now = _utcnow()
            rows = candidate_rows(
                self._conn,
                query=query,
                layer_filter=layer_filter(filters),
                limit=_candidate_limit(limit, filters),
                active_at=now.isoformat(),
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
            active_at = _utcnow()
            row = self._conn.execute(
                f"""
                SELECT {record_columns()}
                FROM memory_records
                WHERE id = ?
                  AND deleted = 0
                  AND is_latest = 1
                  AND (forget_after IS NULL OR forget_after > ? OR recovered_at IS NOT NULL)
                """,
                (memory_id, active_at.isoformat()),
            ).fetchone()
            if row is None:
                return None

            record = _row_to_record(row, now=_utcnow)
            accessed_at = _utcnow()
            self._mark_accessed_locked([memory_id], accessed_at)
            return self._with_access_signal(record, accessed_at)

    async def update(
        self,
        memory_id: str,
        content: str,
        *,
        last_writer_client: str | None = None,
        last_writer_session_id: str | None = None,
        project_scope: str | None = None,
    ) -> None:
        await asyncio.to_thread(
            self._update_sync,
            memory_id,
            content,
            last_writer_client,
            last_writer_session_id,
            project_scope,
        )

    def _update_sync(
        self,
        memory_id: str,
        content: str,
        last_writer_client: str | None,
        last_writer_session_id: str | None,
        project_scope: str | None,
    ) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                row = self._conn.execute(
                    f"""
                    SELECT {record_columns()}
                    FROM memory_records
                    WHERE id = ? AND deleted = 0 AND is_latest = 1
                    """,
                    (memory_id,),
                ).fetchone()
                if row is None:
                    return

                now = _utcnow()
                metadata = _deserialize_metadata(row["metadata_json"])
                conflict = self._detect_conflict_locked(
                    row,
                    last_writer_client=last_writer_client,
                    project_scope=project_scope,
                    at=now,
                )
                if conflict:
                    metadata["conflict_resolution_pending"] = True
                    metadata["conflict_with_client"] = str(row["last_writer_client"])
                    if row["last_writer_session_id"]:
                        metadata["conflict_with_session_id"] = str(row["last_writer_session_id"])

                validate_semantic_ingestion_contract(
                    layer=validate_memory_layer(row["tier"]),
                    content_type=row["content_type"],
                    metadata=metadata,
                    content=content,
                )
                self._record_history_snapshot_locked(
                    memory_id=memory_id,
                    record=_row_to_record(row, now=_utcnow),
                    label_kind="update",
                    snapshot_at=now,
                )
                self._conn.execute(
                    """
                    UPDATE memory_records
                    SET content = ?,
                        embedding_json = NULL,
                        metadata_json = ?,
                        last_accessed = ?,
                        last_written_at = ?,
                        last_writer_client = COALESCE(?, last_writer_client),
                        last_writer_session_id = COALESCE(?, last_writer_session_id),
                        project_scope = COALESCE(?, project_scope)
                    WHERE id = ? AND deleted = 0 AND is_latest = 1
                    """,
                    (
                        content,
                        _serialize_metadata(metadata),
                        now.isoformat(),
                        now.isoformat(),
                        last_writer_client,
                        last_writer_session_id,
                        project_scope,
                        memory_id,
                    ),
                )
                self._conn.execute(
                    """
                    UPDATE memory_records_fts
                    SET content = ?, keywords = ?
                    WHERE id = ?
                    """,
                    (content, _build_keywords(content), memory_id),
                )

    def _detect_conflict_locked(
        self,
        row: sqlite3.Row,
        *,
        last_writer_client: str | None,
        project_scope: str | None,
        at: datetime,
        window: timedelta = DEFAULT_CONFLICT_WINDOW,
    ) -> bool:
        if not last_writer_client or not row["last_writer_client"]:
            return False
        if str(row["last_writer_client"]) == last_writer_client:
            return False
        if not self._same_conflict_project_scope(row["project_scope"], project_scope):
            return False
        try:
            last_written_at = (
                row["last_written_at"] if "last_written_at" in tuple(row.keys()) else None
            )
            last_write_at = datetime.fromisoformat(str(last_written_at or row["last_accessed"]))
        except ValueError:
            return False
        return at - last_write_at <= window

    def _same_conflict_project_scope(
        self,
        existing_project_scope: object,
        incoming_project_scope: str | None,
    ) -> bool:
        if incoming_project_scope is None:
            return True
        if existing_project_scope is None:
            return False
        return str(existing_project_scope) == incoming_project_scope

    async def delete(self, memory_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, memory_id)

    def _delete_sync(self, memory_id: str) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                row = self._conn.execute(
                    f"""
                    SELECT {record_columns()}
                    FROM memory_records
                    WHERE id = ? AND deleted = 0 AND is_latest = 1
                    """,
                    (memory_id,),
                ).fetchone()
                if row is None:
                    return

                deleted_at = _utcnow()
                # dogfood 2026-05-21 发现的 bug:`forget_after` 之前写成
                # `deleted_at.isoformat()` 等于 `archived_at`,GC 用
                # `forget_after < now` 会立即清理。正确语义:`forget_after`
                # = 软删除窗口结束时间(deleted_at + DEFAULT_RECOVERY_WINDOW)。
                forget_after = deleted_at + DEFAULT_RECOVERY_WINDOW
                self._record_history_snapshot_locked(
                    memory_id=memory_id,
                    record=_row_to_record(row, now=_utcnow),
                    label_kind="delete",
                    snapshot_at=deleted_at,
                )
                self._conn.execute(
                    """
                    UPDATE memory_records
                    SET deleted = 1, archived_at = ?, forget_after = ?, recovered_at = NULL
                    WHERE id = ? AND deleted = 0 AND is_latest = 1
                    """,
                    (deleted_at.isoformat(), forget_after.isoformat(), memory_id),
                )
                self._conn.execute(
                    "DELETE FROM memory_records_fts WHERE id = ?",
                    (memory_id,),
                )

    async def preview_delete(self, memory_id: str) -> DestructiveImpactPreview:
        return await asyncio.to_thread(self._preview_delete_sync, memory_id)

    def _preview_delete_sync(self, memory_id: str) -> DestructiveImpactPreview:
        with self._lock:
            now = _utcnow()
            row = self._conn.execute(
                """
                SELECT id, deleted, is_latest, forget_after, archived_at, recovered_at
                FROM memory_records
                WHERE id = ?
                """,
                (memory_id,),
            ).fetchone()

        if row is None:
            return DestructiveImpactPreview(
                memory_id=memory_id,
                exists=False,
                currently_visible=False,
                would_archive=False,
                affected_records=0,
                recoverable=False,
                recommended_action="no_record",
            )

        forget_after = (
            datetime.fromisoformat(str(row["forget_after"])) if row["forget_after"] else None
        )
        archived_at = (
            datetime.fromisoformat(str(row["archived_at"])) if row["archived_at"] else None
        )
        recovered_at = (
            datetime.fromisoformat(str(row["recovered_at"])) if row["recovered_at"] else None
        )
        currently_visible = (
            int(row["deleted"]) == 0
            and int(row["is_latest"]) == 1
            and (forget_after is None or forget_after > now or recovered_at is not None)
        )
        recoverable = (
            currently_visible
            or int(row["deleted"]) == 1
            and int(row["is_latest"]) == 1
            and archived_at is not None
            and archived_at + DEFAULT_RECOVERY_WINDOW >= now
        )
        return DestructiveImpactPreview(
            memory_id=memory_id,
            exists=True,
            currently_visible=currently_visible,
            would_archive=currently_visible,
            affected_records=1 if currently_visible else 0,
            recoverable=recoverable,
            recommended_action=(
                "archive_then_recover_if_needed" if currently_visible else "no_current_record"
            ),
            archived_at=archived_at,
        )

    async def recover_memory(
        self,
        memory_id: str,
        *,
        recovery_window: timedelta = DEFAULT_RECOVERY_WINDOW,
    ) -> bool:
        return await asyncio.to_thread(
            self._recover_memory_sync,
            memory_id,
            recovery_window,
        )

    def _recover_memory_sync(self, memory_id: str, recovery_window: timedelta) -> bool:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                row = self._conn.execute(
                    f"""
                    SELECT {record_columns()}, deleted, is_latest, archived_at
                    FROM memory_records
                    WHERE id = ?
                    """,
                    (memory_id,),
                ).fetchone()
                if row is None or int(row["deleted"]) == 0:
                    return False
                if int(row["is_latest"]) != 1:
                    return False
                if not row["archived_at"]:
                    return False

                archived_at = datetime.fromisoformat(str(row["archived_at"]))
                if archived_at + recovery_window < _utcnow():
                    raise ValueError(f"recovery window expired for memory record: {memory_id}")

                recovered_at = _utcnow()
                self._record_history_snapshot_locked(
                    memory_id=memory_id,
                    record=_row_to_record(row, now=_utcnow),
                    label_kind="recover",
                    snapshot_at=recovered_at,
                )
                self._conn.execute(
                    """
                    UPDATE memory_records
                    SET deleted = 0, recovered_at = ?
                    WHERE id = ? AND deleted = 1 AND is_latest = 1
                    """,
                    (recovered_at.isoformat(), memory_id),
                )
                self._conn.execute(
                    """
                    INSERT OR REPLACE INTO memory_records_fts (id, content, keywords)
                    VALUES (?, ?, ?)
                    """,
                    (memory_id, row["content"], _build_keywords(row["content"])),
                )
                return True

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
            now = _utcnow()
            rows = self._conn.execute(
                f"""
                SELECT {record_columns()}
                FROM memory_records
                WHERE tier = ?
                  AND deleted = 0
                  AND is_latest = 1
                  AND (forget_after IS NULL OR forget_after > ? OR recovered_at IS NOT NULL)
                ORDER BY rowid ASC
                LIMIT ? OFFSET ?
                """,
                (resolved_layer, now.isoformat(), max(limit, 0), max(offset, 0)),
            ).fetchall()

        return [_row_to_record(row, now=_utcnow) for row in rows]

    async def count(self, filters: dict[str, Any] | None = None) -> int:
        return await asyncio.to_thread(self._count_sync, filters)

    def _count_sync(self, filters: dict[str, Any] | None = None) -> int:
        now = _utcnow()
        predicates = [
            "deleted = 0",
            "is_latest = 1",
            "(forget_after IS NULL OR forget_after > ? OR recovered_at IS NOT NULL)",
        ]
        params: list[object] = [now.isoformat()]
        if filters:
            resolved_layer_filter = layer_filter(filters)
            if resolved_layer_filter is not None:
                predicates.append("tier = ?")
                params.append(resolved_layer_filter)

            content_type = filters.get("content_type")
            if content_type is not None:
                predicates.append("content_type = ?")
                params.append(str(content_type))

            if "project_scope" in filters:
                project_scope = filters["project_scope"]
                if project_scope is None:
                    predicates.append("project_scope IS NULL")
                else:
                    predicates.append("(project_scope = ? OR project_scope IS NULL)")
                    params.append(str(project_scope))

            writer_client = filters.get("last_writer_client", filters.get("writer_client"))
            if writer_client is not None:
                predicates.append("last_writer_client = ?")
                params.append(str(writer_client))

            writer_session_id = filters.get(
                "last_writer_session_id",
                filters.get("writer_session_id"),
            )
            if writer_session_id is not None:
                predicates.append("last_writer_session_id = ?")
                params.append(str(writer_session_id))

            metadata_filters = filters.get("metadata")
            if isinstance(metadata_filters, dict):
                for key, value in sorted(metadata_filters.items()):
                    predicates.append("json_extract(metadata_json, ?) = ?")
                    params.extend(
                        (
                            _metadata_json_path(str(key)),
                            _count_metadata_value(value),
                        )
                    )

            created_after = coerce_filter_datetime(filters.get("created_after"))
            if created_after is not None:
                predicates.append("created_at >= ?")
                params.append(created_after.isoformat())

            created_before = coerce_filter_datetime(filters.get("created_before"))
            if created_before is not None:
                predicates.append("created_at <= ?")
                params.append(created_before.isoformat())

        with self._lock:
            row = self._conn.execute(
                f"""
                SELECT COUNT(*)
                FROM memory_records
                WHERE {" AND ".join(predicates)}
                """,
                params,
            ).fetchone()

        return int(row[0]) if row is not None else 0

    async def clear_layer(self, layer: MemoryLayer) -> int:
        return await asyncio.to_thread(self._clear_layer_sync, layer)

    def _clear_layer_sync(self, layer: MemoryLayer) -> int:
        resolved_layer = validate_memory_layer(layer)
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                clear_at = _utcnow()
                rows = self._conn.execute(
                    f"""
                    SELECT {record_columns()}
                    FROM memory_records
                    WHERE tier = ?
                      AND deleted = 0
                      AND is_latest = 1
                      AND (forget_after IS NULL OR forget_after > ? OR recovered_at IS NOT NULL)
                    """,
                    (resolved_layer, clear_at.isoformat()),
                ).fetchall()
                for row in rows:
                    memory_id = row["id"]
                    self._record_history_snapshot_locked(
                        memory_id=memory_id,
                        record=_row_to_record(row, now=_utcnow),
                        label_kind="clear",
                        snapshot_at=clear_at,
                    )
                # dogfood 2026-05-21 fix:forget_after = clear_at + recovery window
                # 不是 clear_at 自身(那会让 GC 立即清理)
                clear_forget_after = clear_at + DEFAULT_RECOVERY_WINDOW
                cursor = self._conn.execute(
                    """
                    UPDATE memory_records
                    SET deleted = 1, archived_at = ?, forget_after = ?, recovered_at = NULL
                    WHERE tier = ?
                      AND deleted = 0
                      AND is_latest = 1
                      AND (forget_after IS NULL OR forget_after > ? OR recovered_at IS NOT NULL)
                    """,
                    (
                        clear_at.isoformat(),
                        clear_forget_after.isoformat(),
                        resolved_layer,
                        clear_at.isoformat(),
                    ),
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

    async def recall(
        self,
        query: str,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryRecord]:
        return await asyncio.to_thread(self._recall_sync, query, filters)

    def _recall_sync(
        self,
        query: str,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryRecord]:
        with self._lock:
            rows = candidate_rows(
                self._conn,
                query=query,
                layer_filter=layer_filter(filters),
                active_at=_utcnow().isoformat(),
            )

        records = [_row_to_record(row, now=_utcnow) for row in rows]
        if filters:
            records = [record for record in records if matches_filters(record, filters)]
        return records

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
        last_writer_client: str | None = None,
        last_writer_session_id: str | None = None,
        project_scope: str | None = None,
        salience: dict[str, object] | None = None,
        kind: str | None = None,
        deadline_at: datetime | None = None,
        prospective_action: str | None = None,
        resource_pointer: dict[str, object] | None = None,
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
            last_writer_client,
            last_writer_session_id,
            project_scope,
            salience,
            kind,
            deadline_at,
            prospective_action,
            resource_pointer,
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
        last_writer_client: str | None = None,
        last_writer_session_id: str | None = None,
        project_scope: str | None = None,
        salience: dict[str, object] | None = None,
        kind: str | None = None,
        deadline_at: datetime | None = None,
        prospective_action: str | None = None,
        resource_pointer: dict[str, object] | None = None,
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
            last_writer_client=last_writer_client,
            last_writer_session_id=last_writer_session_id,
            project_scope=project_scope,
            salience=salience,
            kind=kind,
            deadline_at=deadline_at,
            prospective_action=prospective_action,
            resource_pointer=resource_pointer,
        )
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                insert_memory(self._conn, record, build_keywords=_build_keywords)

        return record

    async def record_observation(
        self,
        *,
        content: str,
        source_event_id: str | None = None,
        observed_at: datetime | None = None,
        actor_id: str | None = None,
        role: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> MemoryObservation:
        return await asyncio.to_thread(
            self._record_observation_sync,
            content,
            source_event_id,
            observed_at,
            actor_id,
            role,
            metadata,
        )

    def _record_observation_sync(
        self,
        content: str,
        source_event_id: str | None,
        observed_at: datetime | None,
        actor_id: str | None,
        role: str | None,
        metadata: dict[str, object] | None,
    ) -> MemoryObservation:
        observation_id = new_id()
        timestamp = observed_at or _utcnow()
        created_at = _utcnow()
        content_hash = stable_hash(content)
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO memory_observations (
                        id,
                        source_event_id,
                        content,
                        content_hash,
                        observed_at,
                        actor_id,
                        role,
                        metadata_json,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        observation_id,
                        source_event_id,
                        content,
                        content_hash,
                        timestamp.isoformat(),
                        actor_id,
                        role,
                        coerce_metadata(metadata),
                        created_at.isoformat(),
                    ),
                )
                row = self._conn.execute(
                    """
                    SELECT id, source_event_id, content, content_hash, observed_at,
                           actor_id, role, metadata_json
                    FROM memory_observations
                    WHERE id = ?
                    """,
                    (observation_id,),
                ).fetchone()

        return row_to_observation(row)

    async def link_memory_source(
        self,
        *,
        memory_id: str,
        observation_id: str,
        source_type: str = "observation",
        source_uri: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> MemorySource:
        return await asyncio.to_thread(
            self._link_memory_source_sync,
            memory_id,
            observation_id,
            source_type,
            source_uri,
            metadata,
        )

    def _link_memory_source_sync(
        self,
        memory_id: str,
        observation_id: str,
        source_type: str,
        source_uri: str | None,
        metadata: dict[str, object] | None,
    ) -> MemorySource:
        source_id = new_id()
        created_at = _utcnow()
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                memory_exists = self._conn.execute(
                    """
                    SELECT 1
                    FROM memory_records
                    WHERE id = ?
                    """,
                    (memory_id,),
                ).fetchone()
                if memory_exists is None:
                    raise KeyError(f"memory record not found: {memory_id}")

                observation_exists = self._conn.execute(
                    """
                    SELECT 1
                    FROM memory_observations
                    WHERE id = ?
                    """,
                    (observation_id,),
                ).fetchone()
                if observation_exists is None:
                    raise KeyError(f"memory observation not found: {observation_id}")

                self._conn.execute(
                    """
                    INSERT INTO memory_sources (
                        id,
                        memory_record_id,
                        observation_id,
                        source_type,
                        source_uri,
                        metadata_json,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        source_id,
                        memory_id,
                        observation_id,
                        source_type,
                        source_uri,
                        coerce_metadata(metadata),
                        created_at.isoformat(),
                    ),
                )
                row = self._conn.execute(
                    """
                    SELECT id, memory_record_id, observation_id, source_type,
                           source_uri, metadata_json, created_at
                    FROM memory_sources
                    WHERE id = ?
                    """,
                    (source_id,),
                ).fetchone()

        return row_to_source(row)

    async def get_memory_sources(self, memory_id: str) -> list[MemorySource]:
        return await asyncio.to_thread(self._get_memory_sources_sync, memory_id)

    def _get_memory_sources_sync(self, memory_id: str) -> list[MemorySource]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, memory_record_id, observation_id, source_type,
                       source_uri, metadata_json, created_at
                FROM memory_sources
                WHERE memory_record_id = ?
                ORDER BY rowid ASC
                """,
                (memory_id,),
            ).fetchall()

        return [row_to_source(row) for row in rows]

    async def supersede_memory(
        self,
        memory_id: str,
        replacement: MemoryItem,
        *,
        source_event_id: str | None = None,
        evidence_hash: str | None = None,
        forget_after: datetime | None = None,
        strength: float = 1.0,
    ) -> str:
        return await asyncio.to_thread(
            self._supersede_memory_sync,
            memory_id,
            replacement,
            source_event_id,
            evidence_hash,
            forget_after,
            strength,
        )

    def _supersede_memory_sync(
        self,
        memory_id: str,
        replacement: MemoryItem,
        source_event_id: str | None,
        evidence_hash: str | None,
        forget_after: datetime | None,
        strength: float,
    ) -> str:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                existing = self._conn.execute(
                    """
                    SELECT version, is_latest, created_at, forget_after, recovered_at,
                           project_scope
                    FROM memory_records
                    WHERE id = ? AND deleted = 0
                    """,
                    (memory_id,),
                ).fetchone()
                if existing is None:
                    raise KeyError(f"memory record not found: {memory_id}")
                if int(existing["is_latest"]) != 1:
                    raise ValueError(f"cannot supersede non-latest memory record: {memory_id}")
                existing_forget_after = (
                    datetime.fromisoformat(str(existing["forget_after"]))
                    if existing["forget_after"]
                    else None
                )
                if (
                    existing_forget_after is not None
                    and existing_forget_after <= _utcnow()
                    and not existing["recovered_at"]
                ):
                    raise ValueError(f"cannot supersede expired memory record: {memory_id}")
                parent_created_at = datetime.fromisoformat(str(existing["created_at"]))
                if replacement.created_at <= parent_created_at:
                    raise ValueError("replacement.created_at must be after parent created_at")
                if replacement.project_scope is None and existing["project_scope"] is not None:
                    replacement = memory_item_with(
                        replacement,
                        project_scope=str(existing["project_scope"]),
                    )

                validate_semantic_ingestion_contract(
                    layer=replacement.layer,
                    content_type=replacement.content_type,
                    metadata=dict(replacement.metadata),
                    content=replacement.content,
                )

                self._conn.execute(
                    """
                    UPDATE memory_records
                    SET is_latest = 0
                    WHERE id = ? AND deleted = 0
                    """,
                    (memory_id,),
                )
                insert_memory(
                    self._conn,
                    replacement,
                    build_keywords=_build_keywords,
                    version=int(existing["version"]) + 1,
                    parent_id=memory_id,
                    supersedes=[memory_id],
                    source_event_id=source_event_id,
                    evidence_hash=evidence_hash,
                    forget_after=forget_after,
                    strength=strength,
                )

        return replacement.id

    async def get_version_info(self, memory_id: str) -> MemoryVersionInfo:
        return await asyncio.to_thread(self._get_version_info_sync, memory_id)

    def _get_version_info_sync(self, memory_id: str) -> MemoryVersionInfo:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, version, parent_id, supersedes_json, is_latest,
                       source_event_id, evidence_hash, forget_after, strength
                FROM memory_records
                WHERE id = ?
                """,
                (memory_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"memory record not found: {memory_id}")

        return row_to_version_info(row)

    async def checkout_at(self, at: datetime) -> list[MemoryItem]:
        return await asyncio.to_thread(self._checkout_at_sync, at)

    def _checkout_at_sync(self, at: datetime) -> list[MemoryItem]:
        with self._lock:
            return self._checkout_at_locked(at)

    def _checkout_at_locked(self, at: datetime) -> list[MemoryItem]:
        rows = self._conn.execute(
            f"""
            SELECT {record_columns()}, version, parent_id, supersedes_json,
                   is_latest, source_event_id, evidence_hash, forget_after, strength,
                   archived_at, recovered_at, deleted
            FROM memory_records
            WHERE created_at <= ?
            ORDER BY rowid ASC
            """,
            (at.isoformat(),),
        ).fetchall()
        historical_records = self._history_records_after_locked(at)
        superseded_ids: set[str] = set()
        for row in rows:
            parent_id = row["parent_id"]
            if parent_id:
                superseded_ids.add(str(parent_id))
            superseded_ids.update(json.loads(row["supersedes_json"] or "[]"))

        records: list[MemoryItem] = []
        for row in rows:
            if row["id"] in superseded_ids:
                continue
            if self._is_archived_at_locked(str(row["id"]), at):
                continue

            forget_after = row_to_version_info(row).forget_after
            recovered_at = None
            if "recovered_at" in tuple(row.keys()) and row["recovered_at"]:
                recovered_at = datetime.fromisoformat(str(row["recovered_at"]))
            if (
                forget_after is not None
                and forget_after <= at
                and (recovered_at is None or recovered_at > at)
            ):
                continue
            if int(row["deleted"]) == 1 and forget_after is None:
                continue

            historical_record = historical_records.get(row["id"])
            records.append(historical_record or _row_to_record(row, now=_utcnow))

        return records

    def _is_archived_at_locked(self, memory_id: str, at: datetime) -> bool:
        rows = self._conn.execute(
            """
            SELECT label
            FROM memory_snapshot
            WHERE label IN (?, ?, ?)
              AND snapshot_at <= ?
            ORDER BY snapshot_at ASC, rowid ASC
            """,
            (
                f"{HISTORY_SNAPSHOT_LABEL_PREFIX}delete:{memory_id}",
                f"{HISTORY_SNAPSHOT_LABEL_PREFIX}clear:{memory_id}",
                f"{HISTORY_SNAPSHOT_LABEL_PREFIX}recover:{memory_id}",
                at.isoformat(),
            ),
        ).fetchall()
        archived = False
        for row in rows:
            label = str(row["label"])
            if label.startswith(f"{HISTORY_SNAPSHOT_LABEL_PREFIX}recover:"):
                archived = False
            else:
                archived = True

        return archived

    def _record_history_snapshot_locked(
        self,
        *,
        memory_id: str,
        record: MemoryItem,
        label_kind: str,
        snapshot_at: datetime,
    ) -> None:
        records_json = dumps_json([record.to_wire_dict()])
        self._conn.execute(
            """
            INSERT INTO memory_snapshot (
                id,
                label,
                snapshot_at,
                memory_ids_json,
                records_json,
                signature_hash,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                new_id(),
                f"{HISTORY_SNAPSHOT_LABEL_PREFIX}{label_kind}:{memory_id}",
                snapshot_at.isoformat(),
                values_for_json([memory_id]),
                records_json,
                stable_hash(records_json),
                snapshot_at.isoformat(),
            ),
        )

    def _history_records_after_locked(self, at: datetime) -> dict[str, MemoryItem]:
        rows = self._conn.execute(
            """
            SELECT records_json
            FROM memory_snapshot
            WHERE label LIKE ? AND snapshot_at > ?
            ORDER BY snapshot_at ASC, rowid ASC
            """,
            (f"{HISTORY_SNAPSHOT_LABEL_PREFIX}%", at.isoformat()),
        ).fetchall()
        historical_records: dict[str, MemoryItem] = {}
        for row in rows:
            loaded = json.loads(row["records_json"] or "[]")
            if not isinstance(loaded, list):
                continue

            for raw_record in loaded:
                if not isinstance(raw_record, dict):
                    continue

                record = MemoryItem.from_dict(raw_record)
                historical_records.setdefault(record.id, record)

        return historical_records

    async def create_snapshot(
        self,
        *,
        label: str | None = None,
        at: datetime | None = None,
    ) -> MemorySnapshot:
        return await asyncio.to_thread(self._create_snapshot_sync, label, at)

    def _create_snapshot_sync(self, label: str | None, at: datetime | None) -> MemorySnapshot:
        snapshot_id = new_id()
        snapshot_at = at or _utcnow()
        created_at = _utcnow()
        with self._lock:
            records = self._checkout_at_locked(snapshot_at)
            memory_ids = [record.id for record in records]
            records_json = dumps_json([record.to_wire_dict() for record in records])
            signature_hash = stable_hash(records_json)
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO memory_snapshot (
                        id,
                        label,
                        snapshot_at,
                        memory_ids_json,
                        records_json,
                        signature_hash,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        snapshot_id,
                        label,
                        snapshot_at.isoformat(),
                        values_for_json(memory_ids),
                        records_json,
                        signature_hash,
                        created_at.isoformat(),
                    ),
                )
                row = self._conn.execute(
                    """
                    SELECT id, label, snapshot_at, memory_ids_json,
                           signature_hash, created_at
                    FROM memory_snapshot
                    WHERE id = ?
                    """,
                    (snapshot_id,),
                ).fetchone()

        return row_to_snapshot(row)

    async def checkout_snapshot(self, snapshot_id: str) -> list[MemoryItem]:
        return await asyncio.to_thread(self._checkout_snapshot_sync, snapshot_id)

    def _checkout_snapshot_sync(self, snapshot_id: str) -> list[MemoryItem]:
        with self._lock:
            snapshot_row = self._conn.execute(
                """
                SELECT id, label, snapshot_at, memory_ids_json,
                       records_json, signature_hash, created_at
                FROM memory_snapshot
                WHERE id = ?
                """,
                (snapshot_id,),
            ).fetchone()
            if snapshot_row is None:
                raise KeyError(f"memory snapshot not found: {snapshot_id}")

            records_json = snapshot_row["records_json"]
            if records_json:
                loaded = json.loads(records_json)
                if isinstance(loaded, list):
                    return [
                        self._snapshot_record_from_dict(record)
                        for record in loaded
                        if isinstance(record, dict)
                    ]

            snapshot = row_to_snapshot(snapshot_row)
            if not snapshot.memory_ids:
                return []

            rows_by_id = {
                row["id"]: row
                for row in self._conn.execute(
                    f"""
                    SELECT {record_columns()}
                    FROM memory_records
                    WHERE id IN ({",".join("?" for _ in snapshot.memory_ids)})
                    """,
                    snapshot.memory_ids,
                ).fetchall()
            }

        return [
            _row_to_record(rows_by_id[memory_id], now=_utcnow)
            for memory_id in snapshot.memory_ids
            if memory_id in rows_by_id
        ]

    @staticmethod
    def _snapshot_record_from_dict(payload: dict[str, object]) -> MemoryItem:
        raw_layer = payload.get("layer", payload.get("tier"))
        if raw_layer == "short":
            payload = {**payload, "layer": "working", "tier": "working"}
        elif raw_layer == "long":
            payload = {**payload, "layer": "semantic", "tier": "semantic"}

        return MemoryItem.from_dict(payload)

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
        return memory_item_with(
            record,
            last_accessed=accessed_at,
            access_count=record.access_count + 1,
        )
