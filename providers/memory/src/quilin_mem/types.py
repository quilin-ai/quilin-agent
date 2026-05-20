from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, NotRequired, TypedDict, cast
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
MemoryKind = Literal[
    "preference",
    "feedback",
    "project_note",
    "reference",
    "pattern",
    "bug",
    "workflow",
    "prospective",
    "resource",
]
VALID_MEMORY_KINDS: tuple[MemoryKind, ...] = (
    "preference",
    "feedback",
    "project_note",
    "reference",
    "pattern",
    "bug",
    "workflow",
    "prospective",
    "resource",
)


class MemoryMetadata(TypedDict):
    schema_version: int
    source: NotRequired[str]
    score: NotRequired[float]
    staleness: NotRequired[str]
    memory_source: NotRequired[str]
    layer: NotRequired[str]
    source_layers: NotRequired[list[str]]
    cache_key: NotRequired[str]
    block_version: NotRequired[str]
    graph_distance: NotRequired[int]
    valid_from: NotRequired[str]
    valid_to: NotRequired[str | None]
    retrieval_score: NotRequired[float]
    reranker_score: NotRequired[float]
    reranker_rank: NotRequired[int]
    run_id: NotRequired[str]
    stability_reason: NotRequired[str]
    conflict_resolution_pending: NotRequired[bool]
    conflict_with_client: NotRequired[str]
    conflict_with_session_id: NotRequired[str]
    staleness_marker: NotRequired[dict[str, object]]


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
        raise ValueError(f"Invalid memory layer: {layer}. Expected one of: {valid_layers}")

    return cast(MemoryLayer, layer)


def validate_memory_kind(kind: str | None) -> MemoryKind | None:
    if kind is None:
        return None
    normalized = kind.strip().lower()
    if normalized not in VALID_MEMORY_KINDS:
        valid_kinds = ", ".join(VALID_MEMORY_KINDS)
        raise ValueError(f"Invalid memory kind: {kind}. Expected one of: {valid_kinds}")
    return cast(MemoryKind, normalized)


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
    last_writer_client: str | None = None
    last_writer_session_id: str | None = None
    project_scope: str | None = None
    salience: dict[str, object] | None = None
    kind: str | None = None
    deadline_at: datetime | None = None
    prospective_action: str | None = None
    resource_pointer: dict[str, object] | None = None

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
        last_writer_client: str | None = None,
        last_writer_session_id: str | None = None,
        project_scope: str | None = None,
        salience: dict[str, object] | None = None,
        kind: str | None = None,
        deadline_at: datetime | None = None,
        prospective_action: str | None = None,
        resource_pointer: dict[str, object] | None = None,
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
        object.__setattr__(self, "last_writer_client", last_writer_client)
        object.__setattr__(self, "last_writer_session_id", last_writer_session_id)
        object.__setattr__(self, "project_scope", project_scope)
        object.__setattr__(self, "salience", dict(salience) if salience is not None else None)
        object.__setattr__(self, "kind", validate_memory_kind(kind))
        object.__setattr__(self, "deadline_at", deadline_at)
        object.__setattr__(self, "prospective_action", prospective_action)
        object.__setattr__(
            self,
            "resource_pointer",
            dict(resource_pointer) if resource_pointer is not None else None,
        )

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
            "last_writer_client": self.last_writer_client,
            "last_writer_session_id": self.last_writer_session_id,
            "project_scope": self.project_scope,
            "salience": dict(self.salience) if self.salience is not None else None,
            "kind": self.kind,
            "deadline_at": self.deadline_at.isoformat() if self.deadline_at else None,
            "prospective_action": self.prospective_action,
            "resource_pointer": (
                dict(self.resource_pointer) if self.resource_pointer is not None else None
            ),
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
        deadline_at = payload.get("deadline_at")

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
                else created_at
                if isinstance(created_at, datetime)
                else None
            ),
            last_accessed=(
                datetime.fromisoformat(cast(str, last_accessed))
                if isinstance(last_accessed, str)
                else last_accessed
                if isinstance(last_accessed, datetime)
                else None
            ),
            access_count=int(cast(int | float, payload.get("access_count", 0))),
            importance_score=float(cast(int | float, payload.get("importance_score", 0.5))),
            last_writer_client=cast(str | None, payload.get("last_writer_client")),
            last_writer_session_id=cast(str | None, payload.get("last_writer_session_id")),
            project_scope=cast(str | None, payload.get("project_scope")),
            salience=cast(dict[str, object] | None, payload.get("salience")),
            kind=cast(str | None, payload.get("kind")),
            deadline_at=(
                datetime.fromisoformat(cast(str, deadline_at))
                if isinstance(deadline_at, str)
                else deadline_at
                if isinstance(deadline_at, datetime)
                else None
            ),
            prospective_action=cast(str | None, payload.get("prospective_action")),
            resource_pointer=cast(dict[str, object] | None, payload.get("resource_pointer")),
        )


MemoryRecord = MemoryItem


def memory_item_with(record: MemoryItem, **updates: object) -> MemoryItem:
    """Clone a memory item while preserving all structured fields."""

    payload = record.to_wire_dict()
    payload.update(updates)
    return MemoryItem.from_dict(payload)
