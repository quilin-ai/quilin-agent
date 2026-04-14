from __future__ import annotations

from .types import MemoryRecord


class OmniMemStore:
    def __init__(self) -> None:
        self._records: list[MemoryRecord] = []

    async def recall(self, query: str) -> list[MemoryRecord]:
        _ = query
        return list(self._records)

    async def store(self, record: MemoryRecord) -> None:
        self._records.append(record)
