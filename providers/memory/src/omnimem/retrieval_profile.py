from __future__ import annotations

import json
import os
import sqlite3
import threading
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .types import MemoryItem

DEFAULT_RETRIEVAL_WEIGHTS: dict[str, float] = {
    "bm25": 1.0,
    "vector": 1.0,
    "kg": 1.0,
    "working": 1.0,
    "recency": 0.0,
}


def _default_db_path() -> str:
    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"
    return os.environ.get("OMNIMEM_DB_PATH", str(Path.home() / ".quilin" / "memory.db"))


@dataclass(frozen=True, slots=True)
class RetrievalWeightProfile:
    user_id: str
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_RETRIEVAL_WEIGHTS))
    schema_version: int = 1

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ValueError("RetrievalWeightProfile.schema_version must be 1")
        normalized = dict(DEFAULT_RETRIEVAL_WEIGHTS)
        for key, value in self.weights.items():
            normalized[str(key)] = float(value)
        object.__setattr__(self, "weights", normalized)

    def apply_to(self, items: list[MemoryItem]) -> list[MemoryItem]:
        weighted: list[tuple[float, str, MemoryItem]] = []
        for item in items:
            source = str(item.metadata.get("source", item.layer))
            layer = str(item.metadata.get("layer", item.layer))
            base_score = float(item.metadata.get("score", 0.0))
            source_weight = self.weights.get(source, self.weights.get(layer, 1.0))
            weighted_score = base_score * source_weight
            weighted.append((weighted_score, item.id, _with_weight_metadata(item, weighted_score)))

        return [item for _score, _id, item in sorted(weighted, key=lambda row: (-row[0], row[1]))]


class RetrievalProfileStore:
    """Per-user retrieval weights, separate from UserProfile identity state."""

    def __init__(self, db_path: str | None = None) -> None:
        resolved_path = db_path or _default_db_path()
        if resolved_path != ":memory:":
            Path(resolved_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(resolved_path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._ensure_schema()

    def get(self, user_id: str) -> RetrievalWeightProfile:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT user_id, schema_version, weights_json
                FROM retrieval_weight_profiles
                WHERE user_id = ?
                """,
                (user_id,),
            ).fetchone()
        if row is None:
            return RetrievalWeightProfile(user_id=user_id)

        return RetrievalWeightProfile(
            user_id=str(row["user_id"]),
            schema_version=int(row["schema_version"]),
            weights=json.loads(str(row["weights_json"])),
        )

    def update_weights(self, user_id: str, weights: dict[str, float]) -> RetrievalWeightProfile:
        current = self.get(user_id)
        updated = replace(current, weights={**current.weights, **weights})
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO retrieval_weight_profiles (
                        user_id, schema_version, weights_json
                    )
                    VALUES (?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        schema_version = excluded.schema_version,
                        weights_json = excluded.weights_json
                    """,
                    (
                        updated.user_id,
                        updated.schema_version,
                        json.dumps(updated.weights, sort_keys=True, separators=(",", ":")),
                    ),
                )
        return updated

    def _ensure_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS retrieval_weight_profiles (
                    user_id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
                    weights_json TEXT NOT NULL
                )
                """
            )
            self._conn.commit()


def _with_weight_metadata(item: MemoryItem, weighted_score: float) -> MemoryItem:
    metadata: dict[str, Any] = dict(item.metadata)
    metadata["weighted_score"] = round(weighted_score, 6)
    return MemoryItem(
        id=item.id,
        content=item.content,
        content_type=item.content_type,
        layer=item.layer,
        metadata=metadata,
        embedding=item.embedding,
        created_at=item.created_at,
        last_accessed=item.last_accessed,
        access_count=item.access_count,
        importance_score=item.importance_score,
    )
