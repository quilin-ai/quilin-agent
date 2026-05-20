from __future__ import annotations

import inspect
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, cast

from .store import QuilinMemStore
from .types import MemoryItem

REFLECTOR_SCHEMA_VERSION = 1
DEFAULT_REFLECT_MODEL = "claude-sonnet-4-6"
REFLECT_MODEL_ENV = "QUILIN_MEM_REFLECT_MODEL"

ReflectionProposalKind = Literal["reflection_insight"]
ReflectionTrigger = Literal["task_complete", "task_fail", "discard_all", "interval_turns", "idle"]
TaskOutcome = Literal["success", "failure", "unknown"]


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _default_reflect_model() -> str:
    return os.environ.get(REFLECT_MODEL_ENV, DEFAULT_REFLECT_MODEL)


@dataclass(slots=True, frozen=True)
class ReflectorConfig:
    reflect_model: str = field(default_factory=_default_reflect_model)
    max_episodic_for_reflect: int = 10
    min_episodic_for_reflect: int = 3
    min_info_gain_score: float = 0.55


@dataclass(slots=True, frozen=True)
class InfoGainResult:
    allowed: bool
    score: float
    reason: str


@dataclass(slots=True, frozen=True)
class ReflectionProposal:
    kind: ReflectionProposalKind
    sourceIds: list[str]  # noqa: N815 - wire contract uses camelCase.
    proposedContent: str  # noqa: N815 - wire contract uses camelCase.
    reason: str
    confidence: float
    requiresApproval: bool = True  # noqa: N815 - wire contract uses camelCase.
    reflectModel: str = DEFAULT_REFLECT_MODEL  # noqa: N815 - wire contract uses camelCase.
    created_at: datetime = field(default_factory=_utcnow)
    schema_version: int = REFLECTOR_SCHEMA_VERSION


@dataclass(slots=True, frozen=True)
class ReflectionInsight:
    id: str
    content: str
    sourceIds: tuple[str, ...]  # noqa: N815 - wire contract uses camelCase.
    confidence: float
    committed_at: datetime


class ReflectionLLMCaller(Protocol):
    def __call__(
        self,
        *,
        model: str,
        episodic_summaries: list[str],
        task_outcome: TaskOutcome,
    ) -> Mapping[str, object]: ...


class WriteAuthorityGate(Protocol):
    def authorize(self, request: Mapping[str, object]) -> object: ...


_STOPWORDS = {
    "the",
    "and",
    "for",
    "that",
    "this",
    "with",
    "from",
    "task",
    "user",
    "agent",
    "memory",
    "was",
    "were",
    "are",
    "has",
    "have",
    "成功",
    "失败",
    "任务",
    "用户",
}


def _tokens(text: str) -> list[str]:
    cleaned = "".join(char.lower() if char.isalnum() else " " for char in text)
    return [token for token in cleaned.split() if len(token) >= 3 and token not in _STOPWORDS]


def _clamp_confidence(value: object, fallback: float) -> float:
    if isinstance(value, int | float):
        return max(0.0, min(1.0, float(value)))
    return fallback


def _text_value(value: object, fallback: str) -> str:
    return value if isinstance(value, str) and value.strip() else fallback


