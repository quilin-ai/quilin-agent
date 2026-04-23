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
    build_keywords: Callable[[str], str],
    now: Callable[[], datetime],
    rebuild_fts_index: Callable[[], None] | None = None,
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
    _ensure_fts_schema(conn, build_keywords=build_keywords, rebuild_fts_index=rebuild_fts_index)
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


def _ensure_fts_schema(
    conn: sqlite3.Connection,
    *,
    build_keywords: Callable[[str], str],
    rebuild_fts_index: Callable[[], None] | None,
) -> None:
    if _get_schema_version(conn, FTS_SCHEMA_COMPONENT) >= FTS_SCHEMA_VERSION:
        return

    if rebuild_fts_index is None:
        _rebuild_fts_index(conn, build_keywords=build_keywords)
    else:
        rebuild_fts_index()
    conn.execute(
        """
        INSERT INTO schema_version (component, version)
        VALUES (?, ?)
        ON CONFLICT(component) DO UPDATE SET version = excluded.version
        """,
        (FTS_SCHEMA_COMPONENT, FTS_SCHEMA_VERSION),
    )


def _rebuild_fts_index(
    conn: sqlite3.Connection,
    *,
    build_keywords: Callable[[str], str],
) -> None:
    conn.execute("DELETE FROM memory_records_fts")
    conn.execute(
        """
        INSERT INTO memory_records_fts (id, content, keywords)
        SELECT id, content, ''
        FROM memory_records
        WHERE deleted = 0
        """
    )
    rows = conn.execute(
        """
        SELECT id, content
        FROM memory_records
        WHERE deleted = 0
        ORDER BY rowid ASC
        """
    ).fetchall()
    for row in rows:
        conn.execute(
            """
            UPDATE memory_records_fts
            SET keywords = ?
            WHERE id = ?
            """,
            (build_keywords(row["content"]), row["id"]),
        )


def _get_schema_version(conn: sqlite3.Connection, component: str) -> int:
    row = conn.execute(
        "SELECT version FROM schema_version WHERE component = ?",
        (component,),
    ).fetchone()
    if row is None:
        return 0

    return int(row["version"])
