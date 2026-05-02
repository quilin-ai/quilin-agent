from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, Protocol, cast, runtime_checkable

ObservationRole = Literal["user", "assistant", "tool", "system", "unknown"]
ObservationKind = Literal["fact", "preference", "event", "intent", "relationship", "unknown"]
ObservationBatchQualityStatus = Literal["rejected", "mixed", "high_quality"]
ObservationArchiveBlockingReason = Literal[
    "empty_batch",
    "all_candidates_rejected",
    "mixed_batch",
    "rejected_candidates",
    "low_confidence_candidates",
    "low_quality_candidates",
    "no_high_quality_candidates",
]
OBSERVATION_ARCHIVE_BLOCKING_REASON_ORDER: tuple[
    ObservationArchiveBlockingReason,
    ...,
] = (
    "empty_batch",
    "all_candidates_rejected",
    "mixed_batch",
    "rejected_candidates",
    "low_confidence_candidates",
    "low_quality_candidates",
    "no_high_quality_candidates",
)

VALID_OBSERVATION_ROLES: tuple[ObservationRole, ...] = (
    "user",
    "assistant",
    "tool",
    "system",
    "unknown",
)
VALID_OBSERVATION_KINDS: tuple[ObservationKind, ...] = (
    "fact",
    "preference",
    "event",
    "intent",
    "relationship",
    "unknown",
)
SOURCE_METADATA_KEYS: tuple[str, ...] = (
    "source",
    "source_id",
    "source_turn_id",
    "turn_id",
    "trace_id",
)
EVIDENCE_METADATA_KEYS: tuple[str, ...] = (
    "evidence",
    "evidence_ids",
    "evidence_refs",
    "citations",
    "source_excerpt",
    "supporting_turns",
)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _optional_string(
    payload: Mapping[str, object],
    key: str,
    *,
    field_prefix: str = "turn",
) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field_prefix}.{key} must be a string when provided")
    return value


def _normalize_metadata(
    metadata: object,
    *,
    field_name: str = "turn.metadata",
) -> dict[str, object]:
    if metadata is None:
        return {}
    if not isinstance(metadata, Mapping):
        raise TypeError(f"{field_name} must be a mapping when provided")
    return dict(metadata)


def _normalize_role(raw_role: object) -> ObservationRole:
    if raw_role is None:
        return "unknown"
    if not isinstance(raw_role, str):
        raise TypeError("turn.role must be a string when provided")
    if raw_role not in VALID_OBSERVATION_ROLES:
        valid_roles = ", ".join(VALID_OBSERVATION_ROLES)
        raise ValueError(f"Invalid turn.role: {raw_role}. Expected one of: {valid_roles}")
    return cast(ObservationRole, raw_role)


def _normalize_kind(raw_kind: object) -> ObservationKind:
    if raw_kind is None:
        return "unknown"
    if not isinstance(raw_kind, str):
        raise TypeError("candidate.kind must be a string when provided")
    if raw_kind not in VALID_OBSERVATION_KINDS:
        valid_kinds = ", ".join(VALID_OBSERVATION_KINDS)
        raise ValueError(f"Invalid candidate.kind: {raw_kind}. Expected one of: {valid_kinds}")
    return cast(ObservationKind, raw_kind)


def _is_numeric_confidence(value: object) -> bool:
    return not isinstance(value, bool) and isinstance(value, int | float)


@dataclass(slots=True, frozen=True)
class ObservationTurn:
    content: str
    role: ObservationRole = "unknown"
    turn_id: str | None = None
    session_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    observed_at: datetime = field(default_factory=_utcnow)

    def __post_init__(self) -> None:
        if not isinstance(self.content, str):
            raise TypeError("turn.content must be a string")
        object.__setattr__(self, "role", _normalize_role(self.role))
        object.__setattr__(self, "metadata", _normalize_metadata(self.metadata))

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> ObservationTurn:
        content = payload.get("content")
        if not isinstance(content, str):
            raise TypeError("turn.content must be a string")

        return cls(
            content=content,
            role=_normalize_role(payload.get("role")),
            turn_id=_optional_string(payload, "turn_id"),
            session_id=_optional_string(payload, "session_id"),
            user_id=_optional_string(payload, "user_id"),
            metadata=_normalize_metadata(payload.get("metadata")),
        )


