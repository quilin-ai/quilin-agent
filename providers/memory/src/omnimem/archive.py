from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Literal, cast

from .types import MemoryItem

ArchiveCompression = Literal["none", "zstd-stub"]
ArchiveTemperature = Literal["hot", "cold"]
ARCHIVE_SCHEMA_COMPONENT = "episodic_archive_manifest"
ARCHIVE_SCHEMA_VERSION = 1
DEFAULT_CAPACITY_TARGET_PER_USER = 100_000
DEFAULT_COLD_AFTER_DAYS = 90
DEFAULT_MIN_IMPORTANCE_FOR_HOT = 0.8


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class ArchivePolicy:
    cold_after_days: int = DEFAULT_COLD_AFTER_DAYS
    min_importance_for_hot: float = DEFAULT_MIN_IMPORTANCE_FOR_HOT
    capacity_target_per_user: int = DEFAULT_CAPACITY_TARGET_PER_USER
    compression: ArchiveCompression = "zstd-stub"

    def __post_init__(self) -> None:
        if self.cold_after_days < 1:
            raise ValueError("cold_after_days must be positive")
        if not 0 <= self.min_importance_for_hot <= 1:
            raise ValueError("min_importance_for_hot must be between 0 and 1")
        if self.capacity_target_per_user < 1:
            raise ValueError("capacity_target_per_user must be positive")

    def classify(self, memory: MemoryItem, *, now: datetime | None = None) -> ArchiveTemperature:
        reference_time = now or _utcnow()
        age = reference_time - memory.created_at
        if memory.importance_score >= self.min_importance_for_hot:
            return "hot"
        if age >= timedelta(days=self.cold_after_days):
            return "cold"
        return "hot"


@dataclass(frozen=True, slots=True)
class ArchiveManifestEntry:
    memory_id: str
    user_id: str
    temperature: ArchiveTemperature
    compression: ArchiveCompression
    archive_key: str
    content_digest: str
    original_bytes: int
    compressed_bytes: int
    created_at: datetime
    archived_at: datetime
    schema_version: int = ARCHIVE_SCHEMA_VERSION
    metadata: dict[str, object] = field(default_factory=dict)

    def to_row(self) -> tuple[object, ...]:
        return (
            self.memory_id,
            self.user_id,
            self.temperature,
            self.compression,
            self.archive_key,
            self.content_digest,
            self.original_bytes,
            self.compressed_bytes,
            self.created_at.isoformat(),
            self.archived_at.isoformat(),
            self.schema_version,
            json.dumps(self.metadata, sort_keys=True),
        )

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> ArchiveManifestEntry:
        return cls(
            memory_id=cast(str, row["memory_id"]),
            user_id=cast(str, row["user_id"]),
            temperature=cast(ArchiveTemperature, row["temperature"]),
            compression=cast(ArchiveCompression, row["compression"]),
            archive_key=cast(str, row["archive_key"]),
            content_digest=cast(str, row["content_digest"]),
            original_bytes=int(row["original_bytes"]),
            compressed_bytes=int(row["compressed_bytes"]),
            created_at=datetime.fromisoformat(cast(str, row["created_at"])),
            archived_at=datetime.fromisoformat(cast(str, row["archived_at"])),
            schema_version=int(row["schema_version"]),
            metadata=cast(dict[str, object], json.loads(cast(str, row["metadata_json"]))),
        )


