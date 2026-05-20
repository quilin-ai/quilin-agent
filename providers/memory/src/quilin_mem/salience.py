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
    "salience_from_importance_scalar",
    "kind_for_metadata",
    "build_staleness_marker",
    "INTENT_DIMENSION_WEIGHTS",
]


SALIENCE_SCHEMA_VERSION: Final[int] = 1
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

    def to_json_dict(self) -> dict[str, float | int]:
        """序列化为 JSON-safe dict(供 memory_records.salience_json 列存储)。"""
        return {
            "novelty": self.novelty,
            "utility": self.utility,
            "personal_relevance": self.personal_relevance,
            "actionability": self.actionability,
            "temporal_relevance": self.temporal_relevance,
            "stability": self.stability,
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_json_dict(cls, payload: dict[str, object]) -> SalienceVector:
        """从 memory_records.salience_json 反序列化。

        缺失维度退回 ``_DEFAULT_FALLBACK_DIM_VALUE``,bool / 非数字静默忽略
        (避免污染权重计算)。
        """

        def _safe_dim(key: str) -> float:
            raw = payload.get(key)
            if isinstance(raw, bool):
                return _DEFAULT_FALLBACK_DIM_VALUE
            if isinstance(raw, int | float):
                return _clamp01(float(raw))
            return _DEFAULT_FALLBACK_DIM_VALUE

        return cls(
            novelty=_safe_dim("novelty"),
            utility=_safe_dim("utility"),
            personal_relevance=_safe_dim("personal_relevance"),
            actionability=_safe_dim("actionability"),
            temporal_relevance=_safe_dim("temporal_relevance"),
            stability=_safe_dim("stability"),
            schema_version=int(payload.get("schema_version", SALIENCE_SCHEMA_VERSION) or 1),
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
    )


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
    import math

    if not math.isfinite(value):
        return _DEFAULT_FALLBACK_DIM_VALUE
    return max(0.0, min(1.0, value))
