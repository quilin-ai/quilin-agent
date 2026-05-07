from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, Protocol, cast, runtime_checkable
from urllib.request import Request, urlopen

ObservationRole = Literal["user", "assistant", "tool", "system", "unknown"]
ObservationKind = Literal["fact", "preference", "event", "intent", "relationship", "unknown"]
ObservationBatchQualityStatus = Literal["rejected", "mixed", "high_quality"]
ObservationLanguage = Literal["en", "zh", "mixed", "unknown"]
ObservationExtractionPath = Literal["deterministic", "deterministic_escalation"]
ObservationEscalationReason = Literal[
    "ambiguous_memory_request",
    "mixed_language_input",
    "non_user_source",
    "no_deterministic_candidate",
    "safety_relevant",
]
ObservationArchiveBlockingReason = Literal[
    "empty_batch",
    "all_candidates_rejected",
    "mixed_batch",
    "rejected_candidates",
    "escalation_required",
    "policy_review_required",
    "low_confidence_candidates",
    "low_quality_candidates",
    "no_high_quality_candidates",
]
OBSERVATION_ARCHIVE_BLOCKING_REASON_ORDER: tuple[
    ObservationArchiveBlockingReason,
    ...,
] = (
    "empty_batch",
    "all_candidates_rejected",
    "mixed_batch",
    "rejected_candidates",
    "escalation_required",
    "policy_review_required",
    "low_confidence_candidates",
    "low_quality_candidates",
    "no_high_quality_candidates",
)

_DEFAULT_OBSERVER_MODEL = "deepseek-v4-flash"
_DEEPSEEK_CHAT_URL = "https://api.deepseek.com/v1/chat/completions"
_L3A_OBSERVER_SYSTEM_PROMPT = (
    "You are a user-behavior observer in the Quilin Agent memory system. "
    "Analyze the provided conversation turns to discover: "
    "1) recurring user preferences and habits, "
    "2) repeated task patterns or workflows, "
    "3) latent user intentions not yet explicitly stated, "
    "4) communication style preferences (language, verbosity, tone). "
    "Output ONLY a valid JSON object with three fields: "
    '"patterns" (array of strings describing observed patterns), '
    '"suggestions" (array of strings with actionable profile improvement suggestions), '
    '"confidence" (a float between 0.0 and 1.0 indicating overall confidence). '
    "Be conservative — only report patterns with clear evidence from the conversation."
)
_L3A_OBSERVER_USER_PROMPT_TEMPLATE = (
    "Below are the most recent {turn_count} turns from a user session. "
    "Analyze them and extract profile-worthy observations:\n\n{turns_text}"
)


@dataclass(slots=True, frozen=True)
class ObserverConfig:
    """Immutable configuration for L3a LLM-backed observer.

    Fields:
        model: DeepSeek model name for observer LLM calls.
        api_key: API key for the observer LLM.  Default reads DEEPSEEK_API_KEY env var.
        frequency: Trigger LLM analysis every N turns (default 10).
        base_url: Chat completions endpoint URL.
    """

    model: str = field(
        default_factory=lambda: os.environ.get("QUILIN_OBSERVER_MODEL", _DEFAULT_OBSERVER_MODEL)
    )
    api_key: str = field(default_factory=lambda: os.environ.get("DEEPSEEK_API_KEY", ""))
    frequency: int = 10
    base_url: str = _DEEPSEEK_CHAT_URL

    def __post_init__(self) -> None:
        if self.frequency < 1:
            raise ValueError("ObserverConfig.frequency must be >= 1")

VALID_OBSERVATION_ROLES: tuple[ObservationRole, ...] = (
    "user",
    "assistant",
    "tool",
    "system",
    "unknown",
)
VALID_OBSERVATION_KINDS: tuple[ObservationKind, ...] = (
    "fact",
    "preference",
    "event",
    "intent",
    "relationship",
    "unknown",
)
SOURCE_METADATA_KEYS: tuple[str, ...] = (
    "source",
    "source_id",
    "source_turn_id",
    "turn_id",
    "trace_id",
)
EVIDENCE_METADATA_KEYS: tuple[str, ...] = (
    "evidence",
    "evidence_ids",
    "evidence_refs",
    "citations",
    "source_excerpt",
    "supporting_turns",
)
RULE_FIRST_OBSERVER_VERSION = "rule-first-observer-v1"
_VALUE_PATTERN = r"(?P<value>[^.!?\n。！？]{2,180})"
_CJK_RE = re.compile(r"[\u3400-\u9fff]")
_ASCII_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
_WHITESPACE_RE = re.compile(r"\s+")
_LINEAR_ISSUE_RE = re.compile(r"\b(?P<issue>[A-Z]{2,10}-\d+)\b")
_PROJECT_PATH_RE = re.compile(
    r"(?<![\w/.-])"
    r"(?P<path>(?:providers|packages|docs|scripts|crates)/[A-Za-z0-9._/-]+)"
)
_TEST_OUTCOME_RE = re.compile(
    r"\b(?P<command>uv run pytest|pytest|ruff check|ruff|vitest|bun test|cargo test|"
    r"just test-py|just lint-py)\b(?P<tail>[^\n。！？]{0,120})",
    re.IGNORECASE,
)
_OUTCOME_WORD_RE = re.compile(
    r"\b(pass(?:ed|es)?|fail(?:ed|s|ures?)?|error(?:s)?|exit\s+0|exit\s+1|"
    r"0\s+failed)\b",
    re.IGNORECASE,
)
_AMBIGUOUS_MEMORY_RE = re.compile(
    r"\b(maybe|might|possibly|probably|not sure|temporary|for now)\b|"
    r"(可能|也许|大概|不确定|暂时|临时)"
)
_OBSERVER_RELEVANT_RE = re.compile(
    r"\b(prefer|like|want|need|remember|always|never|please|use|keep|write|"
    r"respond|answer|call me)\b|"
    r"(喜欢|偏好|希望|需要|想要|记住|以后|之后|请|必须|不要|叫我|称呼)",
    re.IGNORECASE,
)
_SAFETY_RELEVANT_RE = re.compile(
    r"\b(secret|token|api[-_ ]?key|password|credential|permission|approval|"
    r"private|sensitive)\b|"
    r"(密钥|令牌|密码|凭证|权限|审批|批准|隐私|敏感)",
    re.IGNORECASE,
)
_SECRET_REDACTION = "[REDACTED_SECRET]"
_SECRET_VALUE_PATTERN = (
    r"(?:\"[^\"\n]{4,180}\"|'[^'\n]{4,180}'|`[^`\n]{4,180}`|"
    r"[^\s,;!?。！？)\]}]{4,180})"
)
_SENSITIVE_ASSIGNMENT_KEY_NAMES = frozenset(
    {
        "accesstoken",
        "apikey",
        "authorization",
        "authtoken",
        "bearertoken",
        "clientsecret",
        "credential",
        "credentials",
        "databaseurl",
        "deepseekapikey",
        "githubtoken",
        "openaiapikey",
        "password",
        "privatekey",
        "secret",
        "secretkey",
        "sessiontoken",
        "slacktoken",
        "token",
    }
)
_SENSITIVE_ASSIGNMENT_KEY_SUFFIXES = (
    "apikey",
    "privatekey",
    "secretkey",
    "token",
    "secret",
    "password",
)
_INLINE_SECRET_ASSIGNMENT_RE = re.compile(
    rf"(?P<prefix>\b(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*)"
    rf"(?P<secret>{_SECRET_VALUE_PATTERN})",
    re.IGNORECASE,
)
_LABELED_SECRET_RE = re.compile(
    rf"(?P<label>\b(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|"
    rf"bearer[-_ ]?token|password|passwd|pwd|secret|credential)\b"
    rf"\s*(?:is\s+|[:=]\s*))(?P<secret>{_SECRET_VALUE_PATTERN})",
    re.IGNORECASE,
)
_BEARER_SECRET_RE = re.compile(
    rf"(?P<prefix>\bBearer\s+)(?P<secret>{_SECRET_VALUE_PATTERN})",
    re.IGNORECASE,
)
_STANDALONE_SECRET_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(?:sk|pk|rk|gh[pousr])[-_][A-Za-z0-9][A-Za-z0-9._-]{8,}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
)


