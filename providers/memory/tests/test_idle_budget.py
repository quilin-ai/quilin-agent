from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from omnimem.idle_budget import (
    DEFAULT_IDLE_LEASE_TTL_SECONDS,
    IDLE_EVOLUTION_DEFERRED_REASON,
    IdleBudgetDenied,
    IdleBudgetLease,
    IdleBudgetProvider,
    acquire,
)


def test_default_acquire_denies_idle_evolution_until_iter_f() -> None:
    result = acquire("memory-consolidation", 128)

    assert isinstance(result, IdleBudgetDenied)
    assert result.decision == "denied"
    assert result.granted is False
    assert result.task == "memory-consolidation"
    assert result.estimated_tokens == 128
    assert result.reason == IDLE_EVOLUTION_DEFERRED_REASON


def test_provider_can_return_stub_lease_when_explicitly_enabled() -> None:
    now = datetime(2026, 4, 24, tzinfo=UTC)
    provider = IdleBudgetProvider(enabled=True, token_budget=1_000, clock=lambda: now)

    result = provider.acquire("dry-run-proposal", 250)

    assert isinstance(result, IdleBudgetLease)
    assert result.decision == "lease"
    assert result.granted is True
    assert result.task == "dry-run-proposal"
    assert result.estimated_tokens == 250
    assert result.granted_tokens == 250
    assert result.expires_at == now + timedelta(seconds=DEFAULT_IDLE_LEASE_TTL_SECONDS)
    assert result.lease_id


def test_provider_denies_when_stub_budget_is_exceeded() -> None:
    provider = IdleBudgetProvider(enabled=True, token_budget=100)

    result = provider.acquire("oversized", 101)

    assert isinstance(result, IdleBudgetDenied)
    assert result.reason == "estimated_tokens_exceed_stub_budget"


@pytest.mark.parametrize(
    "task, estimated_tokens",
    [
        ("", 1),
        ("   ", 1),
        ("task", -1),
    ],
)
def test_provider_rejects_invalid_acquire_inputs(task: str, estimated_tokens: int) -> None:
    with pytest.raises(ValueError):
        IdleBudgetProvider().acquire(task, estimated_tokens)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"token_budget": -1},
        {"lease_ttl_seconds": 0},
    ],
)
def test_provider_rejects_invalid_configuration(kwargs: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        IdleBudgetProvider(**kwargs)
