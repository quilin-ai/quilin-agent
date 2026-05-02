from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol

from .kg_validation import KGSearchResult
from .types import MemoryItem

DEFAULT_KG_LIMIT = 20
DEFAULT_KG_MAX_HOPS = 2


class KnowledgeGraphStore(Protocol):
    async def search(
        self,
        query: str,
        *,
        max_hops: int = 2,
        limit: int = 10,
        as_of: datetime | str | None = None,
        filters: dict[str, Any] | None = None,
    ) -> list[KGSearchResult]: ...


class KGRetrieverMixin:
    async def retrieve_kg(
        self,
        query: str,
        task_context: dict[str, object] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        if self._kg is None:
            return []

        effective_limit = self._bounded_limit(limit)
        if effective_limit == 0:
            return []

        max_hops = self._kg_max_hops
        if task_context is not None:
            raw_hops = task_context.get("kg_max_hops")
            if isinstance(raw_hops, int) and raw_hops >= 1:
                max_hops = raw_hops

        as_of = task_context.get("as_of") if isinstance(task_context, dict) else None
        candidates = await self._kg.search(
            query,
            max_hops=max_hops,
            limit=max(effective_limit, self._kg_limit),
            as_of=as_of,
            filters=self._filters_from_task_context(task_context),
        )
        return [self._kg_result_to_memory_item(result) for result in candidates[:effective_limit]]

    @staticmethod
    def _kg_result_to_memory_item(result: KGSearchResult) -> MemoryItem:
        is_stale = result.valid_to is not None and result.valid_to < datetime.now(UTC)
        metadata = dict(result.metadata)
        schema_version = metadata.get("schema_version", 1)
        metadata.update(
            {
                "schema_version": schema_version if isinstance(schema_version, int) else 1,
                "source": "kg_subgraph",
                "graph_distance": result.depth,
                "seed_entity": result.seed_entity,
                "memory_id": result.memory_id,
                "valid_from": result.valid_from.isoformat(),
                "valid_to": (
                    result.valid_to.isoformat() if result.valid_to is not None else None
                ),
                "staleness": "stale" if is_stale else "fresh",
                "source_layers": ["kg"],
            }
        )
        return MemoryItem(
            id=f"kg:{result.edge_id}:{result.seed_entity}:{result.depth}",
            content=f"{result.subject} {result.predicate} {result.object}",
            content_type="text",
            layer="semantic",
            metadata=metadata,
            created_at=result.valid_from,
            last_accessed=result.valid_from,
            importance_score=result.weight,
        )
