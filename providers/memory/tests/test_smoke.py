from __future__ import annotations

import json
from pathlib import Path

from omnimem import __version__
from omnimem.types import MemoryItem, MemoryRecord


def test_package_imports() -> None:
    assert __version__ == "0.0.1"
    record = MemoryRecord(id="1", content="hello")
    assert record.content == "hello"


def test_memory_record_default_tier() -> None:
    record = MemoryRecord(id="1", content="hello")
    assert record.tier == "working"


def test_memory_record_custom_tier() -> None:
    record = MemoryRecord(id="1", content="hello", tier="semantic")
    assert record.tier == "semantic"


def test_memory_record_to_dict() -> None:
    record = MemoryRecord(id="abc", content="test content", tier="episodic")
    result = record.to_dict()
    assert result == {"id": "abc", "content": "test content", "tier": "episodic"}


def test_memory_record_to_dict_default_tier() -> None:
    record = MemoryRecord(id="xyz", content="hello world")
    result = record.to_dict()
    assert result == {"id": "xyz", "content": "hello world", "tier": "working"}


def test_memory_item_wire_dict_includes_contract_fields() -> None:
    item = MemoryItem(
        id="wire-1",
        content="hello world",
        layer="semantic",
        metadata={"schema_version": 1, "source": "fixture"},
        importance_score=0.8,
    )

    result = item.to_wire_dict()

    assert result["layer"] == "semantic"
    assert result["tier"] == "semantic"
    assert result["content_type"] == "text"
    assert result["metadata"] == {"schema_version": 1, "source": "fixture"}
    assert result["importance_score"] == 0.8


def test_memory_item_fixture_roundtrip() -> None:
    fixture_path = Path(__file__).parent / "fixtures" / "memory_item.json"
    payload = json.loads(fixture_path.read_text())

    items = [MemoryItem.from_dict(entry) for entry in payload]

    assert [item.layer for item in items] == [
        "working",
        "episodic",
        "semantic",
        "skill",
    ]
    assert all(item.metadata["schema_version"] == 1 for item in items)


def test_memory_record_is_frozen() -> None:
    """MemoryRecord should be immutable (frozen=True)."""
    import pytest

    record = MemoryRecord(id="1", content="hello")
    with pytest.raises(AttributeError):
        record.content = "mutated"  # type: ignore[misc]
