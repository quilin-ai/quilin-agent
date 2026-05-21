from __future__ import annotations

from datetime import datetime
from typing import Any

from .types import MemoryItem, MemoryLayer, validate_memory_layer


def layer_filter(filters: dict[str, Any] | None) -> MemoryLayer | None:
    if not filters:
        return None

    raw_layer = filters.get("layer", filters.get("tier"))
    if raw_layer is None:
        return None

    return validate_memory_layer(str(raw_layer))


def matches_filters(item: MemoryItem, filters: dict[str, Any] | None) -> bool:
    if not filters:
        return True

    raw_layer = filters.get("layer", filters.get("tier"))
    if raw_layer is not None and item.layer != validate_memory_layer(str(raw_layer)):
        return False

    content_type = filters.get("content_type")
    if content_type is not None and item.content_type != content_type:
        return False

    if "project_scope" in filters:
        project_scope = filters["project_scope"]
        if project_scope is None:
            if item.project_scope is not None:
                return False
        elif item.project_scope not in {str(project_scope), None}:
            return False

    writer_client = filters.get("last_writer_client", filters.get("writer_client"))
    if writer_client is not None and item.last_writer_client != str(writer_client):
        return False

    writer_session_id = filters.get(
        "last_writer_session_id",
        filters.get("writer_session_id"),
    )
    if writer_session_id is not None and item.last_writer_session_id != str(writer_session_id):
        return False

    metadata_filters = filters.get("metadata")
    if isinstance(metadata_filters, dict):
        for key, value in metadata_filters.items():
            if item.metadata.get(key) != value:
                return False

    created_after = coerce_filter_datetime(filters.get("created_after"))
    if created_after is not None and item.created_at < created_after:
        return False

    created_before = coerce_filter_datetime(filters.get("created_before"))
    return not (created_before is not None and item.created_at > created_before)


def coerce_filter_datetime(raw_value: object) -> datetime | None:
    if raw_value is None:
        return None

    if isinstance(raw_value, datetime):
        return raw_value

    if isinstance(raw_value, str):
        return datetime.fromisoformat(raw_value)

    raise TypeError("datetime filters must be datetime or ISO 8601 strings")
