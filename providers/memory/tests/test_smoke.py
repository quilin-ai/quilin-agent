from __future__ import annotations

from omnimem import __version__
from omnimem.types import MemoryRecord


def test_package_imports() -> None:
    assert __version__ == "0.0.1"
    record = MemoryRecord(id="1", content="hello")
    assert record.content == "hello"


def test_memory_record_default_tier() -> None:
    record = MemoryRecord(id="1", content="hello")
    assert record.tier == "short"


def test_memory_record_custom_tier() -> None:
    record = MemoryRecord(id="1", content="hello", tier="long")
    assert record.tier == "long"


def test_memory_record_to_dict() -> None:
    record = MemoryRecord(id="abc", content="test content", tier="mid")
    result = record.to_dict()
    assert result == {"id": "abc", "content": "test content", "tier": "mid"}


def test_memory_record_to_dict_default_tier() -> None:
    record = MemoryRecord(id="xyz", content="hello world")
    result = record.to_dict()
    assert result == {"id": "xyz", "content": "hello world", "tier": "short"}


def test_memory_record_is_frozen() -> None:
    """MemoryRecord should be immutable (frozen=True)."""
    import pytest

    record = MemoryRecord(id="1", content="hello")
    with pytest.raises(AttributeError):
        record.content = "mutated"  # type: ignore[misc]
