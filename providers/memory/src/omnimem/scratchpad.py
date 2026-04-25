from __future__ import annotations

import asyncio
import os
import sqlite3
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

DEFAULT_SCRATCHPAD_TTL_SEC = 3600
DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK = 1024


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _resolve_db_path(db_path: str | None) -> str:
    if db_path is not None:
        return db_path

    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"

    return os.environ.get(
        "OMNIMEM_SCRATCHPAD_PATH",
        str(Path.home() / ".quilin" / "memory-scratchpad.db"),
    )


def _validate_positive_int(value: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _validate_non_empty(value: str, field: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


@dataclass(frozen=True, slots=True)
class ScratchpadEntry:
    task_id: str
    session_id: str
    key: str
    value: str
    created_at: datetime
    ttl_sec: int

    @property
    def expires_at(self) -> datetime:
        return self.created_at + timedelta(seconds=self.ttl_sec)

    def is_expired(self, now: datetime) -> bool:
        return self.expires_at <= now


class ScratchpadStore:
    def __init__(
        self,
        db_path: str | None = None,
        *,
        default_ttl_sec: int = DEFAULT_SCRATCHPAD_TTL_SEC,
        capacity_per_task: int = DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self._default_ttl_sec = _validate_positive_int(
            default_ttl_sec,
            "default_ttl_sec",
        )
        self._capacity_per_task = _validate_positive_int(
            capacity_per_task,
            "capacity_per_task",
        )
        self._now = now

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

    async def __aenter__(self) -> ScratchpadStore:
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
                self._conn.execute("DELETE FROM scratchpad_entries")

    async def write(
        self,
        *,
        task_id: str,
        session_id: str,
        key: str,
        value: str,
        ttl_sec: int | None = None,
        capacity_per_task: int | None = None,
    ) -> ScratchpadEntry:
        return await asyncio.to_thread(
            self._write_sync,
            task_id,
            session_id,
            key,
            value,
            ttl_sec,
            capacity_per_task,
        )

    def _write_sync(
        self,
        task_id: str,
        session_id: str,
        key: str,
        value: str,
        ttl_sec: int | None,
        capacity_per_task: int | None,
    ) -> ScratchpadEntry:
        normalized_task_id = _validate_non_empty(task_id, "task_id")
        normalized_session_id = _validate_non_empty(session_id, "session_id")
        normalized_key = _validate_non_empty(key, "key")
        if not isinstance(value, str):
            raise ValueError("value must be a string")

        resolved_ttl_sec = _validate_positive_int(
            ttl_sec if ttl_sec is not None else self._default_ttl_sec,
            "ttl_sec",
        )
        resolved_capacity = _validate_positive_int(
            capacity_per_task
            if capacity_per_task is not None
            else self._capacity_per_task,
            "capacity_per_task",
        )
        now = self._now()
        now_wire = now.isoformat()

        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._delete_expired_locked(
                    task_id=normalized_task_id,
                    session_id=normalized_session_id,
                    now=now,
                )
                self._conn.execute(
                    """
                    INSERT INTO scratchpad_entries (
                        task_id,
                        session_id,
                        key,
                        value,
                        created_at,
                        ttl_sec,
                        last_accessed
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(task_id, session_id, key) DO UPDATE SET
                        value = excluded.value,
                        created_at = excluded.created_at,
                        ttl_sec = excluded.ttl_sec,
                        last_accessed = excluded.last_accessed
                    """,
                    (
                        normalized_task_id,
                        normalized_session_id,
                        normalized_key,
                        value,
                        now_wire,
                        resolved_ttl_sec,
                        now_wire,
                    ),
                )
                self._evict_over_capacity_locked(
                    task_id=normalized_task_id,
                    session_id=normalized_session_id,
                    capacity=resolved_capacity,
                )

        return ScratchpadEntry(
            task_id=normalized_task_id,
            session_id=normalized_session_id,
            key=normalized_key,
            value=value,
            created_at=now,
            ttl_sec=resolved_ttl_sec,
        )

    async def read(
        self,
        *,
        task_id: str,
        session_id: str,
        key: str,
    ) -> str | None:
        return await asyncio.to_thread(self._read_sync, task_id, session_id, key)

    def _read_sync(self, task_id: str, session_id: str, key: str) -> str | None:
        normalized_task_id = _validate_non_empty(task_id, "task_id")
        normalized_session_id = _validate_non_empty(session_id, "session_id")
        normalized_key = _validate_non_empty(key, "key")
        now = self._now()
        now_wire = now.isoformat()

        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._delete_expired_locked(
                    task_id=normalized_task_id,
                    session_id=normalized_session_id,
                    now=now,
                )
                row = self._conn.execute(
                    """
                    SELECT value
                    FROM scratchpad_entries
                    WHERE task_id = ? AND session_id = ? AND key = ?
                    """,
                    (normalized_task_id, normalized_session_id, normalized_key),
                ).fetchone()
                if row is None:
                    return None

                self._conn.execute(
                    """
                    UPDATE scratchpad_entries
                    SET last_accessed = ?
                    WHERE task_id = ? AND session_id = ? AND key = ?
                    """,
                    (
                        now_wire,
                        normalized_task_id,
                        normalized_session_id,
                        normalized_key,
                    ),
                )
                return str(row["value"])

    async def clear(
        self,
        *,
        task_id: str,
        session_id: str,
        key: str | None = None,
    ) -> int:
        return await asyncio.to_thread(self._clear_sync, task_id, session_id, key)

    def _clear_sync(self, task_id: str, session_id: str, key: str | None) -> int:
        normalized_task_id = _validate_non_empty(task_id, "task_id")
        normalized_session_id = _validate_non_empty(session_id, "session_id")
        normalized_key = None if key is None else _validate_non_empty(key, "key")

        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                if normalized_key is None:
                    cursor = self._conn.execute(
                        """
                        DELETE FROM scratchpad_entries
                        WHERE task_id = ? AND session_id = ?
                        """,
                        (normalized_task_id, normalized_session_id),
                    )
                else:
                    cursor = self._conn.execute(
                        """
                        DELETE FROM scratchpad_entries
                        WHERE task_id = ? AND session_id = ? AND key = ?
                        """,
                        (normalized_task_id, normalized_session_id, normalized_key),
                    )
                return int(cursor.rowcount)

    def _ensure_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scratchpad_entries (
                task_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                ttl_sec INTEGER NOT NULL,
                last_accessed TEXT NOT NULL,
                PRIMARY KEY (task_id, session_id, key)
            )
            """
        )
        self._conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_scratchpad_task_lru
            ON scratchpad_entries(session_id, task_id, last_accessed, created_at, key)
            """
        )
        self._conn.commit()

    def _delete_expired_locked(
        self,
        *,
        task_id: str,
        session_id: str,
        now: datetime,
    ) -> None:
        rows = self._conn.execute(
            """
            SELECT key, created_at, ttl_sec
            FROM scratchpad_entries
            WHERE task_id = ? AND session_id = ?
            """,
            (task_id, session_id),
        ).fetchall()
        expired_keys = [
            row["key"]
            for row in rows
            if ScratchpadEntry(
                task_id=task_id,
                session_id=session_id,
                key=str(row["key"]),
                value="",
                created_at=_parse_timestamp(str(row["created_at"])),
                ttl_sec=int(row["ttl_sec"]),
            ).is_expired(now)
        ]
        if not expired_keys:
            return

        self._conn.executemany(
            """
            DELETE FROM scratchpad_entries
            WHERE task_id = ? AND session_id = ? AND key = ?
            """,
            [(task_id, session_id, key) for key in expired_keys],
        )

    def _evict_over_capacity_locked(
        self,
        *,
        task_id: str,
        session_id: str,
        capacity: int,
    ) -> None:
        rows = self._conn.execute(
            """
            SELECT key
            FROM scratchpad_entries
            WHERE task_id = ? AND session_id = ?
            ORDER BY last_accessed ASC, created_at ASC, key ASC
            """,
            (task_id, session_id),
        ).fetchall()
        overflow = len(rows) - capacity
        if overflow <= 0:
            return

        self._conn.executemany(
            """
            DELETE FROM scratchpad_entries
            WHERE task_id = ? AND session_id = ? AND key = ?
            """,
            [(task_id, session_id, str(row["key"])) for row in rows[:overflow]],
        )
