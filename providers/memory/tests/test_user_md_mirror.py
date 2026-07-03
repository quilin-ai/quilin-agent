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


def test_user_md_lock_serializes_concurrent_python_writes(tmp_path: Path) -> None:
    """Task #16 option C: fcntl-based advisory lock serializes Python-side
    writes so two threads / processes can't interleave the read-modify-write
    region.

    Hermetic via in-process threads. Each thread invokes ``sync_user_md``
    against the same tmp_path; the assertion is that all of them succeed
    AND the final file is well-formed (no torn writes / corrupted JSON
    in the header comment).
    """
    import threading

    from quilin_mem.profile_store import ProfileStore, emit_profile_signal
    from quilin_mem.profile_updater import ProfileUpdater

    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)
    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    pu._USER_MD_DIR = user_md_dir
    try:
        # Pre-populate a profile so sync writes content, not just template.
        signal = emit_profile_signal(
            "default", {"communication_style": "concise"}, source="test"
        )
        updater.apply_signal(signal, who="test", why="seed")

        errors: list[Exception] = []

        def worker() -> None:
            try:
                updater.sync_user_md(profile_id="default")
            except Exception as exc:  # noqa: BLE001 — propagate to main thread
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        # No thread crashed.
        assert errors == [], f"workers raised: {errors}"
        # Final file is well-formed: starts with the canonical HTML comment header.
        content = user_md_path.read_text(encoding="utf-8")
        assert content.startswith("<!-- quilin-profile schema=1 ")
        # And the profile field is present (proves the write actually completed).
        assert "communication_style" in content
    finally:
        pu._USER_MD_DIR = orig_dir


