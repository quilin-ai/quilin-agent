from __future__ import annotations

from datetime import UTC, datetime

from quilin_mem.consolidator import (
    CONSOLIDATOR_SCHEMA_VERSION,
    DEFAULT_CONSOLIDATION_TASK,
    Consolidator,
    propose,
)
from quilin_mem.idle_budget import IdleBudgetLease, IdleBudgetProvider


def test_default_consolidator_proposes_dry_run_actions_without_writes() -> None:
    now = datetime(2026, 4, 24, tzinfo=UTC)
    proposal = Consolidator().propose(now=now)

    assert proposal.schema_version == CONSOLIDATOR_SCHEMA_VERSION
    assert proposal.task == DEFAULT_CONSOLIDATION_TASK
    assert proposal.created_at == now
    assert proposal.dry_run is True
    assert proposal.budget.decision == "denied"
    assert proposal.writes_performed == 0
    assert [action.kind for action in proposal.actions] == [
        "reflect",
        "prune_kg",
        "recompress_verbatim",
    ]
    assert all(action.dry_run for action in proposal.actions)
    assert all(not action.writes_semantic for action in proposal.actions)
    assert all(not action.writes_skill for action in proposal.actions)


def test_default_propose_function_is_also_noop_dry_run() -> None:
    proposal = propose(estimated_tokens=64)

    assert proposal.dry_run is True
    assert proposal.budget.decision == "denied"
    assert proposal.writes_performed == 0


def test_consolidator_surfaces_lease_without_enabling_writes() -> None:
    budget = IdleBudgetProvider(enabled=True, token_budget=1_000)

    proposal = Consolidator(budget).propose(task="manual-dry-run", estimated_tokens=100)

    assert isinstance(proposal.budget, IdleBudgetLease)
    assert proposal.budget.decision == "lease"
    assert proposal.dry_run is True
    assert proposal.writes_performed == 0
    assert all(action.metadata["budget_decision"] == "lease" for action in proposal.actions)
    assert all(not action.writes_semantic for action in proposal.actions)
    assert all(not action.writes_skill for action in proposal.actions)


def test_denied_budget_reason_is_carried_into_action_metadata() -> None:
    proposal = Consolidator().propose(task="idle-loop", estimated_tokens=500)

    assert proposal.budget.decision == "denied"
    assert all(action.metadata["budget_decision"] == "denied" for action in proposal.actions)
    assert all("blocked_reason" in action.metadata for action in proposal.actions)


def test_consolidator_has_no_non_dry_run_constructor_switch() -> None:
    proposal = Consolidator().propose()

    assert proposal.dry_run is True
    assert proposal.writes_performed == 0
