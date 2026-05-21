from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .retrieval_safety_gate import SafetyLesson

DEFAULT_LESSON_TYPE = "poisoning"
DEFAULT_SEVERITY = "medium"
DEFAULT_SOURCE = "memory"
SAFETY_LESSONS_DB_ENV = "QUILIN_SAFETY_LESSONS_DB_PATH"

_EPOCH_ISO = "1970-01-01T00:00:00+00:00"
_SCHEMA_COLUMNS: dict[str, str] = {
    "id": "TEXT PRIMARY KEY",
    "pattern": "TEXT NOT NULL",
    "lesson_type": f"TEXT NOT NULL DEFAULT '{DEFAULT_LESSON_TYPE}'",
    "severity": f"TEXT NOT NULL DEFAULT '{DEFAULT_SEVERITY}'",
    "source": f"TEXT NOT NULL DEFAULT '{DEFAULT_SOURCE}'",
    "created_at": f"TEXT NOT NULL DEFAULT '{_EPOCH_ISO}'",
    "updated_at": f"TEXT NOT NULL DEFAULT '{_EPOCH_ISO}'",
    "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
    "enabled": "INTEGER NOT NULL DEFAULT 1",
}


class SQLiteSafetyLessonStore:
    """SQLite-backed SafetyLesson store for retrieval-time quarantine rules."""

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._ensure_schema()

    def add(
        self,
        *,
        pattern: str,
        lesson_type: str,
        severity: str,
        source: str,
        metadata: dict[str, object] | None = None,
        lesson_id: str | None = None,
        created_at: datetime | None = None,
        updated_at: datetime | None = None,
    ) -> SafetyLesson:
        """Insert or replace one enabled lesson and return the stored record."""

        clean_metadata = _normalize_metadata(metadata)
        now = datetime.now(UTC)
        created = created_at or now
        updated = updated_at or created
        lesson = SafetyLesson(
            id=lesson_id or str(uuid4()),
            pattern=pattern,
            reason=str(clean_metadata.get("reason", "")),
            tags=_metadata_tags(clean_metadata),
            created_at=created,
            updated_at=updated,
            lesson_type=lesson_type,
            severity=severity,
            source=source,
            metadata=clean_metadata,
            enabled=True,
            is_regex=bool(clean_metadata.get("is_regex", False)),
        )
        self.record_lesson(lesson)
        return lesson

    def list(self, *, enabled_only: bool = True) -> tuple[SafetyLesson, ...]:
        """Return lessons ordered by creation time, then id."""

        where = "WHERE enabled = 1" if enabled_only else ""
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT id, pattern, lesson_type, severity, source,
                       created_at, updated_at, metadata_json, enabled
                FROM safety_lessons
                {where}
                ORDER BY created_at ASC, id ASC
                """
            ).fetchall()
        return tuple(_row_to_lesson(row) for row in rows)

    def search(self, query: str, *, enabled_only: bool = True) -> tuple[SafetyLesson, ...]:
        """Case-insensitive substring search over public columns and metadata JSON."""

        needle = query.strip().lower()
        if not needle:
            return self.list(enabled_only=enabled_only)

        return tuple(
            lesson
            for lesson in self.list(enabled_only=enabled_only)
            if needle
            in "\n".join(
                (
                    lesson.pattern,
                    lesson.lesson_type,
                    lesson.severity,
                    lesson.source,
                    json.dumps(lesson.metadata, ensure_ascii=False, sort_keys=True),
                )
            ).lower()
        )

    def disable(self, lesson_id: str) -> bool:
        """Disable a lesson without deleting audit history."""

        now = datetime.now(UTC).isoformat()
        with self._lock:
            cursor = self._conn.execute(
                """
                UPDATE safety_lessons
                SET enabled = 0, updated_at = ?
                WHERE id = ? AND enabled = 1
                """,
                (now, lesson_id),
            )
            self._conn.commit()
        return cursor.rowcount > 0

    def match(self, text: str) -> tuple[SafetyLesson, ...]:
        """Return enabled lessons whose deterministic pattern matches text."""

        return tuple(lesson for lesson in self.list() if lesson.matches(text))

    def list_lessons(self) -> Sequence[SafetyLesson]:
        """Compatibility with `RetrievalSafetyGate`'s lesson provider protocol."""

        return self.list()

    def record_lesson(self, lesson: SafetyLesson) -> None:
        """Compatibility upsert used by `RetrievalSafetyGate.record_lesson`."""

        metadata = dict(lesson.metadata)
        if lesson.reason and "reason" not in metadata:
            metadata["reason"] = lesson.reason
        if lesson.tags and "tags" not in metadata:
            metadata["tags"] = list(lesson.tags)
        if lesson.is_regex and "is_regex" not in metadata:
            metadata["is_regex"] = True
        metadata_json = _metadata_json(metadata)
        updated_at = lesson.updated_at or datetime.now(UTC)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO safety_lessons (
                    id, pattern, lesson_type, severity, source,
                    created_at, updated_at, metadata_json, enabled
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    pattern = excluded.pattern,
                    lesson_type = excluded.lesson_type,
                    severity = excluded.severity,
                    source = excluded.source,
                    updated_at = excluded.updated_at,
                    metadata_json = excluded.metadata_json,
                    enabled = excluded.enabled
                """,
                (
                    lesson.id,
                    lesson.pattern,
                    lesson.lesson_type,
                    lesson.severity,
                    lesson.source,
                    lesson.created_at.isoformat(),
                    updated_at.isoformat(),
                    metadata_json,
                    1 if lesson.enabled else 0,
                ),
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _ensure_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS safety_lessons (
                    id TEXT PRIMARY KEY,
                    pattern TEXT NOT NULL,
                    lesson_type TEXT NOT NULL DEFAULT 'poisoning',
                    severity TEXT NOT NULL DEFAULT 'medium',
                    source TEXT NOT NULL DEFAULT 'memory',
                    created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',
                    updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    enabled INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            existing = {
                str(row["name"])
                for row in self._conn.execute("PRAGMA table_info(safety_lessons)").fetchall()
            }
            for column, definition in _SCHEMA_COLUMNS.items():
                if column not in existing:
                    self._conn.execute(
                        f"ALTER TABLE safety_lessons ADD COLUMN {column} {definition}"
                    )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_safety_lessons_enabled
                ON safety_lessons(enabled)
                """
            )
            self._conn.commit()


