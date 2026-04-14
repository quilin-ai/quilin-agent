from omnimem import __version__
from omnimem.types import MemoryRecord


def test_package_imports() -> None:
    assert __version__ == "0.0.1"
    record = MemoryRecord(id="1", content="hello")
    assert record.content == "hello"
