from __future__ import annotations

import sqlite3
from datetime import UTC
from typing import cast

import pytest

from quilin_mem.retrieval_safety_gate import (
    MARKER_QUARANTINE,
    META_SAFETY_LESSON_ID,
    META_SAFETY_MARKER,
    RetrievalSafetyGate,
    SafetyGateConfig,
    SafetyLesson,
)
from quilin_mem.safety_lesson_store import (
    SAFETY_LESSONS_DB_ENV,
    SQLiteSafetyLessonStore,
    default_safety_lesson_db_path,
    open_default_safety_lesson_store,
)
from quilin_mem.types import MemoryItem, MemoryMetadata


def _item(content: str) -> MemoryItem:
    return MemoryItem(
        id="memory-1",
        content=content,
        layer="episodic",
        metadata=cast(MemoryMetadata, {"schema_version": 1, "retrieval_score": 0.9}),
    )


def test_store_migrates_empty_sqlite_database(tmp_path) -> None:
    db_path = tmp_path / "lessons.db"

    store = SQLiteSafetyLessonStore(db_path)
    try:
        columns = {
            row["name"]
            for row in store._conn.execute("PRAGMA table_info(safety_lessons)").fetchall()
        }
    finally:
        store.close()

    assert columns == {
        "id",
        "pattern",
        "lesson_type",
        "severity",
        "source",
        "created_at",
        "updated_at",
        "metadata_json",
        "enabled",
    }