class ArchiveManifestStore:
    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._ensure_schema()

    def close(self) -> None:
        with self._lock:
            self._conn.commit()
            self._conn.close()

    def record(self, entry: ArchiveManifestEntry) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO episodic_archive_manifest (
                    memory_id,
                    user_id,
                    temperature,
                    compression,
                    archive_key,
                    content_digest,
                    original_bytes,
                    compressed_bytes,
                    created_at,
                    archived_at,
                    schema_version,
                    metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(memory_id) DO UPDATE SET
                    user_id = excluded.user_id,
                    temperature = excluded.temperature,
                    compression = excluded.compression,
                    archive_key = excluded.archive_key,
                    content_digest = excluded.content_digest,
                    original_bytes = excluded.original_bytes,
                    compressed_bytes = excluded.compressed_bytes,
                    created_at = excluded.created_at,
                    archived_at = excluded.archived_at,
                    schema_version = excluded.schema_version,
                    metadata_json = excluded.metadata_json
                """,
                entry.to_row(),
            )
            self._conn.commit()

    def get(self, memory_id: str) -> ArchiveManifestEntry | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT *
                FROM episodic_archive_manifest
                WHERE memory_id = ?
                """,
                (memory_id,),
            ).fetchone()
        return None if row is None else ArchiveManifestEntry.from_row(row)

    def list_for_user(
        self,
        user_id: str,
        *,
        temperature: ArchiveTemperature | None = None,
    ) -> list[ArchiveManifestEntry]:
        with self._lock:
            if temperature is None:
                rows = self._conn.execute(
                    """
                    SELECT *
                    FROM episodic_archive_manifest
                    WHERE user_id = ?
                    ORDER BY created_at ASC, memory_id ASC
                    """,
                    (user_id,),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT *
                    FROM episodic_archive_manifest
                    WHERE user_id = ? AND temperature = ?
                    ORDER BY created_at ASC, memory_id ASC
                    """,
                    (user_id, temperature),
                ).fetchall()

        return [ArchiveManifestEntry.from_row(row) for row in rows]

    def _ensure_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS episodic_archive_manifest (
                    memory_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    temperature TEXT NOT NULL CHECK (temperature IN ('hot', 'cold')),
                    compression TEXT NOT NULL CHECK (compression IN ('none', 'zstd-stub')),
                    archive_key TEXT NOT NULL,
                    content_digest TEXT NOT NULL,
                    original_bytes INTEGER NOT NULL,
                    compressed_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    archived_at TEXT NOT NULL,
                    schema_version INTEGER NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_episodic_archive_manifest_user_temp
                ON episodic_archive_manifest(user_id, temperature, created_at)
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
                (ARCHIVE_SCHEMA_COMPONENT, ARCHIVE_SCHEMA_VERSION),
            )
            self._conn.commit()


def build_archive_manifest_entry(
    memory: MemoryItem,
    *,
    user_id: str,
    policy: ArchivePolicy | None = None,
    now: datetime | None = None,
) -> ArchiveManifestEntry:
    resolved_policy = policy or ArchivePolicy()
    archived_at = now or _utcnow()
    content_bytes = memory.content.encode("utf-8")
    temperature = resolved_policy.classify(memory, now=archived_at)
    compression = "none" if temperature == "hot" else resolved_policy.compression

    return ArchiveManifestEntry(
        memory_id=memory.id,
        user_id=user_id,
        temperature=temperature,
        compression=compression,
        archive_key=f"users/{user_id}/episodic/{memory.id}.json",
        content_digest=sha256(content_bytes).hexdigest(),
        original_bytes=len(content_bytes),
        compressed_bytes=_compressed_size_stub(content_bytes, compression),
        created_at=memory.created_at,
        archived_at=archived_at,
        metadata={
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "capacity_target_per_user": resolved_policy.capacity_target_per_user,
            "source_layer": memory.layer,
        },
    )


def _compressed_size_stub(content: bytes, compression: ArchiveCompression) -> int:
    if compression == "none":
        return len(content)

    # TODO(Iter M3): replace this sizing stub with zstandard.ZstdCompressor.
    return len(content)


__all__ = [
    "ARCHIVE_SCHEMA_COMPONENT",
    "ARCHIVE_SCHEMA_VERSION",
    "ArchiveManifestEntry",
    "ArchiveManifestStore",
    "ArchivePolicy",
    "build_archive_manifest_entry",
]
