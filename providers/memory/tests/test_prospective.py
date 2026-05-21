import json
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from quilin_mem.prospective import (
    DEFAULT_REMINDER_WINDOW_HOURS,
    ProspectiveItem,
    cancel_prospective,
    extract_action_from_metadata,
    extract_deadline_from_metadata,
    format_reminder,
    is_due,
    list_due_prospective,
    mark_prospective_done,
    snooze_prospective,
    validate_resource_pointer,
)
from quilin_mem.server import create_server
from quilin_mem.store import QuilinMemStore


def _decode_call_tool_result(result: object) -> dict[str, object]:
    if isinstance(result, tuple):
        _content, metadata = result
        return json.loads(metadata["result"])  # type: ignore[index]
    typed_result = cast(Any, result)
    content = typed_result.content
    first = content[0]
    text = first.text
    return json.loads(text)


def test_extract_deadline_accepts_timezone_aware_iso() -> None:
    deadline = extract_deadline_from_metadata({"deadline_at": "2026-05-21T10:30:00+08:00"})

    assert deadline is not None
    assert deadline.isoformat() == "2026-05-21T10:30:00+08:00"
    assert deadline.utcoffset() is not None


def test_extract_deadline_defaults_naive_iso_to_utc() -> None:
    deadline = extract_deadline_from_metadata({"deadline_at": "2026-05-21T10:30:00"})

    assert deadline == datetime(2026, 5, 21, 10, 30, tzinfo=UTC)


def test_extract_deadline_accepts_z_suffix() -> None:
    deadline = extract_deadline_from_metadata({"deadline_at": "2026-05-21T10:30:00Z"})

    assert deadline == datetime(2026, 5, 21, 10, 30, tzinfo=UTC)


def test_extract_deadline_returns_none_for_missing_or_invalid_metadata() -> None:
    assert extract_deadline_from_metadata(None) is None
    assert extract_deadline_from_metadata({}) is None
    assert extract_deadline_from_metadata({"deadline_at": ""}) is None
    assert extract_deadline_from_metadata({"deadline_at": 123}) is None
    assert extract_deadline_from_metadata({"deadline_at": "not-a-date"}) is None


def test_extract_deadline_falls_back_for_unsupported_chinese_time_phrase() -> None:
    assert extract_deadline_from_metadata({"deadline_at": "明天上午十点"}) is None


def test_extract_deadline_falls_back_for_unsupported_english_time_phrase() -> None:
    assert extract_deadline_from_metadata({"deadline_at": "next Tuesday at 10am"}) is None


def test_extract_action_trims_metadata() -> None:
    assert (
        extract_action_from_metadata({"prospective_action": "  remind before standup  "})
        == "remind before standup"
    )


def test_extract_action_returns_none_for_blank_or_non_string_metadata() -> None:
    assert extract_action_from_metadata(None) is None
    assert extract_action_from_metadata({"prospective_action": "  "}) is None
    assert extract_action_from_metadata({"prospective_action": ["send"]}) is None


def test_is_due_uses_inclusive_default_window() -> None:
    deadline = datetime(2026, 5, 22, 9, 0, tzinfo=UTC)
    now = datetime(2026, 5, 21, 9, 0, tzinfo=UTC)

    assert is_due(deadline, now) is True
    assert DEFAULT_REMINDER_WINDOW_HOURS == 24


def test_is_due_rejects_negative_window_as_safety_boundary() -> None:
    deadline = datetime(2026, 5, 22, 9, 0, tzinfo=UTC)
    now = datetime(2026, 5, 23, 9, 0, tzinfo=UTC)

    assert is_due(deadline, now, reminder_window_hours=-1) is False


def test_format_reminder_marks_soon_due_and_overdue() -> None:
    item = ProspectiveItem(
        memory_id="mem-1",
        content="Send the launch checklist",
        deadline_at=datetime(2026, 5, 21, 12, 0, tzinfo=UTC),
        action="notify user",
    )

    soon = format_reminder(item, now=datetime(2026, 5, 21, 9, 0, tzinfo=UTC))
    due = format_reminder(item, now=datetime(2026, 5, 21, 11, 30, tzinfo=UTC))
    overdue = format_reminder(item, now=datetime(2026, 5, 21, 14, 0, tzinfo=UTC))

    assert soon.urgency == "soon"
    assert "3 小时后到期 / Due in 3 hours" in soon.message
    assert due.urgency == "due"
    assert "30 分钟后到期 / Due in 30 minutes" in due.message
    assert overdue.urgency == "overdue"
    assert "已过期 2 小时 / Overdue by 2 hours" in overdue.message
    assert overdue.suggested_action == "notify user"