@dataclass(frozen=True, slots=True)
class _TextPattern:
    pattern_id: str
    kind: ObservationKind
    confidence: float
    regex: re.Pattern[str]
    prefix: str


_TEXT_PATTERNS: tuple[_TextPattern, ...] = (
    _TextPattern(
        pattern_id="en_explicit_preference",
        kind="preference",
        confidence=0.93,
        regex=re.compile(
            rf"\b(?:i|we|the user)\s+(?:prefer|like|want|need)\s+{_VALUE_PATTERN}",
            re.IGNORECASE,
        ),
        prefix="User preference",
    ),
    _TextPattern(
        pattern_id="en_please_instruction",
        kind="preference",
        confidence=0.9,
        regex=re.compile(
            rf"\bplease\s+(?:use|keep|write|respond(?:\s+in)?|answer(?:\s+in)?)\s+"
            rf"{_VALUE_PATTERN}",
            re.IGNORECASE,
        ),
        prefix="User requested",
    ),
    _TextPattern(
        pattern_id="en_remember_statement",
        kind="fact",
        confidence=0.9,
        regex=re.compile(rf"\bremember(?: that|:)?\s+{_VALUE_PATTERN}", re.IGNORECASE),
        prefix="Remembered fact",
    ),
    _TextPattern(
        pattern_id="en_call_me",
        kind="preference",
        confidence=0.95,
        regex=re.compile(r"\bcall me\s+(?P<value>[^.!?\n。！？]{1,80})", re.IGNORECASE),
        prefix="User naming preference",
    ),
    _TextPattern(
        pattern_id="zh_explicit_preference",
        kind="preference",
        confidence=0.93,
        regex=re.compile(rf"(?:我|我们|用户)(?:更?喜欢|偏好|希望|需要|想要){_VALUE_PATTERN}"),
        prefix="User preference",
    ),
    _TextPattern(
        pattern_id="zh_instruction",
        kind="preference",
        confidence=0.9,
        regex=re.compile(rf"(?:请|以后|之后)(?:用|使用|保持|写|回复|回答){_VALUE_PATTERN}"),
        prefix="User requested",
    ),
    _TextPattern(
        pattern_id="zh_remember_statement",
        kind="fact",
        confidence=0.9,
        regex=re.compile(rf"记住(?:我|用户)?{_VALUE_PATTERN}"),
        prefix="Remembered fact",
    ),
    _TextPattern(
        pattern_id="zh_call_me",
        kind="preference",
        confidence=0.95,
        regex=re.compile(r"叫我(?P<value>[^.!?\n。！？]{1,80})"),
        prefix="User naming preference",
    ),
)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _optional_string(
    payload: Mapping[str, object],
    key: str,
    *,
    field_prefix: str = "turn",
) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field_prefix}.{key} must be a string when provided")
    return value


def _optional_datetime(
    payload: Mapping[str, object],
    key: str,
    *,
    field_prefix: str,
) -> datetime | None:
    value = payload.get(key)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        raise TypeError(f"{field_prefix}.{key} must be an ISO datetime string when provided")

    raw_value = value.strip()
    if not raw_value:
        raise ValueError(f"{field_prefix}.{key} must be a non-empty ISO datetime string")
    try:
        return datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field_prefix}.{key} must be a valid ISO datetime string") from exc


def _normalize_metadata(
    metadata: object,
    *,
    field_name: str = "turn.metadata",
) -> dict[str, object]:
    if metadata is None:
        return {}
    if not isinstance(metadata, Mapping):
        raise TypeError(f"{field_name} must be a mapping when provided")
    return dict(metadata)


def _normalize_role(raw_role: object) -> ObservationRole:
    if raw_role is None:
        return "unknown"
    if not isinstance(raw_role, str):
        raise TypeError("turn.role must be a string when provided")
    if raw_role not in VALID_OBSERVATION_ROLES:
        valid_roles = ", ".join(VALID_OBSERVATION_ROLES)
        raise ValueError(f"Invalid turn.role: {raw_role}. Expected one of: {valid_roles}")
    return cast(ObservationRole, raw_role)


def _normalize_kind(raw_kind: object) -> ObservationKind:
    if raw_kind is None:
        return "unknown"
    if not isinstance(raw_kind, str):
        raise TypeError("candidate.kind must be a string when provided")
    if raw_kind not in VALID_OBSERVATION_KINDS:
        valid_kinds = ", ".join(VALID_OBSERVATION_KINDS)
        raise ValueError(f"Invalid candidate.kind: {raw_kind}. Expected one of: {valid_kinds}")
    return cast(ObservationKind, raw_kind)


def _is_numeric_confidence(value: object) -> bool:
    return not isinstance(value, bool) and isinstance(value, int | float)


