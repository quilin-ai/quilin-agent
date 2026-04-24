from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from omnimem.retriever import MemoryRetriever
from omnimem.store import OmniMemStore

LONGMEMEVAL_BLOCKED_REASON = (
    "LongMemEval is not vendored in providers/memory and requires external dataset "
    "access; this M2.5 gate uses deterministic AMB four-axis local recall instead."
)
TARGET_ID = "amb-100k-target"
TARGET_QUERY = "amb_100k_probe"


async def run_benchmark(
    *,
    cache_path: str | Path,
    records: int = 100_000,
    iterations: int = 30,
    p95_gate_ms: float = 300.0,
) -> dict[str, Any]:
    if records < 1:
        raise ValueError("records must be positive")
    if iterations < 1:
        raise ValueError("iterations must be positive")

    db_path = Path(cache_path)
    if not db_path.exists():
        build_fixture(db_path, records=records)

    store = OmniMemStore(db_path=str(db_path))
    retriever = MemoryRetriever(store, bm25_limit=25)
    accuracy = await _measure_accuracy(retriever)
    speed = await _measure_speed(retriever, iterations=iterations)

    passed = accuracy["top1"] == 1.0 and speed["p95_ms"] < p95_gate_ms
    return {
        "gate": "M2.5 100k p95 recall",
        "passed": passed,
        "records": records,
        "p95_gate_ms": p95_gate_ms,
        "accuracy": accuracy,
        "speed": speed,
        "longmemeval": {
            "status": "blocked",
            "target_accuracy": 0.95,
            "reason": LONGMEMEVAL_BLOCKED_REASON,
            "alternative_evidence": "AMB four-axis deterministic 100k local fixture",
        },
    }


def build_fixture(path: str | Path, *, records: int = 100_000) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()

    conn = sqlite3.connect(str(target))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """
            CREATE TABLE memory_records (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tier TEXT NOT NULL CHECK (
                    tier IN ('working', 'episodic', 'semantic', 'skill')
                ),
                content_type TEXT NOT NULL DEFAULT 'text',
                metadata_json TEXT NOT NULL DEFAULT '{"schema_version":1}',
                embedding_json TEXT,
                created_at TEXT NOT NULL,
                last_accessed TEXT NOT NULL,
                access_count INTEGER NOT NULL DEFAULT 0,
                importance_score REAL NOT NULL DEFAULT 0.5,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
            )
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE memory_records_fts USING fts5(
                id UNINDEXED,
                content,
                keywords,
                tokenize = 'unicode61'
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE schema_version (
                component TEXT PRIMARY KEY,
                version INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO schema_version (component, version) VALUES (?, ?)",
            ("memory_records_fts", 1),
        )
        now = "2026-04-24T00:00:00+00:00"
        rows = [
            (
                TARGET_ID,
                f"Critical {TARGET_QUERY} with exact marker.",
                "episodic",
                "text",
                '{"schema_version":1,"source":"amb-100k"}',
                None,
                now,
                now,
                0,
                1.0,
                0,
            )
        ]
        rows.extend(
            (
                f"amb-100k-filler-{index:06d}",
                f"Filler memory {index:06d} deterministic local context filler_{index:06d}.",
                "episodic",
                "text",
                '{"schema_version":1,"source":"amb-100k-filler"}',
                None,
                now,
                now,
                0,
                0.5,
                0,
            )
            for index in range(records - 1)
        )
        conn.executemany(
            """
            INSERT INTO memory_records (
                id, content, tier, content_type, metadata_json, embedding_json,
                created_at, last_accessed, access_count, importance_score, deleted
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.execute(
            """
            INSERT INTO memory_records_fts (id, content, keywords)
            SELECT id, content, content FROM memory_records WHERE deleted = 0
            """
        )
        conn.commit()
    finally:
        conn.close()


async def _measure_accuracy(retriever: MemoryRetriever) -> dict[str, Any]:
    results = await retriever.retrieve_bm25(TARGET_QUERY, limit=5)
    top_ids = [item.id for item in results]
    return {"top1": 1.0 if top_ids[:1] == [TARGET_ID] else 0.0, "top5_ids": top_ids}


async def _measure_speed(retriever: MemoryRetriever, *, iterations: int) -> dict[str, Any]:
    for _ in range(5):
        await retriever.retrieve_bm25(TARGET_QUERY, limit=5)

    durations_ms: list[float] = []
    for _ in range(iterations):
        started_at = time.perf_counter()
        results = await retriever.retrieve_bm25(TARGET_QUERY, limit=5)
        durations_ms.append((time.perf_counter() - started_at) * 1_000)
        if results[:1] and results[0].id != TARGET_ID:
            raise AssertionError("100k AMB target was not first result")

    return {
        "iterations": iterations,
        "p95_ms": round(_percentile(durations_ms, 0.95), 3),
        "max_ms": round(max(durations_ms), 3),
    }


def _percentile(values: list[float], percentile: float) -> float:
    sorted_values = sorted(values)
    index = max(0, int(len(sorted_values) * percentile) - 1)
    return sorted_values[index]


def main() -> None:
    parser = argparse.ArgumentParser(description="Run M2.5 100k AMB recall gate.")
    parser.add_argument("--cache-path", default=".bench-cache/amb_100k.sqlite")
    parser.add_argument("--records", type=int, default=100_000)
    parser.add_argument("--iterations", type=int, default=30)
    args = parser.parse_args()

    evidence = asyncio.run(
        run_benchmark(
            cache_path=args.cache_path,
            records=args.records,
            iterations=args.iterations,
        )
    )
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2))
    if not evidence["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
