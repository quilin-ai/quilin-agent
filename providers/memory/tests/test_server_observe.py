"""Tests for the memory_observe MCP tool.

These tests verify that the memory_observe tool wires the L3aObserver class
into the MCP server boundary correctly:
    - Frequency gate: low-frequency calls return only deterministic candidates.
    - No-api-key path: observer cannot trigger LLM, no exception raised.
    - Error sanitization: observer-raised exceptions surface as
      MemoryOperationError (no internal stack trace leaked).
    - Per-session caching: repeated calls for the same (user_id, session_id)
      reuse the same L3aObserver instance, preserving turn-buffer state.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest
from mcp.types import CallToolRequest, CallToolRequestParams

from quilin_mem.observer import L3aObserver, ObserverConfig
from quilin_mem.server import MemoryOperationError, create_server


def _decode_call_tool_result(result: object) -> dict[str, object]:
    """Mirror of test_server.py decoder for FastMCP CallToolResult shape."""
    if hasattr(result, "root"):
        content_items = getattr(result.root, "content", [])  # type: ignore[attr-defined]
        text = "\n".join(
            item.text for item in content_items if getattr(item, "type", None) == "text"
        )
        return json.loads(text)

    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


async def _call_tool_request(
    server: object,
    name: str,
    arguments: dict[str, object],
) -> object:
    handler = server._mcp_server.request_handlers[CallToolRequest]  # type: ignore[attr-defined]
    return await handler(
        CallToolRequest(
            method="tools/call",
            params=CallToolRequestParams(
                name=name,
                arguments=arguments,
            ),
        )
    )


def _llm_json_caller(_base_url: str, _api_key: str, _payload: bytes) -> str:
    """Deterministic LLM stub for tests that need L3a candidates."""
    return json.dumps(
        {
            "patterns": ["User prefers concise updates"],
            "suggestions": ["Default to short status messages"],
            "confidence": 0.9,
        }
    )


@pytest.fixture
def server_no_api_key() -> object:
    """Server with an observer factory whose ObserverConfig has no api_key."""

    def factory() -> L3aObserver:
        return L3aObserver(
            ObserverConfig(api_key="", frequency=10),
            _llm_caller=_llm_json_caller,
        )

    return create_server(observer_factory=factory)


@pytest.fixture
def server_with_api_key() -> object:
    """Server with an observer factory whose ObserverConfig has an api_key.

    profile_updater_factory returns None to avoid touching ~/.quilin/user.md
    during tests; observer.observe() still produces L3a candidates because the
    LLM stub is wired.
    """

    def factory() -> L3aObserver:
        return L3aObserver(
            ObserverConfig(api_key="stub-key", frequency=2),
            profile_updater=None,
            _llm_caller=_llm_json_caller,
        )

    return create_server(
        observer_factory=factory,
        profile_updater_factory=lambda: None,
    )


@pytest.fixture
async def shared_observer_server() -> AsyncIterator[tuple[object, list[L3aObserver]]]:
    """Server that records every observer the factory hands out.

    The factory always returns a fresh L3aObserver, so the server's
    per-session cache must keep returning the *same* instance for the same
    (user_id, session_id). The recorder list lets tests assert on construction
    counts.
    """
    constructed: list[L3aObserver] = []

    def factory() -> L3aObserver:
        observer = L3aObserver(
            ObserverConfig(api_key="", frequency=10),
            _llm_caller=_llm_json_caller,
        )
        constructed.append(observer)
        return observer

    server = create_server(observer_factory=factory)
    yield server, constructed


async def test_memory_observe_returns_deterministic_only_when_under_frequency(
    server_no_api_key: object,
) -> None:
    """When frequency threshold is not hit, the response holds only
    deterministic candidates (or none) — never an L3a candidate."""
    result = _decode_call_tool_result(
        await _call_tool_request(
            server_no_api_key,
            "memory_observe",
            {
                "user_text": "I prefer Chinese summaries",
                "assistant_text": "Got it.",
                "user_id": "alice",
                "session_id": "session-A",
            },
        )
    )

    assert "candidates" in result
    candidates = result["candidates"]
    assert isinstance(candidates, list)
    # Deterministic candidates may or may not fire; what we care about is
    # that none of them are tagged as L3a-source (api_key="" prevents L3a).
    for candidate in candidates:
        metadata = candidate.get("metadata", {})  # type: ignore[union-attr]
        assert metadata.get("source") != "l3a_observer"


async def test_memory_observe_no_api_key_does_not_raise(
    server_no_api_key: object,
) -> None:
    """Without api_key the observer must not raise — even after many turns
    that would normally hit the LLM frequency boundary."""
    for turn_idx in range(15):
        result = _decode_call_tool_result(
            await _call_tool_request(
                server_no_api_key,
                "memory_observe",
                {
                    "user_text": f"turn {turn_idx}: please remember my preferences",
                    "assistant_text": "Acknowledged.",
                    "user_id": "alice",
                    "session_id": "session-A",
                },
            )
        )

        assert "candidates" in result
        for candidate in result["candidates"]:
            metadata = candidate.get("metadata", {})  # type: ignore[union-attr]
            # Without api_key the LLM should never be triggered, so no
            # candidate should carry the L3a source tag.
            assert metadata.get("source") != "l3a_observer"


async def test_memory_observe_validates_text_length() -> None:
    """The helper raises MemoryOperationError on oversized text inputs.

    Calling the helper directly bypasses FastMCP's exception wrapping so we
    can assert on our sanitized error type. (The MCP boundary surfaces the
    same error as a tool error to the client.)
    """
    from quilin_mem import server as server_module

    observer = L3aObserver(
        ObserverConfig(api_key="", frequency=10),
        _llm_caller=_llm_json_caller,
    )
    too_large = "x" * (32 * 1024 + 1)

    with pytest.raises(MemoryOperationError, match="memory_observe failed"):
        await server_module._memory_observe_with_observer(
            observer,
            user_text=too_large,
            assistant_text="ok",
            user_id=None,
            session_id=None,
        )


async def test_memory_observe_observer_errors_yield_empty_candidates() -> None:
    """When the underlying observer raises, observe_safely's outer try/except
    catches it and the tool surface returns an empty candidate list — without
    leaking the exception to the MCP caller."""

    class BrokenObserver:
        async def observe(self, _turn: object) -> list[object]:
            raise RuntimeError("simulated observer failure with /private/path/leak")

    server = create_server(observer_factory=lambda: BrokenObserver())  # type: ignore[arg-type]

    result = _decode_call_tool_result(
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": "hello",
                "assistant_text": "world",
            },
        )
    )

    # observe_safely catches everything; tool returns an empty candidate list.
    assert result["candidates"] == []
    # No exception text leaked to the caller.
    assert "private" not in json.dumps(result)


async def test_memory_observe_default_env_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without an injected observer factory, env vars drive ObserverConfig.

    With no api_key in env, the default-constructed observer can never trigger
    the LLM, so the call is safe even though we hit the real factory path.
    """
    monkeypatch.delenv("QUILIN_OBSERVER_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("QUILIN_OBSERVER_FREQUENCY", raising=False)
    monkeypatch.delenv("QUILIN_OBSERVER_MODEL", raising=False)
    monkeypatch.delenv("QUILIN_OBSERVER_BASE_URL", raising=False)

    server = create_server()

    result = _decode_call_tool_result(
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": "I prefer direct corrections",
                "assistant_text": "Acknowledged.",
            },
        )
    )

    assert "candidates" in result
    # Without api_key, no L3a candidates can ever appear.
    for candidate in result["candidates"]:
        metadata = candidate.get("metadata", {})  # type: ignore[union-attr]
        assert metadata.get("source") != "l3a_observer"


