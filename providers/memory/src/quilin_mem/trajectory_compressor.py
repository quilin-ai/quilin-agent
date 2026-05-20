"""Trajectory compression for QUI-198 Operation-Step Pipeline.

This module condenses a multi-turn user/assistant conversation into a single
:class:`TrajectoryCase` — an AgentCase record describing one observed
"workflow" (intent + ordered action steps + success/failure signals).

Cases are downstream input for :mod:`quilin_mem.skill_proposer`, which clusters
recurring cases into SKILL.md proposals. Following the QUI-189 dedupe pattern
the compressor is **pure**:

* Compression accepts a tuple of :class:`ObservationTurn` (already normalised
  by ``observer.py``) plus optional LLM caller. It returns a single
  :class:`TrajectoryCase` or ``None`` when there is too little signal.
* Writes to the memory store / skill catalog happen elsewhere; the compressor
  never mutates global state.

The LLM path is gated by an injection-resistant prompt that:

1. Wraps user content in a per-request ``<TURN_TEXT_{boundary_token}>...``
   boundary (mirrors ``consolidator._build_prompt``).
2. Treats LLM output that leaks the boundary token as an injection attempt
   and falls back to the deterministic heuristic.

When ``llm_caller`` is ``None`` or returns malformed output, the heuristic
extracts intent + action steps using verb-noun phrases and command-shell
hints (``pytest``, ``ruff``, ``git commit``, etc.), keeping behaviour stable
in offline tests.
"""

from __future__ import annotations

import re
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, cast
from uuid import uuid4

from .observer import ObservationRole, ObservationTurn

TRAJECTORY_SCHEMA_VERSION = 1

# Compression model — separate env var so deployments can route trajectory
# compression to a cheaper model than the main reflector / consolidator.
DEFAULT_COMPRESS_MODEL = "deepseek-v4-flash"

# Heuristic thresholds — single source of truth for runtime + tests.
MIN_TURNS_FOR_CASE = 2
DEFAULT_MAX_ACTION_STEPS = 12
MAX_CONTENT_PER_TURN = 800

# Success / failure lexicon. Each entry is matched as a contained substring on
# the lowercased user text, which keeps detection robust to surrounding
# punctuation (e.g. "对！"、"完美~").
SUCCESS_LEXICON: tuple[str, ...] = (
    "好",
    "对",
    "完美",
    "perfect",
    "great",
    "ok",
    "looks good",
    "ship it",
    "lgtm",
    "通过",
    "搞定",
    "成功",
)
FAILURE_LEXICON: tuple[str, ...] = (
    "不对",
    "错了",
    "撤销",
    "revert",
    "rollback",
    "wrong",
    "broken",
    "失败",
    "不行",
    "回滚",
)

# Action verbs we recognise heuristically. Anchored at the start so we don't
# match the verb mid-sentence; case-insensitive matching is handled by the
# caller via ``str.lower``.
_ACTION_VERB_PREFIXES: tuple[str, ...] = (
    "run",
    "execute",
    "build",
    "test",
    "lint",
    "format",
    "commit",
    "push",
    "deploy",
    "install",
    "fix",
    "edit",
    "update",
    "create",
    "delete",
    "remove",
    "review",
    "merge",
    "rebase",
    "verify",
    "check",
    "跑",
    "执行",
    "构建",
    "测试",
    "提交",
    "部署",
    "修复",
    "更新",
    "删除",
    "审查",
    "验证",
    "检查",
)

# Command-shell hints — when these substrings appear we keep the full line as
# an action step (after trimming) since they are concrete shell invocations.
_COMMAND_HINTS: tuple[str, ...] = (
    "pytest",
    "ruff",
    "mypy",
    "git ",
    "npm ",
    "pnpm ",
    "bun ",
    "uv ",
    "just ",
    "cargo ",
    "docker ",
)


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True, frozen=True)
class ActionStep:
    """A single concrete operation extracted from a trajectory."""

    order: int
    description: str
    role: ObservationRole = "assistant"
    source_turn_id: str | None = None

    def __post_init__(self) -> None:
        if self.order < 0:
            raise ValueError("ActionStep.order must be non-negative")
        if not isinstance(self.description, str) or not self.description.strip():
            raise ValueError("ActionStep.description must be a non-empty string")


