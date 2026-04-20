from __future__ import annotations

import asyncio
import os
import re
import sqlite3
import threading
import uuid
from pathlib import Path

from .types import MemoryRecord, MemoryTier, VALID_MEMORY_TIERS

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
FTS_SCHEMA_COMPONENT = "memory_records_fts"
FTS_SCHEMA_VERSION = 1


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


def _validate_memory_tier(tier: str) -> MemoryTier:
    if tier not in VALID_MEMORY_TIERS:
        valid_tiers = ", ".join(VALID_MEMORY_TIERS)
        raise ValueError(f"Invalid memory tier: {tier}. Expected one of: {valid_tiers}")

    return tier


def _row_to_record(row: sqlite3.Row) -> MemoryRecord:
    return MemoryRecord(
        id=row["id"],
        content=row["content"],
        tier=_validate_memory_tier(row["tier"]),
    )


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

        self._conn = sqlite3.connect(
            db_path,
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._closed = False
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_records (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tier TEXT NOT NULL CHECK (
                    tier IN ('working', 'episodic', 'semantic', 'skill')
                )
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
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_version (
                component TEXT PRIMARY KEY,
                version INTEGER NOT NULL
            )
            """
        )
        self._ensure_fts_schema()
        self._conn.commit()

    async def __aenter__(self) -> OmniMemStore:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()

    async def reset(self) -> None:
        await asyncio.to_thread(self._reset_sync)

    def _reset_sync(self) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute("DELETE FROM memory_records")
                self._conn.execute("DELETE FROM memory_records_fts")

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        if self._closed:
            return

        with self._lock:
            self._conn.commit()
            self._conn.close()
            self._closed = True

    async def recall(self, query: str) -> list[MemoryRecord]:
        return await asyncio.to_thread(self._recall_sync, query)

    def _recall_sync(self, query: str) -> list[MemoryRecord]:
        with self._lock:
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

        return [_row_to_record(row) for row in rows]

    async def store(
        self,
        content: str,
        tier: MemoryTier = "working",
    ) -> MemoryRecord:
        return await asyncio.to_thread(self._store_sync, content, tier)

    def _store_sync(
        self,
        content: str,
        tier: MemoryTier = "working",
    ) -> MemoryRecord:
        record = MemoryRecord(
            id=str(uuid.uuid4()),
            content=content,
            tier=_validate_memory_tier(tier),
        )
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
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

    def _ensure_fts_schema(self) -> None:
        if self._get_schema_version(FTS_SCHEMA_COMPONENT) >= FTS_SCHEMA_VERSION:
            return

        self._rebuild_fts_index()
        self._conn.execute(
            """
            INSERT INTO schema_version (component, version)
            VALUES (?, ?)
            ON CONFLICT(component) DO UPDATE SET version = excluded.version
            """,
            (FTS_SCHEMA_COMPONENT, FTS_SCHEMA_VERSION),
        )

    def _get_schema_version(self, component: str) -> int:
        row = self._conn.execute(
            "SELECT version FROM schema_version WHERE component = ?",
            (component,),
        ).fetchone()
        if row is None:
            return 0

        return int(row["version"])

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
