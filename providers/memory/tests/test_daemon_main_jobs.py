from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from quilin_mem.daemon import BudgetLease, JobContext
from quilin_mem.daemon_main import KGBackfillJob, TokenBudgetMonitorJob, _log_event
from quilin_mem.kg_extractor import ExtractedTriple
from quilin_mem.store import QuilinMemStore

NOW = datetime(2026, 5, 21, 10, 30, tzinfo=UTC)


def _context(job_id: str) -> JobContext:
    return JobContext(
        job_id=job_id,
        run_id=f"{job_id}-run",
        started_at=NOW,
        token_budget=100_000,
        cost_budget=1.0,
        token_lease=BudgetLease(kind="token", granted=100_000),
        cost_lease=BudgetLease(kind="cost", granted=1.0),
        heartbeat=lambda _at=None: None,
    )


def test_daemon_entrypoint_logger_serializes_datetime_fields(
    capsys: pytest.CaptureFixture[str],
) -> None:
    _log_event(
        {
            "event": "daemon.job_succeeded",
            "next_run_at": NOW,
            "nested": {"finished_at": NOW},
        }
    )

    payload = json.loads(capsys.readouterr().err)

    assert payload["event"] == "daemon.job_succeeded"
    assert payload["next_run_at"] == "2026-05-21T10:30:00Z"
    assert payload["nested"]["finished_at"] == "2026-05-21T10:30:00Z"


@dataclass(frozen=True, slots=True)
class FakeMemoryRecord:
    id: str
    content: str
    created_at: datetime


class FakeStore:
    def __init__(self, by_layer: dict[str, list[FakeMemoryRecord]]) -> None:
        self._by_layer = by_layer
        self.closed = False

    async def list_by_layer(
        self,
        layer: str,
        limit: int = 50,
        offset: int = 0,
    ) -> Sequence[FakeMemoryRecord]:
        return self._by_layer.get(layer, [])[offset : offset + limit]

    async def close(self) -> None:
        self.closed = True


class FakeKG:
    def __init__(self, already_backfilled: set[str] | None = None) -> None:
        self.already_backfilled = already_backfilled or set()
        self.calls: list[tuple[str, str, str, str | None]] = []
        self.closed = False

    def memory_ids_with_edges(self) -> set[str]:
        return set(self.already_backfilled)

    async def add_edge(
        self,
        subject: str,
        predicate: str,
        object: str,
        *,
        valid_from: datetime | str | None = None,
        valid_to: datetime | str | None = None,
        memory_id: str | None = None,
        weight: float = 1.0,
        metadata: dict[str, object] | None = None,
    ) -> str:
        del valid_from, valid_to, weight, metadata
        self.calls.append((subject, predicate, object, memory_id))
        return f"edge-{len(self.calls)}"

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_kg_backfill_job_runs_real_backfill_path_incrementally() -> None:
    store = FakeStore(
        {
            "working": [
                FakeMemoryRecord("old", "Ada already exists.", NOW),
                FakeMemoryRecord("new", "Ada builds Quilin.", NOW),
            ],
            "episodic": [],
            "semantic": [],
            "skill": [],
        }
    )
    kg = FakeKG(already_backfilled={"old"})

    def extractor(text: str, **_kwargs: Any) -> list[ExtractedTriple]:
        return [
            ExtractedTriple(
                subject="Ada",
                predicate="builds",
                object=text.removesuffix(".").split()[-1],
                valid_from=NOW,
                source_quote=text,
                confidence=0.9,
            )
        ]

    job = KGBackfillJob(
        store_factory=lambda: store,
        kg_factory=lambda: kg,
        extractor_fn=extractor,
        dry_run=False,
    )

    result = await job.run(_context(job.id))

    assert result.status == "succeeded"
    assert result.data["processed"] == 1
    assert result.data["edges_added"] == 1
    assert result.data["dry_run"] is False
    assert kg.calls == [("Ada", "builds", "Quilin", "new")]
    assert store.closed is True
    assert kg.closed is True


