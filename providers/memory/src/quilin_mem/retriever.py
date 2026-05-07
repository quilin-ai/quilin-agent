from __future__ import annotations

from typing import Any, Protocol

from .retrieval_profile import RetrievalProfileStore
from .retriever_bm25 import (
    DEFAULT_BM25_LIMIT,
    DEFAULT_RRF_K,
    DIRECT_RECALL_SOURCE,
    RETRIEVAL_BLOCK_VERSION,
    BM25RetrieverMixin,
    BM25SearchStore,
)
from .retriever_kg import (
    DEFAULT_KG_LIMIT,
    DEFAULT_KG_MAX_HOPS,
    KGRetrieverMixin,
    KnowledgeGraphStore,
)
from .retriever_vector import DEFAULT_VECTOR_LIMIT, VectorRetrieverMixin, VectorSearchStore
from .types import MemoryItem

DEFAULT_TOP_K = 10


class WorkingMemorySource(Protocol):
    async def get_recent(self, limit: int | None = None) -> list[MemoryItem]: ...


class CandidateReranker(Protocol):
    async def rerank(
        self,
        query: str,
        items: list[MemoryItem],
        *,
        task_context: dict[str, Any] | None = None,
    ) -> list[MemoryItem]: ...


class MemoryRetriever(BM25RetrieverMixin, VectorRetrieverMixin, KGRetrieverMixin):
    def __init__(
        self,
        store: BM25SearchStore,
        working: WorkingMemorySource | None = None,
        *,
        vector: VectorSearchStore | None = None,
        kg: KnowledgeGraphStore | None = None,
        reranker: CandidateReranker | None = None,
        retrieval_profiles: RetrievalProfileStore | None = None,
        top_k: int = DEFAULT_TOP_K,
        working_limit: int = 5,
        bm25_limit: int = DEFAULT_BM25_LIMIT,
        vector_limit: int = DEFAULT_VECTOR_LIMIT,
        kg_limit: int = DEFAULT_KG_LIMIT,
        kg_max_hops: int = DEFAULT_KG_MAX_HOPS,
        rrf_k: int = DEFAULT_RRF_K,
    ) -> None:
        if top_k < 1:
            raise ValueError("MemoryRetriever.top_k must be at least 1")
        if working_limit < 0:
            raise ValueError("MemoryRetriever.working_limit must be non-negative")
        if bm25_limit < 1:
            raise ValueError("MemoryRetriever.bm25_limit must be at least 1")
        if vector_limit < 1:
            raise ValueError("MemoryRetriever.vector_limit must be at least 1")
        if kg_limit < 1:
            raise ValueError("MemoryRetriever.kg_limit must be at least 1")
        if kg_max_hops < 1:
            raise ValueError("MemoryRetriever.kg_max_hops must be at least 1")
        if rrf_k < 1:
            raise ValueError("MemoryRetriever.rrf_k must be at least 1")

        self._store = store
        self._working = working
        self._vector = vector
        self._kg = kg
        self._reranker = reranker
        self._retrieval_profiles = retrieval_profiles
        self._top_k = top_k
        self._working_limit = working_limit
        self._bm25_limit = bm25_limit
        self._vector_limit = vector_limit
        self._kg_limit = kg_limit
        self._kg_max_hops = kg_max_hops
        self._rrf_k = rrf_k

    async def retrieve(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        """Fuse L1 working memory with L2/L3/L4 recall sources."""
        effective_limit = self._bounded_limit(limit)
        if effective_limit == 0:
            return []

        cache_key = self._build_cache_key(query, task_context, effective_limit)
        context_filters = self._filters_from_task_context(task_context)
        working_items = await self._retrieve_working(
            limit=effective_limit,
            cache_key=cache_key,
            block_version=RETRIEVAL_BLOCK_VERSION,
            context_filters=context_filters,
        )
        remaining = effective_limit - len(working_items)
        if remaining <= 0:
            return working_items

        bm25_items = await self.retrieve_bm25(
            query,
            limit=self._source_limit(remaining, context_filters, self._bm25_limit),
            filters=context_filters,
        )
        bm25_items = self._filter_items_by_context_filters(bm25_items, context_filters)[:remaining]
        vector_items = await self._best_effort(
            "vector",
            self.retrieve_vector(
                query,
                limit=self._source_limit(remaining, context_filters, self._vector_limit),
                filters=context_filters,
            ),
        )
        vector_items = self._filter_items_by_context_filters(vector_items, context_filters)[
            :remaining
        ]
        kg_items = await self._best_effort(
            "kg",
            self.retrieve_kg(
                query,
                task_context=task_context,
                limit=self._source_limit(remaining, context_filters, self._kg_limit),
            ),
        )
        kg_items = self._filter_items_by_context_filters(kg_items, context_filters)[:remaining]

        reranked = self._fuse_candidates(
            bm25_items,
            vector_items,
            kg_items,
            cache_key=cache_key,
            block_version=RETRIEVAL_BLOCK_VERSION,
        )
        if self._reranker is not None and reranked:
            reranked = await self._best_effort(
                "reranker",
                self._reranker.rerank(
                    query,
                    reranked,
                    task_context=task_context,
                ),
                fallback=reranked,
            )
        reranked = self._filter_items_by_context_filters(reranked, context_filters)
        reranked = self._apply_retrieval_profile(reranked, task_context)

        seen_ids = {item.id for item in working_items}
        fused_items = [item for item in reranked if item.id not in seen_ids]
        return working_items + fused_items[:remaining]

    async def recall(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        return await self.retrieve(query, task_context, limit=limit)

    def annotate_recall_results(
        self,
        query: str,
        items: list[MemoryItem],
        task_context: dict[str, Any] | None = None,
        *,
        limit: int | None = None,
    ) -> list[MemoryItem]:
        effective_limit = len(items) if limit is None else max(limit, 0)
        if effective_limit == 0:
            return []

        cache_key = self._build_cache_key(query, task_context, effective_limit)
        return [
            self._with_retrieval_metadata(
                item,
                source=DIRECT_RECALL_SOURCE,
                score=self._rrf_score(rank),
                cache_key=cache_key,
                block_version=RETRIEVAL_BLOCK_VERSION,
                staleness=str(item.metadata.get("staleness", "fresh")),
            )
            for rank, item in enumerate(items[:effective_limit], start=1)
        ]

    def _apply_retrieval_profile(
        self,
        items: list[MemoryItem],
        task_context: dict[str, Any] | None,
    ) -> list[MemoryItem]:
        if self._retrieval_profiles is None or not task_context:
            return items

        user_id = task_context.get("user_id")
        if not isinstance(user_id, str) or not user_id.strip():
            return items

        return self._retrieval_profiles.get(user_id.strip()).apply_to(items)

    async def _retrieve_working(
        self,
        *,
        limit: int,
        cache_key: str,
        block_version: str,
        context_filters: dict[str, Any] | None,
    ) -> list[MemoryItem]:
        if self._working is None or self._working_limit == 0:
            return []

        effective_limit = min(limit, self._working_limit)
        fetch_limit = (
            self._working_limit
            if self._metadata_filters_from_context_filters(context_filters)
            else effective_limit
        )
        items = await self._working.get_recent(limit=fetch_limit)
        items = self._filter_items_by_context_filters(items, context_filters)[:effective_limit]
        return [
            self._with_retrieval_metadata(
                item,
                source="working_direct",
                score=1.0,
                cache_key=cache_key,
                block_version=block_version,
            )
            for item in items
        ]

    @classmethod
    def _filter_items_by_context_filters(
        cls,
        items: list[MemoryItem],
        context_filters: dict[str, Any] | None,
    ) -> list[MemoryItem]:
        metadata_filters = cls._metadata_filters_from_context_filters(context_filters)
        if not metadata_filters:
            return items

        return [
            item
            for item in items
            if all(item.metadata.get(key) == value for key, value in metadata_filters.items())
        ]

    @staticmethod
    def _metadata_filters_from_context_filters(
        context_filters: dict[str, Any] | None,
    ) -> dict[str, object]:
        if not context_filters:
            return {}

        metadata_filters = context_filters.get("metadata")
        if not isinstance(metadata_filters, dict):
            return {}

        return {
            str(key): value
            for key, value in metadata_filters.items()
            if isinstance(key, str)
        }

    def _source_limit(
        self,
        limit: int,
        context_filters: dict[str, Any] | None,
        configured_limit: int,
    ) -> int:
        if self._metadata_filters_from_context_filters(context_filters):
            return max(limit, configured_limit)

        return limit


__all__ = [
    "BM25SearchStore",
    "CandidateReranker",
    "KnowledgeGraphStore",
    "MemoryRetriever",
    "VectorSearchStore",
    "WorkingMemorySource",
]
