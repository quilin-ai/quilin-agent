"""Skill proposer for QUI-198 Operation-Step Pipeline.

Consumes a batch of :class:`TrajectoryCase` records (produced by
:mod:`quilin_mem.trajectory_compressor`) and proposes one or more
:class:`SkillProposal` records — candidate ``SKILL.md`` entries that the user
can approve via :class:`WriteAuthority`.

Proposal rules (mirrors the Reflector contract):

* The proposer is **pure** — it never writes to disk or to the memory store.
  ``SkillProposal.to_skill_md`` renders a Markdown body that callers can hand
  to a CRITICAL-gated write step.
* A skill candidate requires **at least 3 similar cases** (configurable). The
  similarity test combines intent-keyword overlap and action-sequence overlap.
* Each proposal carries ``requires_write_authority=True`` so downstream
  consumers cannot accidentally bypass the WriteAuthority gate (07 §2.6.4).

The clustering is intentionally simple (O(n^2) Jaccard with thresholds);
production hardening can swap in embedding similarity later without breaking
the API surface.
"""

from __future__ import annotations

import inspect
import json
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, cast

from .trajectory_compressor import ActionStep, TrajectoryCase

SKILL_PROPOSER_SCHEMA_VERSION = 1

# Defaults — single source of truth for runtime + tests.
DEFAULT_MIN_CASES_FOR_PROPOSAL = 3
DEFAULT_INTENT_SIMILARITY_THRESHOLD = 0.4
DEFAULT_ACTION_SIMILARITY_THRESHOLD = 0.7

# Tokeniser stopwords — keep tiny since intents tend to be short imperatives.
_INTENT_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "from",
        "to",
        "a",
        "an",
        "of",
        "or",
        "but",
        "is",
        "are",
        "was",
        "were",
        "be",
        "do",
        "did",
        "done",
        "i",
        "we",
        "you",
        "他",
        "她",
        "它",
        "我",
        "你",
        "的",
        "了",
        "在",
        "和",
        "或",
        "把",
        "给",
        "让",
    }
)

# kebab-case sanitiser pattern used for skill names.
_KEBAB_INVALID = re.compile(r"[^a-z0-9-]+")
_KEBAB_COLLAPSE = re.compile(r"-+")


@dataclass(slots=True, frozen=True)
class SkillProposerConfig:
    """Tunable thresholds for the proposer."""

    min_cases_for_proposal: int = DEFAULT_MIN_CASES_FOR_PROPOSAL
    intent_similarity_threshold: float = DEFAULT_INTENT_SIMILARITY_THRESHOLD
    action_similarity_threshold: float = DEFAULT_ACTION_SIMILARITY_THRESHOLD
    max_proposals_per_call: int = 5


