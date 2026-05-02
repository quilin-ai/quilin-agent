from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from .event_log import TraceContext, parse_traceparent
from .logging import configure_once, logger
from .retrieval_profile import RetrievalProfileStore
from .retriever import MemoryRetriever
from .scratchpad import ScratchpadStore
from .store import OmniMemStore
from .types import MemoryLayer, MemoryTier

MAX_RECALL_QUERY_LENGTH = 512
MAX_TOOL_METADATA_DEPTH = 4
MAX_TOOL_METADATA_ITEMS = 32
MAX_TOOL_METADATA_STRING_LENGTH = 512
MAX_TOOL_METADATA_BYTES = 4 * 1024
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


async def _memory_recall_with_store(
    store: OmniMemStore,
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
    store: OmniMemStore,
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
    validated_metadata = _validate_tool_metadata(metadata)
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


def _get_store_from_context(ctx: Context[object, Any, object] | None) -> OmniMemStore | None:
    if ctx is None or getattr(ctx, "_request_context", None) is None:
        return None

    lifespan_context = ctx.request_context.lifespan_context
    if not isinstance(lifespan_context, dict):
        return None

    store = lifespan_context.get("store")
    return store if isinstance(store, OmniMemStore) else None


def _build_store_lifespan(
    store: OmniMemStore | None,
):
    @asynccontextmanager
    async def lifespan(_app: FastMCP):
        if store is not None:
            yield {"store": store}
            return

        lifespan_store = await asyncio.to_thread(OmniMemStore)
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
    async with OmniMemStore() as store:
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
    async with OmniMemStore() as store:
        return await _memory_store_with_store(
            store,
            content,
            tier,
            layer,
            metadata,
            content_type,
        )


def create_server(
    store: OmniMemStore | None = None,
    scratchpad_store: ScratchpadStore | None = None,
) -> FastMCP:
    server_store: OmniMemStore | None = store
    server_scratchpad_store: ScratchpadStore | None = scratchpad_store
    server = FastMCP("omnimem", lifespan=_build_store_lifespan(store))

    async def resolve_store(
        ctx: Context[object, Any, object] | None = None,
    ) -> OmniMemStore:
        context_store = _get_store_from_context(ctx)
        if context_store is not None:
            return context_store

        nonlocal server_store
        if server_store is None:
            server_store = OmniMemStore()

        return server_store

    async def resolve_scratchpad_store() -> ScratchpadStore:
        nonlocal server_scratchpad_store
        if server_scratchpad_store is None:
            server_scratchpad_store = ScratchpadStore()

        return server_scratchpad_store

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

    return server


mcp = create_server()


def main() -> None:
    configure_once()
    logger.info("omnimem server starting", transport="stdio")
    mcp.run(transport="stdio")
