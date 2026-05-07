from __future__ import annotations

from typing import Any, Protocol

from .types import MemoryItem, MemoryLayer

DEFAULT_VECTOR_LIMIT = 20


class VectorSearchStore(Protocol):
    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]: ...


class VectorRetrieverMixin:
    async def retrieve_vector(
        self,
        query: str,
        *,
        limit: int | None = None,
        layer: MemoryLayer | None = "semantic",
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        if self._vector is None:
            return []

        effective_limit = self._bounded_limit(limit)
        if effective_limit == 0:
            return []

        search_filters = self._build_filters(layer=layer, filters=filters)
        candidates = await self._vector.search(
            query,
            limit=max(effective_limit, self._vector_limit),
            filters=search_filters,
        )
        scored = [
            self._with_retrieval_metadata(
                item,
                source="vector_semantic",
                score=self._rrf_score(rank),
            )
            for rank, item in enumerate(candidates, start=1)
        ]

        return scored[:effective_limit]
