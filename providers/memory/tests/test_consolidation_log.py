"""Tests for `consolidation_log` — UX-4 Slice 4 unblocker.

Hermetic: uses `:memory:` SQLite via the QUILIN_ENV=test default-path
shortcut + explicit constructor path. No real consolidation orchestration
— the log store is a thin persistence layer with its own contract.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from quilin_mem.consolidation_log import (
    CONSOLIDATION_LOG_SCHEMA_VERSION,
    ConsolidationLogStore,
)
from quilin_mem.consolidator import ConsolidationProposal, Consolidator
from quilin_mem.idle_budget import IdleBudgetLease, IdleBudgetProvider
from quilin_mem.reflector import ReflectionProposal
from quilin_mem.server import _memory_consolidate_plan_with_store, create_server
from quilin_mem.store import QuilinMemStore


def _decode_call_tool_result(result: object) -> dict[str, object]:
    if hasattr(result, "root"):
        content_items = getattr(result.root, "content", [])  # type: ignore[attr-defined]
        text = "\n".join(
            item.text for item in content_items if getattr(item, "type", None) == "text"
        )
        return json.loads(text)

    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


def test_append_and_list_round_trips_proposal_shape(tmp_path: Path) -> None:
    """One propose() → one log entry with all fields preserved."""
    store = ConsolidationLogStore(str(tmp_path / "log.db"))
    try:
        consolidator = Consolidator(IdleBudgetProvider(), log_store=store)
        proposal = consolidator.propose(task="test.task.alpha")

        entries = store.list_recent(limit=10)
        assert len(entries) == 1
        entry = entries[0]
        assert entry.task == "test.task.alpha"
        assert entry.dry_run is True  # propose() always emits dry_run=True
        assert entry.budget_decision == proposal.budget.decision
        # QUI-202: placeholder reflect / kg-prune actions are not logged.
        # Only concrete dedupe or real reflector output should appear.
        assert entry.actions == []
        assert entry.writes_performed == 0
        assert entry.schema_version == CONSOLIDATION_LOG_SCHEMA_VERSION
        assert entry.id > 0
    finally:
        store.close()


async def test_user_triggered_consolidate_plan_persists_log_row(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """MCP preview path should write the same durable log dogfood reads."""

    db_path = str(tmp_path / "memory.db")
    monkeypatch.setenv("QUILIN_MEM_DB_PATH", db_path)

    async with QuilinMemStore(db_path=db_path) as memory_store:
        await _memory_consolidate_plan_with_store(memory_store, strategy="all")

    log_store = ConsolidationLogStore(db_path)
    try:
        assert log_store.count() == 1
        [entry] = log_store.list_recent(limit=10)
        assert entry.task == "quilin_mem.memory_consolidate_plan"
    finally:
        log_store.close()


async def test_consolidate_plan_continues_when_log_store_bootstrap_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Logging is observational; bootstrap failure must not break preview."""
    from quilin_mem import server as server_module

    class BrokenLogStore:
        def __init__(self, _db_path: str | None = None) -> None:
            raise RuntimeError("log unavailable")

    monkeypatch.setattr(server_module, "ConsolidationLogStore", BrokenLogStore)
    async with QuilinMemStore(db_path=str(tmp_path / "memory.db")) as memory_store:
        raw = await _memory_consolidate_plan_with_store(memory_store, strategy="all")

    payload = json.loads(raw)
    assert payload["task"] == "quilin_mem.memory_consolidate_plan"
    assert payload["dryRun"] is True


