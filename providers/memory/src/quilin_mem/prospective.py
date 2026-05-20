"""QUI-199 prospective memory — deadline parsing + reminder formatting.

QUI-199 第一步独立实现(不依赖 QUI-195 schema migration):**前瞻记忆的
deadline 解析 + 提醒文案生成 + due check** 的纯函数模块。

Pure helpers, no I/O, no DB coupling. Module is dependency-only on stdlib
+ dataclasses so it can be plugged into:

- ``QuilinMemStore.list_due_prospective(now)`` once the schema gains
  ``memory_records.deadline_at`` + ``prospective_action`` fields(等 QUI-195
  schema migration ship 后由 Codex subagent 接续)。
- Daemon scheduler periodic scan(QUI-188 daemon module 接续)。
- Web ``apps/web/app/api/memory/prospective/route.ts`` 后续 UI prompt。

调研 §5.7 拆解(前瞻记忆 / Prospective Memory):
- 用户承诺 / 待办 / 提醒 / 有时间边界的意图("下周二见客户")
- 系统应记下并在 deadline 之前自动提醒
- 触发提醒不是预先回答,只是把证据 + 缓存备好 → 用户一问立刻响应
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

__all__ = [
    "PROSPECTIVE_SCHEMA_VERSION",
    "DEFAULT_REMINDER_WINDOW_HOURS",
    "ProspectiveItem",
    "ReminderPayload",
    "is_due",
    "format_reminder",
    "extract_deadline_from_metadata",
    "extract_action_from_metadata",
]


PROSPECTIVE_SCHEMA_VERSION: Final[int] = 1
"""Bump when prospective field shape changes(additive-only)."""

DEFAULT_REMINDER_WINDOW_HOURS: Final[int] = 24
"""默认在 deadline 前 24 小时开始提醒(可以通过 caller 参数覆盖)。"""


@dataclass(frozen=True, slots=True)
class ProspectiveItem:
    """Resolved prospective-memory item ready for reminder pipeline.

    Attributes:
        memory_id: 原始 memory_records.id,用于回链 + 标"已提醒"。
        content: 前瞻事项内容(用户原话或抽取概括)。
        deadline_at: 到期时间(必须 timezone-aware UTC)。
        action: 建议触发时执行的 action 摘要(可空)。
        actor: 责任人范围(LLM 主动 / user 手动 / 导入,跟 QUI-196 last_writer
            一致)。
    """

    memory_id: str
    content: str
    deadline_at: datetime
    action: str | None = None
    actor: str | None = None
    schema_version: int = PROSPECTIVE_SCHEMA_VERSION


@dataclass(frozen=True, slots=True)
class ReminderPayload:
    """A formatted reminder ready to surface(daemon → narrate_aside / UI)。

    Attributes:
        memory_id: 来源 prospective memory id。
        message: 给用户看的中英双语提醒字符串。
        urgency: "soon" / "due" / "overdue" — 决定渲染样式。
        deadline_at: ISO8601 字符串(便于 wire 透传)。
        suggested_action: 来自 ``ProspectiveItem.action``,可空。
    """

    memory_id: str
    message: str
    urgency: str
    deadline_at: str
    suggested_action: str | None = None


def is_due(
    deadline_at: datetime,
    now: datetime | None = None,
    reminder_window_hours: int = DEFAULT_REMINDER_WINDOW_HOURS,
) -> bool:
    """返回 True 如果在 ``deadline_at - window`` 之后(进入提醒窗口)。

    Window is inclusive — deadline 当天提醒会在 window 内触发。Overdue
    (now > deadline_at)也会返 True 因为还没提醒过的过期事项更要拉响。
    """
    if reminder_window_hours < 0:
        return False
    current = now or datetime.now(deadline_at.tzinfo or UTC)
    window_start = deadline_at - timedelta(hours=reminder_window_hours)
    return current >= window_start


def format_reminder(
    item: ProspectiveItem, now: datetime | None = None
) -> ReminderPayload:
    """生成 ReminderPayload — 决定 urgency + 渲染中英双语 message。

    Urgency 决定方式:
    - ``now > deadline_at`` → "overdue"
    - ``now >= deadline_at - 1h`` → "due"(到期 1 小时内)
    - else → "soon"
    """
    current = now or datetime.now(item.deadline_at.tzinfo or UTC)
    delta_seconds = (item.deadline_at - current).total_seconds()

    if delta_seconds < 0:
        urgency = "overdue"
        overdue_hours = int(abs(delta_seconds) // 3600)
        message = (
            f"⚠️ 已过期 {overdue_hours} 小时 / Overdue by {overdue_hours} hours:"
            f"{item.content}"
        )
    elif delta_seconds < 3600:
        urgency = "due"
        minutes_left = max(int(delta_seconds // 60), 0)
        message = (
            f"⏰ {minutes_left} 分钟后到期 / Due in {minutes_left} minutes:"
            f"{item.content}"
        )
    else:
        urgency = "soon"
        hours_left = int(delta_seconds // 3600)
        message = (
            f"📅 {hours_left} 小时后到期 / Due in {hours_left} hours:"
            f"{item.content}"
        )

    return ReminderPayload(
        memory_id=item.memory_id,
        message=message,
        urgency=urgency,
        deadline_at=item.deadline_at.isoformat(),
        suggested_action=item.action,
    )


def extract_deadline_from_metadata(
    metadata: dict[str, object] | None,
) -> datetime | None:
    """从 record metadata 提取 ``deadline_at`` ISO 字符串 → datetime。

    返 None 如果 metadata 没 deadline / 解析失败。tzinfo 缺失时默认 UTC。
    """
    if metadata is None:
        return None
    raw = metadata.get("deadline_at")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def extract_action_from_metadata(metadata: dict[str, object] | None) -> str | None:
    """从 record metadata 提取 ``prospective_action`` 字段。"""
    if metadata is None:
        return None
    raw = metadata.get("prospective_action")
    if not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    return trimmed or None