def test_user_md_lock_blocks_concurrent_acquirer_until_released(tmp_path: Path) -> None:
    """Falsifying test: the lock must actually block — a second thread
    that tries to acquire while the first holds it should NOT enter the
    critical section until the first releases.

    This is the test that would fail if `_user_md_lock` were a no-op:
    we record an explicit start/end timestamp from each thread and
    assert the intervals don't overlap.
    """
    import threading
    import time

    import quilin_mem.profile_updater as pu
    from quilin_mem.profile_updater import _user_md_lock

    orig_dir = pu._USER_MD_DIR
    pu._USER_MD_DIR = tmp_path
    try:
        intervals: list[tuple[float, float]] = []
        intervals_lock = threading.Lock()

        def worker() -> None:
            with _user_md_lock():
                start = time.monotonic()
                # Long enough that two concurrent threads would visibly
                # overlap if the lock did NOT serialize them.
                time.sleep(0.05)
                end = time.monotonic()
                with intervals_lock:
                    intervals.append((start, end))

        threads = [threading.Thread(target=worker) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        # Sort by start time and assert no overlap with the next interval.
        intervals.sort()
        for (_, end_i), (start_j, _) in zip(intervals, intervals[1:], strict=False):
            assert start_j >= end_i, (
                f"intervals overlapped: end={end_i} > next_start={start_j} — lock NOT serializing"
            )
    finally:
        pu._USER_MD_DIR = orig_dir


def test_user_md_lock_can_be_acquired_and_released_multiple_times(tmp_path: Path) -> None:
    """The lock context manager must be re-entrant across sequential calls
    (each call opens its own fd; no FD leak).
    """
    import quilin_mem.profile_updater as pu
    from quilin_mem.profile_updater import _user_md_lock

    orig_dir = pu._USER_MD_DIR
    pu._USER_MD_DIR = tmp_path
    try:
        for _ in range(5):
            with _user_md_lock():
                pass  # acquire + release each iteration
    finally:
        pu._USER_MD_DIR = orig_dir


def test_sync_user_md_preserves_quilin_observations_section(tmp_path: Path) -> None:
    """Race fix: ``sync_user_md`` must preserve any TS-appended observations
    in the ``## Quilin 观察 / Agent-observed notes`` section across rewrites.

    Without this, the Python side's full-overwrite-from-SQLite would
    silently wipe the TS profile-evolution.ts appends every time an
    observer signal fires (task #14).
    """
    from quilin_mem.profile_store import ProfileStore, emit_profile_signal
    from quilin_mem.profile_updater import ProfileUpdater

    store = ProfileStore(str(tmp_path / "memory.db"))
    updater = ProfileUpdater(store)
    user_md_dir = tmp_path / ".quilin"
    user_md_path = user_md_dir / "user.md"

    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    pu._USER_MD_DIR = user_md_dir
    try:
        # Step 1: bootstrap an auto-generated user.md.
        updater.sync_user_md(profile_id="default")
        first = user_md_path.read_text(encoding="utf-8")
        assert first.startswith("<!-- quilin-profile schema=1 ")
        # Template doesn't include observations section yet.
        assert "## Quilin 观察" not in first

        # Step 2: simulate the TS-side append — write the section back.
        ts_appended = (
            first
            + "\n## Quilin 观察 / Agent-observed notes\n\n"
            "- `2026-05-15T03:00:00.000Z` — 用户偏好简短回复\n"
            "- `2026-05-15T03:05:00.000Z` — 用户在 ~/.quilin 路径下手写过几段\n"
        )
        user_md_path.write_text(ts_appended, encoding="utf-8")

        # Step 3: trigger another observer signal → sync_user_md rewrites.
        signal = emit_profile_signal(
            "default",
            {"communication_style": "terse and direct"},
            source="observer",
        )
        updater.update(signal, who="l3a_observer", why="new finding")

        # Step 4: observations must survive.
        after = user_md_path.read_text(encoding="utf-8")
        assert "## Quilin 观察 / Agent-observed notes" in after
        assert "用户偏好简短回复" in after
        assert "用户在 ~/.quilin 路径下手写过几段" in after
        # And the new SQLite-driven finding is also reflected.
        assert "terse and direct" in after
    finally:
        pu._USER_MD_DIR = orig_dir


def test_extract_observations_section_returns_none_when_absent() -> None:
    """Helper returns None for files lacking the observations heading."""
    from quilin_mem.profile_updater import _extract_observations_section

    content = (
        "<!-- quilin-profile schema=1 -->\n\n"
        "# 关于用户\n\n## 基本信息\n\n- foo: bar\n"
    )
    assert _extract_observations_section(content) is None


def test_extract_observations_section_handles_heading_at_eof() -> None:
    """Heading is the last line of the file (no content, no trailing newline) —
    the helper should still return a non-None capture so sync_user_md can
    decide whether to re-append it.
    """
    from quilin_mem.profile_updater import _extract_observations_section

    content_no_trailing_nl = "# Title\n\n## Quilin 观察 / Agent-observed notes"
    extracted = _extract_observations_section(content_no_trailing_nl)
    assert extracted is not None
    assert extracted.strip() == "## Quilin 观察 / Agent-observed notes"

    content_with_trailing_nl = "# Title\n\n## Quilin 观察 / Agent-observed notes\n"
    extracted_nl = _extract_observations_section(content_with_trailing_nl)
    assert extracted_nl is not None
    assert "## Quilin 观察 / Agent-observed notes" in extracted_nl


def test_extract_observations_section_handles_crlf_line_endings() -> None:
    """The helper must work for files saved with Windows CRLF line endings."""
    from quilin_mem.profile_updater import _extract_observations_section

    content = (
        "# Title\r\n\r\n"
        "## Quilin 观察 / Agent-observed notes\r\n\r\n"
        "- observation with CRLF\r\n"
        "\r\n"
        "## 其他段落\r\n\r\n"
        "should NOT appear\r\n"
    )
    extracted = _extract_observations_section(content)
    assert extracted is not None
    assert "observation with CRLF" in extracted
    assert "should NOT appear" not in extracted


def test_extract_observations_section_stops_at_legacy_yaml_fence() -> None:
    """The helper must stop at a `---` line so a legacy YAML doc separator
    doesn't get folded into the captured observations section.
    """
    from quilin_mem.profile_updater import _extract_observations_section

    content = (
        "# Title\n\n"
        "## Quilin 观察 / Agent-observed notes\n\n"
        "- observation one\n"
        "\n"
        "---\n\n"
        "Footer that should NOT be captured.\n"
    )
    extracted = _extract_observations_section(content)
    assert extracted is not None
    assert "observation one" in extracted
    assert "Footer" not in extracted


def test_extract_observations_section_stops_at_next_h2() -> None:
    """The helper must NOT eat content from a sibling H2 below it."""
    from quilin_mem.profile_updater import _extract_observations_section

    content = (
        "# Title\n\n"
        "## Quilin 观察 / Agent-observed notes\n\n"
        "- observation 1\n"
        "- observation 2\n"
        "\n"
        "## 其他段落 / Other\n\n"
        "- should NOT be captured\n"
    )
    extracted = _extract_observations_section(content)
    assert extracted is not None
    assert "observation 1" in extracted
    assert "observation 2" in extracted
    assert "should NOT be captured" not in extracted
    assert "其他段落" not in extracted


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
