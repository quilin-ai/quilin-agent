from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from collections.abc import AsyncIterator

import pytest
from mcp.types import CallToolRequest, CallToolRequestParams

from omnimem import server as server_module
from omnimem.scratchpad import ScratchpadStore
from omnimem.server import create_server
from omnimem.store import OmniMemStore

SEMANTIC_METADATA = {
    "schema_version": 1,
    "source": "test_fixture",
    "stability_reason": "fixture stability",
}


def _decode_call_tool_result(result: object) -> dict[str, object]:
    if hasattr(result, "root"):
        content_items = getattr(result.root, "content", [])  # type: ignore[attr-defined]
        text = "\n".join(
            item.text for item in content_items if getattr(item, "type", None) == "text"
        )
        return json.loads(text)

    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


def _assert_memory_item_record(
    record: dict[str, object],
    *,
    content: str,
    layer: str,
    memory_id: str | None = None,
    recall_source: str | None = None,
    memory_source: str | None = None,
) -> None:
    if memory_id is not None:
        assert record["id"] == memory_id

    assert record["content"] == content
    assert record["layer"] == layer
    assert record["tier"] == layer
    assert record["content_type"] == "text"
    metadata = record["metadata"]
    assert metadata["schema_version"] == 1
    if recall_source is None:
        assert metadata == {"schema_version": 1}
    else:
        assert metadata["source"] == recall_source
        assert metadata["source_layers"] == [layer]
        assert metadata["block_version"] == "memory-recall-v1"
        assert metadata["cache_key"].startswith("memory-recall:")
        assert metadata["staleness"] == "fresh"
        assert isinstance(metadata["score"], float)
        if memory_source is None:
            assert "memory_source" not in metadata
        else:
            assert metadata["memory_source"] == memory_source
    assert record["embedding"] is None
    assert isinstance(record["created_at"], str)
    assert isinstance(record["last_accessed"], str)
    assert record["access_count"] == 0
    assert record["importance_score"] == 0.5


async def _call_tool_request(
    server: object,
    name: str,
    arguments: dict[str, object],
    *,
    metadata: dict[str, object] | None = None,
):
    handler = server._mcp_server.request_handlers[CallToolRequest]  # type: ignore[attr-defined]
    return await handler(
        CallToolRequest(
            method="tools/call",
            params=CallToolRequestParams(
                name=name,
                arguments=arguments,
                **({"_meta": metadata} if metadata is not None else {}),
            ),
        )
    )


@pytest.fixture
async def store() -> AsyncIterator[OmniMemStore]:
    async with OmniMemStore(db_path=":memory:") as bound_store:
        yield bound_store


@pytest.fixture
async def scratchpad_store() -> AsyncIterator[ScratchpadStore]:
    async with ScratchpadStore(db_path=":memory:") as bound_store:
        yield bound_store


@pytest.fixture
def server(store: OmniMemStore, scratchpad_store: ScratchpadStore):
    return create_server(store, scratchpad_store)


async def test_memory_store_tool_returns_id(server: object) -> None:
    result = _decode_call_tool_result(
        await server.call_tool("memory_store", {"content": "test content"})  # type: ignore[attr-defined]
    )
    assert "id" in result
    assert isinstance(result["id"], str)
    assert len(result["id"]) > 0


async def test_memory_store_tool_with_tier(server: object) -> None:
    store_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_store",
            {
                "content": "important",
                "tier": "semantic",
                "metadata": dict(SEMANTIC_METADATA),
            },
        )
    )
    recall_result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": "important"})  # type: ignore[attr-defined]
    )

    assert "id" in store_result
    _assert_memory_item_record(
        recall_result["records"][0],  # type: ignore[index]
        content="important",
        layer="semantic",
        memory_id=store_result["id"],  # type: ignore[arg-type]
        recall_source="direct_recall",
        memory_source="test_fixture",
    )


async def test_memory_store_tool_defaults_semantic_metadata(server: object) -> None:
    store_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_store",
            {
                "content": "user prefers direct corrections",
                "layer": "semantic",
            },
        )
    )
    recall_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_recall",
            {"query": "direct corrections"},
        )
    )

    assert "id" in store_result
    record = recall_result["records"][0]  # type: ignore[index]
    _assert_memory_item_record(
        record,
        content="user prefers direct corrections",
        layer="semantic",
        memory_id=store_result["id"],  # type: ignore[arg-type]
        recall_source="direct_recall",
        memory_source="memory_store_tool",
    )
    assert record["metadata"]["stability_reason"] == "caller_selected_semantic_tier"


