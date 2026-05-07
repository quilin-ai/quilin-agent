from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from quilin_mem.types import MemoryItem
from quilin_mem.working import WorkingMemory


async def test_working_memory_keeps_recent_k_in_latest_first_order() -> None:
    memory = WorkingMemory(k=3)
    for index in range(5):
        await memory.push(MemoryItem(content=f"turn-{index}"))

    recent = await memory.get_recent()

    assert len(memory) == 3
    assert [item.content for item in recent] == ["turn-4", "turn-3", "turn-2"]


async def test_working_memory_evicts_fifo_and_emits_episodic_candidate() -> None:
    episodic = AsyncMock()
    episodic.compress_and_add.return_value = MemoryItem(
        content="turn-0",
        layer="episodic",
    )
    memory = WorkingMemory(k=2, episodic=episodic)

    await memory.push(MemoryItem(content="turn-0"))
    await memory.push(MemoryItem(content="turn-1"))
    evicted = await memory.push(MemoryItem(content="turn-2"))

    assert evicted is not None
    assert evicted.content == "turn-0"
    assert evicted.layer == "episodic"
    assert evicted.metadata["source"] == "working_memory_eviction"
    assert evicted.metadata["origin_layer"] == "working"

    candidates = await memory.drain_episodic_candidates()
    assert [item.content for item in candidates] == ["turn-0"]

    episodic.compress_and_add.assert_awaited_once()
    forwarded = episodic.compress_and_add.await_args.args[0]
    assert forwarded == evicted
    assert [item.content for item in await memory.get_recent()] == ["turn-2", "turn-1"]


async def test_working_memory_to_context_uses_recent_content_order() -> None:
    memory = WorkingMemory(k=3)
    await memory.push(MemoryItem(content="first"))
    await memory.push(MemoryItem(content="second"))
    await memory.push(MemoryItem(content="third"))

    assert await memory.to_context(limit=2) == ["third", "second"]


async def test_working_memory_normalizes_non_working_items_to_working_layer() -> None:
    memory = WorkingMemory(k=2)
    await memory.push(
        MemoryItem(
            content="semantic insight",
            layer="semantic",
            metadata={"schema_version": 1, "source": "fixture"},
        )
    )

    recent = await memory.get_recent()

    assert recent[0].content == "semantic insight"
    assert recent[0].layer == "working"
    assert recent[0].metadata["source"] == "fixture"


def test_working_memory_rejects_non_positive_capacity() -> None:
    with pytest.raises(ValueError, match="at least 1"):
        WorkingMemory(k=0)
