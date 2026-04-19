from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

MemoryTier = Literal["working", "episodic", "semantic", "skill"]
VALID_MEMORY_TIERS: tuple[MemoryTier, ...] = (
    "working",
    "episodic",
    "semantic",
    "skill",
)


@dataclass(slots=True, frozen=True)
class MemoryRecord:
    id: str
    content: str
    tier: MemoryTier = "working"

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "content": self.content, "tier": self.tier}
