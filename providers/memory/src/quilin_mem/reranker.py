from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .event_log import RetrievalEventLog
from .types import MemoryItem, memory_item_with

DEFAULT_SOURCE_PRIORS = {
    "working_direct": 0.65,
    "hybrid_rrf": 0.55,
    "vector_semantic": 0.45,
    "bm25_fts": 0.35,
    "direct_recall": 0.35,
    "kg_subgraph": 0.25,
}


@dataclass(slots=True, frozen=True)
class RerankerWeights:
    bias: float = -0.75
    retrieval_score: float = 1.75
    recency: float = 0.45
    citation_rate: float = 1.4
    graph_distance: float = 0.3
    source_prior: float = 0.5


class LearnableReranker:
    def __init__(
        self,
        event_log: RetrievalEventLog | None = None,
        *,
        weights: RerankerWeights | None = None,
        source_priors: dict[str, float] | None = None,
    ) -> None:
        self._event_log = event_log
        self._weights = weights or RerankerWeights()
        self._source_priors = dict(DEFAULT_SOURCE_PRIORS)
        if source_priors is not None:
            self._source_priors.update(source_priors)

    async def rerank(
        self,
        query: str,
        items: list[MemoryItem],
        *,
        task_context: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        del query, task_context
        if not items:
            return []

        stats = {}
        if self._event_log is not None:
            stats = await self._event_log.citation_stats([item.id for item in items])

        scored = [(item, self._score_item(item, stats.get(item.id))) for item in items]
        scored.sort(key=lambda pair: (-pair[1], pair[0].id))

        reranked: list[MemoryItem] = []
        for rank, (item, score) in enumerate(scored, start=1):
            reranked.append(self._with_reranker_metadata(item, score=score, rank=rank))

        return reranked

    def _score_item(
        self,
        item: MemoryItem,
        citation_stats: object | None,
    ) -> float:
        metadata = item.metadata
        retrieval_score = float(metadata.get("score", 0.0))
        recency_score = self._recency_score(item)
        citation_rate = (
            citation_stats.citation_rate
            if citation_stats is not None and hasattr(citation_stats, "citation_rate")
            else 0.0
        )
        graph_distance = metadata.get("graph_distance")
        graph_score = 0.0
        if isinstance(graph_distance, int) and graph_distance >= 0:
            graph_score = 1.0 / (1 + graph_distance)
        source = str(metadata.get("source", item.layer))
        source_prior = self._source_priors.get(source, 0.2)

        linear_score = (
            self._weights.bias
            + self._weights.retrieval_score * retrieval_score
            + self._weights.recency * recency_score
            + self._weights.citation_rate * citation_rate
            + self._weights.graph_distance * graph_score
            + self._weights.source_prior * source_prior
        )
        return 1.0 / (1.0 + math.exp(-linear_score))

    @staticmethod
    def _recency_score(item: MemoryItem) -> float:
        age_seconds = max((datetime.now(UTC) - item.last_accessed).total_seconds(), 0.0)
        age_days = age_seconds / 86_400
        return 1.0 / (1.0 + age_days)

    @staticmethod
    def _with_reranker_metadata(
        item: MemoryItem,
        *,
        score: float,
        rank: int,
    ) -> MemoryItem:
        metadata = dict(item.metadata)
        metadata["schema_version"] = int(metadata.get("schema_version", 1))
        metadata["retrieval_score"] = float(metadata.get("score", 0.0))
        metadata["reranker_score"] = round(score, 6)
        metadata["reranker_rank"] = rank
        metadata["score"] = round(score, 6)
        return memory_item_with(item, metadata=metadata)


__all__ = ["DEFAULT_SOURCE_PRIORS", "LearnableReranker", "RerankerWeights"]