async def test_consolidate_plan_continues_when_log_store_close_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed observational log close must not fail the preview response."""
    from quilin_mem import server as server_module

    class BrokenCloseLogStore:
        def __init__(self, _db_path: str | None = None) -> None:
            self.rows = 0

        def append(self, _proposal: object) -> int:
            self.rows += 1
            return self.rows

        def close(self) -> None:
            raise RuntimeError("close unavailable")

    monkeypatch.setattr(server_module, "ConsolidationLogStore", BrokenCloseLogStore)
    async with QuilinMemStore(db_path=str(tmp_path / "memory.db")) as memory_store:
        raw = await _memory_consolidate_plan_with_store(memory_store, strategy="all")

    payload = json.loads(raw)
    assert payload["task"] == "quilin_mem.memory_consolidate_plan"
    assert payload["dryRun"] is True


def test_reflection_proposals_are_persisted_in_log_actions(tmp_path: Path) -> None:
    """Real reflector output must not disappear from the durable log."""
    log_store = ConsolidationLogStore(str(tmp_path / "log.db"))
    try:
        budget = IdleBudgetLease(
            task="test.reflect",
            estimated_tokens=10,
            lease_id="lease-1",
            granted_tokens=10,
            expires_at=datetime.now(UTC),
        )
        proposal = ConsolidationProposal(
            task="test.reflect",
            dry_run=True,
            budget=budget,
            actions=[],
            writes_performed=0,
            created_at=datetime.now(UTC),
            strategy="reflect",
            reflections=(
                ReflectionProposal(
                    kind="reflection_insight",
                    sourceIds=["episodic-1", "episodic-2"],
                    proposedContent="User prefers concise Chinese status updates.",
                    reason="Multiple recent turns mention concise Chinese updates.",
                    confidence=0.91,
                    reflectModel="claude-sonnet-4-6",
                ),
            ),
        )

        log_store.append(proposal)
        [entry] = log_store.list_recent(limit=1)
        assert entry.actions == [
            {
                "kind": "reflect-insight",
                "target_layer": "semantic",
                "tier": "semantic",
                "deleteIds": [],
                "insertContent": "User prefers concise Chinese status updates.",
                "reason": "Multiple recent turns mention concise Chinese updates.",
                "score": 0.91,
                "memoryIds": ["episodic-1", "episodic-2"],
                "dry_run": True,
                "writes_semantic": False,
                "writes_skill": False,
                "metadata": {
                    "schema_version": 1,
                    "requires_approval": True,
                    "reflect_model": "claude-sonnet-4-6",
                },
            }
        ]
    finally:
        log_store.close()


async def test_log_recent_reads_the_same_file_backed_store(tmp_path: Path) -> None:
    """create_server(store=...) should plan and read logs from the same DB."""
    db_path = str(tmp_path / "memory.db")
    async with QuilinMemStore(db_path=db_path) as memory_store:
        server = create_server(store=memory_store)
        await server.call_tool("memory_consolidate_plan", {"strategy": "all"})  # type: ignore[attr-defined]
        raw = await server.call_tool("consolidation_log_recent", {"limit": 10})  # type: ignore[attr-defined]

    result = _decode_call_tool_result(raw)
    assert result["available"] is True
    assert result["total"] == 1
    assert result["entries"][0]["task"] == "quilin_mem.memory_consolidate_plan"


async def test_log_recent_does_not_read_default_db_for_in_memory_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Injected :memory: stores must not leak rows from QUILIN_MEM_DB_PATH."""
    default_db_path = str(tmp_path / "default-memory.db")
    monkeypatch.setenv("QUILIN_MEM_DB_PATH", default_db_path)
    with ConsolidationLogStore(default_db_path) as log_store:
        Consolidator(IdleBudgetProvider(), log_store=log_store).propose(task="unrelated.default")

    async with QuilinMemStore(db_path=":memory:") as memory_store:
        server = create_server(store=memory_store)
        raw = await server.call_tool("consolidation_log_recent", {"limit": 10})  # type: ignore[attr-defined]

    result = _decode_call_tool_result(raw)
    assert result == {"available": True, "total": 0, "entries": []}


def test_list_recent_returns_newest_first(tmp_path: Path) -> None:
    """Entries are ordered by id DESC (≈ created_at DESC for one writer)."""
    store = ConsolidationLogStore(str(tmp_path / "log.db"))
    try:
        consolidator = Consolidator(IdleBudgetProvider(), log_store=store)
        for i in range(5):
            consolidator.propose(task=f"test.task.{i}")
        entries = store.list_recent(limit=10)
        assert len(entries) == 5
        # newest first
        tasks_in_order = [e.task for e in entries]
        assert tasks_in_order == [
            "test.task.4",
            "test.task.3",
            "test.task.2",
            "test.task.1",
            "test.task.0",
        ]
    finally:
        store.close()


def test_list_recent_limit_clamps_to_bounds(tmp_path: Path) -> None:
    """Limit clamps to [1, 1000]; out-of-bounds inputs don't crash."""
    store = ConsolidationLogStore(str(tmp_path / "log.db"))
    try:
        consolidator = Consolidator(IdleBudgetProvider(), log_store=store)
        for i in range(3):
            consolidator.propose(task=f"t{i}")
        # 0 / negative clamps up to 1
        assert len(store.list_recent(limit=0)) == 1
        assert len(store.list_recent(limit=-99)) == 1
        # huge clamps down (we only have 3 anyway)
        assert len(store.list_recent(limit=999_999)) == 3
    finally:
        store.close()


