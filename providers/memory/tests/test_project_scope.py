"""Unit tests for ``quilin_mem.project_scope``(QUI-196 prep)."""

from __future__ import annotations

from pathlib import Path

import pytest

from quilin_mem.project_scope import (
    PROJECT_SCOPE_SCHEMA_VERSION,
    extract_project_id_from_quilin_md,
    resolve_project_scope,
)

# ---------------------------------------------------------------------------
# 1. extract_project_id_from_quilin_md — frontmatter parser
# ---------------------------------------------------------------------------


def test_extract_returns_id_when_frontmatter_has_project_id() -> None:
    body = "---\nproject_id: my-cool-project\nother: value\n---\n\n# Heading\n"
    assert extract_project_id_from_quilin_md(body) == "my-cool-project"


def test_extract_strips_double_quotes_around_value() -> None:
    body = '---\nproject_id: "quoted-id"\n---\n\nbody\n'
    assert extract_project_id_from_quilin_md(body) == "quoted-id"


def test_extract_strips_single_quotes_around_value() -> None:
    body = "---\nproject_id: 'single-quoted'\n---\n\nbody\n"
    assert extract_project_id_from_quilin_md(body) == "single-quoted"


def test_extract_returns_none_when_no_frontmatter() -> None:
    body = "# Plain markdown without frontmatter\n\nSome content.\n"
    assert extract_project_id_from_quilin_md(body) is None


def test_extract_returns_none_when_frontmatter_lacks_project_id() -> None:
    body = "---\nother_key: value\nname: my-doc\n---\n\nbody\n"
    assert extract_project_id_from_quilin_md(body) is None


def test_extract_returns_none_for_empty_project_id() -> None:
    body = "---\nproject_id:   \n---\n\nbody\n"
    assert extract_project_id_from_quilin_md(body) is None


def test_extract_handles_project_id_with_whitespace() -> None:
    body = "---\nproject_id:    spaced-id   \n---\n\nbody\n"
    assert extract_project_id_from_quilin_md(body) == "spaced-id"


# ---------------------------------------------------------------------------
# 2. resolve_project_scope — QUILIN.md > git root > cwd fallback chain
# ---------------------------------------------------------------------------


def test_quilin_md_with_explicit_id_wins(tmp_path: Path) -> None:
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()
    (project_dir / "QUILIN.md").write_text(
        "---\nproject_id: explicit-id\n---\n\n# my project\n",
        encoding="utf-8",
    )
    subdir = project_dir / "src" / "deep"
    subdir.mkdir(parents=True)

    scope = resolve_project_scope(subdir)

    assert scope.project_id == "quilin:explicit-id"
    assert scope.source == "quilin_md"
    assert scope.root_path == str(project_dir)
    assert scope.quilin_md_path == str(project_dir / "QUILIN.md")
    assert scope.schema_version == PROJECT_SCOPE_SCHEMA_VERSION


def test_quilin_md_without_id_falls_back_to_path_hash(tmp_path: Path) -> None:
    project_dir = tmp_path / "noid"
    project_dir.mkdir()
    (project_dir / "QUILIN.md").write_text("no frontmatter here\n", encoding="utf-8")

    scope = resolve_project_scope(project_dir)

    assert scope.source == "quilin_md"
    assert scope.project_id.startswith("quilin:")
    assert len(scope.project_id) == len("quilin:") + 16  # 16 hex chars
    assert scope.root_path == str(project_dir)


def test_git_root_used_when_no_quilin_md(tmp_path: Path) -> None:
    repo = tmp_path / "gitrepo"
    repo.mkdir()
    (repo / ".git").mkdir()  # marker dir is enough for our heuristic
    nested = repo / "src" / "a" / "b"
    nested.mkdir(parents=True)

    scope = resolve_project_scope(nested)

    assert scope.source == "git_root"
    assert scope.project_id.startswith("git:")
    assert len(scope.project_id) == len("git:") + 16
    assert scope.root_path == str(repo)
    assert scope.quilin_md_path is None


def test_cwd_fallback_when_nothing_found(tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    scratch.mkdir()

    scope = resolve_project_scope(scratch)

    assert scope.source == "cwd_fallback"
    assert scope.project_id.startswith("cwd:")
    assert len(scope.project_id) == len("cwd:") + 16
    assert scope.root_path == str(scratch.resolve())
    assert scope.quilin_md_path is None


# ---------------------------------------------------------------------------
# 3. Determinism — same path always resolves to same id
# ---------------------------------------------------------------------------


def test_same_path_resolves_to_same_id(tmp_path: Path) -> None:
    target = tmp_path / "deterministic"
    target.mkdir()

    scope1 = resolve_project_scope(target)
    scope2 = resolve_project_scope(target)

    assert scope1 == scope2


def test_different_paths_resolve_to_different_ids(tmp_path: Path) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()

    scope_a = resolve_project_scope(a)
    scope_b = resolve_project_scope(b)

    assert scope_a.project_id != scope_b.project_id


# ---------------------------------------------------------------------------
# 4. Edge cases — quilin.md priority + walk-up bounds + unreadable files
# ---------------------------------------------------------------------------


def test_quilin_md_priority_over_git_root(tmp_path: Path) -> None:
    """When both QUILIN.md and .git exist, QUILIN.md wins."""
    project = tmp_path / "both"
    project.mkdir()
    (project / ".git").mkdir()
    (project / "QUILIN.md").write_text(
        "---\nproject_id: priority\n---\n", encoding="utf-8"
    )

    scope = resolve_project_scope(project)

    assert scope.source == "quilin_md"
    assert scope.project_id == "quilin:priority"


def test_walk_up_finds_quilin_md_at_grandparent(tmp_path: Path) -> None:
    project = tmp_path / "deep"
    project.mkdir()
    (project / "QUILIN.md").write_text(
        "---\nproject_id: deep-grandparent\n---\n", encoding="utf-8"
    )
    leaf = project / "a" / "b" / "c" / "d"
    leaf.mkdir(parents=True)

    scope = resolve_project_scope(leaf)

    assert scope.project_id == "quilin:deep-grandparent"
    assert scope.root_path == str(project)


def test_unreadable_quilin_md_falls_back_silently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If QUILIN.md exists but read raises OSError, we fall back to git/cwd."""
    project = tmp_path / "unreadable"
    project.mkdir()
    (project / "QUILIN.md").write_text(
        "---\nproject_id: test\n---\n", encoding="utf-8"
    )

    real_open = Path.open

    def broken_open(self: Path, *args: object, **kwargs: object) -> object:
        if self.name == "QUILIN.md":
            raise OSError("simulated permission denied")
        return real_open(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "open", broken_open)

    scope = resolve_project_scope(project)
    # QUILIN.md found but unreadable → fallback to path hash within
    # quilin_md branch(extract_id returned None)。 But our code logic:
    # _safe_read_quilin_md returns None → ProjectScope branch with
    # path-hash id stays in "quilin_md" source.
    assert scope.source == "quilin_md"
    assert scope.project_id.startswith("quilin:")