@dataclass(slots=True, frozen=True)
class ObservationTurn:
    content: str
    role: ObservationRole = "unknown"
    turn_id: str | None = None
    session_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    observed_at: datetime = field(default_factory=_utcnow)

    def __post_init__(self) -> None:
        if not isinstance(self.content, str):
            raise TypeError("turn.content must be a string")
        object.__setattr__(self, "role", _normalize_role(self.role))
        object.__setattr__(self, "metadata", _normalize_metadata(self.metadata))

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> ObservationTurn:
        content = payload.get("content")
        if not isinstance(content, str):
            raise TypeError("turn.content must be a string")

        return cls(
            content=content,
            role=_normalize_role(payload.get("role")),
            turn_id=_optional_string(payload, "turn_id"),
            session_id=_optional_string(payload, "session_id"),
            user_id=_optional_string(payload, "user_id"),
            metadata=_normalize_metadata(payload.get("metadata")),
            observed_at=_optional_datetime(
                payload,
                "observed_at",
                field_prefix="turn",
            )
            or _utcnow(),
        )


@dataclass(slots=True, frozen=True)
class ObservationCandidate:
    content: str
    confidence: float
    kind: ObservationKind = "unknown"
    source_turn_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    created_at: datetime = field(default_factory=_utcnow)

    def __post_init__(self) -> None:
        if not isinstance(self.content, str):
            raise TypeError("candidate.content must be a string")
        if not self.content.strip():
            raise ValueError("candidate.content must be a non-empty string")
        if not _is_numeric_confidence(self.confidence):
            raise TypeError("candidate.confidence must be numeric")
        if not 0 <= float(self.confidence) <= 1:
            raise ValueError("candidate.confidence must be between 0 and 1")
        if self.source_turn_id is not None and not isinstance(self.source_turn_id, str):
            raise TypeError("candidate.source_turn_id must be a string when provided")

        object.__setattr__(self, "confidence", float(self.confidence))
        object.__setattr__(self, "kind", _normalize_kind(self.kind))
        object.__setattr__(
            self,
            "metadata",
            _normalize_metadata(self.metadata, field_name="candidate.metadata"),
        )

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> ObservationCandidate:
        content = payload.get("content")
        if not isinstance(content, str):
            raise TypeError("candidate.content must be a string")
        confidence = payload.get("confidence")
        if not _is_numeric_confidence(confidence):
            raise TypeError("candidate.confidence must be numeric")

        return cls(
            content=content,
            confidence=confidence,
            kind=_normalize_kind(payload.get("kind")),
            source_turn_id=_optional_string(
                payload,
                "source_turn_id",
                field_prefix="candidate",
            ),
            metadata=_normalize_metadata(
                payload.get("metadata"),
                field_name="candidate.metadata",
            ),
            created_at=_optional_datetime(
                payload,
                "created_at",
                field_prefix="candidate",
            )
            or _utcnow(),
        )


type ObservationTurnInput = ObservationTurn | Mapping[str, object]
type ObservationCandidateInput = ObservationCandidate | Mapping[str, object]


@dataclass(slots=True, frozen=True)
class ObservationCandidateQuality:
    has_content: bool
    has_source: bool
    has_evidence: bool
    has_confidence: bool
    has_valid_confidence: bool
    confidence_value: float | None
    has_known_kind: bool
    evidence_coverage: float
    needs_escalation: bool
    needs_policy_review: bool
    quality_score: float
    issues: tuple[str, ...] = ()


@dataclass(slots=True, frozen=True)
class ObservationArchiveReadinessProjection:
    ready: bool
    status: ObservationBatchQualityStatus
    accepted: int
    rejected: int
    high_quality: int
    average_quality_score: float
    blocking_reasons: tuple[ObservationArchiveBlockingReason, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "ready": self.ready,
            "status": self.status,
            "accepted": self.accepted,
            "rejected": self.rejected,
            "high_quality": self.high_quality,
            "average_quality_score": self.average_quality_score,
            "blocking_reasons": self.blocking_reasons,
        }


@dataclass(slots=True, frozen=True)
class ObservationArchiveGateDecision:
    allowed: bool
    status: ObservationBatchQualityStatus
    blocking_reasons: tuple[ObservationArchiveBlockingReason, ...]
    accepted: int
    rejected: int
    high_quality: int
    summary: str

    def to_dict(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "status": self.status,
            "blocking_reasons": self.blocking_reasons,
            "accepted": self.accepted,
            "rejected": self.rejected,
            "high_quality": self.high_quality,
            "summary": self.summary,
        }


@dataclass(slots=True, frozen=True)
class ObservationArchiveGateReport:
    total_count: int
    allowed_count: int
    blocked_count: int
    allowed_ids: tuple[str, ...]
    blocked_ids: tuple[str, ...]
    reason_codes: tuple[ObservationArchiveBlockingReason, ...]
    decisions: tuple[tuple[str, ObservationArchiveGateDecision], ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "total_count": self.total_count,
            "allowed_count": self.allowed_count,
            "blocked_count": self.blocked_count,
            "allowed_ids": self.allowed_ids,
            "blocked_ids": self.blocked_ids,
            "reason_codes": self.reason_codes,
            "decisions": tuple(
                {"id": decision_id, **decision.to_dict()}
                for decision_id, decision in self.decisions
            ),
        }


@dataclass(slots=True, frozen=True)
class ObservationBatchQualityReport:
    status: ObservationBatchQualityStatus
    archive_ready: bool
    archive_readiness: ObservationArchiveReadinessProjection
    total_candidates: int
    accepted_candidates: int
    rejected_candidates: int
    high_quality_candidates: int
    average_quality_score: float
    qualities: tuple[ObservationCandidateQuality, ...]
    issues: tuple[str, ...] = ()


@dataclass(slots=True, frozen=True)
class ObservationExtractionReport:
    language: ObservationLanguage
    extraction_path: ObservationExtractionPath
    escalation_required: bool
    escalation_reasons: tuple[ObservationEscalationReason, ...]
    pattern_ids: tuple[str, ...]
    candidates: tuple[ObservationCandidate, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "language": self.language,
            "extraction_path": self.extraction_path,
            "escalation_required": self.escalation_required,
            "escalation_reasons": self.escalation_reasons,
            "pattern_ids": self.pattern_ids,
            "candidates": tuple(_candidate_to_dict(candidate) for candidate in self.candidates),
        }


def _candidate_to_dict(candidate: ObservationCandidate) -> dict[str, object]:
    return {
        "content": candidate.content,
        "confidence": candidate.confidence,
        "kind": candidate.kind,
        "source_turn_id": candidate.source_turn_id,
        "metadata": candidate.metadata,
        "created_at": candidate.created_at.isoformat(),
    }


