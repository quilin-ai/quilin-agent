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

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final, cast
from urllib.parse import urlparse

from .store_search import record_columns
from .store_serialization import row_to_record, serialize_metadata
from .types import MemoryRecord

__all__ = [
    "PROSPECTIVE_SCHEMA_VERSION",
    "DEFAULT_REMINDER_WINDOW_HOURS",
    "ProspectiveItem",
    "ReminderPayload",
    "DueProspectiveItem",
    "is_due",
    "format_reminder",
    "extract_deadline_from_metadata",
    "extract_action_from_metadata",
    "validate_resource_pointer",
    "list_due_prospective",
    "mark_prospective_done",
    "snooze_prospective",
    "cancel_prospective",
]


PROSPECTIVE_SCHEMA_VERSION: Final[int] = 1
"""Bump when prospective field shape changes(additive-only)."""

DEFAULT_REMINDER_WINDOW_HOURS: Final[int] = 24
"""默认在 deadline 前 24 小时开始提醒(可以通过 caller 参数覆盖)。"""

RESOURCE_TYPE_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
METADATA_KIND_KEYS: Final[tuple[str, ...]] = ("kind", "memory_kind")
PROSPECTIVE_STATUS_KEY: Final[str] = "prospective_status"


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
        source: 来源范围(conversation / import / idle 等,由 caller 传入)。
    """

    memory_id: str
    content: str
    deadline_at: datetime
    action: str | None = None
    actor: str | None = None
    source: str | None = None
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
        actor: 透传 ``ProspectiveItem.actor``。
        source: 透传 ``ProspectiveItem.source``。
    """

    memory_id: str
    message: str
    urgency: str
    deadline_at: str
    suggested_action: str | None = None
    actor: str | None = None
    source: str | None = None


@dataclass(frozen=True, slots=True)
class DueProspectiveItem:
    """Store-backed prospective memory item that is due for scheduler pickup."""

    memory_id: str
    content: str
    deadline_at: datetime
    kind: str = "prospective"
    prospective_action: str | None = None
    project_scope: str | None = None
    user_id: str | None = None
    session_id: str | None = None
    resource_pointer: dict[str, object] | None = None
    metadata: dict[str, object] | None = None

    def to_wire_dict(self) -> dict[str, object]:
        return {
            "id": self.memory_id,
            "content": self.content,
            "kind": self.kind,
            "deadline_at": self.deadline_at.isoformat(),
            "prospective_action": self.prospective_action,
            "project_scope": self.project_scope,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "resource_pointer": (
                dict(self.resource_pointer) if self.resource_pointer is not None else None
            ),
            "metadata": dict(self.metadata or {}),
        }


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