@dataclass(slots=True, frozen=True)
class SkillProposal:
    """A SKILL.md candidate ready for WriteAuthority approval."""

    name: str
    when_to_use: str
    prerequisites: tuple[str, ...]
    verification_steps: tuple[str, ...]
    expected_evidence: tuple[str, ...]
    failure_cases: tuple[str, ...]
    source_case_ids: tuple[str, ...]
    confidence: float
    requires_write_authority: bool = True
    schema_version: int = SKILL_PROPOSER_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("SkillProposal.name must be a non-empty kebab-case string")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("SkillProposal.confidence must be between 0 and 1")
        if len(self.source_case_ids) == 0:
            raise ValueError("SkillProposal must reference at least one source case")
        # QUI-198 Reviewer 1 REAL #1 fix (2026-05-21):YAML frontmatter 注入防护。
        # name / when_to_use 含换行或冒号 → 可注入伪造 YAML key 覆盖
        # requires_write_authority 绕过 WriteAuthority gate。在构造期强制拒绝。
        for field_name, field_value in (("name", self.name), ("when_to_use", self.when_to_use)):
            if not isinstance(field_value, str):
                raise ValueError(f"SkillProposal.{field_name} must be a string")
            if "\n" in field_value or "\r" in field_value:
                raise ValueError(
                    f"SkillProposal.{field_name} must not contain newline characters "
                    f"(YAML frontmatter injection risk)"
                )
            if ":" in field_value and field_name == "name":
                # name 用 kebab-case,绝不应有冒号
                raise ValueError("SkillProposal.name must not contain ':' (YAML injection risk)")

    def to_skill_md(self) -> str:
        """Render this proposal as a SKILL.md document.

        Output shape follows ``docs/13-skills/README.md`` SKILL.md frontmatter
        + body convention. The Markdown body never embeds raw LLM output;
        every value here comes from heuristic aggregation of cases, so this
        renderer is safe to invoke on the agent main path.
        """

        prerequisites = _bullet_list(self.prerequisites, empty_placeholder="无 / none")
        verification = _bullet_list(
            self.verification_steps,
            empty_placeholder="待补充 / to be supplied",
        )
        evidence = _bullet_list(
            self.expected_evidence,
            empty_placeholder="待补充 / to be supplied",
        )
        failure = _bullet_list(self.failure_cases, empty_placeholder="无已知失败案例")
        source_refs = ", ".join(self.source_case_ids)

        # QUI-198 Reviewer 1 REAL #1 fix:用 YAML quoted string 输出 when_to_use,
        # 即使 newline 检查放过其他特殊字符(冒号 / 引号 / 单引号),quoted scalar
        # 也能安全 escape。JSON 字面量本质就是 YAML 1.2 兼容的 quoted scalar。
        safe_when_to_use = json.dumps(self.when_to_use, ensure_ascii=False)
        safe_name = json.dumps(self.name, ensure_ascii=False)
        return (
            "---\n"
            f"name: {safe_name}\n"
            f"description: {safe_when_to_use}\n"
            f"confidence: {self.confidence:.2f}\n"
            f"requires_write_authority: {str(self.requires_write_authority).lower()}\n"
            f"schema_version: {self.schema_version}\n"
            "---\n\n"
            f"# {self.name}\n\n"
            "## When to use / 使用时机\n"
            f"{self.when_to_use}\n\n"
            "## Prerequisites / 前置条件\n"
            f"{prerequisites}\n\n"
            "## Verification steps / 验证步骤\n"
            f"{verification}\n\n"
            "## Expected evidence / 期望证据\n"
            f"{evidence}\n\n"
            "## Known failure cases / 已知失败案例\n"
            f"{failure}\n\n"
            "## Source cases / 出处案例\n"
            f"{source_refs}\n"
        )