def decide_observation_archive_gate(
    archive_readiness: ObservationArchiveReadinessProjection,
) -> ObservationArchiveGateDecision:
    allowed = archive_readiness.ready
    blocking_reasons = archive_readiness.blocking_reasons
    reason_summary = ",".join(blocking_reasons) if blocking_reasons else "none"
    outcome = "allowed" if allowed else "blocked"

    return ObservationArchiveGateDecision(
        allowed=allowed,
        status=archive_readiness.status,
        blocking_reasons=blocking_reasons,
        accepted=archive_readiness.accepted,
        rejected=archive_readiness.rejected,
        high_quality=archive_readiness.high_quality,
        summary=(
            f"{outcome}: status={archive_readiness.status}; "
            f"reasons={reason_summary}; "
            f"accepted={archive_readiness.accepted}; "
            f"rejected={archive_readiness.rejected}; "
            f"high_quality={archive_readiness.high_quality}"
        ),
    )


def _normalize_archive_gate_decision_items(
    decisions: Mapping[str, ObservationArchiveGateDecision]
    | Iterable[tuple[str, ObservationArchiveGateDecision]],
) -> tuple[tuple[str, ObservationArchiveGateDecision], ...]:
    if isinstance(decisions, Mapping):
        decision_items = tuple(decisions.items())
    elif isinstance(decisions, Iterable) and not isinstance(decisions, str | bytes):
        decision_items = tuple(decisions)
    else:
        raise TypeError("decisions must be a mapping or iterable of decision pairs")

    normalized: list[tuple[str, ObservationArchiveGateDecision]] = []
    seen_ids: set[str] = set()
    for raw_decision_id, decision in decision_items:
        if not isinstance(raw_decision_id, str):
            raise TypeError("archive gate decision id must be a string")
        decision_id = raw_decision_id.strip()
        if not decision_id:
            raise ValueError("archive gate decision id must be non-empty")
        if decision_id in seen_ids:
            raise ValueError(f"duplicate archive gate decision id: {decision_id}")
        if not isinstance(decision, ObservationArchiveGateDecision):
            raise TypeError("archive gate decision must be an ObservationArchiveGateDecision")
        seen_ids.add(decision_id)
        normalized.append((decision_id, decision))

    return tuple(sorted(normalized, key=lambda item: item[0]))


def _ordered_archive_gate_reason_codes(
    decisions: Iterable[ObservationArchiveGateDecision],
) -> tuple[ObservationArchiveBlockingReason, ...]:
    reason_codes = {
        reason
        for decision in decisions
        if not decision.allowed
        for reason in decision.blocking_reasons
    }
    reason_order = {
        reason: index for index, reason in enumerate(OBSERVATION_ARCHIVE_BLOCKING_REASON_ORDER)
    }
    return tuple(
        sorted(
            reason_codes,
            key=lambda reason: (reason_order.get(reason, len(reason_order)), reason),
        )
    )


def build_observation_archive_gate_report(
    decisions: Mapping[str, ObservationArchiveGateDecision]
    | Iterable[tuple[str, ObservationArchiveGateDecision]],
) -> ObservationArchiveGateReport:
    decision_items = _normalize_archive_gate_decision_items(decisions)
    allowed_ids = tuple(decision_id for decision_id, decision in decision_items if decision.allowed)
    blocked_ids = tuple(
        decision_id for decision_id, decision in decision_items if not decision.allowed
    )

    return ObservationArchiveGateReport(
        total_count=len(decision_items),
        allowed_count=len(allowed_ids),
        blocked_count=len(blocked_ids),
        allowed_ids=allowed_ids,
        blocked_ids=blocked_ids,
        reason_codes=_ordered_archive_gate_reason_codes(decision for _, decision in decision_items),
        decisions=decision_items,
    )


def detect_observation_language(text: str) -> ObservationLanguage:
    if not isinstance(text, str) or not text.strip():
        return "unknown"
    has_cjk = bool(_CJK_RE.search(text))
    has_ascii = bool(_ASCII_WORD_RE.search(text))
    if has_cjk and has_ascii:
        return "mixed"
    if has_cjk:
        return "zh"
    if has_ascii:
        return "en"
    return "unknown"


def _source_ref(turn: ObservationTurn) -> str:
    if turn.turn_id and turn.turn_id.strip():
        return turn.turn_id.strip()
    digest = hashlib.sha256(turn.content.encode("utf-8")).hexdigest()[:16]
    return f"content-sha256:{digest}"


def _normalize_assignment_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _is_sensitive_assignment_key(key: str) -> bool:
    normalized = _normalize_assignment_key(key)
    return normalized in _SENSITIVE_ASSIGNMENT_KEY_NAMES or any(
        normalized.endswith(suffix) for suffix in _SENSITIVE_ASSIGNMENT_KEY_SUFFIXES
    )


def _redact_inline_secret_assignment(match: re.Match[str]) -> str:
    key = match.group("key")
    secret = match.group("secret")
    if _is_sensitive_assignment_key(key) and not secret.startswith("[REDACTED"):
        return f"{match.group('prefix')}{_SECRET_REDACTION}"
    return match.group(0)


def _redact_sensitive_text(text: str) -> str:
    redacted = _LABELED_SECRET_RE.sub(
        lambda match: f"{match.group('label')}{_SECRET_REDACTION}",
        text,
    )
    redacted = _INLINE_SECRET_ASSIGNMENT_RE.sub(
        _redact_inline_secret_assignment,
        redacted,
    )
    redacted = _BEARER_SECRET_RE.sub(
        lambda match: f"{match.group('prefix')}{_SECRET_REDACTION}",
        redacted,
    )
    for secret_re in _STANDALONE_SECRET_RES:
        redacted = secret_re.sub(_SECRET_REDACTION, redacted)
    return redacted


def _source_excerpt(content: str, *, max_length: int = 240) -> str:
    collapsed = _WHITESPACE_RE.sub(" ", _redact_sensitive_text(content)).strip()
    if len(collapsed) <= max_length:
        return collapsed
    return f"{collapsed[: max_length - 1]}..."


def _clean_claim_fragment(value: str) -> str | None:
    cleaned = _WHITESPACE_RE.sub(" ", value).strip(" \t\r\n:：,，;；-—")
    cleaned = cleaned.strip("\"'`“”‘’()[]{}")
    cleaned = cleaned.strip(" \t\r\n.。!！?？")
    if len(cleaned) < 2:
        return None
    return cleaned