def format_reminder(item: ProspectiveItem, now: datetime | None = None) -> ReminderPayload:
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
        message = f"⚠️ 已过期 {overdue_hours} 小时 / Overdue by {overdue_hours} hours:{item.content}"
    elif delta_seconds < 3600:
        urgency = "due"
        minutes_left = max(int(delta_seconds // 60), 0)
        message = f"⏰ {minutes_left} 分钟后到期 / Due in {minutes_left} minutes:{item.content}"
    else:
        urgency = "soon"
        hours_left = int(delta_seconds // 3600)
        message = f"📅 {hours_left} 小时后到期 / Due in {hours_left} hours:{item.content}"

    return ReminderPayload(
        memory_id=item.memory_id,
        message=message,
        urgency=urgency,
        deadline_at=item.deadline_at.isoformat(),
        suggested_action=item.action,
        actor=item.actor,
        source=item.source,
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


def validate_resource_pointer(pointer: dict[str, object] | None) -> dict[str, object] | None:
    """Validate a resource pointer shape without opening files or network handles.

    The validator is intentionally deterministic: it checks only JSON shape and
    string syntax for ``uri`` / ``path`` / ``type``. It never stats paths, opens
    files, resolves symlinks, or probes remote URLs.
    """
    if pointer is None:
        return None
    if not isinstance(pointer, dict):
        raise ValueError("resource_pointer must be a JSON object")

    normalized = dict(pointer)
    raw_uri = normalized.get("uri")
    raw_path = normalized.get("path")
    raw_type = normalized.get("type")

    has_uri = isinstance(raw_uri, str) and bool(raw_uri.strip())
    has_path = isinstance(raw_path, str) and bool(raw_path.strip())
    if has_uri == has_path:
        raise ValueError("resource_pointer must include exactly one of uri or path")

    if raw_uri is not None:
        if not isinstance(raw_uri, str) or not raw_uri.strip():
            raise ValueError("resource_pointer.uri must be a non-empty string")
        uri = raw_uri.strip()
        parsed = urlparse(uri)
        if not parsed.scheme:
            raise ValueError("resource_pointer.uri must include a URI scheme")
        if any(ord(char) < 32 for char in uri):
            raise ValueError("resource_pointer.uri must not contain control characters")
        normalized["uri"] = uri

    if raw_path is not None:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError("resource_pointer.path must be a non-empty string")
        path = raw_path.strip()
        if "\x00" in path or any(ord(char) < 32 for char in path):
            raise ValueError("resource_pointer.path must not contain control characters")
        normalized["path"] = path

    if raw_type is not None:
        if not isinstance(raw_type, str) or not raw_type.strip():
            raise ValueError("resource_pointer.type must be a non-empty string")
        resource_type = raw_type.strip().lower()
        if RESOURCE_TYPE_PATTERN.fullmatch(resource_type) is None:
            raise ValueError("resource_pointer.type must be a stable lowercase identifier")
        normalized["type"] = resource_type

    return normalized


async def list_due_prospective(
    store: object,
    *,
    now: datetime,
    project_scope: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
) -> list[DueProspectiveItem]:
    """List due active prospective records using structured fields plus legacy metadata."""

    return await asyncio.to_thread(
        _list_due_prospective_sync,
        store,
        _ensure_aware(now),
        project_scope,
        user_id,
        session_id,
    )


def _list_due_prospective_sync(
    store: object,
    now: datetime,
    project_scope: str | None,
    user_id: str | None,
    session_id: str | None,
) -> list[DueProspectiveItem]:
    typed_store = cast(Any, store)
    conn = typed_store._conn
    lock = typed_store._lock
    active_at = now.astimezone(UTC)
    with lock:
        rows = conn.execute(
            f"""
            SELECT {record_columns()}, forget_after, recovered_at
            FROM memory_records
            WHERE deleted = 0
              AND is_latest = 1
            ORDER BY rowid ASC
            """,
        ).fetchall()

    due_items: list[DueProspectiveItem] = []
    for row in rows:
        if not _row_visible_at(row, active_at):
            continue
        try:
            record = row_to_record(row, now=lambda: now)
        except Exception:
            continue
        due_item = _record_to_due_item(record, now=now)
        if due_item is None:
            continue
        if (
            project_scope is not None
            and due_item.project_scope is not None
            and due_item.project_scope != project_scope
        ):
            continue
        if user_id is not None and due_item.user_id != user_id:
            continue
        if session_id is not None and due_item.session_id != session_id:
            continue
        due_items.append(due_item)

    return sorted(due_items, key=lambda item: (item.deadline_at, item.memory_id))


async def mark_prospective_done(
    store: object,
    memory_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """Mark a prospective memory done, then archive it via the store soft-delete path."""

    completed_at = _ensure_aware(now or datetime.now(UTC))
    updated = await asyncio.to_thread(
        _merge_prospective_metadata_sync,
        store,
        memory_id,
        {
            PROSPECTIVE_STATUS_KEY: "done",
            "prospective_done_at": completed_at.isoformat(),
        },
        None,
    )
    await cast(Any, store).delete(memory_id)
    return {"ok": True, "memory_id": memory_id, "done": updated}


async def cancel_prospective(
    store: object,
    memory_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """Cancel a prospective memory and archive it without physically deleting the row."""

    canceled_at = _ensure_aware(now or datetime.now(UTC))
    updated = await asyncio.to_thread(
        _merge_prospective_metadata_sync,
        store,
        memory_id,
        {
            PROSPECTIVE_STATUS_KEY: "canceled",
            "prospective_canceled_at": canceled_at.isoformat(),
        },
        None,
    )
    await cast(Any, store).delete(memory_id)
    return {"ok": True, "memory_id": memory_id, "canceled": updated}


async def snooze_prospective(
    store: object,
    memory_id: str,
    snooze_until: datetime,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """Move the prospective deadline forward and recover if it was archived."""

    updated_at = _ensure_aware(now or datetime.now(UTC))
    new_deadline = _ensure_aware(snooze_until)
    recovered = False
    if await _is_deleted(store, memory_id):
        recovered = bool(await cast(Any, store).recover_memory(memory_id))

    updated = await asyncio.to_thread(
        _merge_prospective_metadata_sync,
        store,
        memory_id,
        {
            PROSPECTIVE_STATUS_KEY: "pending",
            "deadline_at": new_deadline.isoformat(),
            "prospective_snoozed_at": updated_at.isoformat(),
        },
        new_deadline,
    )
    return {
        "ok": True,
        "memory_id": memory_id,
        "snoozed": updated,
        "recovered": recovered,
        "deadline_at": new_deadline.isoformat(),
    }


async def _is_deleted(store: object, memory_id: str) -> bool:
    return await asyncio.to_thread(_is_deleted_sync, store, memory_id)


def _is_deleted_sync(store: object, memory_id: str) -> bool:
    typed_store = cast(Any, store)
    conn = typed_store._conn
    lock = typed_store._lock
    with lock:
        row = conn.execute(
            "SELECT deleted FROM memory_records WHERE id = ? AND is_latest = 1",
            (memory_id,),
        ).fetchone()
    return row is not None and int(row["deleted"]) == 1


def _merge_prospective_metadata_sync(
    store: object,
    memory_id: str,
    metadata_updates: dict[str, object],
    deadline_at: datetime | None,
) -> bool:
    typed_store = cast(Any, store)
    conn = typed_store._conn
    lock = typed_store._lock
    with lock:
        conn.execute("BEGIN IMMEDIATE")
        with conn:
            row = conn.execute(
                """
                SELECT metadata_json
                FROM memory_records
                WHERE id = ? AND is_latest = 1
                """,
                (memory_id,),
            ).fetchone()
            if row is None:
                return False

            metadata = _load_metadata_json(str(row["metadata_json"]))
            metadata.update(metadata_updates)
            if deadline_at is None:
                conn.execute(
                    """
                    UPDATE memory_records
                    SET metadata_json = ?
                    WHERE id = ? AND is_latest = 1
                    """,
                    (serialize_metadata(metadata), memory_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE memory_records
                    SET metadata_json = ?, deadline_at = ?
                    WHERE id = ? AND is_latest = 1
                    """,
                    (serialize_metadata(metadata), deadline_at.isoformat(), memory_id),
                )
    return True


def _record_to_due_item(record: MemoryRecord, *, now: datetime) -> DueProspectiveItem | None:
    metadata = dict(record.metadata)
    if _effective_kind(record, metadata) != "prospective":
        return None
    if metadata.get(PROSPECTIVE_STATUS_KEY) in {"done", "canceled"}:
        return None

    deadline = record.deadline_at or extract_deadline_from_metadata(metadata)
    if deadline is None:
        return None
    deadline = _ensure_aware(deadline)
    if deadline > now:
        return None

    try:
        resource_pointer = validate_resource_pointer(record.resource_pointer)
    except ValueError:
        resource_pointer = None
    return DueProspectiveItem(
        memory_id=record.id,
        content=record.content,
        deadline_at=deadline,
        prospective_action=record.prospective_action or extract_action_from_metadata(metadata),
        project_scope=record.project_scope,
        user_id=_metadata_string(metadata, "user_id"),
        session_id=_metadata_string(metadata, "session_id"),
        resource_pointer=resource_pointer,
        metadata=metadata,
    )


def _effective_kind(record: MemoryRecord, metadata: dict[str, object]) -> str | None:
    if record.kind:
        return record.kind
    for key in METADATA_KIND_KEYS:
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return None


def _metadata_string(metadata: dict[str, object], key: str) -> str | None:
    value = metadata.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _row_visible_at(row: Any, active_at: datetime) -> bool:
    if row["recovered_at"] is not None:
        return True
    raw_forget_after = row["forget_after"]
    if raw_forget_after is None:
        return True
    try:
        forget_after = datetime.fromisoformat(str(raw_forget_after))
    except ValueError:
        return False
    if forget_after.tzinfo is None:
        forget_after = forget_after.replace(tzinfo=UTC)
    return forget_after.astimezone(UTC) > active_at


def _load_metadata_json(raw: str) -> dict[str, object]:
    try:
        loaded = json.loads(raw)
    except ValueError:
        return {"schema_version": 1}
    if not isinstance(loaded, dict):
        return {"schema_version": 1}
    loaded.setdefault("schema_version", 1)
    return dict(loaded)


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value