@dataclass(slots=True, frozen=True)
class ObservationCandidate:
    content: str
    confidence: float
    kind: ObservationKind = "unknown"
    source_turn_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    created_at: datetime = field(default_factory=_utcnow)

    def __post_init__(self) -> None:
        if not isinstance(self.content, str):
            raise TypeError("candidate.content must be a string")
        if not self.content.strip():
            raise ValueError("candidate.content must be a non-empty string")
        if not _is_numeric_confidence(self.confidence):
            raise TypeError("candidate.confidence must be numeric")
        if not 0 <= float(self.confidence) <= 1:
            raise ValueError("candidate.confidence must be between 0 and 1")
        if self.source_turn_id is not None and not isinstance(self.source_turn_id, str):
            raise TypeError("candidate.source_turn_id must be a string when provided")

        object.__setattr__(self, "confidence", float(self.confidence))
        object.__setattr__(self, "kind", _normalize_kind(self.kind))
        object.__setattr__(
            self,
            "metadata",
            _normalize_metadata(self.metadata, field_name="candidate.metadata"),
        )

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> ObservationCandidate:
        content = payload.get("content")
        if not isinstance(content, str):
            raise TypeError("candidate.content must be a string")
        confidence = payload.get("confidence")
        if not _is_numeric_confidence(confidence):
            raise TypeError("candidate.confidence must be numeric")

        return cls(
            content=content,
            confidence=confidence,
            kind=_normalize_kind(payload.get("kind")),
            source_turn_id=_optional_string(
                payload,
                "source_turn_id",
                field_prefix="candidate",
            ),
            metadata=_normalize_metadata(
                payload.get("metadata"),
                field_name="candidate.metadata",
            ),
        )


type ObservationTurnInput = ObservationTurn | Mapping[str, object]
type ObservationCandidateInput = ObservationCandidate | Mapping[str, object]


@dataclass(slots=True, frozen=True)
class ObservationCandidateQuality:
    has_content: bool
    has_source: bool
    has_evidence: bool
    has_confidence: bool
    has_valid_confidence: bool
    confidence_value: float | None
    has_known_kind: bool
    evidence_coverage: float
    quality_score: float
    issues: tuple[str, ...] = ()


@dataclass(slots=True, frozen=True)
class ObservationArchiveReadinessProjection:
    ready: bool
    status: ObservationBatchQualityStatus
    accepted: int
    rejected: int
    high_quality: int
    average_quality_score: float
    blocking_reasons: tuple[ObservationArchiveBlockingReason, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "ready": self.ready,
            "status": self.status,
            "accepted": self.accepted,
            "rejected": self.rejected,
            "high_quality": self.high_quality,
            "average_quality_score": self.average_quality_score,
            "blocking_reasons": self.blocking_reasons,
        }


@dataclass(slots=True, frozen=True)
class ObservationArchiveGateDecision:
    allowed: bool
    status: ObservationBatchQualityStatus
    blocking_reasons: tuple[ObservationArchiveBlockingReason, ...]
    accepted: int
    rejected: int
    high_quality: int
    summary: str

    def to_dict(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "status": self.status,
            "blocking_reasons": self.blocking_reasons,
            "accepted": self.accepted,
            "rejected": self.rejected,
            "high_quality": self.high_quality,
            "summary": self.summary,
        }


