from __future__ import annotations

import json
import sqlite3
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from quilin_mem.scratchpad import ScratchpadStore
from quilin_mem.server import create_server
from quilin_mem.store import QuilinMemStore
from quilin_mem.store_schema import ensure_store_schema


@pytest.fixture
async def store_fixture() -> AsyncIterator[QuilinMemStore]:
    async with QuilinMemStore(db_path=":memory:") as bound_store:
        yield bound_store


@pytest.fixture
async def scratchpad_store() -> AsyncIterator[ScratchpadStore]:
    async with ScratchpadStore(db_path=":memory:") as bound_store:
        yield bound_store


@pytest.fixture
def server(store_fixture: QuilinMemStore, scratchpad_store: ScratchpadStore):
    return create_server(store_fixture, scratchpad_store)


def _decode_call_tool_result(result: object) -> dict[str, object]:
    if hasattr(result, "root"):
        content_items = getattr(result.root, "content", [])  # type: ignore[attr-defined]
        text = "\n".join(
            item.text for item in content_items if getattr(item, "type", None) == "text"
        )
        return json.loads(text)

    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


async def test_schema_adds_archived_at_for_recoverable_deletes(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "destructive-guard.db"))

    columns = {
        row["name"]: row["dflt_value"]
        for row in store._conn.execute("PRAGMA table_info(memory_records)").fetchall()  # type: ignore[attr-defined]
    }

    assert columns["archived_at"] is None
    assert columns["recovered_at"] is None


async def test_schema_backfills_archived_at_for_legacy_soft_deleted_rows(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "legacy-soft-delete.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE memory_records (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            tier TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            metadata_json TEXT NOT NULL DEFAULT '{"schema_version":1}',
            embedding_json TEXT,
            created_at TEXT NOT NULL,
            last_accessed TEXT NOT NULL,
            access_count INTEGER NOT NULL DEFAULT 0,
            importance_score REAL NOT NULL DEFAULT 0.5,
            deleted INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 1,
            parent_id TEXT,
            supersedes_json TEXT,
            is_latest INTEGER NOT NULL DEFAULT 1,
            source_event_id TEXT,
            evidence_hash TEXT,
            forget_after TEXT,
            strength REAL NOT NULL DEFAULT 1.0
        )
        """
    )
    deleted_at = datetime.now(UTC) - timedelta(minutes=1)
    conn.execute(
        """
        INSERT INTO memory_records (
            id, content, tier, created_at, last_accessed, deleted, forget_after
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "legacy-deleted",
            "legacy deleted fact",
            "episodic",
            (deleted_at - timedelta(days=1)).isoformat(),
            (deleted_at - timedelta(days=1)).isoformat(),
            1,
            deleted_at.isoformat(),
        ),
    )
    ensure_store_schema(conn, now=lambda: datetime.now(UTC), rebuild_fts_index=lambda: None)
    row = conn.execute(
        "SELECT archived_at FROM memory_records WHERE id = ?",
        ("legacy-deleted",),
    ).fetchone()
    conn.close()

    assert row["archived_at"] == deleted_at.isoformat()

    store = QuilinMemStore(db_path=str(db_path))
    try:
        assert await store.recover_memory("legacy-deleted") is True
        assert await store.get("legacy-deleted") is not None
    finally:
        await store.close()


async def test_delete_archives_record_and_preview_reports_impact(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "delete-preview.db"))
    record = await store.store("keep a recoverable audit trail", tier="episodic")

    preview = await store.preview_delete(record.id)
    assert preview.memory_id == record.id
    assert preview.exists is True
    assert preview.currently_visible is True
    assert preview.would_archive is True
    assert preview.affected_records == 1
    assert preview.recoverable is True
    assert preview.recommended_action == "archive_then_recover_if_needed"

    await store.delete(record.id)

    row = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT deleted, archived_at, forget_after FROM memory_records WHERE id = ?",
        (record.id,),
    ).fetchone()
    assert row["deleted"] == 1
    assert row["archived_at"] is not None
    assert row["forget_after"] is not None

    after = await store.preview_delete(record.id)
    assert after.exists is True
    assert after.currently_visible is False
    assert after.would_archive is False
    assert after.affected_records == 0


