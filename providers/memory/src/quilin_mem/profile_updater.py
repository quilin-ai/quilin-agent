from __future__ import annotations

import json
import os
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from .profile_store import ProfileAuditEntry, ProfileSignal, ProfileStore

_DEFAULT_PROFILE_ID = "default"
_USER_MD_DIR = Path.home() / ".quilin"
_USER_MD_PATH = _USER_MD_DIR / "user.md"


def _utcnow() -> datetime:
    return datetime.now(UTC)


_AUTO_MARKER = "<!-- quilin-profile"


_FORBIDDEN_METADATA_CHARS = frozenset(("\x00", " ", " "))


def _safe_metadata_value(raw: str) -> str:
    """JSON-quote a metadata value and reject values that would corrupt
    the surrounding HTML comment or produce a malformed file.

    Rejects:
    - ``-->`` substring: would early-terminate the comment and leak the
      rest of the value into rendered markdown body.
    - NUL byte (``\\x00``): truncates the file in some C-string contexts.
    - Unicode line / paragraph separators (U+2028, U+2029): treated as
      line terminators by some parsers; harmless for the comment scope
      but produces malformed metadata.
    """
    if "-->" in raw:
        raise ValueError(
            "metadata value cannot contain '-->'; it would early-terminate "
            "the user.md header comment"
        )
    bad = _FORBIDDEN_METADATA_CHARS.intersection(raw)
    if bad:
        codepoints = ", ".join(f"U+{ord(ch):04X}" for ch in sorted(bad))
        raise ValueError(
            f"metadata value contains forbidden control character(s): {codepoints}"
        )
    return json.dumps(raw)


def _format_user_md(
    profile_id: str,
    non_sensitive: dict,
    updated_at: str,
    *,
    updated_by: str = "profile_updater",
    scope: str = "global_projection",
) -> str:
    """Format a UserProfile as canonical pure-markdown ``user.md``.

    User directive 2026-05-15: drop YAML frontmatter, render the file as
    pure markdown the user can read and edit. A single invisible HTML
    comment at the top preserves round-trip metadata (schema / id / scope
    / updated_at / updated_by / sensitive_export) so ``sync_from_markdown``
    can parse the auto-generated shape back into a ``UserProfile``.

    用户指示 2026-05-15:user.md 改用纯 markdown,不要 YAML frontmatter。
    元数据通过顶部一行 HTML 注释保留,既不渲染又可机读。手动编辑的文件
    不携带该注释 → ``sync_user_md`` 不会覆盖(见 ``_is_auto_generated_user_md``)。
    """
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

    # Defensive: even callers that pass validated `scope` values get
    # guarded against `-->` injection. Cheap and prevents footguns if
    # the function is reused for less-trusted inputs later.
    if "-->" in scope:
        raise ValueError(
            "scope cannot contain '-->'; it would early-terminate the header comment"
        )
    header = (
        f"{_AUTO_MARKER} schema=1 "
        f"profile_id={_safe_metadata_value(profile_id)} "
        f"scope={scope} "
        f"updated_at={_safe_metadata_value(updated_at)} "
        f"updated_by={_safe_metadata_value(updated_by)} "
        f"sensitive_export=false -->\n\n"
    )

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

    return header + "\n".join(body_lines) + "\n"


def _default_user_md(profile_id: str = _DEFAULT_PROFILE_ID) -> str:
    """Generate a minimal user.md template when no profile exists."""
    return _format_user_md(profile_id, {}, _utcnow().isoformat())


_OBSERVATIONS_HEADING = "## Quilin 观察 / Agent-observed notes"


