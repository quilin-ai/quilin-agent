from __future__ import annotations

import contextlib
from datetime import UTC, datetime, timedelta

from quilin_mem.consolidator import (
    CONSOLIDATOR_SCHEMA_VERSION,
    DEFAULT_CONSOLIDATION_TASK,
    ConsolidationAction,
    ConsolidationProposal,
    Consolidator,
    RecallWeightsUpdate,
    propose,
)
from quilin_mem.idle_budget import (
    IdleBudgetDenied,
    IdleBudgetLease,
    IdleBudgetProvider,
)
from quilin_mem.reranker import LearnableReranker


def test_default_consolidator_proposes_dry_run_actions_without_writes() -> None:
    now = datetime(2026, 4, 24, tzinfo=UTC)
    proposal = Consolidator().propose(now=now)

    assert proposal.schema_version == CONSOLIDATOR_SCHEMA_VERSION
    assert proposal.task == DEFAULT_CONSOLIDATION_TASK
    assert proposal.created_at == now
    assert proposal.dry_run is True
    assert proposal.budget.decision == "denied"
    assert proposal.writes_performed == 0
    # QUI-187 cross-review Reviewer F REAL (2026-05-20):recompress_verbatim
    # placeholder 已从 _proposal_actions 移除(它经 to_wire_dict 默认 fallback
    # 错标 kind="reflect-insight" 导致 UI 误导)。docs/03-memory line 274 设计的
    # verbatim 差分再压缩仍在 ConsolidationActionKind Literal union 中,等真实
    # 实现路径接入时再恢复此 placeholder action。
    assert [action.kind for action in proposal.actions] == [
        "reflect",
        "prune_kg",
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


# ---------------------------------------------------------------------------
# auto_schedule
# ---------------------------------------------------------------------------


def test_auto_schedule_runs_on_first_call_and_returns_proposal() -> None:
    now = datetime(2026, 5, 1, tzinfo=UTC)
    c = Consolidator()

    result = c.auto_schedule(interval_hours=6, now=now)

    assert result is not None
    assert result.task == f"{DEFAULT_CONSOLIDATION_TASK}.auto"
    assert result.created_at == now
    assert result.dry_run is True


def test_auto_schedule_skips_when_interval_not_elapsed() -> None:
    now = datetime(2026, 5, 1, 0, 0, 0, tzinfo=UTC)
    c = Consolidator()

    c.auto_schedule(interval_hours=6, now=now)

    too_soon = now + timedelta(hours=2)
    result = c.auto_schedule(interval_hours=6, now=too_soon)

    assert result is None


def test_auto_schedule_runs_again_after_interval_elapses() -> None:
    now = datetime(2026, 5, 1, 0, 0, 0, tzinfo=UTC)
    c = Consolidator()

    c.auto_schedule(interval_hours=6, now=now)

    later = now + timedelta(hours=7)
    result = c.auto_schedule(interval_hours=6, now=later)

    assert result is not None
    assert result.created_at == later


def test_auto_schedule_increments_consolidation_count() -> None:
    now = datetime(2026, 5, 1, tzinfo=UTC)
    c = Consolidator()

    assert c._consolidation_count == 0

    c.auto_schedule(interval_hours=1, now=now)
    assert c._consolidation_count == 1

    later = now + timedelta(hours=2)
    c.auto_schedule(interval_hours=1, now=later)
    assert c._consolidation_count == 2


def test_auto_schedule_calls_update_recall_weights_when_budget_denied() -> None:
    now = datetime(2026, 5, 1, tzinfo=UTC)
    c = Consolidator()

    proposal = c.auto_schedule(interval_hours=1, now=now)
    assert proposal is not None

    # Budget denied => scaling factor 0.3
    updates = c._update_recall_weights(proposal)
    assert len(updates) > 0
    for update in updates:
        assert isinstance(update, RecallWeightsUpdate)
        assert isinstance(update.source_prior_key, str)
        assert isinstance(update.prior_delta, float)
        assert isinstance(update.reason, str)


def test_auto_schedule_calls_update_recall_weights_when_budget_granted() -> None:
    now = datetime(2026, 5, 1, tzinfo=UTC)
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)
    c = Consolidator(budget)

    proposal = c.auto_schedule(interval_hours=1, now=now)
    assert proposal is not None
    assert proposal.budget.granted is True

    updates = c._update_recall_weights(proposal)
    assert len(updates) > 0


# ---------------------------------------------------------------------------
# _update_recall_weights
# ---------------------------------------------------------------------------


def test_update_recall_weights_produces_expected_deltas_per_action() -> None:
    c = Consolidator()

    proposal = c.propose(task="test", now=datetime(2026, 5, 1, tzinfo=UTC))
    updates = c._update_recall_weights(proposal)

    # Verify all consolidation actions map to weight updates
    # QUI-187 Reviewer F REAL fix: recompress_verbatim placeholder 已移除
    action_kinds = {action.kind for action in proposal.actions}
    assert action_kinds == {"reflect", "prune_kg"}

    updated_keys = {update.source_prior_key for update in updates}
    assert "kg_subgraph" in updated_keys
    assert "direct_recall" in updated_keys
    # QUI-187 Reviewer F REAL fix:bm25_fts 是 recompress_verbatim placeholder 对应
    # 的 weight update key,我已移除 placeholder,此 key 不再产生。
    assert "bm25_fts" not in updated_keys

    # Each update has valid prior_delta (non-zero)
    for update in updates:
        assert update.prior_delta != 0.0


