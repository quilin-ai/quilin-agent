from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from .types import MemoryItem

DEFAULT_RETRIEVAL_WEIGHTS: dict[str, float] = {
    "bm25": 1.0,
    "vector": 1.0,
    "kg": 1.0,
    "working": 1.0,
    "recency": 0.0,
}

RETRIEVAL_PROFILE_REQUIRED_SOURCES: dict[str, str] = {
    "bm25": "bm25_fts",
    "vector": "vector_semantic",
    "kg": "kg_subgraph",
}
RETRIEVAL_PROFILE_PREVIEW_UNSETTABLE_WEIGHTS: frozenset[str] = frozenset(
    RETRIEVAL_PROFILE_REQUIRED_SOURCES.values()
)

RETRIEVAL_PROFILE_HEALTH_AXES: tuple[str, ...] = tuple(RETRIEVAL_PROFILE_REQUIRED_SOURCES)

RETRIEVAL_PROFILE_RECOMMENDATIONS: dict[str, str] = {
    "bm25": "Set an explicit bm25_fts weight before retrieval reevaluation.",
    "vector": "Set an explicit vector_semantic weight before retrieval reevaluation.",
    "kg": "Set an explicit kg_subgraph weight before retrieval reevaluation.",
}

_RETRIEVAL_PROFILE_AXIS_ORDER: dict[str, int] = {
    axis: index for index, axis in enumerate(RETRIEVAL_PROFILE_HEALTH_AXES)
}
_RETRIEVAL_PROFILE_RISK_CODE_ORDER: dict[str, int] = {
    f"missing_{axis}_retrieval_weight": index
    for index, axis in enumerate(RETRIEVAL_PROFILE_HEALTH_AXES)
}
RetrievalProfileHealthChange = Literal["improved", "regressed", "mixed", "unchanged"]
RETRIEVAL_PROFILE_HEALTH_CHANGE_CLASSIFICATIONS: tuple[RetrievalProfileHealthChange, ...] = (
    "improved",
    "regressed",
    "mixed",
    "unchanged",
)