def _extract_observations_section(existing: str) -> str | None:
    """Pull the ``## Quilin 观察 / Agent-observed notes`` section out of an
    existing user.md so ``sync_user_md`` can preserve it across overwrites.

    The TS-side ``profile-evolution.ts`` appends timestamped observations
    to this section without round-tripping to SQLite (see task #14). If
    we rewrote the file from SQLite alone, those appends would be lost.
    This helper extracts the section verbatim (heading inclusive,
    up to the next H2 boundary or EOF) so the caller can re-append it.

    Returns ``None`` if the section is absent — the common case for
    freshly-generated templates from ``_format_user_md`` (which doesn't
    emit this section).

    从已有 user.md 里抠出 "## Quilin 观察 / Agent-observed notes" 段,以便
    ``sync_user_md`` 覆盖时保留 TS 端追加的观察。未找到该段返回 None。
    """
    lines = existing.splitlines(keepends=True)
    start_idx: int | None = None
    for i, line in enumerate(lines):
        if line.strip() == _OBSERVATIONS_HEADING:
            start_idx = i
            break
    if start_idx is None:
        return None
    end_idx = len(lines)
    for j in range(start_idx + 1, len(lines)):
        stripped = lines[j].strip()
        # Next H2 boundary (or anything starting with `## `) closes the
        # section. The closing fence ``---`` from legacy YAML also closes.
        if stripped.startswith("## ") and stripped != _OBSERVATIONS_HEADING:
            end_idx = j
            break
        if stripped == "---":
            end_idx = j
            break
    return "".join(lines[start_idx:end_idx])


def _is_auto_generated_user_md(path: Path) -> bool:
    """Detect whether ``user.md`` is in the auto-generated shape produced
    by ``_format_user_md``. Hand-edited files (no marker comment) return
    False so ``sync_user_md`` leaves them alone.

    判断 user.md 是否是 auto-generated 形态。纯 markdown / 手动编辑过的
    文件没有顶部 HTML 注释标记,返回 False。

    Also accepts the legacy YAML-frontmatter shape for backward compat
    during the migration period.
    """
    try:
        first_chunk = path.read_text(encoding="utf-8", errors="replace")[:512]
    except OSError:
        return False
    stripped = first_chunk.lstrip()
    if stripped.startswith(_AUTO_MARKER):
        return True
    # Legacy YAML frontmatter detection (pre-2026-05-15 files)
    if stripped.startswith("---"):
        for line in first_chunk.splitlines()[:12]:
            if line.strip().startswith("schema_version"):
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

        Race fix (task #14, 2026-05-15): the TS-side ``profile-evolution.ts``
        appends observations to the ``## Quilin 观察 / Agent-observed notes``
        section of an auto-generated user.md without writing back to SQLite.
        Before overwriting, this method now extracts that section (if
        present) and re-appends it to the freshly generated content, so
        TS appends survive Python-side observer signal applies.

        Race 修复(task #14):TS ``profile-evolution.ts`` 在 ``## Quilin 观察``
        段追加用户观察但不回写 SQLite。覆盖前抠出该段并保留到新内容尾部。
        """
        if _USER_MD_PATH.exists() and not _is_auto_generated_user_md(_USER_MD_PATH):
            return

        preserved_observations: str | None = None
        if _USER_MD_PATH.exists():
            try:
                existing = _USER_MD_PATH.read_text(encoding="utf-8", errors="replace")
                preserved_observations = _extract_observations_section(existing)
            except OSError:
                preserved_observations = None

        profile = self._store.get_profile(profile_id)
        _USER_MD_DIR.mkdir(parents=True, exist_ok=True)
        if profile is None:
            content = _default_user_md(profile_id)
        else:
            content = _format_user_md(
                profile_id=profile.profile_id,
                non_sensitive=profile.non_sensitive,
                updated_at=profile.updated_at.isoformat(),
                updated_by=profile.updated_by,
                scope=profile.scope,
            )
        if preserved_observations is not None and preserved_observations.strip():
            if content.endswith("\n\n"):
                separator = ""
            elif content.endswith("\n"):
                separator = "\n"
            else:
                separator = "\n\n"
            content = f"{content}{separator}{preserved_observations.rstrip()}\n"
        # Atomic write: write to a temp file in the same directory, then
        # os.replace into place. Prevents partial-file readers from seeing
        # a half-written user.md if the process crashes mid-write.
        # NOTE residual race (task #14, second-pass review 2026-05-15): a
        # concurrent TS-side `appendFile` between this method's read at
        # line 306 and the rename below can still lose 1 observation. The
        # full fix would require cross-language flock coordination or
        # moving observations into SQLite. For the current local single-
        # user threat model (sub-second windows, recoverable data) we
        # accept the residual window and prefer atomicity over locks.
        tmp_path = _USER_MD_PATH.with_suffix(_USER_MD_PATH.suffix + ".tmp")
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(tmp_path, _USER_MD_PATH)

    def reset(self) -> None:
        self._store._reset()
