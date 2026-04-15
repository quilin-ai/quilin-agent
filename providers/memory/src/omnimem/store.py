from __future__ import annotations

import os
import sqlite3
import uuid
from pathlib import Path

from .types import MemoryRecord


class OmniMemStore:
    def __init__(self, db_path: str | None = None) -> None:
        if db_path is None:
            if os.environ.get("QUILIN_ENV") == "test":
                db_path = ":memory:"
            else:
                db_path = os.environ.get("OMNIMEM_DB_PATH", "./data/omnimem.db")

        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_records (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tier TEXT NOT NULL
            )
            """
        )
        self._conn.commit()

    def reset(self) -> None:
        self._conn.execute("DELETE FROM memory_records")
        self._conn.commit()

    async def recall(self, query: str) -> list[MemoryRecord]:
        if not query:
            rows = self._conn.execute(
                "SELECT id, content, tier FROM memory_records ORDER BY rowid ASC"
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT id, content, tier
                FROM memory_records
                WHERE lower(content) LIKE ?
                ORDER BY rowid ASC
                """,
                (f"%{query.lower()}%",),
            ).fetchall()

        return [
            MemoryRecord(id=row["id"], content=row["content"], tier=row["tier"])
            for row in rows
        ]

    async def store(self, content: str, tier: str = "short") -> MemoryRecord:
        record = MemoryRecord(id=str(uuid.uuid4()), content=content, tier=tier)
        self._conn.execute(
            "INSERT INTO memory_records (id, content, tier) VALUES (?, ?, ?)",
            (record.id, record.content, record.tier),
        )
        self._conn.commit()
        return record
