from __future__ import annotations

import hashlib
import json
from typing import Any, Protocol

from .logging import logger
from .types import MemoryItem, MemoryLayer, memory_item_with, validate_memory_layer

DEFAULT_BM25_LIMIT = 50
DEFAULT_RRF_K = 60
RETRIEVAL_BLOCK_VERSION = "memory-recall-v1"
DIRECT_RECALL_SOURCE = "direct_recall"


class BM25SearchStore(Protocol):
    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]: ...


class BM25RetrieverMixin:
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

    async def _best_effort(
        self,
        source: str,
        operation: Any,
        *,
        fallback: list[MemoryItem] | None = None,
    ) -> list[MemoryItem]:
        try:
            result = await operation
        except Exception as exc:
            logger.warn("memory retriever source failed", source=source, error=str(exc))
            return [] if fallback is None else fallback

        return list(result)

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

    def _with_retrieval_metadata(
        self,
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
        metadata["source_layers"] = source_layers or self._source_layers_for_item(item)
        if cache_key is not None:
            metadata["cache_key"] = cache_key
        if block_version is not None:
            metadata["block_version"] = block_version

        return memory_item_with(item, metadata=metadata)
