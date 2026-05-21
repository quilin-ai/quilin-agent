from __future__ import annotations

import json
from datetime import timedelta

import pytest

from quilin_mem.store import QuilinMemStore
from quilin_mem.store_serialization import serialize_metadata
from quilin_mem.types import MemoryItem


async def _conflict_token(store: QuilinMemStore, memory_id: str) -> str:
    pending = await store.get(memory_id)
    assert pending is not None
    token = pending.metadata.get("conflict_token")
    assert isinstance(token, str)
    return token


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
    assert updated.metadata["conflict_current_content"] == "same project conflict candidate"
    assert updated.metadata["conflict_candidate_content"] == "same project edited by web"
    assert updated.metadata["session_id"] == "session-a"
    assert updated.last_writer_client == "web"
    assert updated.last_writer_session_id == "session-b"
    assert updated.project_scope == "project:alpha"


async def test_resolve_conflict_keep_a_restores_previous_content() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "conflict previous content",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "conflict candidate content",
            last_writer_client="web",
            last_writer_session_id="web-session",
            project_scope="project:alpha",
        )
        token = await _conflict_token(store, record.id)

        resolved = await store.resolve_conflict(record.id, "keep_a", conflict_token=token)
        recalled = await store.get(record.id)

    assert resolved is not None
    assert recalled is not None
    assert recalled.content == "conflict previous content"
    assert recalled.last_writer_client == "cli"
    assert recalled.last_writer_session_id is None
    assert recalled.metadata.get("conflict_resolution_pending") is not True
    assert "conflict_current_content" not in recalled.metadata


async def test_resolve_conflict_keep_a_prevents_false_reconflict() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "owned by cli",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            last_writer_session_id="cli-session",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "candidate from web",
            last_writer_client="web",
            last_writer_session_id="web-session",
            project_scope="project:alpha",
        )
        token = await _conflict_token(store, record.id)

        await store.resolve_conflict(record.id, "keep_a", conflict_token=token)
        await store.update(
            record.id,
            "cli follow-up after keeping cli content",
            last_writer_client="cli",
            last_writer_session_id="cli-session-2",
            project_scope="project:alpha",
        )
        recalled = await store.get(record.id)

    assert recalled is not None
    assert recalled.content == "cli follow-up after keeping cli content"
    assert recalled.last_writer_client == "cli"
    assert recalled.last_writer_session_id == "cli-session-2"
    assert recalled.metadata.get("conflict_resolution_pending") is not True
    assert "conflict_with_client" not in recalled.metadata


async def test_resolve_conflict_rejects_non_pending_records() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "ordinary content",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            last_writer_session_id="cli-session",
        )

        resolved = await store.resolve_conflict(
            record.id,
            "merge_manual",
            merged_content="rewritten through resolve_conflict despite no pending conflict",
            conflict_token="not-a-real-conflict-token",
        )
        recalled = await store.get(record.id)

    assert resolved is None
    assert recalled is not None
    assert recalled.content == "ordinary content"
    assert recalled.last_writer_client == "cli"
    assert recalled.last_writer_session_id == "cli-session"
    assert recalled.metadata.get("conflict_resolution_pending") is not True


async def test_resolve_conflict_merge_manual_persists_merged_content() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "conflict manual previous",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "conflict manual candidate",
            last_writer_client="web",
            project_scope="project:alpha",
        )
        token = await _conflict_token(store, record.id)

        resolved = await store.resolve_conflict(
            record.id,
            "merge_manual",
            merged_content="conflict manual merged",
            conflict_token=token,
        )

    assert resolved is not None
    assert resolved.content == "conflict manual merged"
    assert resolved.metadata.get("conflict_resolution_pending") is not True


async def test_resolve_conflict_merge_manual_revalidates_semantic_contract() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            json.dumps(
                {
                    "run_id": "run-conflict-semantic",
                    "source": "planning_review",
                    "schema_version": 1,
                    "summary": "Stable review summary.",
                    "stable_strategy": {"approach": "summarize-first"},
                }
            ),
            tier="semantic",
            metadata={
                "schema_version": 1,
                "source": "planning_review",
                "run_id": "run-conflict-semantic",
                "stability_reason": "Validated stable review summary.",
            },
            content_type="json",
            last_writer_client="cli",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            json.dumps(
                {
                    "run_id": "run-conflict-semantic",
                    "source": "planning_review",
                    "schema_version": 1,
                    "summary": "Candidate review summary.",
                    "stable_strategy": {"approach": "plan-first"},
                }
            ),
            last_writer_client="web",
            project_scope="project:alpha",
        )
        token = await _conflict_token(store, record.id)

        with pytest.raises(ValueError, match="planning_review"):
            await store.resolve_conflict(
                record.id,
                "merge_manual",
                merged_content="not-json runtime phase plan",
                conflict_token=token,
            )
        recalled = await store.get(record.id)

    assert recalled is not None
    assert "Candidate review summary" in recalled.content
    assert recalled.metadata.get("conflict_resolution_pending") is True


