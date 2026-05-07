from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from quilin_mem.retrieval_profile import (
    DEFAULT_RETRIEVAL_WEIGHTS,
    RetrievalProfileHealthComparison,
    RetrievalProfileHealthSnapshot,
    RetrievalProfileHealthSnapshotPair,
    RetrievalProfileStore,
    RetrievalWeightProfile,
    compare_retrieval_profile_health_snapshot_pairs,
    compare_retrieval_profile_health_snapshots,
    preview_retrieval_profile_health_update,
    preview_retrieval_profile_health_updates,
    retrieval_profile_health,
    retrieval_profile_health_snapshot,
    summarize_retrieval_profile_health_comparisons,
)
from quilin_mem.types import MemoryItem

RetrievalProfileHealthSnapshotPairInput = (
    RetrievalProfileHealthSnapshotPair
    | tuple[RetrievalProfileHealthSnapshot, RetrievalProfileHealthSnapshot]
)


def _stored_retrieval_profiles(db_path: Path) -> dict[str, dict[str, float]]:
    with sqlite3.connect(str(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT user_id, weights_json
            FROM retrieval_weight_profiles
            ORDER BY user_id
            """
        ).fetchall()

    return {str(row["user_id"]): json.loads(str(row["weights_json"])) for row in rows}


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


def test_store_health_snapshot_reports_default_profile(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))

    snapshot = store.health_snapshot("user-1")

    assert snapshot.profile_name == "user-1"
    assert snapshot.weights == DEFAULT_RETRIEVAL_WEIGHTS
    assert snapshot.health.status == "incomplete"
    assert snapshot.health.missing_axes == ("bm25", "vector", "kg")


def test_store_health_snapshot_reports_updated_profile(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))
    store.update_weights(
        "user-1",
        {
            "bm25_fts": 1.5,
            "vector_semantic": 0.25,
            "kg_subgraph": 0.75,
        },
    )

    snapshot = store.health_snapshot("user-1")

    assert snapshot.profile_name == "user-1"
    assert snapshot.weights["bm25_fts"] == 1.5
    assert snapshot.weights["vector_semantic"] == 0.25
    assert snapshot.weights["kg_subgraph"] == 0.75
    assert snapshot.health.status == "healthy"
    assert snapshot.health.missing_axes == ()


def test_store_health_snapshot_to_dict_is_stable(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))
    store.update_weights(
        "user-1",
        {
            "vector_semantic": 0.25,
            "kg_subgraph": 0.75,
            "bm25_fts": 1.5,
        },
    )

    snapshot_dict = store.health_snapshot("user-1").to_dict()

    assert list(snapshot_dict["weights"]) == [
        "bm25",
        "bm25_fts",
        "kg",
        "kg_subgraph",
        "recency",
        "vector",
        "vector_semantic",
        "working",
    ]
    assert snapshot_dict == {
        "profile_name": "user-1",
        "weights": {
            "bm25": 1.0,
            "bm25_fts": 1.5,
            "kg": 1.0,
            "kg_subgraph": 0.75,
            "recency": 0.0,
            "vector": 1.0,
            "vector_semantic": 0.25,
            "working": 1.0,
        },
        "health": {
            "status": "healthy",
            "checked_axes": ["bm25", "vector", "kg"],
            "missing_axes": [],
            "risk_codes": [],
            "recommendations": [],
        },
    }


def test_store_health_snapshot_reports_missing_axes(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))
    store.update_weights("user-1", {"vector_semantic": 0.25})

    snapshot = store.health_snapshot("user-1")

    assert snapshot.health.status == "incomplete"
    assert snapshot.health.missing_axes == ("bm25", "kg")
    assert snapshot.health.risk_codes == (
        "missing_bm25_retrieval_weight",
        "missing_kg_retrieval_weight",
    )


def test_store_preview_weight_update_does_not_persist(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))
    store.update_weights("user-1", {"bm25_fts": 1.0})

    preview = store.preview_weight_update("user-1", {"vector_semantic": 0.5})
    preview_unset = store.preview_weight_update("user-1", {"bm25_fts": None})

    persisted = store.get("user-1")
    assert persisted.weights == preview.before.weights
    assert "vector_semantic" not in persisted.weights
    assert preview.before.health.missing_axes == ("vector", "kg")
    assert preview.after.weights["vector_semantic"] == 0.5
    assert preview.after.health.missing_axes == ("kg",)
    assert preview_unset.before.weights == persisted.weights
    assert preview_unset.after.health.missing_axes == ("bm25", "vector", "kg")
    assert store.get("user-1").weights == persisted.weights


def test_store_preview_weight_updates_reads_profiles_in_order_without_mutation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    store = RetrievalProfileStore(str(db_path))
    persisted = store.update_weights("persisted", {"bm25_fts": 1.0})
    rows_before_preview = _stored_retrieval_profiles(db_path)

    batch = store.preview_weight_updates(
        [
            (
                "non-persisted",
                {
                    "bm25_fts": 0.9,
                    "vector_semantic": 0.7,
                    "kg_subgraph": 0.5,
                },
            ),
            (
                "persisted",
                {
                    "vector_semantic": 0.4,
                    "kg_subgraph": 0.2,
                },
            ),
            ("second-default", {"kg_subgraph": 0.3}),
        ]
    )

    assert [preview.before.profile_name for preview in batch.previews] == [
        "non-persisted",
        "persisted",
        "second-default",
    ]
    assert [comparison.before_status for comparison in batch.report.comparisons] == [
        "incomplete",
        "incomplete",
        "incomplete",
    ]
    assert batch.previews[0].before.weights == DEFAULT_RETRIEVAL_WEIGHTS
    assert batch.previews[0].after.health.status == "healthy"
    assert batch.previews[1].before.weights == persisted.weights
    assert batch.previews[1].after.weights["vector_semantic"] == 0.4
    assert batch.previews[1].after.weights["kg_subgraph"] == 0.2
    assert batch.previews[2].before.weights == DEFAULT_RETRIEVAL_WEIGHTS
    assert batch.previews[2].after.health.missing_axes == ("bm25", "vector")
    assert _stored_retrieval_profiles(db_path) == rows_before_preview
    assert store.get("persisted").weights == persisted.weights


def test_store_preview_weight_updates_handles_empty_input_without_persistence(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    store = RetrievalProfileStore(str(db_path))
    persisted = store.update_weights("persisted", {"bm25_fts": 1.0})
    rows_before_preview = _stored_retrieval_profiles(db_path)

    batch = store.preview_weight_updates([])

    assert batch.previews == ()
    assert batch.report.comparisons == ()
    assert batch.to_dict() == {
        "previews": [],
        "report": {
            "comparisons": [],
            "summary": {
                "total": 0,
                "by_change_classification": {
                    "improved": 0,
                    "regressed": 0,
                    "mixed": 0,
                    "unchanged": 0,
                },
                "improved_axes": {},
                "regressed_axes": {},
                "resolved_risk_codes": {},
                "new_risk_codes": {},
            },
        },
    }
    assert store.get("persisted").weights == persisted.weights
    assert _stored_retrieval_profiles(db_path) == rows_before_preview


def test_store_preview_weight_updates_to_dict_is_stable(tmp_path: Path) -> None:
    store = RetrievalProfileStore(str(tmp_path / "memory.db"))
    store.update_weights(
        "persisted",
        {
            "kg_subgraph": 0.7,
            "bm25_fts": 1.3,
        },
    )

    batch_dict = store.preview_weight_updates(
        [
            ("persisted", {"vector_semantic": 0.4}),
            ("default-user", {"kg_subgraph": 0.2}),
        ]
    ).to_dict()

    assert list(batch_dict) == ["previews", "report"]
    assert batch_dict == {
        "previews": [
            {
                "before": {
                    "profile_name": "persisted",
                    "weights": {
                        "bm25": 1.0,
                        "bm25_fts": 1.3,
                        "kg": 1.0,
                        "kg_subgraph": 0.7,
                        "recency": 0.0,
                        "vector": 1.0,
                        "working": 1.0,
                    },
                    "health": {
                        "status": "incomplete",
                        "checked_axes": ["bm25", "vector", "kg"],
                        "missing_axes": ["vector"],
                        "risk_codes": ["missing_vector_retrieval_weight"],
                        "recommendations": [
                            "Set an explicit vector_semantic weight before retrieval reevaluation.",
                        ],
                    },
                },
                "after": {
                    "profile_name": "persisted",
                    "weights": {
                        "bm25": 1.0,
                        "bm25_fts": 1.3,
                        "kg": 1.0,
                        "kg_subgraph": 0.7,
                        "recency": 0.0,
                        "vector": 1.0,
                        "vector_semantic": 0.4,
                        "working": 1.0,
                    },
                    "health": {
                        "status": "healthy",
                        "checked_axes": ["bm25", "vector", "kg"],
                        "missing_axes": [],
                        "risk_codes": [],
                        "recommendations": [],
                    },
                },
                "comparison": {
                    "before_status": "incomplete",
                    "after_status": "healthy",
                    "change_classification": "improved",
                    "improved_axes": ["vector"],
                    "regressed_axes": [],
                    "resolved_risk_codes": ["missing_vector_retrieval_weight"],
                    "new_risk_codes": [],
                    "unchanged_risk_codes": [],
                },
                "report": {
                    "comparisons": [
                        {
                            "before_status": "incomplete",
                            "after_status": "healthy",
                            "change_classification": "improved",
                            "improved_axes": ["vector"],
                            "regressed_axes": [],
                            "resolved_risk_codes": [
                                "missing_vector_retrieval_weight",
                            ],
                            "new_risk_codes": [],
                            "unchanged_risk_codes": [],
                        }
                    ],
                    "summary": {
                        "total": 1,
                        "by_change_classification": {
                            "improved": 1,
                            "regressed": 0,
                            "mixed": 0,
                            "unchanged": 0,
                        },
                        "improved_axes": {"vector": 1},
                        "regressed_axes": {},
                        "resolved_risk_codes": {
                            "missing_vector_retrieval_weight": 1,
                        },
                        "new_risk_codes": {},
                    },
                },
            },
            {
                "before": {
                    "profile_name": "default-user",
                    "weights": {
                        "bm25": 1.0,
                        "kg": 1.0,
                        "recency": 0.0,
                        "vector": 1.0,
                        "working": 1.0,
                    },
                    "health": {
                        "status": "incomplete",
                        "checked_axes": ["bm25", "vector", "kg"],
                        "missing_axes": ["bm25", "vector", "kg"],
                        "risk_codes": [
                            "missing_bm25_retrieval_weight",
                            "missing_vector_retrieval_weight",
                            "missing_kg_retrieval_weight",
                        ],
                        "recommendations": [
                            "Set an explicit bm25_fts weight before retrieval reevaluation.",
                            "Set an explicit vector_semantic weight before retrieval reevaluation.",
                            "Set an explicit kg_subgraph weight before retrieval reevaluation.",
                        ],
                    },
                },
                "after": {
                    "profile_name": "default-user",
                    "weights": {
                        "bm25": 1.0,
                        "kg": 1.0,
                        "kg_subgraph": 0.2,
                        "recency": 0.0,
                        "vector": 1.0,
                        "working": 1.0,
                    },
                    "health": {
                        "status": "incomplete",
                        "checked_axes": ["bm25", "vector", "kg"],
                        "missing_axes": ["bm25", "vector"],
                        "risk_codes": [
                            "missing_bm25_retrieval_weight",
                            "missing_vector_retrieval_weight",
                        ],
                        "recommendations": [
                            "Set an explicit bm25_fts weight before retrieval reevaluation.",
                            "Set an explicit vector_semantic weight before retrieval reevaluation.",
                        ],
                    },
                },
                "comparison": {
                    "before_status": "incomplete",
                    "after_status": "incomplete",
                    "change_classification": "improved",
                    "improved_axes": ["kg"],
                    "regressed_axes": [],
                    "resolved_risk_codes": ["missing_kg_retrieval_weight"],
                    "new_risk_codes": [],
                    "unchanged_risk_codes": [
                        "missing_bm25_retrieval_weight",
                        "missing_vector_retrieval_weight",
                    ],
                },
                "report": {
                    "comparisons": [
                        {
                            "before_status": "incomplete",
                            "after_status": "incomplete",
                            "change_classification": "improved",
                            "improved_axes": ["kg"],
                            "regressed_axes": [],
                            "resolved_risk_codes": [
                                "missing_kg_retrieval_weight",
                            ],
                            "new_risk_codes": [],
                            "unchanged_risk_codes": [
                                "missing_bm25_retrieval_weight",
                                "missing_vector_retrieval_weight",
                            ],
                        }
                    ],
                    "summary": {
                        "total": 1,
                        "by_change_classification": {
                            "improved": 1,
                            "regressed": 0,
                            "mixed": 0,
                            "unchanged": 0,
                        },
                        "improved_axes": {"kg": 1},
                        "regressed_axes": {},
                        "resolved_risk_codes": {
                            "missing_kg_retrieval_weight": 1,
                        },
                        "new_risk_codes": {},
                    },
                },
            },
        ],
        "report": {
            "comparisons": [
                {
                    "before_status": "incomplete",
                    "after_status": "healthy",
                    "change_classification": "improved",
                    "improved_axes": ["vector"],
                    "regressed_axes": [],
                    "resolved_risk_codes": ["missing_vector_retrieval_weight"],
                    "new_risk_codes": [],
                    "unchanged_risk_codes": [],
                },
                {
                    "before_status": "incomplete",
                    "after_status": "incomplete",
                    "change_classification": "improved",
                    "improved_axes": ["kg"],
                    "regressed_axes": [],
                    "resolved_risk_codes": ["missing_kg_retrieval_weight"],
                    "new_risk_codes": [],
                    "unchanged_risk_codes": [
                        "missing_bm25_retrieval_weight",
                        "missing_vector_retrieval_weight",
                    ],
                },
            ],
            "summary": {
                "total": 2,
                "by_change_classification": {
                    "improved": 2,
                    "regressed": 0,
                    "mixed": 0,
                    "unchanged": 0,
                },
                "improved_axes": {
                    "vector": 1,
                    "kg": 1,
                },
                "regressed_axes": {},
                "resolved_risk_codes": {
                    "missing_vector_retrieval_weight": 1,
                    "missing_kg_retrieval_weight": 1,
                },
                "new_risk_codes": {},
            },
        },
    }


def test_store_preview_weight_updates_preserves_none_unset_rules(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    store = RetrievalProfileStore(str(db_path))
    persisted = store.update_weights(
        "user-1",
        {
            "bm25_fts": 1.0,
            "custom_future_axis": 0.25,
        },
    )
    rows_before_preview = _stored_retrieval_profiles(db_path)

    with pytest.raises(ValueError, match="concrete retrieval source weights"):
        store.preview_weight_updates([("user-1", {"custom_future_axis": None})])

    assert store.get("user-1").weights == persisted.weights
    assert _stored_retrieval_profiles(db_path) == rows_before_preview


def test_store_preview_weight_updates_rejects_invalid_none_unset_without_persistence(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    store = RetrievalProfileStore(str(db_path))
    persisted = store.update_weights(
        "user-1",
        {
            "bm25_fts": 1.0,
            "vector_semantic": 0.8,
            "kg_subgraph": 0.6,
        },
    )
    rows_before_preview = _stored_retrieval_profiles(db_path)
    yielded_user_ids: list[str] = []

    def one_pass_updates() -> Iterator[tuple[str, dict[str, float | None]]]:
        for user_id, weights in (
            ("user-1", {"bm25_fts": None}),
            ("new-user", {"vector_semantic": 0.4}),
            ("user-1", {"custom_future_axis": None}),
        ):
            yielded_user_ids.append(user_id)
            yield user_id, weights

    with pytest.raises(ValueError, match="concrete retrieval source weights"):
        store.preview_weight_updates(one_pass_updates())

    assert yielded_user_ids == ["user-1", "new-user", "user-1"]
    assert store.get("user-1").weights == persisted.weights
    assert _stored_retrieval_profiles(db_path) == rows_before_preview


def test_store_preview_weight_updates_accepts_one_pass_duplicate_user_unsets(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    store = RetrievalProfileStore(str(db_path))
    persisted = store.update_weights(
        "duplicate-user",
        {
            "bm25_fts": 1.0,
            "vector_semantic": 0.8,
            "kg_subgraph": 0.6,
        },
    )
    rows_before_preview = _stored_retrieval_profiles(db_path)
    yielded_user_ids: list[str] = []

    def one_pass_updates() -> Iterator[tuple[str, dict[str, float | None]]]:
        for user_id, weights in (
            ("duplicate-user", {"bm25_fts": None}),
            ("new-user", {"vector_semantic": 0.4}),
            ("duplicate-user", {"vector_semantic": 0.2, "kg_subgraph": None}),
        ):
            yielded_user_ids.append(user_id)
            yield user_id, weights

    batch = store.preview_weight_updates(one_pass_updates())

    assert yielded_user_ids == ["duplicate-user", "new-user", "duplicate-user"]
    assert [preview.before.profile_name for preview in batch.previews] == [
        "duplicate-user",
        "new-user",
        "duplicate-user",
    ]
    assert batch.previews[0].before.weights == persisted.weights
    assert "bm25_fts" not in batch.previews[0].after.weights
    assert batch.previews[0].after.health.missing_axes == ("bm25",)
    assert batch.previews[1].before.weights == DEFAULT_RETRIEVAL_WEIGHTS
    assert batch.previews[1].after.health.missing_axes == ("bm25", "kg")
    assert batch.previews[2].before.weights == persisted.weights
    assert batch.previews[2].after.weights["vector_semantic"] == 0.2
    assert "kg_subgraph" not in batch.previews[2].after.weights
    assert batch.previews[2].after.health.missing_axes == ("kg",)
    assert [comparison.change_classification for comparison in batch.report.comparisons] == [
        "regressed",
        "improved",
        "regressed",
    ]
    assert store.get("duplicate-user").weights == persisted.weights
    assert _stored_retrieval_profiles(db_path) == rows_before_preview


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


def test_weight_application_supports_logical_axis_aliases() -> None:
    profile = RetrievalWeightProfile(
        user_id="user-1",
        weights={"bm25": 0.1, "vector": 3.0, "kg": 1.0},
    )
    items = [
        MemoryItem(
            id="bm25",
            content="bm25",
            metadata={"schema_version": 1, "source": "bm25_fts", "score": 0.9},
        ),
        MemoryItem(
            id="vector",
            content="vector",
            metadata={"schema_version": 1, "source": "vector_semantic", "score": 0.4},
        ),
    ]

    assert [item.id for item in profile.apply_to(items)] == ["vector", "bm25"]


def test_retrieval_profile_health_is_healthy_for_complete_source_config() -> None:
    profile = RetrievalWeightProfile(
        user_id="user-1",
        weights={
            "bm25_fts": 1.0,
            "vector_semantic": 0.8,
            "kg_subgraph": 0.6,
        },
    )

    health = retrieval_profile_health(profile)

    assert health.status == "healthy"
    assert health.checked_axes == ("bm25", "vector", "kg")
    assert health.missing_axes == ()
    assert health.risk_codes == ()
    assert health.recommendations == ()


def test_retrieval_profile_health_reports_missing_bm25_vector_and_kg_configs() -> None:
    profile = RetrievalWeightProfile(user_id="user-1")

    health = profile.health_summary()

    assert health.status == "incomplete"
    assert health.missing_axes == ("bm25", "vector", "kg")
    assert health.risk_codes == (
        "missing_bm25_retrieval_weight",
        "missing_vector_retrieval_weight",
        "missing_kg_retrieval_weight",
    )


def test_retrieval_profile_health_orders_missing_axes_deterministically() -> None:
    profile = RetrievalWeightProfile(
        user_id="user-1",
        weights={
            "kg_subgraph": 1.0,
            "custom_future_axis": 0.1,
            "vector_semantic": 1.0,
        },
    )

    health = retrieval_profile_health(profile)

    assert health.missing_axes == ("bm25",)
    assert health.risk_codes == ("missing_bm25_retrieval_weight",)
    assert health.recommendations == (
        "Set an explicit bm25_fts weight before retrieval reevaluation.",
    )


def test_retrieval_profile_health_to_dict_is_json_ready() -> None:
    profile = RetrievalWeightProfile(
        user_id="user-1",
        weights={"bm25_fts": 1.0},
    )

    assert profile.health_summary().to_dict() == {
        "status": "incomplete",
        "checked_axes": ["bm25", "vector", "kg"],
        "missing_axes": ["vector", "kg"],
        "risk_codes": [
            "missing_vector_retrieval_weight",
            "missing_kg_retrieval_weight",
        ],
        "recommendations": [
            "Set an explicit vector_semantic weight before retrieval reevaluation.",
            "Set an explicit kg_subgraph weight before retrieval reevaluation.",
        ],
    }


def test_retrieval_profile_health_update_preview_reports_one_pair_without_mutation() -> None:
    profile = RetrievalWeightProfile(user_id="user-1", weights={"bm25_fts": 1})
    original_weights = dict(profile.weights)

    preview = preview_retrieval_profile_health_update(
        profile,
        {
            "vector_semantic": 0.5,
            "kg_subgraph": 0.25,
        },
    )

    assert profile.weights == original_weights
    assert preview.before.weights == original_weights
    assert preview.after.weights["bm25_fts"] == 1.0
    assert preview.after.weights["vector_semantic"] == 0.5
    assert preview.after.weights["kg_subgraph"] == 0.25
    assert preview.before.health.missing_axes == ("vector", "kg")
    assert preview.after.health.status == "healthy"
    assert preview.comparison.change_classification == "improved"
    assert preview.comparison.improved_axes == ("vector", "kg")
    assert preview.report.comparisons == (preview.comparison,)
    assert preview.report.summary.to_dict() == {
        "total": 1,
        "by_change_classification": {
            "improved": 1,
            "regressed": 0,
            "mixed": 0,
            "unchanged": 0,
        },
        "improved_axes": {
            "vector": 1,
            "kg": 1,
        },
        "regressed_axes": {},
        "resolved_risk_codes": {
            "missing_vector_retrieval_weight": 1,
            "missing_kg_retrieval_weight": 1,
        },
        "new_risk_codes": {},
    }
    assert list(preview.to_dict()) == ["before", "after", "comparison", "report"]


def test_retrieval_profile_health_update_preview_rejects_broad_none_unsets() -> None:
    profile = RetrievalWeightProfile(
        user_id="user-1",
        weights={
            "bm25_fts": 1.0,
            "custom_future_axis": 0.25,
        },
    )
    original_weights = dict(profile.weights)

    with pytest.raises(ValueError, match="concrete retrieval source weights"):
        preview_retrieval_profile_health_update(profile, {"custom_future_axis": None})

    with pytest.raises(ValueError, match="concrete retrieval source weights"):
        preview_retrieval_profile_health_update(profile, {"vector": None})

    assert profile.weights == original_weights


def test_retrieval_profile_health_update_batch_preview_handles_empty_input() -> None:
    batch = preview_retrieval_profile_health_updates([])

    assert batch.previews == ()
    assert batch.to_dict() == {
        "previews": [],
        "report": {
            "comparisons": [],
            "summary": {
                "total": 0,
                "by_change_classification": {
                    "improved": 0,
                    "regressed": 0,
                    "mixed": 0,
                    "unchanged": 0,
                },
                "improved_axes": {},
                "regressed_axes": {},
                "resolved_risk_codes": {},
                "new_risk_codes": {},
            },
        },
    }


def test_retrieval_profile_health_update_batch_preview_reports_combined_counts() -> None:
    improved = RetrievalWeightProfile(user_id="improved")
    regressed = RetrievalWeightProfile(
        user_id="regressed",
        weights={
            "bm25_fts": 1.0,
            "vector_semantic": 1.0,
            "kg_subgraph": 1.0,
        },
    )
    mixed = RetrievalWeightProfile(user_id="mixed", weights={"kg_subgraph": 1.0})
    unchanged = RetrievalWeightProfile(
        user_id="unchanged",
        weights={"vector_semantic": 1.0},
    )
    profiles = (improved, regressed, mixed, unchanged)
    original_weights_by_profile = {profile.user_id: dict(profile.weights) for profile in profiles}

    batch = preview_retrieval_profile_health_updates(
        [
            (
                improved,
                {
                    "bm25_fts": 1.0,
                    "vector_semantic": 1.0,
                    "kg_subgraph": 1.0,
                },
            ),
            (regressed, {"bm25_fts": None, "kg_subgraph": None}),
            (mixed, {"bm25_fts": 1.0, "kg_subgraph": None}),
            (unchanged, {"custom_future_axis": 0.25}),
        ]
    )

    assert [preview.before.profile_name for preview in batch.previews] == [
        "improved",
        "regressed",
        "mixed",
        "unchanged",
    ]
    assert [preview.comparison.change_classification for preview in batch.previews] == [
        "improved",
        "regressed",
        "mixed",
        "unchanged",
    ]
    assert [comparison.change_classification for comparison in batch.report.comparisons] == [
        "improved",
        "regressed",
        "mixed",
        "unchanged",
    ]
    assert batch.previews[1].comparison.regressed_axes == ("bm25", "kg")
    assert batch.previews[2].comparison.improved_axes == ("bm25",)
    assert batch.previews[2].comparison.regressed_axes == ("kg",)
    assert batch.report.summary.to_dict() == {
        "total": 4,
        "by_change_classification": {
            "improved": 1,
            "regressed": 1,
            "mixed": 1,
            "unchanged": 1,
        },
        "improved_axes": {
            "bm25": 2,
            "vector": 1,
            "kg": 1,
        },
        "regressed_axes": {
            "bm25": 1,
            "kg": 2,
        },
        "resolved_risk_codes": {
            "missing_bm25_retrieval_weight": 2,
            "missing_vector_retrieval_weight": 1,
            "missing_kg_retrieval_weight": 1,
        },
        "new_risk_codes": {
            "missing_bm25_retrieval_weight": 1,
            "missing_kg_retrieval_weight": 2,
        },
    }
    assert list(batch.to_dict()) == ["previews", "report"]
    assert len(batch.to_dict()["previews"]) == 4
    assert batch.to_dict()["report"] == batch.report.to_dict()

    for profile in profiles:
        assert profile.weights == original_weights_by_profile[profile.user_id]


def test_retrieval_profile_health_comparison_reports_improvement() -> None:
    before = retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="user-1"))
    after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="user-1",
            weights={
                "bm25_fts": 1.0,
                "vector_semantic": 1.0,
                "kg_subgraph": 1.0,
            },
        )
    )

    comparison = compare_retrieval_profile_health_snapshots(before, after)

    assert comparison.before_status == "incomplete"
    assert comparison.after_status == "healthy"
    assert comparison.change_classification == "improved"
    assert comparison.improved_axes == ("bm25", "vector", "kg")
    assert comparison.regressed_axes == ()
    assert comparison.resolved_risk_codes == (
        "missing_bm25_retrieval_weight",
        "missing_vector_retrieval_weight",
        "missing_kg_retrieval_weight",
    )
    assert comparison.new_risk_codes == ()
    assert comparison.unchanged_risk_codes == ()


def test_retrieval_profile_health_comparison_reports_regression() -> None:
    before = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="user-1",
            weights={
                "bm25_fts": 1.0,
                "vector_semantic": 1.0,
                "kg_subgraph": 1.0,
            },
        )
    )
    after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="user-1", weights={"vector_semantic": 1.0})
    )

    comparison = compare_retrieval_profile_health_snapshots(before, after)

    assert comparison.before_status == "healthy"
    assert comparison.after_status == "incomplete"
    assert comparison.change_classification == "regressed"
    assert comparison.improved_axes == ()
    assert comparison.regressed_axes == ("bm25", "kg")
    assert comparison.resolved_risk_codes == ()
    assert comparison.new_risk_codes == (
        "missing_bm25_retrieval_weight",
        "missing_kg_retrieval_weight",
    )
    assert comparison.unchanged_risk_codes == ()


def test_retrieval_profile_health_comparison_reports_mixed_change() -> None:
    before = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="user-1", weights={"kg_subgraph": 1.0})
    )
    after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="user-1", weights={"bm25_fts": 1.0})
    )

    comparison = compare_retrieval_profile_health_snapshots(before, after)

    assert comparison.before_status == "incomplete"
    assert comparison.after_status == "incomplete"
    assert comparison.change_classification == "mixed"
    assert comparison.improved_axes == ("bm25",)
    assert comparison.regressed_axes == ("kg",)
    assert comparison.resolved_risk_codes == ("missing_bm25_retrieval_weight",)
    assert comparison.new_risk_codes == ("missing_kg_retrieval_weight",)
    assert comparison.unchanged_risk_codes == ("missing_vector_retrieval_weight",)


def test_retrieval_profile_health_comparison_reports_no_change() -> None:
    before = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="user-1", weights={"vector_semantic": 1.0})
    )
    after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="user-1",
            weights={
                "custom_future_axis": 0.25,
                "vector_semantic": 1.0,
            },
        )
    )

    comparison = compare_retrieval_profile_health_snapshots(before, after)

    assert comparison.before_status == "incomplete"
    assert comparison.after_status == "incomplete"
    assert comparison.change_classification == "unchanged"
    assert comparison.improved_axes == ()
    assert comparison.regressed_axes == ()
    assert comparison.resolved_risk_codes == ()
    assert comparison.new_risk_codes == ()
    assert comparison.unchanged_risk_codes == (
        "missing_bm25_retrieval_weight",
        "missing_kg_retrieval_weight",
    )


def test_retrieval_profile_health_comparison_to_dict_is_stable() -> None:
    before = retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="user-1"))
    after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="user-1", weights={"kg_subgraph": 1.0})
    )

    assert compare_retrieval_profile_health_snapshots(before, after).to_dict() == {
        "before_status": "incomplete",
        "after_status": "incomplete",
        "change_classification": "improved",
        "improved_axes": ["kg"],
        "regressed_axes": [],
        "resolved_risk_codes": ["missing_kg_retrieval_weight"],
        "new_risk_codes": [],
        "unchanged_risk_codes": [
            "missing_bm25_retrieval_weight",
            "missing_vector_retrieval_weight",
        ],
    }


def test_retrieval_profile_health_comparison_batch_summary_counts_ordered() -> None:
    improved = compare_retrieval_profile_health_snapshots(
        retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="improved")),
        retrieval_profile_health_snapshot(
            RetrievalWeightProfile(
                user_id="improved",
                weights={
                    "bm25_fts": 1.0,
                    "vector_semantic": 1.0,
                    "kg_subgraph": 1.0,
                },
            )
        ),
    )
    regressed = compare_retrieval_profile_health_snapshots(
        retrieval_profile_health_snapshot(
            RetrievalWeightProfile(
                user_id="regressed",
                weights={
                    "bm25_fts": 1.0,
                    "vector_semantic": 1.0,
                    "kg_subgraph": 1.0,
                },
            )
        ),
        retrieval_profile_health_snapshot(
            RetrievalWeightProfile(user_id="regressed", weights={"vector_semantic": 1.0})
        ),
    )
    mixed = compare_retrieval_profile_health_snapshots(
        retrieval_profile_health_snapshot(
            RetrievalWeightProfile(user_id="mixed", weights={"kg_subgraph": 1.0})
        ),
        retrieval_profile_health_snapshot(
            RetrievalWeightProfile(user_id="mixed", weights={"bm25_fts": 1.0})
        ),
    )
    unchanged = compare_retrieval_profile_health_snapshots(
        retrieval_profile_health_snapshot(
            RetrievalWeightProfile(user_id="unchanged", weights={"vector_semantic": 1.0})
        ),
        retrieval_profile_health_snapshot(
            RetrievalWeightProfile(
                user_id="unchanged",
                weights={
                    "custom_future_axis": 0.25,
                    "vector_semantic": 1.0,
                },
            )
        ),
    )

    summary = summarize_retrieval_profile_health_comparisons(
        [unchanged, mixed, regressed, improved]
    )

    assert summary.to_dict() == {
        "total": 4,
        "by_change_classification": {
            "improved": 1,
            "regressed": 1,
            "mixed": 1,
            "unchanged": 1,
        },
        "improved_axes": {
            "bm25": 2,
            "vector": 1,
            "kg": 1,
        },
        "regressed_axes": {
            "bm25": 1,
            "kg": 2,
        },
        "resolved_risk_codes": {
            "missing_bm25_retrieval_weight": 2,
            "missing_vector_retrieval_weight": 1,
            "missing_kg_retrieval_weight": 1,
        },
        "new_risk_codes": {
            "missing_bm25_retrieval_weight": 1,
            "missing_kg_retrieval_weight": 2,
        },
    }


def test_retrieval_profile_health_comparison_batch_summary_accepts_one_pass_input() -> None:
    yielded_labels: list[str] = []

    def one_pass_comparisons() -> Iterator[RetrievalProfileHealthComparison]:
        for label, before, after in (
            (
                "improved",
                retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="improved")),
                retrieval_profile_health_snapshot(
                    RetrievalWeightProfile(
                        user_id="improved",
                        weights={"kg_subgraph": 1.0},
                    )
                ),
            ),
            (
                "unchanged",
                retrieval_profile_health_snapshot(
                    RetrievalWeightProfile(
                        user_id="unchanged",
                        weights={"vector_semantic": 1.0},
                    )
                ),
                retrieval_profile_health_snapshot(
                    RetrievalWeightProfile(
                        user_id="unchanged",
                        weights={
                            "custom_future_axis": 0.25,
                            "vector_semantic": 1.0,
                        },
                    )
                ),
            ),
        ):
            yielded_labels.append(label)
            yield compare_retrieval_profile_health_snapshots(before, after)

    summary = summarize_retrieval_profile_health_comparisons(one_pass_comparisons())

    assert yielded_labels == ["improved", "unchanged"]
    assert summary.to_dict() == {
        "total": 2,
        "by_change_classification": {
            "improved": 1,
            "regressed": 0,
            "mixed": 0,
            "unchanged": 1,
        },
        "improved_axes": {"kg": 1},
        "regressed_axes": {},
        "resolved_risk_codes": {"missing_kg_retrieval_weight": 1},
        "new_risk_codes": {},
    }


def test_retrieval_profile_health_comparison_batch_summary_handles_empty_input() -> None:
    summary = summarize_retrieval_profile_health_comparisons([])

    assert summary.to_dict() == {
        "total": 0,
        "by_change_classification": {
            "improved": 0,
            "regressed": 0,
            "mixed": 0,
            "unchanged": 0,
        },
        "improved_axes": {},
        "regressed_axes": {},
        "resolved_risk_codes": {},
        "new_risk_codes": {},
    }


def test_retrieval_profile_health_comparison_report_handles_empty_input() -> None:
    report = compare_retrieval_profile_health_snapshot_pairs([])

    assert report.comparisons == ()
    assert report.to_dict() == {
        "comparisons": [],
        "summary": {
            "total": 0,
            "by_change_classification": {
                "improved": 0,
                "regressed": 0,
                "mixed": 0,
                "unchanged": 0,
            },
            "improved_axes": {},
            "regressed_axes": {},
            "resolved_risk_codes": {},
            "new_risk_codes": {},
        },
    }


def test_retrieval_profile_health_comparison_report_accepts_mixed_pair_shapes() -> None:
    improved_before = retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="improved"))
    improved_after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="improved",
            weights={
                "bm25_fts": 1.0,
                "vector_semantic": 1.0,
                "kg_subgraph": 1.0,
            },
        )
    )
    regressed_before = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="regressed",
            weights={
                "bm25_fts": 1.0,
                "vector_semantic": 1.0,
                "kg_subgraph": 1.0,
            },
        )
    )
    regressed_after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="regressed", weights={"vector_semantic": 1.0})
    )

    report = compare_retrieval_profile_health_snapshot_pairs(
        [
            RetrievalProfileHealthSnapshotPair(
                before=improved_before,
                after=improved_after,
            ),
            (regressed_before, regressed_after),
        ]
    )

    assert [comparison.change_classification for comparison in report.comparisons] == [
        "improved",
        "regressed",
    ]
    assert report.summary.to_dict() == {
        "total": 2,
        "by_change_classification": {
            "improved": 1,
            "regressed": 1,
            "mixed": 0,
            "unchanged": 0,
        },
        "improved_axes": {
            "bm25": 1,
            "vector": 1,
            "kg": 1,
        },
        "regressed_axes": {
            "bm25": 1,
            "kg": 1,
        },
        "resolved_risk_codes": {
            "missing_bm25_retrieval_weight": 1,
            "missing_vector_retrieval_weight": 1,
            "missing_kg_retrieval_weight": 1,
        },
        "new_risk_codes": {
            "missing_bm25_retrieval_weight": 1,
            "missing_kg_retrieval_weight": 1,
        },
    }


def test_retrieval_profile_health_comparison_report_accepts_one_pass_pair_input() -> None:
    yielded_labels: list[str] = []
    improved_before = retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="improved"))
    improved_after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="improved", weights={"kg_subgraph": 1.0})
    )
    unchanged_before = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="unchanged", weights={"vector_semantic": 1.0})
    )
    unchanged_after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="unchanged",
            weights={
                "custom_future_axis": 0.25,
                "vector_semantic": 1.0,
            },
        )
    )

    def one_pass_pairs() -> Iterator[RetrievalProfileHealthSnapshotPairInput]:
        for label, pair in (
            ("improved", (improved_before, improved_after)),
            ("unchanged", (unchanged_before, unchanged_after)),
        ):
            yielded_labels.append(label)
            yield pair

    report = compare_retrieval_profile_health_snapshot_pairs(one_pass_pairs())

    assert yielded_labels == ["improved", "unchanged"]
    assert [comparison.change_classification for comparison in report.comparisons] == [
        "improved",
        "unchanged",
    ]
    assert report.summary.to_dict() == {
        "total": 2,
        "by_change_classification": {
            "improved": 1,
            "regressed": 0,
            "mixed": 0,
            "unchanged": 1,
        },
        "improved_axes": {"kg": 1},
        "regressed_axes": {},
        "resolved_risk_codes": {"missing_kg_retrieval_weight": 1},
        "new_risk_codes": {},
    }


def test_retrieval_profile_health_comparison_report_preserves_mixed_pair_order() -> None:
    tuple_before = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="tuple-regressed",
            weights={
                "bm25_fts": 1.0,
                "vector_semantic": 1.0,
                "kg_subgraph": 1.0,
            },
        )
    )
    tuple_after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="tuple-regressed",
            weights={"vector_semantic": 1.0},
        )
    )
    dataclass_before = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="dataclass-improved")
    )
    dataclass_after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(
            user_id="dataclass-improved",
            weights={"bm25_fts": 1.0},
        )
    )

    report = compare_retrieval_profile_health_snapshot_pairs(
        [
            (tuple_before, tuple_after),
            RetrievalProfileHealthSnapshotPair(
                before=dataclass_before,
                after=dataclass_after,
            ),
        ]
    )

    assert [comparison.change_classification for comparison in report.comparisons] == [
        "regressed",
        "improved",
    ]
    assert report.comparisons[0].regressed_axes == ("bm25", "kg")
    assert report.comparisons[1].improved_axes == ("bm25",)


def test_retrieval_profile_health_comparison_report_to_dict_is_stable() -> None:
    before = retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="user-1"))
    after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="user-1", weights={"kg_subgraph": 1.0})
    )

    report = compare_retrieval_profile_health_snapshot_pairs([(before, after)])

    assert report.to_dict() == {
        "comparisons": [
            {
                "before_status": "incomplete",
                "after_status": "incomplete",
                "change_classification": "improved",
                "improved_axes": ["kg"],
                "regressed_axes": [],
                "resolved_risk_codes": ["missing_kg_retrieval_weight"],
                "new_risk_codes": [],
                "unchanged_risk_codes": [
                    "missing_bm25_retrieval_weight",
                    "missing_vector_retrieval_weight",
                ],
            }
        ],
        "summary": {
            "total": 1,
            "by_change_classification": {
                "improved": 1,
                "regressed": 0,
                "mixed": 0,
                "unchanged": 0,
            },
            "improved_axes": {"kg": 1},
            "regressed_axes": {},
            "resolved_risk_codes": {"missing_kg_retrieval_weight": 1},
            "new_risk_codes": {},
        },
    }


def test_retrieval_profile_health_comparison_report_to_dict_is_stable_for_generator_input() -> None:
    yielded_labels: list[str] = []
    before = retrieval_profile_health_snapshot(RetrievalWeightProfile(user_id="user-1"))
    after = retrieval_profile_health_snapshot(
        RetrievalWeightProfile(user_id="user-1", weights={"kg_subgraph": 1.0})
    )

    def one_pass_pairs() -> Iterator[RetrievalProfileHealthSnapshotPairInput]:
        yielded_labels.append("kg")
        yield (before, after)

    report = compare_retrieval_profile_health_snapshot_pairs(one_pass_pairs())
    first_dict = report.to_dict()
    second_dict = report.to_dict()

    assert yielded_labels == ["kg"]
    assert first_dict == second_dict
    assert first_dict == {
        "comparisons": [
            {
                "before_status": "incomplete",
                "after_status": "incomplete",
                "change_classification": "improved",
                "improved_axes": ["kg"],
                "regressed_axes": [],
                "resolved_risk_codes": ["missing_kg_retrieval_weight"],
                "new_risk_codes": [],
                "unchanged_risk_codes": [
                    "missing_bm25_retrieval_weight",
                    "missing_vector_retrieval_weight",
                ],
            }
        ],
        "summary": {
            "total": 1,
            "by_change_classification": {
                "improved": 1,
                "regressed": 0,
                "mixed": 0,
                "unchanged": 0,
            },
            "improved_axes": {"kg": 1},
            "regressed_axes": {},
            "resolved_risk_codes": {"missing_kg_retrieval_weight": 1},
            "new_risk_codes": {},
        },
    }