def _create_observability_db(path: Path, *, today_tokens: int) -> None:
    conn = sqlite3.connect(path)
    hour_ts = int(NOW.replace(minute=0, second=0, microsecond=0).timestamp())
    yesterday_hour_ts = int(
        (NOW - timedelta(days=1)).replace(minute=0, second=0, microsecond=0).timestamp()
    )
    conn.executescript(
        """
        CREATE TABLE metrics_hourly (
          hour_ts INTEGER NOT NULL,
          metric_name TEXT NOT NULL,
          labels_json TEXT NOT NULL DEFAULT '{}',
          count INTEGER NOT NULL DEFAULT 0,
          sum REAL NOT NULL DEFAULT 0.0,
          min REAL,
          max REAL,
          PRIMARY KEY (hour_ts, metric_name, labels_json)
        );
        CREATE TABLE agent_runs (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          model TEXT,
          tokens_used INTEGER DEFAULT 0,
          tool_calls INTEGER DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running'
        );
        """
    )
    conn.execute(
        """
        INSERT INTO metrics_hourly (hour_ts, metric_name, labels_json, count, sum, min, max)
        VALUES (?, 'quilin_llm_tokens_total', '{}', 1, ?, ?, ?)
        """,
        (hour_ts, today_tokens, today_tokens, today_tokens),
    )
    conn.execute(
        """
        INSERT INTO metrics_hourly (hour_ts, metric_name, labels_json, count, sum, min, max)
        VALUES (?, 'quilin_llm_tokens_total', '{}', 1, 999999, 999999, 999999)
        """,
        (yesterday_hour_ts,),
    )
    conn.execute(
        """
        INSERT INTO agent_runs (run_id, session_id, started_at, tokens_used, status)
        VALUES ('fallback-run', 'session', ?, 1, 'completed')
        """,
        (int(NOW.timestamp() * 1000),),
    )
    conn.commit()
    conn.close()


def _create_agent_runs_only_db(path: Path, *, today_tokens: int) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE agent_runs (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          model TEXT,
          tokens_used INTEGER DEFAULT 0,
          tool_calls INTEGER DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO agent_runs (run_id, session_id, started_at, tokens_used, status)
        VALUES ('run-today', 'session', ?, ?, 'completed')
        """,
        (int(NOW.timestamp() * 1000), today_tokens),
    )
    conn.execute(
        """
        INSERT INTO agent_runs (run_id, session_id, started_at, tokens_used, status)
        VALUES ('run-yesterday', 'session', ?, 999999, 'completed')
        """,
        (int((NOW - timedelta(days=1)).timestamp() * 1000),),
    )
    conn.commit()
    conn.close()


def _memory_warning_rows(path: Path) -> list[sqlite3.Row]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT content, tier, kind, metadata_json FROM memory_records ORDER BY rowid ASC"
    ).fetchall()
    conn.close()
    return rows


@pytest.mark.asyncio
async def test_token_budget_monitor_reads_metrics_and_writes_one_daily_warning(
    tmp_path: Path,
) -> None:
    observability_db = tmp_path / "observability.db"
    memory_db = tmp_path / "memory.db"
    _create_observability_db(observability_db, today_tokens=850)

    job = TokenBudgetMonitorJob(
        store_factory=lambda: QuilinMemStore(str(memory_db)),
        observability_db_path=str(observability_db),
        daily_token_limit=1_000,
        warning_threshold_ratio=0.8,
        clock=lambda: NOW,
    )

    first = await job.run(_context(job.id))
    second = await job.run(_context(job.id))

    assert first.status == "succeeded"
    assert first.data["tokens_used_today"] == 850
    assert first.data["usage_source"] == "observability.metrics_hourly"
    assert first.data["warning_written"] is True
    assert second.data["warning_written"] is False
    assert second.data["warning_reason"] == "already_recorded"

    rows = _memory_warning_rows(memory_db)
    assert len(rows) == 1
    assert rows[0]["tier"] == "working"
    assert rows[0]["kind"] == "workflow"
    assert "850 / 1000" in rows[0]["content"]
    metadata = json.loads(rows[0]["metadata_json"])
    assert metadata["source"] == "daemon_token_budget_monitor"
    assert metadata["warning_date"] == "2026-05-21"
    assert metadata["token_limit"] == 1_000


@pytest.mark.asyncio
async def test_token_budget_monitor_falls_back_to_agent_runs_when_metrics_are_absent(
    tmp_path: Path,
) -> None:
    observability_db = tmp_path / "observability.db"
    memory_db = tmp_path / "memory.db"
    _create_agent_runs_only_db(observability_db, today_tokens=650)

    job = TokenBudgetMonitorJob(
        store_factory=lambda: QuilinMemStore(str(memory_db)),
        observability_db_path=str(observability_db),
        daily_token_limit=1_000,
        warning_threshold_ratio=0.6,
        clock=lambda: NOW,
    )

    result = await job.run(_context(job.id))

    assert result.status == "succeeded"
    assert result.data["tokens_used_today"] == 650
    assert result.data["usage_source"] == "observability.agent_runs"
    assert result.data["warning_written"] is True
    rows = _memory_warning_rows(memory_db)
    assert len(rows) == 1
