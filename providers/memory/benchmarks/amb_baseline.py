from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any

from quilin_mem.retriever import MemoryRetriever
from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem
from quilin_mem.working import WorkingMemory

LONGMEMEVAL_BLOCKED_REASON = (
    "LongMemEval is not vendored in this repository and this M0.10 harness must "
    "run offline; per O3, AMB four-axis local evidence is used instead."
)


@dataclass(frozen=True)
class BaselineCase:
    query: str
    expected_id: str
    axis: str


EPISODIC_TARGETS: tuple[MemoryItem, ...] = (
    MemoryItem(
        id="amb-db",
        content="Decision amb_db_probe: use SQLite FTS5 BM25 for local memory recall.",
        layer="episodic",
        metadata={"schema_version": 1, "source": "amb-fixture"},
    ),
    MemoryItem(
        id="amb-user-pref",
        content="Preference amb_user_pref_probe: user wants concise Chinese progress updates.",
        layer="episodic",
        metadata={"schema_version": 1, "source": "amb-fixture"},
    ),
    MemoryItem(
        id="amb-checkpoint",
        content=(
            "Checkpoint amb_checkpoint_probe: checkpoint_failed records run_id phase "
            "task_hash error_code ts."
        ),
        layer="episodic",
        metadata={"schema_version": 1, "source": "amb-fixture"},
    ),
    MemoryItem(
        id="amb-cost",
        content="Cost amb_cost_probe: M0 memory baseline uses no vector model or network call.",
        layer="episodic",
        metadata={"schema_version": 1, "source": "amb-fixture"},
    ),
    MemoryItem(
        id="amb-latency",
        content="Latency amb_latency_probe: deterministic 1000-row local recall sample.",
        layer="episodic",
        metadata={"schema_version": 1, "source": "amb-fixture"},
    ),
)
WORKING_TARGET = MemoryItem(
    id="amb-working",
    content="Working amb_working_probe: active task is fused recall baseline validation.",
    layer="working",
    metadata={"schema_version": 1, "source": "amb-fixture"},
)
BASELINE_CASES: tuple[BaselineCase, ...] = (
    BaselineCase("amb_working_probe fused recall", "amb-working", "accuracy"),
    BaselineCase("amb_db_probe SQLite BM25", "amb-db", "accuracy"),
    BaselineCase("amb_user_pref_probe Chinese updates", "amb-user-pref", "accuracy"),
    BaselineCase("amb_checkpoint_probe task_hash", "amb-checkpoint", "accuracy"),
    BaselineCase("amb_cost_probe vector network", "amb-cost", "cost"),
)


async def run_baseline(
    *,
    sample_size: int = 1_000,
    iterations: int = 30,
) -> dict[str, Any]:
    if sample_size < len(EPISODIC_TARGETS):
        raise ValueError("sample_size must fit the episodic AMB target fixtures")
    if iterations < 1:
        raise ValueError("iterations must be at least 1")

    store = QuilinMemStore(db_path=":memory:")
    working = WorkingMemory(k=5)
    await _seed(store, working, sample_size=sample_size)
    retriever = MemoryRetriever(store, working=working)

    accuracy = await _measure_accuracy(retriever)
    speed = await _measure_speed(retriever, sample_size=sample_size, iterations=iterations)

    return {
        "accuracy": accuracy,
        "speed": speed,
        "cost": {
            "network_calls": 0,
            "vector_calls": 0,
            "kg_calls": 0,
            "estimated_extra_usd": 0.0,
            "local_only": True,
        },
        "usability": {
            "requires_network": False,
            "deterministic_fixture": True,
            "local_run_command": "cd providers/memory && uv run python benchmarks/amb_baseline.py",
            "sample_size": sample_size,
            "iterations": iterations,
        },
        "longmemeval": {
            "status": "blocked",
            "target_accuracy": 0.85,
            "reason": LONGMEMEVAL_BLOCKED_REASON,
            "alternative_evidence": "AMB accuracy/speed/cost/usability local fixture",
        },
    }


async def _seed(
    store: QuilinMemStore,
    working: WorkingMemory,
    *,
    sample_size: int,
) -> None:
    await working.push(WORKING_TARGET)
    for item in EPISODIC_TARGETS:
        await store.add(item)

    filler_count = sample_size - len(EPISODIC_TARGETS)
    for index in range(filler_count):
        await store.add(
            MemoryItem(
                content=(
                    f"Filler episodic memory {index}: deterministic local AMB context "
                    f"without target probe token filler_{index}."
                ),
                layer="episodic",
                metadata={"schema_version": 1, "source": "amb-filler"},
            )
        )


async def _measure_accuracy(retriever: MemoryRetriever) -> dict[str, Any]:
    details: list[dict[str, Any]] = []
    hits = 0
    for case in BASELINE_CASES:
        results = await retriever.retrieve(case.query, limit=5)
        top_ids = [item.id for item in results[:3]]
        hit = case.expected_id in top_ids
        hits += int(hit)
        details.append(
            {
                "query": case.query,
                "expected_id": case.expected_id,
                "top3_ids": top_ids,
                "hit": hit,
                "axis": case.axis,
            }
        )

    return {
        "top3": hits / len(BASELINE_CASES),
        "hits": hits,
        "cases": len(BASELINE_CASES),
        "details": details,
    }


async def _measure_speed(
    retriever: MemoryRetriever,
    *,
    sample_size: int,
    iterations: int,
) -> dict[str, Any]:
    for _ in range(5):
        await retriever.retrieve("amb_latency_probe local recall", limit=5)

    durations_ms: list[float] = []
    for _ in range(iterations):
        started_at = time.perf_counter()
        await retriever.retrieve("amb_latency_probe local recall", limit=5)
        durations_ms.append((time.perf_counter() - started_at) * 1_000)

    return {
        "sample_size": sample_size,
        "iterations": iterations,
        "p95_ms": round(_percentile(durations_ms, 0.95), 3),
        "max_ms": round(max(durations_ms), 3),
    }


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0

    sorted_values = sorted(values)
    index = max(0, int(len(sorted_values) * percentile) - 1)
    return sorted_values[index]


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local M0 AMB baseline harness.")
    parser.add_argument("--sample-size", type=int, default=1_000)
    parser.add_argument("--iterations", type=int, default=30)
    args = parser.parse_args()

    evidence = asyncio.run(
        run_baseline(sample_size=args.sample_size, iterations=args.iterations)
    )
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
