#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPT = Path(__file__).with_name("lint-docs-process.py")
SPEC = importlib.util.spec_from_file_location("lint_docs_process", SCRIPT)
assert SPEC is not None
lint_docs_process = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = lint_docs_process
SPEC.loader.exec_module(lint_docs_process)


class DocsProcessLintTest(unittest.TestCase):
    def test_english_only_prose_fails_and_valid_pair_passes(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "00-core-loop" / "README.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "# 示例 / Example\n\n"
                "This paragraph describes a project rule but has no paired Chinese paragraph.\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_bilingual_file(doc, root)
            self.assertEqual(["DPA-101"], [finding.code for finding in findings])

            doc.write_text(
                "# 示例 / Example\n\n"
                "This paragraph describes a project rule and is paired with Chinese.\n\n"
                "这一段说明项目规则，并且与前一段英文配对。\n",
                encoding="utf-8",
            )
            self.assertEqual([], lint_docs_process.check_bilingual_file(doc, root))

    def test_chinese_only_prose_fails(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "00-core-loop" / "README.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "# 示例 / Example\n\n"
                "这一段只用中文改写项目规则，没有紧邻的英文对照段落，因此应该被双语检查拦住。\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_bilingual_file(doc, root)
            self.assertEqual(["DPA-102"], [finding.code for finding in findings])

    def test_valid_bilingual_doc_allows_tables_and_code(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "00-core-loop" / "README.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "# 当前状态 / Current Status\n\n"
                "This paragraph explains a stable project fact and is paired with Chinese.\n\n"
                "这一段说明稳定的项目事实，并且与前一段英文对照。\n\n"
                "| Item | Meaning |\n"
                "|---|---|\n"
                "| docs | navigation |\n\n"
                "```text\n"
                "English-only code is allowed.\n"
                "```\n",
                encoding="utf-8",
            )

            self.assertEqual([], lint_docs_process.check_bilingual_file(doc, root))

    def test_docs_readme_current_style_expectation(self) -> None:
        doc = lint_docs_process.REPO_ROOT / "docs" / "README.md"
        findings = [
            *lint_docs_process.check_bilingual_file(doc, lint_docs_process.REPO_ROOT),
            *lint_docs_process.check_task_board_leakage(doc, lint_docs_process.REPO_ROOT),
        ]
        self.assertEqual([], [(finding.code, finding.line) for finding in findings])

    def test_blockquote_chinese_pair_counts_as_pair(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "01-llm-integration" / "plan.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "# 计划 / Plan\n\n"
                "This paragraph is paired by the following quoted Chinese translation.\n"
                ">\n"
                "> 这一段中文翻译放在引用块里，仍然算作对照段落。\n",
                encoding="utf-8",
            )

            self.assertEqual([], lint_docs_process.check_bilingual_file(doc, root))

    def test_structure_detects_evidence_and_missing_readme(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            docs = root / "docs"
            (docs / "04-planning" / "evidence").mkdir(parents=True)
            (docs / "15-new-component").mkdir(parents=True)
            (docs / "README.md").write_text("# docs\n", encoding="utf-8")

            findings = lint_docs_process.check_structure(root)
            codes = [finding.code for finding in findings]
            self.assertGreaterEqual(codes.count("DPA-301"), 2)

    def test_explicit_disposable_artifact_fails(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            findings = lint_docs_process.check_generated_artifacts(root, [".logs/run.json"])
            self.assertEqual(["DPA-401"], [finding.code for finding in findings])

    def test_nested_disposable_artifacts_fail_without_docs_false_positive(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            findings = lint_docs_process.check_generated_artifacts(
                root,
                [
                    "packages/agent-core/dist/index.js",
                    "packages/agent-core/target/debug/app",
                    "providers/memory/__pycache__/module.pyc",
                    "coverage/.coverage",
                    "docs/foo/__pycache__/x.pyc",
                    "docs/foo/dist/out.js",
                    "docs/foo/.coverage",
                    "docs/08-observability/coverage-gates.md",
                ],
            )

            self.assertEqual(
                [
                    "coverage/.coverage",
                    "docs/foo/.coverage",
                    "docs/foo/__pycache__/x.pyc",
                    "docs/foo/dist/out.js",
                    "packages/agent-core/dist/index.js",
                    "packages/agent-core/target/debug/app",
                    "providers/memory/__pycache__/module.pyc",
                ],
                [
                    finding.path.relative_to(root).as_posix()
                    for finding in findings
                    if finding.code == "DPA-401"
                ],
            )

    def test_status_content_does_not_trigger_generated_artifact_detection(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            status = root / "docs" / "STATUS.md"
            status.parent.mkdir(parents=True)
            status.write_text(
                "# 状态 / Status\n\n"
                "Coverage gates and .coverage files are discussed as policy examples.\n\n"
                "coverage gate 和 .coverage 文件在这里作为流程示例讨论。\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_generated_artifacts(root, ["docs/STATUS.md"])
            self.assertEqual([], findings)

    def test_evidence_claim_warning_can_be_strict_failure(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "STATUS.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "# 状态 / Status\n\n"
                "The implementation is complete.\n\n"
                "实现已经完成。\n",
                encoding="utf-8",
            )

            with (
                patch.object(lint_docs_process, "check_structure", return_value=[]),
                patch.object(lint_docs_process, "check_generated_artifacts", return_value=[]),
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(0, lint_docs_process.main([str(doc)]))
            with (
                patch.object(lint_docs_process, "check_structure", return_value=[]),
                patch.object(lint_docs_process, "check_generated_artifacts", return_value=[]),
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(1, lint_docs_process.main([str(doc), "--strict-warnings"]))

    def test_evidence_claims_scan_tables_and_lists(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "STATUS.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "# 状态 / Status\n\n"
                "| Unit | Status | Meaning |\n"
                "|---|---|---|\n"
                "| Phase 0 | closed | Baseline shipped. |\n\n"
                "- Iter A completed without an evidence marker.\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_evidence_claims(doc, root)
            self.assertEqual(["DPA-201", "DPA-201"], [finding.code for finding in findings])

            doc.write_text(
                "# 状态 / Status\n\n"
                "| Unit | Status | Evidence |\n"
                "|---|---|---|\n"
                "| Phase 0 | closed | close `297b61a` |\n",
                encoding="utf-8",
            )
            self.assertEqual([], lint_docs_process.check_evidence_claims(doc, root))

    def test_evidence_claims_ignore_inline_code_workflow_states(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "agent-bridge.md"
            doc.write_text(
                "| Step | Output |\n"
                "|---|---|\n"
                "| Review | Linear state `Done` |\n\n"
                "1. Task state is recorded as `done` or `in-progress`.\n",
                encoding="utf-8",
            )

            self.assertEqual([], lint_docs_process.check_evidence_claims(doc, root))

    def test_default_changed_markdown_includes_docs_and_root_readme(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docs").mkdir()
            (root / "docs" / "STATUS.md").write_text("# 状态\n", encoding="utf-8")
            (root / "readme.md").write_text("# Readme\n", encoding="utf-8")
            (root / "quilin.md").write_text("# Guide\n", encoding="utf-8")
            (root / "AGENTS.md").write_text("# Agents\n", encoding="utf-8")
            (root / "CLAUDE.md").write_text("# Claude\n", encoding="utf-8")
            (root / "agent-bridge.md").write_text("# Bridge\n", encoding="utf-8")

            with patch.object(
                lint_docs_process,
                "git_list",
                return_value=[
                    "docs/STATUS.md",
                    "readme.md",
                    "quilin.md",
                    "AGENTS.md",
                    "CLAUDE.md",
                    "agent-bridge.md",
                ],
            ):
                paths = lint_docs_process.changed_markdown_paths(root)

            self.assertEqual(
                [
                    "AGENTS.md",
                    "CLAUDE.md",
                    "agent-bridge.md",
                    "docs/STATUS.md",
                    "quilin.md",
                    "readme.md",
                ],
                [path.relative_to(root).as_posix() for path in paths],
            )

    def test_task_board_detection_ignores_code_fence(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "00-core-loop" / "process.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "```markdown\n"
                "## Sprint Backlog / Sprint Backlog\n"
                "- [ ] Owner: agent; Due: tomorrow; Status: in progress\n"
                "```\n\n"
                "## Sprint Backlog / Sprint Backlog\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_task_board_leakage(doc, root)
            self.assertEqual(["DPA-501"], [finding.code for finding in findings])

    def test_task_board_detection_catches_backlog_and_task_plan_tables(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "00-core-loop" / "process.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "## Backlog / Backlog\n\n"
                "| Task | Owner | Status | Due |\n"
                "|---|---|---|---|\n"
                "| Build gate | Codex | active | tomorrow |\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_task_board_leakage(doc, root)
            self.assertEqual(["DPA-501", "DPA-501"], [finding.code for finding in findings])

    def test_task_board_detection_allows_status_snapshot(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "STATUS.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "## 任务追踪 / Task Tracking\n\n"
                "| Iter | 状态 | 当前含义 |\n"
                "|---|---|---|\n"
                "| Iter E | active | Current-state snapshot only. |\n",
                encoding="utf-8",
            )

            self.assertEqual([], lint_docs_process.check_task_board_leakage(doc, root))

    def test_status_file_rejects_linear_issue_task_table_under_tracking_heading(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "STATUS.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "## 任务追踪 / Task Tracking\n\n"
                "| Linear Issue | Owner | Status | Due |\n"
                "|---|---|---|---|\n"
                "| QUI-69 | Codex | active | 2026-05-02 |\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_task_board_leakage(doc, root)
            self.assertEqual(["DPA-501"], [finding.code for finding in findings])

    def test_status_file_rejects_exact_linear_task_table_header(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "STATUS.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "## 任务追踪 / Task Tracking\n\n"
                "| Linear | Owner | Status | Due |\n"
                "|---|---|---|---|\n"
                "| QUI-69 | Codex | active | 2026-05-02 |\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_task_board_leakage(doc, root)
            self.assertEqual(["DPA-501"], [finding.code for finding in findings])

    def test_task_board_detection_allows_linear_status_snapshot_without_task_columns(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "STATUS.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "## 当前状态 / Current Status\n\n"
                "| Area | Status | Source |\n"
                "|---|---|---|\n"
                "| Docs process | current | Linear is the task source-of-truth. |\n",
                encoding="utf-8",
            )

            self.assertEqual([], lint_docs_process.check_task_board_leakage(doc, root))

    def test_status_file_still_rejects_clear_task_board(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = root / "docs" / "STATUS.md"
            doc.parent.mkdir(parents=True)
            doc.write_text(
                "## Sprint Backlog / Sprint Backlog\n\n"
                "| Task | Owner | Status | Due |\n"
                "|---|---|---|---|\n"
                "| Build gate | Codex | active | tomorrow |\n",
                encoding="utf-8",
            )

            findings = lint_docs_process.check_task_board_leakage(doc, root)
            self.assertEqual(["DPA-501", "DPA-501"], [finding.code for finding in findings])


if __name__ == "__main__":
    unittest.main()
