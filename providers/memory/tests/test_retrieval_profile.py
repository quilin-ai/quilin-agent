from __future__ import annotations

from pathlib import Path

from omnimem.retrieval_profile import (
    DEFAULT_RETRIEVAL_WEIGHTS,
    RetrievalProfileStore,
    RetrievalWeightProfile,
)
from omnimem.types import MemoryItem


def test_retrieval_profile_defaults_to_global_weights(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))

    profile = store.get("user-1")

    assert profile.user_id == "user-1"
    assert profile.weights == DEFAULT_RETRIEVAL_WEIGHTS


def test_retrieval_profile_persists_independently_from_user_profile(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))

    updated = store.update_weights("user-1", {"bm25_fts": 1.5, "vector_semantic": 0.25})

    assert updated.weights["bm25_fts"] == 1.5
    assert store.get("user-1").weights["vector_semantic"] == 0.25


def test_weighted_sort_is_stable_for_equal_scores() -> None:
    profile = RetrievalWeightProfile(user_id="user-1", weights={"bm25_fts": 1.0})
    items = [
        MemoryItem(id="b", content="second", metadata={"schema_version": 1, "score": 0.5}),
        MemoryItem(id="a", content="first", metadata={"schema_version": 1, "score": 0.5}),
    ]

    ranked = profile.apply_to(items)

    assert [item.id for item in ranked] == ["a", "b"]
    assert ranked[0].metadata["weighted_score"] == 0.5


def test_weight_updates_change_ranking_deterministically() -> None:
    profile = RetrievalWeightProfile(user_id="user-1", weights={"vector_semantic": 2.0})
    items = [
        MemoryItem(
            id="bm25",
            content="bm25",
            metadata={"schema_version": 1, "source": "bm25_fts", "score": 0.7},
        ),
        MemoryItem(
            id="vector",
            content="vector",
            metadata={"schema_version": 1, "source": "vector_semantic", "score": 0.4},
        ),
    ]

    assert [item.id for item in profile.apply_to(items)] == ["vector", "bm25"]
