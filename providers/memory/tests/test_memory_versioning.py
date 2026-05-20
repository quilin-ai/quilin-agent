from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest

from quilin_mem.store import QuilinMemStore
from quilin_mem.store_versioning import (
    loads_object,
    loads_string_list,
    row_to_observation,
    row_to_snapshot,
    row_to_source,
)
from quilin_mem.types import MemoryItem


def _column_defaults(conn: sqlite3.Connection) -> dict[str, object]:
    return {
        row["name"]: row["dflt_value"]
        for row in conn.execute("PRAGMA table_info(memory_records)").fetchall()
    }


async def test_schema_adds_version_columns_and_evidence_tables(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "memory.db"))

    columns = _column_defaults(store._conn)  # type: ignore[attr-defined]
    assert columns["version"] == "1"
    assert columns["parent_id"] is None
    assert columns["supersedes_json"] is None
    assert columns["is_latest"] == "1"
    assert columns["source_event_id"] is None
    assert columns["evidence_hash"] is None
    assert columns["forget_after"] is None
    assert columns["strength"] == "1.0"

    table_names = {
        row[0]
        for row in store._conn.execute(  # type: ignore[attr-defined]
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    assert {"memory_sources", "memory_observations", "memory_snapshot"} <= table_names


async def test_schema_backfills_legacy_records_with_default_safe_values(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "legacy.db"
    legacy = sqlite3.connect(db_path)
    legacy.execute(
        """
        CREATE TABLE memory_records (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            tier TEXT NOT NULL CHECK (
                tier IN ('working', 'episodic', 'semantic', 'skill')
            )
        )
        """
    )
    legacy.execute(
        "INSERT INTO memory_records (id, content, tier) VALUES (?, ?, ?)",
        ("legacy-1", "legacy content", "working"),
    )
    legacy.commit()
    legacy.close()

    store = QuilinMemStore(db_path=str(db_path))

    row = store._conn.execute(  # type: ignore[attr-defined]
        """
        SELECT version, parent_id, supersedes_json, is_latest, source_event_id,
               evidence_hash, forget_after, strength
        FROM memory_records
        WHERE id = ?
        """,
        ("legacy-1",),
    ).fetchone()
    assert dict(row) == {
        "version": 1,
        "parent_id": None,
        "supersedes_json": None,
        "is_latest": 1,
        "source_event_id": None,
        "evidence_hash": None,
        "forget_after": None,
        "strength": 1.0,
    }


async def test_old_memory_item_wire_payload_round_trips_without_new_fields(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "payload.db"))
    memory = MemoryItem(
        id="payload-1",
        content="unchanged payload",
        layer="episodic",
        metadata={"schema_version": 1, "source": "unit"},
        created_at=datetime(2026, 5, 20, tzinfo=UTC),
    )

    await store.add(memory)

    fetched = await store.get(memory.id)
    assert fetched is not None
    assert fetched.to_wire_dict() == {
        **memory.to_wire_dict(),
        "last_accessed": fetched.last_accessed.isoformat(),
        "access_count": 1,
    }
    assert {
        "version",
        "parent_id",
        "supersedes_json",
        "is_latest",
        "source_event_id",
        "evidence_hash",
        "forget_after",
        "strength",
    }.isdisjoint(fetched.to_wire_dict())


async def test_record_observation_persists_raw_evidence_with_hash(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "evidence.db"))
    observed_at = datetime(2026, 5, 20, 10, 0, tzinfo=UTC)

    observation = await store.record_observation(
        content="User said: I prefer concise answers.",
        source_event_id="turn-001",
        observed_at=observed_at,
        actor_id="user",
        role="user",
        metadata={"channel": "chat"},
    )

    assert observation.id
    assert observation.source_event_id == "turn-001"
    assert observation.content_hash
    assert observation.observed_at == observed_at
    row = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT content_hash FROM memory_observations WHERE id = ?",
        (observation.id,),
    ).fetchone()
    assert row["content_hash"] == observation.content_hash


