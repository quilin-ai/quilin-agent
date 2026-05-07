from __future__ import annotations

from pathlib import Path

from quilin_mem.profile_store import ProfileStore, UserProfile
from quilin_mem.profile_updater import ProfileUpdater


def test_user_profile_exports_stable_markdown_without_sensitive_fields(tmp_path: Path) -> None:
    profile = UserProfile(
        profile_id="profile-1",
        non_sensitive={"communication_style": "concise", "workflow": ["test", "ship"]},
        sensitive={"real_name": "Ada", "contact": "ada@example.test"},
        updated_by="profile_updater",
    )
    path = tmp_path / ".quilin" / "user.md"

    profile.export_markdown(path)

    exported = path.read_text(encoding="utf-8")
    assert exported.startswith('---\nschema_version: 1\nprofile_id: "profile-1"\n')
    assert "sensitive_export: false" in exported
    assert "communication_style" in exported
    assert "real_name" not in exported
    assert "ada@example" not in exported


def test_user_profile_sensitive_export_is_explicit_single_call(tmp_path: Path) -> None:
    profile = UserProfile(
        profile_id="profile-1",
        non_sensitive={"workflow": "tests first"},
        sensitive={"real_name": "Ada"},
    )
    path = tmp_path / "user.md"

    profile.export_markdown(path, include_sensitive=True)

    exported = path.read_text(encoding="utf-8")
    assert "sensitive_export: true" in exported
    assert '- real_name: "Ada"' in exported


def test_sync_from_markdown_routes_through_profile_updater(tmp_path: Path) -> None:
    fixture = Path(__file__).parent / "fixtures" / ".quilin" / "user.md"
    target = tmp_path / ".quilin" / "user.md"
    target.parent.mkdir(parents=True)
    target.write_text(fixture.read_text(encoding="utf-8"), encoding="utf-8")
    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)

    audit = store.sync_from_markdown(target, updater=updater, who="user_edit", why="mirror sync")

    profile = store.get_profile("fixture-profile")
    assert profile is not None
    assert profile.non_sensitive["communication_style"] == "direct and concise"
    assert profile.sensitive == {}
    assert audit.source == "user.md"
    assert audit.who == "user_edit"
    assert store.list_audit("fixture-profile")[0].diff["non_sensitive"]