class SkillProposer:
    """Cluster trajectory cases and emit SKILL.md proposals."""

    def __init__(self, config: SkillProposerConfig | None = None) -> None:
        self._config = config or SkillProposerConfig()

    @property
    def config(self) -> SkillProposerConfig:
        return self._config

    def propose(self, cases: Sequence[TrajectoryCase]) -> list[SkillProposal]:
        """Return zero or more SKILL.md proposals.

        Clustering walks the cases in order and greedily groups each case
        into the first cluster whose representative passes both the intent
        and action similarity thresholds. Clusters smaller than
        ``min_cases_for_proposal`` are discarded.
        """

        # QUI-198 Reviewer 1 REAL #2 fix (2026-05-21):按 case.id 去重避免单个
        # case 复读 3x 即触发 propose。攻击/bug 路径:dedupe 上游漏 → propose
        # 错以为是 3 个独立 case → SKILL.md 提案绕过 min_cases threshold。
        seen_ids: set[str] = set()
        deduped_cases: list[TrajectoryCase] = []
        for case in cases:
            if case.id in seen_ids:
                continue
            seen_ids.add(case.id)
            deduped_cases.append(case)

        if len(deduped_cases) < self._config.min_cases_for_proposal:
            return []

        clusters: list[list[TrajectoryCase]] = []
        for case in deduped_cases:
            placed = False
            for cluster in clusters:
                representative = cluster[0]
                if self._cases_are_similar(representative, case):
                    cluster.append(case)
                    placed = True
                    break
            if not placed:
                clusters.append([case])

        proposals: list[SkillProposal] = []
        for cluster in clusters:
            if len(cluster) < self._config.min_cases_for_proposal:
                continue
            proposals.append(self._build_proposal(cluster))
            if len(proposals) >= self._config.max_proposals_per_call:
                break
        return proposals

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _cases_are_similar(self, a: TrajectoryCase, b: TrajectoryCase) -> bool:
        intent_overlap = _jaccard(_intent_tokens(a.intent), _intent_tokens(b.intent))
        if intent_overlap < self._config.intent_similarity_threshold:
            return False
        action_overlap = _action_overlap(a.action_sequence, b.action_sequence)
        return action_overlap >= self._config.action_similarity_threshold

    def _build_proposal(self, cluster: Sequence[TrajectoryCase]) -> SkillProposal:
        representative = cluster[0]
        name = _kebab_case_name(representative.intent) or "auto-skill"
        when_to_use = representative.intent.strip() or "Recurring user workflow"

        action_index = _aggregate_actions(cluster)
        prerequisites = _extract_prerequisites(cluster)
        verification = action_index["actions"]
        evidence = _aggregate_success_signals(cluster)
        failure = _aggregate_failure_signals(cluster)

        # Confidence combines per-case confidence with cluster size — more
        # repeated evidence → stronger candidate. Clamp to [0, 1].
        avg_confidence = sum(case.confidence for case in cluster) / len(cluster)
        size_boost = min(0.2, 0.05 * (len(cluster) - self._config.min_cases_for_proposal + 1))
        confidence = min(1.0, max(0.0, avg_confidence + size_boost))

        return SkillProposal(
            name=name,
            when_to_use=when_to_use,
            prerequisites=tuple(prerequisites),
            verification_steps=tuple(verification),
            expected_evidence=tuple(evidence),
            failure_cases=tuple(failure),
            source_case_ids=tuple(case.id for case in cluster),
            confidence=confidence,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _intent_tokens(intent: str) -> set[str]:
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in intent)
    tokens = {
        token for token in cleaned.split() if len(token) >= 2 and token not in _INTENT_STOPWORDS
    }
    return tokens


def _action_tokens(step: ActionStep) -> frozenset[str]:
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in step.description)
    return frozenset(token for token in cleaned.split() if len(token) >= 2)


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 0.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def _action_overlap(
    a: Sequence[ActionStep],
    b: Sequence[ActionStep],
) -> float:
    if not a or not b:
        return 0.0
    tokens_a = [_action_tokens(step) for step in a]
    tokens_b = [_action_tokens(step) for step in b]
    matched = 0
    used_b: set[int] = set()
    for ta in tokens_a:
        for idx, tb in enumerate(tokens_b):
            if idx in used_b:
                continue
            if not ta or not tb:
                continue
            if _jaccard(set(ta), set(tb)) >= 0.5:
                matched += 1
                used_b.add(idx)
                break
    denom = max(len(tokens_a), len(tokens_b))
    return matched / denom if denom else 0.0


def _kebab_case_name(intent: str) -> str:
    lowered = intent.lower().strip()
    candidate = _KEBAB_INVALID.sub("-", lowered)
    candidate = _KEBAB_COLLAPSE.sub("-", candidate).strip("-")
    if not candidate:
        return ""
    return candidate[:60]


def _aggregate_actions(cluster: Sequence[TrajectoryCase]) -> dict[str, list[str]]:
    """Pick the longest action sequence + dedupe descriptions across cluster."""

    longest = max(cluster, key=lambda case: len(case.action_sequence))
    seen: set[str] = set()
    actions: list[str] = []
    for step in longest.action_sequence:
        key = step.description.strip().lower()
        if key and key not in seen:
            seen.add(key)
            actions.append(step.description.strip())
    return {"actions": actions}


def _extract_prerequisites(cluster: Sequence[TrajectoryCase]) -> list[str]:
    """Heuristic: lines mentioning "before"/"先" or "需要"/"requires" become
    prerequisites. Pulled from intent strings only — we deliberately avoid
    scanning action descriptions to keep prerequisites high-level."""

    hits: list[str] = []
    seen: set[str] = set()
    keywords = ("before", "requires", "prereq", "先", "需要", "前提")
    for case in cluster:
        text = case.intent
        lowered = text.lower()
        for keyword in keywords:
            if keyword in lowered:
                key = text.strip().lower()
                if key and key not in seen:
                    seen.add(key)
                    hits.append(text.strip())
                break
    return hits