async def test_memory_source_links_derived_fact_to_observation(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "sources.db"))
    record = await store.store(
        "User prefers concise answers.",
        tier="semantic",
        metadata={
            "schema_version": 1,
            "source": "observer",
            "stability_reason": "Repeated preference in chat.",
        },
    )
    observation = await store.record_observation(
        content="Please be concise.",
        source_event_id="turn-002",
    )

    source = await store.link_memory_source(
        memory_id=record.id,
        observation_id=observation.id,
        source_type="observation",
        source_uri="conversation://turn-002",
        metadata={"extractor": "unit"},
    )

    assert source.memory_id == record.id
    assert source.observation_id == observation.id
    assert source.source_uri == "conversation://turn-002"
    assert await store.get_memory_sources(record.id) == [source]


async def test_supersede_creates_new_version_and_hides_old_from_retrieval(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "versions.db"))
    old = await store.store(
        "User likes verbose answers.",
        tier="semantic",
        metadata={
            "schema_version": 1,
            "source": "observer",
            "stability_reason": "Initial preference.",
        },
    )

    new_id = await store.supersede_memory(
        old.id,
        MemoryItem(
            id="version-2",
            content="User prefers concise answers.",
            layer="semantic",
            metadata={
                "schema_version": 1,
                "source": "correction",
                "stability_reason": "User corrected the preference.",
            },
        ),
        source_event_id="turn-003",
        evidence_hash="hash-003",
    )

    assert new_id == "version-2"
    old_version = await store.get_version_info(old.id)
    new_version = await store.get_version_info(new_id)
    assert old_version.is_latest is False
    assert new_version.version == 2
    assert new_version.parent_id == old.id
    assert new_version.supersedes == [old.id]
    assert new_version.source_event_id == "turn-003"
    assert new_version.evidence_hash == "hash-003"

    results = await store.search("answers")
    assert [item.id for item in results] == [new_id]


async def test_supersede_rejects_non_latest_parent_to_prevent_branch_heads(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "branch.db"))
    old = await store.store("User prefers terse answers.", tier="working")
    await store.supersede_memory(
        old.id,
        MemoryItem(id="branch-v2", content="User prefers concise answers.", layer="working"),
    )

    with pytest.raises(ValueError, match="non-latest"):
        await store.supersede_memory(
            old.id,
            MemoryItem(
                id="branch-v2b",
                content="User prefers long answers.",
                layer="working",
            ),
        )

    rows = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT id, is_latest FROM memory_records ORDER BY rowid ASC"
    ).fetchall()
    assert [(row["id"], row["is_latest"]) for row in rows] == [
        (old.id, 0),
        ("branch-v2", 1),
    ]


async def test_update_does_not_mutate_superseded_history(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "immutable-history.db"))
    t1 = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    old = MemoryItem(
        id="history-v1",
        content="Original historical content.",
        layer="semantic",
        metadata={
            "schema_version": 1,
            "source": "observer",
            "stability_reason": "Initial observation.",
        },
        created_at=t1,
    )
    await store.add(old)
    await store.supersede_memory(
        old.id,
        MemoryItem(
            id="history-v2",
            content="Corrected current content.",
            layer="semantic",
            metadata={
                "schema_version": 1,
                "source": "correction",
                "stability_reason": "Correction observation.",
            },
            created_at=t1 + timedelta(hours=1),
        ),
    )

    await store.update(old.id, "MUTATED historical content.")
    before_supersede = await store.checkout_at(t1 + timedelta(minutes=30))

    assert [(item.id, item.content) for item in before_supersede] == [
        (old.id, "Original historical content.")
    ]


async def test_update_does_not_mutate_latest_history(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "latest-update-history.db"))
    t1 = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    record = MemoryItem(
        id="latest-update",
        content="Original latest content.",
        layer="working",
        created_at=t1,
    )
    await store.add(record)

    await store.update(record.id, "Mutated current content.")
    before_update = await store.checkout_at(t1 + timedelta(minutes=1))

    assert [(item.id, item.content) for item in before_update] == [
        (record.id, "Original latest content.")
    ]
    current = await store.get(record.id)
    assert current is not None
    assert current.content == "Mutated current content."


async def test_delete_does_not_remove_superseded_history(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "delete-history.db"))
    t1 = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    old = MemoryItem(
        id="delete-history-v1",
        content="Historical content before delete.",
        layer="working",
        created_at=t1,
    )
    await store.add(old)
    await store.supersede_memory(
        old.id,
        MemoryItem(
            id="delete-history-v2",
            content="Current content after supersede.",
            layer="working",
            created_at=t1 + timedelta(hours=1),
        ),
    )

    await store.delete(old.id)
    before_supersede = await store.checkout_at(t1 + timedelta(minutes=30))

    assert [(item.id, item.content) for item in before_supersede] == [
        (old.id, "Historical content before delete.")
    ]


