from __future__ import annotations

from datetime import timedelta

from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem


async def test_same_project_different_writer_flags_conflict() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "same project conflict candidate",
            metadata={"schema_version": 1, "session_id": "session-a"},
            last_writer_client="cli",
            last_writer_session_id="session-a",
            project_scope="project:alpha",
        )

        await store.update(
            record.id,
            "same project edited by web",
            last_writer_client="web",
            last_writer_session_id="session-b",
            project_scope="project:alpha",
        )
        updated = await store.get(record.id)

    assert updated is not None
    assert updated.metadata["conflict_resolution_pending"] is True
    assert updated.metadata["conflict_with_client"] == "cli"
    assert updated.metadata["conflict_with_session_id"] == "session-a"
    assert updated.metadata["session_id"] == "session-a"
    assert updated.last_writer_client == "web"
    assert updated.last_writer_session_id == "session-b"
    assert updated.project_scope == "project:alpha"


async def test_different_project_scope_does_not_flag_conflict() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "cross project conflict candidate",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            project_scope="project:alpha",
        )

        await store.update(
            record.id,
            "cross project edited by web",
            last_writer_client="web",
            project_scope="project:beta",
        )
        updated = await store.get(record.id)

    assert updated is not None
    assert updated.metadata.get("conflict_resolution_pending") is not True
    assert updated.project_scope == "project:beta"


async def test_update_preserves_session_metadata_when_writer_session_changes() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "session metadata should survive writer changes",
            metadata={
                "schema_version": 1,
                "session_id": "observer-session",
                "source": "observer",
            },
            last_writer_client="cli",
            last_writer_session_id="writer-session-a",
            project_scope="project:alpha",
        )

        await store.update(
            record.id,
            "session metadata survives writer session changes",
            last_writer_client="cli",
            last_writer_session_id="writer-session-b",
            project_scope="project:alpha",
        )
        updated = await store.get(record.id)

    assert updated is not None
    assert updated.metadata["session_id"] == "observer-session"
    assert updated.metadata["source"] == "observer"
    assert updated.last_writer_session_id == "writer-session-b"


async def test_search_and_count_filter_by_project_scope_with_legacy_fallback() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        alpha = await store.store(
            "shared project filter alpha",
            metadata={"schema_version": 1},
            project_scope="project:alpha",
        )
        beta = await store.store(
            "shared project filter beta",
            metadata={"schema_version": 1},
            project_scope="project:beta",
        )
        legacy = await store.store(
            "shared project filter legacy",
            metadata={"schema_version": 1},
            project_scope=None,
        )

        results = await store.search(
            "shared project filter",
            filters={"project_scope": "project:alpha"},
        )
        count = await store.count(filters={"project_scope": "project:alpha"})

    assert [item.id for item in results] == [alpha.id, legacy.id]
    assert beta.id not in [item.id for item in results]
    assert count == 2


async def test_search_and_count_filter_by_last_writer_client() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        cli = await store.store(
            "writer client filter cli",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            project_scope="project:alpha",
        )
        await store.store(
            "writer client filter web",
            metadata={"schema_version": 1},
            last_writer_client="web",
            project_scope="project:alpha",
        )

        results = await store.search(
            "writer client filter",
            filters={"last_writer_client": "cli"},
        )
        count = await store.count(filters={"last_writer_client": "cli"})

    assert [item.id for item in results] == [cli.id]
    assert count == 1


async def test_recover_memory_retains_project_scope() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "recover scoped memory",
            metadata={"schema_version": 1},
            project_scope="project:alpha",
        )

        await store.delete(record.id)
        assert await store.recover_memory(record.id) is True
        recovered = await store.get(record.id)

    assert recovered is not None
    assert recovered.project_scope == "project:alpha"


async def test_supersede_memory_inherits_project_scope_when_replacement_is_unscoped() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        old = await store.store(
            "old scoped fact",
            metadata={"schema_version": 1},
            project_scope="project:alpha",
        )
        replacement = MemoryItem(
            id="scoped-replacement",
            content="new scoped fact",
            layer=old.layer,
            metadata={"schema_version": 1},
            created_at=old.created_at + timedelta(seconds=1),
        )

        new_id = await store.supersede_memory(old.id, replacement)
        new_record = await store.get(new_id)

    assert new_record is not None
    assert new_record.project_scope == "project:alpha"
