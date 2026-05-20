from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from quilin_mem.daemon import (
    DaemonConfig,
    JobContext,
    JobResult,
    QuilinDaemon,
)

NOW = datetime(2026, 5, 21, 1, 2, 3, tzinfo=UTC)


@dataclass(slots=True)
class FakeJob:
    id: str
    interval_seconds: float = 60
    estimated_tokens: int = 1
    estimated_cost: float = 0
    max_retries: int = 2
    backoff_seconds: float = 5
    result: JobResult = field(default_factory=lambda: JobResult.succeeded("ok"))
    delay: float = 0
    calls: int = 0
    contexts: list[JobContext] = field(default_factory=list)

    async def run(self, context: JobContext) -> JobResult:
        self.calls += 1
        self.contexts.append(context)
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.result


def test_register_and_run_once_records_success_and_logs_event() -> None:
    events: list[dict[str, Any]] = []
    daemon = QuilinDaemon(config=DaemonConfig(), logger=events.append)
    job = FakeJob(id="reflect")

    daemon.register(job)
    record = asyncio.run(daemon.run_once("reflect", now=NOW))

    assert job.calls == 1
    assert record.job_id == "reflect"
    assert record.status == "succeeded"
    assert record.started_at == NOW
    assert record.finished_at == NOW
    assert daemon.records["reflect"][-1] == record
    assert daemon.next_run_at("reflect") == NOW + timedelta(seconds=job.interval_seconds)
    assert events[-1]["event"] == "daemon.job_succeeded"
    assert events[-1]["job_id"] == "reflect"


def test_tick_due_runs_only_due_jobs() -> None:
    daemon = QuilinDaemon(config=DaemonConfig())
    due = FakeJob(id="due", interval_seconds=10)
    later = FakeJob(id="later", interval_seconds=10)
    daemon.register(due, next_run_at=NOW)
    daemon.register(later, next_run_at=NOW + timedelta(seconds=1))

    records = asyncio.run(daemon.tick_due(NOW))

    assert [record.job_id for record in records] == ["due"]
    assert due.calls == 1
    assert later.calls == 0


def test_lease_prevents_same_job_from_running_concurrently() -> None:
    daemon = QuilinDaemon(config=DaemonConfig())
    job = FakeJob(id="slow", delay=0.05)
    daemon.register(job)

    async def run_two() -> tuple[str, str]:
        first, second = await asyncio.gather(
            daemon.run_once("slow", now=NOW),
            daemon.run_once("slow", now=NOW),
        )
        return first.status, second.status

    statuses = asyncio.run(run_two())

    assert sorted(statuses) == ["skipped", "succeeded"]
    assert job.calls == 1
    assert daemon.records["slow"][0].reason == "already_running"


def test_active_task_prevents_same_process_rerun_after_lease_expiry() -> None:
    daemon = QuilinDaemon(config=DaemonConfig(lease_ttl_seconds=0.01))
    job = FakeJob(id="slow-expiring", delay=0.05)
    daemon.register(job)

    async def run_two() -> tuple[str, str]:
        first_task = asyncio.create_task(daemon.run_once("slow-expiring", now=NOW))
        await asyncio.sleep(0.02)
        second = await daemon.run_once(
            "slow-expiring",
            now=NOW + timedelta(seconds=1),
        )
        first = await first_task
        return first.status, second.status

    statuses = asyncio.run(run_two())

    assert sorted(statuses) == ["skipped", "succeeded"]
    assert job.calls == 1
    assert daemon.records["slow-expiring"][0].reason == "already_running"


def test_failure_records_retry_with_backoff_until_max_retries() -> None:
    daemon = QuilinDaemon(config=DaemonConfig())
    job = FakeJob(
        id="flaky",
        max_retries=1,
        backoff_seconds=7,
        result=JobResult.failed("provider timeout"),
    )
    daemon.register(job)

    first = asyncio.run(daemon.run_once("flaky", now=NOW))
    assert daemon.next_run_at("flaky") == NOW + timedelta(seconds=7)
    second = asyncio.run(daemon.run_once("flaky", now=NOW + timedelta(seconds=7)))

    assert first.status == "failed"
    assert first.attempt == 1
    assert first.next_run_at == NOW + timedelta(seconds=7)
    assert first.reason == "provider timeout"
    assert second.status == "failed"
    assert second.attempt == 2
    assert second.next_run_at is None
    assert daemon.next_run_at("flaky") is None


def test_stop_cancels_active_job_and_records_cancelled_status() -> None:
    daemon = QuilinDaemon(config=DaemonConfig())
    job = FakeJob(id="cancellable", delay=60)
    daemon.register(job)

    async def run_and_stop() -> str:
        task = asyncio.create_task(daemon.run_once("cancellable", now=NOW))
        await asyncio.sleep(0)
        await daemon.stop(now=NOW + timedelta(seconds=1))
        record = await task
        return record.status

    assert asyncio.run(run_and_stop()) == "cancelled"
    assert daemon.records["cancellable"][0].reason == "daemon_stopped"


def test_budget_exceeded_skips_job_without_calling_run() -> None:
    events: list[dict[str, Any]] = []
    daemon = QuilinDaemon(
        config=DaemonConfig(token_budget_per_run=10, cost_budget_per_run=0.01),
        logger=events.append,
    )
    job = FakeJob(id="expensive", estimated_tokens=11)
    daemon.register(job)

    record = asyncio.run(daemon.run_once("expensive", now=NOW))

    assert record.status == "skipped"
    assert record.reason == "token_budget_exceeded"
    assert job.calls == 0
    assert events[-1]["event"] == "daemon.job_skipped"


def test_context_heartbeat_updates_lease_store() -> None:
    daemon = QuilinDaemon(config=DaemonConfig())

    @dataclass(slots=True)
    class HeartbeatJob:
        id: str = "heartbeat"
        interval_seconds: float = 60
        estimated_tokens: int = 1
        estimated_cost: float = 0
        max_retries: int = 0
        backoff_seconds: float = 1

        async def run(self, context: JobContext) -> JobResult:
            context.heartbeat(NOW + timedelta(seconds=4))
            return JobResult.succeeded("beat")

    daemon.register(HeartbeatJob())
    record = asyncio.run(daemon.run_once("heartbeat", now=NOW))

    assert record.status == "succeeded"
    assert record.last_heartbeat_at == NOW + timedelta(seconds=4)


def test_result_record_preserves_result_metadata() -> None:
    daemon = QuilinDaemon(config=DaemonConfig())
    job = FakeJob(
        id="metrics",
        result=JobResult.succeeded(
            "stored",
            tokens_used=8,
            cost_used=0.002,
            data={"records": 3},
        ),
    )
    daemon.register(job)

    record = asyncio.run(daemon.run_once("metrics", now=NOW))

    assert record.message == "stored"
    assert record.tokens_used == 8
    assert record.cost_used == 0.002
    assert record.data == {"records": 3}