class Reflector:
    def __init__(
        self,
        config: ReflectorConfig | None = None,
        *,
        llm_caller: ReflectionLLMCaller | None = None,
    ) -> None:
        self._config = config or ReflectorConfig()
        self._llm_caller = llm_caller

    @property
    def config(self) -> ReflectorConfig:
        return self._config

    def propose(
        self,
        episodic_records: Sequence[MemoryItem],
        *,
        task_outcome: TaskOutcome = "unknown",
        trigger: ReflectionTrigger = "idle",
        now: datetime | None = None,
    ) -> list[ReflectionProposal]:
        del trigger  # trigger is part of the public contract; proposal scoring is trigger-agnostic.
        records = self._eligible_records(episodic_records)
        gate = self.evaluate_info_gain(records)
        if not gate.allowed:
            return []

        summaries = [record.content.strip() for record in records if record.content.strip()]
        generated = self._generate_insight(summaries=summaries, task_outcome=task_outcome)
        source_ids = [record.id for record in records]
        fallback_content = self._deterministic_content(summaries)
        fallback_reason = f"{gate.reason}; propose semantic insight for human approval"

        return [
            ReflectionProposal(
                kind="reflection_insight",
                sourceIds=source_ids,
                proposedContent=_text_value(generated.get("proposedContent"), fallback_content),
                reason=_text_value(generated.get("reason"), fallback_reason),
                confidence=_clamp_confidence(generated.get("confidence"), gate.score),
                requiresApproval=True,
                reflectModel=self._config.reflect_model,
                created_at=now or _utcnow(),
            )
        ]

    def evaluate_info_gain(self, episodic_records: Sequence[MemoryItem]) -> InfoGainResult:
        records = self._eligible_records(episodic_records)
        if len(records) < self._config.min_episodic_for_reflect:
            return InfoGainResult(
                allowed=False,
                score=0.0,
                reason="not enough episodic records for reflection",
            )

        contents = [record.content.strip() for record in records if record.content.strip()]
        normalized_contents = {content.lower() for content in contents}
        all_tokens = [token for content in contents for token in _tokens(content)]
        unique_tokens = set(all_tokens)

        if len(normalized_contents) < 2 or len(unique_tokens) < 8:
            return InfoGainResult(
                allowed=False,
                score=0.2,
                reason="episodic records are too repetitive or low-detail",
            )

        recurrence = 1.0 - (len(unique_tokens) / max(len(all_tokens), 1))
        detail = min(1.0, len(unique_tokens) / 24)
        coverage = min(1.0, len(records) / self._config.max_episodic_for_reflect)
        score = round((detail * 0.5) + (coverage * 0.25) + (recurrence * 0.25), 4)

        if score < self._config.min_info_gain_score:
            return InfoGainResult(
                allowed=False,
                score=score,
                reason="estimated information gain is below reflector threshold",
            )

        return InfoGainResult(
            allowed=True,
            score=score,
            reason="episodic records contain enough detail and recurring signal",
        )

    def _eligible_records(self, records: Sequence[MemoryItem]) -> list[MemoryItem]:
        episodic = [record for record in records if record.layer == "episodic"]
        return episodic[: max(0, self._config.max_episodic_for_reflect)]

    def _generate_insight(
        self,
        *,
        summaries: list[str],
        task_outcome: TaskOutcome,
    ) -> Mapping[str, object]:
        if self._llm_caller is None:
            return {}

        result = self._llm_caller(
            model=self._config.reflect_model,
            episodic_summaries=summaries,
            task_outcome=task_outcome,
        )
        return cast(Mapping[str, object], result)

    def _deterministic_content(self, summaries: list[str]) -> str:
        token_counts: dict[str, int] = {}
        for summary in summaries:
            for token in _tokens(summary):
                token_counts[token] = token_counts.get(token, 0) + 1

        recurring = [
            token
            for token, count in sorted(token_counts.items(), key=lambda item: (-item[1], item[0]))
            if count > 1
        ][:5]
        signal = ", ".join(recurring) if recurring else ", ".join(sorted(token_counts)[:5])

        return (
            f"Recent episodic records show a reusable pattern around {signal}. "
            "Preserve this as a semantic insight only after approval."
        )

    async def commit_insight(
        self,
        proposal: ReflectionProposal,
        *,
        store: QuilinMemStore,
        write_authority: WriteAuthorityGate,
        now: datetime | None = None,
    ) -> ReflectionInsight:
        decision = await _authorize_write(
            write_authority,
            {
                "tool": "memory_reflect_commit",
                "origin": "idle",
                "riskLevel": "medium",
                "summary": "Commit approved Reflector insight into semantic memory",
                "metadata": {
                    "schema_version": REFLECTOR_SCHEMA_VERSION,
                    "source_ids": list(proposal.sourceIds),
                    "reflect_model": proposal.reflectModel,
                },
            },
        )
        if not _decision_allowed(decision):
            raise PermissionError("WriteAuthority denied reflection insight commit")

        committed_at = now or _utcnow()
        record = await store.store(
            proposal.proposedContent,
            tier="semantic",
            metadata={
                "schema_version": REFLECTOR_SCHEMA_VERSION,
                "source": "reflector",
                "stability_reason": proposal.reason,
                "source_layers": ["episodic"],
            },
            importance_score=proposal.confidence,
        )
        return ReflectionInsight(
            id=record.id,
            content=record.content,
            sourceIds=tuple(proposal.sourceIds),
            confidence=proposal.confidence,
            committed_at=committed_at,
        )


async def _authorize_write(
    write_authority: WriteAuthorityGate,
    request: Mapping[str, object],
) -> object:
    decision = write_authority.authorize(request)
    if inspect.isawaitable(decision):
        return await cast(Any, decision)
    return decision


def _decision_allowed(decision: object) -> bool:
    if isinstance(decision, bool):
        return decision
    if isinstance(decision, Mapping):
        allowed = decision.get("allowed")
        if isinstance(allowed, bool):
            return allowed
        decision_value = decision.get("decision")
        return decision_value in {"allow", "allowed", "approved"}
    allowed = getattr(decision, "allowed", None)
    if isinstance(allowed, bool):
        return allowed
    decision_value = getattr(decision, "decision", None)
    return decision_value in {"allow", "allowed", "approved"}


def propose_reflection(
    episodic_records: Sequence[MemoryItem],
    *,
    config: ReflectorConfig | None = None,
    llm_caller: ReflectionLLMCaller | None = None,
    task_outcome: TaskOutcome = "unknown",
    trigger: ReflectionTrigger = "idle",
) -> list[ReflectionProposal]:
    return Reflector(config, llm_caller=llm_caller).propose(
        episodic_records,
        task_outcome=task_outcome,
        trigger=trigger,
    )


__all__ = [
    "DEFAULT_REFLECT_MODEL",
    "REFLECTOR_SCHEMA_VERSION",
    "REFLECT_MODEL_ENV",
    "InfoGainResult",
    "ReflectionInsight",
    "ReflectionLLMCaller",
    "ReflectionProposal",
    "ReflectionProposalKind",
    "ReflectionTrigger",
    "Reflector",
    "ReflectorConfig",
    "TaskOutcome",
    "WriteAuthorityGate",
    "propose_reflection",
]