def _ordered_escalation_reasons(
    reasons: Iterable[ObservationEscalationReason],
) -> tuple[ObservationEscalationReason, ...]:
    order: dict[ObservationEscalationReason, int] = {
        "ambiguous_memory_request": 0,
        "mixed_language_input": 1,
        "non_user_source": 2,
        "safety_relevant": 3,
        "no_deterministic_candidate": 4,
    }
    return tuple(sorted(set(reasons), key=lambda reason: (order[reason], reason)))


def _turn_escalation_reasons(
    turn: ObservationTurn,
    *,
    language: ObservationLanguage,
) -> tuple[ObservationEscalationReason, ...]:
    reasons: list[ObservationEscalationReason] = []
    if language == "mixed":
        reasons.append("mixed_language_input")
    if turn.role in {"assistant", "tool", "system"}:
        reasons.append("non_user_source")
    if _AMBIGUOUS_MEMORY_RE.search(turn.content):
        reasons.append("ambiguous_memory_request")
    if _SAFETY_RELEVANT_RE.search(turn.content):
        reasons.append("safety_relevant")
    return _ordered_escalation_reasons(reasons)


def _looks_observer_relevant(text: str) -> bool:
    return bool(
        _OBSERVER_RELEVANT_RE.search(text)
        or _LINEAR_ISSUE_RE.search(text)
        or _PROJECT_PATH_RE.search(text)
        or _TEST_OUTCOME_RE.search(text)
        or _SAFETY_RELEVANT_RE.search(text)
    )


def _base_candidate_metadata(
    turn: ObservationTurn,
    *,
    language: ObservationLanguage,
    pattern_id: str,
    extraction_path: ObservationExtractionPath,
    escalation_reasons: tuple[ObservationEscalationReason, ...],
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "source": "rule_first_observer",
        "observer_version": RULE_FIRST_OBSERVER_VERSION,
        "language": language,
        "pattern_id": pattern_id,
        "extraction_path": extraction_path,
        "evidence": [_source_ref(turn)],
        "source_excerpt": _source_excerpt(turn.content),
        "needs_escalation": bool(escalation_reasons),
        "needs_policy_review": bool(escalation_reasons) or turn.role != "user",
    }
    if turn.session_id:
        metadata["session_id"] = turn.session_id
    if turn.user_id:
        metadata["user_id"] = turn.user_id
    if escalation_reasons:
        metadata["escalation_reasons"] = escalation_reasons
    return metadata


def _observation_candidate(
    turn: ObservationTurn,
    *,
    content: str,
    confidence: float,
    kind: ObservationKind,
    language: ObservationLanguage,
    pattern_id: str,
    extraction_path: ObservationExtractionPath,
    escalation_reasons: tuple[ObservationEscalationReason, ...],
) -> ObservationCandidate:
    return ObservationCandidate(
        content=_redact_sensitive_text(content),
        confidence=confidence,
        kind=kind,
        source_turn_id=turn.turn_id,
        metadata=_base_candidate_metadata(
            turn,
            language=language,
            pattern_id=pattern_id,
            extraction_path=extraction_path,
            escalation_reasons=escalation_reasons,
        ),
    )


def _extract_text_pattern_candidates(
    turn: ObservationTurn,
    *,
    language: ObservationLanguage,
    escalation_reasons: tuple[ObservationEscalationReason, ...],
) -> list[ObservationCandidate]:
    candidates: list[ObservationCandidate] = []
    for text_pattern in _TEXT_PATTERNS:
        for match in text_pattern.regex.finditer(turn.content):
            fragment = _clean_claim_fragment(match.group("value"))
            if fragment is None:
                continue
            candidates.append(
                _observation_candidate(
                    turn,
                    content=f"{text_pattern.prefix}: {fragment}",
                    confidence=text_pattern.confidence,
                    kind=text_pattern.kind,
                    language=language,
                    pattern_id=text_pattern.pattern_id,
                    extraction_path="deterministic",
                    escalation_reasons=escalation_reasons,
                )
            )
    return candidates


def _extract_structured_candidates(
    turn: ObservationTurn,
    *,
    language: ObservationLanguage,
    escalation_reasons: tuple[ObservationEscalationReason, ...],
) -> list[ObservationCandidate]:
    candidates: list[ObservationCandidate] = []
    for match in _LINEAR_ISSUE_RE.finditer(turn.content):
        issue_id = match.group("issue")
        candidates.append(
            _observation_candidate(
                turn,
                content=f"Referenced Linear issue: {issue_id}",
                confidence=0.95,
                kind="fact",
                language=language,
                pattern_id="linear_issue_reference",
                extraction_path="deterministic",
                escalation_reasons=escalation_reasons,
            )
        )

    for match in _PROJECT_PATH_RE.finditer(turn.content):
        path = match.group("path").rstrip(".,;:)")
        candidates.append(
            _observation_candidate(
                turn,
                content=f"Referenced project path: {path}",
                confidence=0.92,
                kind="fact",
                language=language,
                pattern_id="project_path_reference",
                extraction_path="deterministic",
                escalation_reasons=escalation_reasons,
            )
        )

    for match in _TEST_OUTCOME_RE.finditer(turn.content):
        command = _clean_claim_fragment(match.group("command"))
        tail = _source_excerpt(match.group("tail"), max_length=120)
        if command is None or not _OUTCOME_WORD_RE.search(tail):
            continue
        outcome = tail.strip(" ,;:")
        candidates.append(
            _observation_candidate(
                turn,
                content=f"Observed local validation result: {command} {outcome}".strip(),
                confidence=0.9,
                kind="event",
                language=language,
                pattern_id="test_outcome",
                extraction_path="deterministic",
                escalation_reasons=escalation_reasons,
            )
        )
    return candidates


