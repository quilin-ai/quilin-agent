"""Unit tests for QUI-198 SKILL.md disk-write path.

Covers ``SkillProposerWriter.write_candidate_to_disk`` + the
``SkillCandidateProposerJob`` daemon wiring. The propose-only path is already
exercised by ``test_skill_proposer.py``; here we focus on the gap that the
audit flagged: actually persisting SKILL.md to ``~/.quilin/skills/``.

测试目标(对应 docs/03-memory/memory-completeness-audit.md P1 gap):
SkillProposer 生成候选之后,真把 SKILL.md 写入 ``~/.quilin/skills/``,且写入
必须经过 WriteAuthority gate(origin="proposal" / tool="skill_create" 触发
CRITICAL 审批)。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path

import pytest

from quilin_mem.daemon import BudgetLease, JobContext
from quilin_mem.daemon_main import SkillCandidateProposerJob
from quilin_mem.skill_proposer import (
    SkillCandidateWriteResult,
    SkillProposal,
    SkillProposer,
    SkillProposerWriter,
    SkillProposerWriterConfig,
)
from quilin_mem.trajectory_compressor import ActionStep, TrajectoryCase

NOW = datetime(2026, 5, 21, 10, 30, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _proposal(name: str = "run-tests-then-commit") -> SkillProposal:
    return SkillProposal(
        name=name,
        when_to_use="Run pytest then commit",
        prerequisites=("Repo has pytest configured",),
        verification_steps=("pytest -q", "git commit -m green"),
        expected_evidence=("好",),
        failure_cases=("不对",),
        source_case_ids=("c1", "c2", "c3"),
        confidence=0.83,
    )


def _case(
    case_id: str,
    intent: str,
    actions: Sequence[str],
    *,
    success: tuple[str, ...] = ("好",),
    confidence: float = 0.75,
) -> TrajectoryCase:
    return TrajectoryCase(
        id=case_id,
        user_id="user-1",
        session_id=f"sess-{case_id}",
        intent=intent,
        action_sequence=tuple(
            ActionStep(order=idx, description=desc) for idx, desc in enumerate(actions)
        ),
        success_signals=success,
        failure_signals=(),
        occurred_at=NOW,
        confidence=confidence,
    )


def _ctx(job_id: str) -> JobContext:
    return JobContext(
        job_id=job_id,
        run_id=f"{job_id}-run",
        started_at=NOW,
        token_budget=100_000,
        cost_budget=1.0,
        token_lease=BudgetLease(kind="token", granted=100_000),
        cost_lease=BudgetLease(kind="cost", granted=1.0),
        heartbeat=lambda _at=None: None,
    )


class _AllowGate:
    def __init__(self) -> None:
        self.calls: list[Mapping[str, object]] = []

    def authorize(self, request: Mapping[str, object]) -> dict[str, object]:
        self.calls.append(request)
        return {"allowed": True}


class _DenyGate:
    def __init__(self) -> None:
        self.calls: list[Mapping[str, object]] = []

    def authorize(self, request: Mapping[str, object]) -> dict[str, object]:
        self.calls.append(request)
        return {"allowed": False}


class _AsyncAllowGate:
    def __init__(self) -> None:
        self.calls: list[Mapping[str, object]] = []

    async def authorize(self, request: Mapping[str, object]) -> dict[str, object]:
        self.calls.append(request)
        return {"decision": "approved"}


# ---------------------------------------------------------------------------
# Direct writer behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_writer_persists_skill_md_under_real_mode(tmp_path: Path) -> None:
    """A real(``dry_run=False``)write should produce a SKILL.md file with
    legal frontmatter and 644 mode, gated by WriteAuthority.

    真写盘路径:产出 SKILL.md 文件,frontmatter 合法,权限 644,且必须先过 gate。
    """

    writer = SkillProposerWriter(SkillProposerWriterConfig(skills_dir=tmp_path))
    gate = _AllowGate()
    proposal = _proposal()

    result = await writer.write_candidate_to_disk(
        proposal,
        write_authority=gate,
        dry_run=False,
    )

    assert isinstance(result, SkillCandidateWriteResult)
    assert result.reason == "written"
    assert result.dry_run is False
    assert result.path is not None
    assert result.path.exists()
    assert result.bytes_written > 0
    assert result.written_at is not None

    content = result.path.read_text(encoding="utf-8")
    # Frontmatter sanity — name + description quoted, requires_write_authority pinned true.
    assert content.startswith("---\n")
    assert 'name: "run-tests-then-commit"' in content
    assert 'description: "Run pytest then commit"' in content
    assert "requires_write_authority: true" in content
    assert "## When to use / 使用时机" in content
    assert "## Source cases / 出处案例" in content

    # Gate received a CRITICAL request shape.
    assert len(gate.calls) == 1
    request = gate.calls[0]
    assert request["tool"] == "skill_create"
    assert request["origin"] == "proposal"
    assert request["riskLevel"] == "critical"
    metadata = request["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["skill_name"] == "run-tests-then-commit"
    assert metadata["dry_run"] is False
    assert metadata["destination"].endswith("run-tests-then-commit.md")

    # File mode should be 0o644(low 9 bits — strip out type bits).
    mode = result.path.stat().st_mode & 0o777
    assert mode == 0o644


@pytest.mark.asyncio
async def test_writer_dry_run_skips_disk_but_still_authorises(tmp_path: Path) -> None:
    """``dry_run=True`` must still call WriteAuthority(so the gate observes
    every candidate)but must not touch disk.

    dry_run 必须仍调 gate(让 gate 看到每个候选),但不写盘 — 保证 daemon 默认
    安全且 audit log 完整。
    """

    writer = SkillProposerWriter(SkillProposerWriterConfig(skills_dir=tmp_path))
    gate = _AllowGate()
    proposal = _proposal()

    result = await writer.write_candidate_to_disk(
        proposal,
        write_authority=gate,
        dry_run=True,
    )

    assert result.reason == "dry_run"
    assert result.dry_run is True
    assert result.path is None
    assert result.bytes_written == 0
    assert list(tmp_path.iterdir()) == []
    assert len(gate.calls) == 1
    assert gate.calls[0]["metadata"]["dry_run"] is True  # type: ignore[index]


@pytest.mark.asyncio
async def test_writer_denied_decision_blocks_disk_write(tmp_path: Path) -> None:
    """If the gate denies, the writer returns ``reason="denied"`` and never
    creates the SKILL.md file.

    Gate 拒绝时不写盘,返回 denied,目录保持空。
    """

    writer = SkillProposerWriter(SkillProposerWriterConfig(skills_dir=tmp_path))
    gate = _DenyGate()
    proposal = _proposal()

    result = await writer.write_candidate_to_disk(
        proposal,
        write_authority=gate,
        dry_run=False,
    )

    assert result.reason == "denied"
    assert result.path is None
    assert result.bytes_written == 0
    assert list(tmp_path.iterdir()) == []
    assert len(gate.calls) == 1


@pytest.mark.asyncio
async def test_writer_accepts_async_write_authority(tmp_path: Path) -> None:
    """Async gates(coroutine ``authorize``)work transparently — mirrors the
    Reflector/Promotion gate pattern.

    异步 gate 应当被 await,与 Reflector / Promotion 模式一致。
    """

    writer = SkillProposerWriter(SkillProposerWriterConfig(skills_dir=tmp_path))
    gate = _AsyncAllowGate()
    proposal = _proposal()

    result = await writer.write_candidate_to_disk(
        proposal,
        write_authority=gate,
        dry_run=False,
    )

    assert result.reason == "written"
    assert result.path is not None and result.path.exists()
    assert len(gate.calls) == 1


@pytest.mark.asyncio
async def test_writer_does_not_overwrite_existing_candidate(tmp_path: Path) -> None:
    """Two write calls with the same skill name must land on distinct files
    (``foo.md`` then ``foo-2.md``) — never silently clobber.

    同名候选连写两次:第二次落 ``-2`` 后缀,确保 cross-session 写多个 candidate
    不互覆盖。
    """

    writer = SkillProposerWriter(SkillProposerWriterConfig(skills_dir=tmp_path))
    gate = _AllowGate()
    proposal = _proposal()

    first = await writer.write_candidate_to_disk(
        proposal, write_authority=gate, dry_run=False
    )
    second = await writer.write_candidate_to_disk(
        proposal, write_authority=gate, dry_run=False
    )

    assert first.path is not None and first.path.name == "run-tests-then-commit.md"
    assert second.path is not None and second.path.name == "run-tests-then-commit-2.md"
    assert first.path != second.path
    assert first.path.exists() and second.path.exists()


@pytest.mark.asyncio
async def test_writer_default_skills_dir_env_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``QUILIN_SKILLS_DIR`` should redirect the default location, so test /
    container deployments can avoid touching ``~/.quilin``.

    通过 ``QUILIN_SKILLS_DIR`` 环境变量覆盖默认目录,确保不会污染 ``~/.quilin``。
    """

    monkeypatch.setenv("QUILIN_SKILLS_DIR", str(tmp_path))
    writer = SkillProposerWriter()  # no explicit config → reads env at default time
    gate = _AllowGate()

    result = await writer.write_candidate_to_disk(
        _proposal("envvar-skill"),
        write_authority=gate,
        dry_run=False,
    )

    assert result.path is not None
    assert result.path.parent == tmp_path
    assert result.path.name == "envvar-skill.md"


