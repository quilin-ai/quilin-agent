from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

from .idle_budget import IdleBudgetProvider, IdleBudgetResult

ConsolidationActionKind = Literal["reflect", "prune_kg", "recompress_verbatim"]
CONSOLIDATOR_SCHEMA_VERSION = 1
DEFAULT_CONSOLIDATION_TASK = "quilin_mem.consolidator.propose"


def _utcnow() -> datetime:
    return datetime.now(UTC)


_CONSOLIDATION_PRIOR_MAP: dict[tuple[ConsolidationActionKind, str], dict[str, float]] = {
    ("reflect", "semantic"): {"kg_subgraph": +0.08, "direct_recall": -0.05},
    ("reflect", "skill"): {"hybrid_rrf": +0.06, "vector_semantic": +0.04},
    ("prune_kg", "episodic"): {"direct_recall": +0.05, "kg_subgraph": -0.06},
    ("recompress_verbatim", "episodic"): {"bm25_fts": +0.06, "working_direct": -0.04},
}


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


@dataclass(slots=True, frozen=True)
class RecallWeightsUpdate:
    source_prior_key: str
    prior_delta: float
    reason: str


class Consolidator:
    def __init__(
        self,
        budget_provider: IdleBudgetProvider | None = None,
        *,
        reranker: object | None = None,
    ) -> None:
        self._budget_provider = budget_provider or IdleBudgetProvider()
        self._reranker = reranker
        self._last_consolidation: datetime | None = None
        self._consolidation_count = 0

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

    def auto_schedule(
        self,
        *,
        interval_hours: int = 24,
        now: datetime | None = None,
    ) -> ConsolidationProposal | None:
        current_time = now or _utcnow()

        if self._last_consolidation is not None:
            elapsed = current_time - self._last_consolidation
            if elapsed < timedelta(hours=interval_hours):
                return None

        proposal = self.propose(
            task=f"{DEFAULT_CONSOLIDATION_TASK}.auto",
            now=current_time,
        )

        object.__setattr__(self, "_last_consolidation", current_time)
        object.__setattr__(self, "_consolidation_count", self._consolidation_count + 1)

        self._update_recall_weights(proposal)

        return proposal

    def _update_recall_weights(
        self,
        proposal: ConsolidationProposal,
    ) -> list[RecallWeightsUpdate]:
        budget_granted = proposal.budget.granted
        scaling = 1.0 if budget_granted else 0.3

        updates: list[RecallWeightsUpdate] = []
        for action in proposal.actions:
            action_deltas = _CONSOLIDATION_PRIOR_MAP.get(
                (action.kind, action.target_layer)
            )
            if action_deltas is None:
                continue

            for source_key, raw_delta in action_deltas.items():
                scaled_delta = round(raw_delta * scaling, 4)
                updates.append(
                    RecallWeightsUpdate(
                        source_prior_key=source_key,
                        prior_delta=scaled_delta,
                        reason=(
                            f"consolidation action '{action.kind}' "
                            f"targeting '{action.target_layer}' layer"
                        ),
                    )
                )

        self._apply_recall_priors(updates)
        return updates

    def _apply_recall_priors(self, updates: list[RecallWeightsUpdate]) -> None:
        if self._reranker is None:
            return

        source_priors: dict[str, float] | None = getattr(
            self._reranker, "_source_priors", None
        )
        if not isinstance(source_priors, dict):
            return

        for update in updates:
            key = update.source_prior_key
            current = source_priors.get(key, 0.2)
            adjusted = max(0.05, min(0.95, round(current + update.prior_delta, 4)))
            source_priors[key] = adjusted


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
    "RecallWeightsUpdate",
    "propose",
]
