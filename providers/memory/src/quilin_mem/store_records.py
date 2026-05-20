from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import datetime

from .store_serialization import serialize_embedding, serialize_metadata
from .types import MemoryItem


def insert_memory(
    conn: sqlite3.Connection,
    memory: MemoryItem,
    *,
    build_keywords: Callable[[str], str],
    version: int = 1,
    parent_id: str | None = None,
    supersedes: list[str] | None = None,
    is_latest: bool = True,
    source_event_id: str | None = None,
    evidence_hash: str | None = None,
    forget_after: datetime | None = None,
    strength: float = 1.0,
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
            deleted,
            version,
            parent_id,
            supersedes_json,
            is_latest,
            source_event_id,
            evidence_hash,
            forget_after,
            strength
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
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
            version,
            parent_id,
            (
                json.dumps(supersedes, ensure_ascii=False, separators=(",", ":"))
                if supersedes is not None
                else None
            ),
            int(is_latest),
            source_event_id,
            evidence_hash,
            forget_after.isoformat() if forget_after is not None else None,
            strength,
        ),
    )
    conn.execute(
        """
        INSERT INTO memory_records_fts (id, content, keywords)
        VALUES (?, ?, ?)
        """,
        (memory.id, memory.content, build_keywords(memory.content)),
    )
