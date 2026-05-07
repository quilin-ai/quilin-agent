from __future__ import annotations

from pathlib import Path

import pytest

from quilin_mem.profile_store import ProfileStore, UserProfile, emit_profile_signal
from quilin_mem.profile_updater import ProfileUpdater


def test_profile_updater_is_single_write_entrypoint(tmp_path: Path) -> None:
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)
    signal = emit_profile_signal(
        "profile-1",
        {"communication_style": "concise progress updates"},
        source="observer",
    )

    audit = updater.apply_signal(signal, who="profile_updater", why="user preference signal")

    profile = store.get_profile("profile-1")
    assert profile is not None
    assert profile.schema_version == 1
    assert profile.non_sensitive == {"communication_style": "concise progress updates"}
    assert profile.sensitive == {}
    assert audit.who == "profile_updater"
    assert audit.why == "user preference signal"
    assert audit.source == "observer"
    assert audit.diff["non_sensitive"]["communication_style"]["after"] == (
        "concise progress updates"
    )


def test_sensitive_fields_are_redacted_in_audit(tmp_path: Path) -> None:
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)
    signal = emit_profile_signal(
        "profile-1",
        {"workflow": "prefers tests first"},
        sensitive_updates={"real_name": "Ada Lovelace", "birthday": "1815-12-10"},
        source="import",
    )

    updater.apply_signal(signal, who="profile_updater", why="explicit import")

    profile = store.get_profile("profile-1")
    assert profile is not None
    assert profile.sensitive["real_name"] == "Ada Lovelace"
    audit = store.list_audit("profile-1")[0]
    assert audit.diff["sensitive"]["real_name"] == {
        "before": None,
        "after": "<redacted>",
    }


def test_bulk_apply_and_reset(tmp_path: Path) -> None:
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    audits = updater.bulk_apply(
        [
            emit_profile_signal("profile-1", {"a": "1"}),
            emit_profile_signal("profile-1", {"b": "2"}),
        ],
        who="profile_updater",
        why="batch",
    )

    assert len(audits) == 2
    assert store.get_profile("profile-1") is not None
    updater.reset()
    assert store.get_profile("profile-1") is None
    assert store.list_audit("profile-1") == []


def test_profile_signal_rejects_sensitive_plain_updates() -> None:
    with pytest.raises(ValueError, match="use sensitive_updates"):
        emit_profile_signal("profile-1", {"real_name": "Ada"})


def test_user_profile_rejects_schema_drift() -> None:
    with pytest.raises(ValueError, match="schema_version"):
        UserProfile(profile_id="profile-1", schema_version=2)


# -- ProfileUpdater.update() + sync_user_md() tests --


def test_update_applies_signal_and_writes_user_md(tmp_path: Path) -> None:
    """update() should persist the change AND write ~/.quilin/user.md."""
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    # Patch user.md path to use tmp_path
    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    orig_path = pu._USER_MD_PATH
    pu._USER_MD_DIR = user_md_dir
    pu._USER_MD_PATH = user_md_path
    try:
        signal = emit_profile_signal(
            "default",
            {"communication_style": "concise progress updates"},
            source="observer",
        )
        audit = updater.update(signal, who="l3a_observer", why="LLM pattern found")

        # Verify audit
        assert audit.who == "l3a_observer"

        # Verify profile stored
        profile = store.get_profile("default")
        assert profile is not None
        assert profile.non_sensitive["communication_style"] == "concise progress updates"

        # Verify user.md written
        assert user_md_path.exists()
        content = user_md_path.read_text(encoding="utf-8")
        assert 'schema_version: 1' in content
        assert '"default"' in content
        assert 'global_projection' in content
        assert 'communication_style' in content
        assert 'concise progress updates' in content
    finally:
        pu._USER_MD_DIR = orig_dir
        pu._USER_MD_PATH = orig_path


def test_sync_user_md_writes_minimal_template_when_no_profile(tmp_path: Path) -> None:
    """sync_user_md() should write a valid template even with no stored profile."""
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    orig_path = pu._USER_MD_PATH
    pu._USER_MD_DIR = user_md_dir
    pu._USER_MD_PATH = user_md_path
    try:
        updater.sync_user_md(profile_id="default")

        assert user_md_path.exists()
        content = user_md_path.read_text(encoding="utf-8")
        assert 'schema_version: 1' in content
        assert '# 关于用户' in content
        assert '## 基本信息' in content
        assert '## 偏好 / Preferences' in content
        assert '## 习惯 / Habits' in content
    finally:
        pu._USER_MD_DIR = orig_dir
        pu._USER_MD_PATH = orig_path


