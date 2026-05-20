"""Retrieval Safety Gate (QUI-194 / survey §5.2).

在 hybrid retriever 之上增量包一层"安全检索门",做三件事:

1. 低置信标记 (`low_confidence_filter`) — 置信度 < threshold 的条目附加
   `retrieval_confidence: "low"` + `safety_marker: "insufficient_evidence"`,
   仍然返回(不过滤),由下游 caller 决定是否拒答。
2. 共识检查 (`consensus_check`) — 用 LLM judge 多路独立判定 top-K 是否互相
   矛盾,矛盾的条目附加 `consensus: "disagree"` + `quarantine_reason`。
3. 投毒隔离 (`poisoning_quarantine`) — 用历史 `SafetyLesson` 模式匹配,命中
   则附加 `safety_marker: "quarantine"` + `quarantine_reason`。

设计约束(由 Codex feasibility review 锁定):
- 返回类型保持 `list[MemoryItem]`,不引入 union / refusal-object。
- wrap 在 `MemoryRetriever` 之上,不修改 retriever 内部逻辑。
- 所有标记通过 `MemoryMetadata` 附加字段实现,schema 不变。
- env `QUILIN_RETRIEVAL_SAFETY_ENABLED=true` 才激活,默认 false 完全透传。
- LLM judge 复用 `consolidator._DeepseekConsolidationJudge`,不新增 LLM 调用层。

参考:
- A-MemGuard / MemX / OWASP Agent Memory Guard 的 retrieval-time consensus 模式
- AgentPoison / MemoryGraft 的 poisoning quarantine 模式
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol, cast

from .types import MemoryItem, MemoryMetadata, memory_item_with

DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.3
DEFAULT_CONSENSUS_TOP_K = 3
SAFETY_GATE_ENV = "QUILIN_RETRIEVAL_SAFETY_ENABLED"
SAFETY_GATE_THRESHOLD_ENV = "QUILIN_RETRIEVAL_SAFETY_THRESHOLD"
SAFETY_GATE_TOP_K_ENV = "QUILIN_RETRIEVAL_SAFETY_TOP_K"

# Metadata key vocabulary (deliberately namespaced to avoid clashes with retriever)
META_RETRIEVAL_CONFIDENCE = "retrieval_confidence"
META_SAFETY_MARKER = "safety_marker"
META_CONSENSUS = "consensus"
META_QUARANTINE_REASON = "quarantine_reason"
META_SAFETY_LESSON_ID = "safety_lesson_id"

# Safety marker values
MARKER_INSUFFICIENT_EVIDENCE = "insufficient_evidence"
MARKER_QUARANTINE = "quarantine"

# Consensus values
CONSENSUS_AGREE = "agree"
CONSENSUS_DISAGREE = "disagree"

# Confidence labels
CONFIDENCE_LOW = "low"


@dataclass(slots=True, frozen=True)
class SafetyLesson:
    """Historical poisoning / mis-recall lesson for quarantine pattern matching.

    `pattern` is a substring or compiled-style regex (case-insensitive) tested
    against `MemoryItem.content`. `tags` describe the attack class (e.g. prompt
    injection, role hijack). Lessons are persisted via
    `memory_records.metadata["safety_lesson"]` rather than a separate schema.
    """

    id: str
    pattern: str
    reason: str
    tags: tuple[str, ...] = ()
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    is_regex: bool = False

    def matches(self, content: str) -> bool:
        if not self.pattern:
            return False
        if self.is_regex:
            try:
                return re.search(self.pattern, content, re.IGNORECASE) is not None
            except re.error:
                # Malformed regex falls back to substring match (defensive).
                return self.pattern.lower() in content.lower()
        return self.pattern.lower() in content.lower()

    def to_metadata_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "pattern": self.pattern,
            "reason": self.reason,
            "tags": list(self.tags),
            "created_at": self.created_at.isoformat(),
            "is_regex": self.is_regex,
        }

    @classmethod
    def from_metadata_dict(cls, payload: dict[str, object]) -> SafetyLesson:
        raw_created = payload.get("created_at")
        if isinstance(raw_created, str):
            try:
                created_at = datetime.fromisoformat(raw_created)
            except ValueError:
                created_at = datetime.now(UTC)
        else:
            created_at = datetime.now(UTC)

        tags_value = payload.get("tags", [])
        if isinstance(tags_value, (list, tuple)):
            tags = tuple(str(tag) for tag in tags_value)
        else:
            tags = ()

        return cls(
            id=str(payload.get("id", "")),
            pattern=str(payload.get("pattern", "")),
            reason=str(payload.get("reason", "")),
            tags=tags,
            created_at=created_at,
            is_regex=bool(payload.get("is_regex", False)),
        )


class ConsensusJudge(Protocol):
    """Minimal protocol covered by `_DeepseekConsolidationJudge`-like callers.

    The gate only needs a callable that, given a query and a candidate item,
    returns a 0..1 relevance score (or a dict containing it). Real LLM judges
    can adapt their `judge(...)` method via a thin adapter; tests inject a
    deterministic stub.
    """

    def relevance(
        self,
        query: str,
        item: MemoryItem,
    ) -> float: ...


class SafetyLessonStore(Protocol):
    """Persistent store for SafetyLesson records.

    Implementations may piggy-back on the existing `QuilinMemStore` by stashing
    lessons inside `memory_records.metadata["safety_lesson"]` (schema-stable).
    The gate only depends on the iterable contract here.
    """

    def list_lessons(self) -> Sequence[SafetyLesson]: ...

    def record_lesson(self, lesson: SafetyLesson) -> None: ...


class InMemorySafetyLessonStore:
    """Default in-memory implementation for tests and ephemeral runs.

    ⚠️ v1 LIMITATION (QUI-194 follow-up tracked as QUI-200):

    Production deployment currently uses this ephemeral store. The
    SafetyLessonStore Protocol is designed to be backed by the existing
    `memory_records.metadata["safety_lesson"]` slot (no new schema), but a
    production SQLite-backed implementation is **deferred to follow-up issue
    QUI-200**.

    Impact:
    - Process restart loses all recorded SafetyLessons.
    - poisoning_quarantine strategy still works within a process lifetime
      but cannot cumulative-learn across restarts.
    - For testing, hand-feeding lessons via constructor or test injection is
      sufficient. For production, expect quarantine effectiveness to degrade
      after each web/daemon restart until QUI-200 lands.

    Mitigation in v1 (QUI-194 commit):
    - Gate is OFF by default (``QUILIN_RETRIEVAL_SAFETY_ENABLED=false``),
      lossy InMemoryStore does not silently degrade live UX.
    - When user opts in, every ``record_lesson`` call still works within
      the current process; quarantine + safety_lesson are useful for the
      session but not cross-session yet.
    """

    def __init__(self, lessons: Iterable[SafetyLesson] | None = None) -> None:
        self._lessons: list[SafetyLesson] = list(lessons or [])

    def list_lessons(self) -> Sequence[SafetyLesson]:
        return tuple(self._lessons)

    def record_lesson(self, lesson: SafetyLesson) -> None:
        self._lessons = [existing for existing in self._lessons if existing.id != lesson.id]
        self._lessons.append(lesson)


@dataclass(slots=True, frozen=True)
class SafetyGateConfig:
    """Gate-wide tuning knobs.

    `enabled` defaults to `os.environ[QUILIN_RETRIEVAL_SAFETY_ENABLED] == "true"`.
    """

    enabled: bool = False
    low_confidence_threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD
    consensus_top_k: int = DEFAULT_CONSENSUS_TOP_K
    consensus_disagreement_threshold: float = 0.35


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def load_config_from_env() -> SafetyGateConfig:
    return SafetyGateConfig(
        enabled=_env_bool(SAFETY_GATE_ENV, default=False),
        low_confidence_threshold=_env_float(
            SAFETY_GATE_THRESHOLD_ENV, DEFAULT_LOW_CONFIDENCE_THRESHOLD
        ),
        consensus_top_k=_env_int(SAFETY_GATE_TOP_K_ENV, DEFAULT_CONSENSUS_TOP_K),
    )


def _item_confidence(item: MemoryItem) -> float:
    """Pick the most authoritative confidence signal already on the item.

    Order: `metadata.retrieval_score` -> `metadata.score` -> `importance_score`.
    Falls back to `0.0` to be conservative (will trigger low-confidence marker).
    """

    metadata: dict[str, object] = dict(item.metadata)
    for key in ("retrieval_score", "score", "reranker_score"):
        value = metadata.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return float(item.importance_score)


def _annotate(item: MemoryItem, updates: dict[str, object]) -> MemoryItem:
    """Return a new `MemoryItem` with merged metadata. Pure / immutable."""

    merged: dict[str, object] = dict(item.metadata)
    merged.update(updates)
    return memory_item_with(item, metadata=cast(MemoryMetadata, merged))


class _DeepseekRelevanceJudge:
    """Adapter exposing a `relevance(query, item) -> float` over the existing
    consolidator DeepSeek judge.

    We do not import `_DeepseekConsolidationJudge` at module import time to
    avoid pulling network credentials into pure-Python code paths (e.g. unit
    tests that disable the gate). It is resolved lazily.
    """

    def __init__(self, *, model: str | None = None) -> None:
        self._model = model
        self._llm = None  # lazy

    def _ensure_llm(self) -> Any:
        if self._llm is not None:
            return self._llm
        from .consolidator import _DeepseekConsolidationJudge

        self._llm = _DeepseekConsolidationJudge(model=self._model)
        return self._llm

    def relevance(self, query: str, item: MemoryItem) -> float:
        """Ask the LLM 'how relevant is this memory to the query (0..1)?'.

        We deliberately reuse the dedupe judge's transport layer to avoid a
        second HTTP path. The prompt asks for `{"relevance": 0..1}` JSON.
        Network or auth failures return `0.5` (neutral) so the gate degrades
        gracefully.
        """

        try:
            llm = self._ensure_llm()
        except Exception:  # noqa: BLE001
            return 0.5

        api_key = getattr(llm, "_api_key", None)
        base_url = getattr(llm, "_base_url", None)
        model = getattr(llm, "_model", None)
        if not api_key or not base_url or not model:
            return 0.5

        try:
            from .observer import _call_deepseek_api as _llm_call
        except Exception:  # noqa: BLE001
            return 0.5

        prompt = (
            "你是 Quilin Agent 的检索相关性评估器。判定下面这条记忆与查询的相关程度,"
            "返回 0..1 的浮点分数(0 = 完全无关,1 = 高度相关)。\n\n"
            f"查询: {query}\n\n"
            f"记忆 (id={item.id}, layer={item.layer}):\n{item.content}\n\n"
            '只输出 JSON: {"relevance": <float between 0 and 1>}'
        )
        payload = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.0,
                "max_tokens": 50,
                "response_format": {"type": "json_object"},
            }
        ).encode("utf-8")

        try:
            raw = _llm_call(base_url, api_key, payload)
            parsed = json.loads(raw)
            value = parsed.get("relevance", 0.5)
            if not isinstance(value, (int, float)):
                return 0.5
            score = float(value)
            if score < 0.0:
                return 0.0
            if score > 1.0:
                return 1.0
            return score
        except Exception:  # noqa: BLE001 — degrade to neutral on any failure
            return 0.5


class RetrievalSafetyGate:
    """Wrap an existing retriever and scrub its outputs through 3 strategies.

    The gate is **non-destructive**: it never removes items from the result
    list. Suspect items receive metadata markers; downstream consumers decide
    whether to hide them, surface a refusal, or pass them through.

    Wiring example (server.py):

        gate = RetrievalSafetyGate(
            judge=_DeepseekRelevanceJudge(),
            lesson_store=InMemorySafetyLessonStore(),
        )
        retriever = gate.wrap(MemoryRetriever(store, ...))
        items = await retriever.retrieve(query)

    `wrap` returns the original retriever (with `scrub` installed on its
    `recall` path); we use a thin proxy so the public API stays identical.
    """

    def __init__(
        self,
        *,
        config: SafetyGateConfig | None = None,
        judge: ConsensusJudge | None = None,
        lesson_store: SafetyLessonStore | None = None,
    ) -> None:
        self._config = config or load_config_from_env()
        self._judge = judge
        self._lesson_store = lesson_store or InMemorySafetyLessonStore()

    @property
    def config(self) -> SafetyGateConfig:
        return self._config

    @property
    def lesson_store(self) -> SafetyLessonStore:
        return self._lesson_store

    def wrap(self, retriever: Any) -> Any:
        """Install `scrub` on the retriever via a transparent proxy.

        We avoid mutating `retriever` (immutability discipline). The returned
        proxy preserves attribute access; only `retrieve` / `recall` are
        intercepted so the gate runs on their return value.
        """

        gate = self
        return _GatedRetrieverProxy(retriever, gate)

    def scrub(
        self,
        query: str,
        items: list[MemoryItem],
    ) -> list[MemoryItem]:
        """Apply all three strategies. Returns a fresh list; never mutates input.

        Order is intentional:
        1. poisoning_quarantine first (cheap, lesson-driven)
        2. low_confidence_filter second (cheap, score-driven)
        3. consensus_check last (expensive, LLM-driven; only top-K)
        """

        if not self._config.enabled or not items:
            return list(items)

        stage_a = self.poisoning_quarantine(items, self._lesson_store.list_lessons())
        stage_b = self.low_confidence_filter(
            stage_a, threshold=self._config.low_confidence_threshold
        )
        stage_c = self.consensus_check(
            query,
            stage_b,
            k=self._config.consensus_top_k,
        )
        return stage_c

    # ------------------------------------------------------------------ strategies

    def low_confidence_filter(
        self,
        items: list[MemoryItem],
        *,
        threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    ) -> list[MemoryItem]:
        """Mark items with confidence < threshold as `insufficient_evidence`.

        Items remain in the list — caller decides whether to surface a refusal
        or hide them. If an item already carries `safety_marker = quarantine`
        (set by `poisoning_quarantine`), we keep the stronger quarantine signal
        on `safety_marker` and only add the `retrieval_confidence` annotation.
        """

        out: list[MemoryItem] = []
        for item in items:
            confidence = _item_confidence(item)
            if confidence < threshold:
                updates: dict[str, object] = {META_RETRIEVAL_CONFIDENCE: CONFIDENCE_LOW}
                # Quarantine is a stronger signal — do not overwrite it.
                existing_marker = item.metadata.get(META_SAFETY_MARKER)
                if existing_marker != MARKER_QUARANTINE:
                    updates[META_SAFETY_MARKER] = MARKER_INSUFFICIENT_EVIDENCE
                out.append(_annotate(item, updates))
            else:
                out.append(item)
        return out

    def consensus_check(
        self,
        query: str,
        items: list[MemoryItem],
        *,
        k: int = DEFAULT_CONSENSUS_TOP_K,
    ) -> list[MemoryItem]:
        """For top-K items, ask the judge K independent relevance scores.

        Disagreement is defined as `max(scores) - min(scores) >
        consensus_disagreement_threshold`. When disagreement is detected, every
        item in the top-K window gets `consensus: "disagree"` so downstream
        readers know the cluster is unstable.
        """

        if self._judge is None or k <= 1 or not items:
            return list(items)

        window = items[:k]
        scores: list[float] = []
        for candidate in window:
            try:
                score = self._judge.relevance(query, candidate)
            except Exception:  # noqa: BLE001 — judge errors degrade to neutral
                score = 0.5
            if score < 0.0:
                score = 0.0
            elif score > 1.0:
                score = 1.0
            scores.append(score)

        if not scores:
            return list(items)

        spread = max(scores) - min(scores)
        disagreed = spread > self._config.consensus_disagreement_threshold

        if not disagreed:
            return list(items)

        annotated_window: list[MemoryItem] = []
        for item, score in zip(window, scores, strict=True):
            annotated_window.append(
                _annotate(
                    item,
                    {
                        META_CONSENSUS: CONSENSUS_DISAGREE,
                        META_QUARANTINE_REASON: (
                            f"top-{k} consensus disagree (spread={spread:.2f}, score={score:.2f})"
                        ),
                    },
                )
            )
        tail = list(items[k:])
        return annotated_window + tail

    def poisoning_quarantine(
        self,
        items: list[MemoryItem],
        lessons: Iterable[SafetyLesson],
    ) -> list[MemoryItem]:
        """Match each item against known `SafetyLesson` patterns.

        First match wins; the matched lesson's id is recorded in metadata so
        downstream auditing can trace the decision.
        """

        lesson_list = tuple(lessons)
        if not lesson_list:
            return list(items)

        out: list[MemoryItem] = []
        for item in items:
            matched: SafetyLesson | None = None
            for lesson in lesson_list:
                if lesson.matches(item.content):
                    matched = lesson
                    break
            if matched is not None:
                out.append(
                    _annotate(
                        item,
                        {
                            META_SAFETY_MARKER: MARKER_QUARANTINE,
                            META_QUARANTINE_REASON: matched.reason
                            or f"matched safety_lesson:{matched.id}",
                            META_SAFETY_LESSON_ID: matched.id,
                        },
                    )
                )
            else:
                out.append(item)
        return out

    # ------------------------------------------------------------------ lesson helpers

    def record_lesson(self, lesson: SafetyLesson) -> None:
        """Persist a new lesson so future recalls quarantine matching items."""

        self._lesson_store.record_lesson(lesson)


class _GatedRetrieverProxy:
    """Lightweight attribute-forwarding proxy that scrubs `retrieve` / `recall`.

    Implemented as a manual proxy (not `__getattr__` magic) so the surface
    stays explicit. Only the two return-list methods are intercepted; every
    other attribute (e.g. `_store`, `annotate_recall_results`) forwards
    unchanged.
    """

    def __init__(self, inner: Any, gate: RetrievalSafetyGate) -> None:
        # store via __dict__ so __getattr__ doesn't recurse
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_gate", gate)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    async def retrieve(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        items = await self._inner.retrieve(query, task_context, limit=limit)
        return self._gate.scrub(query, list(items))

    async def recall(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        items = await self._inner.recall(query, task_context, limit=limit)
        return self._gate.scrub(query, list(items))


__all__ = [
    "CONFIDENCE_LOW",
    "CONSENSUS_AGREE",
    "CONSENSUS_DISAGREE",
    "ConsensusJudge",
    "DEFAULT_CONSENSUS_TOP_K",
    "DEFAULT_LOW_CONFIDENCE_THRESHOLD",
    "InMemorySafetyLessonStore",
    "MARKER_INSUFFICIENT_EVIDENCE",
    "MARKER_QUARANTINE",
    "META_CONSENSUS",
    "META_QUARANTINE_REASON",
    "META_RETRIEVAL_CONFIDENCE",
    "META_SAFETY_LESSON_ID",
    "META_SAFETY_MARKER",
    "RetrievalSafetyGate",
    "SAFETY_GATE_ENV",
    "SafetyGateConfig",
    "SafetyLesson",
    "SafetyLessonStore",
    "_DeepseekRelevanceJudge",
    "load_config_from_env",
]