async def test_recover_memory_restores_archived_record_to_current_indexes(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "recover.db"))
    record = await store.store("recoverable project fact", tier="episodic")

    await store.delete(record.id)
    assert await store.get(record.id) is None
    assert await store.search("recoverable project fact") == []

    restored = await store.recover_memory(record.id)

    assert restored is True
    fetched = await store.get(record.id)
    assert fetched is not None
    assert fetched.content == "recoverable project fact"
    assert await store.search("recoverable project fact")

    row = store._conn.execute(  # type: ignore[attr-defined]
        """
        SELECT deleted, archived_at, recovered_at, forget_after
        FROM memory_records
        WHERE id = ?
        """,
        (record.id,),
    ).fetchone()
    assert row["deleted"] == 0
    assert row["archived_at"] is not None
    assert row["recovered_at"] is not None
    assert row["forget_after"] == row["archived_at"]


async def test_delete_preview_treats_recovered_record_as_currently_visible(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "recover-preview.db"))
    record = await store.store("recovered preview fact", tier="episodic")

    await store.delete(record.id)
    await store.recover_memory(record.id)

    preview = await store.preview_delete(record.id)
    assert preview.currently_visible is True
    assert preview.would_archive is True
    assert preview.affected_records == 1
    assert preview.recoverable is True


async def test_recovered_record_can_be_superseded(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "recover-supersede.db"))
    record = await store.store("old recovered fact", tier="episodic")

    await store.delete(record.id)
    await store.recover_memory(record.id)

    replacement = record.__class__(
        id="new-recovered-fact",
        content="new recovered fact",
        layer="episodic",
        created_at=datetime.now(UTC) + timedelta(seconds=1),
    )
    replacement_id = await store.supersede_memory(record.id, replacement)

    assert replacement_id == "new-recovered-fact"
    assert await store.get(record.id) is None
    assert (await store.get(replacement.id)).content == "new recovered fact"


async def test_delete_preview_does_not_mark_superseded_recovered_record_recoverable(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "recover-preview-superseded.db"))
    record = await store.store("old recovered preview fact", tier="episodic")
    await store.delete(record.id)
    await store.recover_memory(record.id)
    replacement = record.__class__(
        id="new-preview-fact",
        content="new preview fact",
        layer="episodic",
        created_at=datetime.now(UTC) + timedelta(seconds=1),
    )
    await store.supersede_memory(record.id, replacement)

    preview = await store.preview_delete(record.id)

    assert preview.currently_visible is False
    assert preview.would_archive is False
    assert preview.affected_records == 0
    assert preview.recoverable is False


async def test_recover_memory_rejects_records_outside_soft_delete_window(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "recover-window.db"))
    record = await store.store("too old to recover", tier="episodic")
    await store.delete(record.id)

    old_archive_time = datetime.now(UTC) - timedelta(days=30)
    store._conn.execute(  # type: ignore[attr-defined]
        "UPDATE memory_records SET archived_at = ? WHERE id = ?",
        (old_archive_time.isoformat(), record.id),
    )

    with pytest.raises(ValueError, match="recovery window expired"):
        await store.recover_memory(record.id, recovery_window=timedelta(days=7))

    assert await store.get(record.id) is None


async def test_delete_preview_handles_missing_and_superseded_records(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "preview-hidden.db"))
    first = await store.store("old nickname is Lao Meng", tier="episodic")
    replacement = await store.store("placeholder", tier="episodic")
    await store.delete(replacement.id)
    await store.supersede_memory(
        first.id,
        replacement.__class__(
            id="new-nickname",
            content="preferred nickname is Meng Ge",
            layer="episodic",
            created_at=first.created_at + timedelta(seconds=1),
        ),
    )

    missing = await store.preview_delete("missing")
    assert missing.exists is False
    assert missing.currently_visible is False
    assert missing.would_archive is False
    assert missing.affected_records == 0

    old = await store.preview_delete(first.id)
    assert old.exists is True
    assert old.currently_visible is False
    assert old.would_archive is False
    assert old.affected_records == 0


async def test_recover_memory_is_idempotent_for_visible_or_missing_records(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "recover-idempotent.db"))
    record = await store.store("visible fact", tier="episodic")

    assert await store.recover_memory(record.id) is False
    assert await store.recover_memory("missing") is False


async def test_delete_still_preserves_checkout_before_delete(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "checkout-delete.db"))
    created_at = datetime(2026, 1, 1, tzinfo=UTC)
    record = await store.store("historical delete fact", tier="episodic")
    store._conn.execute(  # type: ignore[attr-defined]
        "UPDATE memory_records SET created_at = ?, last_accessed = ? WHERE id = ?",
        (created_at.isoformat(), created_at.isoformat(), record.id),
    )

    await store.delete(record.id)

    before = await store.checkout_at(created_at + timedelta(seconds=1))
    assert [(item.id, item.content) for item in before] == [(record.id, "historical delete fact")]
    assert await store.checkout_at(datetime.now(UTC) + timedelta(seconds=1)) == []