def default_safety_lesson_db_path() -> str:
    explicit = os.environ.get(SAFETY_LESSONS_DB_ENV)
    if explicit:
        return explicit
    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"
    return os.environ.get("QUILIN_MEM_DB_PATH", str(Path.home() / ".quilin" / "memory.db"))


def open_default_safety_lesson_store() -> SQLiteSafetyLessonStore:
    return SQLiteSafetyLessonStore(default_safety_lesson_db_path())


def _normalize_metadata(metadata: dict[str, object] | None) -> dict[str, object]:
    if metadata is None:
        return {}
    if not isinstance(metadata, dict):
        raise TypeError("metadata must be a dict[str, object]")
    _metadata_json(metadata)
    return dict(metadata)


def _metadata_json(metadata: dict[str, object]) -> str:
    return json.dumps(metadata, allow_nan=False, ensure_ascii=False, sort_keys=True)


def _metadata_tags(metadata: dict[str, object]) -> tuple[str, ...]:
    tags = metadata.get("tags", ())
    if not isinstance(tags, (list, tuple)):
        return ()
    return tuple(str(tag) for tag in tags)


def _row_to_lesson(row: sqlite3.Row) -> SafetyLesson:
    metadata = _load_metadata(row["metadata_json"])
    return SafetyLesson(
        id=str(row["id"]),
        pattern=str(row["pattern"]),
        reason=str(metadata.get("reason", "")),
        tags=_metadata_tags(metadata),
        created_at=_parse_datetime(str(row["created_at"])),
        updated_at=_parse_datetime(str(row["updated_at"])),
        lesson_type=str(row["lesson_type"]),
        severity=str(row["severity"]),
        source=str(row["source"]),
        metadata=metadata,
        enabled=bool(row["enabled"]),
        is_regex=bool(metadata.get("is_regex", False)),
    )


def _load_metadata(metadata_json: str | None) -> dict[str, object]:
    if not metadata_json:
        return {}
    try:
        loaded: Any = json.loads(metadata_json)
    except json.JSONDecodeError:
        return {"metadata_error": "invalid_json"}
    if not isinstance(loaded, dict):
        return {"metadata_error": "not_object"}
    return dict(loaded)


def _parse_datetime(raw: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return datetime.now(UTC)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


__all__ = [
    "SAFETY_LESSONS_DB_ENV",
    "SQLiteSafetyLessonStore",
    "default_safety_lesson_db_path",
    "open_default_safety_lesson_store",
]
