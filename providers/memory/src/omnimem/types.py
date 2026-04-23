from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import NotRequired, TypedDict, cast
from typing import Literal
from uuid import uuid4

MemoryLayer = Literal["working", "episodic", "semantic", "skill"]
MemoryTier = MemoryLayer

VALID_MEMORY_LAYERS: tuple[MemoryLayer, ...] = (
    "working",
    "episodic",
    "semantic",
    "skill",
)
VALID_MEMORY_TIERS: tuple[MemoryTier, ...] = VALID_MEMORY_LAYERS


class MemoryMetadata(TypedDict):
    schema_version: int
    source: NotRequired[str]
    score: NotRequired[float]
    staleness: NotRequired[str]


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _new_memory_id() -> str:
    return str(uuid4())


def _normalize_metadata(metadata: dict[str, object] | MemoryMetadata | None) -> MemoryMetadata:
    normalized = dict(metadata or {})
    schema_version = normalized.get("schema_version", 1)
    if not isinstance(schema_version, int):
        raise TypeError("metadata.schema_version must be an int")

    normalized["schema_version"] = schema_version
    return cast(MemoryMetadata, normalized)


def validate_memory_layer(layer: str) -> MemoryLayer:
    if layer not in VALID_MEMORY_LAYERS:
        valid_layers = ", ".join(VALID_MEMORY_LAYERS)
        raise ValueError(
            f"Invalid memory layer: {layer}. Expected one of: {valid_layers}"
        )

    return cast(MemoryLayer, layer)


@dataclass(slots=True, frozen=True, init=False)
class MemoryItem:
    id: str = field(default_factory=_new_memory_id)
    content: str = ""
    content_type: str = "text"
    layer: MemoryLayer = "working"
    metadata: MemoryMetadata = field(
        default_factory=lambda: cast(MemoryMetadata, {"schema_version": 1})
    )
    embedding: list[float] | None = None
    created_at: datetime = field(default_factory=_utcnow)
    last_accessed: datetime = field(default_factory=_utcnow)
    access_count: int = 0
    importance_score: float = 0.5

    def __init__(
        self,
        id: str | None = None,
        content: str = "",
        content_type: str = "text",
        layer: MemoryLayer = "working",
        metadata: dict[str, object] | MemoryMetadata | None = None,
        embedding: list[float] | tuple[float, ...] | None = None,
        created_at: datetime | None = None,
        last_accessed: datetime | None = None,
        access_count: int = 0,
        importance_score: float = 0.5,
        *,
        tier: MemoryTier | None = None,
    ) -> None:
        resolved_layer = validate_memory_layer(tier or layer)
        created = created_at or _utcnow()
        last_seen = last_accessed or created

        object.__setattr__(self, "id", id or _new_memory_id())
        object.__setattr__(self, "content", content)
        object.__setattr__(self, "content_type", content_type)
        object.__setattr__(self, "layer", resolved_layer)
        object.__setattr__(self, "metadata", _normalize_metadata(metadata))
        object.__setattr__(
            self,
            "embedding",
            None if embedding is None else [float(value) for value in embedding],
        )
        object.__setattr__(self, "created_at", created)
        object.__setattr__(self, "last_accessed", last_seen)
        object.__setattr__(self, "access_count", access_count)
        object.__setattr__(self, "importance_score", float(importance_score))

    @property
    def tier(self) -> MemoryTier:
        return self.layer

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "content": self.content, "tier": self.layer}

    def to_wire_dict(self, *, include_legacy_tier: bool = True) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "content": self.content,
            "content_type": self.content_type,
            "layer": self.layer,
            "metadata": dict(self.metadata),
            "embedding": self.embedding,
            "created_at": self.created_at.isoformat(),
            "last_accessed": self.last_accessed.isoformat(),
            "access_count": self.access_count,
            "importance_score": self.importance_score,
        }
        if include_legacy_tier:
            payload["tier"] = self.layer

        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> MemoryItem:
        raw_layer = payload.get("layer", payload.get("tier", "working"))
        metadata = payload.get("metadata")
        embedding = payload.get("embedding")
        created_at = payload.get("created_at")
        last_accessed = payload.get("last_accessed")

        return cls(
            id=cast(str | None, payload.get("id")),
            content=cast(str, payload.get("content", "")),
            content_type=cast(str, payload.get("content_type", "text")),
            layer=validate_memory_layer(cast(str, raw_layer)),
            metadata=cast(dict[str, object] | MemoryMetadata | None, metadata),
            embedding=cast(list[float] | tuple[float, ...] | None, embedding),
            created_at=(
                datetime.fromisoformat(cast(str, created_at))
                if isinstance(created_at, str)
                else None
            ),
            last_accessed=(
                datetime.fromisoformat(cast(str, last_accessed))
                if isinstance(last_accessed, str)
                else None
            ),
            access_count=int(cast(int | float, payload.get("access_count", 0))),
            importance_score=float(
                cast(int | float, payload.get("importance_score", 0.5))
            ),
        )


MemoryRecord = MemoryItem

