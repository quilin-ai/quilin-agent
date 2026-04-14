from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class MemoryRecord:
    id: str
    content: str
    tier: str = "short"
