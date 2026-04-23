from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from typing import Protocol

from .types import MemoryItem


class EpisodicCandidateStore(Protocol):
    async def compress_and_add(self, memory: MemoryItem) -> MemoryItem:
        ...


class WorkingMemory:
    def __init__(
        self,
        k: int = 5,
        episodic: EpisodicCandidateStore | None = None,
    ) -> None:
        if k < 1:
            raise ValueError("WorkingMemory.k must be at least 1")

        self._capacity = k
        self._buffer: deque[MemoryItem] = deque()
        self._pending_candidates: deque[MemoryItem] = deque()
        self._episodic = episodic

    async def push(self, memory: MemoryItem) -> MemoryItem | None:
        candidate: MemoryItem | None = None
        if len(self._buffer) >= self._capacity:
            candidate = self._build_episodic_candidate(self._buffer.popleft())
            self._pending_candidates.append(candidate)
            if self._episodic is not None:
                await self._episodic.compress_and_add(candidate)

        self._buffer.append(self._as_working_item(memory))
        return candidate

    async def get_recent(self, limit: int | None = None) -> list[MemoryItem]:
        items = list(reversed(self._buffer))
        if limit is None:
            return items

        return items[: max(limit, 0)]

    async def to_context(self, limit: int | None = None) -> list[str]:
        return [item.content for item in await self.get_recent(limit=limit)]

    async def drain_episodic_candidates(self) -> list[MemoryItem]:
        drained = list(self._pending_candidates)
        self._pending_candidates.clear()
        return drained

    def __len__(self) -> int:
        return len(self._buffer)

    @staticmethod
    def _as_working_item(memory: MemoryItem) -> MemoryItem:
        if memory.layer == "working":
            return memory

        payload = memory.to_wire_dict(include_legacy_tier=False)
        payload["layer"] = "working"
        return MemoryItem.from_dict(payload)

    @staticmethod
    def _build_episodic_candidate(memory: MemoryItem) -> MemoryItem:
        metadata = dict(memory.metadata)
        metadata.setdefault("schema_version", 1)
        metadata.setdefault("source", "working_memory_eviction")
        metadata["origin_layer"] = memory.layer
        return MemoryItem(
            id=memory.id,
            content=memory.content,
            content_type=memory.content_type,
            layer="episodic",
            metadata=metadata,
            embedding=memory.embedding,
            created_at=memory.created_at,
            last_accessed=memory.last_accessed,
            access_count=memory.access_count,
            importance_score=memory.importance_score,
        )


__all__: Sequence[str] = ("EpisodicCandidateStore", "WorkingMemory")
