from __future__ import annotations

from pathlib import Path

import pytest

from omnimem.soul_schema import SoulDocument

VALID_SOUL_MD = """---
schema_version: 1
persona_name: "Quilin"
core_values: ["clarity", "rigor"]
communication_style: "direct and pragmatic"
created_at: "2026-04-24T00:00:00+00:00"
last_updated_by: "human"
---
# Quilin Soul

Body remains free Markdown.
"""


def test_soul_schema_parses_frozen_frontmatter_fields() -> None:
    document = SoulDocument.from_markdown(VALID_SOUL_MD)

    assert document.schema_version == 1
    assert document.persona_name == "Quilin"
    assert document.core_values == ["clarity", "rigor"]
    assert "free Markdown" in document.body


def test_soul_schema_loads_from_path(tmp_path: Path) -> None:
    path = tmp_path / "soul.md"
    path.write_text(VALID_SOUL_MD, encoding="utf-8")

    assert SoulDocument.load(path).last_updated_by == "human"


def test_soul_schema_rejects_missing_required_fields() -> None:
    with pytest.raises(ValueError, match="missing required fields"):
        SoulDocument.from_markdown("---\nschema_version: 1\n---\nbody")


def test_soul_schema_rejects_schema_drift() -> None:
    with pytest.raises(ValueError, match="schema_version"):
        SoulDocument.from_markdown(VALID_SOUL_MD.replace("schema_version: 1", "schema_version: 2"))


def test_soul_schema_accepts_json_string_core_values() -> None:
    document = SoulDocument.from_markdown(
        VALID_SOUL_MD.replace(
            'core_values: ["clarity", "rigor"]',
            'core_values: "[\\"clarity\\", \\"rigor\\"]"',
        )
    )

    assert document.core_values == ["clarity", "rigor"]


def test_soul_schema_rejects_empty_identity_fields() -> None:
    with pytest.raises(ValueError, match="persona_name"):
        SoulDocument.from_markdown(
            VALID_SOUL_MD.replace('persona_name: "Quilin"', 'persona_name: ""')
        )

    with pytest.raises(ValueError, match="core_values"):
        SoulDocument.from_markdown(
            VALID_SOUL_MD.replace('core_values: ["clarity", "rigor"]', "core_values: []")
        )


def test_soul_schema_rejects_non_list_core_values() -> None:
    with pytest.raises(ValueError, match="core_values"):
        SoulDocument.from_markdown(
            VALID_SOUL_MD.replace(
                'core_values: ["clarity", "rigor"]',
                'core_values: "\\"clarity\\""',
            )
        )