def _dedupe_candidates(
    candidates: Iterable[ObservationCandidate],
) -> tuple[ObservationCandidate, ...]:
    deduped: list[ObservationCandidate] = []
    seen: set[tuple[str, ObservationKind, str | None]] = set()
    for candidate in candidates:
        key = (candidate.content.casefold(), candidate.kind, candidate.source_turn_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return tuple(deduped)


def _escalation_candidate(
    turn: ObservationTurn,
    *,
    language: ObservationLanguage,
    escalation_reasons: tuple[ObservationEscalationReason, ...],
) -> ObservationCandidate:
    return _observation_candidate(
        turn,
        content=f"Escalate observation review for {_source_ref(turn)}",
        confidence=0.0,
        kind="unknown",
        language=language,
        pattern_id="model_assisted_escalation_required",
        extraction_path="deterministic_escalation",
        escalation_reasons=escalation_reasons,
    )


def build_observation_extraction_report(
    turn: ObservationTurnInput,
) -> ObservationExtractionReport:
    normalized_turn = normalize_observation_turn(turn)
    language = detect_observation_language(normalized_turn.content)
    base_escalation_reasons = _turn_escalation_reasons(
        normalized_turn,
        language=language,
    )
    candidates = _dedupe_candidates(
        (
            *_extract_text_pattern_candidates(
                normalized_turn,
                language=language,
                escalation_reasons=base_escalation_reasons,
            ),
            *_extract_structured_candidates(
                normalized_turn,
                language=language,
                escalation_reasons=base_escalation_reasons,
            ),
        )
    )

    escalation_reasons = base_escalation_reasons
    extraction_path: ObservationExtractionPath = "deterministic"
    if not candidates and _looks_observer_relevant(normalized_turn.content):
        escalation_reasons = _ordered_escalation_reasons(
            (*base_escalation_reasons, "no_deterministic_candidate")
        )
        candidates = (
            _escalation_candidate(
                normalized_turn,
                language=language,
                escalation_reasons=escalation_reasons,
            ),
        )
        extraction_path = "deterministic_escalation"
    elif base_escalation_reasons:
        extraction_path = "deterministic_escalation"

    pattern_ids = tuple(
        str(candidate.metadata["pattern_id"])
        for candidate in candidates
        if "pattern_id" in candidate.metadata
    )
    return ObservationExtractionReport(
        language=language,
        extraction_path=extraction_path,
        escalation_required=bool(escalation_reasons),
        escalation_reasons=escalation_reasons,
        pattern_ids=pattern_ids,
        candidates=candidates,
    )


def extract_observation_candidates(
    turn: ObservationTurnInput,
) -> tuple[ObservationCandidate, ...]:
    return build_observation_extraction_report(turn).candidates


def normalize_observation_turn(turn: ObservationTurnInput) -> ObservationTurn:
    if isinstance(turn, ObservationTurn):
        return turn
    if isinstance(turn, Mapping):
        return ObservationTurn.from_mapping(turn)
    raise TypeError("turn must be an ObservationTurn or mapping")


def normalize_observation_candidate(
    candidate: ObservationCandidateInput,
) -> ObservationCandidate:
    if isinstance(candidate, ObservationCandidate):
        return candidate
    if isinstance(candidate, Mapping):
        return ObservationCandidate.from_mapping(candidate)
    raise TypeError("candidate must be an ObservationCandidate or mapping")


def normalize_observation_candidates(
    candidates: Iterable[ObservationCandidateInput],
) -> list[ObservationCandidate]:
    if isinstance(candidates, Mapping | str | bytes):
        raise TypeError("observer.observe must return an iterable of observation candidates")
    if not isinstance(candidates, Iterable):
        raise TypeError("observer.observe must return an iterable of observation candidates")
    normalized: list[ObservationCandidate] = []
    for candidate in candidates:
        try:
            normalized.append(normalize_observation_candidate(candidate))
        except TypeError, ValueError:
            continue
    return normalized


def _is_non_empty_quality_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, bool):
        return value
    if isinstance(value, Mapping):
        return any(_is_non_empty_quality_value(item) for item in value.values())
    if isinstance(value, Iterable) and not isinstance(value, bytes | bytearray):
        return any(_is_non_empty_quality_value(item) for item in value)
    return True


def _quality_metadata_value(
    metadata: Mapping[str, object],
    keys: tuple[str, ...],
) -> bool:
    return any(_is_non_empty_quality_value(metadata.get(key)) for key in keys)


def evaluate_observation_candidate_quality(
    candidate: ObservationCandidateInput,
) -> ObservationCandidateQuality:
    try:
        normalized = normalize_observation_candidate(candidate)
        content: object = normalized.content
        confidence: object = normalized.confidence
        kind: object = normalized.kind
        source_turn_id: object = normalized.source_turn_id
        metadata: object = normalized.metadata
        metadata_valid = True
    except TypeError, ValueError:
        if not isinstance(candidate, Mapping):
            return ObservationCandidateQuality(
                has_content=False,
                has_source=False,
                has_evidence=False,
                has_confidence=False,
                has_valid_confidence=False,
                confidence_value=None,
                has_known_kind=False,
                evidence_coverage=0.0,
                needs_escalation=False,
                needs_policy_review=False,
                quality_score=0.0,
                issues=("invalid_candidate_type",),
            )
        content = candidate.get("content")
        confidence = candidate.get("confidence")
        kind = candidate.get("kind")
        source_turn_id = candidate.get("source_turn_id")
        metadata = candidate.get("metadata")
        metadata_valid = isinstance(metadata, Mapping) or metadata is None

    normalized_metadata: Mapping[str, object] = metadata if isinstance(metadata, Mapping) else {}
    has_content = isinstance(content, str) and bool(content.strip())
    has_confidence = _is_numeric_confidence(confidence)
    has_valid_confidence = has_confidence and 0 <= float(confidence) <= 1
    confidence_value = float(confidence) if has_valid_confidence else None
    has_known_kind = isinstance(kind, str) and kind in VALID_OBSERVATION_KINDS and kind != "unknown"
    has_source = (
        isinstance(source_turn_id, str)
        and bool(source_turn_id.strip())
        or _quality_metadata_value(normalized_metadata, SOURCE_METADATA_KEYS)
    )
    has_evidence = _quality_metadata_value(normalized_metadata, EVIDENCE_METADATA_KEYS)
    needs_escalation = bool(normalized_metadata.get("needs_escalation")) or _quality_metadata_value(
        normalized_metadata,
        ("escalation_reasons",),
    )
    needs_policy_review = bool(normalized_metadata.get("needs_policy_review"))
    evidence_coverage = (float(has_source) + float(has_evidence)) / 2

    issues: list[str] = []
    if not has_content:
        issues.append("missing_content")
    if not has_source:
        issues.append("missing_source")
    if not has_evidence:
        issues.append("missing_evidence")
    if not has_confidence:
        issues.append("missing_confidence")
    elif not has_valid_confidence:
        issues.append("invalid_confidence")
    if not has_known_kind:
        issues.append("missing_or_unknown_kind")
    if not metadata_valid:
        issues.append("invalid_metadata")
    if needs_escalation:
        issues.append("needs_escalation")
    if needs_policy_review:
        issues.append("needs_policy_review")

    confidence_score = confidence_value if confidence_value is not None else 0.0
    quality_score = 0.0
    if has_content:
        quality_score = round(
            0.35
            + (0.2 * confidence_score)
            + (0.2 if has_known_kind else 0.0)
            + (0.25 * evidence_coverage),
            3,
        )

    return ObservationCandidateQuality(
        has_content=has_content,
        has_source=has_source,
        has_evidence=has_evidence,
        has_confidence=has_confidence,
        has_valid_confidence=has_valid_confidence,
        confidence_value=confidence_value,
        has_known_kind=has_known_kind,
        evidence_coverage=evidence_coverage,
        needs_escalation=needs_escalation,
        needs_policy_review=needs_policy_review,
        quality_score=quality_score,
        issues=tuple(issues),
    )


