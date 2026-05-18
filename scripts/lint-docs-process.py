#!/usr/bin/env python3
"""Docs/process lint for Quilin project documentation.

This gate enforces the local, mechanically provable parts of the docs
process: bilingual prose pairing, docs source-of-truth structure,
disposable artifact hygiene, and obvious task-board leakage.

Warnings are intentionally conservative. They surface review signals
without failing CI until the false-positive rate is proven low.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal, Sequence

REPO_ROOT = Path(__file__).resolve().parent.parent

Severity = Literal["error", "warning"]

IGNORE_PREFIXES = (
    "upstreams/",
    "node_modules/",
    ".git/",
    ".logs/",
    ".patches/",
    ".benchmarks/",
    ".code-review-graph/",
    "dist/",
    "target/",
    "__pycache__/",
    "docs/superpowers/",
)

FORBIDDEN_DOCS_DIRS = (
    "adr",
    "architecture",
    "engineering",
    "iterations",
    "planning",
    "research",
    "review",
)

DISPOSABLE_DIR_NAMES = {
    ".logs",
    ".patches",
    ".benchmarks",
    ".code-review-graph",
    "coverage",
    "dist",
    "target",
    "__pycache__",
}

DISPOSABLE_FILE_NAMES = {
    ".coverage",
    "coverage.xml",
}

DISPOSABLE_FILE_SUFFIXES = (
    ".lcov",
)

ROOT_PROJECT_MARKDOWN = {
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "agent-bridge.md",
    "quilin.md",
    "readme.md",
}

NUMBERED_COMPONENT_RE = re.compile(r"^\d{2}-")
CHINESE_RE = re.compile(r"[\u3400-\u9fff]")
LATIN_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9'-]*")
PROOF_RE = re.compile(
    r"("
    r"Evidence:|证据|commit|hash|returned|exit code|退出码|"
    r"\bQUI-\d+\b|\bPR\b|pull request|"
    r"tests? passed|测试通过|lint|check|wc -l|"
    r"https?://|"
    r"\b[0-9a-f]{7,40}\b|"
    r"[A-Za-z0-9_./-]+\.(ts|tsx|js|py|rs|md|json|ya?ml|toml|sh)"
    r")",
    re.IGNORECASE,
)
CLAIM_RE = re.compile(
    r"("
    r"\b(done|complete|completed|closed|landed|passed)\b|"
    r"\bis\s+implemented\b|\bare\s+implemented\b|"
    r"已完成|已经完成|已关闭|已经关闭|已通过|已经通过|验证通过|测试通过|已实现|已经实现|已落地|已经落地"
    r")",
    re.IGNORECASE,
)
FUTURE_OR_NEGATED_RE = re.compile(
    r"("
    r"\b(not|never|future|planned|plan|should|will|must|may|can)\b|"
    r"未|不会|不得|计划|规划|后续|未来|应该|必须|可以|预期|目标"
    r")",
    re.IGNORECASE,
)
GENERATED_DOC_RE = re.compile(r"(generated|auto[-_]?summary|raw[-_]?report)", re.IGNORECASE)
TASK_BOARD_HEADING_RE = re.compile(
    r"\b(?:Sprint Backlog|Task Board|TODO Board|Backlog|Phase Tracking|Task Plan)\b|"
    r"任务看板|待办清单|阶段追踪|任务计划",
    re.IGNORECASE,
)
TASK_BOARD_TABLE_CONTEXT_RE = re.compile(
    r"\b(?:Backlog|Roadmap|Phase Tracking|Task Plan|Sprint|Milestone)\b|"
    r"待办|路线图|阶段追踪|任务计划|里程碑",
    re.IGNORECASE,
)
TASK_BOARD_FIELD_RE = re.compile(
    r"\b(?:Owner|Assignee|Due|ETA|Status|Task|Phase)\b|负责人|执行人|截止|状态|任务|阶段",
    re.IGNORECASE,
)
TASK_BOARD_TABLE_WORK_RE = re.compile(
    r"\b(?:Plane\s+Issue|Issue|Task|Todo|Action\s+Item|Work\s+Item)\b|"
    r"议题|任务|待办|行动项|事项",
    re.IGNORECASE,
)
TASK_BOARD_TABLE_LINEAR_RE = re.compile(r"^Plane$", re.IGNORECASE)
TASK_BOARD_TABLE_OWNER_RE = re.compile(
    r"\b(?:Owner|Assignee|DRI|Responsible)\b|负责人|执行人|责任人",
    re.IGNORECASE,
)
TASK_BOARD_TABLE_STATUS_RE = re.compile(r"\bStatus\b|状态", re.IGNORECASE)
TASK_BOARD_TABLE_SCHEDULE_RE = re.compile(
    r"\b(?:Due|Deadline|ETA|Priority)\b|截止|到期|优先级",
    re.IGNORECASE,
)
TASK_BOARD_ALLOW_RE = re.compile(
    r"("
    r"Plane|documentation map|docs navigation|navigation|entry point|current-state snapshot|"
    r"文档地图|文档导航|入口|当前状态快照|"
    r"不再|不承载|禁止|只保留|source-of-truth|真相源"
    r")",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Finding:
    severity: Severity
    code: str
    path: Path | None
    line: int | None
    message_en: str
    message_zh: str
    fix_en: str
    fix_zh: str


@dataclass(frozen=True)
class MarkdownBlock:
    kind: Literal["heading", "prose"]
    line: int
    text: str


def rel(path: Path | None, root: Path) -> str:
    if path is None:
        return "<repo>"
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def is_ignored(path: Path, root: Path) -> bool:
    path_rel = rel(path, root)
    return any(
        path_rel == prefix.rstrip("/") or path_rel.startswith(prefix)
        for prefix in IGNORE_PREFIXES
    )


def is_project_markdown(path_rel: str) -> bool:
    return path_rel.startswith("docs/") or path_rel in ROOT_PROJECT_MARKDOWN


def changed_markdown_paths(root: Path) -> list[Path]:
    candidates = set(git_list(root, ["diff", "--name-only", "--diff-filter=ACMR", "--", "*.md"]))
    candidates.update(
        git_list(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--", "*.md"])
    )
    paths: list[Path] = []
    for path_rel in candidates:
        path = root / path_rel
        if (
            is_project_markdown(path_rel)
            and path.suffix == ".md"
            and path.exists()
            and not is_ignored(path, root)
        ):
            paths.append(path)
    return sorted(dict.fromkeys(paths), key=lambda p: rel(p, root))


def iter_markdown_paths(root: Path, inputs: Sequence[str], all_markdown: bool) -> list[Path]:
    if inputs:
        paths: list[Path] = []
        for raw in inputs:
            candidate = Path(raw)
            path = candidate if candidate.is_absolute() else root / candidate
            if path.is_dir():
                paths.extend(p for p in path.rglob("*.md") if not is_ignored(p, root))
            elif path.suffix == ".md" and not is_ignored(path, root):
                paths.append(path)
        return sorted(dict.fromkeys(paths), key=lambda p: rel(p, root))

    if not all_markdown:
        return changed_markdown_paths(root)

    docs = root / "docs"
    if not docs.exists():
        return []
    return sorted((p for p in docs.rglob("*.md") if not is_ignored(p, root)), key=lambda p: rel(p, root))


def is_skip_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if stripped.startswith(("|", "<!--", "-->", "<img", "![", "[![")):
        return True
    if stripped in {"---", "***", "___"}:
        return True
    if re.match(r"^[-*+]\s+", stripped):
        return True
    if re.match(r"^\d+\.\s+", stripped):
        return True
    if re.match(r"^\[[^\]]+\]:\s+", stripped):
        return True
    return False


def iter_markdown_blocks(path: Path) -> list[MarkdownBlock]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return []

    blocks: list[MarkdownBlock] = []
    paragraph: list[str] = []
    paragraph_start = 0
    in_fence = False
    in_comment = False

    def flush() -> None:
        nonlocal paragraph, paragraph_start
        if paragraph:
            blocks.append(MarkdownBlock("prose", paragraph_start, " ".join(paragraph)))
            paragraph = []
            paragraph_start = 0

    for line_no, line in enumerate(lines, 1):
        stripped = line.strip()

        if stripped.startswith("```") or stripped.startswith("~~~"):
            flush()
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        if in_comment:
            if "-->" in stripped:
                in_comment = False
            continue
        if stripped.startswith("<!--"):
            flush()
            if "-->" not in stripped:
                in_comment = True
            continue

        if stripped.startswith("#"):
            flush()
            blocks.append(MarkdownBlock("heading", line_no, stripped))
            continue

        if is_skip_line(stripped):
            flush()
            continue

        if stripped.startswith(">"):
            stripped = stripped.lstrip("> ")
            if not stripped:
                flush()
                continue

        if not paragraph:
            paragraph_start = line_no
        paragraph.append(stripped)

    flush()
    return blocks


def language_counts(text: str) -> tuple[int, list[str], int]:
    chinese_chars = len(CHINESE_RE.findall(text))
    words = LATIN_WORD_RE.findall(text)
    letter_count = sum(len(word) for word in words)
    return chinese_chars, words, letter_count


def is_english_like(text: str) -> bool:
    chinese_chars, words, letter_count = language_counts(text)
    return (
        len(words) >= 4
        and letter_count >= 20
        and letter_count >= max(chinese_chars * 2, 20)
    )


def is_chinese_like(text: str) -> bool:
    chinese_chars, words, letter_count = language_counts(text)
    return (
        chinese_chars >= 4
        and chinese_chars >= len(words)
        and chinese_chars * 4 >= max(letter_count, 1)
    )


def is_mixed_language_prose(text: str) -> bool:
    chinese_chars, words, letter_count = language_counts(text)
    return chinese_chars >= 4 and len(words) >= 4 and letter_count >= 20


def strip_inline_code(text: str) -> str:
    return re.sub(r"`[^`]*`", "", text)


def table_cells(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("|"):
        return []
    cells = [cell.strip() for cell in stripped.strip("|").split("|")]
    return [cell for cell in cells if cell]


def is_table_separator(cells: Sequence[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def is_task_management_table_header(line: str) -> bool:
    cells = table_cells(line)
    if is_table_separator(cells):
        return False
    return (
        any(
            TASK_BOARD_TABLE_LINEAR_RE.fullmatch(cell)
            or TASK_BOARD_TABLE_WORK_RE.search(cell)
            for cell in cells
        )
        and any(TASK_BOARD_TABLE_OWNER_RE.search(cell) for cell in cells)
        and any(TASK_BOARD_TABLE_STATUS_RE.search(cell) for cell in cells)
        and any(TASK_BOARD_TABLE_SCHEDULE_RE.search(cell) for cell in cells)
    )


def heading_has_chinese_first_and_english(text: str) -> bool:
    body = text.lstrip("#").strip()
    chinese_match = CHINESE_RE.search(body)
    latin_match = LATIN_WORD_RE.search(body)
    return bool(chinese_match and latin_match and chinese_match.start() < latin_match.start())


def requires_bilingual_pairing(path: Path, root: Path) -> bool:
    return rel(path, root).startswith("docs/")


def check_bilingual_file(path: Path, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    if not requires_bilingual_pairing(path, root):
        return findings

    blocks = iter_markdown_blocks(path)
    for idx, block in enumerate(blocks):
        if block.kind == "heading":
            if heading_has_chinese_first_and_english(block.text):
                continue
            findings.append(
                Finding(
                    severity="error",
                    code="DPA-100",
                    path=path,
                    line=block.line,
                    message_en="Heading is not bilingual with Chinese first and English second.",
                    message_zh="标题没有按中文在前、英文在后的双语格式书写。",
                    fix_en="Rewrite the heading as Chinese first, then English, for example `## 当前状态 / Current Status`.",
                    fix_zh="将标题改为中文在前、英文在后的格式，例如 `## 当前状态 / Current Status`。",
                )
            )
            continue

        if block.kind != "prose" or is_mixed_language_prose(block.text):
            continue

        if is_english_like(block.text):
            next_block = blocks[idx + 1] if idx + 1 < len(blocks) else None
            if next_block and next_block.kind == "prose" and is_chinese_like(next_block.text):
                continue
            findings.append(
                Finding(
                    severity="error",
                    code="DPA-101",
                    path=path,
                    line=block.line,
                    message_en="English prose paragraph is not followed by a Chinese counterpart.",
                    message_zh="英文正文段落后没有紧跟中文对照段落。",
                    fix_en="Add the matching Chinese paragraph immediately after this paragraph, or move non-prose material into a list/table/code block.",
                    fix_zh="在该英文段落后立即补上对应中文段落；如果内容不是正文，请改成列表、表格或代码块。",
                )
            )
            continue

        if is_chinese_like(block.text):
            prev_block = blocks[idx - 1] if idx > 0 else None
            if prev_block and prev_block.kind == "prose" and is_english_like(prev_block.text):
                continue
            findings.append(
                Finding(
                    severity="error",
                    code="DPA-102",
                    path=path,
                    line=block.line,
                    message_en="Chinese prose paragraph is not preceded by its English counterpart.",
                    message_zh="中文正文段落前没有紧邻英文对照段落。",
                    fix_en="Add the matching English paragraph immediately before this paragraph, or move non-prose material into a list/table/code block.",
                    fix_zh="在该中文段落前立即补上对应英文段落；如果内容不是正文，请改成列表、表格或代码块。",
                )
            )
    return findings


def check_evidence_claims(path: Path, root: Path) -> list[Finding]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return []

    findings: list[Finding] = []
    seen_lines: set[int] = set()

    def add_finding(line_no: int) -> None:
        findings.append(
            Finding(
                severity="warning",
                code="DPA-201",
                path=path,
                line=line_no,
                message_en="Progress or completion claim has no nearby proof.",
                message_zh="进度或完成声明附近没有实证依据。",
                fix_en="Add nearby evidence such as a command result, commit hash, test count, Plane ID, pull request link, or exact file path.",
                fix_zh="在附近补充命令结果、提交哈希、测试数量、Plane 编号、PR 链接或具体文件路径等证据。",
            )
        )

    for block in iter_markdown_blocks(path):
        claim_text = strip_inline_code(block.text)
        if block.kind != "prose" or not CLAIM_RE.search(claim_text):
            continue
        if FUTURE_OR_NEGATED_RE.search(claim_text):
            continue
        line_index = max(block.line - 1, 0)
        nearby = "\n".join(lines[line_index : line_index + 4])
        if PROOF_RE.search(nearby):
            continue
        add_finding(block.line)
        seen_lines.add(block.line)

    in_fence = False
    in_comment = False
    for line_no, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if in_comment:
            if "-->" in stripped:
                in_comment = False
            continue
        if stripped.startswith("<!--"):
            if "-->" not in stripped:
                in_comment = True
            continue
        if line_no in seen_lines:
            continue
        if not (stripped.startswith("|") or re.match(r"^[-*+]\s+", stripped) or re.match(r"^\d+\.\s+", stripped)):
            continue
        claim_text = strip_inline_code(stripped)
        if not CLAIM_RE.search(claim_text):
            continue
        if FUTURE_OR_NEGATED_RE.search(claim_text):
            continue
        line_index = max(line_no - 1, 0)
        nearby = "\n".join(lines[line_index : line_index + 4])
        if PROOF_RE.search(nearby):
            continue
        add_finding(line_no)
    return findings


def check_task_board_leakage(path: Path, root: Path) -> list[Finding]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return []

    findings: list[Finding] = []
    path_rel = rel(path, root)
    in_fence = False
    in_comment = False
    task_context_until = 0

    def allowed_task_tracking_context(text: str) -> bool:
        return bool(TASK_BOARD_ALLOW_RE.search(text))

    def add_task_finding(
        line_no: int,
        message_en: str,
        message_zh: str,
        fix_en: str,
        fix_zh: str,
    ) -> None:
        findings.append(
            Finding(
                severity="error",
                code="DPA-501",
                path=path,
                line=line_no,
                message_en=message_en,
                message_zh=message_zh,
                fix_en=fix_en,
                fix_zh=fix_zh,
            )
        )

    for line_no, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if in_comment:
            if "-->" in stripped:
                in_comment = False
            continue
        if stripped.startswith("<!--"):
            if "-->" not in stripped:
                in_comment = True
            continue
        if stripped.startswith("#") and TASK_BOARD_HEADING_RE.search(stripped):
            if allowed_task_tracking_context(stripped):
                continue
            task_context_until = line_no + 8
            add_task_finding(
                line_no,
                "Docs heading looks like an active task board.",
                "docs 标题看起来像活跃任务看板。",
                "Move active work tracking to Plane and keep docs focused on architecture facts, decisions, and verified state.",
                "把活跃任务追踪移到 Plane，docs 只保留架构事实、决策和已验证状态。",
            )
        if stripped.startswith("|") and is_task_management_table_header(stripped):
            add_task_finding(
                line_no,
                "Docs table looks like task management or phase tracking.",
                "docs 表格看起来像任务管理或阶段追踪。",
                "Move backlog, owner, due-date, and phase-tracking tables to Plane; keep docs tables limited to navigation or verified current-state snapshots.",
                "把 backlog、负责人、截止日期和阶段追踪表移到 Plane；docs 表格只保留导航或已验证的当前状态快照。",
            )
            continue
        if stripped.startswith("|") and not allowed_task_tracking_context(stripped):
            field_hits = len(set(TASK_BOARD_FIELD_RE.findall(stripped)))
            has_board_context = (
                line_no <= task_context_until
                or TASK_BOARD_TABLE_CONTEXT_RE.search(stripped) is not None
            )
            if field_hits >= 3 or (has_board_context and field_hits >= 2):
                add_task_finding(
                    line_no,
                    "Docs table looks like task management or phase tracking.",
                    "docs 表格看起来像任务管理或阶段追踪。",
                    "Move backlog, owner, due-date, and phase-tracking tables to Plane; keep docs tables limited to navigation or verified current-state snapshots.",
                    "把 backlog、负责人、截止日期和阶段追踪表移到 Plane；docs 表格只保留导航或已验证的当前状态快照。",
                )
        if re.match(r"^[-*+]\s+\[[ xX]\]\s+", stripped):
            field_hits = len(TASK_BOARD_FIELD_RE.findall(stripped))
            if field_hits >= 2 and not allowed_task_tracking_context(stripped):
                add_task_finding(
                    line_no,
                    "Docs checklist carries task-board fields.",
                    "docs checklist 带有任务看板字段。",
                    "Move owner/status/due-date tracking to Plane; keep only durable architecture or verification notes in docs.",
                    "把负责人、状态和截止日期追踪移到 Plane；docs 只保留长期有效的架构或验证说明。",
                )
    return findings


def check_structure(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    docs = root / "docs"
    if not docs.exists():
        return findings

    for evidence_dir in sorted(p for p in docs.rglob("evidence") if p.is_dir()):
        findings.append(
            Finding(
                severity="error",
                code="DPA-301",
                path=evidence_dir,
                line=None,
                message_en="Resurrected docs evidence directory breaks the source-of-truth boundary.",
                message_zh="docs evidence 目录回归，破坏了事实源边界。",
                fix_en="Move archival evidence to git history or summarize durable facts in the relevant component README.",
                fix_zh="把档案证据交给 git history 追溯，或把长期有效结论摘要写入对应组件 README。",
            )
        )

    for dirname in FORBIDDEN_DOCS_DIRS:
        stale_dir = docs / dirname
        if stale_dir.exists():
            findings.append(
                Finding(
                    severity="error",
                    code="DPA-301",
                    path=stale_dir,
                    line=None,
                    message_en="Old top-level docs directory has returned.",
                    message_zh="旧的 docs 顶层目录重新出现。",
                    fix_en="Keep tasks/history in Plane or git history; keep current facts in docs/STATUS.md and component README files.",
                    fix_zh="任务和历史材料放到 Plane 或 git history；当前事实放在 docs/STATUS.md 与组件 README。",
                )
            )

    component_dirs = sorted(
        p for p in docs.iterdir() if p.is_dir() and NUMBERED_COMPONENT_RE.match(p.name)
    )
    for component_dir in component_dirs:
        readme = component_dir / "README.md"
        if not readme.exists():
            findings.append(
                Finding(
                    severity="error",
                    code="DPA-301",
                    path=component_dir,
                    line=None,
                    message_en="Numbered component docs directory has no README.md.",
                    message_zh="编号组件文档目录缺少 README.md。",
                    fix_en="Add a component README.md or remove the stale component directory.",
                    fix_zh="补充组件 README.md，或删除这个过期组件目录。",
                )
            )

    docs_readme = docs / "README.md"
    if docs_readme.exists():
        nav = docs_readme.read_text(encoding="utf-8", errors="ignore")
        for component_dir in component_dirs:
            if component_dir.name not in nav:
                findings.append(
                    Finding(
                        severity="error",
                        code="DPA-301",
                        path=docs_readme,
                        line=None,
                        message_en=f"Docs navigation is missing component directory {component_dir.name}.",
                        message_zh=f"docs 导航缺少组件目录 {component_dir.name}。",
                        fix_en="Add the component to docs/README.md navigation or remove the stale directory.",
                        fix_zh="把该组件加入 docs/README.md 导航，或删除过期目录。",
                    )
                )
    else:
        findings.append(
            Finding(
                severity="error",
                code="DPA-301",
                path=docs,
                line=None,
                message_en="docs/README.md is missing.",
                message_zh="缺少 docs/README.md。",
                fix_en="Restore docs/README.md as the docs navigation and write-policy entry point.",
                fix_zh="恢复 docs/README.md 作为 docs 导航与写入规则入口。",
            )
        )

    return findings


def is_disposable_path(path_rel: str) -> bool:
    parts = [part for part in path_rel.split("/") if part]
    if not parts:
        return False
    if any(part in DISPOSABLE_DIR_NAMES for part in parts[:-1]):
        return True
    filename = parts[-1]
    if filename in DISPOSABLE_DIR_NAMES or filename in DISPOSABLE_FILE_NAMES:
        return True
    return any(filename.endswith(suffix) for suffix in DISPOSABLE_FILE_SUFFIXES)


def git_list(root: Path, args: Sequence[str]) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "-c", "core.quotePath=false", *args],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except FileNotFoundError:
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def check_generated_artifacts(root: Path, inputs: Sequence[str]) -> list[Finding]:
    findings: list[Finding] = []
    candidates = set(git_list(root, ["ls-files"]))
    candidates.update(git_list(root, ["diff", "--name-only", "--diff-filter=ACMR"]))
    candidates.update(git_list(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]))

    for raw in inputs:
        candidate = Path(raw)
        path = candidate if candidate.is_absolute() else root / candidate
        try:
            candidates.add(path.relative_to(root).as_posix())
        except ValueError:
            continue

    for path_rel in sorted(candidates):
        if is_disposable_path(path_rel):
            findings.append(
                Finding(
                    severity="error",
                    code="DPA-401",
                    path=root / path_rel,
                    line=None,
                    message_en="Disposable generated artifact is tracked, staged, modified, or explicitly linted.",
                    message_zh="可丢弃生成物被跟踪、暂存、修改，或被显式纳入检查。",
                    fix_en="Remove it from source control, keep it ignored, or promote it into reviewed bilingual docs with source-command evidence.",
                    fix_zh="从源码控制中移除并保持忽略；若要提升为文档，需改写为中英双语并附来源命令证据。",
                )
            )

    docs = root / "docs"
    if docs.exists():
        for doc in sorted(docs.rglob("*.md")):
            if is_ignored(doc, root) or not GENERATED_DOC_RE.search(doc.name):
                continue
            text = doc.read_text(encoding="utf-8", errors="ignore")
            if PROOF_RE.search(text) and re.search(r"review|Reviewed|人工|审查|复核", text):
                continue
            findings.append(
                Finding(
                    severity="warning",
                    code="DPA-401",
                    path=doc,
                    line=None,
                    message_en="Generated-looking docs file lacks clear promotion evidence.",
                    message_zh="看似生成的 docs 文件缺少明确的提升证据。",
                    fix_en="Add source command and review evidence, or rename/rewrite the file as normal bilingual project documentation.",
                    fix_zh="补充来源命令和 review 证据，或将文件重命名/改写为普通中英双语项目文档。",
                )
            )

    return findings


def collect_findings(root: Path, inputs: Sequence[str], all_markdown: bool) -> list[Finding]:
    markdown_paths = iter_markdown_paths(root, inputs, all_markdown)
    findings: list[Finding] = []
    findings.extend(check_structure(root))
    findings.extend(check_generated_artifacts(root, inputs))
    for path in markdown_paths:
        findings.extend(check_bilingual_file(path, root))
        findings.extend(check_evidence_claims(path, root))
        findings.extend(check_task_board_leakage(path, root))
    return findings


def print_finding(finding: Finding, root: Path) -> None:
    location = rel(finding.path, root)
    if finding.line is not None:
        location = f"{location}:{finding.line}"
    severity = finding.severity.upper()
    print(f"{location} [{severity} {finding.code}] {finding.message_en}")
    print(f"    中文：{finding.message_zh}")
    print(f"    Fix: {finding.fix_en}")
    print(f"    修复：{finding.fix_zh}")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lint Quilin docs/process rules.")
    parser.add_argument(
        "paths",
        nargs="*",
        help="Optional files or directories to lint. Defaults to changed docs Markdown plus structural checks.",
    )
    parser.add_argument(
        "--all-markdown",
        action="store_true",
        help="Run Markdown-content checks against every docs/**/*.md file, including legacy docs.",
    )
    parser.add_argument(
        "--strict-warnings",
        action="store_true",
        help="Treat warning-level process signals as CI failures.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    findings = collect_findings(REPO_ROOT, args.paths, args.all_markdown)

    for finding in findings:
        print_finding(finding, REPO_ROOT)

    errors = sum(1 for finding in findings if finding.severity == "error")
    warnings = sum(1 for finding in findings if finding.severity == "warning")
    if errors or (args.strict_warnings and warnings):
        print(f"\ndocs-process lint: {errors} error(s), {warnings} warning(s)")
        return 1
    if warnings:
        print(f"\ndocs-process lint: clean with {warnings} warning(s)")
        return 0
    print("docs-process lint: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
