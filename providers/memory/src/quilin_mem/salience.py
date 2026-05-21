"""QUI-197 multi-dimensional importance + kind taxonomy + staleness.

QUI-197 第一步独立实现(不依赖 QUI-195 schema migration):**6 维 salience
向量 + 9 种 kind 分类 + intent 加权 + staleness wrapping** 的纯函数库,
之后通过 QUI-197 schema field(`memory_records.salience_json` /
``memory_records.kind``)持久化。

Pure helpers, no I/O. Module is dependency-only on stdlib + dataclasses
so it can be reused by retriever weighting, store insertion paths, and
``apps/web`` server-side memory pipeline without dragging in store internals.

调研 §5.6 拆解:
- 单一 ``importance_score`` scalar 把 6 维信息压成一个数 → 用户当前意图
  无法对单维加权。
- Claude Code 风格的 staleness 提示(``"47 天前的记忆"``)也缺。

本模块解 3 个问题:
1. **6 维 salience**:novelty / utility / personal_relevance / actionability /
   temporal_relevance / stability。
2. **9 种 kind 标签**:preference / feedback / project_note / reference /
   pattern / bug / workflow / prospective / resource。
3. **intent → 维度权重映射**:``coding_task`` 加权 utility + actionability,
   ``research`` 加权 novelty + personal_relevance,等等。
4. **staleness wrap**:``staleness_threshold_days`` 之外的 record 附 marker。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal

__all__ = [
    "SALIENCE_SCHEMA_VERSION",
    "SalienceVector",
    "KindLiteral",
    "IntentLiteral",
    "DEFAULT_STALENESS_THRESHOLD_DAYS",
    "compute_weighted_score",
    "compute_salience_ranking_score",
    "compute_retrieval_ranking_score",
    "salience_from_payload",
    "salience_from_importance_scalar",
    "kind_for_metadata",
    "build_staleness_marker",
    "INTENT_DIMENSION_WEIGHTS",
    "KIND_INTENT_WEIGHTS",
]


SALIENCE_SCHEMA_VERSION: Final[int] = 2
"""Bump when SalienceVector shape changes(additive-only)."""


KindLiteral = Literal[
    "preference",  # 用户偏好(喜欢 Vim、深色主题)
    "feedback",  # 用户反馈("这答案不对")
    "project_note",  # 项目笔记 / 代码片段
    "reference",  # 引用 / 文档链接
    "pattern",  # 反复出现的模式 / 工作流
    "bug",  # 已知 bug / 限制
    "workflow",  # 操作步骤序列(QUI-198 trajectory_compressor 出处)
    "prospective",  # 前瞻 / 待办 / deadline(QUI-199)
    "resource",  # 资源指针 / 多模态附件占位
    "predictive_warm",  # 预测预热缓存 / short-lived evidence cache
]

_KIND_VALUES: Final[frozenset[str]] = frozenset(
    {
        "preference",
        "feedback",
        "project_note",
        "reference",
        "pattern",
        "bug",
        "workflow",
        "prospective",
        "resource",
        "predictive_warm",
    }
)


IntentLiteral = Literal[
    "coding_task",  # 实现 / 调试 / 重构
    "research",  # 调研 / 学习 / 论文
    "planning",  # 规划 / 决策 / 架构
    "casual_chat",  # 闲聊 / 用户偏好探测
    "review",  # code review / 反馈
    "unspecified",  # 默认 — 6 维平均权重
]


DEFAULT_STALENESS_THRESHOLD_DAYS: Final[int] = 30
"""默认 staleness 阈值。超过这个天数的记忆会被附 staleness marker。"""


_DEFAULT_FALLBACK_DIM_VALUE: Final[float] = 0.5
"""单维 fallback 默认值(scalar importance → 6 维平均)。"""


@dataclass(frozen=True, slots=True)
class SalienceVector:
    """6 维 importance vector for a memory record.

    每个维度 [0.0, 1.0]:
        novelty: 新颖度 — 与现有记忆重复度的反。
        utility: 实用性 — 后续任务是否经常用到。
        personal_relevance: 个人相关 — 与 user profile / cwd / 当前 session 相关。
        actionability: 可操作性 — 是否能立即转化为 action(命令 / SKILL 提案)。
        temporal_relevance: 时效性 — 时间敏感度(高时效 = 短窗口内有效)。
        stability: 稳定度 — 信息是否稳定不易过时(高稳定 = 长期有效)。

    `schema_version` 跟随 SALIENCE_SCHEMA_VERSION,additive 演化兼容。
    """

    novelty: float = _DEFAULT_FALLBACK_DIM_VALUE
    utility: float = _DEFAULT_FALLBACK_DIM_VALUE
    personal_relevance: float = _DEFAULT_FALLBACK_DIM_VALUE
    actionability: float = _DEFAULT_FALLBACK_DIM_VALUE
    temporal_relevance: float = _DEFAULT_FALLBACK_DIM_VALUE
    stability: float = _DEFAULT_FALLBACK_DIM_VALUE
    schema_version: int = SALIENCE_SCHEMA_VERSION
    recency: float = _DEFAULT_FALLBACK_DIM_VALUE
    user_confirmed: bool = False
    active_project: bool = False
    safety_risk: float = 0.0

    def average(self) -> float:
        """6 维等权平均 — 等价于退回 scalar importance。"""
        return (
            self.novelty
            + self.utility
            + self.personal_relevance
            + self.actionability
            + self.temporal_relevance
            + self.stability
        ) / 6.0

    def to_json_dict(self) -> dict[str, float | int | bool]:
        """序列化为 JSON-safe dict(供 memory_records.salience_json 列存储)。"""
        return {
            "novelty": _clamp01(self.novelty),
            "utility": _clamp01(self.utility),
            "personal_relevance": _clamp01(self.personal_relevance),
            "actionability": _clamp01(self.actionability),
            "temporal_relevance": _clamp01(self.temporal_relevance),
            "stability": _clamp01(self.stability),
            "schema_version": self.schema_version,
            "recency": _clamp01(self.recency),
            "user_confirmed": self.user_confirmed,
            "active_project": self.active_project,
            "safety_risk": _clamp01(self.safety_risk),
        }

    @classmethod
    def from_json_dict(cls, payload: dict[str, object]) -> SalienceVector:
        """从 memory_records.salience_json 反序列化。

        缺失维度退回 ``_DEFAULT_FALLBACK_DIM_VALUE``,bool / 非数字静默忽略
        (避免污染权重计算)。
        """

        importance_fallback = _safe_optional_float(
            payload.get("importance"),
            default=_DEFAULT_FALLBACK_DIM_VALUE,
        )

        def _safe_dim(key: str, *, default: float = importance_fallback) -> float:
            raw = payload.get(key)
            if isinstance(raw, bool):
                return default
            if isinstance(raw, int | float):
                value = float(raw)
                if not math.isfinite(value):
                    return default
                return max(0.0, min(1.0, value))
            return default

        def _safe_bool(key: str) -> bool:
            raw = payload.get(key)
            if isinstance(raw, bool):
                return raw
            if isinstance(raw, str):
                normalized = raw.strip().lower()
                if normalized in {"true", "1", "yes"}:
                    return True
                if normalized in {"false", "0", "no"}:
                    return False
            return False

        def _safe_schema_version() -> int:
            raw = payload.get("schema_version")
            if isinstance(raw, bool):
                return SALIENCE_SCHEMA_VERSION
            if isinstance(raw, int):
                return raw if raw > 0 else SALIENCE_SCHEMA_VERSION
            if isinstance(raw, float):
                if not math.isfinite(raw):
                    return SALIENCE_SCHEMA_VERSION
                coerced = int(raw)
                return coerced if coerced > 0 else SALIENCE_SCHEMA_VERSION
            if isinstance(raw, str):
                try:
                    coerced = int(raw)
                except ValueError:
                    return SALIENCE_SCHEMA_VERSION
                return coerced if coerced > 0 else SALIENCE_SCHEMA_VERSION
            return SALIENCE_SCHEMA_VERSION

        return cls(
            novelty=_safe_dim("novelty"),
            utility=_safe_dim("utility"),
            personal_relevance=_safe_dim("personal_relevance"),
            actionability=_safe_dim("actionability"),
            temporal_relevance=_safe_dim("temporal_relevance"),
            stability=_safe_dim("stability"),
            schema_version=_safe_schema_version(),
            recency=_safe_dim("recency"),
            user_confirmed=_safe_bool("user_confirmed"),
            active_project=_safe_bool("active_project"),
            safety_risk=_safe_dim("safety_risk", default=0.0),
        )


# ---------------------------------------------------------------- weighting


INTENT_DIMENSION_WEIGHTS: Final[dict[IntentLiteral, dict[str, float]]] = {
    # 实现 / 调试 / 重构:用户要立即可用的工具/技能/已知 bug。
    "coding_task": {
        "utility": 1.5,
        "actionability": 1.4,
        "personal_relevance": 1.1,
        "novelty": 0.8,
        "temporal_relevance": 1.0,
        "stability": 1.0,
    },
    # 调研 / 学习:用户想要 novel + 个人相关的信息。
    "research": {
        "novelty": 1.5,
        "personal_relevance": 1.3,
        "utility": 1.0,
        "actionability": 0.8,
        "temporal_relevance": 0.9,
        "stability": 1.1,
    },
    # 规划 / 决策:稳定 + 实用 + 可操作的信息优先。
    "planning": {
        "stability": 1.4,
        "utility": 1.2,
        "actionability": 1.2,
        "personal_relevance": 1.0,
        "novelty": 0.9,
        "temporal_relevance": 0.9,
    },
    # 闲聊 / 用户偏好探测:个人相关 + 稳定优先。
    "casual_chat": {
        "personal_relevance": 1.5,
        "stability": 1.2,
        "novelty": 1.0,
        "utility": 0.8,
        "actionability": 0.7,
        "temporal_relevance": 0.9,
    },
    # Review:实用 + 反馈类 + 已知 bug。
    "review": {
        "utility": 1.3,
        "actionability": 1.3,
        "personal_relevance": 1.1,
        "novelty": 0.9,
        "temporal_relevance": 1.0,
        "stability": 1.0,
    },
    # 未指定 — 6 维等权(=scalar fallback)。
    "unspecified": {
        "novelty": 1.0,
        "utility": 1.0,
        "personal_relevance": 1.0,
        "actionability": 1.0,
        "temporal_relevance": 1.0,
        "stability": 1.0,
    },
}


KIND_INTENT_WEIGHTS: Final[dict[IntentLiteral, dict[KindLiteral, float]]] = {
    "coding_task": {
        "bug": 1.12,
        "workflow": 1.1,
        "project_note": 1.08,
        "preference": 1.03,
        "feedback": 1.03,
        "reference": 1.0,
        "pattern": 1.0,
        "prospective": 0.98,
        "resource": 0.96,
        "predictive_warm": 1.08,
    },
    "research": {
        "reference": 1.12,
        "resource": 1.1,
        "pattern": 1.06,
        "project_note": 1.03,
        "bug": 1.0,
        "feedback": 1.0,
        "preference": 0.98,
        "workflow": 0.98,
        "prospective": 0.96,
        "predictive_warm": 1.06,
    },
    "planning": {
        "prospective": 1.12,
        "project_note": 1.08,
        "pattern": 1.06,
        "workflow": 1.04,
        "bug": 1.02,
        "reference": 1.0,
        "feedback": 1.0,
        "preference": 0.98,
        "resource": 0.96,
        "predictive_warm": 1.08,
    },
    "casual_chat": {
        "preference": 1.12,
        "feedback": 1.08,
        "pattern": 1.02,
        "project_note": 1.0,
        "reference": 1.0,
        "workflow": 0.98,
        "bug": 0.96,
        "prospective": 0.96,
        "resource": 0.95,
        "predictive_warm": 1.02,
    },
    "review": {
        "bug": 1.14,
        "feedback": 1.12,
        "workflow": 1.06,
        "project_note": 1.04,
        "pattern": 1.02,
        "reference": 1.0,
        "preference": 0.98,
        "prospective": 0.96,
        "resource": 0.95,
        "predictive_warm": 1.06,
    },
    "unspecified": {
        "preference": 1.04,
        "feedback": 1.04,
        "project_note": 1.03,
        "workflow": 1.02,
        "bug": 1.02,
        "pattern": 1.0,
        "reference": 1.0,
        "prospective": 1.0,
        "resource": 0.98,
        "predictive_warm": 1.08,
    },
}


def compute_weighted_score(
    salience: SalienceVector,
    intent: IntentLiteral = "unspecified",
) -> float:
    """根据 intent 对 6 维 salience 加权汇总,返回 [0.0, 1.0] 标量。

    权重表 INTENT_DIMENSION_WEIGHTS 决定每维倍率。最终分数 = sum(dim * weight)
    / sum(weights)(weighted average),确保结果仍落在 [0, 1]。
    """
    weights = INTENT_DIMENSION_WEIGHTS.get(intent, INTENT_DIMENSION_WEIGHTS["unspecified"])
    weighted_sum = (
        salience.novelty * weights["novelty"]
        + salience.utility * weights["utility"]
        + salience.personal_relevance * weights["personal_relevance"]
        + salience.actionability * weights["actionability"]
        + salience.temporal_relevance * weights["temporal_relevance"]
        + salience.stability * weights["stability"]
    )
    total_weight = sum(weights.values())
    if total_weight <= 0:
        return _DEFAULT_FALLBACK_DIM_VALUE
    return _clamp01(weighted_sum / total_weight)


def salience_from_importance_scalar(importance: float | None) -> SalienceVector:
    """Backwards-compat fallback:从老 scalar `importance_score` 构造 6 维向量。

    所有 6 维赋同一 scalar 值,等价于"未做多维区分"的 baseline。
    """
    if importance is None:
        importance = _DEFAULT_FALLBACK_DIM_VALUE
    clamped = _clamp01(importance)
    return SalienceVector(
        novelty=clamped,
        utility=clamped,
        personal_relevance=clamped,
        actionability=clamped,
        temporal_relevance=clamped,
        stability=clamped,
        recency=clamped,
    )


def salience_from_payload(
    payload: dict[str, object] | None,
    *,
    importance_score: float | None,
) -> SalienceVector:
    """Build a SalienceVector from optional JSON, falling back to legacy scalar.

    ``payload["importance"]`` is treated as the additive compatibility scalar
    for partially-populated JSON. If salience JSON is absent, the old
    ``importance_score`` column remains the source of truth.
    """
    if payload is None:
        return salience_from_importance_scalar(importance_score)

    scalar_fallback = _safe_optional_float(
        importance_score,
        default=_DEFAULT_FALLBACK_DIM_VALUE,
    )
    merged = dict(payload)
    merged["importance"] = _safe_optional_float(
        merged.get("importance"),
        default=scalar_fallback,
    )
    return SalienceVector.from_json_dict(merged)


def compute_salience_ranking_score(
    payload: dict[str, object] | None,
    *,
    importance_score: float | None,
    kind: str | None = None,
    intent: IntentLiteral = "unspecified",
    active_project: bool = False,
) -> float:
    """Deterministic retrieval salience score in [0, 1].

    The score combines dimensional salience, recency, explicit user
    confirmation, active-project relevance, kind-specific intent weights, and
    safety risk. High ``safety_risk`` records are penalized after positive
    boosts, so risk cannot be used as a ranking boost.
    """
    vector = salience_from_payload(payload, importance_score=importance_score)
    dimensional = compute_weighted_score(vector, intent=intent)
    score = (dimensional * 0.82) + (vector.recency * 0.18)

    if vector.user_confirmed:
        score += 0.08
    if active_project or vector.active_project:
        score += 0.06

    score *= _kind_intent_weight(kind, intent)

    risk = _clamp01(vector.safety_risk)
    if risk >= 0.7:
        score = min(score, dimensional)
    score *= 1.0 - (0.45 * risk)
    return _clamp01(score)


def compute_retrieval_ranking_score(
    base_score: float,
    payload: dict[str, object] | None,
    *,
    importance_score: float | None,
    kind: str | None = None,
    intent: IntentLiteral = "unspecified",
    active_project: bool = False,
) -> float:
    """Adjust a retrieval/reranker score with salience without unsafe boosts."""
    if not math.isfinite(base_score):
        base_score = 0.0

    salience_score = compute_salience_ranking_score(
        payload,
        importance_score=importance_score,
        kind=kind,
        intent=intent,
        active_project=active_project,
    )
    vector = salience_from_payload(payload, importance_score=importance_score)
    multiplier = 0.75 + (salience_score * 0.5)
    if vector.safety_risk >= 0.7:
        multiplier = min(multiplier, 1.0)
    return max(0.0, base_score) * multiplier


# ---------------------------------------------------------------- kind taxonomy


def kind_for_metadata(metadata: dict[str, object] | None) -> KindLiteral | None:
    """从 record metadata 拿 kind 标签 — 返 None 如果未标。

    返 None 让 caller 决策(可能 fallback 默认 kind 或不写入)。Quote:
    "kind 是与层级正交的类型标签 — 不强制每条都有,但有的话强 schema。"
    """
    if metadata is None:
        return None
    raw = metadata.get("kind")
    if not isinstance(raw, str):
        return None
    normalized = raw.strip().lower()
    if normalized in _KIND_VALUES:
        # mypy: 帮助 narrow 到 KindLiteral 范围
        return normalized  # type: ignore[return-value]
    return None


# ---------------------------------------------------------------- staleness


def build_staleness_marker(
    record_created_at: datetime,
    now: datetime | None = None,
    threshold_days: int = DEFAULT_STALENESS_THRESHOLD_DAYS,
) -> str | None:
    """如果 record 距 ``now`` 超过 ``threshold_days``,返 marker 字符串。

    格式:``"<N> 天前 / <N> days ago"``。返 None 表示新鲜不需 marker。
    """
    if threshold_days <= 0:
        return None
    current = now or datetime.now(record_created_at.tzinfo)
    age = current - record_created_at
    if age < timedelta(days=threshold_days):
        return None
    days = max(int(age.total_seconds() // 86400), 1)
    return f"{days} 天前 / {days} days ago"


# ---------------------------------------------------------------- helpers


def _clamp01(value: float) -> float:
    """Clamp to [0.0, 1.0]. NaN / inf collapse to default fallback."""
    if not math.isfinite(value):
        return _DEFAULT_FALLBACK_DIM_VALUE
    return max(0.0, min(1.0, value))


def _safe_optional_float(raw: object, *, default: float) -> float:
    if isinstance(raw, bool):
        return default
    if isinstance(raw, int | float):
        value = float(raw)
        if not math.isfinite(value):
            return default
        return max(0.0, min(1.0, value))
    return default


def _kind_intent_weight(kind: str | None, intent: IntentLiteral) -> float:
    if kind is None:
        return 1.0
    normalized = kind.strip().lower()
    if normalized not in _KIND_VALUES:
        return 1.0
    weights = KIND_INTENT_WEIGHTS.get(intent, KIND_INTENT_WEIGHTS["unspecified"])
    return weights.get(normalized, 1.0)  # type: ignore[arg-type]
