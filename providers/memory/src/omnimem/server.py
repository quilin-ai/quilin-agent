from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from .logging import logger
from .store import OmniMemStore

mcp = FastMCP("omnimem")
_store = OmniMemStore()


@mcp.tool()
async def memory_recall(query: str) -> str:
    """Recall memory records matching a query string (substring, case-insensitive).

    Returns all records if query is empty.
    """
    try:
        results = await _store.recall(query)
        return json.dumps({"records": [r.to_dict() for r in results]})
    except Exception as exc:
        logger.error("memory_recall failed", error=str(exc))
        return json.dumps({"error": str(exc)})


@mcp.tool()
async def memory_store(content: str, tier: str = "short") -> str:
    """Store a new memory record.

    Args:
        content: The text content to store.
        tier: Memory tier (default "short").
    """
    try:
        record = await _store.store(content, tier)
        return json.dumps({"id": record.id})
    except Exception as exc:
        logger.error("memory_store failed", error=str(exc))
        return json.dumps({"error": str(exc)})


def main() -> None:
    logger.info("omnimem server starting", transport="stdio")
    mcp.run(transport="stdio")