async def test_memory_store_tool_defaults_semantic_metadata_from_tier(
    server: object,
) -> None:
    store_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_store",
            {
                "content": "user prefers tier semantic defaults",
                "tier": "semantic",
            },
        )
    )
    recall_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_recall",
            {"query": "tier semantic defaults"},
        )
    )

    assert "id" in store_result
    record = recall_result["records"][0]  # type: ignore[index]
    _assert_memory_item_record(
        record,
        content="user prefers tier semantic defaults",
        layer="semantic",
        memory_id=store_result["id"],  # type: ignore[arg-type]
        recall_source="direct_recall",
        memory_source="memory_store_tool",
    )
    assert record["metadata"]["stability_reason"] == "caller_selected_semantic_tier"


async def test_memory_store_tool_accepts_canonical_layer(server: object) -> None:
    await server.call_tool(  # type: ignore[attr-defined]
        "memory_store",
        {"content": "checkpoint", "layer": "episodic"},
    )

    recall_result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": "checkpoint"})  # type: ignore[attr-defined]
    )

    _assert_memory_item_record(
        recall_result["records"][0],  # type: ignore[index]
        content="checkpoint",
        layer="episodic",
        recall_source="direct_recall",
    )


async def test_memory_store_tool_prefers_layer_over_tier(server: object) -> None:
    await server.call_tool(  # type: ignore[attr-defined]
        "memory_store",
        {
            "content": "stable preference",
            "tier": "working",
            "layer": "semantic",
            "metadata": dict(SEMANTIC_METADATA),
        },
    )

    recall_result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": "stable preference"})  # type: ignore[attr-defined]
    )

    _assert_memory_item_record(
        recall_result["records"][0],  # type: ignore[index]
        content="stable preference",
        layer="semantic",
        recall_source="direct_recall",
        memory_source="test_fixture",
    )


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
        assert "layer" in record
        assert "metadata" in record
        assert record["metadata"]["schema_version"] == 1
        assert record["metadata"]["source"] == "direct_recall"
        assert record["metadata"]["block_version"] == "memory-recall-v1"
        assert record["metadata"]["cache_key"].startswith("memory-recall:")
        assert "score" in record["metadata"]
        assert "source_layers" in record["metadata"]


class _FakeMeta:
    def __init__(self, metadata: dict[str, object]) -> None:
        self._metadata = metadata

    def model_dump(self) -> dict[str, object]:
        return dict(self._metadata)


class _FakeRequestContext:
    def __init__(self, metadata: dict[str, object]) -> None:
        self.meta = _FakeMeta(metadata)
        self.lifespan_context: object = {}


class _FakeContext:
    def __init__(self, metadata: dict[str, object]) -> None:
        self._request_context = _FakeRequestContext(metadata)

    @property
    def request_context(self) -> _FakeRequestContext:
        return self._request_context


class _RawRequestContext:
    def __init__(self, meta: object, lifespan_context: object | None = None) -> None:
        self.meta = meta
        self.lifespan_context = {} if lifespan_context is None else lifespan_context


class _RawContext:
    def __init__(self, meta: object, lifespan_context: object | None = None) -> None:
        self._request_context = _RawRequestContext(meta, lifespan_context)

    @property
    def request_context(self) -> _RawRequestContext:
        return self._request_context


async def test_memory_recall_parses_traceparent_metadata(
    store: OmniMemStore,
) -> None:
    await server_module._memory_store_with_store(store, "trace me")
    trace_context = server_module._trace_context_from_context(
        _FakeContext(
            {
                "traceparent": f"00-{'a' * 32}-{'b' * 16}-01",
                "request_id": "request-1",
            }
        )
    )
    assert trace_context is not None

    child_context = server_module._child_trace_context(trace_context)
    assert child_context is not None

    result = json.loads(
        await server_module._memory_recall_with_store(
            store,
            "trace",
            trace_context=child_context,
        )
    )

    assert result["records"]
    assert result["traceparent"].startswith(f"00-{'a' * 32}-")
    assert result["traceparent"].endswith("-01")


async def test_memory_store_returns_child_traceparent(
    store: OmniMemStore,
) -> None:
    parent = server_module.parse_traceparent(
        f"00-{'e' * 32}-{'f' * 16}-01",
        request_id="request-store",
    )
    child = server_module._child_trace_context(parent)
    assert child is not None

    result = json.loads(
        await server_module._memory_store_with_store(
            store,
            "traceable content",
            trace_context=child,
        )
    )

    assert isinstance(result["id"], str)
    assert result["traceparent"].startswith(f"00-{'e' * 32}-")
    assert result["traceparent"].endswith("-01")


