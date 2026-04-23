from __future__ import annotations

from datetime import UTC, datetime, timedelta

from omnimem.episodic import EpisodicMemory
from omnimem.store import OmniMemStore
from omnimem.types import MemoryItem


def _ts(hour: int) -> datetime:
    return datetime(2026, 4, 23, hour, 0, tzinfo=UTC)


async def test_compress_and_add_keeps_verbatim_content() -> None:
    store = OmniMemStore(db_path=":memory:")
    episodic = EpisodicMemory(store)
    raw_content = "step 1\nstep 2\nfinal decision"

    saved = await episodic.compress_and_add(
        MemoryItem(
            content=raw_content,
            layer="working",
            metadata={"schema_version": 1, "session_id": "session-1"},
        )
    )
    recalled = await episodic.search("final decision", session_id="session-1")

    assert saved.layer == "episodic"
    assert saved.content == raw_content
    assert [item.content for item in recalled] == [raw_content]


async def test_search_supports_session_user_and_time_filters() -> None:
    store = OmniMemStore(db_path=":memory:")
    episodic = EpisodicMemory(store)
    await episodic.compress_and_add(
        MemoryItem(
            content="checkpoint alpha",
            layer="episodic",
            metadata={
                "schema_version": 1,
                "session_id": "session-1",
                "user_id": "user-1",
            },
            created_at=_ts(9),
            last_accessed=_ts(9),
        )
    )
    await episodic.compress_and_add(
        MemoryItem(
            content="checkpoint beta",
            layer="episodic",
            metadata={
                "schema_version": 1,
                "session_id": "session-2",
                "user_id": "user-1",
            },
            created_at=_ts(10),
            last_accessed=_ts(10),
        )
    )
    await episodic.compress_and_add(
        MemoryItem(
            content="checkpoint gamma",
            layer="episodic",
            metadata={
                "schema_version": 1,
                "session_id": "session-1",
                "user_id": "user-2",
            },
            created_at=_ts(11),
            last_accessed=_ts(11),
        )
    )

    results = await episodic.search(
        "checkpoint",
        session_id="session-1",
        user_id="user-1",
        start_time=_ts(8),
        end_time=_ts(9) + timedelta(minutes=30),
    )

    assert [item.content for item in results] == ["checkpoint alpha"]


async def test_save_and_load_checkpoint_roundtrip_by_run_and_event_seq() -> None:
    store = OmniMemStore(db_path=":memory:")
    episodic = EpisodicMemory(store)
    first_payload = {"kind": "checkpoint", "step": 1}
    second_payload = {"kind": "checkpoint", "step": 2}

    await episodic.save_checkpoint(
        first_payload,
        run_id="run-1",
        event_seq=1,
        phase="execute",
        task_hash="task-a",
        session_id="session-1",
        created_at=_ts(9),
    )
    saved = await episodic.save_checkpoint(
        second_payload,
        run_id="run-1",
        event_seq=2,
        phase="execute",
        task_hash="task-a",
        session_id="session-1",
        created_at=_ts(10),
    )

    assert saved.metadata["source"] == "checkpoint-writer"
    assert saved.metadata["run_id"] == "run-1"
    assert saved.metadata["event_seq"] == 2
    assert saved.metadata["phase"] == "execute"
    assert saved.metadata["task_hash"] == "task-a"

    assert await episodic.load_checkpoint("run-1", session_id="session-1") == second_payload
    assert (
        await episodic.load_checkpoint("run-1", event_seq=1, session_id="session-1")
        == first_payload
    )


async def test_discard_all_clears_only_episodic_records() -> None:
    store = OmniMemStore(db_path=":memory:")
    episodic = EpisodicMemory(store)
    await episodic.compress_and_add(
        MemoryItem(content="ep-1", layer="episodic", created_at=_ts(9), last_accessed=_ts(9))
    )
    await store.store("semantic-1", tier="semantic")

    cleared = await episodic.discard_all()

    assert cleared == 1
    assert await episodic.search("") == []
    assert await store.count({"layer": "semantic"}) == 1
