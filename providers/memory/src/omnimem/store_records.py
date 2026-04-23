from __future__ import annotations

import sqlite3
from collections.abc import Callable

from .store_serialization import serialize_embedding, serialize_metadata
from .types import MemoryItem


def insert_memory(
    conn: sqlite3.Connection,
    memory: MemoryItem,
    *,
    build_keywords: Callable[[str], str],
) -> None:
    conn.execute(
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
            serialize_metadata(dict(memory.metadata)),
            serialize_embedding(memory.embedding),
            memory.created_at.isoformat(),
            memory.last_accessed.isoformat(),
            memory.access_count,
            memory.importance_score,
        ),
    )
    conn.execute(
        """
        INSERT INTO memory_records_fts (id, content, keywords)
        VALUES (?, ?, ?)
        """,
        (memory.id, memory.content, build_keywords(memory.content)),
    )
