from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4


@dataclass(frozen=True, slots=True)
class MemoryObservation:
    id: str
    content: str
    content_hash: str
    observed_at: datetime
    source_event_id: str | None = None
    actor_id: str | None = None
    role: str | None = None
    metadata: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class MemorySource:
    id: str
    memory_id: str
    observation_id: str
    source_type: str
    source_uri: str | None
    metadata: dict[str, object]
    created_at: datetime


@dataclass(frozen=True, slots=True)
class MemorySnapshot:
    id: str
    label: str | None
    snapshot_at: datetime
    memory_ids: list[str]
    signature_hash: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class MemoryVersionInfo:
    id: str
    version: int
    parent_id: str | None
    supersedes: list[str]
    is_latest: bool
    source_event_id: str | None
    evidence_hash: str | None
    forget_after: datetime | None
    strength: float


@dataclass(frozen=True, slots=True)
class DestructiveImpactPreview:
    memory_id: str
    exists: bool
    currently_visible: bool
    would_archive: bool
    affected_records: int
    recoverable: bool
    recommended_action: str
    archived_at: datetime | None = None

    def to_wire_dict(self) -> dict[str, object]:
        return {
            "memory_id": self.memory_id,
            "exists": self.exists,
            "currently_visible": self.currently_visible,
            "would_archive": self.would_archive,
            "affected_records": self.affected_records,
            "recoverable": self.recoverable,
            "recommended_action": self.recommended_action,
            "archived_at": self.archived_at.isoformat() if self.archived_at else None,
        }


def stable_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def new_id() -> str:
    return str(uuid4())


def dumps_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def loads_object(raw_value: str | None) -> dict[str, object]:
    if raw_value is None:
        return {}

    loaded = json.loads(raw_value)
    return loaded if isinstance(loaded, dict) else {}


def loads_string_list(raw_value: str | None) -> list[str]:
    if raw_value is None:
        return []

    loaded = json.loads(raw_value)
    if not isinstance(loaded, list):
        return []

    return [str(value) for value in loaded]


def parse_datetime(raw_value: str | None) -> datetime | None:
    if raw_value is None or raw_value == "":
        return None

    return datetime.fromisoformat(raw_value)


def row_to_observation(row: sqlite3.Row) -> MemoryObservation:
    observed_at = parse_datetime(row["observed_at"])
    if observed_at is None:
        raise ValueError("memory_observations.observed_at is required")

    return MemoryObservation(
        id=row["id"],
        content=row["content"],
        content_hash=row["content_hash"],
        observed_at=observed_at,
        source_event_id=row["source_event_id"],
        actor_id=row["actor_id"],
        role=row["role"],
        metadata=loads_object(row["metadata_json"]),
    )


def row_to_source(row: sqlite3.Row) -> MemorySource:
    created_at = parse_datetime(row["created_at"])
    if created_at is None:
        raise ValueError("memory_sources.created_at is required")

    return MemorySource(
        id=row["id"],
        memory_id=row["memory_record_id"],
        observation_id=row["observation_id"],
        source_type=row["source_type"],
        source_uri=row["source_uri"],
        metadata=loads_object(row["metadata_json"]),
        created_at=created_at,
    )


def row_to_snapshot(row: sqlite3.Row) -> MemorySnapshot:
    snapshot_at = parse_datetime(row["snapshot_at"])
    created_at = parse_datetime(row["created_at"])
    if snapshot_at is None or created_at is None:
        raise ValueError("memory_snapshot timestamps are required")

    return MemorySnapshot(
        id=row["id"],
        label=row["label"],
        snapshot_at=snapshot_at,
        memory_ids=loads_string_list(row["memory_ids_json"]),
        signature_hash=row["signature_hash"],
        created_at=created_at,
    )


def row_to_version_info(row: sqlite3.Row) -> MemoryVersionInfo:
    return MemoryVersionInfo(
        id=row["id"],
        version=int(row["version"]),
        parent_id=row["parent_id"],
        supersedes=loads_string_list(row["supersedes_json"]),
        is_latest=bool(row["is_latest"]),
        source_event_id=row["source_event_id"],
        evidence_hash=row["evidence_hash"],
        forget_after=parse_datetime(row["forget_after"]),
        strength=float(row["strength"]),
    )


def dict_from_optional(metadata: dict[str, object] | None) -> dict[str, object]:
    return dict(metadata or {})


def coerce_metadata(metadata: dict[str, object] | None) -> str:
    return dumps_json(dict_from_optional(metadata))


def values_for_json(values: list[str]) -> str:
    return dumps_json(values)