async def test_memory_observe_invalid_env_frequency_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When QUILIN_OBSERVER_FREQUENCY is non-numeric, builder uses the default."""
    from quilin_mem import server as server_module

    monkeypatch.setenv("QUILIN_OBSERVER_FREQUENCY", "not-a-number")
    monkeypatch.delenv("QUILIN_OBSERVER_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    config = server_module._build_observer_config_from_env()
    assert config.frequency == server_module.DEFAULT_OBSERVER_FREQUENCY


async def test_memory_observe_observer_factory_failure_falls_back_to_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When observer_factory raises, the server falls back to building an
    observer from env-derived ObserverConfig (no api_key here → safe).

    Uses ``monkeypatch.delenv`` so the test never pollutes the pytest
    session environment (raw ``os.environ.pop`` would persist across tests
    and break parallel runs).
    """
    monkeypatch.delenv("QUILIN_OBSERVER_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    def broken_factory() -> L3aObserver:
        raise RuntimeError("factory blew up")

    server = create_server(observer_factory=broken_factory)

    # Should still respond (fell back to default observer with no api_key)
    result = _decode_call_tool_result(
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": "hello",
                "assistant_text": "world",
            },
        )
    )

    assert "candidates" in result


async def test_memory_observe_profile_factory_returns_wrong_type() -> None:
    """If profile_updater_factory yields something that isn't a ProfileUpdater,
    the server logs a warning and continues without a profile updater."""

    def factory() -> L3aObserver:
        return L3aObserver(
            ObserverConfig(api_key="stub-key", frequency=1),
            _llm_caller=_llm_json_caller,
        )

    server = create_server(
        observer_factory=factory,
        profile_updater_factory=lambda: "not an updater",  # type: ignore[arg-type,return-value]
    )

    # Server resolves observer without throwing; the wrong-type updater is
    # rejected and observer is wired with profile_updater=None.
    result = _decode_call_tool_result(
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": "hello",
                "assistant_text": "world",
            },
        )
    )
    assert "candidates" in result


