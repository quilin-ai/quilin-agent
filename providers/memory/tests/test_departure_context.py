"""Tests for DepartureContext writer (audit P2 #10).

Coverage:
1. extract with LLM returns structured snapshot.
2. extract falls back to deterministic summary when no LLM.
3. extract handles empty / blank conversation gracefully.
4. write persists snapshot with kind=departure_context + session_id metadata.
5. recall_for_session round-trip — write then read by session_id.
6. is_idle threshold respects the 30-minute default.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest

from quilin_mem.departure_context import (
    DEPARTURE_CONTEXT_KIND,
    DEPARTURE_CONTEXT_LAYER,
    DEPARTURE_CONTEXT_SOURCE,
    ConversationTurn,
    DepartureContextConfig,
    DepartureContextWriter,
)
from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem


def _scripted_llm(payload: str) -> Any:
    def caller(prompt: str, *, model: str) -> str:
        # The prompt must contain the transcript marker; assert it weakly
        # so accidental misuse surfaces in test output.
        assert "对话片段" in prompt
        return payload

    return caller


@pytest.fixture(autouse=True)
def _isolate_safety_db(monkeypatch: pytest.MonkeyPatch) -> None:
    # QuilinMemStore opens an in-process SQLite when no path env vars provided,
    # so we just ensure the safety lesson store does not collide with the user
    # home directory during test runs.
    monkeypatch.setenv("QUILIN_ENV", "test")
    monkeypatch.delenv("QUILIN_MEM_DB_PATH", raising=False)


@pytest.mark.asyncio
async def test_extract_with_llm_returns_structured_snapshot() -> None:
    llm_payload = (
        '{"summary": "用户在排查 Mac 客户端的 mesh 连接问题,'
        '已经定位到 UniFFI bridge 的 panic 现象", '
        '"pending_items": ["重启 daemon 后复测", "查 quilin-bridge log"], '
        '"open_questions": ["UniFFI panic 是否每次都触发?"], '
        '"followups": ["明天继续看 mesh-sdk 的握手时序"]}'
    )
    writer = DepartureContextWriter(
        store=None,
        config=DepartureContextConfig(model="test-model"),
        llm_caller=_scripted_llm(llm_payload),
    )
    turns = [
        ConversationTurn(role="user", content="quilin-bridge 又 panic 了,你看下"),
        ConversationTurn(role="assistant", content="收到,我看 stack trace"),
        ConversationTurn(role="user", content="先放着我明天接着排查"),
    ]

    ctx = await writer.extract("session-abc", turns)

    assert ctx.session_id == "session-abc"
    assert ctx.extraction_method == "llm"
    assert "Mac 客户端" in ctx.summary
    assert "重启 daemon 后复测" in ctx.pending_items
    assert "UniFFI panic 是否每次都触发?" in ctx.open_questions
    assert "明天继续看 mesh-sdk 的握手时序" in ctx.followups


@pytest.mark.asyncio
async def test_extract_falls_back_to_deterministic_summary() -> None:
    # No LLM caller wired — writer must produce a fallback snapshot.
    writer = DepartureContextWriter(store=None)
    turns = [
        ConversationTurn(role="user", content="hey can you check the dedupe job"),
        ConversationTurn(role="assistant", content="sure — running it now"),
        ConversationTurn(role="user", content="ok will be back later"),
    ]

    ctx = await writer.extract("sess-1", turns)

    assert ctx.session_id == "sess-1"
    assert ctx.extraction_method == "fallback"
    assert "User left mid-conversation" in ctx.summary
    assert "ok will be back later" in ctx.summary
    # Every tail turn becomes a pending entry in the fallback path.
    assert any("user" in p for p in ctx.pending_items)
    assert any("assistant" in p for p in ctx.pending_items)


@pytest.mark.asyncio
async def test_extract_handles_empty_conversation() -> None:
    writer = DepartureContextWriter(store=None)
    ctx = await writer.extract("sess-empty", [])
    assert ctx.session_id == "sess-empty"
    assert ctx.extraction_method == "empty"
    assert ctx.summary == "(empty session)"
    assert ctx.pending_items == ()


@pytest.mark.asyncio
async def test_extract_handles_dict_turns_and_invalid_entries() -> None:
    writer = DepartureContextWriter(store=None)
    turns = cast(
        Any,
        [
            {"role": "user", "content": "  "},  # blank → skipped
            {"role": "assistant", "content": "hello"},
            {"role": "user", "content": "see you tomorrow"},
            "not a mapping",  # invalid → skipped
        ],
    )

    ctx = await writer.extract("sess-2", turns)

    assert ctx.extraction_method == "fallback"
    assert "see you tomorrow" in ctx.summary


@pytest.mark.asyncio
async def test_write_persists_snapshot_into_store(tmp_path) -> None:
    db_path = tmp_path / "quilin_mem.db"
    os.environ["QUILIN_MEM_DB_PATH"] = str(db_path)
    try:
        store = QuilinMemStore(db_path=str(db_path))
        try:
            writer = DepartureContextWriter(store=store)
            turns = [
                ConversationTurn(
                    role="user",
                    content="I'll continue the dedupe migration tomorrow.",
                ),
                ConversationTurn(role="assistant", content="Sounds good, summary saved."),
            ]
            ctx = await writer.extract("session-xyz", turns)
            record = await writer.write(ctx)

            assert isinstance(record, MemoryItem)
            assert record.kind == DEPARTURE_CONTEXT_KIND
            assert record.layer == DEPARTURE_CONTEXT_LAYER
            assert record.metadata.get("source") == DEPARTURE_CONTEXT_SOURCE
            assert record.metadata.get("session_id") == "session-xyz"
            assert record.last_writer_session_id == "session-xyz"
            assert "dedupe migration tomorrow" in record.content
            assert record.metadata.get("extraction_method") in {"fallback", "llm"}
        finally:
            await store.close()
    finally:
        os.environ.pop("QUILIN_MEM_DB_PATH", None)


@pytest.mark.asyncio
async def test_recall_for_session_returns_latest_first(tmp_path) -> None:
    db_path = tmp_path / "quilin_mem.db"
    os.environ["QUILIN_MEM_DB_PATH"] = str(db_path)
    try:
        store = QuilinMemStore(db_path=str(db_path))
        try:
            writer = DepartureContextWriter(store=store)
            old_turn = [ConversationTurn(role="user", content="Phase 1 plan: ship the bridge.")]
            await writer.extract_and_write(
                "session-α",
                old_turn,
                now=datetime(2026, 5, 1, tzinfo=UTC),
            )
            new_turn = [ConversationTurn(role="user", content="Switch focus to mesh smoke tests.")]
            await writer.extract_and_write(
                "session-α",
                new_turn,
                now=datetime(2026, 5, 21, tzinfo=UTC),
            )
            # Different session — must not bleed across.
            await writer.extract_and_write(
                "session-β",
                [ConversationTurn(role="user", content="Investor outreach checklist.")],
            )

            results = await writer.recall_for_session("session-α", limit=5)
            # 至少返回一条 session-α 的 departure record(取决于 search 内置打分,可能两条都被召回)。
            assert len(results) >= 1
            session_ids = {item.metadata.get("session_id") for item in results}
            assert session_ids == {"session-α"}
            if len(results) >= 2:
                # Latest first.
                assert "mesh smoke tests" in results[0].content
        finally:
            await store.close()
    finally:
        os.environ.pop("QUILIN_MEM_DB_PATH", None)


@pytest.mark.asyncio
async def test_recall_for_session_limit_one_returns_latest_primary_match(tmp_path) -> None:
    db_path = tmp_path / "quilin_mem.db"
    os.environ["QUILIN_MEM_DB_PATH"] = str(db_path)
    try:
        store = QuilinMemStore(db_path=str(db_path))
        try:
            writer = DepartureContextWriter(store=store)
            await writer.extract_and_write(
                "session-latest",
                [ConversationTurn(role="user", content="old departure marker")],
                now=datetime(2026, 5, 1, tzinfo=UTC),
            )
            await writer.extract_and_write(
                "session-latest",
                [ConversationTurn(role="user", content="new departure marker")],
                now=datetime(2026, 5, 21, tzinfo=UTC),
            )

            results = await writer.recall_for_session("session-latest", limit=1)

            assert len(results) == 1
            assert results[0].metadata.get("extracted_at") == "2026-05-21T00:00:00+00:00"
            assert "new departure marker" in results[0].content
        finally:
            await store.close()
    finally:
        os.environ.pop("QUILIN_MEM_DB_PATH", None)


@pytest.mark.asyncio
async def test_recall_for_session_limit_one_returns_latest_with_many_primary_matches(
    tmp_path,
) -> None:
    db_path = tmp_path / "quilin_mem.db"
    os.environ["QUILIN_MEM_DB_PATH"] = str(db_path)
    try:
        store = QuilinMemStore(db_path=str(db_path))
        try:
            writer = DepartureContextWriter(store=store)
            base = datetime(2026, 5, 1, tzinfo=UTC)
            for index in range(40):
                await writer.extract_and_write(
                    "session-many",
                    [ConversationTurn(role="user", content=f"departure marker {index}")],
                    now=base + timedelta(days=index),
                )

            results = await writer.recall_for_session("session-many", limit=1)

            assert len(results) == 1
            assert results[0].metadata.get("extracted_at") == "2026-06-09T00:00:00+00:00"
            assert "departure marker 39" in results[0].content
        finally:
            await store.close()
    finally:
        os.environ.pop("QUILIN_MEM_DB_PATH", None)


@pytest.mark.asyncio
async def test_recall_for_session_falls_back_to_metadata_session_id(tmp_path) -> None:
    db_path = tmp_path / "quilin_mem.db"
    os.environ["QUILIN_MEM_DB_PATH"] = str(db_path)
    try:
        store = QuilinMemStore(db_path=str(db_path))
        try:
            await store.store(
                "[departure summary] legacy metadata-only session",
                tier=DEPARTURE_CONTEXT_LAYER,
                kind=DEPARTURE_CONTEXT_KIND,
                metadata={
                    "schema_version": 1,
                    "source": DEPARTURE_CONTEXT_SOURCE,
                    "session_id": "legacy-session",
                    "extracted_at": "2026-05-21T12:00:00+00:00",
                },
            )
            writer = DepartureContextWriter(store=store)

            results = await writer.recall_for_session("legacy-session", limit=3)

            assert len(results) == 1
            assert "legacy metadata-only session" in results[0].content
        finally:
            await store.close()
    finally:
        os.environ.pop("QUILIN_MEM_DB_PATH", None)


@pytest.mark.asyncio
async def test_recall_for_session_metadata_fallback_survives_noisy_episodic_rows(
    tmp_path,
) -> None:
    db_path = tmp_path / "quilin_mem.db"
    os.environ["QUILIN_MEM_DB_PATH"] = str(db_path)
    try:
        store = QuilinMemStore(db_path=str(db_path))
        try:
            for index in range(40):
                await store.store(
                    f"ordinary episodic row {index}",
                    tier=DEPARTURE_CONTEXT_LAYER,
                    metadata={"schema_version": 1, "source": "ordinary"},
                )
            await store.store(
                "[departure summary] legacy noisy metadata-only session",
                tier=DEPARTURE_CONTEXT_LAYER,
                kind=DEPARTURE_CONTEXT_KIND,
                metadata={
                    "schema_version": 1,
                    "source": DEPARTURE_CONTEXT_SOURCE,
                    "session_id": "legacy-noisy-session",
                    "extracted_at": "2026-05-21T12:00:00+00:00",
                },
            )
            writer = DepartureContextWriter(store=store)

            results = await writer.recall_for_session("legacy-noisy-session", limit=1)

            assert len(results) == 1
            assert "legacy noisy metadata-only session" in results[0].content
        finally:
            await store.close()
    finally:
        os.environ.pop("QUILIN_MEM_DB_PATH", None)


@pytest.mark.asyncio
async def test_recall_for_session_limit_one_returns_latest_with_many_metadata_matches(
    tmp_path,
) -> None:
    db_path = tmp_path / "quilin_mem.db"
    os.environ["QUILIN_MEM_DB_PATH"] = str(db_path)
    try:
        store = QuilinMemStore(db_path=str(db_path))
        try:
            base = datetime(2026, 5, 1, tzinfo=UTC)
            for index in range(40):
                observed_at = (base + timedelta(days=index)).isoformat()
                await store.store(
                    f"[departure summary] legacy marker {index}",
                    tier=DEPARTURE_CONTEXT_LAYER,
                    kind=DEPARTURE_CONTEXT_KIND,
                    metadata={
                        "schema_version": 1,
                        "source": DEPARTURE_CONTEXT_SOURCE,
                        "session_id": "legacy-many-session",
                        "extracted_at": observed_at,
                    },
                )
            writer = DepartureContextWriter(store=store)

            results = await writer.recall_for_session("legacy-many-session", limit=1)

            assert len(results) == 1
            assert results[0].metadata.get("extracted_at") == "2026-06-09T00:00:00+00:00"
            assert "legacy marker 39" in results[0].content
        finally:
            await store.close()
    finally:
        os.environ.pop("QUILIN_MEM_DB_PATH", None)


def test_is_idle_threshold_respects_idle_minutes() -> None:
    writer = DepartureContextWriter(
        store=None,
        config=DepartureContextConfig(idle_minutes=30),
    )
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    fresh = now - timedelta(minutes=5)
    stale = now - timedelta(minutes=45)

    assert writer.is_idle(fresh, now=now) is False
    assert writer.is_idle(stale, now=now) is True


def test_departure_context_to_content_includes_all_sections() -> None:
    from quilin_mem.departure_context import DepartureContext

    ctx = DepartureContext(
        session_id="s1",
        summary="left mid-task",
        pending_items=("write the report",),
        open_questions=("which model to use?",),
        followups=("circle back on benchmark",),
    )
    rendered = ctx.to_content()
    assert "[departure summary] left mid-task" in rendered
    assert "[pending / 未完成]" in rendered
    assert "- write the report" in rendered
    assert "- which model to use?" in rendered
    assert "- circle back on benchmark" in rendered
