from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from .profile_store import ProfileAuditEntry, ProfileSignal, ProfileStore

_DEFAULT_PROFILE_ID = "default"
_USER_MD_DIR = Path.home() / ".quilin"
_USER_MD_PATH = _USER_MD_DIR / "user.md"


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _format_user_md(profile_id: str, non_sensitive: dict, updated_at: str) -> str:
    """Format a UserProfile as the canonical user.md Markdown."""
    frontmatter: dict[str, object] = {
        "schema_version": 1,
        "profile_id": profile_id,
        "scope": "global_projection",
        "last_updated": updated_at,
    }

    # Categorize non_sensitive fields into sections
    basic_info: dict[str, object] = {}
    preferences: dict[str, object] = {}
    habits: dict[str, object] = {}

    preference_keys = frozenset(
        {
            "communication_style",
            "language_preference",
            "tone",
            "verbosity",
            "response_style",
        }
    )
    habit_keys = frozenset({"workflow", "test_pattern", "coding_habit", "review_pattern"})

    for key, value in sorted(non_sensitive.items()):
        if key in preference_keys or "prefer" in key.lower():
            preferences[key] = value
        elif key in habit_keys or "habit" in key.lower() or "pattern" in key.lower():
            habits[key] = value
        else:
            basic_info[key] = value

    body_lines: list[str] = [
        "# 关于用户 / About the User",
        "",
        "## 基本信息 / Basic Info",
        "",
    ]
    if basic_info:
        for key, value in basic_info.items():
            rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
            body_lines.append(f"- **{key}**: {rendered}")
    else:
        body_lines.append("*（暂无自动发现的基本信息）*")

    body_lines.extend(["", "## 偏好 / Preferences", ""])
    if preferences:
        for key, value in preferences.items():
            rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
            body_lines.append(f"- **{key}**: {rendered}")
    else:
        body_lines.append("*（暂无自动发现的偏好）*")

    body_lines.extend(["", "## 习惯 / Habits", ""])
    if habits:
        for key, value in habits.items():
            rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
            body_lines.append(f"- **{key}**: {rendered}")
    else:
        body_lines.append("*（暂无自动发现的行为模式）*")

    body = "\n".join(body_lines) + "\n"

    fm_lines: list[str] = []
    for key, value in frontmatter.items():
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, int | float):
            rendered = str(value)
        else:
            rendered = json.dumps(str(value))
        fm_lines.append(f"{key}: {rendered}")

    return "---\n" + "\n".join(fm_lines) + "\n---\n\n" + body


def _default_user_md(profile_id: str = _DEFAULT_PROFILE_ID) -> str:
    """Generate a minimal user.md template when no profile exists."""
    return _format_user_md(profile_id, {}, _utcnow().isoformat())


def _is_auto_generated_user_md(path: Path) -> bool:
    """Detect whether `user.md` is in the auto-generated YAML-frontmatter
    shape produced by ``_format_user_md``. Returns False if the file is
    pure markdown / hand-edited — those should be left alone.

    判断 user.md 是否是 auto-generated 的 YAML frontmatter 形态。纯 markdown
    或手动编辑过的内容返回 False,sync_user_md 不会覆盖。

    Heuristic: an auto-generated file always starts with ``---\\n`` and a
    ``schema_version: 1`` line in the next handful of lines. Anything
    else is treated as user-authored.
    """
    try:
        first_chunk = path.read_text(encoding="utf-8", errors="replace")[:512]
    except OSError:
        return False
    if not first_chunk.lstrip().startswith("---"):
        return False
    header_lines = first_chunk.splitlines()[:12]
    for line in header_lines:
        stripped = line.strip()
        if stripped.startswith("schema_version"):
            return True
    return False


class ProfileUpdater:
    """Single durable write entrypoint for UserProfile changes."""

    def __init__(self, store: ProfileStore) -> None:
        self._store = store

    def apply_signal(
        self,
        signal: ProfileSignal,
        *,
        who: str,
        why: str,
    ) -> ProfileAuditEntry:
        return self._store._apply_signal(signal, who=who, why=why)

    def update(
        self,
        signal: ProfileSignal,
        *,
        who: str,
        why: str,
    ) -> ProfileAuditEntry:
        """Apply a signal to durable store and synchronize user.md.

        This is the primary entry point for observer-driven profile updates.
        After persisting the change it immediately mirrors to ~/.quilin/user.md.
        """
        entry = self.apply_signal(signal, who=who, why=why)
        self.sync_user_md(profile_id=signal.profile_id)
        return entry

    def bulk_apply(
        self,
        signals: Iterable[ProfileSignal],
        *,
        who: str,
        why: str,
    ) -> list[ProfileAuditEntry]:
        return [self.apply_signal(signal, who=who, why=why) for signal in signals]

    def bulk_update(
        self,
        signals: Iterable[ProfileSignal],
        *,
        who: str,
        why: str,
        profile_id: str = _DEFAULT_PROFILE_ID,
    ) -> list[ProfileAuditEntry]:
        """Apply multiple signals and synchronize user.md once (not per-signal).

        Use this when batching multiple observer findings to avoid redundant
        file writes.
        """
        entries = [self.apply_signal(signal, who=who, why=why) for signal in signals]
        if entries:
            self.sync_user_md(profile_id=profile_id)
        return entries

    def sync_user_md(self, profile_id: str = _DEFAULT_PROFILE_ID) -> None:
        """Read UserProfile from SQLite, format as Markdown, write to ~/.quilin/user.md.

        If no profile exists yet a minimal template is written so the file
        always exists for external readers (editor, cron, etc.).

        Honors a user-edit guard: when the existing file is NOT in the
        auto-generated YAML-frontmatter shape (i.e., it looks like manual
        markdown the user wrote), this method skips the overwrite to
        avoid clobbering hand-edits. User directive 2026-05-15: profile
        files should be pure markdown the user can shape, with the agent
        appending observations rather than rewriting wholesale. See
        docs/03-memory/profile-pure-markdown-migration.md.

        手动编辑过的 user.md(无 schema_version YAML 头)不会被覆盖。
        """
        if _USER_MD_PATH.exists() and not _is_auto_generated_user_md(_USER_MD_PATH):
            return
        profile = self._store.get_profile(profile_id)
        _USER_MD_DIR.mkdir(parents=True, exist_ok=True)
        if profile is None:
            content = _default_user_md(profile_id)
        else:
            content = _format_user_md(
                profile_id=profile.profile_id,
                non_sensitive=profile.non_sensitive,
                updated_at=profile.updated_at.isoformat(),
            )
        _USER_MD_PATH.write_text(content, encoding="utf-8")

    def reset(self) -> None:
        self._store._reset()
