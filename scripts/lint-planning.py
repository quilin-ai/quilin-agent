#!/usr/bin/env python3
"""Planning doc lint — enforce `threat_surface_delta` frontmatter discipline
for `docs/planning/*.md` (SD-08, round-3 review).

Each per-feature planning doc must declare what **new attack surface** the
phase introduces. The frontmatter schema lives in
`docs/planning/_template.md`:

    threat_surface_delta:
      new_ingress: []       # new external input sources
      new_egress: []        # new outbound sinks
      new_persistence: []   # new on-disk / db state

Empty lists explicitly declare "this phase adds none". A missing field is
treated as unaudited and fails the lint.

Nested-per-phase shape is also accepted (see `2026-04-21-01-skills-b3b-…`):

    threat_surface_delta:
      phase_0:
        new_ingress: [...]
        new_egress: []
        new_persistence: []

As long as the three keys each appear at least once inside the block, the
doc passes. This is a coarse check; full semantic validation is intentionally
deferred to human review.

Exemptions
----------
- `README.md` / `_template.md` / `00-implementation-plan.md` — meta/index/
  template docs, not per-feature plans.
- Any doc with `status: superseded` — historical snapshot, frozen.
- `GRACE_ALLOWLIST` — active docs pre-dating the contract, emit WARN but
  do not fail. Backfill and remove from the set; do not extend it.

Exit codes
----------
  0  all docs pass (warnings allowed)
  1  one or more docs failed validation
  2  usage / environment error
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PLANNING_DIR = REPO_ROOT / "docs" / "planning"

EXEMPT_FILES = frozenset(
    {
        "README.md",
        "_template.md",
        "00-implementation-plan.md",
    }
)

# Active planning docs that pre-date the threat_surface_delta contract.
# These emit WARN instead of FAIL so the lint can land without a blocking
# backfill. Each entry should be removed as the doc is audited. Do NOT add
# new entries here — new docs must comply from day one.
GRACE_ALLOWLIST = frozenset(
    {
        "2026-04-21-02-reasoning-lifecycle.md",
        "2026-04-21-03-handoff.md",
        "2026-04-21-04-pre-phase-3-checklist.md",
    }
)

REQUIRED_KEYS: tuple[str, ...] = ("new_ingress", "new_egress", "new_persistence")


@dataclass(frozen=True)
class ScanResult:
    rel_path: str
    level: str  # "ok" | "warn" | "fail" | "skip"
    reason: str


def extract_frontmatter(text: str) -> str | None:
    """Return frontmatter body between leading `---` delimiters, or None."""
    if not text.startswith("---"):
        return None
    # Accept CRLF or LF after opening delimiter.
    nl = text.find("\n")
    if nl == -1:
        return None
    end = text.find("\n---", nl)
    if end == -1:
        return None
    return text[nl + 1 : end]


def has_status_superseded(frontmatter: str) -> bool:
    return (
        re.search(r"^status:\s*superseded\b", frontmatter, re.MULTILINE) is not None
    )


def extract_tsd_block(frontmatter: str) -> str | None:
    """Return the `threat_surface_delta:` block contents (indented lines).

    Stops at the next top-level key (column 0, non-comment) or end of
    frontmatter. Returns None if the key is absent.
    """
    lines = frontmatter.splitlines()
    start: int | None = None
    for i, line in enumerate(lines):
        if re.match(r"^threat_surface_delta\s*:", line):
            start = i
            break
    if start is None:
        return None
    body: list[str] = []
    for line in lines[start + 1 :]:
        if not line:
            body.append(line)
            continue
        if line.startswith("#"):
            continue
        if not line[0].isspace():
            break
        body.append(line)
    return "\n".join(body)


def validate_tsd(block: str) -> list[str]:
    """Return list of problems. Empty list = valid."""
    problems: list[str] = []
    for key in REQUIRED_KEYS:
        if not re.search(rf"^\s+{re.escape(key)}\s*:", block, re.MULTILINE):
            problems.append(f"missing key `{key}`")
    return problems


def scan(path: Path, root: Path | None = None) -> ScanResult:
    rel_name = path.name
    root = root if root is not None else REPO_ROOT
    try:
        full_rel = path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        full_rel = rel_name

    if rel_name in EXEMPT_FILES:
        return ScanResult(full_rel, "skip", "exempt (meta/index/template)")

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ScanResult(full_rel, "fail", "non-UTF-8 file")

    frontmatter = extract_frontmatter(text)
    if frontmatter is None:
        if rel_name in GRACE_ALLOWLIST:
            return ScanResult(full_rel, "warn", "grace: missing frontmatter")
        return ScanResult(
            full_rel,
            "fail",
            "missing frontmatter — add `---` block with threat_surface_delta",
        )

    if has_status_superseded(frontmatter):
        return ScanResult(full_rel, "skip", "exempt (status: superseded)")

    tsd = extract_tsd_block(frontmatter)
    if tsd is None:
        if rel_name in GRACE_ALLOWLIST:
            return ScanResult(full_rel, "warn", "grace: missing threat_surface_delta")
        return ScanResult(
            full_rel, "fail", "frontmatter missing `threat_surface_delta` block"
        )

    problems = validate_tsd(tsd)
    if problems:
        reason = "; ".join(problems)
        if rel_name in GRACE_ALLOWLIST:
            return ScanResult(full_rel, "warn", f"grace: {reason}")
        return ScanResult(full_rel, "fail", reason)

    return ScanResult(full_rel, "ok", "")


def main() -> int:
    if not PLANNING_DIR.is_dir():
        print(f"ERROR: planning dir not found at {PLANNING_DIR}", file=sys.stderr)
        return 2

    results = [scan(p) for p in sorted(PLANNING_DIR.glob("*.md"))]

    fails = [r for r in results if r.level == "fail"]
    warns = [r for r in results if r.level == "warn"]
    skips = [r for r in results if r.level == "skip"]
    oks = [r for r in results if r.level == "ok"]

    for r in fails:
        print(f"FAIL {r.rel_path} — {r.reason}")
    for r in warns:
        print(f"WARN {r.rel_path} — {r.reason}")
    for r in skips:
        print(f"SKIP {r.rel_path} — {r.reason}")

    print(
        f"\nplanning lint: {len(oks)} ok, {len(warns)} warn, "
        f"{len(skips)} skip, {len(fails)} fail "
        f"({len(results)} total)"
    )

    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