def test_update_recall_weights_scales_down_when_budget_denied() -> None:
    c = Consolidator()

    proposal = c.propose(task="test", now=datetime(2026, 5, 1, tzinfo=UTC))
    assert proposal.budget.granted is False

    updates = c._update_recall_weights(proposal)

    for update in updates:
        # All deltas should be <= 0.03 (0.3x scaling of max 0.08)
        assert abs(update.prior_delta) <= 0.03


def test_update_recall_weights_full_scale_when_budget_granted() -> None:
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)
    c = Consolidator(budget)

    proposal = c.propose(task="test", estimated_tokens=100, now=datetime(2026, 5, 1, tzinfo=UTC))
    assert proposal.budget.granted is True

    updates = c._update_recall_weights(proposal)

    for update in updates:
        # Full scale: deltas should be raw values from _CONSOLIDATION_PRIOR_MAP
        # Smallest raw value is 0.04 (vector_semantic, working_direct)
        assert abs(update.prior_delta) >= 0.04


def test_update_recall_weights_each_update_has_reason() -> None:
    c = Consolidator()

    proposal = c.propose(task="test", now=datetime(2026, 5, 1, tzinfo=UTC))
    updates = c._update_recall_weights(proposal)

    for update in updates:
        assert len(update.reason) > 0
        assert "consolidation action" in update.reason


# ---------------------------------------------------------------------------
# _apply_recall_priors / reranker integration
# ---------------------------------------------------------------------------


def test_update_recall_weights_applies_priors_to_reranker() -> None:
    reranker = LearnableReranker()
    original_priors = dict(reranker._source_priors)

    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)
    c = Consolidator(budget, reranker=reranker)

    proposal = c.propose(task="test", estimated_tokens=100, now=datetime(2026, 5, 1, tzinfo=UTC))
    c._update_recall_weights(proposal)

    # Verify at least one source prior changed
    any_changed = any(
        reranker._source_priors.get(key) != original_priors.get(key)
        for key in original_priors
    )
    assert any_changed


def test_update_recall_weights_noop_when_no_reranker() -> None:
    c = Consolidator()

    proposal = c.propose(task="test", now=datetime(2026, 5, 1, tzinfo=UTC))

    # Should not raise — graceful no-op when _reranker is None
    updates = c._update_recall_weights(proposal)
    assert isinstance(updates, list)
    assert len(updates) > 0


def test_update_recall_weights_prior_values_stay_in_bounds() -> None:
    reranker = LearnableReranker()
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)
    c = Consolidator(budget, reranker=reranker)

    # Run multiple consolidation cycles
    now = datetime(2026, 5, 1, tzinfo=UTC)
    for i in range(5):
        proposal = c.propose(
            task=f"test-cycle-{i}",
            estimated_tokens=100,
            now=now,
        )
        c._update_recall_weights(proposal)

    # All priors should be within [0.05, 0.95]
    for key, value in reranker._source_priors.items():
        assert 0.05 <= value <= 0.95, f"{key} = {value} is out of bounds [0.05, 0.95]"


# ---------------------------------------------------------------------------
# RecallWeightsUpdate dataclass
# ---------------------------------------------------------------------------


def test_recall_weights_update_is_immutable() -> None:
    update = RecallWeightsUpdate(
        source_prior_key="kg_subgraph",
        prior_delta=0.08,
        reason="test reason",
    )

    assert update.source_prior_key == "kg_subgraph"
    assert update.prior_delta == 0.08

    # Should be frozen (immutable)
    with contextlib.suppress(Exception):
        update.prior_delta = 0.5  # type: ignore[misc]
    assert update.prior_delta == 0.08


def test_auto_schedule_default_interval_is_24_hours() -> None:
    now = datetime(2026, 5, 1, tzinfo=UTC)
    c = Consolidator()

    # First call should run even with default interval
    proposal = c.auto_schedule(now=now)
    assert proposal is not None

    # 23h later should skip (less than 24h default)
    too_soon = now + timedelta(hours=23)
    result = c.auto_schedule(now=too_soon)
    assert result is None

    # 25h later should run
    later = now + timedelta(hours=25)
    result = c.auto_schedule(now=later)
    assert result is not None


# ---------------------------------------------------------------------------
# Branch coverage: unmapped action kind and non-dict _source_priors
# ---------------------------------------------------------------------------


def test_update_recall_weights_skips_unmapped_action_kind() -> None:
    """Cover the `continue` branch when an action's (kind, target_layer)
    is not in _CONSOLIDATION_PRIOR_MAP."""
    c = Consolidator()

    budget = IdleBudgetDenied(task="test", estimated_tokens=0)
    unmapped_action = ConsolidationAction(
        kind="reflect",
        target_layer="episodic",  # reflect+episodic is not in the prio map
        reason="unmapped reflect on episodic layer",
    )
    proposal = ConsolidationProposal(
        task="test-unmapped",
        dry_run=True,
        budget=budget,
        actions=[unmapped_action],
        writes_performed=0,
        created_at=datetime(2026, 5, 1, tzinfo=UTC),
    )

    updates = c._update_recall_weights(proposal)
    # Unmapped action produces no updates
    assert updates == []


def test_update_recall_weights_noop_when_source_priors_not_dict() -> None:
    """Cover the `not isinstance(source_priors, dict)` guard in _apply_recall_priors."""

    class RerankerWithNonDictPriors:
        _source_priors = "not_a_dict"

    reranker = RerankerWithNonDictPriors()
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)
    c = Consolidator(budget, reranker=reranker)

    proposal = c.propose(task="test", estimated_tokens=100, now=datetime(2026, 5, 1, tzinfo=UTC))

    # Should not raise — graceful no-op when _source_priors is not a dict
    updates = c._update_recall_weights(proposal)
    assert isinstance(updates, list)
    assert len(updates) > 0