async def test_delete_does_not_remove_latest_history(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "latest-delete-history.db"))
    t1 = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    record = MemoryItem(
        id="latest-delete",
        content="Content before delete.",
        layer="working",
        created_at=t1,
    )
    await store.add(record)

    await store.delete(record.id)
    before_delete = await store.checkout_at(t1 + timedelta(minutes=1))

    assert [(item.id, item.content) for item in before_delete] == [
        (record.id, "Content before delete.")
    ]
    assert await store.get(record.id) is None


async def test_clear_layer_does_not_remove_latest_history(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "clear-history.db"))
    t1 = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    record = MemoryItem(
        id="clear-history",
        content="Content before clear.",
        layer="working",
        created_at=t1,
    )
    await store.add(record)

    assert await store.clear_layer("working") == 1
    before_clear = await store.checkout_at(t1 + timedelta(minutes=1))

    assert [(item.id, item.content) for item in before_clear] == [
        (record.id, "Content before clear.")
    ]
    assert await store.get(record.id) is None


async def test_clear_layer_ignores_expired_currently_hidden_records(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "clear-expired.db"))
    expired = await store.store("Expired hidden clear target.", tier="working")
    store._conn.execute(  # type: ignore[attr-defined]
        "UPDATE memory_records SET forget_after = ? WHERE id = ?",
        ((datetime.now(UTC) - timedelta(days=1)).isoformat(), expired.id),
    )

    assert await store.clear_layer("working") == 0
    row = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT deleted FROM memory_records WHERE id = ?",
        (expired.id,),
    ).fetchone()
    assert row["deleted"] == 0


async def test_memory_source_rejects_missing_memory_or_observation(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "source-integrity.db"))
    record = await store.store("Source-backed fact.", tier="working")
    observation = await store.record_observation(content="raw source")

    with pytest.raises(KeyError, match="memory record not found"):
        await store.link_memory_source(
            memory_id="missing-memory",
            observation_id=observation.id,
        )
    with pytest.raises(KeyError, match="memory observation not found"):
        await store.link_memory_source(
            memory_id=record.id,
            observation_id="missing-observation",
        )

    assert await store.get_memory_sources(record.id) == []


async def test_checkout_at_returns_version_that_was_current_at_that_time(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "checkout.db"))
    t1 = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    t2 = t1 + timedelta(hours=1)
    old = MemoryItem(
        id="chain-1",
        content="Project status is red.",
        layer="semantic",
        metadata={
            "schema_version": 1,
            "source": "observer",
            "stability_reason": "Status update.",
        },
        created_at=t1,
    )
    await store.add(old)
    await store.supersede_memory(
        old.id,
        MemoryItem(
            id="chain-2",
            content="Project status is green.",
            layer="semantic",
            metadata={
                "schema_version": 1,
                "source": "correction",
                "stability_reason": "Later status update.",
            },
            created_at=t2,
        ),
    )

    before = await store.checkout_at(t1 + timedelta(minutes=30))
    after = await store.checkout_at(t2 + timedelta(minutes=30))

    assert [item.id for item in before] == ["chain-1"]
    assert [item.id for item in after] == ["chain-2"]


async def test_snapshot_checkout_returns_frozen_memory_set_after_later_changes(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "snapshot.db"))
    t1 = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    old = MemoryItem(
        id="snapshot-1",
        content="Pinned state before correction.",
        layer="semantic",
        metadata={
            "schema_version": 1,
            "source": "observer",
            "stability_reason": "Snapshot fixture.",
        },
        created_at=t1,
    )
    await store.add(old)

    snapshot = await store.create_snapshot(label="before-correction", at=t1)
    await store.supersede_memory(
        old.id,
        MemoryItem(
            id="snapshot-2",
            content="Pinned state after correction.",
            layer="semantic",
            metadata={
                "schema_version": 1,
                "source": "correction",
                "stability_reason": "Snapshot fixture correction.",
            },
            created_at=t1 + timedelta(minutes=1),
        ),
    )

    restored = await store.checkout_snapshot(snapshot.id)

    assert snapshot.label == "before-correction"
    assert snapshot.memory_ids == ["snapshot-1"]
    assert [item.id for item in restored] == ["snapshot-1"]