async def test_recover_preserves_deleted_interval_in_checkout(tmp_path: Path) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "recover-checkout.db"))
    record = await store.store("recovered historical fact", tier="episodic")
    created_at = datetime.now(UTC) - timedelta(days=1)
    store._conn.execute(  # type: ignore[attr-defined]
        """
        UPDATE memory_records
        SET created_at = ?, last_accessed = ?
        WHERE id = ?
        """,
        (
            created_at.isoformat(),
            created_at.isoformat(),
            record.id,
        ),
    )

    await store.delete(record.id)
    row_after_delete = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT archived_at FROM memory_records WHERE id = ?",
        (record.id,),
    ).fetchone()
    delete_at = datetime.fromisoformat(row_after_delete["archived_at"])

    await store.recover_memory(record.id)
    row_after_recover = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT recovered_at FROM memory_records WHERE id = ?",
        (record.id,),
    ).fetchone()
    recover_at = datetime.fromisoformat(row_after_recover["recovered_at"])

    before_delete = await store.checkout_at(delete_at - timedelta(microseconds=1))
    during_delete = await store.checkout_at(delete_at + timedelta(microseconds=1))
    after_recover = await store.checkout_at(recover_at + timedelta(microseconds=1))

    assert [item.id for item in before_delete] == [record.id]
    assert during_delete == []
    assert [item.id for item in after_recover] == [record.id]


async def test_repeated_delete_recover_preserves_all_deleted_intervals(
    tmp_path: Path,
) -> None:
    store = QuilinMemStore(db_path=str(tmp_path / "repeat-delete.db"))
    record = await store.store("repeat delete fact", tier="episodic")
    created_at = datetime.now(UTC) - timedelta(days=1)
    store._conn.execute(  # type: ignore[attr-defined]
        """
        UPDATE memory_records
        SET created_at = ?, last_accessed = ?
        WHERE id = ?
        """,
        (created_at.isoformat(), created_at.isoformat(), record.id),
    )

    await store.delete(record.id)
    first_delete_at = datetime.fromisoformat(
        store._conn.execute(  # type: ignore[attr-defined]
            "SELECT archived_at FROM memory_records WHERE id = ?",
            (record.id,),
        ).fetchone()["archived_at"]
    )
    await store.recover_memory(record.id)
    first_recover_at = datetime.fromisoformat(
        store._conn.execute(  # type: ignore[attr-defined]
            "SELECT recovered_at FROM memory_records WHERE id = ?",
            (record.id,),
        ).fetchone()["recovered_at"]
    )
    await store.delete(record.id)
    second_delete_at = datetime.fromisoformat(
        store._conn.execute(  # type: ignore[attr-defined]
            "SELECT archived_at FROM memory_records WHERE id = ?",
            (record.id,),
        ).fetchone()["archived_at"]
    )

    before_first_delete = await store.checkout_at(first_delete_at - timedelta(microseconds=1))
    during_first_delete = await store.checkout_at(first_delete_at + timedelta(microseconds=1))
    after_first_recover = await store.checkout_at(first_recover_at + timedelta(microseconds=1))
    after_second_delete = await store.checkout_at(second_delete_at + timedelta(microseconds=1))

    assert [item.id for item in before_first_delete] == [record.id]
    assert during_first_delete == []
    assert [item.id for item in after_first_recover] == [record.id]
    assert after_second_delete == []


async def test_memory_delete_preview_and_recover_tools(server: object) -> None:
    stored = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_store",
            {"content": "tool recoverable fact", "tier": "episodic"},
        )
    )
    memory_id = stored["id"]

    preview = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_delete_preview",
            {"memory_id": memory_id},
        )
    )
    assert preview["would_archive"] is True
    assert preview["recoverable"] is True

    await server.call_tool("memory_delete", {"memory_id": memory_id})  # type: ignore[attr-defined]
    recovered = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_recover",
            {"memory_id": memory_id},
        )
    )
    assert recovered == {"ok": True, "memory_id": memory_id, "recovered": True}

    payload = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_recall",
            {"query": "tool recoverable"},
        )
    )
    assert any(item["id"] == memory_id for item in payload["records"])
