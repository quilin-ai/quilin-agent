from __future__ import annotations

import json
import sqlite3
from collections.abc import AsyncIterator

import pytest
from mcp.types import CallToolRequest, CallToolRequestParams

from omnimem.server import create_server
from omnimem.store import OmniMemStore


def _decode_call_tool_result(result: object) -> dict[str, object]:
    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


async def _call_tool_request(server: object, name: str, arguments: dict[str, object]):
    handler = server._mcp_server.request_handlers[CallToolRequest]  # type: ignore[attr-defined]
    return await handler(
        CallToolRequest(
            method="tools/call",
            params=CallToolRequestParams(name=name, arguments=arguments),
        )
    )


@pytest.fixture
async def store() -> AsyncIterator[OmniMemStore]:
    async with OmniMemStore(db_path=":memory:") as bound_store:
        yield bound_store


@pytest.fixture
def server(store: OmniMemStore):
    return create_server(store)


async def test_memory_store_tool_returns_id(server: object) -> None:
    result = _decode_call_tool_result(
        await server.call_tool("memory_store", {"content": "test content"})  # type: ignore[attr-defined]
    )
    assert "id" in result
    assert isinstance(result["id"], str)
    assert len(result["id"]) > 0


async def test_memory_store_tool_with_tier(server: object) -> None:
    result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_store",
            {"content": "important", "tier": "semantic"},
        )
    )
    assert "id" in result


async def test_memory_recall_tool_returns_records(server: object) -> None:
    await server.call_tool("memory_store", {"content": "hello world"})  # type: ignore[attr-defined]
    await server.call_tool("memory_store", {"content": "hello there"})  # type: ignore[attr-defined]
    await server.call_tool("memory_store", {"content": "goodbye"})  # type: ignore[attr-defined]

    result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": "hello"})  # type: ignore[attr-defined]
    )
    assert "records" in result
    assert len(result["records"]) == 2
    for record in result["records"]:  # type: ignore[index]
        assert "id" in record
        assert "content" in record
        assert "tier" in record


async def test_memory_recall_tool_empty_query(server: object) -> None:
    await server.call_tool("memory_store", {"content": "alpha"})  # type: ignore[attr-defined]
    await server.call_tool("memory_store", {"content": "beta"})  # type: ignore[attr-defined]

    result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": ""})  # type: ignore[attr-defined]
    )
    assert len(result["records"]) == 2


async def test_memory_recall_tool_no_match(server: object) -> None:
    await server.call_tool("memory_store", {"content": "apple"})  # type: ignore[attr-defined]

    result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": "banana"})  # type: ignore[attr-defined]
    )
    assert result["records"] == []


async def test_roundtrip_store_then_recall(server: object) -> None:
    """Store a record and recall it, verifying the full wire schema."""
    store_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_store",
            {"content": "my memory", "tier": "episodic"},
        )
    )
    stored_id = store_result["id"]

    recall_result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": "my memory"})  # type: ignore[attr-defined]
    )
    records = recall_result["records"]
    assert len(records) == 1
    assert records[0] == {
        "id": stored_id,
        "content": "my memory",
        "tier": "episodic",
    }


async def test_memory_recall_error_path(
    store: OmniMemStore,
    server: object,
    monkeypatch: object,
) -> None:
    """memory_recall should surface a sanitized MCP error result."""

    async def _raise_on_recall(query: str) -> list:
        raise sqlite3.OperationalError("no such table: memories at /tmp/omnimem.db")

    monkeypatch.setattr(store, "recall", _raise_on_recall)  # type: ignore[attr-defined]

    result = await _call_tool_request(server, "memory_recall", {"query": "anything"})
    assert result.root.isError is True
    assert "memory_recall failed" in result.root.content[0].text
    assert "memories" not in result.root.content[0].text
    assert "/tmp/omnimem.db" not in result.root.content[0].text


async def test_memory_store_error_path(
    store: OmniMemStore,
    server: object,
    monkeypatch: object,
) -> None:
    """memory_store should surface a sanitized MCP error result."""

    async def _raise_on_store(content: str, tier: str = "working") -> None:
        raise sqlite3.OperationalError("unable to open database file /tmp/private.db")

    monkeypatch.setattr(store, "store", _raise_on_store)  # type: ignore[attr-defined]

    result = await _call_tool_request(server, "memory_store", {"content": "test content"})
    assert result.root.isError is True
    assert "memory_store failed" in result.root.content[0].text
    assert "private.db" not in result.root.content[0].text
    assert "/tmp/private.db" not in result.root.content[0].text


async def test_create_server_uses_injected_store_isolation() -> None:
    left_server = create_server(OmniMemStore(db_path=":memory:"))
    right_server = create_server(OmniMemStore(db_path=":memory:"))

    await left_server.call_tool(
        "memory_store",
        {"content": "left only", "tier": "working"},
    )

    left_result = _decode_call_tool_result(
        await left_server.call_tool("memory_recall", {"query": "left"})
    )
    right_result = _decode_call_tool_result(
        await right_server.call_tool("memory_recall", {"query": "left"})
    )

    assert left_result["records"] == [
        {
            "id": left_result["records"][0]["id"],  # type: ignore[index]
            "content": "left only",
            "tier": "working",
        }
    ]
    assert right_result["records"] == []


async def test_create_server_rejects_invalid_tier_enum() -> None:
    server = create_server(OmniMemStore(db_path=":memory:"))

    with pytest.raises(Exception, match="tier"):
        await server.call_tool(
            "memory_store",
            {"content": "bad tier", "tier": "short"},
        )


async def test_default_server_instances_do_not_share_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("QUILIN_ENV", "test")
    left_server = create_server()
    right_server = create_server()

    await left_server.call_tool(
        "memory_store",
        {"content": "left only", "tier": "working"},
    )

    left_result = _decode_call_tool_result(
        await left_server.call_tool("memory_recall", {"query": "left"})
    )
    right_result = _decode_call_tool_result(
        await right_server.call_tool("memory_recall", {"query": "left"})
    )

    assert len(left_result["records"]) == 1
    assert right_result["records"] == []