def test_count_returns_total_entries(tmp_path: Path) -> None:
    store = ConsolidationLogStore(str(tmp_path / "log.db"))
    try:
        consolidator = Consolidator(IdleBudgetProvider(), log_store=store)
        assert store.count() == 0
        for _ in range(7):
            consolidator.propose()
        assert store.count() == 7
    finally:
        store.close()


def test_consolidator_without_log_store_remains_backward_compatible(tmp_path: Path) -> None:
    """Existing callers passing no log_store get the original behavior:
    propose() works, returns a proposal, persists nothing.
    """
    consolidator = Consolidator(IdleBudgetProvider())  # no log_store
    proposal = consolidator.propose()
    assert proposal.task is not None
    # No store to query — just verify nothing crashed.


def test_close_is_idempotent(tmp_path: Path) -> None:
    store = ConsolidationLogStore(str(tmp_path / "log.db"))
    store.close()
    store.close()  # second call should be a no-op, not raise


def test_context_manager_closes_on_exit(tmp_path: Path) -> None:
    db = tmp_path / "log.db"
    with ConsolidationLogStore(str(db)) as store:
        consolidator = Consolidator(IdleBudgetProvider(), log_store=store)
        consolidator.propose(task="ctx.mgr.test")
        assert store.count() == 1
    # After exit, close() should have been called — calling again is no-op.
    # A second open should reuse the persisted data (proves we really committed).
    store2 = ConsolidationLogStore(str(db))
    try:
        assert store2.count() == 1
        entries = store2.list_recent(limit=10)
        assert entries[0].task == "ctx.mgr.test"
    finally:
        store2.close()


def test_log_failure_doesnt_break_propose(tmp_path: Path) -> None:
    """If the log store raises, propose() must still return the proposal."""

    class BrokenLog:
        def append(self, _proposal: object) -> int:
            raise RuntimeError("simulated log corruption")

    # We cast through the Consolidator constructor — duck-typed.
    consolidator = Consolidator(IdleBudgetProvider(), log_store=BrokenLog())  # type: ignore[arg-type]
    proposal = consolidator.propose(task="resilience.test")
    assert proposal.task == "resilience.test"
    # No raise = success.


def test_default_db_path_honors_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_default_log_db_path` returns `:memory:` under QUILIN_ENV=test,
    QUILIN_MEM_DB_PATH override otherwise, falling back to `~/.quilin/memory.db`.
    """
    from quilin_mem.consolidation_log import _default_log_db_path

    monkeypatch.setenv("QUILIN_ENV", "test")
    monkeypatch.delenv("QUILIN_MEM_DB_PATH", raising=False)
    assert _default_log_db_path() == ":memory:"

    monkeypatch.delenv("QUILIN_ENV", raising=False)
    monkeypatch.setenv("QUILIN_MEM_DB_PATH", "/tmp/custom-memory.db")
    assert _default_log_db_path() == "/tmp/custom-memory.db"


def test_constructed_with_default_path_when_db_path_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ConsolidationLogStore(None)` resolves through `_default_log_db_path`."""
    monkeypatch.setenv("QUILIN_ENV", "test")
    store = ConsolidationLogStore()  # no db_path → :memory: via env
    try:
        # If the resolution worked, count() returns 0 on a fresh in-mem db.
        assert store.count() == 0
    finally:
        store.close()


def test_actions_metadata_serialized_correctly(tmp_path: Path) -> None:
    """Action metadata (dict) survives the JSON round-trip."""
    store = ConsolidationLogStore(str(tmp_path / "log.db"))
    try:
        consolidator = Consolidator(IdleBudgetProvider(), log_store=store)
        consolidator.propose(task="meta.test")
        entry = store.list_recent(limit=1)[0]
        # Each action carries the standard metadata dict from _proposal_actions.
        for action in entry.actions:
            assert "metadata" in action
            assert isinstance(action["metadata"], dict)
            assert "schema_version" in action["metadata"]
            assert action["metadata"]["schema_version"] == 1
    finally:
        store.close()