@dataclass(slots=True, frozen=True)
class TrajectoryCase:
    """One condensed AgentCase — input for :mod:`skill_proposer`."""

    id: str
    user_id: str
    session_id: str
    intent: str
    action_sequence: tuple[ActionStep, ...]
    success_signals: tuple[str, ...]
    failure_signals: tuple[str, ...]
    occurred_at: datetime
    confidence: float
    schema_version: int = TRAJECTORY_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be between 0 and 1")

    @property
    def succeeded(self) -> bool:
        """Convenience flag: at least one success signal and no failure signal."""

        return bool(self.success_signals) and not self.failure_signals


@dataclass(slots=True, frozen=True)
class CompressorConfig:
    """Tunable thresholds for the compressor.

    Defaults mirror module constants; tests override individual values without
    touching module-level state.
    """

    compress_model: str = DEFAULT_COMPRESS_MODEL
    min_turns_for_case: int = MIN_TURNS_FOR_CASE
    max_action_steps: int = DEFAULT_MAX_ACTION_STEPS
    max_content_per_turn: int = MAX_CONTENT_PER_TURN
    min_confidence_to_emit: float = 0.4


class TrajectoryLLMCaller(Protocol):
    """Protocol matching ``ReflectionLLMCaller`` in :mod:`reflector`.

    Implementations receive the model id plus a boundary-wrapped serialisation
    of the turn buffer and return a JSON-shaped mapping describing intent +
    actions. Any value of an unexpected type is ignored by the compressor.
    """

    def __call__(
        self,
        *,
        model: str,
        turns: Sequence[Mapping[str, object]],
        boundary_token: str,
    ) -> Mapping[str, object]: ...


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


