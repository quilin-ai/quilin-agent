from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from .consolidation_log import ConsolidationLogStore
from .consolidator import ConsolidationStrategy, Consolidator
from .event_log import TraceContext, parse_traceparent
from .kg import TemporalKnowledgeGraph
from .kg_backfill import backfill_kg_from_memory
from .logging import configure_once, logger
from .observer import (
    L3aObserver,
    ObservationTurnInput,
    ObserverConfig,
    _candidate_to_dict,
    observe_safely,
)
from .profile_store import ProfileStore
from .profile_updater import ProfileUpdater
from .retrieval_profile import RetrievalProfileStore
from .retriever import MemoryRetriever
from .scratchpad import ScratchpadStore
from .store import QuilinMemStore
from .types import MemoryLayer, MemoryTier

MAX_RECALL_QUERY_LENGTH = 512
MAX_TOOL_METADATA_DEPTH = 4
MAX_TOOL_METADATA_ITEMS = 32
MAX_TOOL_METADATA_STRING_LENGTH = 512
MAX_TOOL_METADATA_BYTES = 4 * 1024
MAX_OBSERVE_TEXT_LENGTH = 32 * 1024  # cap per-text field at 32KB
DEFAULT_OBSERVER_FREQUENCY = 10
DEFAULT_OBSERVER_BASE_URL = "https://api.deepseek.com/v1/chat/completions"
DEFAULT_OBSERVER_MODEL = "deepseek-v4-flash"
# Cap on the per-server (user_id, session_id) → L3aObserver cache so that a
# misbehaving caller (e.g. random session ids) cannot make the server leak
# memory unboundedly. Eviction is LRU via OrderedDict.move_to_end + popitem.
#
# 缓存 (user_id, session_id) → L3aObserver 的上限，防止调用方滥用（例如
# 每次都传随机 session id）导致内存无界增长。基于 OrderedDict 的 LRU。
MAX_OBSERVER_SESSIONS = 256
ALLOWED_TOOL_METADATA_KEYS = frozenset(
    {
        "block_version",
        "blocked_reason",
        "budget_decision",
        "cache_key",
        "event_seq",
        "graph_distance",
        "layer",
        "memory_source",
        "origin_layer",
        "phase",
        "reranker_rank",
        "reranker_score",
        "retrieval_score",
        "run_id",
        "schema_version",
        "score",
        "session_id",
        "source",
        "source_excerpt",
        "source_layers",
        "source_turn_id",
        "stability_reason",
        "staleness",
        "supporting_turns",
        "task_hash",
        "trace_id",
        "turn_id",
        "user_id",
        "valid_from",
        "valid_to",
        "evidence",
        "evidence_ids",
        "evidence_refs",
        "citations",
    }
)


class MemoryOperationError(RuntimeError):
    """Sanitized tool error exposed over MCP."""


def _raise_memory_operation_error(operation: str, exc: Exception) -> None:
    logger.error(f"{operation} failed", error=str(exc))
    raise MemoryOperationError(f"{operation} failed") from exc


def _validate_memory_recall_query(query: str) -> None:
    if len(query) > MAX_RECALL_QUERY_LENGTH:
        raise ValueError(
            f"memory_recall query must be at most {MAX_RECALL_QUERY_LENGTH} characters"
        )


def _validate_metadata_value(value: object, *, depth: int) -> None:
    if depth > MAX_TOOL_METADATA_DEPTH:
        raise ValueError(
            f"memory_store metadata nesting must be at most {MAX_TOOL_METADATA_DEPTH} levels"
        )

    if value is None or isinstance(value, bool | int | float):
        return

    if isinstance(value, str):
        if len(value) > MAX_TOOL_METADATA_STRING_LENGTH:
            raise ValueError(
                "memory_store metadata string values must be at most "
                f"{MAX_TOOL_METADATA_STRING_LENGTH} characters"
            )
        return

    if isinstance(value, list):
        if len(value) > MAX_TOOL_METADATA_ITEMS:
            raise ValueError(
                f"memory_store metadata lists must contain at most {MAX_TOOL_METADATA_ITEMS} items"
            )
        for item in value:
            _validate_metadata_value(item, depth=depth + 1)
        return

    if isinstance(value, dict):
        if len(value) > MAX_TOOL_METADATA_ITEMS:
            raise ValueError(
                f"memory_store metadata objects must contain at most {MAX_TOOL_METADATA_ITEMS} keys"
            )
        for nested_key, nested_value in value.items():
            if not isinstance(nested_key, str) or not nested_key:
                raise ValueError("memory_store metadata keys must be non-empty strings")
            _validate_metadata_value(nested_value, depth=depth + 1)
        return

    raise ValueError("memory_store metadata values must be JSON-serializable scalars")