async def test_scratchpad_tools_are_task_scoped_and_do_not_pollute_memory(
    server: object,
) -> None:
    write_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "scratchpad_write",
            {
                "task_id": "task-1",
                "session_id": "session-1",
                "key": "draft",
                "value": "scratchpad only",
                "ttl_sec": 60,
                "capacity_per_task": 8,
            },
        )
    )
    read_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "scratchpad_read",
            {
                "task_id": "task-1",
                "session_id": "session-1",
                "key": "draft",
            },
        )
    )
    recall_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "memory_recall",
            {"query": "scratchpad only"},
        )
    )
    clear_result = _decode_call_tool_result(
        await server.call_tool(  # type: ignore[attr-defined]
            "scratchpad_clear",
            {
                "task_id": "task-1",
                "session_id": "session-1",
                "key": "draft",
            },
        )
    )

    assert write_result == {"ok": True}
    assert read_result == {"value": "scratchpad only"}
    assert recall_result["records"] == []
    assert clear_result == {"cleared": 1}


async def test_scratchpad_helpers_return_child_traceparent(
    scratchpad_store: ScratchpadStore,
) -> None:
    parent = server_module.parse_traceparent(
        f"00-{'c' * 32}-{'d' * 16}-01",
        request_id="request-2",
    )
    child = server_module._child_trace_context(parent)
    assert child is not None

    result = json.loads(
        await server_module._scratchpad_write_with_store(
            scratchpad_store,
            task_id="task-trace",
            session_id="session-1",
            key="k",
            value="v",
            trace_context=child,
        )
    )

    assert result["ok"] is True
    assert result["traceparent"].startswith(f"00-{'c' * 32}-")
    assert result["traceparent"].endswith("-01")


async def test_scratchpad_helper_errors_are_sanitized() -> None:
    class FailingScratchpadStore:
        async def write(self, **_kwargs: object) -> None:
            raise sqlite3.OperationalError("cannot write /tmp/private-scratchpad.db")

        async def read(self, **_kwargs: object) -> None:
            raise sqlite3.OperationalError("cannot read /tmp/private-scratchpad.db")

        async def clear(self, **_kwargs: object) -> None:
            raise sqlite3.OperationalError("cannot clear /tmp/private-scratchpad.db")

    scratchpad_store = FailingScratchpadStore()

    with pytest.raises(server_module.MemoryOperationError, match="scratchpad_write failed"):
        await server_module._scratchpad_write_with_store(
            scratchpad_store,  # type: ignore[arg-type]
            task_id="task-1",
            session_id="session-1",
            key="k",
            value="v",
        )
    with pytest.raises(server_module.MemoryOperationError, match="scratchpad_read failed"):
        await server_module._scratchpad_read_with_store(
            scratchpad_store,  # type: ignore[arg-type]
            task_id="task-1",
            session_id="session-1",
            key="k",
        )
    with pytest.raises(server_module.MemoryOperationError, match="scratchpad_clear failed"):
        await server_module._scratchpad_clear_with_store(
            scratchpad_store,  # type: ignore[arg-type]
            task_id="task-1",
            session_id="session-1",
        )


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


def test_memory_store_metadata_validation_boundaries() -> None:
    observer_metadata = {
        "source_turn_id": "turn-1",
        "trace_id": "a" * 32,
        "evidence": ["turn-1"],
        "source_excerpt": "User asked for direct updates.",
        "supporting_turns": ["turn-1", "turn-2"],
    }
    assert server_module._validate_tool_metadata(
        {"source_layers": ["episodic"], **observer_metadata}
    ) == {"source_layers": ["episodic"], **observer_metadata}

    with pytest.raises(ValueError, match="string values"):
        server_module._validate_tool_metadata({"source": "x" * 513})
    with pytest.raises(ValueError, match="lists"):
        server_module._validate_tool_metadata({"source_layers": ["episodic"] * 33})
    with pytest.raises(ValueError, match="objects"):
        server_module._validate_tool_metadata(
            {"budget_decision": {f"k{index}": index for index in range(33)}}
        )
    with pytest.raises(ValueError, match="keys"):
        server_module._validate_tool_metadata({"budget_decision": {"": "bad"}})
    with pytest.raises(ValueError, match="JSON-serializable"):
        server_module._validate_tool_metadata({"budget_decision": object()})
    with pytest.raises(ValueError, match="4096 bytes"):
        server_module._validate_tool_metadata({"source_layers": ["x" * 512] * 9})