def _default_db_path() -> str:
    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"
    return os.environ.get("OMNIMEM_DB_PATH", str(Path.home() / ".quilin" / "memory.db"))


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealth:
    status: str
    missing_axes: tuple[str, ...]
    risk_codes: tuple[str, ...]
    recommendations: tuple[str, ...]
    checked_axes: tuple[str, ...] = RETRIEVAL_PROFILE_HEALTH_AXES

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "checked_axes": list(self.checked_axes),
            "missing_axes": list(self.missing_axes),
            "risk_codes": list(self.risk_codes),
            "recommendations": list(self.recommendations),
        }


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealthSnapshot:
    profile_name: str
    weights: dict[str, float]
    health: RetrievalProfileHealth

    def to_dict(self) -> dict[str, object]:
        return {
            "profile_name": self.profile_name,
            "weights": {key: self.weights[key] for key in sorted(self.weights)},
            "health": self.health.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealthSnapshotPair:
    before: RetrievalProfileHealthSnapshot
    after: RetrievalProfileHealthSnapshot


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealthComparison:
    before_status: str
    after_status: str
    change_classification: RetrievalProfileHealthChange
    improved_axes: tuple[str, ...]
    regressed_axes: tuple[str, ...]
    resolved_risk_codes: tuple[str, ...]
    new_risk_codes: tuple[str, ...]
    unchanged_risk_codes: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "before_status": self.before_status,
            "after_status": self.after_status,
            "change_classification": self.change_classification,
            "improved_axes": list(self.improved_axes),
            "regressed_axes": list(self.regressed_axes),
            "resolved_risk_codes": list(self.resolved_risk_codes),
            "new_risk_codes": list(self.new_risk_codes),
            "unchanged_risk_codes": list(self.unchanged_risk_codes),
        }


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealthComparisonBatchSummary:
    total: int
    by_change_classification: dict[RetrievalProfileHealthChange, int]
    improved_axes: dict[str, int]
    regressed_axes: dict[str, int]
    resolved_risk_codes: dict[str, int]
    new_risk_codes: dict[str, int]

    def to_dict(self) -> dict[str, object]:
        return {
            "total": self.total,
            "by_change_classification": dict(self.by_change_classification),
            "improved_axes": dict(self.improved_axes),
            "regressed_axes": dict(self.regressed_axes),
            "resolved_risk_codes": dict(self.resolved_risk_codes),
            "new_risk_codes": dict(self.new_risk_codes),
        }


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealthComparisonReport:
    comparisons: tuple[RetrievalProfileHealthComparison, ...]
    summary: RetrievalProfileHealthComparisonBatchSummary

    def to_dict(self) -> dict[str, object]:
        return {
            "comparisons": [comparison.to_dict() for comparison in self.comparisons],
            "summary": self.summary.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealthUpdatePreview:
    before: RetrievalProfileHealthSnapshot
    after: RetrievalProfileHealthSnapshot
    comparison: RetrievalProfileHealthComparison
    report: RetrievalProfileHealthComparisonReport

    def to_dict(self) -> dict[str, object]:
        return {
            "before": self.before.to_dict(),
            "after": self.after.to_dict(),
            "comparison": self.comparison.to_dict(),
            "report": self.report.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class RetrievalProfileHealthUpdateBatchPreview:
    previews: tuple[RetrievalProfileHealthUpdatePreview, ...]
    report: RetrievalProfileHealthComparisonReport

    def to_dict(self) -> dict[str, object]:
        return {
            "previews": [preview.to_dict() for preview in self.previews],
            "report": self.report.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class RetrievalWeightProfile:
    user_id: str
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_RETRIEVAL_WEIGHTS))
    schema_version: int = 1

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ValueError("RetrievalWeightProfile.schema_version must be 1")
        normalized = dict(DEFAULT_RETRIEVAL_WEIGHTS)
        for key, value in self.weights.items():
            normalized[str(key)] = float(value)
        object.__setattr__(self, "weights", normalized)

    def apply_to(self, items: list[MemoryItem]) -> list[MemoryItem]:
        weighted: list[tuple[float, str, MemoryItem]] = []
        for item in items:
            source = str(item.metadata.get("source", item.layer))
            layer = str(item.metadata.get("layer", item.layer))
            base_score = float(item.metadata.get("score", 0.0))
            source_weight = self.weights.get(source, self.weights.get(layer, 1.0))
            weighted_score = base_score * source_weight
            weighted.append((weighted_score, item.id, _with_weight_metadata(item, weighted_score)))

        return [item for _score, _id, item in sorted(weighted, key=lambda row: (-row[0], row[1]))]

    def health_summary(self) -> RetrievalProfileHealth:
        return retrieval_profile_health(self)


class RetrievalProfileStore:
    """Per-user retrieval weights, separate from UserProfile identity state."""

    def __init__(self, db_path: str | None = None) -> None:
        resolved_path = db_path or _default_db_path()
        if resolved_path != ":memory:":
            Path(resolved_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(resolved_path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._ensure_schema()

    def get(self, user_id: str) -> RetrievalWeightProfile:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT user_id, schema_version, weights_json
                FROM retrieval_weight_profiles
                WHERE user_id = ?
                """,
                (user_id,),
            ).fetchone()
        if row is None:
            return RetrievalWeightProfile(user_id=user_id)

        return RetrievalWeightProfile(
            user_id=str(row["user_id"]),
            schema_version=int(row["schema_version"]),
            weights=json.loads(str(row["weights_json"])),
        )

    def update_weights(self, user_id: str, weights: dict[str, float]) -> RetrievalWeightProfile:
        current = self.get(user_id)
        updated = replace(current, weights={**current.weights, **weights})
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO retrieval_weight_profiles (
                        user_id, schema_version, weights_json
                    )
                    VALUES (?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        schema_version = excluded.schema_version,
                        weights_json = excluded.weights_json
                    """,
                    (
                        updated.user_id,
                        updated.schema_version,
                        json.dumps(updated.weights, sort_keys=True, separators=(",", ":")),
                    ),
                )
        return updated

    def health_snapshot(self, user_id: str) -> RetrievalProfileHealthSnapshot:
        return retrieval_profile_health_snapshot(self.get(user_id))

    def preview_weight_update(
        self, user_id: str, weights: dict[str, float | None]
    ) -> RetrievalProfileHealthUpdatePreview:
        return preview_retrieval_profile_health_update(self.get(user_id), weights)

    def preview_weight_updates(
        self,
        updates: Iterable[tuple[str, dict[str, float | None]]],
    ) -> RetrievalProfileHealthUpdateBatchPreview:
        return preview_retrieval_profile_health_updates(
            (self.get(user_id), weights) for user_id, weights in updates
        )

    def _ensure_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS retrieval_weight_profiles (
                    user_id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
                    weights_json TEXT NOT NULL
                )
                """
            )
            self._conn.commit()


def retrieval_profile_health(profile: RetrievalWeightProfile) -> RetrievalProfileHealth:
    missing_axes = tuple(
        axis
        for axis in RETRIEVAL_PROFILE_HEALTH_AXES
        if RETRIEVAL_PROFILE_REQUIRED_SOURCES[axis] not in profile.weights
    )
    status = "healthy" if not missing_axes else "incomplete"
    risk_codes = tuple(f"missing_{axis}_retrieval_weight" for axis in missing_axes)
    recommendations = tuple(RETRIEVAL_PROFILE_RECOMMENDATIONS[axis] for axis in missing_axes)

    return RetrievalProfileHealth(
        status=status,
        missing_axes=missing_axes,
        risk_codes=risk_codes,
        recommendations=recommendations,
    )


def retrieval_profile_health_snapshot(
    profile: RetrievalWeightProfile,
) -> RetrievalProfileHealthSnapshot:
    return RetrievalProfileHealthSnapshot(
        profile_name=profile.user_id,
        weights=dict(profile.weights),
        health=profile.health_summary(),
    )


def preview_retrieval_profile_health_update(
    profile: RetrievalWeightProfile,
    weights: dict[str, float | None],
) -> RetrievalProfileHealthUpdatePreview:
    before = retrieval_profile_health_snapshot(profile)
    after = retrieval_profile_health_snapshot(_with_retrieval_weight_overrides(profile, weights))
    report = compare_retrieval_profile_health_snapshot_pairs(
        [RetrievalProfileHealthSnapshotPair(before=before, after=after)]
    )

    return RetrievalProfileHealthUpdatePreview(
        before=before,
        after=after,
        comparison=report.comparisons[0],
        report=report,
    )


def preview_retrieval_profile_health_updates(
    updates: Iterable[tuple[RetrievalWeightProfile, dict[str, float | None]]],
) -> RetrievalProfileHealthUpdateBatchPreview:
    previews = tuple(
        preview_retrieval_profile_health_update(profile, weights) for profile, weights in updates
    )
    report = compare_retrieval_profile_health_snapshot_pairs(
        RetrievalProfileHealthSnapshotPair(
            before=preview.before,
            after=preview.after,
        )
        for preview in previews
    )

    return RetrievalProfileHealthUpdateBatchPreview(
        previews=previews,
        report=report,
    )


def compare_retrieval_profile_health_snapshots(
    before: RetrievalProfileHealthSnapshot,
    after: RetrievalProfileHealthSnapshot,
) -> RetrievalProfileHealthComparison:
    before_missing_axes = set(before.health.missing_axes)
    after_missing_axes = set(after.health.missing_axes)
    before_risk_codes = set(before.health.risk_codes)
    after_risk_codes = set(after.health.risk_codes)
    improved_axes = _ordered_retrieval_axes(before_missing_axes - after_missing_axes)
    regressed_axes = _ordered_retrieval_axes(after_missing_axes - before_missing_axes)
    resolved_risk_codes = _ordered_retrieval_risk_codes(before_risk_codes - after_risk_codes)
    new_risk_codes = _ordered_retrieval_risk_codes(after_risk_codes - before_risk_codes)

    return RetrievalProfileHealthComparison(
        before_status=before.health.status,
        after_status=after.health.status,
        change_classification=_classify_retrieval_profile_health_change(
            improved_axes=improved_axes,
            regressed_axes=regressed_axes,
            resolved_risk_codes=resolved_risk_codes,
            new_risk_codes=new_risk_codes,
        ),
        improved_axes=improved_axes,
        regressed_axes=regressed_axes,
        resolved_risk_codes=resolved_risk_codes,
        new_risk_codes=new_risk_codes,
        unchanged_risk_codes=_ordered_retrieval_risk_codes(before_risk_codes & after_risk_codes),
    )


def summarize_retrieval_profile_health_comparisons(
    comparisons: Iterable[RetrievalProfileHealthComparison],
) -> RetrievalProfileHealthComparisonBatchSummary:
    by_change_classification = dict.fromkeys(
        RETRIEVAL_PROFILE_HEALTH_CHANGE_CLASSIFICATIONS,
        0,
    )
    improved_axis_counts: Counter[str] = Counter()
    regressed_axis_counts: Counter[str] = Counter()
    resolved_risk_code_counts: Counter[str] = Counter()
    new_risk_code_counts: Counter[str] = Counter()
    total = 0

    for comparison in comparisons:
        total += 1
        by_change_classification[comparison.change_classification] += 1
        improved_axis_counts.update(comparison.improved_axes)
        regressed_axis_counts.update(comparison.regressed_axes)
        resolved_risk_code_counts.update(comparison.resolved_risk_codes)
        new_risk_code_counts.update(comparison.new_risk_codes)

    return RetrievalProfileHealthComparisonBatchSummary(
        total=total,
        by_change_classification=by_change_classification,
        improved_axes=_ordered_retrieval_axis_counts(improved_axis_counts),
        regressed_axes=_ordered_retrieval_axis_counts(regressed_axis_counts),
        resolved_risk_codes=_ordered_retrieval_risk_code_counts(resolved_risk_code_counts),
        new_risk_codes=_ordered_retrieval_risk_code_counts(new_risk_code_counts),
    )


def compare_retrieval_profile_health_snapshot_pairs(
    pairs: Iterable[
        RetrievalProfileHealthSnapshotPair
        | tuple[RetrievalProfileHealthSnapshot, RetrievalProfileHealthSnapshot]
    ],
) -> RetrievalProfileHealthComparisonReport:
    comparisons = tuple(
        compare_retrieval_profile_health_snapshots(pair.before, pair.after)
        if isinstance(pair, RetrievalProfileHealthSnapshotPair)
        else compare_retrieval_profile_health_snapshots(pair[0], pair[1])
        for pair in pairs
    )

    return RetrievalProfileHealthComparisonReport(
        comparisons=comparisons,
        summary=summarize_retrieval_profile_health_comparisons(comparisons),
    )


def _classify_retrieval_profile_health_change(
    *,
    improved_axes: tuple[str, ...],
    regressed_axes: tuple[str, ...],
    resolved_risk_codes: tuple[str, ...],
    new_risk_codes: tuple[str, ...],
) -> RetrievalProfileHealthChange:
    has_improvement = bool(improved_axes or resolved_risk_codes)
    has_regression = bool(regressed_axes or new_risk_codes)
    if has_improvement and has_regression:
        return "mixed"
    if has_improvement:
        return "improved"
    if has_regression:
        return "regressed"
    return "unchanged"


def _ordered_retrieval_axes(values: set[str]) -> tuple[str, ...]:
    return tuple(
        sorted(
            values,
            key=lambda axis: (
                _RETRIEVAL_PROFILE_AXIS_ORDER.get(axis, len(_RETRIEVAL_PROFILE_AXIS_ORDER)),
                axis,
            ),
        )
    )


def _ordered_retrieval_risk_codes(values: set[str]) -> tuple[str, ...]:
    return tuple(
        sorted(
            values,
            key=lambda risk_code: (
                _RETRIEVAL_PROFILE_RISK_CODE_ORDER.get(
                    risk_code,
                    len(_RETRIEVAL_PROFILE_RISK_CODE_ORDER),
                ),
                risk_code,
            ),
        )
    )


def _ordered_retrieval_axis_counts(counts: Counter[str]) -> dict[str, int]:
    return {axis: counts[axis] for axis in _ordered_retrieval_axes(set(counts))}


def _ordered_retrieval_risk_code_counts(counts: Counter[str]) -> dict[str, int]:
    return {
        risk_code: counts[risk_code] for risk_code in _ordered_retrieval_risk_codes(set(counts))
    }


def _with_retrieval_weight_overrides(
    profile: RetrievalWeightProfile,
    weights: dict[str, float | None],
) -> RetrievalWeightProfile:
    updated_weights = dict(profile.weights)
    for key, value in weights.items():
        normalized_key = str(key)
        if value is None:
            if normalized_key not in RETRIEVAL_PROFILE_PREVIEW_UNSETTABLE_WEIGHTS:
                allowed = ", ".join(sorted(RETRIEVAL_PROFILE_PREVIEW_UNSETTABLE_WEIGHTS))
                raise ValueError(
                    "Preview weight unsets are limited to concrete retrieval source "
                    f"weights: {allowed}"
                )
            updated_weights.pop(normalized_key, None)
        else:
            updated_weights[normalized_key] = float(value)
    return replace(profile, weights=updated_weights)


def _with_weight_metadata(item: MemoryItem, weighted_score: float) -> MemoryItem:
    metadata: dict[str, Any] = dict(item.metadata)
    metadata["weighted_score"] = round(weighted_score, 6)
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