def test_format_reminder_carries_actor_and_source_metadata() -> None:
    item = ProspectiveItem(
        memory_id="mem-actor",
        content="Prepare weekly update",
        deadline_at=datetime(2026, 5, 21, 12, 0, tzinfo=UTC),
        actor="user",
        source="conversation",
    )

    reminder = format_reminder(item, now=datetime(2026, 5, 21, 10, 0, tzinfo=UTC))

    assert reminder.actor == "user"
    assert reminder.source == "conversation"


async def test_list_due_returns_due_active_prospective_records_only() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        due = await store.store(
            "call the customer",
            kind="prospective",
            deadline_at=now - timedelta(minutes=1),
        )
        await store.store(
            "ordinary reference",
            kind="reference",
            deadline_at=now - timedelta(minutes=1),
        )
        deleted = await store.store(
            "deleted prospective",
            kind="prospective",
            deadline_at=now - timedelta(minutes=1),
        )
        expired = await store.store(
            "expired prospective",
            kind="prospective",
            deadline_at=now - timedelta(minutes=1),
        )
        await store.delete(deleted.id)
        store._conn.execute(  # type: ignore[attr-defined]
            "UPDATE memory_records SET forget_after = ? WHERE id = ?",
            ((now - timedelta(seconds=1)).isoformat(), expired.id),
        )
        store._conn.commit()  # type: ignore[attr-defined]

        results = await list_due_prospective(store, now=now)

    assert [item.memory_id for item in results] == [due.id]
    assert results[0].kind == "prospective"


async def test_list_due_excludes_future_deadlines() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await store.store(
            "future prospective",
            kind="prospective",
            deadline_at=now + timedelta(seconds=1),
        )

        results = await list_due_prospective(store, now=now)

    assert results == []


async def test_list_due_filters_project_user_and_session_scope() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        expected = await store.store(
            "scoped due prospective",
            kind="prospective",
            deadline_at=now,
            project_scope="/repo/quilin-agent",
            metadata={"schema_version": 1, "user_id": "user-1", "session_id": "session-1"},
        )
        await store.store(
            "wrong project",
            kind="prospective",
            deadline_at=now,
            project_scope="/repo/other",
            metadata={"schema_version": 1, "user_id": "user-1", "session_id": "session-1"},
        )
        await store.store(
            "wrong user",
            kind="prospective",
            deadline_at=now,
            project_scope="/repo/quilin-agent",
            metadata={"schema_version": 1, "user_id": "user-2", "session_id": "session-1"},
        )
        await store.store(
            "wrong session",
            kind="prospective",
            deadline_at=now,
            project_scope="/repo/quilin-agent",
            metadata={"schema_version": 1, "user_id": "user-1", "session_id": "session-2"},
        )

        results = await list_due_prospective(
            store,
            now=now,
            project_scope="/repo/quilin-agent",
            user_id="user-1",
            session_id="session-1",
        )

    assert [item.memory_id for item in results] == [expected.id]


