from __future__ import annotations

import json
import os
import sqlite3
import threading
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Self

PROFILE_SCHEMA_VERSION = 1
PROFILE_AUDIT_SOURCE_MARKDOWN = "user.md"
SENSITIVE_PROFILE_FIELDS = frozenset({"real_name", "contact", "location", "tokens", "birthday"})

ProfileScope = Literal["project", "global_projection"]


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _default_profile_db_path() -> str:
    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"

    return os.environ.get("QUILIN_MEM_DB_PATH", str(Path.home() / ".quilin" / "memory.db"))


@dataclass(frozen=True, slots=True)
class UserProfile:
    profile_id: str
    non_sensitive: dict[str, Any] = field(default_factory=dict)
    sensitive: dict[str, Any] = field(default_factory=dict)
    schema_version: int = PROFILE_SCHEMA_VERSION
    scope: ProfileScope = "project"
    updated_at: datetime = field(default_factory=_utcnow)
    updated_by: str = "profile_updater"

    def __post_init__(self) -> None:
        if self.schema_version != PROFILE_SCHEMA_VERSION:
            raise ValueError("UserProfile.schema_version must be 1")
        if self.scope not in ("project", "global_projection"):
            raise ValueError("UserProfile.scope must be project or global_projection")
        leaked = SENSITIVE_PROFILE_FIELDS.intersection(self.non_sensitive)
        if leaked:
            fields = ", ".join(sorted(leaked))
            raise ValueError(f"sensitive fields cannot be non_sensitive: {fields}")

        object.__setattr__(self, "non_sensitive", dict(self.non_sensitive))
        object.__setattr__(self, "sensitive", dict(self.sensitive))

    def export_markdown(self, path: str | Path, *, include_sensitive: bool = False) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            self.to_markdown(include_sensitive=include_sensitive),
            encoding="utf-8",
        )

    def to_markdown(self, *, include_sensitive: bool = False) -> str:
        """Render the profile as pure markdown with an invisible HTML
        comment header carrying machine-readable metadata.

        User directive 2026-05-15: profile files are pure markdown, no
        YAML frontmatter. The HTML comment is invisible when rendered
        but parseable for round-trip.

        Comment-injection guard: every quoted value is screened for the
        substring ``-->`` which would early-terminate the surrounding
        comment and leak the rest of the value into rendered body.
        """
        for raw in (self.profile_id, self.updated_at.isoformat(), self.updated_by, self.scope):
            if "-->" in raw:
                raise ValueError(
                    "profile metadata value cannot contain '-->'; "
                    "it would early-terminate the user.md header comment"
                )
            for forbidden in ("\x00", " ", " "):
                if forbidden in raw:
                    raise ValueError(
                        f"profile metadata value contains forbidden control "
                        f"character U+{ord(forbidden):04X}"
                    )
        metadata = {
            "schema": str(self.schema_version),
            "profile_id": json.dumps(self.profile_id),
            "updated_at": json.dumps(self.updated_at.isoformat()),
            "updated_by": json.dumps(self.updated_by),
            "scope": self.scope,
            "sensitive_export": "true" if include_sensitive else "false",
        }
        header = "<!-- quilin-profile " + " ".join(
            f"{key}={value}" for key, value in metadata.items()
        ) + " -->\n\n"

        body_profile = dict(self.non_sensitive)
        if include_sensitive:
            body_profile.update(
                {
                    key: value
                    for key, value in self.sensitive.items()
                    if key in SENSITIVE_PROFILE_FIELDS
                }
            )

        return (
            f"{header}"
            "# User Profile\n\n"
            f"{_profile_body_to_markdown(body_profile)}"
        )

    @classmethod
    def from_markdown(cls, markdown: str) -> Self:
        metadata, body = parse_profile_header(markdown)
        schema_version = int(metadata.get("schema", metadata.get("schema_version", 0)))
        if schema_version != PROFILE_SCHEMA_VERSION:
            raise ValueError("user.md schema_version must be 1")

        body_profile = _profile_body_from_markdown(body)
        sensitive_export_raw = metadata.get("sensitive_export", False)
        # Identity check, not bool() — bool("false") == True, which would
        # silently leak sensitive fields. Only Python True or the literal
        # string "true" (lowercased) counts as opt-in.
        sensitive_export = (
            sensitive_export_raw is True
            or (isinstance(sensitive_export_raw, str) and sensitive_export_raw.lower() == "true")
        )
        sensitive = {
            key: body_profile.pop(key)
            for key in list(body_profile)
            if key in SENSITIVE_PROFILE_FIELDS and sensitive_export
        }
        for key in SENSITIVE_PROFILE_FIELDS:
            body_profile.pop(key, None)

        return cls(
            profile_id=str(metadata["profile_id"]),
            schema_version=schema_version,
            scope=_validate_scope(str(metadata["scope"])),
            updated_at=datetime.fromisoformat(str(metadata["updated_at"])),
            updated_by=str(metadata["updated_by"]),
            non_sensitive=body_profile,
            sensitive=sensitive,
        )


