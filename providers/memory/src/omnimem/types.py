from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class MemoryRecord:
    id: str
    content: str
    tier: str = "short"

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "content": self.content, "tier": self.tier}
