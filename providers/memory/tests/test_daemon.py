from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from quilin_mem.daemon import (
    DaemonConfig,
    JobContext,
    JobResult,
    LeaseStore,
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


def test_config_and_lease_store_validate_boundaries() -> None:
    for kwargs, message in (
        ({"token_budget_per_run": -1}, "token_budget_per_run"),
        ({"cost_budget_per_run": -0.1}, "cost_budget_per_run"),
        ({"lease_ttl_seconds": 0}, "lease_ttl_seconds"),
        ({"tick_interval_seconds": 0}, "tick_interval_seconds"),
    ):
        try:
            DaemonConfig(**kwargs)
        except ValueError as exc:
            assert message in str(exc)
        else:  # pragma: no cover - defensive
            raise AssertionError(f"expected ValueError for {kwargs}")

    try:
        LeaseStore(ttl_seconds=0)
    except ValueError as exc:
        assert "ttl_seconds" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("expected LeaseStore ttl validation")


def test_lease_store_rejects_wrong_owner_heartbeat_and_release() -> None:
    leases = LeaseStore(ttl_seconds=10)
    assert leases.acquire("job", "owner-a", NOW) is True
    assert leases.acquire("job", "owner-b", NOW + timedelta(seconds=1)) is False
    assert leases.heartbeat("job", "owner-b", NOW + timedelta(seconds=2)) is False
    leases.release("job", "owner-b")
    assert leases.get("job") is not None
    assert leases.heartbeat("missing", "owner-a", NOW) is False
    leases.release("job", "owner-a")
    assert leases.get("job") is None


def test_register_rejects_invalid_and_duplicate_jobs() -> None:
    daemon = QuilinDaemon(config=DaemonConfig())
    daemon.register(FakeJob(id="valid"))

    for job, message in (
        (FakeJob(id=" "), "job id"),
        (FakeJob(id="bad-interval", interval_seconds=0), "interval_seconds"),
        (FakeJob(id="bad-tokens", estimated_tokens=-1), "estimated_tokens"),
        (FakeJob(id="bad-cost", estimated_cost=-1), "estimated_cost"),
        (FakeJob(id="bad-retries", max_retries=-1), "max_retries"),
        (FakeJob(id="bad-backoff", backoff_seconds=0), "backoff_seconds"),
    ):
        try:
            daemon.register(job)
        except ValueError as exc:
            assert message in str(exc)
        else:  # pragma: no cover - defensive
            raise AssertionError(f"expected ValueError for {job.id}")

    try:
        daemon.register(FakeJob(id="valid"))
    except ValueError as exc:
        assert "already registered" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("expected duplicate job validation")

    try:
        daemon.next_run_at("missing")
    except KeyError as exc:
        assert "unknown job" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("expected unknown job")


def test_run_once_records_exception_as_failed_result() -> None:
    @dataclass(slots=True)
    class ExplodingJob:
        id: str = "explode"
        interval_seconds: float = 60
        estimated_tokens: int = 1
        estimated_cost: float = 0
        max_retries: int = 0
        backoff_seconds: float = 1

        async def run(self, context: JobContext) -> JobResult:
            del context
            raise RuntimeError("boom")

    daemon = QuilinDaemon(config=DaemonConfig())
    daemon.register(ExplodingJob())
    record = asyncio.run(daemon.run_once("explode", now=NOW))

    assert record.status == "failed"
    assert record.reason == "RuntimeError"
    assert record.message == "boom"


def test_run_forever_stops_when_event_is_set() -> None:
    daemon = QuilinDaemon(config=DaemonConfig(tick_interval_seconds=0.01))
    stop_event = asyncio.Event()
    stop_event.set()

    asyncio.run(daemon.run_forever(stop_event))

    assert daemon._stopping is True  # type: ignore[attr-defined]


def test_run_forever_cancels_active_job_when_stop_event_is_set() -> None:
    @dataclass(slots=True)
    class SlowJob:
        id: str = "slow"
        interval_seconds: float = 60
        estimated_tokens: int = 1
        estimated_cost: float = 0
        max_retries: int = 0
        backoff_seconds: float = 1

        async def run(self, context: JobContext) -> JobResult:
            context.heartbeat()
            await asyncio.sleep(10)
            return JobResult.succeeded()

    async def scenario() -> None:
        daemon = QuilinDaemon(config=DaemonConfig(tick_interval_seconds=0.01))
        daemon.register(SlowJob())
        stop_event = asyncio.Event()
        task = asyncio.create_task(daemon.run_forever(stop_event))

        while "slow" not in daemon._active_tasks:  # type: ignore[attr-defined]
            await asyncio.sleep(0)
        stop_event.set()

        await asyncio.wait_for(task, timeout=0.5)
        assert "slow" not in daemon._active_tasks  # type: ignore[attr-defined]
        records = daemon.records["slow"]
        assert records[-1].status == "cancelled"

    asyncio.run(scenario())
