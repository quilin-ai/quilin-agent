from __future__ import annotations

import math
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from quilin_mem.store_filters import coerce_filter_datetime, layer_filter, matches_filters
from quilin_mem.store_serialization import (
    deserialize_embedding,
    deserialize_json_object,
    deserialize_memory_tier,
    deserialize_metadata,
    parse_datetime,
    parse_optional_datetime,
    row_to_record,
    serialize_embedding,
    serialize_json_object,
    serialize_metadata,
    validate_memory_tier,
)
from quilin_mem.types import MemoryItem


def test_store_serialization_handles_defaults_and_legacy_shapes() -> None:
    now = datetime(2026, 4, 25, tzinfo=UTC)

    assert deserialize_metadata(None) == {"schema_version": 1}
    assert deserialize_metadata("[]") == {"schema_version": 1}
    assert deserialize_metadata('{"source":"legacy"}') == {
        "schema_version": 1,
        "source": "legacy",
    }
    assert serialize_embedding([1.0, 2.5]) == "[1.0, 2.5]"
    assert deserialize_embedding('{"bad": true}') is None
    assert deserialize_embedding('[1, "2.5"]') == [1.0, 2.5]
    assert parse_datetime(None, now=lambda: now) == now


def test_row_to_record_uses_safe_defaults_for_nullable_legacy_rows() -> None:
    now = datetime(2026, 4, 25, tzinfo=UTC)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        """
        SELECT
            'memory-1' AS id,
            'hello' AS content,
            'text' AS content_type,
            'working' AS tier,
            NULL AS metadata_json,
            NULL AS embedding_json,
            NULL AS created_at,
            NULL AS last_accessed,
            0 AS access_count,
            0.5 AS importance_score
        """
    ).fetchone()

    record = row_to_record(row, now=lambda: now)
    conn.close()

    assert record.id == "memory-1"
    assert record.metadata == {"schema_version": 1}
    assert record.embedding is None
    assert record.created_at == now
    assert record.last_accessed == now
    assert record.kind is None
    assert record.salience is None


def test_serialize_json_object_rejects_non_finite_values() -> None:
    with pytest.raises(ValueError, match="JSON"):
        serialize_json_object({"novelty": math.nan})

    with pytest.raises(ValueError, match="JSON"):
        serialize_json_object({"score": math.inf})

    with pytest.raises(ValueError, match="JSON"):
        serialize_metadata({"score": math.nan})


def test_json_object_and_optional_datetime_helpers_cover_invalid_shapes() -> None:
    assert serialize_json_object(None) is None
    assert serialize_json_object({"b": 2, "a": 1}) == '{"a": 1, "b": 2}'
    assert deserialize_json_object(None) is None
    assert deserialize_json_object("") is None
    assert deserialize_json_object("[]") is None
    assert deserialize_json_object('{"ok": true}') == {"ok": True}
    assert parse_optional_datetime(None) is None
    assert parse_optional_datetime("") is None
    assert parse_optional_datetime("2026-05-21T10:00:00") == datetime(
        2026, 5, 21, 10, 0, tzinfo=UTC
    )


def test_memory_item_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError, match="Invalid memory kind"):
        MemoryItem(content="bad kind", kind="made-up-kind")


@pytest.mark.parametrize(
    ("legacy_tier", "canonical_tier"),
    [("short", "working"), ("long", "semantic")],
)
def test_row_to_record_maps_legacy_tier_aliases_without_accepting_new_writes(
    legacy_tier: str,
    canonical_tier: str,
) -> None:
    now = datetime(2026, 4, 25, tzinfo=UTC)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        """
        SELECT
            ? AS id,
            ? AS content,
            'text' AS content_type,
            ? AS tier,
            NULL AS metadata_json,
            NULL AS embedding_json,
            NULL AS created_at,
            NULL AS last_accessed,
            0 AS access_count,
            0.5 AS importance_score
        """,
        (
            f"memory-legacy-{legacy_tier}",
            f"legacy {legacy_tier} memory",
            legacy_tier,
        ),
    ).fetchone()

    record = row_to_record(row, now=lambda: now)
    conn.close()

    assert record.layer == canonical_tier
    assert deserialize_memory_tier(legacy_tier) == canonical_tier
    with pytest.raises(ValueError, match="Invalid memory tier"):
        validate_memory_tier(legacy_tier)


def test_store_filters_cover_aliases_dates_and_invalid_values() -> None:
    created_at = datetime(2026, 4, 25, 12, 0, tzinfo=UTC)
    item = MemoryItem(
        content="checkpoint",
        layer="episodic",
        content_type="json",
        metadata={"schema_version": 1, "session_id": "session-1"},
        created_at=created_at,
    )

    assert layer_filter(None) is None
    assert layer_filter({"content_type": "json"}) is None
    assert matches_filters(item, None) is True
    assert matches_filters(item, {"tier": "semantic"}) is False
    assert (
        matches_filters(
            item,
            {"created_after": created_at + timedelta(seconds=1)},
        )
        is False
    )
    assert coerce_filter_datetime(created_at.isoformat()) == created_at

    with pytest.raises(TypeError, match="datetime filters"):
        coerce_filter_datetime(1)
