"""Unit tests for ``quilin_mem.salience``(QUI-197 prep)."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from quilin_mem.salience import (
    DEFAULT_STALENESS_THRESHOLD_DAYS,
    INTENT_DIMENSION_WEIGHTS,
    SALIENCE_SCHEMA_VERSION,
    SalienceVector,
    build_staleness_marker,
    compute_weighted_score,
    kind_for_metadata,
    salience_from_importance_scalar,
)

# ---------------------------------------------------------------------------
# 1. SalienceVector dataclass + JSON round-trip
# ---------------------------------------------------------------------------


def test_default_vector_has_neutral_dimensions() -> None:
    vec = SalienceVector()
    assert vec.novelty == 0.5
    assert vec.utility == 0.5
    assert vec.personal_relevance == 0.5
    assert vec.actionability == 0.5
    assert vec.temporal_relevance == 0.5
    assert vec.stability == 0.5
    assert vec.schema_version == SALIENCE_SCHEMA_VERSION


def test_average_returns_six_dim_mean() -> None:
    vec = SalienceVector(
        novelty=1.0,
        utility=0.5,
        personal_relevance=0.0,
        actionability=1.0,
        temporal_relevance=0.5,
        stability=0.0,
    )
    assert abs(vec.average() - 0.5) < 1e-9


def test_to_json_dict_includes_schema_version() -> None:
    vec = SalienceVector(novelty=0.7, utility=0.3)
    payload = vec.to_json_dict()
    assert payload["novelty"] == 0.7
    assert payload["utility"] == 0.3
    assert payload["schema_version"] == SALIENCE_SCHEMA_VERSION


def test_from_json_dict_round_trips() -> None:
    original = SalienceVector(
        novelty=0.8,
        utility=0.6,
        personal_relevance=0.9,
        actionability=0.2,
        temporal_relevance=0.4,
        stability=0.7,
    )
    restored = SalienceVector.from_json_dict(original.to_json_dict())
    assert restored == original


def test_from_json_dict_handles_missing_dims_with_fallback() -> None:
    restored = SalienceVector.from_json_dict({"novelty": 0.9})
    assert restored.novelty == 0.9
    assert restored.utility == 0.5  # fallback
    assert restored.schema_version == SALIENCE_SCHEMA_VERSION


def test_from_json_dict_rejects_bool_values() -> None:
    """`True`/`False` 不应被当 1.0/0.0 自动 coerce(会污染权重)。"""
    restored = SalienceVector.from_json_dict({"novelty": True, "utility": False})
    assert restored.novelty == 0.5  # fallback,不接受 bool
    assert restored.utility == 0.5


def test_from_json_dict_clamps_out_of_range_values() -> None:
    restored = SalienceVector.from_json_dict(
        {"novelty": 1.5, "utility": -0.3, "personal_relevance": float("nan")}
    )
    assert restored.novelty == 1.0
    assert restored.utility == 0.0
    assert restored.personal_relevance == 0.5  # NaN → fallback


def test_from_json_dict_schema_version_falls_back_for_invalid_values() -> None:
    for raw_schema_version in (float("nan"), float("inf"), "not-an-int", True, None):
        restored = SalienceVector.from_json_dict({"schema_version": raw_schema_version})
        assert restored.schema_version == SALIENCE_SCHEMA_VERSION


# ---------------------------------------------------------------------------
# 2. compute_weighted_score — intent → 维度加权
# ---------------------------------------------------------------------------


def test_unspecified_intent_returns_average() -> None:
    vec = SalienceVector(
        novelty=0.2,
        utility=0.4,
        personal_relevance=0.6,
        actionability=0.8,
        temporal_relevance=0.5,
        stability=0.5,
    )
    score = compute_weighted_score(vec, intent="unspecified")
    expected = vec.average()
    assert abs(score - expected) < 1e-9


def test_coding_task_intent_prefers_utility_and_actionability() -> None:
    """coding_task 时 utility=1.0 + actionability=1.0 应该比 novelty=1.0 单维更高分。"""
    utility_focused = SalienceVector(utility=1.0, actionability=1.0)
    novelty_focused = SalienceVector(novelty=1.0)
    score_utility = compute_weighted_score(utility_focused, intent="coding_task")
    score_novelty = compute_weighted_score(novelty_focused, intent="coding_task")
    assert score_utility > score_novelty


def test_research_intent_prefers_novelty() -> None:
    novelty_focused = SalienceVector(novelty=1.0)
    utility_focused = SalienceVector(utility=1.0)
    score_novelty = compute_weighted_score(novelty_focused, intent="research")
    score_utility = compute_weighted_score(utility_focused, intent="research")
    assert score_novelty > score_utility


def test_all_intents_have_six_dim_weights() -> None:
    """每个 intent 都必须配齐 6 维权重(防止 typo 导致 KeyError)。"""
    expected_dims = {
        "novelty",
        "utility",
        "personal_relevance",
        "actionability",
        "temporal_relevance",
        "stability",
    }
    for intent, weights in INTENT_DIMENSION_WEIGHTS.items():
        assert set(weights.keys()) == expected_dims, f"intent={intent} 维度缺失"


def test_weighted_score_clamped_to_unit_range() -> None:
    """即使输入全 1 / 全 0,加权 score 仍在 [0, 1]。"""
    vec_max = SalienceVector(1.0, 1.0, 1.0, 1.0, 1.0, 1.0)
    vec_min = SalienceVector(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    for intent in INTENT_DIMENSION_WEIGHTS:
        score_max = compute_weighted_score(vec_max, intent=intent)
        score_min = compute_weighted_score(vec_min, intent=intent)
        assert 0.0 <= score_min <= score_max <= 1.0


# ---------------------------------------------------------------------------
# 3. salience_from_importance_scalar — backwards-compat fallback
# ---------------------------------------------------------------------------


def test_scalar_fallback_fills_all_dims() -> None:
    vec = salience_from_importance_scalar(0.7)
    assert vec.novelty == 0.7
    assert vec.utility == 0.7
    assert vec.personal_relevance == 0.7
    assert vec.actionability == 0.7
    assert vec.temporal_relevance == 0.7
    assert vec.stability == 0.7


def test_scalar_fallback_handles_none() -> None:
    vec = salience_from_importance_scalar(None)
    assert vec.average() == 0.5


def test_scalar_fallback_clamps_out_of_range() -> None:
    high = salience_from_importance_scalar(2.0)
    low = salience_from_importance_scalar(-0.5)
    nan = salience_from_importance_scalar(math.nan)
    assert high.novelty == 1.0
    assert low.novelty == 0.0
    assert nan.novelty == 0.5  # NaN → fallback


# ---------------------------------------------------------------------------
# 4. kind_for_metadata — 9 种 kind 标签
# ---------------------------------------------------------------------------


def test_kind_returns_value_when_valid() -> None:
    for kind_value in (
        "preference",
        "feedback",
        "project_note",
        "reference",
        "pattern",
        "bug",
        "workflow",
        "prospective",
        "resource",
    ):
        assert kind_for_metadata({"kind": kind_value}) == kind_value


def test_kind_returns_none_for_unknown() -> None:
    assert kind_for_metadata({"kind": "made-up-kind"}) is None


def test_kind_returns_none_for_missing_metadata() -> None:
    assert kind_for_metadata(None) is None
    assert kind_for_metadata({}) is None
    assert kind_for_metadata({"other_key": "value"}) is None


def test_kind_is_case_insensitive_and_stripped() -> None:
    assert kind_for_metadata({"kind": "  PREFERENCE  "}) == "preference"


# ---------------------------------------------------------------------------
# 5. build_staleness_marker — Claude Code 风格的过期提示
# ---------------------------------------------------------------------------


def test_fresh_record_returns_no_marker() -> None:
    now = datetime(2026, 5, 21, 12, 0, 0, tzinfo=UTC)
    created = now - timedelta(days=5)
    assert build_staleness_marker(created, now=now) is None


def test_old_record_returns_chinese_english_bilingual_marker() -> None:
    now = datetime(2026, 5, 21, 12, 0, 0, tzinfo=UTC)
    created = now - timedelta(days=47)
    marker = build_staleness_marker(created, now=now)
    assert marker is not None
    assert "47" in marker
    assert "天前" in marker
    assert "days ago" in marker


def test_custom_threshold_applies() -> None:
    now = datetime(2026, 5, 21, 12, 0, 0, tzinfo=UTC)
    created = now - timedelta(days=10)
    # 默认 30 天阈值 → 10 天 < 30,no marker
    assert build_staleness_marker(created, now=now) is None
    # 调到 7 天阈值 → 10 天 > 7,有 marker
    marker = build_staleness_marker(created, now=now, threshold_days=7)
    assert marker is not None and "10" in marker


def test_zero_or_negative_threshold_disables_staleness() -> None:
    now = datetime(2026, 5, 21, 12, 0, 0, tzinfo=UTC)
    created = now - timedelta(days=365)
    assert build_staleness_marker(created, now=now, threshold_days=0) is None
    assert build_staleness_marker(created, now=now, threshold_days=-1) is None


def test_marker_rounds_down_partial_days() -> None:
    """1.5 天前应该显示 1 天,不是 2 天(int division)。"""
    now = datetime(2026, 5, 21, 12, 0, 0, tzinfo=UTC)
    # 31 天 + 12 小时 = 31 天(向下)
    created = now - timedelta(days=31, hours=12)
    marker = build_staleness_marker(created, now=now)
    assert marker is not None
    assert "31 天前" in marker


# ---------------------------------------------------------------------------
# 6. Default constants sanity
# ---------------------------------------------------------------------------


def test_default_staleness_threshold_is_30_days() -> None:
    assert DEFAULT_STALENESS_THRESHOLD_DAYS == 30