class TrajectoryCompressor:
    """Compress observation turns into a single AgentCase record."""

    def __init__(
        self,
        config: CompressorConfig | None = None,
        *,
        llm_caller: TrajectoryLLMCaller | None = None,
    ) -> None:
        self._config = config or CompressorConfig()
        self._llm_caller = llm_caller

    @property
    def config(self) -> CompressorConfig:
        return self._config

    def compress(
        self,
        turns: Sequence[ObservationTurn],
        *,
        now: datetime | None = None,
        case_id: str | None = None,
    ) -> TrajectoryCase | None:
        """Return a single :class:`TrajectoryCase` or ``None``.

        ``None`` is returned when the turn buffer carries too little signal —
        either fewer turns than ``config.min_turns_for_case`` or no
        identifiable action steps after heuristic + (optional) LLM extraction.
        """

        if len(turns) < self._config.min_turns_for_case:
            return None

        normalised = self._truncate_turns(turns)
        success_signals = self._collect_signals(normalised, SUCCESS_LEXICON)
        failure_signals = self._collect_signals(normalised, FAILURE_LEXICON)

        llm_payload = self._invoke_llm(normalised)
        heuristic_intent = self.extract_intent(normalised)
        heuristic_actions = self.extract_action_sequence(normalised)

        intent = _text_value(llm_payload.get("intent"), heuristic_intent).strip()
        actions = _coerce_actions(
            llm_payload.get("actions"),
            fallback=heuristic_actions,
            max_steps=self._config.max_action_steps,
        )
        if not actions:
            return None

        confidence_floor = 0.5 if self._llm_caller is None else 0.6
        confidence = _clamp_confidence(llm_payload.get("confidence"), confidence_floor)
        if confidence < self._config.min_confidence_to_emit:
            return None

        session_id = _first_present(normalised, "session_id") or "unknown-session"
        user_id = _first_present(normalised, "user_id") or "unknown-user"
        occurred_at = now or _last_observed_at(normalised) or _utcnow()

        return TrajectoryCase(
            id=case_id or str(uuid4()),
            user_id=user_id,
            session_id=session_id,
            intent=intent or "unspecified user workflow",
            action_sequence=tuple(actions),
            success_signals=success_signals,
            failure_signals=failure_signals,
            occurred_at=occurred_at,
            confidence=confidence,
        )

    def extract_intent(self, turns: Sequence[ObservationTurn]) -> str:
        """Heuristic intent extraction.

        Concatenates non-empty user turns (truncated per config) and stitches
        their leading clauses together. Keeps behaviour deterministic so unit
        tests can assert exact strings without LLM mocking.
        """

        user_lines: list[str] = []
        for turn in turns:
            if turn.role != "user":
                continue
            content = turn.content.strip()
            if not content:
                continue
            first_line = content.splitlines()[0].strip()
            if first_line:
                user_lines.append(first_line[: self._config.max_content_per_turn])

        if not user_lines:
            return ""
        return " | ".join(user_lines[:3])

    def extract_action_sequence(self, turns: Sequence[ObservationTurn]) -> list[ActionStep]:
        """Heuristic action extraction.

        Scans assistant + tool turns for either an explicit command hint
        (``pytest``, ``ruff``, …) or a leading action verb (``run``, ``跑``,
        …). Each matching line becomes one :class:`ActionStep` in observed
        order; duplicates are skipped.
        """

        steps: list[ActionStep] = []
        seen: set[str] = set()
        order = 0
        for turn in turns:
            if turn.role not in {"assistant", "tool"}:
                continue
            for raw_line in turn.content.splitlines():
                line = raw_line.strip()
                if not line or not _looks_like_action(line):
                    continue
                normalised = line[: self._config.max_content_per_turn]
                key = normalised.lower()
                if key in seen:
                    continue
                seen.add(key)
                steps.append(
                    ActionStep(
                        order=order,
                        description=normalised,
                        role=turn.role,
                        source_turn_id=turn.turn_id,
                    )
                )
                order += 1
                if order >= self._config.max_action_steps:
                    return steps
        return steps

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _truncate_turns(self, turns: Sequence[ObservationTurn]) -> tuple[ObservationTurn, ...]:
        cap = self._config.max_content_per_turn
        out: list[ObservationTurn] = []
        for turn in turns:
            if len(turn.content) <= cap:
                out.append(turn)
                continue
            out.append(
                ObservationTurn(
                    content=turn.content[:cap],
                    role=turn.role,
                    turn_id=turn.turn_id,
                    session_id=turn.session_id,
                    user_id=turn.user_id,
                    metadata=dict(turn.metadata),
                    observed_at=turn.observed_at,
                )
            )
        return tuple(out)

    def _collect_signals(
        self,
        turns: Sequence[ObservationTurn],
        lexicon: Sequence[str],
    ) -> tuple[str, ...]:
        hits: list[str] = []
        for turn in turns:
            if turn.role != "user":
                continue
            text = turn.content.lower()
            for token in lexicon:
                if token in text and token not in hits:
                    hits.append(token)
        return tuple(hits)

    def _invoke_llm(self, turns: Sequence[ObservationTurn]) -> Mapping[str, object]:
        if self._llm_caller is None:
            return {}

        boundary_token = secrets.token_hex(8)
        serialised = self._serialise_for_llm(turns, boundary_token)
        try:
            result = self._llm_caller(
                model=self._config.compress_model,
                turns=serialised,
                boundary_token=boundary_token,
            )
        except Exception:  # noqa: BLE001 — LLM must never crash the pipeline.
            return {}
        if not isinstance(result, Mapping):
            return {}

        # Boundary token must not leak — if it does, the LLM was reflecting
        # untrusted content and we discard its output (matches consolidator).
        if _payload_contains_token(result, boundary_token):
            return {}
        return result

    def _serialise_for_llm(
        self,
        turns: Sequence[ObservationTurn],
        boundary_token: str,
    ) -> list[Mapping[str, object]]:
        rows: list[Mapping[str, object]] = []
        for turn in turns:
            content = turn.content.replace("\n", " ")[: self._config.max_content_per_turn]
            rows.append(
                {
                    "role": turn.role,
                    "wrapped_content": (
                        f"<TURN_TEXT_{boundary_token}>{content}</TURN_TEXT_{boundary_token}>"
                    ),
                    "turn_id": turn.turn_id,
                }
            )
        return rows


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _looks_like_action(line: str) -> bool:
    lowered = line.lower()
    for hint in _COMMAND_HINTS:
        if hint in lowered:
            return True
    # English verb prefix
    head = lowered.split(maxsplit=1)
    if head:
        verb = head[0].strip(":：,-").rstrip(".!?")
        if verb in _ACTION_VERB_PREFIXES:
            return True
    # Chinese verb prefix (no whitespace split)
    for verb in _ACTION_VERB_PREFIXES:
        if any("一" <= ch <= "鿿" for ch in verb) and line.startswith(verb):
            return True
    # Numbered list ("1. 跑测试", "2) commit")
    return bool(re.match(r"^\d+[\.\)、]\s*\S", line))