def _validate_tool_metadata(metadata: dict[str, object] | None) -> dict[str, object] | None:
    if metadata is None:
        return None

    normalized = dict(metadata)
    unexpected_keys = sorted(key for key in normalized if key not in ALLOWED_TOOL_METADATA_KEYS)
    if unexpected_keys:
        raise ValueError("memory_store metadata keys not allowed: " + ", ".join(unexpected_keys))

    _validate_metadata_value(normalized, depth=1)
    encoded = json.dumps(normalized, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_TOOL_METADATA_BYTES:
        raise ValueError(f"memory_store metadata must be at most {MAX_TOOL_METADATA_BYTES} bytes")

    return normalized


def _is_blank_string(value: object) -> bool:
    return not isinstance(value, str) or not value.strip()


def _tool_metadata_with_defaults(
    tier: MemoryTier,
    layer: MemoryLayer | None,
    metadata: dict[str, object] | None,
) -> dict[str, object] | None:
    resolved_layer = layer or tier
    if resolved_layer != "semantic":
        return metadata

    normalized = dict(metadata or {})
    normalized.setdefault("schema_version", 1)
    if _is_blank_string(normalized.get("source")):
        normalized["source"] = "memory_store_tool"
    if _is_blank_string(normalized.get("stability_reason")):
        normalized["stability_reason"] = "caller_selected_semantic_tier"

    return normalized


async def _memory_recall_with_store(
    store: QuilinMemStore,
    query: str,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    retrieval_profile_store: RetrievalProfileStore | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    """Recall memory records matching a query string (substring, case-insensitive).

    Returns all records if query is empty.
    """
    _validate_memory_recall_query(query)
    try:
        raw_results = await store.recall(query)
    except Exception as exc:
        _raise_memory_operation_error("memory_recall", exc)

    task_context: dict[str, object] = {}
    if user_id is not None and user_id.strip():
        task_context["user_id"] = user_id.strip()
    if session_id is not None and session_id.strip():
        task_context["session_id"] = session_id.strip()
    task_context_or_none = task_context or None
    context_filters = MemoryRetriever._filters_from_task_context(task_context_or_none)
    if context_filters is not None:
        metadata_filters = context_filters.get("metadata")
        if isinstance(metadata_filters, dict):
            raw_results = [
                item
                for item in raw_results
                if all(item.metadata.get(key) == value for key, value in metadata_filters.items())
            ]

    retriever = MemoryRetriever(
        store,
        retrieval_profiles=store.retrieval_profiles,
    )
    results = retriever.annotate_recall_results(
        query,
        raw_results,
        task_context_or_none,
        limit=len(raw_results),
    )
    if user_id is not None and user_id.strip():
        try:
            profile_store = retrieval_profile_store or store.retrieval_profiles
            results = profile_store.get(user_id.strip()).apply_to(results)
        except Exception as exc:
            _raise_memory_operation_error("memory_recall", exc)

    payload: dict[str, object] = {"records": [r.to_wire_dict() for r in results]}
    if trace_context is not None:
        payload["traceparent"] = trace_context.traceparent

    return json.dumps(payload)


def _request_meta_to_dict(ctx: Context[object, Any, object] | None) -> dict[str, object]:
    if ctx is None or getattr(ctx, "_request_context", None) is None:
        return {}

    meta = ctx.request_context.meta
    if meta is None:
        return {}

    if hasattr(meta, "model_dump"):
        return {key: value for key, value in meta.model_dump().items() if value is not None}

    if isinstance(meta, dict):
        return dict(meta)

    return {}


def _trace_context_from_context(
    ctx: Context[object, Any, object] | None,
) -> TraceContext | None:
    meta = _request_meta_to_dict(ctx)
    traceparent = meta.get("traceparent")
    request_id = meta.get("request_id")
    if not isinstance(traceparent, str):
        return None

    return parse_traceparent(
        traceparent,
        request_id=request_id if isinstance(request_id, str) else None,
    )


def _child_trace_context(parent: TraceContext | None) -> TraceContext | None:
    if parent is None:
        return None

    return TraceContext(
        trace_id=parent.trace_id,
        span_id=secrets.token_hex(8),
        request_id=parent.request_id,
        trace_flags=parent.trace_flags,
    )


async def _memory_store_with_store(
    store: QuilinMemStore,
    content: str,
    tier: MemoryTier = "working",
    layer: MemoryLayer | None = None,
    metadata: dict[str, object] | None = None,
    content_type: str = "text",
    trace_context: TraceContext | None = None,
) -> str:
    """Store a new memory record.

    Args:
        content: The text content to store.
        tier: Memory tier (default "working").
    """
    metadata_with_defaults = _tool_metadata_with_defaults(tier, layer, metadata)
    validated_metadata = _validate_tool_metadata(metadata_with_defaults)
    try:
        if layer is None:
            record = await store.store(
                content,
                tier=tier,
                metadata=validated_metadata,
                content_type=content_type,
            )
        else:
            record = await store.store(
                content,
                tier=tier,
                layer=layer,
                metadata=validated_metadata,
                content_type=content_type,
            )
    except Exception as exc:
        _raise_memory_operation_error("memory_store", exc)

    return json.dumps({"id": record.id, **_trace_payload(trace_context)})


async def _memory_consolidate_plan_with_store(
    store: QuilinMemStore,
    *,
    strategy: ConsolidationStrategy = "all",
    tier: MemoryTier | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    """Run user-triggered consolidation preview.

    QUI-187 Reviewer F follow-up (2026-05-20):用户在 web 手动点"智能整理"是
    explicit user-triggered preview,**不是 idle-time reflection**。默认
    IdleBudgetProvider(enabled=False)让所有 expensive soft dedupe 永远 denied,
    9 条明显语义重复的记忆"0 条整理"是 user-facing bug。

    user-triggered preview 不该被 idle_budget gate(idle_budget 设计是给后台周期性
    reflection 用的,见 docs/03-memory line 269-275)。这里注入 enabled=True +
    充足 token budget,允许 dedupe 完整跑(embedding + LLM judge)。
    实际写入(execute=True 路径)仍走 WriteAuthority gate。
    """
    from .consolidator import _DeepseekConsolidationJudge
    from .idle_budget import IdleBudgetProvider as _IdleBudgetProvider

    budget_provider = _IdleBudgetProvider(enabled=True, token_budget=1_000_000)
    # 注入 LLM judge(deepseek-v4-flash 便宜模型),识别"老孟→孟哥/小明→小花"
    # 这类 entity 演化(hash embedding 无法识别)。无 API key 时 judge 自动
    # fallback "distinct",dedupe 退化为 exact-only。
    dedupe_judge = _DeepseekConsolidationJudge().judge
    try:
        proposal = Consolidator(
            budget_provider=budget_provider,
            store=store,
            dedupe_judge=dedupe_judge,
        ).propose(
            strategy=strategy,
            tier=tier,
            task="quilin_mem.memory_consolidate_plan",
            estimated_tokens=1024,
        )
    except Exception as exc:
        _raise_memory_operation_error("memory_consolidate_plan", exc)

    return json.dumps({**proposal.to_wire_dict(), **_trace_payload(trace_context)})


def _trace_payload(trace_context: TraceContext | None) -> dict[str, str]:
    if trace_context is None:
        return {}

    return {"traceparent": trace_context.traceparent}


async def _scratchpad_write_with_store(
    scratchpad_store: ScratchpadStore,
    *,
    task_id: str,
    session_id: str,
    key: str,
    value: str,
    ttl_sec: int | None = None,
    capacity_per_task: int | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    try:
        await scratchpad_store.write(
            task_id=task_id,
            session_id=session_id,
            key=key,
            value=value,
            ttl_sec=ttl_sec,
            capacity_per_task=capacity_per_task,
        )
    except Exception as exc:
        _raise_memory_operation_error("scratchpad_write", exc)

    return json.dumps({"ok": True, **_trace_payload(trace_context)})


async def _scratchpad_read_with_store(
    scratchpad_store: ScratchpadStore,
    *,
    task_id: str,
    session_id: str,
    key: str,
    trace_context: TraceContext | None = None,
) -> str:
    try:
        value = await scratchpad_store.read(
            task_id=task_id,
            session_id=session_id,
            key=key,
        )
    except Exception as exc:
        _raise_memory_operation_error("scratchpad_read", exc)

    return json.dumps({"value": value, **_trace_payload(trace_context)})


def _build_observer_config_from_env() -> ObserverConfig:
    """Build ObserverConfig from environment variables.

    Defaults match observer.py's ObserverConfig:
        model = QUILIN_OBSERVER_MODEL or deepseek-v4-flash
        api_key = QUILIN_OBSERVER_API_KEY (preferred) or DEEPSEEK_API_KEY
        frequency = QUILIN_OBSERVER_FREQUENCY (>=1) or 10
        base_url = QUILIN_OBSERVER_BASE_URL or DeepSeek chat completions URL

    API keys must come from env only — never from MCP arguments.
    """
    model = os.environ.get("QUILIN_OBSERVER_MODEL", DEFAULT_OBSERVER_MODEL)
    # QUILIN_OBSERVER_API_KEY takes precedence; fall back to DEEPSEEK_API_KEY
    # to align with the existing ObserverConfig default factory.
    api_key = os.environ.get("QUILIN_OBSERVER_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or ""
    base_url = os.environ.get("QUILIN_OBSERVER_BASE_URL", DEFAULT_OBSERVER_BASE_URL)
    raw_frequency = os.environ.get("QUILIN_OBSERVER_FREQUENCY")
    frequency = DEFAULT_OBSERVER_FREQUENCY
    if raw_frequency is not None and raw_frequency.strip():
        try:
            parsed = int(raw_frequency)
            if parsed >= 1:
                frequency = parsed
        except ValueError:
            # Invalid env value — fall back to default rather than crash.
            logger.warning(
                "memory_observe ignoring invalid QUILIN_OBSERVER_FREQUENCY",
                value=raw_frequency,
            )

    return ObserverConfig(
        model=model,
        api_key=api_key,
        frequency=frequency,
        base_url=base_url,
    )


def _validate_observe_text(text: str, field: str) -> str:
    """Cap per-text field length at MAX_OBSERVE_TEXT_LENGTH bytes."""
    if not isinstance(text, str):
        raise ValueError(f"memory_observe {field} must be a string")
    if len(text) > MAX_OBSERVE_TEXT_LENGTH:
        raise ValueError(
            f"memory_observe {field} must be at most {MAX_OBSERVE_TEXT_LENGTH} characters"
        )
    return text


def _build_observer_session_key(
    user_id: str | None,
    session_id: str | None,
) -> str:
    """Compose the cache key for the per-session observer instance.

    None values normalize to literal "_" so we still produce a stable key.
    """
    safe_user = (user_id or "").strip() or "_"
    safe_session = (session_id or "").strip() or "_"
    return f"{safe_user}|{safe_session}"


async def _memory_observe_with_observer(
    observer: L3aObserver,
    *,
    user_text: str,
    assistant_text: str,
    user_id: str | None,
    session_id: str | None,
    metadata: dict[str, object] | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    """Run the observer over a single (user, assistant) turn pair.

    Both texts are concatenated into one ObservationTurn with role=user
    (a single turn captures the full exchange). On candidate yield this
    returns wire-format JSON `{"candidates": [...]}`.
    Errors are sanitized via MemoryOperationError.
    """
    try:
        safe_user_text = _validate_observe_text(user_text, "user_text")
        safe_assistant_text = _validate_observe_text(assistant_text, "assistant_text")
    except ValueError as exc:
        _raise_memory_operation_error("memory_observe", exc)

    combined_content_parts: list[str] = []
    if safe_user_text.strip():
        combined_content_parts.append(f"[user]: {safe_user_text.strip()}")
    if safe_assistant_text.strip():
        combined_content_parts.append(f"[assistant]: {safe_assistant_text.strip()}")
    combined_content = "\n".join(combined_content_parts) or "(empty turn)"

    turn_input: ObservationTurnInput = {
        "content": combined_content,
        "role": "user",
        **({"user_id": user_id} if user_id and user_id.strip() else {}),
        **({"session_id": session_id} if session_id and session_id.strip() else {}),
        **({"metadata": metadata} if metadata else {}),
    }

    try:
        candidates = await observe_safely(observer, turn_input)
    except Exception as exc:
        _raise_memory_operation_error("memory_observe", exc)

    payload: dict[str, object] = {
        "candidates": [_candidate_to_dict(candidate) for candidate in candidates],
    }
    if trace_context is not None:
        payload["traceparent"] = trace_context.traceparent

    return json.dumps(payload)


async def _scratchpad_clear_with_store(
    scratchpad_store: ScratchpadStore,
    *,
    task_id: str,
    session_id: str,
    key: str | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    try:
        cleared = await scratchpad_store.clear(
            task_id=task_id,
            session_id=session_id,
            key=key,
        )
    except Exception as exc:
        _raise_memory_operation_error("scratchpad_clear", exc)

    return json.dumps({"cleared": cleared, **_trace_payload(trace_context)})


def _get_store_from_context(ctx: Context[object, Any, object] | None) -> QuilinMemStore | None:
    if ctx is None or getattr(ctx, "_request_context", None) is None:
        return None

    lifespan_context = ctx.request_context.lifespan_context
    if not isinstance(lifespan_context, dict):
        return None

    store = lifespan_context.get("store")
    return store if isinstance(store, QuilinMemStore) else None


def _build_store_lifespan(
    store: QuilinMemStore | None,
):
    @asynccontextmanager
    async def lifespan(_app: FastMCP):
        if store is not None:
            yield {"store": store}
            return

        lifespan_store = await asyncio.to_thread(QuilinMemStore)
        try:
            yield {"store": lifespan_store}
        finally:
            await lifespan_store.close()

    return lifespan


async def memory_recall(
    query: str,
    user_id: str | None = None,
    session_id: str | None = None,
) -> str:
    """Legacy direct helper that opens a store per call."""
    async with QuilinMemStore() as store:
        return await _memory_recall_with_store(
            store,
            query,
            user_id=user_id,
            session_id=session_id,
        )


async def memory_store(
    content: str,
    tier: MemoryTier = "working",
    *,
    layer: MemoryLayer | None = None,
    metadata: dict[str, object] | None = None,
    content_type: str = "text",
) -> str:
    """Legacy direct helper that opens a store per call."""
    async with QuilinMemStore() as store:
        return await _memory_store_with_store(
            store,
            content,
            tier,
            layer,
            metadata,
            content_type,
        )


def create_server(
    store: QuilinMemStore | None = None,
    scratchpad_store: ScratchpadStore | None = None,
    *,
    observer_factory: object | None = None,
    profile_updater_factory: object | None = None,
) -> FastMCP:
    """Build the quilin-mem MCP server.

    Optional injection points:
        observer_factory: zero-arg callable returning ``L3aObserver``;
            defaults to constructing one from env-derived ``ObserverConfig``.
            Used by tests to inject deterministic LLM stubs without env vars.
        profile_updater_factory: zero-arg callable returning ``ProfileUpdater``
            or ``None``. Defaults to lazy ``ProfileStore`` per server.

    L3a observer instances are cached per ``(user_id, session_id)`` so a
    long-running session accumulates buffer state across ``memory_observe``
    calls.
    """
    server_store: QuilinMemStore | None = store
    server_scratchpad_store: ScratchpadStore | None = scratchpad_store
    observer_sessions: OrderedDict[str, L3aObserver] = OrderedDict()
    server_profile_updater: ProfileUpdater | None = None
    server = FastMCP("quilin-mem", lifespan=_build_store_lifespan(store))

    async def resolve_store(
        ctx: Context[object, Any, object] | None = None,
    ) -> QuilinMemStore:
        context_store = _get_store_from_context(ctx)
        if context_store is not None:
            return context_store

        nonlocal server_store
        if server_store is None:
            server_store = QuilinMemStore()

        return server_store

    async def resolve_scratchpad_store() -> ScratchpadStore:
        nonlocal server_scratchpad_store
        if server_scratchpad_store is None:
            server_scratchpad_store = ScratchpadStore()

        return server_scratchpad_store

    def resolve_profile_updater() -> ProfileUpdater | None:
        """Lazily construct a ProfileUpdater for L3a profile sync.

        Returns None if the factory yields None or raises (best-effort).
        Without a profile updater, observer.observe() still runs but high-
        confidence findings are not mirrored to ~/.quilin/user.md.
        """
        nonlocal server_profile_updater
        if server_profile_updater is not None:
            return server_profile_updater

        if profile_updater_factory is not None:
            try:
                candidate = profile_updater_factory()  # type: ignore[misc]
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "memory_observe profile_updater_factory failed",
                    error=str(exc),
                )
                return None

            if candidate is None:
                return None

            if not isinstance(candidate, ProfileUpdater):
                logger.warning(
                    "memory_observe profile_updater_factory returned wrong type",
                    type=type(candidate).__name__,
                )
                return None

            server_profile_updater = candidate
            return server_profile_updater

        try:
            store_instance = ProfileStore()
            server_profile_updater = ProfileUpdater(store_instance)
            return server_profile_updater
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "memory_observe profile_updater bootstrap failed",
                error=str(exc),
            )
            return None

    def _store_observer(key: str, observer: L3aObserver) -> None:
        """Insert or refresh an observer entry with LRU eviction.

        Adding a new entry past ``MAX_OBSERVER_SESSIONS`` evicts the oldest
        (least recently used) entry. Existing entries are moved to the end
        (most recently used) to refresh their LRU position.

        新增条目超过 ``MAX_OBSERVER_SESSIONS`` 时驱逐最久未用的条目；
        已存在的条目移到末尾以刷新 LRU 位置。
        """
        if key in observer_sessions:
            observer_sessions.move_to_end(key)
            observer_sessions[key] = observer
            return
        observer_sessions[key] = observer
        while len(observer_sessions) > MAX_OBSERVER_SESSIONS:
            observer_sessions.popitem(last=False)

    def resolve_observer(
        user_id: str | None,
        session_id: str | None,
    ) -> L3aObserver:
        """Get-or-create the per-session L3aObserver instance.

        We key on (user_id, session_id) so observer turn buffers grow
        across multiple memory_observe calls for the same session.
        Cache is bounded at ``MAX_OBSERVER_SESSIONS`` with LRU eviction.
        """
        key = _build_observer_session_key(user_id, session_id)
        cached = observer_sessions.get(key)
        if cached is not None:
            # Refresh LRU position so frequently-used sessions survive.
            observer_sessions.move_to_end(key)
            return cached

        if observer_factory is not None:
            try:
                created = observer_factory()  # type: ignore[misc]
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "memory_observe observer_factory failed; using env defaults",
                    error=str(exc),
                )
                created = None

            if isinstance(created, L3aObserver):
                _store_observer(key, created)
                return created

        config = _build_observer_config_from_env()
        # Wire profile updater only if api_key configured (matches observer
        # behavior: no api_key → no LLM trigger → no profile mirror).
        profile_updater = resolve_profile_updater() if config.api_key else None
        observer = L3aObserver(config, profile_updater=profile_updater)
        _store_observer(key, observer)
        return observer

    @server.tool(name="memory_recall")
    async def memory_recall_tool(
        query: str,
        user_id: str | None = None,
        session_id: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Recall memory records matching a query string (substring, case-insensitive).

        Returns all records if query is empty.
        """
        parent_trace = _trace_context_from_context(ctx)
        return await _memory_recall_with_store(
            await resolve_store(ctx),
            query,
            user_id=user_id,
            session_id=session_id,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="memory_store")
    async def memory_store_tool(
        content: str,
        tier: MemoryTier = "working",
        layer: MemoryLayer | None = None,
        metadata: dict[str, object] | None = None,
        content_type: str = "text",
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Store a new memory record.

        Args:
            content: The text content to store.
            tier: Memory tier (default "working").
            layer: Canonical memory layer. Takes precedence over tier.
        """
        parent_trace = _trace_context_from_context(ctx)
        return await _memory_store_with_store(
            await resolve_store(ctx),
            content,
            tier,
            layer,
            metadata,
            content_type,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="memory_delete")
    async def memory_delete_tool(
        memory_id: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Soft-delete one memory record by id.

        Use this when the agent recognizes duplicate or stale memory
        records and wants to clean them up. The record is marked
        `deleted=1` in SQLite and removed from the FTS index so future
        `memory_recall` calls won't surface it; the row itself is
        retained for audit. Idempotent: deleting an already-deleted
        or non-existent id is a no-op (returns ok=true with deleted=false).

        Args:
            memory_id: Record id returned by `memory_store` or surfaced
                by `memory_recall`.

        Returns:
            JSON string `{"ok": true, "memory_id": <id>}`.
        """
        del ctx  # not used
        store = await resolve_store(ctx=None)
        await store.delete(memory_id)
        return json.dumps({"ok": True, "memory_id": memory_id})

    @server.tool(name="memory_consolidate_plan")
    async def memory_consolidate_plan_tool(
        strategy: ConsolidationStrategy = "all",
        tier: MemoryTier | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Preview memory consolidation proposals without mutating storage.

        Strategies: ``dedupe`` groups duplicate records, ``reflect``
        proposes semantic insights from episodic memory, ``kg-prune``
        previews stale temporal edge cleanup, and ``all`` combines them.
        It returns a preview only; callers must confirm and execute writes
        through WriteAuthority-gated tools.
        """
        parent_trace = _trace_context_from_context(ctx)
        return await _memory_consolidate_plan_with_store(
            await resolve_store(ctx),
            strategy=strategy,
            tier=tier,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="scratchpad_write")
    async def scratchpad_write_tool(
        task_id: str,
        session_id: str,
        key: str,
        value: str,
        ttl_sec: int | None = None,
        capacity_per_task: int | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Write a task-scoped scratchpad value."""
        parent_trace = _trace_context_from_context(ctx)
        return await _scratchpad_write_with_store(
            await resolve_scratchpad_store(),
            task_id=task_id,
            session_id=session_id,
            key=key,
            value=value,
            ttl_sec=ttl_sec,
            capacity_per_task=capacity_per_task,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="scratchpad_read")
    async def scratchpad_read_tool(
        task_id: str,
        session_id: str,
        key: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Read a task-scoped scratchpad value."""
        parent_trace = _trace_context_from_context(ctx)
        return await _scratchpad_read_with_store(
            await resolve_scratchpad_store(),
            task_id=task_id,
            session_id=session_id,
            key=key,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="memory_observe")
    async def memory_observe_tool(
        user_text: str,
        assistant_text: str,
        user_id: str | None = None,
        session_id: str | None = None,
        metadata: dict[str, object] | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Observe a single agent turn and return profile-worthy candidates.

        L3a observer instances are cached per (user_id, session_id), so
        consecutive calls for the same session accumulate buffer state.

        Args:
            user_text: The user message text for this turn.
            assistant_text: The assistant response text for this turn.
            user_id: Optional user identifier (used to scope observer).
            session_id: Optional session identifier (used to scope observer).
            metadata: Optional turn metadata propagated to ObservationTurn.

        Returns:
            JSON string ``{"candidates": [...]}`` (deterministic + optional L3a).
        """
        parent_trace = _trace_context_from_context(ctx)
        observer = resolve_observer(user_id, session_id)
        return await _memory_observe_with_observer(
            observer,
            user_text=user_text,
            assistant_text=assistant_text,
            user_id=user_id,
            session_id=session_id,
            metadata=metadata,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="scratchpad_clear")
    async def scratchpad_clear_tool(
        task_id: str,
        session_id: str,
        key: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Clear one scratchpad key, or all keys for a task/session."""
        parent_trace = _trace_context_from_context(ctx)
        return await _scratchpad_clear_with_store(
            await resolve_scratchpad_store(),
            task_id=task_id,
            session_id=session_id,
            key=key,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="consolidation_log_recent")
    async def consolidation_log_recent_tool(
        limit: int = 100,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Return the N most-recent consolidation proposals as JSON.

        UX-4 Slice 4 backend. Reads from `ConsolidationLogStore` (which the
        `Consolidator` writes to on every `propose()`). Used by the
        /memory page consolidation timeline tab.

        Returns JSON: `{available: bool, total: int, entries: [...]}`.
        Each entry: `{id, task, dry_run, budget_decision, actions[],
        writes_performed, created_at, schema_version}`. `actions[]` is
        the JSON-decoded list of action dicts originally produced by
        the Consolidator.

        Args:
            limit: How many entries (clamped to [1, 1000]). Default 100.

        Returns:
            JSON string suitable for `JSON.parse` on the TS side.
        """
        del ctx  # unused
        with ConsolidationLogStore() as store:
            entries = store.list_recent(limit=limit)
            total = store.count()
        return json.dumps(
            {
                "available": True,
                "total": total,
                "entries": [
                    {
                        "id": e.id,
                        "task": e.task,
                        "dry_run": e.dry_run,
                        "budget_decision": e.budget_decision,
                        "actions": e.actions,
                        "writes_performed": e.writes_performed,
                        "created_at": e.created_at.isoformat(),
                        "schema_version": e.schema_version,
                    }
                    for e in entries
                ],
            }
        )

    @server.tool(name="kg_dump_for_viz")
    async def kg_dump_for_viz_tool(
        limit: int = 500,
        as_of: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Bulk-dump KG edges for /api/memory/graph visualization.

        Returns up to `limit` edges as a JSON-encoded `{nodes, edges}`
        payload sized for reactflow / cytoscape:
        - nodes:  [{id: entity, label: entity}]  (deduplicated)
        - edges:  [{id, source, target, label, valid_from, valid_to,
                    memory_id, weight}]

        UX-4 Slice 3 backend. limit clamped to [1, 2000]. `as_of`,
        if provided as ISO 8601, filters edges to those temporally
        valid at that moment.
        """
        del ctx  # not used; signature compatibility with other tools
        # Use the class's async context manager so a future maintainer who
        # adds work after `dump_edges` doesn't accidentally trip a
        # use-after-close on `kg`. The `raw_edges` list is plain Python
        # dicts so the post-processing below works either way, but
        # `async with` makes the resource scope unambiguous.
        async with TemporalKnowledgeGraph() as kg:
            raw_edges = await kg.dump_edges(limit=limit, as_of=as_of)

        # Deduplicate nodes by entity name.
        node_set: set[str] = set()
        for edge in raw_edges:
            node_set.add(str(edge["subject"]))
            node_set.add(str(edge["object"]))
        nodes = [{"id": name, "label": name} for name in sorted(node_set)]

        edges = [
            {
                "id": edge["edge_id"],
                "source": edge["subject"],
                "target": edge["object"],
                "label": edge["predicate"],
                "valid_from": edge["valid_from"],
                "valid_to": edge["valid_to"],
                "memory_id": edge["memory_id"],
                "weight": edge["weight"],
            }
            for edge in raw_edges
        ]
        return json.dumps({"nodes": nodes, "edges": edges})

    @server.tool(name="memory_backfill_kg")
    async def memory_backfill_kg_tool(
        batch_size: int = 50,
        max_records: int | None = None,
        dry_run: bool = True,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Backfill the knowledge graph from existing memory records.

        Walks `memory_records` across the working / episodic / semantic /
        skill layers, runs the LLM triple extractor on each record's
        text body, and (if `dry_run=False`) persists the resulting
        edges into the TemporalKnowledgeGraph with `memory_id` linkage.

        UX-4 Slice 2. Anti-hallucination filter (source_quote must be
        verbatim substring) + anti-injection (random per-call boundary
        token + system+user role split) run inside the extractor.

        Args:
            batch_size: Records to fetch per `list_by_layer` page
                (1-200; clamped). Default 50.
            max_records: Hard cap across all layers (1-10000; clamped).
                None means "all available, up to the hard cap".
            dry_run: When True (default), counts what would be added
                without writing to the KG. Flip to False to persist.

        Returns:
            JSON string with `{processed, edges_added, skipped, errors, dry_run}`.
        """
        store = await resolve_store(ctx)
        # Construct a per-call KG using the same DB path the store
        # writes to — `TemporalKnowledgeGraph` shares the `memory.db`
        # SQLite file with `memory_records`. Close on completion to
        # release the connection.
        kg = TemporalKnowledgeGraph()
        try:
            result = await backfill_kg_from_memory(
                store=store,
                kg=kg,
                batch_size=batch_size,
                max_records=max_records,
                dry_run=dry_run,
            )
        finally:
            await kg.close()
        return json.dumps(result.to_dict())

    return server


mcp = create_server()


def main() -> None:
    configure_once()
    logger.info("quilin-mem server starting", transport="stdio")
    mcp.run(transport="stdio")
