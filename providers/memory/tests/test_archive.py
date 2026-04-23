from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from omnimem.archive import (
    ARCHIVE_SCHEMA_COMPONENT,
    ARCHIVE_SCHEMA_VERSION,
    ArchiveManifestStore,
    ArchivePolicy,
    build_archive_manifest_entry,
)
from omnimem.types import MemoryItem


def _memory(
    memory_id: str,
    *,
    age_days: int,
    importance_score: float = 0.5,
) -> MemoryItem:
    created_at = datetime(2026, 1, 1, tzinfo=UTC) - timedelta(days=age_days)
    return MemoryItem(
        id=memory_id,
        content=f"episodic content {memory_id}",
        layer="episodic",
        metadata={"schema_version": 1, "session_id": "session-1"},
        created_at=created_at,
        last_accessed=created_at,
        importance_score=importance_score,
    )


def test_archive_policy_classifies_old_low_importance_items_as_cold() -> None:
    policy = ArchivePolicy(cold_after_days=30, min_importance_for_hot=0.8)
    now = datetime(2026, 1, 1, tzinfo=UTC)

    assert policy.classify(_memory("cold", age_days=31), now=now) == "cold"
    assert (
        policy.classify(_memory("important", age_days=365, importance_score=0.95), now=now) == "hot"
    )
    assert policy.classify(_memory("recent", age_days=3), now=now) == "hot"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"cold_after_days": 0},
        {"min_importance_for_hot": 1.5},
        {"capacity_target_per_user": 0},
    ],
)
def test_archive_policy_rejects_invalid_thresholds(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        ArchivePolicy(**kwargs)


def test_build_archive_manifest_entry_freezes_capacity_and_compression_stub() -> None:
    policy = ArchivePolicy(
        cold_after_days=30,
        capacity_target_per_user=100_000,
        compression="zstd-stub",
    )
    memory = _memory("memory-1", age_days=45)
    archived_at = datetime(2026, 1, 1, tzinfo=UTC)

    entry = build_archive_manifest_entry(
        memory,
        user_id="user-1",
        policy=policy,
        now=archived_at,
    )

    assert entry.temperature == "cold"
    assert entry.compression == "zstd-stub"
    assert entry.archive_key == "users/user-1/episodic/memory-1.json"
    assert entry.original_bytes == len(memory.content.encode("utf-8"))
    assert entry.compressed_bytes == entry.original_bytes
    assert entry.metadata == {
        "schema_version": 1,
        "capacity_target_per_user": 100_000,
        "source_layer": "episodic",
    }


def test_archive_manifest_store_records_schema_version_and_lists_by_user() -> None:
    store = ArchiveManifestStore(db_path=":memory:")
    now = datetime(2026, 1, 1, tzinfo=UTC)
    hot = build_archive_manifest_entry(
        _memory("hot", age_days=3),
        user_id="user-1",
        now=now,
    )
    cold = build_archive_manifest_entry(
        _memory("cold", age_days=365),
        user_id="user-1",
        now=now,
    )
    other_user = build_archive_manifest_entry(
        _memory("other", age_days=365),
        user_id="user-2",
        now=now,
    )

    store.record(cold)
    store.record(hot)
    store.record(other_user)

    assert store.get("cold") == cold
    assert [entry.memory_id for entry in store.list_for_user("user-1")] == ["cold", "hot"]
    assert [entry.memory_id for entry in store.list_for_user("user-1", temperature="cold")] == [
        "cold"
    ]
    schema_row = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT version FROM schema_version WHERE component = ?",
        (ARCHIVE_SCHEMA_COMPONENT,),
    ).fetchone()
    assert schema_row["version"] == ARCHIVE_SCHEMA_VERSION

    store.close()