def _coerce_actions(
    raw: object,
    *,
    fallback: Sequence[ActionStep],
    max_steps: int,
) -> list[ActionStep]:
    if not isinstance(raw, list) or not raw:
        return list(fallback[:max_steps])

    coerced: list[ActionStep] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        if len(coerced) >= max_steps:
            break
        if isinstance(entry, str):
            description = entry.strip()
            if not description:
                continue
            key = description.lower()
            if key in seen:
                continue
            seen.add(key)
            coerced.append(ActionStep(order=index, description=description))
            continue
        if isinstance(entry, Mapping):
            description_raw = entry.get("description") or entry.get("text")
            if not isinstance(description_raw, str):
                continue
            description = description_raw.strip()
            if not description:
                continue
            key = description.lower()
            if key in seen:
                continue
            seen.add(key)
            role_raw = entry.get("role")
            role: ObservationRole = (
                cast(ObservationRole, role_raw)
                if role_raw in {"user", "assistant", "tool", "system"}
                else "assistant"
            )
            source_raw = entry.get("source_turn_id")
            source_turn_id = source_raw if isinstance(source_raw, str) else None
            coerced.append(
                ActionStep(
                    order=index,
                    description=description,
                    role=role,
                    source_turn_id=source_turn_id,
                )
            )
    if not coerced:
        return list(fallback[:max_steps])
    return coerced


def _clamp_confidence(value: object, fallback: float) -> float:
    if isinstance(value, bool):
        # bool is a subtype of int — exclude explicitly.
        return fallback
    if isinstance(value, int | float):
        # QUI-198 Reviewer 1 REAL #3 fix (2026-05-21):NaN 通过 isinstance(float)
        # check 但 `min(1.0, nan) == 1.0` 静默返满分。math.isfinite 排除 NaN / inf。
        import math

        numeric_value = float(value)
        if not math.isfinite(numeric_value):
            return fallback
        return max(0.0, min(1.0, numeric_value))
    return fallback


def _text_value(value: object, fallback: str) -> str:
    if isinstance(value, str) and value.strip():
        return value
    return fallback


def _first_present(turns: Sequence[ObservationTurn], attribute: str) -> str | None:
    for turn in turns:
        candidate = getattr(turn, attribute, None)
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _last_observed_at(turns: Sequence[ObservationTurn]) -> datetime | None:
    if not turns:
        return None
    return max(turn.observed_at for turn in turns)


def _payload_contains_token(payload: Mapping[str, object], token: str) -> bool:
    """Recursively check whether the LLM payload echoes the boundary token.

    ``repr`` walks the structure once and includes every nested string —
    cheap and sufficient for the injection-guard fast path.
    """

    return token in repr(payload)


__all__ = [
    "ActionStep",
    "CompressorConfig",
    "DEFAULT_COMPRESS_MODEL",
    "DEFAULT_MAX_ACTION_STEPS",
    "FAILURE_LEXICON",
    "MAX_CONTENT_PER_TURN",
    "MIN_TURNS_FOR_CASE",
    "SUCCESS_LEXICON",
    "TRAJECTORY_SCHEMA_VERSION",
    "TrajectoryCase",
    "TrajectoryCompressor",
    "TrajectoryLLMCaller",
]
