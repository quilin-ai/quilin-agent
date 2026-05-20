from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from .store_schema import DEFAULT_MEMORY_METADATA
from .types import VALID_MEMORY_TIERS, MemoryRecord, MemoryTier

LEGACY_MEMORY_TIER_ALIASES: dict[str, MemoryTier] = {
    "short": "working",
    "long": "semantic",
}


def validate_memory_tier(tier: str) -> MemoryTier:
    if tier not in VALID_MEMORY_TIERS:
        valid_tiers = ", ".join(VALID_MEMORY_TIERS)
        raise ValueError(f"Invalid memory tier: {tier}. Expected one of: {valid_tiers}")

    return tier


def deserialize_memory_tier(tier: str) -> MemoryTier:
    legacy_tier = LEGACY_MEMORY_TIER_ALIASES.get(tier)
    if legacy_tier is not None:
        return legacy_tier

    return validate_memory_tier(tier)


def serialize_metadata(metadata: dict[str, object]) -> str:
    return json.dumps(metadata, allow_nan=False, ensure_ascii=False, sort_keys=True)


def deserialize_metadata(metadata_json: str | None) -> dict[str, object]:
    if not metadata_json:
        return json.loads(DEFAULT_MEMORY_METADATA)

    loaded = json.loads(metadata_json)
    if not isinstance(loaded, dict):
        return json.loads(DEFAULT_MEMORY_METADATA)

    if "schema_version" not in loaded:
        loaded["schema_version"] = 1

    return dict(loaded)


def serialize_embedding(embedding: list[float] | None) -> str | None:
    if embedding is None:
        return None

    return json.dumps(embedding)


def deserialize_embedding(embedding_json: str | None) -> list[float] | None:
    if not embedding_json:
        return None

    loaded = json.loads(embedding_json)
    if not isinstance(loaded, list):
        return None

    return [float(value) for value in loaded]


def serialize_json_object(payload: dict[str, object] | None) -> str | None:
    if payload is None:
        return None

    return json.dumps(payload, allow_nan=False, ensure_ascii=False, sort_keys=True)


def deserialize_json_object(payload_json: str | None) -> dict[str, object] | None:
    if not payload_json:
        return None

    loaded = json.loads(payload_json)
    if not isinstance(loaded, dict):
        return None

    return dict(loaded)


def parse_datetime(raw_value: str | None, *, now: Callable[[], datetime]) -> datetime:
    if not raw_value:
        return now()

    return datetime.fromisoformat(raw_value)


def parse_optional_datetime(raw_value: str | None) -> datetime | None:
    if not raw_value:
        return None

    parsed = datetime.fromisoformat(raw_value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def row_get(row: sqlite3.Row, key: str) -> Any | None:
    if key not in tuple(row.keys()):
        return None
    return row[key]


def row_to_record(row: sqlite3.Row, *, now: Callable[[], datetime]) -> MemoryRecord:
    return MemoryRecord(
        id=row["id"],
        content=row["content"],
        content_type=row["content_type"],
        layer=deserialize_memory_tier(row["tier"]),
        metadata=deserialize_metadata(row["metadata_json"]),
        embedding=deserialize_embedding(row["embedding_json"]),
        created_at=parse_datetime(row["created_at"], now=now),
        last_accessed=parse_datetime(row["last_accessed"], now=now),
        access_count=int(row["access_count"]),
        importance_score=float(row["importance_score"]),
        last_writer_client=row_get(row, "last_writer_client"),
        last_writer_session_id=row_get(row, "last_writer_session_id"),
        project_scope=row_get(row, "project_scope"),
        salience=deserialize_json_object(row_get(row, "salience_json")),
        kind=row_get(row, "kind"),
        deadline_at=parse_optional_datetime(row_get(row, "deadline_at")),
        prospective_action=row_get(row, "prospective_action"),
        resource_pointer=deserialize_json_object(row_get(row, "resource_pointer_json")),
    )