@dataclass(frozen=True, slots=True)
class ProfileSignal:
    profile_id: str
    updates: dict[str, Any]
    sensitive_updates: dict[str, Any] = field(default_factory=dict)
    scope: ProfileScope = "project"
    source: str = "candidate"

    def __post_init__(self) -> None:
        leaked = SENSITIVE_PROFILE_FIELDS.intersection(self.updates)
        if leaked:
            fields = ", ".join(sorted(leaked))
            raise ValueError(f"use sensitive_updates for sensitive fields: {fields}")
        object.__setattr__(self, "updates", dict(self.updates))
        object.__setattr__(self, "sensitive_updates", dict(self.sensitive_updates))


@dataclass(frozen=True, slots=True)
class ProfileAuditEntry:
    profile_id: str
    who: str
    when: datetime
    why: str
    diff: dict[str, Any]
    source: str
    sensitive_export: bool = False


def emit_profile_signal(
    profile_id: str,
    updates: dict[str, Any],
    *,
    sensitive_updates: dict[str, Any] | None = None,
    scope: ProfileScope = "project",
    source: str = "candidate",
) -> ProfileSignal:
    """Create a candidate profile signal without mutating durable state."""
    return ProfileSignal(
        profile_id=profile_id,
        updates=updates,
        sensitive_updates=sensitive_updates or {},
        scope=scope,
        source=source,
    )


