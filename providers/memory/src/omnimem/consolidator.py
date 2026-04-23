from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from .idle_budget import IdleBudgetProvider, IdleBudgetResult

ConsolidationActionKind = Literal["reflect", "prune_kg", "recompress_verbatim"]
CONSOLIDATOR_SCHEMA_VERSION = 1
DEFAULT_CONSOLIDATION_TASK = "omnimem.consolidator.propose"


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True, frozen=True)
class ConsolidationAction:
    kind: ConsolidationActionKind
    target_layer: Literal["episodic", "semantic", "skill"]
    reason: str
    dry_run: bool = True
    writes_semantic: bool = False
    writes_skill: bool = False
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class ConsolidationProposal:
    task: str
    dry_run: bool
    budget: IdleBudgetResult
    actions: list[ConsolidationAction]
    writes_performed: int
    created_at: datetime
    schema_version: int = CONSOLIDATOR_SCHEMA_VERSION


class Consolidator:
    def __init__(
        self,
        budget_provider: IdleBudgetProvider | None = None,
    ) -> None:
        self._budget_provider = budget_provider or IdleBudgetProvider()

    def propose(
        self,
        *,
        task: str = DEFAULT_CONSOLIDATION_TASK,
        estimated_tokens: int = 0,
        now: datetime | None = None,
    ) -> ConsolidationProposal:
        budget = self._budget_provider.acquire(task, estimated_tokens)
        return ConsolidationProposal(
            task=task,
            dry_run=True,
            budget=budget,
            actions=self._proposal_actions(budget),
            writes_performed=0,
            created_at=now or _utcnow(),
        )

    def _proposal_actions(self, budget: IdleBudgetResult) -> list[ConsolidationAction]:
        blocked = budget.decision == "denied"
        metadata: dict[str, object] = {
            "schema_version": CONSOLIDATOR_SCHEMA_VERSION,
            "budget_decision": budget.decision,
        }
        if blocked:
            metadata["blocked_reason"] = budget.reason

        return [
            ConsolidationAction(
                kind="reflect",
                target_layer="semantic",
                reason="propose stable episodic reflections for future WriteAuthority review",
                metadata=dict(metadata),
            ),
            ConsolidationAction(
                kind="prune_kg",
                target_layer="episodic",
                reason="propose stale temporal edge cleanup without mutating the graph",
                metadata=dict(metadata),
            ),
            ConsolidationAction(
                kind="recompress_verbatim",
                target_layer="episodic",
                reason="propose cold verbatim memory recompression without touching storage",
                metadata=dict(metadata),
            ),
        ]


def propose(
    *,
    task: str = DEFAULT_CONSOLIDATION_TASK,
    estimated_tokens: int = 0,
) -> ConsolidationProposal:
    return Consolidator().propose(task=task, estimated_tokens=estimated_tokens)


__all__ = [
    "CONSOLIDATOR_SCHEMA_VERSION",
    "DEFAULT_CONSOLIDATION_TASK",
    "ConsolidationAction",
    "ConsolidationActionKind",
    "ConsolidationProposal",
    "Consolidator",
    "propose",
]