async def test_resolve_conflict_keep_a_preserves_empty_previous_content() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            last_writer_session_id="cli-session",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "candidate from web",
            last_writer_client="web",
            last_writer_session_id="web-session",
            project_scope="project:alpha",
        )
        token = await _conflict_token(store, record.id)

        resolved = await store.resolve_conflict(record.id, "keep_a", conflict_token=token)

    assert resolved is not None
    assert resolved.content == ""
    assert resolved.last_writer_client == "cli"
    assert resolved.last_writer_session_id == "cli-session"


async def test_resolve_conflict_rejects_legacy_pending_without_content_metadata() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "previous content from cli",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            last_writer_session_id="cli-session",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "candidate content from web",
            last_writer_client="web",
            last_writer_session_id="web-session",
            project_scope="project:alpha",
        )
        pending = await store.get(record.id)
        assert pending is not None
        metadata = dict(pending.metadata)
        metadata.pop("conflict_current_content", None)
        metadata.pop("conflict_candidate_content", None)
        metadata.pop("conflict_token", None)
        store._conn.execute(  # noqa: SLF001 - test simulates a legacy persisted row.
            "UPDATE memory_records SET metadata_json = ? WHERE id = ?",
            (serialize_metadata(metadata), record.id),
        )

        resolved = await store.resolve_conflict(
            record.id,
            "keep_a",
            conflict_token="legacy-missing-token",
        )
        recalled = await store.get(record.id)

    assert resolved is None
    assert recalled is not None
    assert recalled.content == "candidate content from web"
    assert recalled.metadata.get("conflict_resolution_pending") is True


async def test_resolve_conflict_rejects_stale_conflict_token() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "v1 from cli",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            last_writer_session_id="cli-session",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "v2 from web",
            last_writer_client="web",
            last_writer_session_id="web-session",
            project_scope="project:alpha",
        )
        stale_token = await _conflict_token(store, record.id)
        await store.update(
            record.id,
            "v3 from cli new conflict",
            last_writer_client="cli",
            last_writer_session_id="cli-session-2",
            project_scope="project:alpha",
        )

        stale_resolved = await store.resolve_conflict(
            record.id,
            "keep_b",
            conflict_token=stale_token,
        )
        recalled = await store.get(record.id)

    assert stale_resolved is None
    assert recalled is not None
    assert recalled.content == "v3 from cli new conflict"
    assert recalled.metadata.get("conflict_resolution_pending") is True


async def test_update_clears_pending_conflict_when_same_writer_moves_forward() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "A",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "B",
            last_writer_client="web",
            project_scope="project:alpha",
        )
        stale_token = await _conflict_token(store, record.id)
        await store.update(
            record.id,
            "C",
            last_writer_client="web",
            project_scope="project:alpha",
        )

        stale_resolved = await store.resolve_conflict(
            record.id,
            "keep_b",
            conflict_token=stale_token,
        )
        recalled = await store.get(record.id)

    assert stale_resolved is None
    assert recalled is not None
    assert recalled.content == "C"
    assert recalled.metadata.get("conflict_resolution_pending") is not True
    assert "conflict_token" not in recalled.metadata


async def test_fresh_conflict_clears_stale_previous_writer_session() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "A",
            metadata={"schema_version": 1},
            last_writer_client="cli",
            last_writer_session_id="cli-session",
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "B",
            last_writer_client="web",
            last_writer_session_id=None,
            project_scope="project:alpha",
        )
        await store.update(
            record.id,
            "C",
            last_writer_client="cli",
            last_writer_session_id="cli-session-2",
            project_scope="project:alpha",
        )
        token = await _conflict_token(store, record.id)

        resolved = await store.resolve_conflict(record.id, "keep_a", conflict_token=token)

    assert resolved is not None
    assert resolved.content == "B"
    assert resolved.last_writer_client == "web"
    assert resolved.last_writer_session_id is None


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