def evaluate_observation_candidates_quality(
    candidates: Iterable[ObservationCandidateInput],
) -> list[ObservationCandidateQuality]:
    if isinstance(candidates, Mapping | str | bytes):
        raise TypeError("candidates must be an iterable of observation candidates")
    if not isinstance(candidates, Iterable):
        raise TypeError("candidates must be an iterable of observation candidates")
    return [evaluate_observation_candidate_quality(candidate) for candidate in candidates]


def _candidate_normalizes(candidate: ObservationCandidateInput) -> bool:
    try:
        normalize_observation_candidate(candidate)
    except TypeError, ValueError:
        return False
    return True


def _is_high_quality_candidate(quality: ObservationCandidateQuality) -> bool:
    return (
        quality.confidence_value is not None
        and quality.confidence_value >= 0.9
        and quality.quality_score >= 0.95
        and not quality.issues
    )


def _classify_observation_batch_quality(
    *,
    total_candidates: int,
    accepted_candidates: int,
    high_quality_candidates: int,
) -> ObservationBatchQualityStatus:
    if total_candidates == 0 or accepted_candidates == 0:
        return "rejected"
    if high_quality_candidates == total_candidates:
        return "high_quality"
    return "mixed"


def _has_low_confidence_candidate(
    qualities: tuple[ObservationCandidateQuality, ...],
    accepted_flags: tuple[bool, ...],
) -> bool:
    return any(
        accepted and quality.confidence_value is not None and quality.confidence_value < 0.9
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
    )


def _has_escalation_candidate(
    qualities: tuple[ObservationCandidateQuality, ...],
    accepted_flags: tuple[bool, ...],
) -> bool:
    return any(
        accepted and quality.needs_escalation
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
    )


def _has_policy_review_candidate(
    qualities: tuple[ObservationCandidateQuality, ...],
    accepted_flags: tuple[bool, ...],
) -> bool:
    return any(
        accepted and quality.needs_policy_review
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
    )


def _archive_readiness_blocking_reasons(
    *,
    total_candidates: int,
    accepted_candidates: int,
    rejected_candidates: int,
    high_quality_candidates: int,
    qualities: tuple[ObservationCandidateQuality, ...],
    accepted_flags: tuple[bool, ...],
) -> tuple[ObservationArchiveBlockingReason, ...]:
    if total_candidates == 0:
        return ("empty_batch",)
    if accepted_candidates == 0:
        return ("all_candidates_rejected", "no_high_quality_candidates")

    reasons: list[ObservationArchiveBlockingReason] = []
    low_quality_candidates = accepted_candidates - high_quality_candidates
    if (rejected_candidates and accepted_candidates) or (
        high_quality_candidates and low_quality_candidates
    ):
        reasons.append("mixed_batch")
    if rejected_candidates:
        reasons.append("rejected_candidates")
    if _has_escalation_candidate(qualities, accepted_flags):
        reasons.append("escalation_required")
    if _has_policy_review_candidate(qualities, accepted_flags):
        reasons.append("policy_review_required")
    if low_quality_candidates:
        if _has_low_confidence_candidate(qualities, accepted_flags):
            reasons.append("low_confidence_candidates")
        reasons.append("low_quality_candidates")
    if high_quality_candidates == 0:
        reasons.append("no_high_quality_candidates")
    return tuple(reasons)


def evaluate_observation_batch_quality(
    candidates: Iterable[ObservationCandidateInput],
) -> ObservationBatchQualityReport:
    if isinstance(candidates, Mapping | str | bytes):
        raise TypeError("candidates must be an iterable of observation candidates")
    if not isinstance(candidates, Iterable):
        raise TypeError("candidates must be an iterable of observation candidates")

    candidate_items = tuple(candidates)
    qualities = tuple(
        evaluate_observation_candidate_quality(candidate) for candidate in candidate_items
    )
    total_candidates = len(candidate_items)
    accepted_flags = tuple(_candidate_normalizes(candidate) for candidate in candidate_items)
    accepted_candidates = sum(1 for accepted in accepted_flags if accepted)
    rejected_candidates = total_candidates - accepted_candidates
    high_quality_candidates = sum(
        1
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
        if accepted and _is_high_quality_candidate(quality)
    )
    accepted_quality_scores = tuple(
        quality.quality_score
        for quality, accepted in zip(qualities, accepted_flags, strict=True)
        if accepted
    )
    average_quality_score = (
        round(sum(accepted_quality_scores) / len(accepted_quality_scores), 3)
        if accepted_quality_scores
        else 0.0
    )
    status = _classify_observation_batch_quality(
        total_candidates=total_candidates,
        accepted_candidates=accepted_candidates,
        high_quality_candidates=high_quality_candidates,
    )

    issues: list[str] = []
    if total_candidates == 0:
        issues.append("empty_batch")
    if rejected_candidates:
        issues.append("rejected_candidates")
    if accepted_candidates > high_quality_candidates:
        issues.append("low_quality_candidates")
    if total_candidates and high_quality_candidates == 0:
        issues.append("no_high_quality_candidates")
    archive_readiness = ObservationArchiveReadinessProjection(
        ready=status == "high_quality",
        status=status,
        accepted=accepted_candidates,
        rejected=rejected_candidates,
        high_quality=high_quality_candidates,
        average_quality_score=average_quality_score,
        blocking_reasons=_archive_readiness_blocking_reasons(
            total_candidates=total_candidates,
            accepted_candidates=accepted_candidates,
            rejected_candidates=rejected_candidates,
            high_quality_candidates=high_quality_candidates,
            qualities=qualities,
            accepted_flags=accepted_flags,
        ),
    )

    return ObservationBatchQualityReport(
        status=status,
        archive_ready=archive_readiness.ready,
        archive_readiness=archive_readiness,
        total_candidates=total_candidates,
        accepted_candidates=accepted_candidates,
        rejected_candidates=rejected_candidates,
        high_quality_candidates=high_quality_candidates,
        average_quality_score=average_quality_score,
        qualities=qualities,
        issues=tuple(issues),
    )


@runtime_checkable
class MemoryObserver(Protocol):
    async def observe(
        self,
        turn: ObservationTurnInput,
    ) -> Iterable[ObservationCandidateInput]: ...