@dataclass(slots=True, frozen=True)
class ObservationArchiveGateReport:
    total_count: int
    allowed_count: int
    blocked_count: int
    allowed_ids: tuple[str, ...]
    blocked_ids: tuple[str, ...]
    reason_codes: tuple[ObservationArchiveBlockingReason, ...]
    decisions: tuple[tuple[str, ObservationArchiveGateDecision], ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "total_count": self.total_count,
            "allowed_count": self.allowed_count,
            "blocked_count": self.blocked_count,
            "allowed_ids": self.allowed_ids,
            "blocked_ids": self.blocked_ids,
            "reason_codes": self.reason_codes,
            "decisions": tuple(
                {"id": decision_id, **decision.to_dict()}
                for decision_id, decision in self.decisions
            ),
        }


@dataclass(slots=True, frozen=True)
class ObservationBatchQualityReport:
    status: ObservationBatchQualityStatus
    archive_ready: bool
    archive_readiness: ObservationArchiveReadinessProjection
    total_candidates: int
    accepted_candidates: int
    rejected_candidates: int
    high_quality_candidates: int
    average_quality_score: float
    qualities: tuple[ObservationCandidateQuality, ...]
    issues: tuple[str, ...] = ()


def decide_observation_archive_gate(
    archive_readiness: ObservationArchiveReadinessProjection,
) -> ObservationArchiveGateDecision:
    allowed = archive_readiness.ready
    blocking_reasons = archive_readiness.blocking_reasons
    reason_summary = ",".join(blocking_reasons) if blocking_reasons else "none"
    outcome = "allowed" if allowed else "blocked"

    return ObservationArchiveGateDecision(
        allowed=allowed,
        status=archive_readiness.status,
        blocking_reasons=blocking_reasons,
        accepted=archive_readiness.accepted,
        rejected=archive_readiness.rejected,
        high_quality=archive_readiness.high_quality,
        summary=(
            f"{outcome}: status={archive_readiness.status}; "
            f"reasons={reason_summary}; "
            f"accepted={archive_readiness.accepted}; "
            f"rejected={archive_readiness.rejected}; "
            f"high_quality={archive_readiness.high_quality}"
        ),
    )


def _normalize_archive_gate_decision_items(
    decisions: Mapping[str, ObservationArchiveGateDecision]
    | Iterable[tuple[str, ObservationArchiveGateDecision]],
) -> tuple[tuple[str, ObservationArchiveGateDecision], ...]:
    if isinstance(decisions, Mapping):
        decision_items = tuple(decisions.items())
    elif isinstance(decisions, Iterable) and not isinstance(decisions, str | bytes):
        decision_items = tuple(decisions)
    else:
        raise TypeError("decisions must be a mapping or iterable of decision pairs")

    normalized: list[tuple[str, ObservationArchiveGateDecision]] = []
    seen_ids: set[str] = set()
    for raw_decision_id, decision in decision_items:
        if not isinstance(raw_decision_id, str):
            raise TypeError("archive gate decision id must be a string")
        decision_id = raw_decision_id.strip()
        if not decision_id:
            raise ValueError("archive gate decision id must be non-empty")
        if decision_id in seen_ids:
            raise ValueError(f"duplicate archive gate decision id: {decision_id}")
        if not isinstance(decision, ObservationArchiveGateDecision):
            raise TypeError("archive gate decision must be an ObservationArchiveGateDecision")
        seen_ids.add(decision_id)
        normalized.append((decision_id, decision))

    return tuple(sorted(normalized, key=lambda item: item[0]))


def _ordered_archive_gate_reason_codes(
    decisions: Iterable[ObservationArchiveGateDecision],
) -> tuple[ObservationArchiveBlockingReason, ...]:
    reason_codes = {
        reason
        for decision in decisions
        if not decision.allowed
        for reason in decision.blocking_reasons
    }
    reason_order = {
        reason: index for index, reason in enumerate(OBSERVATION_ARCHIVE_BLOCKING_REASON_ORDER)
    }
    return tuple(
        sorted(
            reason_codes,
            key=lambda reason: (reason_order.get(reason, len(reason_order)), reason),
        )
    )


