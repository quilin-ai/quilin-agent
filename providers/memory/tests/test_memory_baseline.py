from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from benchmarks.amb_baseline import LONGMEMEVAL_BLOCKED_REASON, run_baseline


async def test_m0_amb_baseline_outputs_four_axes_and_blocked_longmemeval() -> None:
    evidence = await run_baseline(sample_size=1_000, iterations=20)

    accuracy = evidence["accuracy"]
    speed = evidence["speed"]
    cost = evidence["cost"]
    usability = evidence["usability"]
    longmemeval = evidence["longmemeval"]

    assert accuracy["top3"] == 1.0
    assert accuracy["hits"] == accuracy["cases"] == 5
    assert len(accuracy["details"]) == 5

    assert speed["sample_size"] == 1_000
    assert speed["iterations"] == 20
    assert speed["p95_ms"] < 100
    assert speed["max_ms"] >= speed["p95_ms"]

    assert cost == {
        "network_calls": 0,
        "vector_calls": 0,
        "kg_calls": 0,
        "estimated_extra_usd": 0.0,
        "local_only": True,
    }
    assert usability["requires_network"] is False
    assert usability["deterministic_fixture"] is True
    assert "amb_baseline.py" in usability["local_run_command"]

    assert longmemeval["status"] == "blocked"
    assert longmemeval["target_accuracy"] == 0.85
    assert longmemeval["reason"] == LONGMEMEVAL_BLOCKED_REASON
    assert "AMB" in longmemeval["alternative_evidence"]
