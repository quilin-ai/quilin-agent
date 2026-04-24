from __future__ import annotations

from pathlib import Path

import pytest

from omnimem.profile_store import ProfileStore, UserProfile, emit_profile_signal
from omnimem.profile_updater import ProfileUpdater


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
