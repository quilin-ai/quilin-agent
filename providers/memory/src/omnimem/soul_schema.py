from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Self

from .profile_store import parse_frontmatter

SOUL_SCHEMA_VERSION = 1
SOUL_REQUIRED_FIELDS = (
    "schema_version",
    "persona_name",
    "core_values",
    "communication_style",
    "created_at",
    "last_updated_by",
)


@dataclass(frozen=True, slots=True)
class SoulDocument:
    persona_name: str
    core_values: list[str]
    communication_style: str
    created_at: datetime
    last_updated_by: str
    body: str = ""
    schema_version: int = SOUL_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != SOUL_SCHEMA_VERSION:
            raise ValueError("soul.md schema_version must be 1")
        if not self.persona_name:
            raise ValueError("soul.md persona_name is required")
        if not self.core_values:
            raise ValueError("soul.md core_values must not be empty")
        object.__setattr__(self, "core_values", [str(value) for value in self.core_values])

    @classmethod
    def load(cls, path: str | Path) -> Self:
        return cls.from_markdown(Path(path).read_text(encoding="utf-8"))

    @classmethod
    def from_markdown(cls, markdown: str) -> Self:
        frontmatter, body = parse_frontmatter(markdown)
        missing = [name for name in SOUL_REQUIRED_FIELDS if name not in frontmatter]
        if missing:
            raise ValueError(f"soul.md missing required fields: {', '.join(missing)}")

        return cls(
            schema_version=int(frontmatter["schema_version"]),
            persona_name=str(frontmatter["persona_name"]),
            core_values=_coerce_string_list(frontmatter["core_values"]),
            communication_style=str(frontmatter["communication_style"]),
            created_at=datetime.fromisoformat(str(frontmatter["created_at"])),
            last_updated_by=str(frontmatter["last_updated_by"]),
            body=body,
        )


def _coerce_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    raise ValueError("soul.md core_values must be a string array")
