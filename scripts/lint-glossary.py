#!/usr/bin/env python3
"""Glossary lint — enforces the key terminology drifts called out in
`docs/00-core-loop/glossary.md` (D-10 / R-08, 2026-04-17 ultra-review).

The lint is intentionally **narrow**: it checks only the specific drift
items escalated by Coherence reviewers (C-01..C-14), not every term in
the glossary. Broad vocabulary policing would produce false positives
in quoted text, code identifiers, and upstream excerpts.

Checks:
  G-01  quilin-mem tier vocabulary must be lowercase in prose (C-10)
  G-02  Skill load tool is `skill_view`, never `skill_load` (C-02)
  G-03  Project name: `Quilin` / `Quilin Agent`, not `Qilin Agent` (C-04)
  G-04  Auto-fusion narrative removed: `自动缝合` in prose (D-03)
  G-05  Public Memory OS name: `quilin-mem`; legacy names fail on user-visible surfaces

Markdown code blocks (```...```), inline code (`...`), URLs, paths containing
`upstreams/`, and historical review docs are excluded. The scanner covers
Markdown docs plus user-visible HTML/SVG site and architecture surfaces.

Exit 0 when clean, exit 1 when violations found.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
GLOSSARY = REPO_ROOT / "docs" / "00-core-loop" / "glossary.md"

IGNORE_PREFIXES = (
    "upstreams/",
    "node_modules/",
    ".git/",
    "dist/",
    "target/",
    "__pycache__/",
    # Glossary & lint script — self-references allowed
    "docs/00-core-loop/glossary.md",
    "scripts/lint-glossary.py",
    # Superpowers are upstream-style skills content
    "docs/superpowers/",
)

USER_VISIBLE_ROOT_DOCS = {
    "readme.md",
    "quilin.md",
    "AGENTS.md",
    "CLAUDE.md",
}

USER_VISIBLE_PREFIXES = (
    "briefs/",
    "docs/",
    "site/",
)


@dataclass(frozen=True)
class Check:
    code: str
    # Regex must match a single line, anchored as needed.
    pattern: re.Pattern[str]
    reason: str
    # If line matches any of these, the violation is suppressed.
    # Use for historical / retrospective mentions that cite the banned term
    # as an example of what to avoid.
    exempt_line_patterns: tuple[re.Pattern[str], ...] = ()


# Markers that indicate a line is retrospectively citing a banned term
# (explaining why it was removed). G-04 is the main consumer; G-03 and
# G-05 can share the same heuristic.
HISTORICAL_MARKERS = re.compile(
    r"(已废弃|已收回|已在.*?收回|已在.*?后收回|删除[\"“].*?[\"”]|非自动|否决|早期(宣传|版本)|D-03|ultra-review|retrospective)"
)


CHECKS: tuple[Check, ...] = (
    Check(
        code="G-01",
        # quilin-mem tier vocabulary: reject old SHORT/MID/LONG/ULTRA tiers near the public name.
        pattern=re.compile(r"quilin-mem[^\n]{0,80}?\b(SHORT|MID|LONG|ULTRA)\b"),
        reason="quilin-mem tier 必须用 working/episodic/semantic/skill — glossary §一 C-10",
    ),
    Check(
        code="G-01b",
        # Chain form e.g. "SHORT/MID/LONG/ULTRA" or "SHORT → MID → LONG"
        pattern=re.compile(
            r"\b(SHORT|MID|LONG|ULTRA)\s*[→/]\s*(SHORT|MID|LONG|ULTRA)\b"
        ),
        reason="quilin-mem tier 链式写法必须用 working/episodic/semantic/skill — glossary §一 C-10",
    ),
    Check(
        code="G-02",
        pattern=re.compile(r"\bskill_load\b"),
        reason="Skill 按需加载工具是 `skill_view`，不是 `skill_load` — glossary §一 C-02",
    ),
    Check(
        code="G-03",
        # Disallow Qilin Agent / Qilin CLI in prose; "Qilin" alone as etymology is fine
        pattern=re.compile(r"\bQilin\s+(Agent|CLI|agent)\b"),
        reason="项目名用 `Quilin`，不是 `Qilin` — glossary §一",
    ),
    Check(
        code="G-04",
        pattern=re.compile(r"自动缝合"),
        reason="`自动缝合` 已废弃，改 `Fusion PR` / `人审融合 PR` — D-03",
        exempt_line_patterns=(HISTORICAL_MARKERS,),
    ),
    Check(
        code="G-05",
        # Public prose must use quilin-mem; runtime identifiers remain a later QUI-88 phase.
        pattern=re.compile(
            r"\b(?:quilin-mem|quilin_mem)\b"  # memory OS: correct forms only,
            re.IGNORECASE,
        ),
        reason="memory OS naming: use `quilin-mem` (prose) or `quilin_mem` (code) — glossary §一",
    ),
)

LEGACY_MEMORY_CHECK = next(check for check in CHECKS if check.code == "G-05")

# Patterns for masking out code blocks, inline code, URLs, and link targets.
CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+")
# Markdown link target: `[text](target)` — mask target only
LINK_TARGET_RE = re.compile(r"\]\(([^)]+)\)")
# File paths with slashes or dots that look like identifiers
PATH_RE = re.compile(
    r"[A-Za-z0-9_./-]+\.(ts|js|py|rs|md|json|yaml|yml|toml|sh|html|svg)"
)
DIRECTORY_PATH_RE = re.compile(
    r"(?<!\w)(?:\.{0,2}/)?(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]*/?"
)
ENV_IDENTIFIER_RE = re.compile(
    r"\b[A-Z0-9_]*(?:QUILIN_MEM|QUILIN_MEMORY)[A-Z0-9_]*\b"
)
PYTHON_IMPORT_RE = re.compile(
    r"\b(?:from\s+quilin_mem(?:\.[A-Za-z_]\w*)*\s+import|import\s+quilin_mem(?:\.[A-Za-z_]\w*)*)\b"
)
PYTHON_MODULE_CMD_RE = re.compile(r"\bpython(?:3)?\s+-m\s+quilin_mem\b")
PACKAGE_IDENTIFIER_RE = re.compile(
    r"\b(?:[a-z0-9]+[-_])+(?:quilin-mem|quilin_mem)\b"
    r"|\b(?:quilin-mem|quilin_mem)(?:[-_][a-z0-9]+)+\b",
    re.IGNORECASE,
)


def blank_match(match: re.Match[str]) -> str:
    span = match.group(0)
    return "".join("\n" if ch == "\n" else " " for ch in span)


def mask_non_prose(text: str) -> str:
    """Replace code/URL/path spans with whitespace of equal length so line
    numbers stay aligned but their content won't trigger matches. Newlines
    inside multi-line fences are preserved so line numbering is accurate."""

    for regex in (CODE_FENCE_RE, INLINE_CODE_RE, URL_RE, LINK_TARGET_RE, PATH_RE):
        text = regex.sub(blank_match, text)
    return text


def mask_legacy_memory_implementation_spans(text: str) -> str:
    """Mask compatibility identifiers while keeping rendered Markdown text visible.

    G-05 intentionally scans code fences and inline code because prompts,
    diagrams, tables, and command examples are visible after Markdown render.
    These masks keep runtime compatibility names from becoming false positives.
    """

    for regex in (
        URL_RE,
        LINK_TARGET_RE,
        PATH_RE,
        DIRECTORY_PATH_RE,
        ENV_IDENTIFIER_RE,
        PYTHON_IMPORT_RE,
        PYTHON_MODULE_CMD_RE,
        PACKAGE_IDENTIFIER_RE,
    ):
        text = regex.sub(blank_match, text)
    return text


def iter_lint_files(root: Path) -> Iterable[Path]:
    for p in root.rglob("*"):
        if p.suffix not in {".md", ".html", ".svg"}:
            continue
        rel = p.relative_to(root).as_posix()
        if any(rel.startswith(prefix) for prefix in IGNORE_PREFIXES):
            continue
        yield p


def is_user_visible_surface(path: Path) -> bool:
    rel = path.relative_to(REPO_ROOT).as_posix()
    return rel in USER_VISIBLE_ROOT_DOCS or any(
        rel.startswith(prefix) for prefix in USER_VISIBLE_PREFIXES
    )


def format_snippet(line: str, check: Check) -> str:
    text = line.strip()
    if check.code == "G-05":
        text = check.pattern.sub("[legacy memory OS term]", text)
    return text[:80] + ("…" if len(text) > 80 else "")


def scan(path: Path) -> list[tuple[int, str, str, str]]:
    """Returns (line_no, code, matched_text, reason)."""
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []
    masked = mask_non_prose(raw)
    masked_lines = masked.splitlines()
    raw_lines = raw.splitlines()
    violations: list[tuple[int, str, str, str]] = []
    for check in CHECKS:
        if check.code == "G-05":
            continue
        for i, mline in enumerate(masked_lines, 1):
            if not check.pattern.search(mline):
                continue
            orig_line = raw_lines[i - 1]
            if any(p.search(orig_line) for p in check.exempt_line_patterns):
                continue
            snippet = format_snippet(orig_line, check)
            violations.append((i, check.code, snippet, check.reason))
    if is_user_visible_surface(path):
        visible_text = mask_legacy_memory_implementation_spans(raw)
        for i, mline in enumerate(visible_text.splitlines(), 1):
            if not LEGACY_MEMORY_CHECK.pattern.search(mline):
                continue
            orig_line = raw_lines[i - 1]
            if any(
                p.search(orig_line)
                for p in LEGACY_MEMORY_CHECK.exempt_line_patterns
            ):
                continue
            snippet = format_snippet(orig_line, LEGACY_MEMORY_CHECK)
            violations.append(
                (
                    i,
                    LEGACY_MEMORY_CHECK.code,
                    snippet,
                    LEGACY_MEMORY_CHECK.reason,
                )
            )
    return violations


def main() -> int:
    if not GLOSSARY.exists():
        print(f"ERROR: glossary not found at {GLOSSARY}", file=sys.stderr)
        return 2

    total = 0
    for scanned_file in sorted(iter_lint_files(REPO_ROOT)):
        violations = scan(scanned_file)
        if not violations:
            continue
        rel = scanned_file.relative_to(REPO_ROOT).as_posix()
        for line_no, code, snippet, reason in violations:
            print(f"{rel}:{line_no} [{code}] {snippet}\n    → {reason}")
            total += 1

    if total:
        print(
            f"\n{total} glossary violation(s) — see docs/00-core-loop/glossary.md"
        )
        return 1

    print("glossary lint: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
