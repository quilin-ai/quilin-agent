"""Persistent log of Consolidator proposals — UX-4 Slice 4 unblocker.

The in-memory `Consolidator` produces `ConsolidationProposal`s but
keeps no durable record. This module adds a thin SQLite-backed log
so the web /memory page can surface "what has the agent been
consolidating lately" without needing to live-monitor the consolidator
process.

Designed to be optional: `Consolidator` takes an
`Optional[ConsolidationLogStore]`. Tests + headless integration
runs pass `None` to keep behavior unchanged from before this commit.

Schema kept dead-simple: one row per proposal, actions JSON-encoded
in a single column. The log is read-only from the web side; the only
mutator is `append()`, called from `Consolidator.propose`.

UX-4 Slice 4 unblocker:给 Consolidator 加一张 SQLite 历史表,让
/memory 页面能展示"agent 最近在整理什么"。表 schema 极简,actions 用
JSON 列存,web 侧只读。

Concurrency: same WAL + busy_timeout pattern the rest of quilin-mem
uses. The Consolidator is the only writer; the MCP/web read tools
only do SELECTs.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # avoid circular at runtime (consolidator imports nothing from here)
    from .consolidator import ConsolidationProposal


CONSOLIDATION_LOG_SCHEMA_VERSION = 1
_BUSY_TIMEOUT_MS = 5000


def _default_log_db_path() -> str:
    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"
    return os.environ.get("QUILIN_MEM_DB_PATH", str(Path.home() / ".quilin" / "memory.db"))


@dataclass(frozen=True, slots=True)
class ConsolidationLogEntry:
    """One persisted proposal — flat shape for serialization to UI."""

    id: int
    task: str
    dry_run: bool
    budget_decision: str
    actions: list[dict[str, object]]
    writes_performed: int
    created_at: datetime
    schema_version: int


class ConsolidationLogStore:
    """SQLite-backed append-only log of consolidation proposals.

    Single-writer expected (the Consolidator). Multiple readers OK
    thanks to WAL. The class is NOT thread-safe for write contention
    BUT the connection itself uses a Lock + WAL, so concurrent calls
    serialize correctly.
    """

    def __init__(self, db_path: str | None = None) -> None:
        resolved = db_path if db_path is not None else _default_log_db_path()
        if resolved != ":memory:":
            Path(resolved).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            resolved,
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._closed = False
        self._conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._ensure_schema()

    def __enter__(self) -> ConsolidationLogStore:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    @contextmanager
    def _txn(self) -> Iterator[None]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def close(self) -> None:
        if self._closed:
            return
        with self._lock:
            self._conn.commit()
            self._conn.close()
            self._closed = True

    def append(self, proposal: ConsolidationProposal) -> int:
        """Persist one proposal. Returns its rowid."""
        actions_json = json.dumps(
            [
                {
                    "kind": a.kind,
                    "target_layer": a.target_layer,
                    "reason": a.reason,
                    "dry_run": a.dry_run,
                    "writes_semantic": a.writes_semantic,
                    "writes_skill": a.writes_skill,
                    "metadata": a.metadata,
                }
                for a in proposal.actions
            ]
        )
        with self._txn():
            cursor = self._conn.execute(
                """
                INSERT INTO consolidation_log (
                    task, dry_run, budget_decision, actions_json,
                    writes_performed, created_at, schema_version
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    proposal.task,
                    1 if proposal.dry_run else 0,
                    proposal.budget.decision,
                    actions_json,
                    proposal.writes_performed,
                    proposal.created_at.isoformat(),
                    proposal.schema_version,
                ),
            )
            return int(cursor.lastrowid or 0)

    def list_recent(self, limit: int = 100) -> list[ConsolidationLogEntry]:
        """Return up to `limit` most-recent entries, newest first.

        Clamped to [1, 1000] to bound memory cost of one read.
        """
        effective_limit = max(1, min(int(limit), 1000))
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, task, dry_run, budget_decision, actions_json,
                       writes_performed, created_at, schema_version
                FROM consolidation_log
                ORDER BY id DESC
                LIMIT ?
                """,
                (effective_limit,),
            ).fetchall()
        return [_row_to_entry(row) for row in rows]

    def count(self) -> int:
        """Total log entries — cheap COUNT(*) for UI badging."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM consolidation_log"
            ).fetchone()
        return int(row["n"]) if row is not None else 0

    def _ensure_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS consolidation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task TEXT NOT NULL,
                    dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
                    budget_decision TEXT NOT NULL,
                    actions_json TEXT NOT NULL,
                    writes_performed INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    schema_version INTEGER NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_consolidation_log_created_at
                ON consolidation_log(created_at DESC)
                """
            )


def _row_to_entry(row: sqlite3.Row) -> ConsolidationLogEntry:
    return ConsolidationLogEntry(
        id=int(row["id"]),
        task=str(row["task"]),
        dry_run=bool(row["dry_run"]),
        budget_decision=str(row["budget_decision"]),
        actions=json.loads(str(row["actions_json"])),
        writes_performed=int(row["writes_performed"]),
        created_at=datetime.fromisoformat(str(row["created_at"])),
        schema_version=int(row["schema_version"]),
    )


__all__ = [
    "CONSOLIDATION_LOG_SCHEMA_VERSION",
    "ConsolidationLogEntry",
    "ConsolidationLogStore",
]