async def test_memory_observe_profile_factory_raises_is_swallowed() -> None:
    """If profile_updater_factory itself raises, server logs and continues."""

    def factory() -> L3aObserver:
        return L3aObserver(
            ObserverConfig(api_key="stub-key", frequency=1),
            _llm_caller=_llm_json_caller,
        )

    def broken_pf_factory() -> object:
        raise RuntimeError("profile updater bootstrap blew up")

    server = create_server(
        observer_factory=factory,
        profile_updater_factory=broken_pf_factory,
    )

    result = _decode_call_tool_result(
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": "hi",
                "assistant_text": "ok",
            },
        )
    )
    assert "candidates" in result


async def test_memory_observe_session_key_normalizes_blank_ids() -> None:
    """Blank user_id and session_id collapse to the same observer instance."""
    constructed: list[L3aObserver] = []

    def factory() -> L3aObserver:
        observer = L3aObserver(
            ObserverConfig(api_key="", frequency=10),
            _llm_caller=_llm_json_caller,
        )
        constructed.append(observer)
        return observer

    server = create_server(observer_factory=factory)

    # Both calls have neither user_id nor session_id → same cache key.
    for _ in range(2):
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": "hi",
                "assistant_text": "ok",
            },
        )

    assert len(constructed) == 1


async def test_memory_observe_caches_observer_per_session(
    shared_observer_server: tuple[object, list[L3aObserver]],
) -> None:
    """Calling memory_observe twice with the same (user_id, session_id) must
    reuse the same L3aObserver instance, so its turn buffer keeps growing."""
    server, constructed = shared_observer_server

    for turn_idx in range(3):
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": f"turn {turn_idx}",
                "assistant_text": "ack",
                "user_id": "alice",
                "session_id": "session-A",
            },
        )

    # Single observer constructed for the (alice, session-A) key.
    assert len(constructed) == 1

    # Different session -> new observer.
    await _call_tool_request(
        server,
        "memory_observe",
        {
            "user_text": "turn from other session",
            "assistant_text": "ack",
            "user_id": "alice",
            "session_id": "session-B",
        },
    )

    assert len(constructed) == 2


