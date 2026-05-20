from datetime import UTC, datetime

from quilin_mem.prospective import (
    DEFAULT_REMINDER_WINDOW_HOURS,
    ProspectiveItem,
    extract_action_from_metadata,
    extract_deadline_from_metadata,
    format_reminder,
    is_due,
)


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