async def test_snapshot_checkout_returns_frozen_content_after_update(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "snapshot-content.db"))
    record = await store.store("Frozen snapshot content.", tier="working")

    snapshot = await store.create_snapshot(label="before-update")
    await store.update(record.id, "Mutated after snapshot.")
    restored = await store.checkout_snapshot(snapshot.id)

    assert [(item.id, item.content) for item in restored] == [
        (record.id, "Frozen snapshot content.")
    ]


async def test_snapshot_checkout_supports_legacy_id_only_snapshots(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "legacy-snapshot.db"))
    record = await store.store("Legacy snapshot content.", tier="working")
    snapshot_at = datetime.now(UTC)
    store._conn.execute(  # type: ignore[attr-defined]
        """
        INSERT INTO memory_snapshot (
            id,
            label,
            snapshot_at,
            memory_ids_json,
            records_json,
            signature_hash,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "legacy-snapshot",
            "legacy",
            snapshot_at.isoformat(),
            f'["{record.id}"]',
            None,
            "legacy-signature",
            snapshot_at.isoformat(),
        ),
    )

    restored = await store.checkout_snapshot("legacy-snapshot")

    assert [(item.id, item.content) for item in restored] == [
        (record.id, "Legacy snapshot content.")
    ]


async def test_snapshot_checkout_accepts_legacy_tier_alias_payload(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "legacy-payload-snapshot.db"))
    snapshot_at = datetime.now(UTC)
    store._conn.execute(  # type: ignore[attr-defined]
        """
        INSERT INTO memory_snapshot (
            id,
            label,
            snapshot_at,
            memory_ids_json,
            records_json,
            signature_hash,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "legacy-payload-snapshot",
            "legacy-payload",
            snapshot_at.isoformat(),
            '["legacy-short"]',
            '[{"id":"legacy-short","content":"Legacy alias content.","tier":"short"}]',
            "legacy-payload-signature",
            snapshot_at.isoformat(),
        ),
    )

    restored = await store.checkout_snapshot("legacy-payload-snapshot")

    assert [(item.id, item.content, item.layer) for item in restored] == [
        ("legacy-short", "Legacy alias content.", "working")
    ]