def build_observation_archive_gate_report(
    decisions: Mapping[str, ObservationArchiveGateDecision]
    | Iterable[tuple[str, ObservationArchiveGateDecision]],
) -> ObservationArchiveGateReport:
    decision_items = _normalize_archive_gate_decision_items(decisions)
    allowed_ids = tuple(decision_id for decision_id, decision in decision_items if decision.allowed)
    blocked_ids = tuple(
        decision_id for decision_id, decision in decision_items if not decision.allowed
    )

    return ObservationArchiveGateReport(
        total_count=len(decision_items),
        allowed_count=len(allowed_ids),
        blocked_count=len(blocked_ids),
        allowed_ids=allowed_ids,
        blocked_ids=blocked_ids,
        reason_codes=_ordered_archive_gate_reason_codes(decision for _, decision in decision_items),
        decisions=decision_items,
    )


def normalize_observation_turn(turn: ObservationTurnInput) -> ObservationTurn:
    if isinstance(turn, ObservationTurn):
        return turn
    if isinstance(turn, Mapping):
        return ObservationTurn.from_mapping(turn)
    raise TypeError("turn must be an ObservationTurn or mapping")


def normalize_observation_candidate(
    candidate: ObservationCandidateInput,
) -> ObservationCandidate:
    if isinstance(candidate, ObservationCandidate):
        return candidate
    if isinstance(candidate, Mapping):
        return ObservationCandidate.from_mapping(candidate)
    raise TypeError("candidate must be an ObservationCandidate or mapping")


def normalize_observation_candidates(
    candidates: Iterable[ObservationCandidateInput],
) -> list[ObservationCandidate]:
    if isinstance(candidates, Mapping | str | bytes):
        raise TypeError("observer.observe must return an iterable of observation candidates")
    if not isinstance(candidates, Iterable):
        raise TypeError("observer.observe must return an iterable of observation candidates")
    normalized: list[ObservationCandidate] = []
    for candidate in candidates:
        try:
            normalized.append(normalize_observation_candidate(candidate))
        except TypeError, ValueError:
            continue
    return normalized


def _is_non_empty_quality_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, bool):
        return value
    if isinstance(value, Mapping):
        return any(_is_non_empty_quality_value(item) for item in value.values())
    if isinstance(value, Iterable) and not isinstance(value, bytes | bytearray):
        return any(_is_non_empty_quality_value(item) for item in value)
    return True


def _quality_metadata_value(
    metadata: Mapping[str, object],
    keys: tuple[str, ...],
) -> bool:
    return any(_is_non_empty_quality_value(metadata.get(key)) for key in keys)