@pytest.mark.asyncio
async def test_writer_does_not_leak_tmp_file_on_success(tmp_path: Path) -> None:
    """After a successful write the only artefact in the skills dir is the
    final SKILL.md — no leftover ``.tmp.<pid>`` files.

    成功写完不留 tmp 文件 — 原子 rename 应当移走临时文件。
    """

    writer = SkillProposerWriter(SkillProposerWriterConfig(skills_dir=tmp_path))
    gate = _AllowGate()

    await writer.write_candidate_to_disk(_proposal(), write_authority=gate, dry_run=False)

    entries = sorted(p.name for p in tmp_path.iterdir())
    assert entries == ["run-tests-then-commit.md"]


# ---------------------------------------------------------------------------
# Daemon job wiring
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_daemon_job_no_cases_path_logs_and_skips(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Default daemon path with no case provider → reports ``cases_seen=0``
    and does not touch disk(no fake propose).

    默认 daemon 路径无 case provider → 报告 0 cases 不写盘,避免伪造数据。
    """

    monkeypatch.setenv("QUILIN_SKILLS_DIR", str(tmp_path))
    job = SkillCandidateProposerJob()

    result = await job.run(_ctx(job.id))

    assert result.status == "succeeded"
    assert result.data["cases_seen"] == 0
    assert result.data["proposals"] == 0
    assert result.data["written"] == 0
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_daemon_job_real_write_path_with_injected_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When a case provider yields 3 similar cases and dry_run=False + allow
    gate, the daemon job should persist exactly one SKILL.md(deduped cluster).

    真写路径:3 个相似 case → 聚合 1 个 proposal → 写 1 个 SKILL.md。
    """

    monkeypatch.setenv("QUILIN_SKILLS_DIR", str(tmp_path))

    cases = [
        _case("c1", "run pytest then commit", ["pytest -q", "git commit -m a"]),
        _case("c2", "run pytest then commit", ["pytest -q tests/", "git commit -m b"]),
        _case("c3", "run pytest then commit", ["pytest -q", "git commit -m c"]),
    ]
    gate = _AllowGate()
    job = SkillCandidateProposerJob(
        case_provider=lambda: cases,
        write_authority_factory=lambda: gate,
        dry_run=False,
    )

    result = await job.run(_ctx(job.id))

    assert result.status == "succeeded"
    assert result.data["cases_seen"] == 3
    assert result.data["proposals"] == 1
    assert result.data["written"] == 1
    assert result.data["denied"] == 0
    skill_files = sorted(p for p in tmp_path.iterdir() if p.suffix == ".md")
    assert len(skill_files) == 1
    assert skill_files[0].read_text(encoding="utf-8").startswith("---\n")


@pytest.mark.asyncio
async def test_daemon_job_dry_run_authorises_but_does_not_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dry-run daemon path with cases present still calls the gate(audit) but
    leaves the skills directory empty.

    dry_run + 有 case:仍 call gate(留 audit log),但不真写盘。
    """

    monkeypatch.setenv("QUILIN_SKILLS_DIR", str(tmp_path))

    cases = [
        _case("c1", "run pytest then commit", ["pytest -q", "git commit -m a"]),
        _case("c2", "run pytest then commit", ["pytest -q", "git commit -m b"]),
        _case("c3", "run pytest then commit", ["pytest -q", "git commit -m c"]),
    ]
    gate = _AllowGate()
    job = SkillCandidateProposerJob(
        case_provider=lambda: cases,
        write_authority_factory=lambda: gate,
        dry_run=True,
    )

    result = await job.run(_ctx(job.id))

    assert result.status == "succeeded"
    assert result.data["proposals"] == 1
    assert result.data["written"] == 0
    assert result.data["dry_run"] is True
    assert list(tmp_path.iterdir()) == []
    assert len(gate.calls) == 1


@pytest.mark.asyncio
async def test_daemon_job_proposer_propose_is_called(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Inject a stub proposer to confirm the daemon job actually forwards the
    case batch — guards against future refactors that accidentally drop the
    propose call.

    注入 stub proposer,确认 daemon job 把 case 列表正确转给 propose(),防止
    未来重构断链。
    """

    monkeypatch.setenv("QUILIN_SKILLS_DIR", str(tmp_path))

    captured: list[Sequence[TrajectoryCase]] = []

    class _StubProposer:
        def propose(self, cases: Sequence[TrajectoryCase]) -> list[SkillProposal]:
            captured.append(list(cases))
            return []

    job = SkillCandidateProposerJob(
        case_provider=lambda: [
            _case("c1", "run pytest", ["pytest -q"]),
            _case("c2", "run pytest", ["pytest -q"]),
        ],
        proposer_factory=_StubProposer,
        dry_run=True,
    )

    result = await job.run(_ctx(job.id))

    assert result.status == "succeeded"
    assert len(captured) == 1
    assert {c.id for c in captured[0]} == {"c1", "c2"}
    assert result.data["proposals"] == 0


@pytest.mark.asyncio
async def test_writer_via_real_proposer_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: real ``SkillProposer.propose`` → ``SkillProposerWriter`` →
    file on disk with frontmatter sourced from the cluster. No shortcuts.

    端到端:真 SkillProposer + 真 writer → 文件落盘,frontmatter 由 cluster 真
    聚合而来,不走 shortcut。
    """

    monkeypatch.setenv("QUILIN_SKILLS_DIR", str(tmp_path))
    proposer = SkillProposer()
    writer = SkillProposerWriter()
    gate = _AllowGate()

    proposals = proposer.propose(
        [
            _case("c1", "run pytest then commit", ["pytest -q", "git commit -m a"]),
            _case("c2", "run pytest commit", ["pytest -q tests/", "git commit -m b"]),
            _case("c3", "run pytest and commit", ["pytest -q", "git commit -m c"]),
        ]
    )
    assert len(proposals) == 1

    result = await writer.write_candidate_to_disk(
        proposals[0], write_authority=gate, dry_run=False
    )
    assert result.path is not None
    assert result.path.parent == tmp_path
    text = result.path.read_text(encoding="utf-8")
    assert "## Source cases / 出处案例" in text
    assert "c1" in text and "c2" in text and "c3" in text