async def test_history_overlay_ignores_malformed_internal_snapshots(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "malformed-history.db"))
    record = await store.store("History overlay survives malformed rows.", tier="working")
    snapshot_at = datetime.now(UTC) + timedelta(minutes=1)
    for snapshot_id, records_json in (
        ("bad-history-object", "{}"),
        ("bad-history-list", '["not-a-record"]'),
    ):
        store._conn.execute(  # type: ignore[attr-defined]
            """
            INSERT INTO memory_snapshot (
                id,
                label,
                snapshot_at,
                memory_ids_json,
                records_json,
                signature_hash,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                snapshot_id,
                f"__history__:bad:{record.id}",
                snapshot_at.isoformat(),
                f'["{record.id}"]',
                records_json,
                "bad-signature",
                snapshot_at.isoformat(),
            ),
        )

    restored = await store.checkout_at(snapshot_at - timedelta(seconds=1))

    assert [(item.id, item.content) for item in restored] == [
        (record.id, "History overlay survives malformed rows.")
    ]


async def test_checkout_excludes_expired_memories(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "ttl.db"))
    created_at = datetime(2026, 5, 20, 8, 0, tzinfo=UTC)
    record = MemoryItem(
        id="ttl-1",
        content="Temporary preference",
        layer="working",
        created_at=created_at,
    )
    await store.add(record)
    store._conn.execute(  # type: ignore[attr-defined]
        "UPDATE memory_records SET forget_after = ? WHERE id = ?",
        (datetime(2026, 5, 20, 10, 0, tzinfo=UTC).isoformat(), record.id),
    )

    active = await store.checkout_at(datetime(2026, 5, 20, 9, 0, tzinfo=UTC))
    expired = await store.checkout_at(datetime(2026, 5, 20, 11, 0, tzinfo=UTC))

    assert [item.id for item in active] == [record.id]
    assert expired == []


async def test_current_visibility_excludes_expired_memories(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "current-ttl.db"))
    expired = await store.store("expiring visible memory", tier="working")
    active = await store.store("active visible memory", tier="working")
    store._conn.execute(  # type: ignore[attr-defined]
        "UPDATE memory_records SET forget_after = ? WHERE id = ?",
        ((datetime.now(UTC) - timedelta(days=1)).isoformat(), expired.id),
    )
    store._conn.execute(  # type: ignore[attr-defined]
        "UPDATE memory_records SET forget_after = ? WHERE id = ?",
        ((datetime.now(UTC) + timedelta(days=1)).isoformat(), active.id),
    )

    assert [item.id for item in await store.search("visible memory")] == [active.id]
    assert [item.id for item in await store.list_by_layer("working")] == [active.id]
    assert await store.count({"layer": "working"}) == 1


async def test_count_supports_created_date_filters(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "count-created.db"))
    old_created_at = datetime(2026, 5, 20, 9, 0, tzinfo=UTC)
    new_created_at = old_created_at + timedelta(hours=1)
    await store.add(
        MemoryItem(id="count-old", content="old", layer="working", created_at=old_created_at)
    )
    await store.add(
        MemoryItem(id="count-new", content="new", layer="working", created_at=new_created_at)
    )

    assert await store.count({"created_after": old_created_at + timedelta(minutes=30)}) == 1
    assert await store.count({"created_before": old_created_at + timedelta(minutes=30)}) == 1


async def test_supersede_rejects_replacement_created_before_parent(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "time-order.db"))
    parent_created_at = datetime(2026, 5, 20, 10, 0, tzinfo=UTC)
    parent = MemoryItem(
        id="time-parent",
        content="Parent fact.",
        layer="working",
        created_at=parent_created_at,
    )
    await store.add(parent)

    with pytest.raises(ValueError, match="created_at"):
        await store.supersede_memory(
            parent.id,
            MemoryItem(
                id="time-child",
                content="Time-travel child fact.",
                layer="working",
                created_at=parent_created_at - timedelta(minutes=30),
            ),
        )

    assert await store.checkout_at(parent_created_at - timedelta(minutes=15)) == []


async def test_supersede_rejects_expired_parent_without_resurrecting_it(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "expired-parent.db"))
    parent = await store.store("Expired parent fact.", tier="working")
    store._conn.execute(  # type: ignore[attr-defined]
        "UPDATE memory_records SET forget_after = ? WHERE id = ?",
        ((datetime.now(UTC) - timedelta(days=1)).isoformat(), parent.id),
    )

    with pytest.raises(ValueError, match="expired"):
        await store.supersede_memory(
            parent.id,
            MemoryItem(
                id="resurrected-child",
                content="Resurrected child fact.",
                layer="working",
                created_at=datetime.now(UTC) + timedelta(minutes=1),
            ),
        )

    assert await store.get(parent.id) is None
    assert await store.get("resurrected-child") is None


def test_versioning_json_helpers_tolerate_empty_or_wrong_shapes() -> None:
    assert loads_object(None) == {}
    assert loads_object('["not", "object"]') == {}
    assert loads_string_list(None) == []
    assert loads_string_list('{"not":"list"}') == []


def test_versioning_row_parsers_reject_missing_required_timestamps() -> None:
    with pytest.raises(ValueError, match="observed_at"):
        row_to_observation(
            cast(
                sqlite3.Row,
                {
                    "id": "obs-1",
                    "content": "raw",
                    "content_hash": "hash",
                    "observed_at": None,
                    "source_event_id": None,
                    "actor_id": None,
                    "role": None,
                    "metadata_json": "{}",
                },
            )
        )

    with pytest.raises(ValueError, match="created_at"):
        row_to_source(
            cast(
                sqlite3.Row,
                {
                    "id": "src-1",
                    "memory_record_id": "mem-1",
                    "observation_id": "obs-1",
                    "source_type": "observation",
                    "source_uri": None,
                    "metadata_json": "{}",
                    "created_at": None,
                },
            )
        )

    with pytest.raises(ValueError, match="timestamps"):
        row_to_snapshot(
            cast(
                sqlite3.Row,
                {
                    "id": "snap-1",
                    "label": None,
                    "snapshot_at": None,
                    "memory_ids_json": "[]",
                    "signature_hash": "hash",
                    "created_at": "2026-05-20T00:00:00+00:00",
                },
            )
        )