def _aggregate_success_signals(cluster: Sequence[TrajectoryCase]) -> list[str]:
    seen: set[str] = set()
    signals: list[str] = []
    for case in cluster:
        for token in case.success_signals:
            if token not in seen:
                seen.add(token)
                signals.append(token)
    return signals


def _aggregate_failure_signals(cluster: Sequence[TrajectoryCase]) -> list[str]:
    seen: set[str] = set()
    signals: list[str] = []
    for case in cluster:
        for token in case.failure_signals:
            if token not in seen:
                seen.add(token)
                signals.append(token)
    return signals


def _bullet_list(items: Sequence[str], *, empty_placeholder: str) -> str:
    if not items:
        return empty_placeholder
    return "\n".join(f"- {item}" for item in items)


# ---------------------------------------------------------------------------
# Disk writer / WriteAuthority gate (QUI-198 disk-write gap fix)
# ---------------------------------------------------------------------------
#
# QUI-198 had a P1 gap audited in docs/03-memory/memory-completeness-audit.md:
# SkillProposer.propose() returned candidates but nothing actually persisted
# them. The Reflector / Promotion modules already route writes through a
# WriteAuthorityGate Protocol (`authorize(request)`); we mirror that shape
# here so SKILL.md candidates land on disk only after a CRITICAL approval,
# matching docs/07-safety-guardrails §2.6.4 ("skill_create" origin="proposal").
#
# QUI-198 disk write gap 修复:proposer 之前只生成候选,从不落盘。Reflector /
# Promotion 已经用 WriteAuthorityGate Protocol(`authorize(request)`)管理写入,
# 这里采用同一形状,SKILL.md 候选必须经 CRITICAL 审批后才落 `~/.quilin/skills/`,
# 对齐 docs/07-safety-guardrails §2.6.4("skill_create" + origin="proposal")。


# Default disk location — overridable per call (tests inject tmp_path) and
# via QUILIN_SKILLS_DIR env var.
DEFAULT_SKILLS_DIR_ENV = "QUILIN_SKILLS_DIR"


