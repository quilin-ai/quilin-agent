from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, Protocol, cast, runtime_checkable

ObservationRole = Literal["user", "assistant", "tool", "system", "unknown"]
ObservationKind = Literal["fact", "preference", "event", "intent", "relationship", "unknown"]

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


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _optional_string(payload: Mapping[str, object], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"turn.{key} must be a string when provided")
    return value


def _normalize_metadata(metadata: object) -> dict[str, object]:
    if metadata is None:
        return {}
    if not isinstance(metadata, Mapping):
        raise TypeError("turn.metadata must be a mapping when provided")
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
        if not isinstance(self.confidence, int | float):
            raise TypeError("candidate.confidence must be numeric")
        if not 0 <= float(self.confidence) <= 1:
            raise ValueError("candidate.confidence must be between 0 and 1")
        if self.source_turn_id is not None and not isinstance(self.source_turn_id, str):
            raise TypeError("candidate.source_turn_id must be a string when provided")

        object.__setattr__(self, "confidence", float(self.confidence))
        object.__setattr__(self, "kind", _normalize_kind(self.kind))
        object.__setattr__(self, "metadata", _normalize_metadata(self.metadata))


type ObservationTurnInput = ObservationTurn | Mapping[str, object]


def normalize_observation_turn(turn: ObservationTurnInput) -> ObservationTurn:
    if isinstance(turn, ObservationTurn):
        return turn
    if isinstance(turn, Mapping):
        return ObservationTurn.from_mapping(turn)
    raise TypeError("turn must be an ObservationTurn or mapping")


@runtime_checkable
class MemoryObserver(Protocol):
    async def observe(self, turn: ObservationTurnInput) -> list[ObservationCandidate]:
        ...


class NoOpMemoryObserver:
    async def observe(self, turn: ObservationTurnInput) -> list[ObservationCandidate]:
        normalize_observation_turn(turn)
        return []


async def observe_safely(
    observer: MemoryObserver,
    turn: ObservationTurnInput,
) -> list[ObservationCandidate]:
    try:
        return await observer.observe(turn)
    except Exception:
        return []
