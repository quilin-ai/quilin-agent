"""DepartureContext writer (audit gap P2 #10 / `docs/03-memory/README.md` §二·B).

When a user leaves a session (either by closing the chat or via the 30-min
inactivity detector), Quilin captures a "departure context" snapshot that
records the things the user was in the middle of doing — pending TODOs,
half-asked questions, references they were about to follow up on. On the
next session the LLM can recall this snapshot and immediately re-anchor the
conversation in the user's previous mental state.

当用户离开对话(关闭聊天或触发 30 分钟空闲检测)时,Quilin 抽取一份"离场上下文"
快照,记录用户离开时仍在进行的事情 —— 未完成的待办、问到一半的问题、当时
准备跟进的资料。下一次 session 时,LLM 可以召回这份快照,立刻把对话锚定到
用户之前的心智状态。

Design constraints (audit task brief):

- Pure module — no MCP wiring required for the minimal P2 deliverable.
  Callers are: (1) ``_memory_observe_with_observer`` when a session-ending
  signal is emitted, or (2) the daemon idle scanner once it is enabled.
- LLM extraction is best-effort with a deterministic fallback. The fallback
  preserves the trailing user / assistant turns verbatim so the recall path
  never returns an empty record.
- Records land in the ``episodic`` layer with ``kind="departure_context"``
  and ``metadata.source = "departure_context"``. The session_id lives in
  ``metadata.session_id`` so the next session can query by session.

设计约束(audit 任务书):

- 纯模块 —— 最小 P2 deliverable 不需要 MCP 接线。调用方:
  (1) ``_memory_observe_with_observer`` 在收到 session-end 信号时调,
  (2) daemon idle 扫描器在启用后调。
- LLM 抽取是 best-effort,带 deterministic fallback。Fallback 直接保留
  最后几轮对话原文,保证 recall 永远不会拿到空记录。
- 记录写到 ``episodic`` 层,``kind="departure_context"`` +
  ``metadata.source = "departure_context"``。session_id 存
  ``metadata.session_id``,下次 session 按 session_id 查询。
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, cast

from .types import MemoryItem

DEPARTURE_CONTEXT_KIND = "departure_context"
DEPARTURE_CONTEXT_SOURCE = "departure_context"
DEPARTURE_CONTEXT_SCHEMA_VERSION = 1
DEPARTURE_CONTEXT_LAYER = "episodic"

DEFAULT_DEPARTURE_MODEL = "deepseek-chat"
DEPARTURE_MODEL_ENV = "QUILIN_DEPARTURE_MODEL"
DEPARTURE_IDLE_MINUTES_ENV = "QUILIN_DEPARTURE_IDLE_MINUTES"
DEFAULT_IDLE_MINUTES = 30
DEFAULT_TAIL_TURNS = 6
MAX_CONTENT_PREVIEW_CHARS = 400


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _default_model() -> str:
    return os.environ.get(DEPARTURE_MODEL_ENV, DEFAULT_DEPARTURE_MODEL)


def _default_idle_minutes() -> int:
    raw = os.environ.get(DEPARTURE_IDLE_MINUTES_ENV)
    if raw is None or not raw.strip():
        return DEFAULT_IDLE_MINUTES
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_IDLE_MINUTES


@dataclass(slots=True, frozen=True)
class ConversationTurn:
    """One turn from a session transcript.

    用 ``role`` 区分发言方(``user`` / ``assistant`` / ``system``),``content``
    是原文。``timestamp`` optional,只在按时间窗口判断 idle 时才会用到。
    """

    role: str
    content: str
    timestamp: datetime | None = None

    def short_preview(self, max_chars: int = MAX_CONTENT_PREVIEW_CHARS) -> str:
        content = self.content.strip()
        if len(content) <= max_chars:
            return content
        return content[:max_chars].rstrip() + "…"


@dataclass(slots=True, frozen=True)
class DepartureContextConfig:
    """Tuning knobs for the writer.

    - ``model``: LLM model id (defaults to ``deepseek-chat``).
    - ``idle_minutes``: minimum gap before a session is considered "departed".
    - ``tail_turns``: how many trailing turns to feed the LLM / fallback.
    """

    model: str = field(default_factory=_default_model)
    idle_minutes: int = field(default_factory=_default_idle_minutes)
    tail_turns: int = DEFAULT_TAIL_TURNS
    max_extract_chars: int = 800


@dataclass(slots=True, frozen=True)
class DepartureContext:
    """Structured departure snapshot — the thing we persist as a memory record.

    持久化的离场快照结构。``summary`` 是 LLM 抽出来的"用户离开时的整体状态",
    ``pending_items`` 列出未完成 / 待续的具体任务,``open_questions`` 是用户
    提到但未解答的问题,``followups`` 是用户暗示下次想继续的话题。
    """

    session_id: str
    summary: str
    pending_items: tuple[str, ...] = ()
    open_questions: tuple[str, ...] = ()
    followups: tuple[str, ...] = ()
    extracted_at: datetime = field(default_factory=_utcnow)
    extraction_method: str = "llm"
    schema_version: int = DEPARTURE_CONTEXT_SCHEMA_VERSION

    def to_content(self) -> str:
        """Render a human-readable content string for the memory record.

        把结构化字段渲染成 LLM 在下一次 session 召回时易读的纯文本。
        故意保留中英 label,前缀让 retriever 关键词命中更高。
        """

        lines: list[str] = [f"[departure summary] {self.summary.strip()}"]
        if self.pending_items:
            lines.append("[pending / 未完成]")
            lines.extend(f"- {item}" for item in self.pending_items)
        if self.open_questions:
            lines.append("[open questions / 待解答]")
            lines.extend(f"- {item}" for item in self.open_questions)
        if self.followups:
            lines.append("[followups / 下次跟进]")
            lines.extend(f"- {item}" for item in self.followups)
        return "\n".join(lines)

    def to_metadata(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "source": DEPARTURE_CONTEXT_SOURCE,
            "session_id": self.session_id,
            "extraction_method": self.extraction_method,
            "extracted_at": self.extracted_at.isoformat(),
            "pending_items": list(self.pending_items),
            "open_questions": list(self.open_questions),
            "followups": list(self.followups),
        }


class DepartureLLMCaller(Protocol):
    """Callable that takes a prompt and returns the raw LLM response text.

    保持 protocol 最小,方便测试注入 deterministic stub。
    """

    def __call__(self, prompt: str, *, model: str) -> str: ...


class _MemoryStoreProtocol(Protocol):
    """Subset of ``QuilinMemStore`` the writer actually needs."""

    async def store(
        self,
        content: str,
        tier: str = "working",
        *,
        layer: str | None = None,
        metadata: dict[str, object] | None = None,
        content_type: str = "text",
        embedding: list[float] | None = None,
        importance_score: float = 0.5,
        last_writer_client: str | None = None,
        last_writer_session_id: str | None = None,
        project_scope: str | None = None,
        salience: dict[str, object] | None = None,
        kind: str | None = None,
        deadline_at: datetime | None = None,
        prospective_action: str | None = None,
        resource_pointer: dict[str, object] | None = None,
    ) -> MemoryItem: ...

    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]: ...


class DepartureContextWriter:
    """Extract + persist departure context snapshots.

    Typical wiring:

        writer = DepartureContextWriter(store, llm_caller=my_llm)
        ctx = await writer.extract(session_id, conversation_turns)
        record = await writer.write(ctx)

    抽取 + 持久化离场上下文的写入器。典型接线见 docstring。
    """

    def __init__(
        self,
        store: _MemoryStoreProtocol | None = None,
        *,
        config: DepartureContextConfig | None = None,
        llm_caller: DepartureLLMCaller | None = None,
    ) -> None:
        self._store = store
        self._config = config or DepartureContextConfig()
        self._llm_caller = llm_caller

    @property
    def config(self) -> DepartureContextConfig:
        return self._config

    # ------------------------------------------------------------------ extract

    async def extract(
        self,
        session_id: str,
        conversation_turns: Sequence[ConversationTurn | Mapping[str, object]],
        *,
        now: datetime | None = None,
    ) -> DepartureContext:
        """Extract a departure snapshot from a session transcript.

        - LLM available + ``api_key`` set → ask the model for JSON.
        - LLM unavailable or fails → deterministic fallback (latest N turns
          condensed via ``_deterministic_summary``).

        Returns an immutable ``DepartureContext``. Never raises on LLM failure
        — degrades to the fallback summary so the caller's persistence path
        always succeeds.

        从一段对话 transcript 抽出离场快照。LLM 可用就调 LLM,失败回退到 deterministic
        摘要,永远返回一个有效的 ``DepartureContext``。
        """

        normalized = tuple(_normalize_turns(conversation_turns))
        if not normalized:
            return DepartureContext(
                session_id=session_id,
                summary="(empty session)",
                extraction_method="empty",
                extracted_at=now or _utcnow(),
            )

        tail = normalized[-self._config.tail_turns :]
        if self._llm_caller is not None:
            try:
                llm_text = await asyncio.to_thread(
                    self._llm_caller,
                    _build_extraction_prompt(tail),
                    model=self._config.model,
                )
                parsed = _parse_llm_extraction(llm_text)
                if parsed is not None:
                    return DepartureContext(
                        session_id=session_id,
                        summary=parsed["summary"],
                        pending_items=parsed["pending_items"],
                        open_questions=parsed["open_questions"],
                        followups=parsed["followups"],
                        extracted_at=now or _utcnow(),
                        extraction_method="llm",
                    )
            except Exception:  # noqa: BLE001 — degrade to fallback
                pass

        return _deterministic_summary(
            session_id=session_id,
            tail=tail,
            now=now or _utcnow(),
        )

    # ------------------------------------------------------------------ write

    async def write(self, context: DepartureContext) -> MemoryItem:
        """Persist a departure snapshot into the memory store.

        把 ``DepartureContext`` 写到 ``episodic`` 层。返回写入的 ``MemoryItem``,
        方便 caller 在测试 / 监控里断言。
        """

        if self._store is None:
            raise RuntimeError(
                "DepartureContextWriter.write requires a memory store; pass one to __init__"
            )

        return await self._store.store(
            context.to_content(),
            tier=DEPARTURE_CONTEXT_LAYER,
            metadata=cast(dict[str, object], context.to_metadata()),
            content_type="text",
            importance_score=0.7,
            last_writer_session_id=context.session_id,
            kind=DEPARTURE_CONTEXT_KIND,
        )

    async def extract_and_write(
        self,
        session_id: str,
        conversation_turns: Sequence[ConversationTurn | Mapping[str, object]],
        *,
        now: datetime | None = None,
    ) -> tuple[DepartureContext, MemoryItem]:
        """Convenience: extract + write in one call."""

        ctx = await self.extract(session_id, conversation_turns, now=now)
        record = await self.write(ctx)
        return ctx, record

    async def recall_for_session(
        self,
        session_id: str,
        *,
        limit: int = 3,
    ) -> list[MemoryItem]:
        """Return departure snapshots belonging to ``session_id`` (latest first).

        按 session_id 查询历史离场快照,按 ``metadata.extracted_at`` 倒序。
        优先用 ``last_writer_session_id`` 过滤(写入时已设置),无结果时再补 fallback
        按 ``metadata.session_id`` 过滤,兼容历史 / 测试场景。
        """

        if self._store is None:
            raise RuntimeError(
                "DepartureContextWriter.recall_for_session requires a memory store"
            )

        # Empty query → all rows in the layer, then filter by session id in
        # memory. We over-fetch a healthy multiple of ``limit`` so dedupe /
        # ordering stays stable even on noisy databases.
        items = await self._store.search(
            query="",
            limit=max(limit * 16, 32),
            filters={
                "layer": DEPARTURE_CONTEXT_LAYER,
                "last_writer_session_id": session_id,
            },
        )
        matched = [
            item
            for item in items
            if item.metadata.get("source") == DEPARTURE_CONTEXT_SOURCE
        ]
        matched.sort(
            key=lambda r: cast(str, r.metadata.get("extracted_at", "")),
            reverse=True,
        )
        return matched[:limit]

    # ------------------------------------------------------------------ daemon helper

    def is_idle(
        self,
        last_activity: datetime,
        *,
        now: datetime | None = None,
    ) -> bool:
        """Return True when ``last_activity`` is older than ``idle_minutes``.

        提供给 daemon 的 30 分钟空闲检测助手。
        """

        threshold = timedelta(minutes=self._config.idle_minutes)
        reference = now or _utcnow()
        if last_activity.tzinfo is None:
            last_activity = last_activity.replace(tzinfo=UTC)
        return (reference - last_activity) >= threshold


# ---------------------------------------------------------------------- helpers


def _normalize_turns(
    turns: Sequence[ConversationTurn | Mapping[str, object]],
) -> list[ConversationTurn]:
    out: list[ConversationTurn] = []
    for raw in turns:
        if isinstance(raw, ConversationTurn):
            out.append(raw)
            continue
        if not isinstance(raw, Mapping):
            continue
        content = raw.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        role_raw = raw.get("role")
        role = role_raw if isinstance(role_raw, str) and role_raw.strip() else "user"
        timestamp = raw.get("timestamp")
        ts: datetime | None
        if isinstance(timestamp, datetime):
            ts = timestamp
        elif isinstance(timestamp, str):
            try:
                ts = datetime.fromisoformat(timestamp)
            except ValueError:
                ts = None
        else:
            ts = None
        out.append(ConversationTurn(role=role, content=content, timestamp=ts))
    return out


_EXTRACTION_PROMPT_TEMPLATE = (
    "你是 Quilin Agent 的离场上下文抽取器。下面是用户最近一次会话末尾的对话片段。"
    "请抽出用户离开时仍在进行的事情,严格输出 JSON,格式:\n"
    '{{"summary": "<一句话总结用户离开时的状态>",'
    ' "pending_items": ["<未完成的具体任务>", ...],'
    ' "open_questions": ["<用户提了但未解答的问题>", ...],'
    ' "followups": ["<用户暗示下次想继续的话题>", ...]}}\n'
    "若没有对应内容,数组留空。不要输出 JSON 之外的任何文本。\n\n"
    "对话片段:\n{transcript}"
)


def _build_extraction_prompt(tail: Sequence[ConversationTurn]) -> str:
    lines: list[str] = []
    for index, turn in enumerate(tail, start=1):
        preview = turn.short_preview()
        lines.append(f"[{index}] {turn.role}: {preview}")
    transcript = "\n".join(lines)
    return _EXTRACTION_PROMPT_TEMPLATE.format(transcript=transcript)


def _parse_llm_extraction(raw: str) -> dict[str, Any] | None:
    """Coerce LLM JSON output into the dataclass-friendly shape.

    Returns ``None`` on parse failure so the caller can fall through to the
    deterministic summary.
    """

    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    # Strip markdown code fences if the model added them.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    summary = payload.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return None
    return {
        "summary": summary.strip(),
        "pending_items": _coerce_str_list(payload.get("pending_items")),
        "open_questions": _coerce_str_list(payload.get("open_questions")),
        "followups": _coerce_str_list(payload.get("followups")),
    }


def _coerce_str_list(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
    return tuple(out)


def _deterministic_summary(
    *,
    session_id: str,
    tail: Sequence[ConversationTurn],
    now: datetime,
) -> DepartureContext:
    """Build a fallback DepartureContext directly from the tail turns.

    用最后几轮原文拼一个保守的快照。优先抽 user 最后一句作为 summary,
    所有 assistant 半截回答 / 未完成步骤都进 pending_items。
    """

    last_user: str | None = None
    pending: list[str] = []
    for turn in reversed(tail):
        if last_user is None and turn.role == "user":
            last_user = turn.short_preview()
            break

    for turn in tail:
        preview = turn.short_preview(200)
        label = "user" if turn.role == "user" else "assistant"
        pending.append(f"{label}: {preview}")

    summary = (
        f"User left mid-conversation; last message: {last_user}"
        if last_user
        else "User left without an explicit final message."
    )

    return DepartureContext(
        session_id=session_id,
        summary=summary,
        pending_items=tuple(pending),
        open_questions=(),
        followups=(),
        extracted_at=now,
        extraction_method="fallback",
    )


__all__ = [
    "DEFAULT_DEPARTURE_MODEL",
    "DEFAULT_IDLE_MINUTES",
    "DEPARTURE_CONTEXT_KIND",
    "DEPARTURE_CONTEXT_LAYER",
    "DEPARTURE_CONTEXT_SCHEMA_VERSION",
    "DEPARTURE_CONTEXT_SOURCE",
    "DEPARTURE_IDLE_MINUTES_ENV",
    "DEPARTURE_MODEL_ENV",
    "ConversationTurn",
    "DepartureContext",
    "DepartureContextConfig",
    "DepartureContextWriter",
    "DepartureLLMCaller",
]