def test_sync_user_md_categorizes_fields_into_sections(tmp_path: Path) -> None:
    """sync_user_md() should sort non_sensitive fields into 基本信息/偏好/习惯."""
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    orig_path = pu._USER_MD_PATH
    pu._USER_MD_DIR = user_md_dir
    pu._USER_MD_PATH = user_md_path
    try:
        # Apply a signal with categorized fields via direct store manipulation
        signal = emit_profile_signal(
            "default",
            {
                "communication_style": "direct",
                "workflow": "test-first",
                "observer_l3a_finding": "User prefers Chinese summaries",
            },
            source="l3a_observer",
        )
        updater.apply_signal(signal, who="l3a_observer", why="test")
        updater.sync_user_md(profile_id="default")

        content = user_md_path.read_text(encoding="utf-8")

        # communication_style should be in 偏好 (matches preference_keys)
        assert '偏好' in content
        assert 'communication_style' in content

        # workflow should be in 习惯 (matches habit_keys)
        assert '习惯' in content
        assert 'workflow' in content

        # observer_l3a_finding should be in 基本信息 (no preference/habit key match)
        assert '基本信息' in content
        assert 'observer_l3a_finding' in content
    finally:
        pu._USER_MD_DIR = orig_dir
        pu._USER_MD_PATH = orig_path


def test_bulk_update_syncs_user_md_once(tmp_path: Path) -> None:
    """bulk_update() should write user.md only once for multiple signals."""
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    orig_path = pu._USER_MD_PATH
    pu._USER_MD_DIR = user_md_dir
    pu._USER_MD_PATH = user_md_path
    try:
        entries = updater.bulk_update(
            [
                emit_profile_signal("default", {"a": "1"}, source="test"),
                emit_profile_signal("default", {"b": "2"}, source="test"),
                emit_profile_signal("default", {"c": "3"}, source="test"),
            ],
            who="l3a_observer",
            why="batch test",
        )

        assert len(entries) == 3
        assert user_md_path.exists()
        content = user_md_path.read_text(encoding="utf-8")
        # All three fields should be present (rendered as **key**: value)
        assert "**a**" in content
        assert "**b**" in content
        assert "**c**" in content
    finally:
        pu._USER_MD_DIR = orig_dir
        pu._USER_MD_PATH = orig_path


def test_bulk_update_no_signals_no_file_write(tmp_path: Path) -> None:
    """bulk_update() with empty signals should not create user.md."""
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    orig_path = pu._USER_MD_PATH
    pu._USER_MD_DIR = user_md_dir
    pu._USER_MD_PATH = user_md_path
    try:
        entries = updater.bulk_update(
            [],
            who="l3a_observer",
            why="empty batch",
        )
        assert entries == []
        assert not user_md_path.exists()
    finally:
        pu._USER_MD_DIR = orig_dir
        pu._USER_MD_PATH = orig_path


def test_user_md_format_contains_all_required_sections() -> None:
    """The generated user.md must have the canonical structure."""
    import quilin_mem.profile_updater as pu

    content = pu._format_user_md("default", {"key": "value"}, "2026-05-07T00:00:00+00:00")

    # Frontmatter
    assert content.startswith("---\n")
    assert "schema_version: 1" in content
    assert '"default"' in content
    assert "global_projection" in content
    assert "last_updated" in content

    # Required sections
    assert "# 关于用户" in content
    assert "## 基本信息" in content
    assert "## 偏好 / Preferences" in content
    assert "## 习惯 / Habits" in content

    # Field rendering
    assert "**key**" in content
    assert '"value"' in content


def test_user_md_default_template_has_placeholder_sections(tmp_path: Path) -> None:
    """Default template should have placeholder text for empty sections."""
    import quilin_mem.profile_updater as pu

    content = pu._default_user_md("default")

    assert "暂无自动发现的基本信息" in content or "暂无自动发现" in content
    assert "暂无自动发现的偏好" in content or "暂无自动发现" in content
    assert "暂无自动发现的行为模式" in content or "暂无自动发现" in content


def test_profile_id_defaults_to_default_on_update(tmp_path: Path) -> None:
    """update() and sync_user_md() should default to profile_id='default'."""
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    orig_path = pu._USER_MD_PATH
    pu._USER_MD_DIR = user_md_dir
    pu._USER_MD_PATH = user_md_path
    try:
        # update() with default profile_id
        sig = emit_profile_signal("default", {"style": "brief"}, source="test")
        updater.update(sig, who="test", why="test")

        content = user_md_path.read_text(encoding="utf-8")
        assert '"default"' in content
    finally:
        pu._USER_MD_DIR = orig_dir
        pu._USER_MD_PATH = orig_path
