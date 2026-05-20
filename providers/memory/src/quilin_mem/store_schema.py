from __future__ import annotations

import sqlite3
from collections.abc import Callable
from datetime import datetime

DEFAULT_MEMORY_METADATA = '{"schema_version": 1}'
FTS_SCHEMA_COMPONENT = "memory_records_fts"
FTS_SCHEMA_VERSION = 1


def configure_connection(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL")


def ensure_store_schema(
    conn: sqlite3.Connection,
    *,
    now: Callable[[], datetime],
    rebuild_fts_index: Callable[[], None],
) -> None:
    conn.execute(
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
    _ensure_memory_record_columns(conn, now=now)
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
            id UNINDEXED,
            content,
            keywords,
            tokenize = 'unicode61'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL
        )
        """
    )
    _ensure_versioning_tables(conn)
    _ensure_fts_schema(conn, rebuild_fts_index=rebuild_fts_index)
    conn.commit()


def _ensure_memory_record_columns(
    conn: sqlite3.Connection,
    *,
    now: Callable[[], datetime],
) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(memory_records)")}
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
        (
            "version",
            "ALTER TABLE memory_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "parent_id",
            "ALTER TABLE memory_records ADD COLUMN parent_id TEXT",
        ),
        (
            "supersedes_json",
            "ALTER TABLE memory_records ADD COLUMN supersedes_json TEXT",
        ),
        (
            "is_latest",
            "ALTER TABLE memory_records ADD COLUMN is_latest INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "source_event_id",
            "ALTER TABLE memory_records ADD COLUMN source_event_id TEXT",
        ),
        (
            "evidence_hash",
            "ALTER TABLE memory_records ADD COLUMN evidence_hash TEXT",
        ),
        (
            "forget_after",
            "ALTER TABLE memory_records ADD COLUMN forget_after TEXT",
        ),
        (
            "strength",
            "ALTER TABLE memory_records ADD COLUMN strength REAL NOT NULL DEFAULT 1.0",
        ),
    )
    for column_name, statement in additions:
        if column_name in columns:
            continue

        conn.execute(statement)

    timestamp = now().isoformat()
    conn.execute(
        """
        UPDATE memory_records
        SET content_type = 'text'
        WHERE content_type IS NULL OR content_type = ''
        """
    )
    conn.execute(
        """
        UPDATE memory_records
        SET metadata_json = ?
        WHERE metadata_json IS NULL OR trim(metadata_json) = ''
        """,
        (DEFAULT_MEMORY_METADATA,),
    )
    conn.execute(
        """
        UPDATE memory_records
        SET created_at = ?
        WHERE created_at IS NULL OR created_at = ''
        """,
        (timestamp,),
    )
    conn.execute(
        """
        UPDATE memory_records
        SET last_accessed = created_at
        WHERE last_accessed IS NULL OR last_accessed = ''
        """,
    )
    conn.execute(
        """
        UPDATE memory_records
        SET access_count = 0
        WHERE access_count IS NULL
        """
    )
    conn.execute(
        """
        UPDATE memory_records
        SET importance_score = 0.5
        WHERE importance_score IS NULL
        """
    )
    conn.execute(
        """
        UPDATE memory_records
        SET deleted = 0
        WHERE deleted IS NULL
        """
    )
    conn.execute(
        """
        UPDATE memory_records
        SET version = 1
        WHERE version IS NULL OR version < 1
        """
    )
    conn.execute(
        """
        UPDATE memory_records
        SET is_latest = 1
        WHERE is_latest IS NULL
        """
    )
    conn.execute(
        """
        UPDATE memory_records
        SET strength = 1.0
        WHERE strength IS NULL
        """
    )


def _ensure_versioning_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memory_observations (
            id TEXT PRIMARY KEY,
            source_event_id TEXT,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            actor_id TEXT,
            role TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memory_sources (
            id TEXT PRIMARY KEY,
            memory_record_id TEXT NOT NULL,
            observation_id TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'observation',
            source_uri TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_sources_record
        ON memory_sources(memory_record_id)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_sources_observation
        ON memory_sources(observation_id)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memory_snapshot (
            id TEXT PRIMARY KEY,
            label TEXT,
            snapshot_at TEXT NOT NULL,
            memory_ids_json TEXT NOT NULL,
            records_json TEXT,
            signature_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    snapshot_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(memory_snapshot)").fetchall()
    }
    if "records_json" not in snapshot_columns:
        conn.execute("ALTER TABLE memory_snapshot ADD COLUMN records_json TEXT")


def _ensure_fts_schema(
    conn: sqlite3.Connection,
    *,
    rebuild_fts_index: Callable[[], None],
) -> None:
    if _get_schema_version(conn, FTS_SCHEMA_COMPONENT) >= FTS_SCHEMA_VERSION:
        return

    rebuild_fts_index()
    conn.execute(
        """
        INSERT INTO schema_version (component, version)
        VALUES (?, ?)
        ON CONFLICT(component) DO UPDATE SET version = excluded.version
        """,
        (FTS_SCHEMA_COMPONENT, FTS_SCHEMA_VERSION),
    )


def _get_schema_version(conn: sqlite3.Connection, component: str) -> int:
    row = conn.execute(
        "SELECT version FROM schema_version WHERE component = ?",
        (component,),
    ).fetchone()
    if row is None:
        return 0

    return int(row["version"])
