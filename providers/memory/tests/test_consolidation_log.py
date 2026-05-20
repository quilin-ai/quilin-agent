"""Tests for `consolidation_log` — UX-4 Slice 4 unblocker.

Hermetic: uses `:memory:` SQLite via the QUILIN_ENV=test default-path
shortcut + explicit constructor path. No real consolidation orchestration
— the log store is a thin persistence layer with its own contract.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from quilin_mem.consolidation_log import (
    CONSOLIDATION_LOG_SCHEMA_VERSION,
    ConsolidationLogStore,
)
from quilin_mem.consolidator import Consolidator
from quilin_mem.idle_budget import IdleBudgetProvider


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
        # QUI-187 cross-review Reviewer F REAL (2026-05-20):recompress_verbatim
        # placeholder 已从 _proposal_actions 移除(避免经 to_wire_dict 默认 fallback
        # 错标 kind="reflect-insight",docs/03-memory line 274 verbatim 差分再压缩
        # 仍在 Literal union 中等真实实现)。
        assert len(entry.actions) == 2
        assert {a["kind"] for a in entry.actions} == {
            "reflect",
            "prune_kg",
        }
        assert entry.writes_performed == 0
        assert entry.schema_version == CONSOLIDATION_LOG_SCHEMA_VERSION
        assert entry.id > 0
    finally:
        store.close()


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
