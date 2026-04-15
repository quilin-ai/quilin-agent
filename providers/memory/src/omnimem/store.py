from __future__ import annotations

import os
import re
import sqlite3
import uuid
from pathlib import Path

from .types import MemoryRecord

ASCII_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+")
CJK_RUN_PATTERN = re.compile(r"[\u4e00-\u9fff]+")

RECALL_QUERY_EXPANSIONS = (
    (
        ("记得", "记住", "回忆", "想起", "以前", "之前"),
        {"记得", "记忆", "名字", "称呼", "身份", "用户"},
    ),
    (
        ("叫什么", "名字", "称呼", "我是谁", "是谁", "叫我"),
        {"名字", "称呼", "身份", "用户"},
    ),
)


def _extract_cjk_terms(text: str) -> set[str]:
    terms: set[str] = set()
    for run in CJK_RUN_PATTERN.findall(text):
        if len(run) <= 3:
            terms.add(run)

        for size in (2, 3):
            if len(run) < size:
                continue

            for index in range(len(run) - size + 1):
                terms.add(run[index : index + size])

    return terms


def _extract_search_terms(text: str) -> set[str]:
    lowered = text.lower()
    return set(ASCII_TOKEN_PATTERN.findall(lowered)) | _extract_cjk_terms(text)


def _expand_query_terms(query: str) -> set[str]:
    terms = _extract_search_terms(query)
    for triggers, expansions in RECALL_QUERY_EXPANSIONS:
        if any(trigger in query for trigger in triggers):
            terms.update(expansions)

    return terms


def _build_keywords(content: str) -> str:
    return " ".join(sorted(_extract_search_terms(content)))


def _build_match_query(query: str) -> str | None:
    terms = sorted(term for term in _expand_query_terms(query) if term)
    if not terms:
        return None

    return " OR ".join(f'"{term.replace("\"", "\"\"")}"' for term in terms)


class OmniMemStore:
    def __init__(self, db_path: str | None = None) -> None:
        if db_path is None:
            if os.environ.get("QUILIN_ENV") == "test":
                db_path = ":memory:"
            else:
                db_path = os.environ.get(
                    "OMNIMEM_DB_PATH",
                    str(Path.home() / ".quilin" / "memory.db"),
                )

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
        self._conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
                id UNINDEXED,
                content,
                keywords,
                tokenize = 'unicode61'
            )
            """
        )
        self._rebuild_fts_index()
        self._conn.commit()

    def reset(self) -> None:
        self._conn.execute("DELETE FROM memory_records")
        self._conn.execute("DELETE FROM memory_records_fts")
        self._conn.commit()

    async def recall(self, query: str) -> list[MemoryRecord]:
        if not query:
            rows = self._conn.execute(
                "SELECT id, content, tier FROM memory_records ORDER BY rowid ASC"
            ).fetchall()
        else:
            rows = self._recall_with_fts(query)
            if not rows:
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
        self._conn.execute(
            """
            INSERT INTO memory_records_fts (id, content, keywords)
            VALUES (?, ?, ?)
            """,
            (record.id, record.content, _build_keywords(record.content)),
        )
        self._conn.commit()
        return record

    def _rebuild_fts_index(self) -> None:
        self._conn.execute("DELETE FROM memory_records_fts")
        self._conn.execute(
            """
            INSERT INTO memory_records_fts (id, content, keywords)
            SELECT id, content, ''
            FROM memory_records
            """
        )
        rows = self._conn.execute(
            "SELECT id, content FROM memory_records ORDER BY rowid ASC"
        ).fetchall()
        for row in rows:
            self._conn.execute(
                """
                UPDATE memory_records_fts
                SET keywords = ?
                WHERE id = ?
                """,
                (_build_keywords(row["content"]), row["id"]),
            )

    def _recall_with_fts(self, query: str) -> list[sqlite3.Row]:
        match_query = _build_match_query(query)
        if match_query is None:
            return []

        return self._conn.execute(
            """
            SELECT mr.id, mr.content, mr.tier
            FROM memory_records_fts fts
            JOIN memory_records mr ON mr.id = fts.id
            WHERE memory_records_fts MATCH ?
            ORDER BY bm25(memory_records_fts), mr.rowid ASC
            """,
            (match_query,),
        ).fetchall()
