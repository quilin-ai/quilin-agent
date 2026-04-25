from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

ASCII_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+")
CJK_RUN_PATTERN = re.compile(r"[\u4e00-\u9fff]+")

KG_SCHEMA_COMPONENT = "temporal_kg"
KG_SCHEMA_VERSION = 1
KG_DEFAULT_DB_NAME = "memory-kg.db"
KG_BUSY_TIMEOUT_MS = 5_000


@dataclass(slots=True, frozen=True)
class KGEdge:
    edge_id: str
    subject: str
    predicate: str
    object: str
    valid_from: datetime
    valid_to: datetime | None
    memory_id: str | None
    weight: float
    metadata: dict[str, object]


@dataclass(slots=True, frozen=True)
class KGSearchResult:
    edge_id: str
    seed_entity: str
    current_entity: str
    subject: str
    predicate: str
    object: str
    depth: int
    path: str
    valid_from: datetime
    valid_to: datetime | None
    memory_id: str | None
    weight: float
    metadata: dict[str, object]


def utcnow() -> datetime:
    return datetime.now(UTC)


def resolve_db_path(db_path: str | None) -> str:
    if db_path is not None:
        return db_path

    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"

    return os.environ.get(
        "OMNIMEM_KG_PATH",
        str(Path.home() / ".quilin" / KG_DEFAULT_DB_NAME),
    )


def serialize_metadata(metadata: dict[str, object] | None) -> str:
    return json.dumps(metadata or {}, ensure_ascii=False, sort_keys=True)


def deserialize_metadata(metadata_json: str | None) -> dict[str, object]:
    if not metadata_json:
        return {}

    loaded = json.loads(metadata_json)
    return dict(loaded) if isinstance(loaded, dict) else {}


def format_datetime(value: datetime | None) -> str | None:
    return None if value is None else normalize_utc_datetime(value).isoformat()


def parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None

    return normalize_utc_datetime(datetime.fromisoformat(value))


def normalize_utc_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)

    return value.astimezone(UTC)


def normalize_datetime(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return normalize_utc_datetime(value)
    if isinstance(value, str):
        return normalize_utc_datetime(datetime.fromisoformat(value))
    raise TypeError("temporal bounds must be datetime or ISO 8601 strings")


def normalize_entity(value: str) -> str:
    return value.casefold().replace("|", "").strip()


def extract_cjk_terms(text: str) -> set[str]:
    terms: set[str] = set()
    for run in CJK_RUN_PATTERN.findall(text):
        if len(run) <= 3:
            terms.add(run)

        for size in (2, 3):
            if len(run) < size:
                continue
            for index in range(len(run) - size + 1):
                terms.add(run[index : index + size])

    return terms


def extract_entity_terms(text: str) -> list[str]:
    lowered = text.casefold()
    terms = set(ASCII_TOKEN_PATTERN.findall(lowered)) | extract_cjk_terms(text)
    return sorted(term for term in terms if term)


def search_result_from_row(row: object) -> KGSearchResult:
    return KGSearchResult(
        edge_id=row["edge_id"],
        seed_entity=row["seed_entity"],
        current_entity=row["current_entity"],
        subject=row["subject"],
        predicate=row["predicate"],
        object=row["object"],
        depth=int(row["depth"]),
        path=row["path"],
        valid_from=parse_datetime(row["valid_from"]) or utcnow(),
        valid_to=parse_datetime(row["valid_to"]),
        memory_id=row["memory_id"],
        weight=float(row["weight"]),
        metadata=deserialize_metadata(row["metadata_json"]),
    )


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kg_edges (
            edge_id TEXT PRIMARY KEY,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object TEXT NOT NULL,
            valid_from TEXT NOT NULL,
            valid_to TEXT,
            memory_id TEXT,
            weight REAL NOT NULL DEFAULT 1.0,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_kg_edges_subject_object
        ON kg_edges(subject, object)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_kg_edges_validity
        ON kg_edges(valid_from, valid_to)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL
        )
        """
    )
    current_version = get_schema_version(conn, KG_SCHEMA_COMPONENT)
    if current_version < KG_SCHEMA_VERSION:
        conn.execute(
            """
            INSERT INTO schema_version (component, version)
            VALUES (?, ?)
            ON CONFLICT(component) DO UPDATE SET version = excluded.version
            """,
            (KG_SCHEMA_COMPONENT, KG_SCHEMA_VERSION),
        )
    conn.commit()


def get_schema_version(conn: sqlite3.Connection, component: str) -> int:
    row = conn.execute(
        "SELECT version FROM schema_version WHERE component = ?",
        (component,),
    ).fetchone()
    if row is None:
        return 0

    return int(row["version"])