async def test_memory_observe_evicts_oldest_observer_when_cache_is_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The (user_id, session_id) → L3aObserver cache is bounded at
    ``MAX_OBSERVER_SESSIONS``. Once the cap is reached, inserting a new
    distinct session evicts the oldest (least recently used) entry.

    To verify eviction, we:
      1) construct a server with a small cap (4) via monkeypatch,
      2) call memory_observe with 5 distinct session ids (key0..key4),
      3) confirm 5 observers were constructed and the cache size is 4
         (key0 evicted),
      4) re-request key0 — it must construct a *new* observer (factory
         called a 6th time), proving key0 was evicted.

    缓存有上限：超过容量时驱逐最久未用条目；重新请求最老 key 时
    工厂会再次被调用（证明它已被驱逐）。
    """
    from quilin_mem import server as server_module

    monkeypatch.setattr(server_module, "MAX_OBSERVER_SESSIONS", 4)

    constructed: list[L3aObserver] = []

    def factory() -> L3aObserver:
        observer = L3aObserver(
            ObserverConfig(api_key="", frequency=10),
            _llm_caller=_llm_json_caller,
        )
        constructed.append(observer)
        return observer

    server = create_server(observer_factory=factory)

    # Five distinct (user_id, session_id) keys — exceeds the cap of 4.
    for i in range(5):
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": f"hi {i}",
                "assistant_text": "ack",
                "user_id": f"user-{i}",
                "session_id": f"session-{i}",
            },
        )

    # Five fresh observers were constructed (one per distinct key).
    assert len(constructed) == 5

    # Re-request key 0 — it must have been evicted (it was the oldest),
    # so the factory is invoked again, giving us a 6th instance.
    await _call_tool_request(
        server,
        "memory_observe",
        {
            "user_text": "hi 0 again",
            "assistant_text": "ack",
            "user_id": "user-0",
            "session_id": "session-0",
        },
    )
    assert len(constructed) == 6

    # In contrast, the most recently used key (4) should still be cached:
    # re-requesting it should NOT increment the constructed count.
    await _call_tool_request(
        server,
        "memory_observe",
        {
            "user_text": "hi 4 again",
            "assistant_text": "ack",
            "user_id": "user-4",
            "session_id": "session-4",
        },
    )
    assert len(constructed) == 6


async def test_memory_observe_cache_stays_bounded_with_many_sessions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stress test: 257 distinct (user_id, session_id) keys against a cap
    of 256 must not grow unboundedly. We can't peek inside the closure-
    private OrderedDict, so we verify indirectly: the *first* key is
    evicted (factory called again on re-request), and the *last* key is
    still cached (factory not called again on re-request).

    若缓存无界增长，最早的 key 仍命中、不会重新构造；要求最早的 key
    在第 257 次插入时被驱逐。
    """
    from quilin_mem import server as server_module

    monkeypatch.setattr(server_module, "MAX_OBSERVER_SESSIONS", 256)

    constructed: list[L3aObserver] = []

    def factory() -> L3aObserver:
        observer = L3aObserver(
            ObserverConfig(api_key="", frequency=10),
            _llm_caller=_llm_json_caller,
        )
        constructed.append(observer)
        return observer

    server = create_server(observer_factory=factory)

    # 257 unique sessions — exceeds the cap by 1.
    total = 257
    for i in range(total):
        await _call_tool_request(
            server,
            "memory_observe",
            {
                "user_text": f"hi {i}",
                "assistant_text": "ack",
                "user_id": f"user-{i}",
                "session_id": f"session-{i}",
            },
        )

    # 257 distinct keys → 257 observers constructed so far.
    assert len(constructed) == total

    # Re-request the oldest key (i=0). It must have been evicted (the
    # 257th insert pushed the cache past 256, evicting key 0).
    await _call_tool_request(
        server,
        "memory_observe",
        {
            "user_text": "hi 0 again",
            "assistant_text": "ack",
            "user_id": "user-0",
            "session_id": "session-0",
        },
    )
    assert len(constructed) == total + 1

    # Re-request the most-recently-inserted key (i=256). It must still
    # be cached → factory not invoked again.
    await _call_tool_request(
        server,
        "memory_observe",
        {
            "user_text": "hi 256 again",
            "assistant_text": "ack",
            "user_id": f"user-{total - 1}",
            "session_id": f"session-{total - 1}",
        },
    )
    # Constructed count stays at total + 1 — no new observer.
    assert len(constructed) == total + 1