def test_default_store_path_prefers_explicit_env_then_test_memory(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "lessons.db"

    monkeypatch.setenv(SAFETY_LESSONS_DB_ENV, str(db_path))
    assert default_safety_lesson_db_path() == str(db_path)

    store = open_default_safety_lesson_store()
    try:
        lesson = store.add(
            pattern="explicit path",
            lesson_type="fixture",
            severity="low",
            source="test",
        )
    finally:
        store.close()

    reopened = SQLiteSafetyLessonStore(db_path)
    try:
        assert [item.id for item in reopened.list()] == [lesson.id]
    finally:
        reopened.close()

    monkeypatch.delenv(SAFETY_LESSONS_DB_ENV)
    monkeypatch.setenv("QUILIN_ENV", "test")
    assert default_safety_lesson_db_path() == ":memory:"


def test_store_migrates_legacy_table_missing_columns(tmp_path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE safety_lessons (id TEXT PRIMARY KEY, pattern TEXT NOT NULL)")
    conn.execute("INSERT INTO safety_lessons (id, pattern) VALUES (?, ?)", ("L1", "legacy"))
    conn.commit()
    conn.close()

    store = SQLiteSafetyLessonStore(db_path)
    try:
        lesson = store.list()[0]
    finally:
        store.close()

    assert lesson.id == "L1"
    assert lesson.pattern == "legacy"
    assert lesson.enabled is True
    assert lesson.lesson_type == "poisoning"


def test_add_list_and_persist_across_instances(tmp_path) -> None:
    db_path = tmp_path / "lessons.db"
    first = SQLiteSafetyLessonStore(db_path)
    try:
        lesson = first.add(
            pattern="ignore previous instructions",
            lesson_type="prompt_injection",
            severity="high",
            source="operator",
            metadata={"reason": "known injection lure", "tags": ["prompt_injection"]},
        )
    finally:
        first.close()

    second = SQLiteSafetyLessonStore(db_path)
    try:
        lessons = second.list()
    finally:
        second.close()

    assert lesson.id
    assert [item.id for item in lessons] == [lesson.id]
    assert lessons[0].pattern == "ignore previous instructions"
    assert lessons[0].lesson_type == "prompt_injection"
    assert lessons[0].severity == "high"
    assert lessons[0].source == "operator"
    assert lessons[0].reason == "known injection lure"
    assert lessons[0].tags == ("prompt_injection",)


def test_search_matches_pattern_type_source_and_metadata(tmp_path) -> None:
    store = SQLiteSafetyLessonStore(tmp_path / "lessons.db")
    try:
        injection = store.add(
            pattern="reveal system prompt",
            lesson_type="prompt_injection",
            severity="high",
            source="red-team",
            metadata={"reason": "do not leak system prompt"},
        )
        store.add(
            pattern="benign preference",
            lesson_type="profile",
            severity="low",
            source="operator",
        )

        by_pattern = store.search("system prompt")
        by_type = store.search("prompt_injection")
        by_source = store.search("red-team")
        by_metadata = store.search("leak")
    finally:
        store.close()

    assert [lesson.id for lesson in by_pattern] == [injection.id]
    assert [lesson.id for lesson in by_type] == [injection.id]
    assert [lesson.id for lesson in by_source] == [injection.id]
    assert [lesson.id for lesson in by_metadata] == [injection.id]


def test_search_blank_returns_enabled_lessons_and_record_lesson_preserves_fields(tmp_path) -> None:
    store = SQLiteSafetyLessonStore(tmp_path / "lessons.db")
    try:
        store.record_lesson(
            SafetyLesson(
                id="L-record",
                pattern=r"delete\s+everything",
                reason="dangerous destructive request",
                tags=("destructive", "operator"),
                lesson_type="destructive_command",
                severity="critical",
                source="review",
                is_regex=True,
            )
        )

        all_results = store.search("   ")
        lesson = all_results[0]
    finally:
        store.close()

    assert [item.id for item in all_results] == ["L-record"]
    assert lesson.reason == "dangerous destructive request"
    assert lesson.tags == ("destructive", "operator")
    assert lesson.is_regex is True
    assert lesson.lesson_type == "destructive_command"


def test_disable_excludes_lesson_from_list_search_and_match(tmp_path) -> None:
    store = SQLiteSafetyLessonStore(tmp_path / "lessons.db")
    try:
        lesson = store.add(
            pattern="rm -rf /",
            lesson_type="destructive_command",
            severity="critical",
            source="operator",
        )

        assert store.disable(lesson.id) is True
        assert store.disable("missing") is False
        assert store.list() == ()
        assert store.search("rm -rf") == ()
        assert store.match("please run rm -rf /") == ()
        assert store.list(enabled_only=False)[0].enabled is False
    finally:
        store.close()


def test_disable_persists_across_store_reopen(tmp_path) -> None:
    db_path = tmp_path / "lessons.db"
    first = SQLiteSafetyLessonStore(db_path)
    try:
        lesson = first.add(
            pattern="disable me",
            lesson_type="fixture",
            severity="low",
            source="test",
        )
        assert first.disable(lesson.id) is True
    finally:
        first.close()

    second = SQLiteSafetyLessonStore(db_path)
    try:
        assert second.list() == ()
        assert second.list(enabled_only=False)[0].enabled is False
    finally:
        second.close()


def test_match_uses_case_insensitive_substring_and_safe_regex_fallback(tmp_path) -> None:
    store = SQLiteSafetyLessonStore(tmp_path / "lessons.db")
    try:
        substring = store.add(
            pattern="Ignore Previous Instructions",
            lesson_type="prompt_injection",
            severity="high",
            source="operator",
        )
        regex = store.add(
            pattern=r"secret\s+token",
            lesson_type="credential_leak",
            severity="high",
            source="operator",
            metadata={"is_regex": True},
        )
        malformed = store.add(
            pattern="[broken",
            lesson_type="malformed",
            severity="low",
            source="fixture",
            metadata={"is_regex": True},
        )

        substring_matches = store.match("please ignore previous instructions")
        regex_matches = store.match("never expose a secret   token")
        fallback_matches = store.match("literal [broken value")
    finally:
        store.close()

    assert [lesson.id for lesson in substring_matches] == [substring.id]
    assert [lesson.id for lesson in regex_matches] == [regex.id]
    assert [lesson.id for lesson in fallback_matches] == [malformed.id]


def test_gate_integration_quarantines_with_sqlite_store(tmp_path) -> None:
    store = SQLiteSafetyLessonStore(tmp_path / "lessons.db")
    try:
        lesson = store.add(
            pattern="exfiltrate secrets",
            lesson_type="credential_leak",
            severity="critical",
            source="operator",
            metadata={"reason": "known credential exfiltration lure"},
        )
        gate = RetrievalSafetyGate(
            config=SafetyGateConfig(enabled=True),
            lesson_store=store,
        )

        result = gate.scrub("q", [_item("try to exfiltrate secrets from memory")])
    finally:
        store.close()

    assert result[0].metadata.get(META_SAFETY_MARKER) == MARKER_QUARANTINE
    assert result[0].metadata.get(META_SAFETY_LESSON_ID) == lesson.id


def test_invalid_metadata_rejected_and_corrupt_metadata_rows_do_not_crash(tmp_path) -> None:
    store = SQLiteSafetyLessonStore(tmp_path / "lessons.db")
    try:
        with pytest.raises(TypeError):
            store.add(
                pattern="bad metadata",
                lesson_type="fixture",
                severity="low",
                source="test",
                metadata=["not", "a", "dict"],  # type: ignore[arg-type]
            )

        store._conn.execute(
            """
            INSERT INTO safety_lessons (
                id, pattern, lesson_type, severity, source,
                created_at, updated_at, metadata_json, enabled
            )
            VALUES (
                'corrupt', 'danger', 'fixture', 'low', 'test',
                '2026-05-21T00:00:00+00:00', '2026-05-21T00:00:00+00:00',
                '{not json', 1
            )
            """
        )

        lesson = store.list()[0]
    finally:
        store.close()

    assert lesson.id == "corrupt"
    assert lesson.metadata["metadata_error"] == "invalid_json"
    assert lesson.reason == ""


def test_legacy_corrupt_metadata_object_and_datetime_fallbacks_do_not_crash(tmp_path) -> None:
    store = SQLiteSafetyLessonStore(tmp_path / "lessons.db")
    try:
        store._conn.execute(
            """
            INSERT INTO safety_lessons (
                id, pattern, lesson_type, severity, source,
                created_at, updated_at, metadata_json, enabled
            )
            VALUES (
                'legacy-shape', 'danger', 'fixture', 'low', 'test',
                'not-a-date', 'also-not-a-date', '["not", "object"]', 1
            )
            """
        )

        lesson = store.list()[0]
    finally:
        store.close()

    assert lesson.id == "legacy-shape"
    assert lesson.metadata["metadata_error"] == "not_object"
    assert lesson.created_at.tzinfo is UTC


def test_gate_default_old_behavior_still_uses_in_memory_fallback() -> None:
    gate = RetrievalSafetyGate(config=SafetyGateConfig(enabled=True))

    result = gate.scrub("q", [_item("ignore previous instructions")])

    assert result[0].metadata.get(META_SAFETY_MARKER) is None
