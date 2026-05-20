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

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass

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
                raise ValueError(
                    "SkillProposal.name must not contain ':' (YAML injection risk)"
                )

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
        token
        for token in cleaned.split()
        if len(token) >= 2 and token not in _INTENT_STOPWORDS
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


__all__ = [
    "DEFAULT_ACTION_SIMILARITY_THRESHOLD",
    "DEFAULT_INTENT_SIMILARITY_THRESHOLD",
    "DEFAULT_MIN_CASES_FOR_PROPOSAL",
    "SKILL_PROPOSER_SCHEMA_VERSION",
    "SkillProposal",
    "SkillProposer",
    "SkillProposerConfig",
]