async def test_list_due_keeps_legacy_unscoped_records_for_project_scope() -> None:
    now = datetime(2026, 5, 21, 20, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        scoped = await store.store(
            "scoped prospective",
            kind="prospective",
            deadline_at=now,
            project_scope="/repo/quilin-agent",
        )
        legacy = await store.store(
            "legacy prospective",
            kind="prospective",
            deadline_at=now,
        )
        await store.store(
            "other project prospective",
            kind="prospective",
            deadline_at=now,
            project_scope="/repo/other",
        )

        results = await list_due_prospective(
            store,
            now=now,
            project_scope="/repo/quilin-agent",
        )

    assert {item.memory_id for item in results} == {scoped.id, legacy.id}


async def test_list_due_normalizes_now_to_utc_for_forget_after_visibility() -> None:
    now = datetime.fromisoformat("2026-05-21T20:00:00+08:00")
    async with QuilinMemStore(db_path=":memory:") as store:
        visible = await store.store(
            "visible with utc forget-after",
            kind="prospective",
            deadline_at=datetime(2026, 5, 21, 11, 0, tzinfo=UTC),
        )
        store._conn.execute(  # type: ignore[attr-defined]
            "UPDATE memory_records SET forget_after = ? WHERE id = ?",
            ("2026-05-21T13:00:00+00:00", visible.id),
        )
        store._conn.commit()  # type: ignore[attr-defined]

        results = await list_due_prospective(store, now=now)

    assert [item.memory_id for item in results] == [visible.id]


async def test_list_due_filters_equal_instant_forget_after_with_offset_timezone() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        expired = await store.store(
            "expired offset prospective",
            kind="prospective",
            deadline_at=now - timedelta(minutes=1),
        )
        visible = await store.store(
            "visible prospective",
            kind="prospective",
            deadline_at=now - timedelta(minutes=1),
        )
        store._conn.execute(  # type: ignore[attr-defined]
            "UPDATE memory_records SET forget_after = ? WHERE id = ?",
            ("2026-05-21T20:00:00+08:00", expired.id),
        )
        store._conn.execute(  # type: ignore[attr-defined]
            "UPDATE memory_records SET forget_after = ? WHERE id = ?",
            ("2026-05-21T13:00:00+00:00", visible.id),
        )
        store._conn.commit()  # type: ignore[attr-defined]

        results = await list_due_prospective(store, now=now)

    assert [item.memory_id for item in results] == [visible.id]


async def test_snooze_updates_deadline_and_metadata_without_deleting() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    snoozed_until = now + timedelta(hours=2)
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store(
            "snooze this reminder",
            kind="prospective",
            deadline_at=now - timedelta(minutes=5),
            prospective_action="remind me before standup",
            resource_pointer={"path": "docs/plan.md", "type": "document"},
            metadata={"schema_version": 1, "user_id": "user-1", "custom": "preserve"},
        )

        payload = await snooze_prospective(store, record.id, snoozed_until, now=now)
        due_after_snooze = await list_due_prospective(store, now=now)
        fetched = await store.get(record.id)

    assert payload["snoozed"] is True
    assert due_after_snooze == []
    assert fetched is not None
    assert fetched.deadline_at == snoozed_until
    assert fetched.metadata["prospective_status"] == "pending"
    assert fetched.metadata["prospective_snoozed_at"] == now.isoformat()
    assert fetched.metadata["user_id"] == "user-1"
    assert fetched.metadata["custom"] == "preserve"
    assert fetched.prospective_action == "remind me before standup"
    assert fetched.resource_pointer == {"path": "docs/plan.md", "type": "document"}


async def test_done_and_cancel_soft_delete_with_status_metadata() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        done = await store.store("done reminder", kind="prospective", deadline_at=now)
        canceled = await store.store("cancel reminder", kind="prospective", deadline_at=now)

        done_payload = await mark_prospective_done(store, done.id, now=now)
        cancel_payload = await cancel_prospective(store, canceled.id, now=now)

        rows = store._conn.execute(  # type: ignore[attr-defined]
            "SELECT id, deleted, metadata_json FROM memory_records ORDER BY rowid ASC"
        ).fetchall()

    assert done_payload["done"] is True
    assert cancel_payload["canceled"] is True
    assert [row["id"] for row in rows] == [done.id, canceled.id]
    assert [row["deleted"] for row in rows] == [1, 1]
    done_metadata = json.loads(rows[0]["metadata_json"])
    canceled_metadata = json.loads(rows[1]["metadata_json"])
    assert done_metadata["prospective_status"] == "done"
    assert done_metadata["prospective_done_at"] == now.isoformat()
    assert canceled_metadata["prospective_status"] == "canceled"
    assert canceled_metadata["prospective_canceled_at"] == now.isoformat()


def test_validate_resource_pointer_is_deterministic_and_does_not_touch_io() -> None:
    assert validate_resource_pointer({"uri": "file:///tmp/note.md", "type": "file"}) == {
        "uri": "file:///tmp/note.md",
        "type": "file",
    }
    assert validate_resource_pointer({"path": "docs/plan.md", "type": "document"}) == {
        "path": "docs/plan.md",
        "type": "document",
    }

    invalid_pointers = [
        {"uri": "not-a-uri", "type": "file"},
        {"uri": "", "path": "docs/plan.md", "type": "file"},
        {"uri": 123, "type": "file"},
        {"uri": "file:///tmp/\x1f/note.md", "type": "file"},
        {"path": "", "type": "file"},
        {"uri": "file:///tmp/a", "path": "", "type": "file"},
        {"path": "docs/\x00plan.md", "type": "file"},
        {"path": "docs/plan.md", "type": ""},
        ["not", "object"],
        {"uri": "file:///tmp/a", "path": "docs/a.md", "type": "file"},
        {"uri": "file:///tmp/a", "type": "bad type"},
    ]
    for pointer in invalid_pointers:
        try:
            validate_resource_pointer(pointer)
        except ValueError:
            continue
        raise AssertionError(f"expected invalid resource pointer: {pointer!r}")


async def test_snooze_recovers_archived_record_before_rescheduling() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    snoozed_until = datetime(2026, 5, 21, 13, 0)
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store("archived reminder", kind="prospective", deadline_at=now)
        await store.delete(record.id)

        payload = await snooze_prospective(store, record.id, snoozed_until, now=now)
        fetched = await store.get(record.id)
        row = store._conn.execute(  # type: ignore[attr-defined]
            "SELECT deleted FROM memory_records WHERE id = ?",
            (record.id,),
        ).fetchone()

    assert payload["snoozed"] is True
    assert payload["recovered"] is True
    assert fetched is not None
    assert row["deleted"] == 0
    assert fetched.deadline_at == snoozed_until.replace(tzinfo=UTC)


async def test_prospective_helpers_return_false_for_missing_records() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        done = await mark_prospective_done(store, "missing", now=now)
        canceled = await cancel_prospective(store, "missing", now=now)
        snoozed = await snooze_prospective(
            store,
            "missing",
            now + timedelta(hours=1),
            now=now,
        )

    assert done["done"] is False
    assert canceled["canceled"] is False
    assert snoozed["snoozed"] is False
    assert snoozed["recovered"] is False


async def test_snooze_recovers_from_corrupt_metadata_json() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    snoozed_until = now + timedelta(hours=1)
    async with QuilinMemStore(db_path=":memory:") as store:
        record = await store.store("corrupt metadata reminder", kind="prospective")
        store._conn.execute(  # type: ignore[attr-defined]
            "UPDATE memory_records SET metadata_json = ? WHERE id = ?",
            ("{not json", record.id),
        )
        store._conn.commit()  # type: ignore[attr-defined]

        payload = await snooze_prospective(store, record.id, snoozed_until, now=now)
        fetched = await store.get(record.id)

    assert payload["snoozed"] is True
    assert fetched is not None
    assert fetched.metadata["schema_version"] == 1
    assert fetched.metadata["prospective_status"] == "pending"


async def test_list_due_ignores_prospective_records_without_deadline_or_closed_status() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await store.store("missing deadline", kind="prospective")
        await store.store(
            "deadline without prospective kind",
            metadata={"schema_version": 1, "deadline_at": now.isoformat()},
        )
        await store.store(
            "done metadata",
            metadata={
                "schema_version": 1,
                "kind": "prospective",
                "deadline_at": now.isoformat(),
                "prospective_status": "done",
            },
        )

        results = await list_due_prospective(store, now=now)

    assert results == []


async def test_list_due_skips_corrupt_legacy_resource_pointer_rows() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        valid = await store.store("valid due", kind="prospective", deadline_at=now)
        corrupt = await store.store("corrupt due", kind="prospective", deadline_at=now)
        store._conn.execute(  # type: ignore[attr-defined]
            "UPDATE memory_records SET resource_pointer_json = ? WHERE id = ?",
            ("{not json", corrupt.id),
        )
        store._conn.commit()  # type: ignore[attr-defined]

        results = await list_due_prospective(store, now=now)

    assert [item.memory_id for item in results] == [valid.id]


async def test_prospective_mcp_tools_wire_due_list_and_snooze() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        server = create_server(store)
        created = _decode_call_tool_result(
            await server.call_tool(  # type: ignore[attr-defined]
                "memory_store",
                {
                    "content": "MCP due prospective",
                    "kind": "prospective",
                    "deadline_at": now.isoformat(),
                    "resource_pointer": {"uri": "file:///tmp/note.md", "type": "file"},
                },
            )
        )
        memory_id = str(created["id"])

        due = _decode_call_tool_result(
            await server.call_tool(  # type: ignore[attr-defined]
                "memory_prospective_list_due",
                {"now": now.isoformat()},
            )
        )
        snoozed = _decode_call_tool_result(
            await server.call_tool(  # type: ignore[attr-defined]
                "memory_prospective_snooze",
                {
                    "memory_id": memory_id,
                    "snooze_until": (now + timedelta(hours=1)).isoformat(),
                    "now": now.isoformat(),
                },
            )
        )
        due_after_snooze = _decode_call_tool_result(
            await server.call_tool(  # type: ignore[attr-defined]
                "memory_prospective_list_due",
                {"now": now.isoformat()},
            )
        )

    assert [item["id"] for item in due["items"]] == [memory_id]
    assert snoozed["snoozed"] is True
    assert due_after_snooze["items"] == []


async def test_list_due_supports_legacy_metadata_deadline_and_action_fallback() -> None:
    now = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        legacy = await store.store(
            "legacy prospective reminder",
            metadata={
                "schema_version": 1,
                "kind": "prospective",
                "deadline_at": (now - timedelta(minutes=1)).isoformat(),
                "prospective_action": "surface legacy reminder",
            },
        )

        results = await list_due_prospective(store, now=now)

    assert [item.memory_id for item in results] == [legacy.id]
    assert results[0].prospective_action == "surface legacy reminder"
