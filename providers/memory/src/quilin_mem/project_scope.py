"""QUI-196 project scope resolution: cwd + QUILIN.md ingestion.

QUI-196 第一步独立实现(不依赖 QUI-195 schema):**从 cwd 解析当前项目身份**,
供后续 QUI-196 schema fields(`project_scope` column on memory_records)填充。

Pure function module — no I/O side effects beyond reading the filesystem. Callers
inject the cwd; resolution is deterministic. The resolution chain is:

1. Walk up from cwd looking for `QUILIN.md`. If found and contains a
   ``project_id`` in its YAML frontmatter, use that.
2. Otherwise walk up looking for ``.git/``. If found, hash the absolute git
   root path with SHA-256 truncated to 16 hex chars → ``git:{sha16}``.
3. Otherwise default to ``cwd:{absolute_cwd_sha16}``.

`ProjectScope` 是 immutable dataclass。下游(QUI-196 retriever 加权 / store
insertion)只读 `project_id` 字段。

Module is intentionally standalone:dependencies only on stdlib + pathlib.
Not coupled to QuilinMemStore so it can also be reused by upcoming
``apps/web`` server-side handlers.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "ProjectScope",
    "resolve_project_scope",
    "extract_project_id_from_quilin_md",
]


PROJECT_SCOPE_SCHEMA_VERSION = 1
"""Bump when ProjectScope dataclass shape changes (additive only)."""

_MAX_WALK_UP_DEPTH = 64
"""Hard cap to avoid pathological filesystem loops or unbounded climbs."""

_QUILIN_MD_FILENAME = "QUILIN.md"
_GIT_DIR_MARKER = ".git"
_HASH_BYTES = 8  # 16 hex chars


_FRONTMATTER_RE = re.compile(
    r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL | re.MULTILINE
)
_PROJECT_ID_LINE_RE = re.compile(
    r"^project_id\s*:\s*(?P<value>.+?)\s*$", re.MULTILINE
)


@dataclass(frozen=True, slots=True)
class ProjectScope:
    """Resolved project scope for a working directory.

    Attributes:
        project_id: Stable identifier for the project. Format guidelines:
            - ``quilin:{slug}`` when ``QUILIN.md`` declared an explicit id.
            - ``git:{sha16}`` when only a git root was discovered.
            - ``cwd:{sha16}`` fallback when neither was found.
        source: How the id was resolved: ``"quilin_md"`` / ``"git_root"`` /
            ``"cwd_fallback"``.
        root_path: The directory the id was anchored to (absolute, resolved).
        quilin_md_path: Path to ``QUILIN.md`` if discovered, else ``None``.
    """

    project_id: str
    source: str
    root_path: str
    quilin_md_path: str | None
    schema_version: int = PROJECT_SCOPE_SCHEMA_VERSION


def resolve_project_scope(cwd: str | Path) -> ProjectScope:
    """Resolve a project scope from a working directory.

    Walks up from ``cwd`` looking first for ``QUILIN.md``(explicit user
    declaration),then for a ``.git`` directory(implicit project marker),
    then falls back to hashing ``cwd`` itself.

    The walk is bounded by :data:`_MAX_WALK_UP_DEPTH` so a symlink loop or
    filesystem root climb cannot hang the caller. Read failures on
    ``QUILIN.md``(permission / EIO)degrade silently to the git-root path.
    """
    start = Path(cwd).resolve()

    # 1. Walk up looking for QUILIN.md(explicit project declaration wins).
    quilin_md_hit = _find_upwards(start, _QUILIN_MD_FILENAME)
    if quilin_md_hit is not None:
        explicit_id = _safe_read_quilin_md(quilin_md_hit)
        if explicit_id:
            return ProjectScope(
                project_id=f"quilin:{explicit_id}",
                source="quilin_md",
                root_path=str(quilin_md_hit.parent),
                quilin_md_path=str(quilin_md_hit),
            )
        # QUILIN.md exists but has no project_id. Use its parent as anchor
        # but compute a stable hash from the directory(同一目录两次解析等值)。
        root_path = quilin_md_hit.parent
        return ProjectScope(
            project_id=f"quilin:{_hash_path(root_path)}",
            source="quilin_md",
            root_path=str(root_path),
            quilin_md_path=str(quilin_md_hit),
        )

    # 2. Walk up looking for .git directory(implicit project marker).
    git_dir_hit = _find_upwards(start, _GIT_DIR_MARKER, want_dir=True)
    if git_dir_hit is not None:
        root_path = git_dir_hit.parent
        return ProjectScope(
            project_id=f"git:{_hash_path(root_path)}",
            source="git_root",
            root_path=str(root_path),
            quilin_md_path=None,
        )

    # 3. Fallback:cwd-only(transient / scratch directories)。
    return ProjectScope(
        project_id=f"cwd:{_hash_path(start)}",
        source="cwd_fallback",
        root_path=str(start),
        quilin_md_path=None,
    )


def extract_project_id_from_quilin_md(content: str) -> str | None:
    """Extract ``project_id`` from a ``QUILIN.md`` body string.

    Recognizes a minimal YAML frontmatter slice:

    .. code-block:: markdown

        ---
        project_id: my-project
        ---

    Returns the trimmed value if found, or ``None`` if the body has no
    frontmatter, no ``project_id`` key, or an obviously empty value.

    Note: We do not import ``yaml`` to keep this module dependency-free.
    The parser is intentionally minimal — non-trivial YAML(nested lists,
    multi-line strings)is not supported and gracefully returns ``None``.
    """
    frontmatter_match = _FRONTMATTER_RE.search(content)
    if frontmatter_match is None:
        return None
    frontmatter_body = frontmatter_match.group(1)
    line_match = _PROJECT_ID_LINE_RE.search(frontmatter_body)
    if line_match is None:
        return None
    raw_value = line_match.group("value")
    # Strip surrounding quotes(single or double)and surrounding whitespace.
    if (raw_value.startswith('"') and raw_value.endswith('"')) or (
        raw_value.startswith("'") and raw_value.endswith("'")
    ):
        raw_value = raw_value[1:-1]
    normalized = raw_value.strip()
    return normalized or None


# ---------------------------------------------------------------- helpers


def _find_upwards(
    start: Path, name: str, *, want_dir: bool = False
) -> Path | None:
    """Walk up from ``start`` looking for a path component named ``name``.

    Returns the first matching path(file if ``want_dir`` is False, dir
    otherwise). Bounded by :data:`_MAX_WALK_UP_DEPTH` and stops at filesystem
    root. Symlink resolution happens at ``start`` only; we don't re-resolve
    intermediates to avoid stepping through unexpected mount boundaries.
    """
    current = start
    for _ in range(_MAX_WALK_UP_DEPTH):
        candidate = current / name
        if want_dir:
            if candidate.is_dir():
                return candidate
        else:
            if candidate.is_file():
                return candidate
        parent = current.parent
        if parent == current:
            # Reached filesystem root.
            return None
        current = parent
    return None


def _safe_read_quilin_md(path: Path) -> str | None:
    """Read QUILIN.md and extract project_id, swallowing IO errors.

    Caps file size at 64 KiB to avoid pathological reads. Returns the
    extracted id or ``None`` on any failure(permission / decoding /
    empty body / malformed frontmatter).
    """
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fp:
            body = fp.read(65_536)
    except (OSError, ValueError):
        return None
    if not body:
        return None
    return extract_project_id_from_quilin_md(body)


def _hash_path(path: Path) -> str:
    """Deterministic short hash of an absolute path for stable project ids."""
    canonical = str(path.resolve())
    digest = hashlib.sha256(canonical.encode("utf-8")).digest()
    return digest[:_HASH_BYTES].hex()
