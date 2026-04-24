from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from .logging import logger
from .retriever import MemoryRetriever
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
        "source_layers",
        "stability_reason",
        "staleness",
        "task_hash",
        "user_id",
        "valid_from",
        "valid_to",
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
        raise ValueError(
            "memory_store metadata keys not allowed: " + ", ".join(unexpected_keys)
        )

    _validate_metadata_value(normalized, depth=1)
    encoded = json.dumps(normalized, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_TOOL_METADATA_BYTES:
        raise ValueError(
            f"memory_store metadata must be at most {MAX_TOOL_METADATA_BYTES} bytes"
        )

    return normalized


async def _memory_recall_with_store(store: OmniMemStore, query: str) -> str:
    """Recall memory records matching a query string (substring, case-insensitive).

    Returns all records if query is empty.
    """
    _validate_memory_recall_query(query)
    try:
        raw_results = await store.recall(query)
    except Exception as exc:
        _raise_memory_operation_error("memory_recall", exc)

    results = MemoryRetriever(store).annotate_recall_results(
        query,
        raw_results,
        limit=len(raw_results),
    )
    return json.dumps({"records": [r.to_wire_dict() for r in results]})


async def _memory_store_with_store(
    store: OmniMemStore,
    content: str,
    tier: MemoryTier = "working",
    layer: MemoryLayer | None = None,
    metadata: dict[str, object] | None = None,
    content_type: str = "text",
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

    return json.dumps({"id": record.id})


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

        async with OmniMemStore() as lifespan_store:
            yield {"store": lifespan_store}

    return lifespan


async def memory_recall(query: str) -> str:
    """Legacy direct helper that opens a store per call."""
    async with OmniMemStore() as store:
        return await _memory_recall_with_store(store, query)


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


def create_server(store: OmniMemStore | None = None) -> FastMCP:
    server_store: OmniMemStore | None = store
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

    @server.tool(name="memory_recall")
    async def memory_recall_tool(
        query: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Recall memory records matching a query string (substring, case-insensitive).

        Returns all records if query is empty.
        """
        return await _memory_recall_with_store(await resolve_store(ctx), query)

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
        return await _memory_store_with_store(
            await resolve_store(ctx),
            content,
            tier,
            layer,
            metadata,
            content_type,
        )

    return server


mcp = create_server()


def main() -> None:
    logger.info("omnimem server starting", transport="stdio")
    mcp.run(transport="stdio")