class RuleFirstMemoryObserver:
    async def observe(self, turn: ObservationTurnInput) -> tuple[ObservationCandidate, ...]:
        return extract_observation_candidates(turn)


class NoOpMemoryObserver:
    async def observe(self, turn: ObservationTurnInput) -> list[ObservationCandidate]:
        normalize_observation_turn(turn)
        return []


class L3aObserver:
    """L3a (LLM-backed) observer — periodic deep analysis via flash model.

    Deterministic (L1/L2) extraction runs on every turn.  Every *frequency* turns
    the buffered conversation is sent to a flash-tier LLM for deeper pattern
    discovery.  Results are parsed into ``ObservationCandidate`` objects and
    optionally written to user profile via ``ProfileUpdater``.

    The LLM call is best-effort — a network or parse failure silently falls back
    to deterministic candidates only.
    """

    def __init__(
        self,
        config: ObserverConfig | None = None,
        *,
        profile_updater: object | None = None,
        _llm_caller: object | None = None,
    ) -> None:
        self._config = config or ObserverConfig()
        self._profile_updater = profile_updater
        self._turn_buffer: list[ObservationTurn] = []
        self._turn_count = 0
        self._llm_caller = _llm_caller or _call_deepseek_api

    async def observe(
        self,
        turn: ObservationTurnInput,
    ) -> list[ObservationCandidate]:
        normalized = normalize_observation_turn(turn)
        self._turn_count += 1
        self._turn_buffer.append(normalized)

        candidates: list[ObservationCandidate] = list(
            extract_observation_candidates(normalized)
        )

        if self._should_trigger_llm() and self._config.api_key:
            try:
                llm_candidates = await self._call_llm()
                candidates.extend(llm_candidates)
                if self._profile_updater is not None:
                    self._apply_to_profile(llm_candidates)
            except Exception:
                pass  # L3a is best-effort — never block deterministic path

        return candidates

    # -- internal -------------------------------------------------------

    def _should_trigger_llm(self) -> bool:
        freq = self._config.frequency
        if freq < 1:
            return False
        return self._turn_count % freq == 0

    async def _call_llm(self) -> list[ObservationCandidate]:
        turns_text = _format_turn_buffer(self._turn_buffer)
        user_prompt = _L3A_OBSERVER_USER_PROMPT_TEMPLATE.format(
            turn_count=len(self._turn_buffer),
            turns_text=turns_text,
        )
        payload = json.dumps(
            {
                "model": self._config.model,
                "messages": [
                    {"role": "system", "content": _L3A_OBSERVER_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.1,
                "max_tokens": 1024,
            }
        ).encode("utf-8")

        response_text = await asyncio.to_thread(
            self._llm_caller,
            self._config.base_url,
            self._config.api_key,
            payload,
        )
        return _parse_l3a_llm_response(response_text, self._turn_buffer)

    def _apply_to_profile(self, candidates: list[ObservationCandidate]) -> None:
        if self._profile_updater is None:
            return
        try:
            from .profile_store import emit_profile_signal  # noqa: F811

            for candidate in candidates:
                if candidate.confidence < 0.7:
                    continue
                signal = emit_profile_signal(
                    profile_id="__default__",
                    updates={"observer_l3a_finding": candidate.content},
                    source="l3a_observer",
                )
                self._profile_updater.apply_signal(  # type: ignore[union-attr]
                    signal,
                    who="l3a_observer",
                    why=f"LLM-observed pattern (confidence={candidate.confidence:.2f})",
                )
        except Exception:
            pass  # profile update is best-effort


def _call_deepseek_api(base_url: str, api_key: str, payload: bytes) -> str:
    """Synchronous HTTP POST to DeepSeek chat completions endpoint.

    Extracted as a module-level function so tests can replace it via the
    ``_llm_caller`` injection point on ``L3aObserver``.
    """
    req = Request(
        base_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
    data = json.loads(body)
    return data["choices"][0]["message"]["content"]


def _format_turn_buffer(buffer: list[ObservationTurn]) -> str:
    """Format buffered turns into a compact text block for the LLM prompt."""
    lines: list[str] = []
    for i, turn in enumerate(buffer, start=1):
        role_label = turn.role if turn.role != "unknown" else "message"
        snippet = turn.content[:300].replace("\n", " ")
        lines.append(f"[Turn {i}] ({role_label}): {snippet}")
    return "\n".join(lines)


def _parse_l3a_llm_response(
    raw_text: str,
    buffer: list[ObservationTurn],
) -> list[ObservationCandidate]:
    """Parse JSON output from L3a LLM into ``ObservationCandidate`` objects."""
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError:
        return []

    if not isinstance(data, dict):
        return []

    candidates: list[ObservationCandidate] = []
    overall_confidence = float(data.get("confidence", 0.0))
    if not (0.0 <= overall_confidence <= 1.0):
        overall_confidence = min(max(overall_confidence, 0.0), 1.0)

    source_turn_id = buffer[-1].turn_id if buffer else None

    patterns: list[str] = _normalize_string_array(data.get("patterns"))
    for pattern in patterns:
        candidates.append(
            ObservationCandidate(
                content=f"L3a observed pattern: {pattern}",
                confidence=round(overall_confidence, 3),
                kind="preference",
                source_turn_id=source_turn_id,
                metadata={
                    "source": "l3a_observer",
                    "observer_version": "l3a-observer-v1",
                    "evidence": [f"buffered_turns_{len(buffer)}"],
                    "extraction_path": "l3a_llm",
                },
            )
        )

    suggestions: list[str] = _normalize_string_array(data.get("suggestions"))
    for suggestion in suggestions:
        candidates.append(
            ObservationCandidate(
                content=f"L3a suggestion: {suggestion}",
                confidence=round(overall_confidence * 0.9, 3),
                kind="intent",
                source_turn_id=source_turn_id,
                metadata={
                    "source": "l3a_observer",
                    "observer_version": "l3a-observer-v1",
                    "evidence": [f"buffered_turns_{len(buffer)}"],
                    "extraction_path": "l3a_llm",
                },
            )
        )

    return candidates


def _normalize_string_array(value: object) -> list[str]:
    """Normalize a JSON array of strings, filtering out non-string entries."""
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
    return result


async def observe_safely(
    observer: MemoryObserver,
    turn: ObservationTurnInput,
) -> list[ObservationCandidate]:
    try:
        normalized_turn = normalize_observation_turn(turn)
        candidates = await observer.observe(normalized_turn)
        return normalize_observation_candidates(candidates)
    except Exception:
        return []
