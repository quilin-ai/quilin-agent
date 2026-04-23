from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Protocol, cast

from .types import MemoryItem


class SupportsMemoryStore(Protocol):
    async def add(self, memory: MemoryItem) -> str: ...

    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]: ...

    async def clear_layer(self, layer: str) -> int: ...


class EpisodicMemory:
    def __init__(self, store: SupportsMemoryStore) -> None:
        self._store = store

    async def add(self, memory: MemoryItem) -> MemoryItem:
        item = self._as_episodic_item(memory)
        await self._store.add(item)
        return item

    async def compress_and_add(self, memory: MemoryItem) -> MemoryItem:
        return await self.add(memory)

    async def search(
        self,
        query: str,
        *,
        limit: int = 10,
        session_id: str | None = None,
        user_id: str | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> list[MemoryItem]:
        filters = self._build_search_filters(
            session_id=session_id,
            user_id=user_id,
            start_time=start_time,
            end_time=end_time,
        )
        return await self._store.search(query, limit=limit, filters=filters)

    async def discard_all(self) -> int:
        return await self._store.clear_layer("episodic")

    async def save_checkpoint(
        self,
        checkpoint: dict[str, Any],
        *,
        run_id: str,
        event_seq: int,
        phase: str,
        task_hash: str,
        session_id: str | None = None,
        user_id: str | None = None,
        created_at: datetime | None = None,
    ) -> MemoryItem:
        metadata: dict[str, object] = {
            "schema_version": 1,
            "source": "checkpoint-writer",
            "run_id": run_id,
            "event_seq": event_seq,
            "phase": phase,
            "task_hash": task_hash,
        }
        if session_id is not None:
            metadata["session_id"] = session_id
        if user_id is not None:
            metadata["user_id"] = user_id

        return await self.add(
            MemoryItem(
                content=json.dumps(checkpoint, ensure_ascii=False, sort_keys=True),
                content_type="json",
                layer="episodic",
                metadata=metadata,
                created_at=created_at,
                last_accessed=created_at,
            )
        )

    async def load_checkpoint(
        self,
        run_id: str,
        *,
        event_seq: int | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any] | None:
        metadata: dict[str, object] = {
            "source": "checkpoint-writer",
            "run_id": run_id,
        }
        if event_seq is not None:
            metadata["event_seq"] = event_seq
        if session_id is not None:
            metadata["session_id"] = session_id

        items = await self._store.search(
            "",
            limit=1_000,
            filters={
                "layer": "episodic",
                "content_type": "json",
                "metadata": metadata,
            },
        )
        if not items:
            return None

        latest = max(items, key=self._checkpoint_order_key)
        return cast(dict[str, Any], json.loads(latest.content))

    @staticmethod
    def _as_episodic_item(memory: MemoryItem) -> MemoryItem:
        if memory.layer == "episodic":
            return memory

        payload = memory.to_wire_dict(include_legacy_tier=False)
        payload["layer"] = "episodic"
        metadata = dict(memory.metadata)
        metadata.setdefault("schema_version", 1)
        payload["metadata"] = metadata
        return MemoryItem.from_dict(payload)

    @staticmethod
    def _build_search_filters(
        *,
        session_id: str | None,
        user_id: str | None,
        start_time: datetime | None,
        end_time: datetime | None,
    ) -> dict[str, Any]:
        filters: dict[str, Any] = {"layer": "episodic"}
        metadata: dict[str, object] = {}
        if session_id is not None:
            metadata["session_id"] = session_id
        if user_id is not None:
            metadata["user_id"] = user_id
        if metadata:
            filters["metadata"] = metadata
        if start_time is not None:
            filters["created_after"] = start_time
        if end_time is not None:
            filters["created_before"] = end_time
        return filters

    @staticmethod
    def _checkpoint_order_key(memory: MemoryItem) -> tuple[int, str]:
        event_seq = memory.metadata.get("event_seq", -1)
        return int(event_seq), memory.created_at.isoformat()


__all__ = ["EpisodicMemory"]
