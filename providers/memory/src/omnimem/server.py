from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from .logging import logger
from .store import OmniMemStore
from .types import MemoryLayer, MemoryTier


class MemoryOperationError(RuntimeError):
    """Sanitized tool error exposed over MCP."""


def _raise_memory_operation_error(operation: str, exc: Exception) -> None:
    logger.error(f"{operation} failed", error=str(exc))
    raise MemoryOperationError(f"{operation} failed") from exc


async def _memory_recall_with_store(store: OmniMemStore, query: str) -> str:
    """Recall memory records matching a query string (substring, case-insensitive).

    Returns all records if query is empty.
    """
    try:
        results = await store.recall(query)
    except Exception as exc:
        _raise_memory_operation_error("memory_recall", exc)

    return json.dumps({"records": [r.to_wire_dict() for r in results]})


async def _memory_store_with_store(
    store: OmniMemStore,
    content: str,
    tier: MemoryTier = "working",
    layer: MemoryLayer | None = None,
) -> str:
    """Store a new memory record.

    Args:
        content: The text content to store.
        tier: Memory tier (default "working").
    """
    try:
        if layer is None:
            record = await store.store(content, tier=tier)
        else:
            record = await store.store(content, tier=tier, layer=layer)
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
) -> str:
    """Legacy direct helper that opens a store per call."""
    async with OmniMemStore() as store:
        return await _memory_store_with_store(store, content, tier, layer)


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
        )

    return server


mcp = create_server()


def main() -> None:
    logger.info("omnimem server starting", transport="stdio")
    mcp.run(transport="stdio")
