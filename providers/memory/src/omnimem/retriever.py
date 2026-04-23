from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any, Protocol

from .kg import KGSearchResult
from .types import MemoryItem, MemoryLayer, validate_memory_layer

DEFAULT_TOP_K = 10
DEFAULT_BM25_LIMIT = 50
DEFAULT_VECTOR_LIMIT = 20
DEFAULT_KG_LIMIT = 20
DEFAULT_KG_MAX_HOPS = 2
DEFAULT_RRF_K = 60
RETRIEVAL_BLOCK_VERSION = "memory-recall-v1"


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


class VectorSearchStore(Protocol):
    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        ...


class KnowledgeGraphStore(Protocol):
    async def search(
        self,
        query: str,
        *,
        max_hops: int = 2,
        limit: int = 10,
        as_of: datetime | str | None = None,
    ) -> list[KGSearchResult]:
        ...


class CandidateReranker(Protocol):
    async def rerank(
        self,
        query: str,
        items: list[MemoryItem],
        *,
        task_context: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        ...


class MemoryRetriever:
    def __init__(
        self,
        store: BM25SearchStore,
        working: WorkingMemorySource | None = None,
        *,
        vector: VectorSearchStore | None = None,
        kg: KnowledgeGraphStore | None = None,
        reranker: CandidateReranker | None = None,
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
        """Fuse L1 working memory with L2 episodic BM25 recall."""
        effective_limit = self._bounded_limit(limit)
        if effective_limit == 0:
            return []

        cache_key = self._build_cache_key(query, task_context, effective_limit)
        working_items = await self._retrieve_working(
            limit=effective_limit,
            cache_key=cache_key,
            block_version=RETRIEVAL_BLOCK_VERSION,
        )
        remaining = effective_limit - len(working_items)
        if remaining <= 0:
            return working_items

        context_filters = self._filters_from_task_context(task_context)
        bm25_items = await self.retrieve_bm25(query, limit=remaining, filters=context_filters)
        vector_items = await self.retrieve_vector(
            query,
            limit=remaining,
            filters=context_filters,
        )
        kg_items = await self.retrieve_kg(query, task_context=task_context, limit=remaining)

        reranked = self._fuse_candidates(
            bm25_items,
            vector_items,
            kg_items,
            cache_key=cache_key,
            block_version=RETRIEVAL_BLOCK_VERSION,
        )
        if self._reranker is not None and reranked:
            reranked = await self._reranker.rerank(
                query,
                reranked,
                task_context=task_context,
            )

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

    async def retrieve_kg(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
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
        )
        return [
            self._kg_result_to_memory_item(result)
            for result in candidates[:effective_limit]
        ]

    async def _retrieve_working(
        self,
        *,
        limit: int,
        cache_key: str,
        block_version: str,
    ) -> list[MemoryItem]:
        if self._working is None or self._working_limit == 0:
            return []

        effective_limit = min(limit, self._working_limit)
        items = await self._working.get_recent(limit=effective_limit)
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

    def _bounded_limit(self, limit: int | None) -> int:
        if limit is None:
            return self._top_k

        return max(limit, 0)

    def _rrf_score(self, rank: int) -> float:
        return (self._rrf_k + 1) / (self._rrf_k + max(rank, 1))

    def _build_cache_key(
        self,
        query: str,
        task_context: dict[str, Any] | None,
        limit: int,
    ) -> str:
        payload = json.dumps(
            {
                "query": query,
                "task_context": task_context or {},
                "limit": limit,
                "block_version": RETRIEVAL_BLOCK_VERSION,
            },
            sort_keys=True,
            default=str,
            ensure_ascii=False,
        )
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        return f"memory-recall:{digest}"

    def _fuse_candidates(
        self,
        *candidate_lists: list[MemoryItem],
        cache_key: str,
        block_version: str,
    ) -> list[MemoryItem]:
        fused: dict[str, dict[str, Any]] = {}
        for candidates in candidate_lists:
            for rank, item in enumerate(candidates, start=1):
                entry = fused.setdefault(
                    item.id,
                    {
                        "item": item,
                        "score": 0.0,
                        "sources": set(),
                        "source_layers": set(),
                        "staleness": item.metadata.get("staleness", "fresh"),
                    },
                )
                entry["score"] += self._rrf_score(rank)
                entry["sources"].add(str(item.metadata.get("source", item.layer)))
                entry["source_layers"].update(self._source_layers_for_item(item))
                if item.metadata.get("staleness") == "stale":
                    entry["staleness"] = "stale"

        ranked = sorted(
            fused.values(),
            key=lambda entry: (-float(entry["score"]), entry["item"].id),
        )
        results: list[MemoryItem] = []
        for entry in ranked:
            sources = sorted(entry["sources"])
            results.append(
                self._with_retrieval_metadata(
                    entry["item"],
                    source=sources[0] if len(sources) == 1 else "hybrid_rrf",
                    score=float(entry["score"]),
                    source_layers=sorted(entry["source_layers"]),
                    cache_key=cache_key,
                    block_version=block_version,
                    staleness=str(entry["staleness"]),
                )
            )

        return results

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
    def _source_layers_for_item(item: MemoryItem) -> list[str]:
        source_layers = item.metadata.get("source_layers")
        if isinstance(source_layers, list):
            normalized = [str(value) for value in source_layers if isinstance(value, str)]
            if normalized:
                return normalized

        source = item.metadata.get("source")
        if source == "kg_subgraph":
            return ["kg"]

        return [str(item.layer)]

    @staticmethod
    def _kg_result_to_memory_item(result: KGSearchResult) -> MemoryItem:
        is_stale = result.valid_to is not None and result.valid_to < datetime.now(UTC)
        return MemoryItem(
            id=f"kg:{result.edge_id}:{result.seed_entity}:{result.depth}",
            content=f"{result.subject} {result.predicate} {result.object}",
            content_type="text",
            layer="semantic",
            metadata={
                "schema_version": 1,
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
            },
            created_at=result.valid_from,
            last_accessed=result.valid_from,
            importance_score=result.weight,
        )

    @staticmethod
    def _with_retrieval_metadata(
        item: MemoryItem,
        *,
        source: str,
        score: float,
        source_layers: list[str] | None = None,
        cache_key: str | None = None,
        block_version: str | None = None,
        staleness: str | None = None,
    ) -> MemoryItem:
        metadata = dict(item.metadata)
        original_source = metadata.get("source")
        if isinstance(original_source, str) and original_source != source:
            metadata.setdefault("memory_source", original_source)

        metadata["schema_version"] = int(metadata.get("schema_version", 1))
        metadata["source"] = source
        metadata["layer"] = item.layer
        metadata["score"] = round(score, 6)
        metadata["staleness"] = staleness or str(metadata.get("staleness", "fresh"))
        metadata["source_layers"] = source_layers or MemoryRetriever._source_layers_for_item(item)
        if cache_key is not None:
            metadata["cache_key"] = cache_key
        if block_version is not None:
            metadata["block_version"] = block_version

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


__all__ = [
    "BM25SearchStore",
    "CandidateReranker",
    "KnowledgeGraphStore",
    "MemoryRetriever",
    "VectorSearchStore",
    "WorkingMemorySource",
]
