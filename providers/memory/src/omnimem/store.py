from __future__ import annotations

import uuid

from .types import MemoryRecord


class OmniMemStore:
    def __init__(self) -> None:
        self._records: list[MemoryRecord] = []

    def reset(self) -> None:
        self._records.clear()

    async def recall(self, query: str) -> list[MemoryRecord]:
        if not query:
            return list(self._records)
        lower_query = query.lower()
        return [r for r in self._records if lower_query in r.content.lower()]

    async def store(self, content: str, tier: str = "short") -> MemoryRecord:
        record = MemoryRecord(id=str(uuid.uuid4()), content=content, tier=tier)
        self._records.append(record)
        return record