def _default_skills_dir() -> Path:
    """Return the default `~/.quilin/skills/` directory.

    返回默认的 ``~/.quilin/skills/`` 目录,允许通过 ``QUILIN_SKILLS_DIR``
    环境变量覆盖(用于测试 / 容器路径迁移)。
    """

    override = os.environ.get(DEFAULT_SKILLS_DIR_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".quilin" / "skills"


class WriteAuthorityGate(Protocol):
    """Structural protocol — same shape as :class:`reflector.WriteAuthorityGate`.

    Re-declared here to avoid importing across sibling modules; the Protocol
    only requires ``authorize(request) -> object`` where ``object`` may be
    ``bool``, a ``Mapping`` with ``{"allowed": bool}`` / ``{"decision": str}``,
    or any object exposing ``allowed`` / ``decision``.

    结构化 Protocol — 与 :class:`reflector.WriteAuthorityGate` 同形,任何暴露
    ``authorize(request)`` 的对象都能直接传入,返回值兼容 bool / mapping /
    带 ``allowed`` 属性的 dataclass / decision dict。
    """

    def authorize(self, request: Mapping[str, object]) -> object: ...


@dataclass(slots=True, frozen=True)
class SkillCandidateWriteResult:
    """Outcome of one ``write_candidate_to_disk`` call.

    ``path`` is populated only when an actual file landed on disk; ``dry_run``
    and denied requests leave it ``None``. ``reason`` carries the structured
    classification (``written`` / ``dry_run`` / ``denied`` / ``existed``) so
    daemon logs can aggregate without parsing free-form messages.

    一次写盘调用的结果:``path`` 只在真写入时填充;``dry_run`` 与拒绝路径不返回路径。
    ``reason`` 提供结构化分类标签便于 daemon 聚合日志。
    """

    proposal: SkillProposal
    path: Path | None
    dry_run: bool
    reason: str
    decision: object = None
    written_at: datetime | None = None
    bytes_written: int = 0


@dataclass(slots=True, frozen=True)
class SkillProposerWriterConfig:
    """Tunable knobs for the writer side.

    ``max_collisions`` caps the rename-on-collision attempts; we never silently
    overwrite an existing SKILL.md(could clobber a curated skill).

    可调阀值:``max_collisions`` 限制同名候选最多重命名次数,避免静默覆盖已有
    SKILL.md(可能是人手 curate 过的 skill)。
    """

    skills_dir: Path = field(default_factory=_default_skills_dir)
    max_collisions: int = 64
    file_mode: int = 0o644
    dir_mode: int = 0o755


class SkillProposerWriter:
    """WriteAuthority-gated SKILL.md writer.

    Stays separate from :class:`SkillProposer` because the proposer is pure
    (no IO) — bolting disk IO + gate calls onto ``propose()`` would couple
    the clustering logic to filesystem state and make tests harder.

    与 :class:`SkillProposer` 解耦的写盘组件:propose 纯函数(无 IO),把磁盘
    与 WriteAuthority gate 调用单独放在 Writer 里,避免聚类逻辑被文件系统污染、
    方便单测注入临时目录与 mock gate。
    """

    def __init__(self, config: SkillProposerWriterConfig | None = None) -> None:
        self._config = config or SkillProposerWriterConfig()

    @property
    def config(self) -> SkillProposerWriterConfig:
        return self._config

    async def write_candidate_to_disk(
        self,
        proposal: SkillProposal,
        *,
        write_authority: WriteAuthorityGate,
        dry_run: bool = True,
        now: datetime | None = None,
    ) -> SkillCandidateWriteResult:
        """Authorize + persist a single SKILL.md candidate.

        Steps:

        1. Render the SKILL.md body via :meth:`SkillProposal.to_skill_md`.
        2. Resolve a non-colliding destination path inside the configured
           skills directory(slugified from ``proposal.name``).
        3. Call ``write_authority.authorize`` with ``origin="proposal"`` and
           ``tool="skill_create"`` so 07-safety classifies it CRITICAL.
        4. If the decision is denied → return ``reason="denied"``.
        5. If ``dry_run=True`` → log the planned write but return without
           touching disk(``reason="dry_run"``).
        6. Otherwise atomically write(``tmp + os.replace``) and chmod 644.

        审批 + 落盘单个 SKILL.md 候选。流程:渲染 → 选无冲突路径 → 过
        WriteAuthority gate(origin="proposal" 走 CRITICAL 审批)→ 拒绝直接返回 →
        dry_run 不真写 → 否则原子写入并 chmod 644。
        """

        content = proposal.to_skill_md()
        skills_dir = self._config.skills_dir
        destination = _resolve_skill_path(
            skills_dir,
            proposal.name,
            max_collisions=self._config.max_collisions,
        )

        request: Mapping[str, object] = {
            "tool": "skill_create",
            "origin": "proposal",
            "riskLevel": "critical",
            "summary": (
                f"Persist SKILL.md candidate '{proposal.name}' to {destination}"
            ),
            "metadata": {
                "schema_version": proposal.schema_version,
                "skill_name": proposal.name,
                "source_case_ids": list(proposal.source_case_ids),
                "confidence": proposal.confidence,
                "destination": str(destination),
                "content_length": len(content),
                "dry_run": dry_run,
            },
        }

        decision = await _authorize_write(write_authority, request)
        if not _decision_allowed(decision):
            return SkillCandidateWriteResult(
                proposal=proposal,
                path=None,
                dry_run=dry_run,
                reason="denied",
                decision=decision,
            )

        if dry_run:
            return SkillCandidateWriteResult(
                proposal=proposal,
                path=None,
                dry_run=True,
                reason="dry_run",
                decision=decision,
            )

        # Atomic write — render to ``<dest>.tmp.<nonce>`` then ``os.replace``
        # so a crash mid-write never leaves a half-written SKILL.md on disk.
        # 原子写:写到 ``<dest>.tmp.<nonce>`` 再 ``os.replace``,避免半写状态被
        # skill catalog 拿去 load。
        skills_dir.mkdir(parents=True, exist_ok=True, mode=self._config.dir_mode)
        tmp_path = destination.with_suffix(destination.suffix + f".tmp.{os.getpid()}")
        data = content.encode("utf-8")
        try:
            tmp_path.write_bytes(data)
            os.chmod(tmp_path, self._config.file_mode)
            os.replace(tmp_path, destination)
        except OSError:
            # Best-effort cleanup of stale tmp file before re-raising.
            with _suppress_oserror():
                tmp_path.unlink(missing_ok=True)
            raise

        written_at = now or datetime.now(UTC)
        return SkillCandidateWriteResult(
            proposal=proposal,
            path=destination,
            dry_run=False,
            reason="written",
            decision=decision,
            written_at=written_at,
            bytes_written=len(data),
        )


# ---------------------------------------------------------------------------
# Writer helpers
# ---------------------------------------------------------------------------


class _SuppressOSError:
    def __enter__(self) -> None:  # pragma: no cover - trivial
        return None

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: Any,
    ) -> bool:
        return exc_type is not None and issubclass(exc_type, OSError)


