"""Unit tests for scripts/lint-planning.py (SD-08)."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent / "lint-planning.py"

spec = importlib.util.spec_from_file_location("lint_planning", SCRIPT_PATH)
assert spec and spec.loader
lint_planning = importlib.util.module_from_spec(spec)
sys.modules["lint_planning"] = lint_planning
spec.loader.exec_module(lint_planning)  # type: ignore[union-attr]


CLEAN_FRONTMATTER = """---
title: Example plan
status: planning
threat_surface_delta:
  new_ingress: []
  new_egress: []
  new_persistence: []
---

body text.
"""

NESTED_FRONTMATTER = """---
title: Phased plan
status: in-progress
threat_surface_delta:
  phase_0:
    new_ingress:
      - source: foo
    new_egress: []
    new_persistence: []
  phase_1:
    new_ingress: []
    new_egress: []
    new_persistence: []
---
"""

MISSING_KEY_FRONTMATTER = """---
title: Broken plan
status: planning
threat_surface_delta:
  new_ingress: []
  new_persistence: []
---
"""

MISSING_BLOCK_FRONTMATTER = """---
title: No TSD
status: in-progress
---
"""

SUPERSEDED_FRONTMATTER = """---
title: Old protocol
status: superseded
superseded_by: /agent-bridge.md
---
"""

NO_FRONTMATTER = """# Bare markdown

No yaml header at all.
"""


def _make_doc(tmp: Path, name: str, content: str) -> Path:
    p = tmp / name
    p.write_text(content, encoding="utf-8")
    return p


def test_clean_flat_passes(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "2026-01-01-01-clean.md", CLEAN_FRONTMATTER)
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "ok", result.reason


def test_nested_phase_passes(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "2026-01-01-02-phased.md", NESTED_FRONTMATTER)
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "ok", result.reason


def test_missing_key_fails(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "2026-01-01-03-broken.md", MISSING_KEY_FRONTMATTER)
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "fail"
    assert "new_egress" in result.reason


def test_missing_block_fails(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "2026-01-01-04-notsd.md", MISSING_BLOCK_FRONTMATTER)
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "fail"
    assert "threat_surface_delta" in result.reason


def test_superseded_exempt(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "2026-01-01-05-old.md", SUPERSEDED_FRONTMATTER)
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "skip"
    assert "superseded" in result.reason


def test_meta_file_exempt(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "README.md", "# index\n")
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "skip"


def test_template_exempt(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "_template.md", "# tmpl\n")
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "skip"


def test_no_frontmatter_fails_by_default(tmp_path: Path) -> None:
    doc = _make_doc(tmp_path, "2026-01-01-06-bare.md", NO_FRONTMATTER)
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "fail"


def test_grace_allowlist_warns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        lint_planning,
        "GRACE_ALLOWLIST",
        frozenset({"2026-01-01-07-grace.md"}),
    )
    doc = _make_doc(tmp_path, "2026-01-01-07-grace.md", MISSING_BLOCK_FRONTMATTER)
    result = lint_planning.scan(doc, tmp_path)
    assert result.level == "warn"


def test_extract_frontmatter_none_when_missing() -> None:
    assert lint_planning.extract_frontmatter("# no header\n") is None


def test_extract_tsd_block_stops_at_next_top_key() -> None:
    fm = (
        "title: x\n"
        "threat_surface_delta:\n"
        "  new_ingress: []\n"
        "  new_egress: []\n"
        "  new_persistence: []\n"
        "other_field: y\n"
    )
    block = lint_planning.extract_tsd_block(fm)
    assert block is not None
    assert "new_ingress" in block
    assert "other_field" not in block


def test_validate_tsd_reports_all_missing_keys() -> None:
    problems = lint_planning.validate_tsd("  new_ingress: []\n")
    assert any("new_egress" in p for p in problems)
    assert any("new_persistence" in p for p in problems)
