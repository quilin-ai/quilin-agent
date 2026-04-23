from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import uuid4

IdleBudgetDecision = Literal["lease", "denied"]
IDLE_EVOLUTION_DEFERRED_REASON = "idle_evolution_disabled_until_iter_f"
DEFAULT_IDLE_LEASE_TTL_SECONDS = 300


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True, frozen=True)
class IdleBudgetDenied:
    task: str
    estimated_tokens: int
    reason: str = IDLE_EVOLUTION_DEFERRED_REASON
    decision: Literal["denied"] = "denied"

    @property
    def granted(self) -> bool:
        return False


@dataclass(slots=True, frozen=True)
class IdleBudgetLease:
    task: str
    estimated_tokens: int
    lease_id: str
    granted_tokens: int
    expires_at: datetime
    decision: Literal["lease"] = "lease"

    @property
    def granted(self) -> bool:
        return True


IdleBudgetResult = IdleBudgetLease | IdleBudgetDenied


class IdleBudgetProvider:
    def __init__(
        self,
        *,
        enabled: bool = False,
        token_budget: int = 0,
        lease_ttl_seconds: int = DEFAULT_IDLE_LEASE_TTL_SECONDS,
        clock: Callable[[], datetime] = _utcnow,
    ) -> None:
        if token_budget < 0:
            raise ValueError("token_budget must be non-negative")
        if lease_ttl_seconds < 1:
            raise ValueError("lease_ttl_seconds must be positive")

        self._enabled = enabled
        self._token_budget = token_budget
        self._lease_ttl_seconds = lease_ttl_seconds
        self._clock = clock

    def acquire(self, task: str, estimated_tokens: int) -> IdleBudgetResult:
        if not task.strip():
            raise ValueError("task must not be empty")
        if estimated_tokens < 0:
            raise ValueError("estimated_tokens must be non-negative")

        if not self._enabled:
            return IdleBudgetDenied(task=task, estimated_tokens=estimated_tokens)
        if estimated_tokens > self._token_budget:
            return IdleBudgetDenied(
                task=task,
                estimated_tokens=estimated_tokens,
                reason="estimated_tokens_exceed_stub_budget",
            )

        now = self._clock()
        return IdleBudgetLease(
            task=task,
            estimated_tokens=estimated_tokens,
            lease_id=str(uuid4()),
            granted_tokens=estimated_tokens,
            expires_at=now + timedelta(seconds=self._lease_ttl_seconds),
        )


_DEFAULT_PROVIDER = IdleBudgetProvider()


def acquire(task: str, estimated_tokens: int) -> IdleBudgetResult:
    return _DEFAULT_PROVIDER.acquire(task, estimated_tokens)


__all__ = [
    "DEFAULT_IDLE_LEASE_TTL_SECONDS",
    "IDLE_EVOLUTION_DEFERRED_REASON",
    "IdleBudgetDecision",
    "IdleBudgetDenied",
    "IdleBudgetLease",
    "IdleBudgetProvider",
    "IdleBudgetResult",
    "acquire",
]
