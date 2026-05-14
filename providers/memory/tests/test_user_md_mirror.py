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
    assert exported.startswith("<!-- quilin-profile schema=1 ")
    assert 'profile_id="profile-1"' in exported
    assert "sensitive_export=false" in exported
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
    assert "sensitive_export=true" in exported
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


def test_format_user_md_output_round_trips_through_from_markdown(tmp_path: Path) -> None:
    """Regression: `_format_user_md` must emit a header `from_markdown` can parse.

    Previous bug: `_format_user_md` wrote `last_updated=...` but
    `UserProfile.from_markdown` required `updated_at` — silent cross-function
    contract drift.
    """
    import quilin_mem.profile_updater as pu

    rendered = pu._format_user_md(
        "profile-99",
        {"communication_style": "terse"},
        "2026-05-15T01:23:45+00:00",
        updated_by="profile_updater",
        scope="global_projection",
    )

    profile = UserProfile.from_markdown(rendered)

    assert profile.profile_id == "profile-99"
    assert profile.scope == "global_projection"
    assert profile.updated_by == "profile_updater"
    assert profile.non_sensitive.get("communication_style") == "terse"


def test_metadata_value_with_comment_close_is_rejected() -> None:
    """Comment-injection guard: writers refuse `-->` inside metadata values."""
    import pytest

    import quilin_mem.profile_updater as pu

    with pytest.raises(ValueError, match="-->"):
        pu._format_user_md(
            "bad-->profile",
            {},
            "2026-05-15T00:00:00+00:00",
        )

    # scope-specific guard (covers the dedicated `if "-->" in scope` branch).
    with pytest.raises(ValueError, match="-->"):
        pu._format_user_md(
            "x",
            {},
            "2026-05-15T00:00:00+00:00",
            scope="evil-->scope",
        )

    profile = UserProfile(
        profile_id="legit",
        non_sensitive={},
        sensitive={},
        updated_by="evil --> closes comment",
    )
    with pytest.raises(ValueError, match="-->"):
        profile.to_markdown()


def test_metadata_value_rejects_control_chars() -> None:
    """NUL, LSEP (U+2028), PSEP (U+2029) are forbidden in metadata values."""
    import pytest

    import quilin_mem.profile_updater as pu

    # _safe_metadata_value (used by _format_user_md)
    with pytest.raises(ValueError, match="U\\+0000"):
        pu._safe_metadata_value("contains\x00nul")
    with pytest.raises(ValueError, match="U\\+2028"):
        pu._safe_metadata_value("contains lsep")
    with pytest.raises(ValueError, match="U\\+2029"):
        pu._safe_metadata_value("contains psep")

    # UserProfile.to_markdown guard — exercise all three forbidden codepoints
    # so a future refactor that drops one is caught by tests.
    for forbidden_char, expected_codepoint in (
        ("\x00", "U\\+0000"),
        (" ", "U\\+2028"),
        (" ", "U\\+2029"),
    ):
        profile = UserProfile(
            profile_id="legit",
            non_sensitive={},
            sensitive={},
            updated_by=f"contains{forbidden_char}forbidden",
        )
        with pytest.raises(ValueError, match=expected_codepoint):
            profile.to_markdown()


def test_profile_body_parser_skips_empty_bold_keys() -> None:
    """A degenerate hand-edit line ``- **: value`` should not insert
    an empty-string key into the parsed profile.
    """
    from quilin_mem.profile_store import _profile_body_from_markdown

    parsed = _profile_body_from_markdown(
        "## Section\n\n- **: 'value-should-be-ignored'\n- key: 1\n"
    )
    assert "" not in parsed
    assert parsed == {"key": 1}


def test_parser_handles_json_escape_inside_quoted_metadata() -> None:
    """`_split_header_tokens` must honor JSON backslash escapes so that
    a value like ``"Ray \\"admin\\""`` parses as one token without flipping
    in_string state on the inner quotes.
    """
    from quilin_mem.profile_store import _find_comment_close, _split_header_tokens

    raw = 'schema=1 profile_id="abc" updated_by="Ray \\"admin\\""'
    tokens = _split_header_tokens(raw)
    assert tokens == ['schema=1', 'profile_id="abc"', 'updated_by="Ray \\"admin\\""']

    # `_find_comment_close` should skip `-->` occurrences inside quoted strings.
    markdown = (
        '<!-- quilin-profile schema=1 profile_id="abc" '
        'updated_by="contains-->arrow but in quotes" '
        'scope=project updated_at="2026-05-15T00:00:00+00:00" '
        'sensitive_export=false -->\n\n# Body\n'
    )
    close = _find_comment_close(markdown, len("<!-- quilin-profile"))
    # The close marker must be the trailing one, not the one inside the quotes.
    assert markdown[close:close + 3] == "-->"
    assert markdown[close - 1] == " "  # space before the real close


def test_sensitive_export_string_false_is_not_truthy(tmp_path: Path) -> None:
    """Regression: a header that says `sensitive_export=false` must not
    leak sensitive fields when round-tripped, even if the value comes back
    from parse as the string ``"false"`` rather than Python ``False``.
    """
    markdown = (
        '<!-- quilin-profile schema=1 profile_id="x" scope=project '
        'updated_at="2026-05-15T00:00:00+00:00" updated_by="u" '
        'sensitive_export=false -->\n'
        '\n# User Profile\n\n- real_name: "ShouldBeDropped"\n'
    )

    profile = UserProfile.from_markdown(markdown)

    assert profile.sensitive == {}
    assert "real_name" not in profile.non_sensitive