class ProfileStore:
    """SQLite persistence for UserProfile.

    The default database is QUILIN_MEM_DB_PATH so profile state is backed up and
    deployed with the rest of quilin-mem while staying in independent tables.
    """

    def __init__(self, db_path: str | None = None) -> None:
        resolved_path = db_path or _default_profile_db_path()
        if resolved_path != ":memory:":
            Path(resolved_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(
            resolved_path,
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._ensure_schema()

    def get_profile(self, profile_id: str) -> UserProfile | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT profile_id, schema_version, scope, non_sensitive_json,
                       sensitive_json, updated_at, updated_by
                FROM user_profiles
                WHERE profile_id = ?
                """,
                (profile_id,),
            ).fetchone()
        if row is None:
            return None

        return _row_to_profile(row)

    def list_audit(self, profile_id: str) -> list[ProfileAuditEntry]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT profile_id, who, when_at, why, diff_json, source, sensitive_export
                FROM user_profile_audit
                WHERE profile_id = ?
                ORDER BY id
                """,
                (profile_id,),
            ).fetchall()

        return [
            ProfileAuditEntry(
                profile_id=str(row["profile_id"]),
                who=str(row["who"]),
                when=datetime.fromisoformat(str(row["when_at"])),
                why=str(row["why"]),
                diff=json.loads(str(row["diff_json"])),
                source=str(row["source"]),
                sensitive_export=bool(row["sensitive_export"]),
            )
            for row in rows
        ]

    def sync_from_markdown(
        self,
        path: str | Path,
        *,
        updater: Any,
        who: str,
        why: str,
    ) -> ProfileAuditEntry:
        profile = UserProfile.from_markdown(Path(path).read_text(encoding="utf-8"))
        signal = emit_profile_signal(
            profile.profile_id,
            profile.non_sensitive,
            sensitive_updates=profile.sensitive,
            scope=profile.scope,
            source=PROFILE_AUDIT_SOURCE_MARKDOWN,
        )
        return updater.apply_signal(signal, who=who, why=why)

    def _apply_signal(
        self,
        signal: ProfileSignal,
        *,
        who: str,
        why: str,
        when: datetime | None = None,
    ) -> ProfileAuditEntry:
        timestamp = when or _utcnow()
        with self._lock:
            current = self.get_profile(signal.profile_id)
            if current is None:
                current = UserProfile(profile_id=signal.profile_id, scope=signal.scope)

            next_profile = replace(
                current,
                non_sensitive={**current.non_sensitive, **signal.updates},
                sensitive={**current.sensitive, **signal.sensitive_updates},
                scope=signal.scope,
                updated_at=timestamp,
                updated_by=who,
            )
            diff = _profile_diff(current, next_profile)
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._upsert_profile_locked(next_profile)
                self._insert_audit_locked(
                    ProfileAuditEntry(
                        profile_id=next_profile.profile_id,
                        who=who,
                        when=timestamp,
                        why=why,
                        diff=diff,
                        source=signal.source,
                    )
                )

        return ProfileAuditEntry(
            profile_id=signal.profile_id,
            who=who,
            when=timestamp,
            why=why,
            diff=diff,
            source=signal.source,
        )

    def _reset(self) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute("DELETE FROM user_profile_audit")
                self._conn.execute("DELETE FROM user_profiles")

    def _ensure_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_profiles (
                    profile_id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
                    scope TEXT NOT NULL CHECK (scope IN ('project', 'global_projection')),
                    non_sensitive_json TEXT NOT NULL,
                    sensitive_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    updated_by TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_profile_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id TEXT NOT NULL,
                    who TEXT NOT NULL,
                    when_at TEXT NOT NULL,
                    why TEXT NOT NULL,
                    diff_json TEXT NOT NULL,
                    source TEXT NOT NULL,
                    sensitive_export INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            self._conn.commit()

    def _upsert_profile_locked(self, profile: UserProfile) -> None:
        self._conn.execute(
            """
            INSERT INTO user_profiles (
                profile_id, schema_version, scope, non_sensitive_json,
                sensitive_json, updated_at, updated_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(profile_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                scope = excluded.scope,
                non_sensitive_json = excluded.non_sensitive_json,
                sensitive_json = excluded.sensitive_json,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
            """,
            (
                profile.profile_id,
                profile.schema_version,
                profile.scope,
                _stable_json(profile.non_sensitive),
                _stable_json(profile.sensitive),
                profile.updated_at.isoformat(),
                profile.updated_by,
            ),
        )

    def _insert_audit_locked(self, entry: ProfileAuditEntry) -> None:
        self._conn.execute(
            """
            INSERT INTO user_profile_audit (
                profile_id, who, when_at, why, diff_json, source, sensitive_export
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry.profile_id,
                entry.who,
                entry.when.isoformat(),
                entry.why,
                _stable_json(entry.diff),
                entry.source,
                int(entry.sensitive_export),
            ),
        )


def _row_to_profile(row: sqlite3.Row) -> UserProfile:
    return UserProfile(
        profile_id=str(row["profile_id"]),
        schema_version=int(row["schema_version"]),
        scope=_validate_scope(str(row["scope"])),
        non_sensitive=json.loads(str(row["non_sensitive_json"])),
        sensitive=json.loads(str(row["sensitive_json"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
        updated_by=str(row["updated_by"]),
    )


def _profile_diff(before: UserProfile, after: UserProfile) -> dict[str, Any]:
    return {
        "non_sensitive": _dict_diff(before.non_sensitive, after.non_sensitive),
        "sensitive": {
            key: {"before": _redact(before.sensitive.get(key)), "after": _redact(value)}
            for key, value in sorted(after.sensitive.items())
            if before.sensitive.get(key) != value
        },
        "scope": (
            {"before": before.scope, "after": after.scope} if before.scope != after.scope else None
        ),
    }


def _dict_diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    keys = sorted(set(before) | set(after))
    return {
        key: {"before": before.get(key), "after": after.get(key)}
        for key in keys
        if before.get(key) != after.get(key)
    }


def _redact(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return "<redacted>"


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _validate_scope(scope: str) -> ProfileScope:
    if scope not in ("project", "global_projection"):
        raise ValueError("profile scope must be project or global_projection")
    return scope


def parse_frontmatter(markdown: str) -> tuple[dict[str, Any], str]:
    if not markdown.startswith("---\n"):
        raise ValueError("markdown must start with YAML frontmatter")
    end = markdown.find("\n---\n", 4)
    if end < 0:
        raise ValueError("markdown frontmatter must be closed")

    raw_frontmatter = markdown[4:end]
    body = markdown[end + 5 :]
    return _load_simple_yaml(raw_frontmatter), body


_PROFILE_HEADER_MARKER = "<!-- quilin-profile"


def parse_profile_header(markdown: str) -> tuple[dict[str, Any], str]:
    """Parse the pure-markdown profile header (HTML comment) into metadata.

    Format: ``<!-- quilin-profile key1=value1 key2=value2 ... -->``
    Values are JSON-parsed when possible (so quoted strings unquote),
    otherwise kept as-is.

    Backward compatibility: if the markdown starts with legacy YAML
    frontmatter (``---\\n...---\\n``), defer to ``parse_frontmatter``.
    """
    stripped_lead = markdown.lstrip()
    if stripped_lead.startswith("---\n"):
        # Legacy YAML shape — delegate so old files still round-trip.
        return parse_frontmatter(markdown)
    if not stripped_lead.startswith(_PROFILE_HEADER_MARKER):
        raise ValueError("markdown must start with quilin-profile header comment")

    leading_offset = len(markdown) - len(stripped_lead)
    end_marker = _find_comment_close(markdown, leading_offset + len(_PROFILE_HEADER_MARKER))
    if end_marker < 0:
        raise ValueError("quilin-profile header comment must be closed with -->")

    header_inner = markdown[leading_offset + len(_PROFILE_HEADER_MARKER) : end_marker].strip()
    body_start = end_marker + len("-->")
    body = markdown[body_start:].lstrip("\n")

    metadata: dict[str, Any] = {}
    for token in _split_header_tokens(header_inner):
        key, separator, raw_value = token.partition("=")
        if not separator:
            raise ValueError(f"invalid quilin-profile header token: {token}")
        metadata[key.strip()] = _parse_scalar(raw_value.strip())
    return metadata, body


def _find_comment_close(markdown: str, start: int) -> int:
    """Find the first ``-->`` outside of any JSON-quoted string region.

    Defensive against pathological values containing ``-->``: even though
    the writers reject such values (see ``_safe_metadata_value`` and the
    ``to_markdown`` guard), the parser still treats string-internal
    occurrences as not closing the comment.
    """
    in_string = False
    escape_next = False
    i = start
    end = len(markdown)
    while i < end:
        ch = markdown[i]
        if escape_next:
            escape_next = False
            i += 1
            continue
        if in_string and ch == "\\":
            escape_next = True
            i += 1
            continue
        if ch == '"':
            in_string = not in_string
            i += 1
            continue
        if not in_string and markdown.startswith("-->", i):
            return i
        i += 1
    return -1


def _split_header_tokens(header: str) -> list[str]:
    """Split a header line by spaces, keeping JSON-quoted strings intact.

    Handles JSON escape sequences inside quoted values: a backslash makes
    the following character literal, so ``"Ray \\"admin\\""`` does not
    prematurely flip ``in_string``.
    """
    tokens: list[str] = []
    buffer: list[str] = []
    in_string = False
    escape_next = False
    for ch in header:
        if escape_next:
            buffer.append(ch)
            escape_next = False
            continue
        if in_string and ch == "\\":
            buffer.append(ch)
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            buffer.append(ch)
        elif ch.isspace() and not in_string:
            if buffer:
                tokens.append("".join(buffer))
                buffer = []
        else:
            buffer.append(ch)
    if buffer:
        tokens.append("".join(buffer))
    return tokens


def _dump_simple_yaml(values: dict[str, Any]) -> str:
    lines: list[str] = []
    for key, value in values.items():
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, int | float):
            rendered = str(value)
        else:
            rendered = json.dumps(str(value))
        lines.append(f"{key}: {rendered}")
    return "\n".join(lines) + "\n"


def _load_simple_yaml(raw: str) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for line in raw.splitlines():
        if not line.strip():
            continue
        key, separator, value = line.partition(":")
        if not separator:
            raise ValueError(f"invalid frontmatter line: {line}")
        values[key.strip()] = _parse_scalar(value.strip())
    return values


def _parse_scalar(value: str) -> Any:
    if value == "true":
        return True
    if value == "false":
        return False
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        pass
    try:
        return int(value)
    except ValueError:
        return value


def _profile_body_to_markdown(values: dict[str, Any]) -> str:
    if not values:
        return "No durable non-sensitive preferences recorded.\n"

    lines = ["## Durable Fields", ""]
    for key in sorted(values):
        value = values[key]
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
        lines.append(f"- {key}: {rendered}")
    return "\n".join(lines) + "\n"


def _profile_body_from_markdown(body: str) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        key, separator, raw_value = stripped[2:].partition(":")
        if not separator:
            continue
        # _format_user_md renders keys as `**key**` (bold) for human
        # readability; UserProfile.to_markdown renders plain `key`. Strip
        # surrounding `**` so both shapes round-trip identically.
        normalized_key = key.strip()
        if normalized_key.startswith("**") and normalized_key.endswith("**"):
            normalized_key = normalized_key[2:-2].strip()
        if not normalized_key:
            continue
        values[normalized_key] = _parse_scalar(raw_value.strip())
    return values
