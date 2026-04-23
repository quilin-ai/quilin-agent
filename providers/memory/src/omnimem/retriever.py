from __future__ import annotations

from typing import Any, Protocol

from .types import MemoryItem, MemoryLayer, validate_memory_layer

DEFAULT_TOP_K = 10
DEFAULT_BM25_LIMIT = 50
DEFAULT_RRF_K = 60


class BM25SearchStore(Protocol):
    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        ...


class WorkingMemorySource(Protocol):
    async def get_recent(self, limit: int | None = None) -> list[MemoryItem]:
        ...


class MemoryRetriever:
    def __init__(
        self,
        store: BM25SearchStore,
        working: WorkingMemorySource | None = None,
        *,
        top_k: int = DEFAULT_TOP_K,
        working_limit: int = 5,
        bm25_limit: int = DEFAULT_BM25_LIMIT,
        rrf_k: int = DEFAULT_RRF_K,
    ) -> None:
        if top_k < 1:
            raise ValueError("MemoryRetriever.top_k must be at least 1")
        if working_limit < 0:
            raise ValueError("MemoryRetriever.working_limit must be non-negative")
        if bm25_limit < 1:
            raise ValueError("MemoryRetriever.bm25_limit must be at least 1")
        if rrf_k < 1:
            raise ValueError("MemoryRetriever.rrf_k must be at least 1")

        self._store = store
        self._working = working
        self._top_k = top_k
        self._working_limit = working_limit
        self._bm25_limit = bm25_limit
        self._rrf_k = rrf_k

    async def retrieve(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        """Fuse L1 working memory with L2 episodic BM25 recall."""
        effective_limit = self._bounded_limit(limit)
        if effective_limit == 0:
            return []

        working_items = await self._retrieve_working(limit=effective_limit)
        remaining = effective_limit - len(working_items)
        if remaining <= 0:
            return working_items

        context_filters = self._filters_from_task_context(task_context)
        bm25_items = await self.retrieve_bm25(
            query,
            limit=effective_limit,
            filters=context_filters,
        )
        seen_ids = {item.id for item in working_items}
        episodic_items = [item for item in bm25_items if item.id not in seen_ids]

        return working_items + episodic_items[:remaining]

    async def recall(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        return await self.retrieve(query, task_context, limit=limit)

    async def retrieve_bm25(
        self,
        query: str,
        *,
        limit: int | None = None,
        layer: MemoryLayer | None = "episodic",
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        """Retrieve by local SQLite FTS5/BM25 ordering without vector dependencies."""
        effective_limit = self._bounded_limit(limit)
        if effective_limit == 0:
            return []

        search_filters = self._build_filters(layer=layer, filters=filters)
        candidates = await self._store.search(
            query,
            limit=max(effective_limit, self._bm25_limit),
            filters=search_filters,
        )
        scored = [
            self._with_retrieval_metadata(
                item,
                source="bm25_fts",
                score=self._rrf_score(rank),
            )
            for rank, item in enumerate(candidates, start=1)
        ]

        return scored[:effective_limit]

    async def _retrieve_working(self, *, limit: int) -> list[MemoryItem]:
        if self._working is None or self._working_limit == 0:
            return []

        effective_limit = min(limit, self._working_limit)
        items = await self._working.get_recent(limit=effective_limit)
        return [
            self._with_retrieval_metadata(
                item,
                source="working_direct",
                score=1.0,
            )
            for item in items
        ]

    def _bounded_limit(self, limit: int | None) -> int:
        if limit is None:
            return self._top_k

        return max(limit, 0)

    def _rrf_score(self, rank: int) -> float:
        return (self._rrf_k + 1) / (self._rrf_k + max(rank, 1))

    @staticmethod
    def _filters_from_task_context(
        task_context: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not task_context:
            return None

        context_filters = task_context.get("filters")
        filters = dict(context_filters) if isinstance(context_filters, dict) else {}

        metadata_filters = filters.get("metadata")
        metadata = dict(metadata_filters) if isinstance(metadata_filters, dict) else {}
        for metadata_key in ("session_id", "user_id"):
            value = task_context.get(metadata_key)
            if isinstance(value, str) and value:
                metadata[metadata_key] = value
        if metadata:
            filters["metadata"] = metadata

        for context_key, filter_key in (
            ("created_after", "created_after"),
            ("created_before", "created_before"),
            ("start_time", "created_after"),
            ("end_time", "created_before"),
        ):
            if context_key in task_context and filter_key not in filters:
                filters[filter_key] = task_context[context_key]

        return filters or None

    @staticmethod
    def _build_filters(
        *,
        layer: MemoryLayer | None,
        filters: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        resolved_filters = dict(filters or {})
        if layer is not None:
            resolved_filters["layer"] = validate_memory_layer(layer)

        return resolved_filters or None

    @staticmethod
    def _with_retrieval_metadata(
        item: MemoryItem,
        *,
        source: str,
        score: float,
    ) -> MemoryItem:
        metadata = dict(item.metadata)
        original_source = metadata.get("source")
        if isinstance(original_source, str) and original_source != source:
            metadata.setdefault("memory_source", original_source)

        metadata["schema_version"] = int(metadata.get("schema_version", 1))
        metadata["source"] = source
        metadata["layer"] = item.layer
        metadata["score"] = round(score, 6)
        metadata.setdefault("staleness", "fresh")

        return MemoryItem(
            id=item.id,
            content=item.content,
            content_type=item.content_type,
            layer=item.layer,
            metadata=metadata,
            embedding=item.embedding,
            created_at=item.created_at,
            last_accessed=item.last_accessed,
            access_count=item.access_count,
            importance_score=item.importance_score,
        )


__all__ = ["BM25SearchStore", "MemoryRetriever", "WorkingMemorySource"]