def evaluate_observation_candidate_quality(
    candidate: ObservationCandidateInput,
) -> ObservationCandidateQuality:
    try:
        normalized = normalize_observation_candidate(candidate)
        content: object = normalized.content
        confidence: object = normalized.confidence
        kind: object = normalized.kind
        source_turn_id: object = normalized.source_turn_id
        metadata: object = normalized.metadata
        metadata_valid = True
    except TypeError, ValueError:
        if not isinstance(candidate, Mapping):
            return ObservationCandidateQuality(
                has_content=False,
                has_source=False,
                has_evidence=False,
                has_confidence=False,
                has_valid_confidence=False,
                confidence_value=None,
                has_known_kind=False,
                evidence_coverage=0.0,
                quality_score=0.0,
                issues=("invalid_candidate_type",),
            )
        content = candidate.get("content")
        confidence = candidate.get("confidence")
        kind = candidate.get("kind")
        source_turn_id = candidate.get("source_turn_id")
        metadata = candidate.get("metadata")
        metadata_valid = isinstance(metadata, Mapping) or metadata is None

    normalized_metadata: Mapping[str, object] = metadata if isinstance(metadata, Mapping) else {}
    has_content = isinstance(content, str) and bool(content.strip())
    has_confidence = _is_numeric_confidence(confidence)
    has_valid_confidence = has_confidence and 0 <= float(confidence) <= 1
    confidence_value = float(confidence) if has_valid_confidence else None
    has_known_kind = isinstance(kind, str) and kind in VALID_OBSERVATION_KINDS and kind != "unknown"
    has_source = (
        isinstance(source_turn_id, str)
        and bool(source_turn_id.strip())
        or _quality_metadata_value(normalized_metadata, SOURCE_METADATA_KEYS)
    )
    has_evidence = _quality_metadata_value(normalized_metadata, EVIDENCE_METADATA_KEYS)
    evidence_coverage = (float(has_source) + float(has_evidence)) / 2

    issues: list[str] = []
    if not has_content:
        issues.append("missing_content")
    if not has_source:
        issues.append("missing_source")
    if not has_evidence:
        issues.append("missing_evidence")
    if not has_confidence:
        issues.append("missing_confidence")
    elif not has_valid_confidence:
        issues.append("invalid_confidence")
    if not has_known_kind:
        issues.append("missing_or_unknown_kind")
    if not metadata_valid:
        issues.append("invalid_metadata")

    confidence_score = confidence_value if confidence_value is not None else 0.0
    quality_score = 0.0
    if has_content:
        quality_score = round(
            0.35
            + (0.2 * confidence_score)
            + (0.2 if has_known_kind else 0.0)
            + (0.25 * evidence_coverage),
            3,
        )

    return ObservationCandidateQuality(
        has_content=has_content,
        has_source=has_source,
        has_evidence=has_evidence,
        has_confidence=has_confidence,
        has_valid_confidence=has_valid_confidence,
        confidence_value=confidence_value,
        has_known_kind=has_known_kind,
        evidence_coverage=evidence_coverage,
        quality_score=quality_score,
        issues=tuple(issues),
    )


def evaluate_observation_candidates_quality(
    candidates: Iterable[ObservationCandidateInput],
) -> list[ObservationCandidateQuality]:
    if isinstance(candidates, Mapping | str | bytes):
        raise TypeError("candidates must be an iterable of observation candidates")
    if not isinstance(candidates, Iterable):
        raise TypeError("candidates must be an iterable of observation candidates")
    return [evaluate_observation_candidate_quality(candidate) for candidate in candidates]


def _candidate_normalizes(candidate: ObservationCandidateInput) -> bool:
    try:
        normalize_observation_candidate(candidate)
    except TypeError, ValueError:
        return False
    return True


def _is_high_quality_candidate(quality: ObservationCandidateQuality) -> bool:
    return (
        quality.confidence_value is not None
        and quality.confidence_value >= 0.9
        and quality.quality_score >= 0.95
        and not quality.issues
    )


def _classify_observation_batch_quality(
    *,
    total_candidates: int,
    accepted_candidates: int,
    high_quality_candidates: int,
) -> ObservationBatchQualityStatus:
    if total_candidates == 0 or accepted_candidates == 0:
        return "rejected"
    if high_quality_candidates == total_candidates:
        return "high_quality"
    return "mixed"


def _has_low_confidence_candidate(
    qualities: tuple[ObservationCandidateQuality, ...],
    accepted_flags: tuple[bool, ...],
) -> bool:
    return any(
        accepted and quality.confidence_value is not None and quality.confidence_value < 0.9
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
    )


def _archive_readiness_blocking_reasons(
    *,
    total_candidates: int,
    accepted_candidates: int,
    rejected_candidates: int,
    high_quality_candidates: int,
    qualities: tuple[ObservationCandidateQuality, ...],
    accepted_flags: tuple[bool, ...],
) -> tuple[ObservationArchiveBlockingReason, ...]:
    if total_candidates == 0:
        return ("empty_batch",)
    if accepted_candidates == 0:
        return ("all_candidates_rejected", "no_high_quality_candidates")

    reasons: list[ObservationArchiveBlockingReason] = []
    low_quality_candidates = accepted_candidates - high_quality_candidates
    if (rejected_candidates and accepted_candidates) or (
        high_quality_candidates and low_quality_candidates
    ):
        reasons.append("mixed_batch")
    if rejected_candidates:
        reasons.append("rejected_candidates")
    if low_quality_candidates:
        if _has_low_confidence_candidate(qualities, accepted_flags):
            reasons.append("low_confidence_candidates")
        reasons.append("low_quality_candidates")
    if high_quality_candidates == 0:
        reasons.append("no_high_quality_candidates")
    return tuple(reasons)