def _suppress_oserror() -> _SuppressOSError:
    return _SuppressOSError()


def _resolve_skill_path(
    skills_dir: Path,
    raw_name: str,
    *,
    max_collisions: int,
) -> Path:
    """Build a ``skills_dir/<slug>.md`` path, suffixing ``-2``, ``-3``... on
    collision so multiple candidates with the same intent never silently
    clobber each other across sessions.

    构造 ``skills_dir/<slug>.md`` 路径,遇同名追加 ``-2 / -3 ...`` 后缀,
    跨 session 多次写入不会互相覆盖。
    """

    slug = _safe_slug(raw_name)
    base = skills_dir / f"{slug}.md"
    if not base.exists():
        return base
    for counter in range(2, max_collisions + 1):
        candidate = skills_dir / f"{slug}-{counter}.md"
        if not candidate.exists():
            return candidate
    raise RuntimeError(
        f"SkillProposerWriter exhausted {max_collisions} collision retries for slug {slug!r}"
    )


def _safe_slug(raw_name: str) -> str:
    """Re-apply kebab-case sanitisation defensively.

    ``SkillProposal.__post_init__`` already rejects ``:`` / newlines in
    ``name``, but path-safe slugging here closes any residual gap(non-ASCII
    chars become ``-``)so we never write to a directory traversal-tainted
    path.

    重新做一次 kebab-case 安全化:proposal 构造期已拦截 ``:`` / 换行,这里再做
    一次纯路径安全 slug,所有非 ASCII 字母数字字符转 ``-``,杜绝路径穿越或非法
    文件名。
    """

    cleaned = _kebab_case_name(raw_name)
    if not cleaned:
        return "auto-skill"
    return cleaned


async def _authorize_write(
    write_authority: WriteAuthorityGate,
    request: Mapping[str, object],
) -> object:
    """Mirror :func:`reflector._authorize_write` — accepts sync or async gates."""

    decision = write_authority.authorize(request)
    if inspect.isawaitable(decision):
        return await cast(Any, decision)
    return decision


def _decision_allowed(decision: object) -> bool:
    """Mirror :func:`reflector._decision_allowed` decision-shape acceptance."""

    if isinstance(decision, bool):
        return decision
    if isinstance(decision, Mapping):
        allowed = decision.get("allowed")
        if isinstance(allowed, bool):
            return allowed
        decision_value = decision.get("decision")
        return decision_value in {"allow", "allowed", "approved"}
    allowed = getattr(decision, "allowed", None)
    if isinstance(allowed, bool):
        return allowed
    decision_value = getattr(decision, "decision", None)
    return decision_value in {"allow", "allowed", "approved"}


__all__ = [
    "DEFAULT_ACTION_SIMILARITY_THRESHOLD",
    "DEFAULT_INTENT_SIMILARITY_THRESHOLD",
    "DEFAULT_MIN_CASES_FOR_PROPOSAL",
    "DEFAULT_SKILLS_DIR_ENV",
    "SKILL_PROPOSER_SCHEMA_VERSION",
    "SkillCandidateWriteResult",
    "SkillProposal",
    "SkillProposer",
    "SkillProposerConfig",
    "SkillProposerWriter",
    "SkillProposerWriterConfig",
    "WriteAuthorityGate",
]
