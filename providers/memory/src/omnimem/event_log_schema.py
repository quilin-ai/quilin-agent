from __future__ import annotations

import sqlite3

EVENT_LOG_SCHEMA_VERSION = 1
EVENT_LOG_COMPONENT = "retrieval_event_log"
DEFAULT_TOP_N = 10


def ensure_event_log_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS retrieval_event_log (
            event_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            query_hash TEXT NOT NULL,
            query_raw TEXT,
            memory_id TEXT NOT NULL,
            rank INTEGER NOT NULL,
            score REAL NOT NULL,
            source_layer TEXT NOT NULL,
            source TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            was_cited INTEGER NOT NULL DEFAULT 0 CHECK (was_cited IN (0, 1)),
            timestamp TEXT NOT NULL,
            schema_version INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_retrieval_event_log_run
        ON retrieval_event_log(run_id, rank)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_retrieval_event_log_memory
        ON retrieval_event_log(memory_id, was_cited)
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
    conn.execute(
        """
        INSERT INTO schema_version (component, version)
        VALUES (?, ?)
        ON CONFLICT(component) DO UPDATE SET version = excluded.version
        """,
        (EVENT_LOG_COMPONENT, EVENT_LOG_SCHEMA_VERSION),
    )
    conn.commit()


__all__ = [
    "DEFAULT_TOP_N",
    "EVENT_LOG_COMPONENT",
    "EVENT_LOG_SCHEMA_VERSION",
    "ensure_event_log_schema",
]