def test_request_metadata_and_context_store_edge_cases(store: OmniMemStore) -> None:
    assert server_module._request_meta_to_dict(_RawContext(None)) == {}
    assert server_module._request_meta_to_dict(_RawContext({"traceparent": "tp"})) == {
        "traceparent": "tp"
    }
    assert server_module._request_meta_to_dict(_RawContext(object())) == {}
    assert server_module._get_store_from_context(_RawContext(None, lifespan_context=[])) is None
    assert (
        server_module._get_store_from_context(
            _RawContext(None, lifespan_context={"store": object()})
        )
        is None
    )
    assert (
        server_module._get_store_from_context(_RawContext(None, lifespan_context={"store": store}))
        is store
    )


async def test_store_lifespan_yields_injected_store(store: OmniMemStore) -> None:
    lifespan = server_module._build_store_lifespan(store)

    async with lifespan(object()) as context:
        assert context == {"store": store}


async def test_legacy_helpers_use_ephemeral_test_store(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QUILIN_ENV", "test")

    store_result = json.loads(await server_module.memory_store("legacy helper"))
    recall_result = json.loads(await server_module.memory_recall("missing"))

    assert isinstance(store_result["id"], str)
    assert recall_result == {"records": []}


async def test_create_server_lazily_creates_scratchpad_store(
    store: OmniMemStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[str] = []

    class LazyScratchpadStore:
        def __init__(self) -> None:
            created.append("scratchpad")

        async def write(self, **_kwargs: object) -> None:
            return None

    monkeypatch.setattr(server_module, "ScratchpadStore", LazyScratchpadStore)
    lazy_server = create_server(store)

    result = _decode_call_tool_result(
        await lazy_server.call_tool(
            "scratchpad_write",
            {
                "task_id": "task-1",
                "session_id": "session-1",
                "key": "draft",
                "value": "hello",
            },
        )
    )

    assert created == ["scratchpad"]
    assert result == {"ok": True}


def test_main_configures_logging_and_runs_stdio(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, object]] = []

    class FakeLogger:
        def info(self, message: str, **kwargs: object) -> None:
            calls.append((message, kwargs))

    class FakeMCP:
        def run(self, *, transport: str) -> None:
            calls.append(("run", transport))

    monkeypatch.setattr(server_module, "configure_once", lambda: calls.append(("configure", None)))
    monkeypatch.setattr(server_module, "logger", FakeLogger())
    monkeypatch.setattr(server_module, "mcp", FakeMCP())

    server_module.main()

    assert calls == [
        ("configure", None),
        ("omnimem server starting", {"transport": "stdio"}),
        ("run", "stdio"),
    ]


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
    _assert_memory_item_record(
        records[0],  # type: ignore[index]
        memory_id=stored_id,  # type: ignore[arg-type]
        content="my memory",
        layer="episodic",
        recall_source="direct_recall",
    )


async def test_memory_recall_tool_adds_retrieval_envelope_and_preserves_memory_source(
    server: object,
) -> None:
    await server.call_tool(  # type: ignore[attr-defined]
        "memory_store",
        {
            "content": "checkpoint with source metadata",
            "tier": "episodic",
            "metadata": {"schema_version": 1, "source": "checkpoint_writer"},
        },
    )

    result = _decode_call_tool_result(
        await server.call_tool("memory_recall", {"query": "checkpoint with source"})  # type: ignore[attr-defined]
    )

    _assert_memory_item_record(
        result["records"][0],  # type: ignore[index]
        content="checkpoint with source metadata",
        layer="episodic",
        recall_source="direct_recall",
        memory_source="checkpoint_writer",
    )


async def test_memory_recall_applies_user_retrieval_profile(
    store: OmniMemStore,
) -> None:
    await server_module._memory_store_with_store(
        store,
        "lower bm25 result",
        metadata={"schema_version": 1, "user_id": "user-1"},
    )
    await server_module._memory_store_with_store(
        store,
        "higher bm25 result",
        metadata={"schema_version": 1, "user_id": "user-1"},
    )
    store.retrieval_profiles.update_weights("user-1", {"direct_recall": 0.25})

    result = json.loads(
        await server_module._memory_recall_with_store(
            store,
            "bm25 result",
            user_id="user-1",
        )
    )

    records = result["records"]
    assert len(records) == 2
    assert all(record["metadata"]["weighted_score"] < 1 for record in records)


async def test_memory_recall_filters_user_records_before_profile_weighting(
    store: OmniMemStore,
) -> None:
    await server_module._memory_store_with_store(
        store,
        "shared deployment note for alpha",
        metadata={"schema_version": 1, "user_id": "user-1"},
    )
    await server_module._memory_store_with_store(
        store,
        "shared deployment note for beta",
        metadata={"schema_version": 1, "user_id": "user-2"},
    )
    store.retrieval_profiles.update_weights("user-1", {"direct_recall": 0.25})

    result = json.loads(
        await server_module._memory_recall_with_store(
            store,
            "shared deployment note",
            user_id="user-1",
        )
    )

    records = result["records"]
    assert [record["content"] for record in records] == ["shared deployment note for alpha"]
    assert records[0]["metadata"]["user_id"] == "user-1"
    assert records[0]["metadata"]["weighted_score"] < 1


async def test_memory_recall_filters_user_and_session_records_before_profile_weighting(
    store: OmniMemStore,
) -> None:
    await server_module._memory_store_with_store(
        store,
        "shared session note for alpha",
        metadata={"schema_version": 1, "user_id": "user-1", "session_id": "session-1"},
    )
    await server_module._memory_store_with_store(
        store,
        "shared session note for beta",
        metadata={"schema_version": 1, "user_id": "user-1", "session_id": "session-2"},
    )
    await server_module._memory_store_with_store(
        store,
        "shared session note for gamma",
        metadata={"schema_version": 1, "user_id": "user-2", "session_id": "session-2"},
    )
    store.retrieval_profiles.update_weights("user-1", {"direct_recall": 0.25})

    result = json.loads(
        await server_module._memory_recall_with_store(
            store,
            "shared session note",
            user_id="user-1",
            session_id="session-2",
        )
    )

    records = result["records"]
    assert [record["content"] for record in records] == ["shared session note for beta"]
    assert records[0]["metadata"]["user_id"] == "user-1"
    assert records[0]["metadata"]["session_id"] == "session-2"
    assert records[0]["metadata"]["weighted_score"] < 1


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

    async def _raise_on_store(
        content: str,
        tier: str = "working",
        *,
        layer: str | None = None,
        metadata: dict[str, object] | None = None,
        content_type: str = "text",
    ) -> None:
        del content, tier, layer, metadata, content_type
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

    assert len(left_result["records"]) == 1
    _assert_memory_item_record(
        left_result["records"][0],  # type: ignore[index]
        content="left only",
        layer="working",
        recall_source="direct_recall",
    )
    assert right_result["records"] == []


async def test_store_lifespan_initializes_store_off_event_loop(monkeypatch: object) -> None:
    class SlowStore(OmniMemStore):
        def __init__(self) -> None:
            time.sleep(0.05)
            super().__init__(db_path=":memory:")

    monkeypatch.setattr(server_module, "OmniMemStore", SlowStore)
    lifespan = server_module._build_store_lifespan(None)  # type: ignore[attr-defined]
    observed: list[str] = []

    async def run_lifespan() -> None:
        async with lifespan(object()):
            observed.append("ready")

    async def heartbeat() -> None:
        await asyncio.sleep(0.01)
        observed.append("tick")

    await asyncio.gather(run_lifespan(), heartbeat())

    assert observed == ["tick", "ready"]


async def test_create_server_rejects_invalid_tier_enum() -> None:
    server = create_server(OmniMemStore(db_path=":memory:"))

    with pytest.raises(Exception, match="tier"):
        await server.call_tool(
            "memory_store",
            {"content": "bad tier", "tier": "short"},
        )


async def test_memory_store_tool_rejects_unknown_metadata_keys(server: object) -> None:
    with pytest.raises(Exception, match="metadata keys not allowed"):
        await server.call_tool(
            "memory_store",
            {
                "content": "bad metadata",
                "metadata": {"schema_version": 1, "source": "user", "debug": True},
            },
        )


async def test_memory_store_tool_rejects_excessively_nested_metadata(server: object) -> None:
    with pytest.raises(Exception, match="nesting"):
        await server.call_tool(
            "memory_store",
            {
                "content": "too deep",
                "metadata": {
                    "schema_version": 1,
                    "source": "user",
                    "stability_reason": "deep payload",
                    "source_layers": [[["a"]]],
                },
            },
        )


async def test_memory_recall_tool_rejects_oversized_query(server: object) -> None:
    with pytest.raises(Exception, match="at most 512 characters"):
        await server.call_tool(
            "memory_recall",
            {"query": "q" * 513},
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
