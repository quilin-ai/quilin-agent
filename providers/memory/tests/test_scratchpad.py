from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta

from quilin_mem.scratchpad import (
    DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK,
    DEFAULT_SCRATCHPAD_TTL_SEC,
    ScratchpadStore,
)


class Clock:
    def __init__(self) -> None:
        self.current = datetime(2026, 4, 25, 10, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current

    def advance(self, seconds: int) -> None:
        self.current += timedelta(seconds=seconds)


async def test_scratchpad_write_read_and_clear_key() -> None:
    store = ScratchpadStore(db_path=":memory:")

    entry = await store.write(
        task_id="task-1",
        session_id="session-1",
        key="draft",
        value="compare retrieval plans",
    )

    assert entry.ttl_sec == DEFAULT_SCRATCHPAD_TTL_SEC
    assert await store.read(task_id="task-1", session_id="session-1", key="draft") == (
        "compare retrieval plans"
    )

    cleared = await store.clear(task_id="task-1", session_id="session-1", key="draft")

    assert cleared == 1
    assert await store.read(task_id="task-1", session_id="session-1", key="draft") is None


async def test_scratchpad_expires_entries_by_ttl() -> None:
    clock = Clock()
    store = ScratchpadStore(db_path=":memory:", now=clock.now)

    await store.write(
        task_id="task-ttl",
        session_id="session-1",
        key="note",
        value="short lived",
        ttl_sec=10,
    )

    clock.advance(9)
    assert await store.read(task_id="task-ttl", session_id="session-1", key="note") == (
        "short lived"
    )

    clock.advance(1)
    assert await store.read(task_id="task-ttl", session_id="session-1", key="note") is None


async def test_scratchpad_evicts_lru_entries_per_task() -> None:
    clock = Clock()
    store = ScratchpadStore(db_path=":memory:", capacity_per_task=2, now=clock.now)

    await store.write(task_id="task-lru", session_id="session-1", key="a", value="A")
    clock.advance(1)
    await store.write(task_id="task-lru", session_id="session-1", key="b", value="B")
    clock.advance(1)
    assert await store.read(task_id="task-lru", session_id="session-1", key="a") == "A"
    clock.advance(1)
    await store.write(task_id="task-lru", session_id="session-1", key="c", value="C")

    assert await store.read(task_id="task-lru", session_id="session-1", key="a") == "A"
    assert await store.read(task_id="task-lru", session_id="session-1", key="b") is None
    assert await store.read(task_id="task-lru", session_id="session-1", key="c") == "C"


async def test_scratchpad_capacity_and_clear_are_isolated_by_task() -> None:
    store = ScratchpadStore(db_path=":memory:", capacity_per_task=1)

    await store.write(
        task_id="task-a",
        session_id="session-1",
        key="shared",
        value="value-a",
    )
    await store.write(
        task_id="task-b",
        session_id="session-1",
        key="shared",
        value="value-b",
    )

    assert await store.read(task_id="task-a", session_id="session-1", key="shared") == ("value-a")
    assert await store.read(task_id="task-b", session_id="session-1", key="shared") == ("value-b")

    cleared = await store.clear(task_id="task-a", session_id="session-1")

    assert cleared == 1
    assert await store.read(task_id="task-a", session_id="session-1", key="shared") is None
    assert await store.read(task_id="task-b", session_id="session-1", key="shared") == ("value-b")


async def test_scratchpad_uses_independent_sqlite_table(tmp_path) -> None:
    db_path = tmp_path / "scratchpad.db"
    store = ScratchpadStore(db_path=str(db_path))

    await store.write(
        task_id="task-schema",
        session_id="session-1",
        key="k",
        value="v",
    )
    await store.close()

    conn = sqlite3.connect(db_path)
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).fetchall()
    }
    columns = {row[1] for row in conn.execute("PRAGMA table_info(scratchpad_entries)").fetchall()}
    conn.close()

    assert "scratchpad_entries" in tables
    assert "memory_records" not in tables
    assert {
        "task_id",
        "session_id",
        "key",
        "value",
        "created_at",
        "ttl_sec",
    }.issubset(columns)
    assert DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK == 1024