def evaluate_observation_batch_quality(
    candidates: Iterable[ObservationCandidateInput],
) -> ObservationBatchQualityReport:
    if isinstance(candidates, Mapping | str | bytes):
        raise TypeError("candidates must be an iterable of observation candidates")
    if not isinstance(candidates, Iterable):
        raise TypeError("candidates must be an iterable of observation candidates")

    candidate_items = tuple(candidates)
    qualities = tuple(
        evaluate_observation_candidate_quality(candidate) for candidate in candidate_items
    )
    total_candidates = len(candidate_items)
    accepted_flags = tuple(_candidate_normalizes(candidate) for candidate in candidate_items)
    accepted_candidates = sum(1 for accepted in accepted_flags if accepted)
    rejected_candidates = total_candidates - accepted_candidates
    high_quality_candidates = sum(
        1
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
        if accepted and _is_high_quality_candidate(quality)
    )
    accepted_quality_scores = tuple(
        quality.quality_score
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
        if accepted
    )
    average_quality_score = (
        round(sum(accepted_quality_scores) / len(accepted_quality_scores), 3)
        if accepted_quality_scores
        else 0.0
    )
    status = _classify_observation_batch_quality(
        total_candidates=total_candidates,
        accepted_candidates=accepted_candidates,
        high_quality_candidates=high_quality_candidates,
    )

    issues: list[str] = []
    if total_candidates == 0:
        issues.append("empty_batch")
    if rejected_candidates:
        issues.append("rejected_candidates")
    if accepted_candidates > high_quality_candidates:
        issues.append("low_quality_candidates")
    if total_candidates and high_quality_candidates == 0:
        issues.append("no_high_quality_candidates")
    archive_readiness = ObservationArchiveReadinessProjection(
        ready=status == "high_quality",
        status=status,
        accepted=accepted_candidates,
        rejected=rejected_candidates,
        high_quality=high_quality_candidates,
        average_quality_score=average_quality_score,
        blocking_reasons=_archive_readiness_blocking_reasons(
            total_candidates=total_candidates,
            accepted_candidates=accepted_candidates,
            rejected_candidates=rejected_candidates,
            high_quality_candidates=high_quality_candidates,
            qualities=qualities,
            accepted_flags=accepted_flags,
        ),
    )

    return ObservationBatchQualityReport(
        status=status,
        archive_ready=archive_readiness.ready,
        archive_readiness=archive_readiness,
        total_candidates=total_candidates,
        accepted_candidates=accepted_candidates,
        rejected_candidates=rejected_candidates,
        high_quality_candidates=high_quality_candidates,
        average_quality_score=average_quality_score,
        qualities=qualities,
        issues=tuple(issues),
    )


@runtime_checkable
class MemoryObserver(Protocol):
    async def observe(
        self,
        turn: ObservationTurnInput,
    ) -> Iterable[ObservationCandidateInput]: ...


class NoOpMemoryObserver:
    async def observe(self, turn: ObservationTurnInput) -> list[ObservationCandidate]:
        normalize_observation_turn(turn)
        return []


async def observe_safely(
    observer: MemoryObserver,
    turn: ObservationTurnInput,
) -> list[ObservationCandidate]:
    try:
        normalized_turn = normalize_observation_turn(turn)
        candidates = await observer.observe(normalized_turn)
        return normalize_observation_candidates(candidates)
    except Exception:
        return []
