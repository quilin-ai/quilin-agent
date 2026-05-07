from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import datetime

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
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True)


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


def parse_datetime(raw_value: str | None, *, now: Callable[[], datetime]) -> datetime:
    if not raw_value:
        return now()

    return datetime.fromisoformat(raw_value)


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
    )
