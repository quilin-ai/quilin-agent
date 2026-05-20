from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Callable, Coroutine, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol, Self
from uuid import uuid4

JobStatus = Literal["succeeded", "failed", "skipped", "cancelled"]


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _stderr_logger(event: dict[str, Any]) -> None:
    print(json.dumps(event, default=str, sort_keys=True), file=sys.stderr)


@dataclass(slots=True, frozen=True)
class BudgetLease:
    kind: Literal["token", "cost"]
    granted: int | float
    used: int | float = 0


@dataclass(slots=True, frozen=True)
class JobResult:
    status: JobStatus
    message: str = ""
    tokens_used: int = 0
    cost_used: float = 0
    data: Mapping[str, Any] = field(default_factory=dict)
    reason: str | None = None

    @classmethod
    def succeeded(
        cls,
        message: str = "",
        *,
        tokens_used: int = 0,
        cost_used: float = 0,
        data: Mapping[str, Any] | None = None,
    ) -> Self:
        return cls(
            status="succeeded",
            message=message,
            tokens_used=tokens_used,
            cost_used=cost_used,
            data=data or {},
        )

    @classmethod
    def failed(cls, reason: str, *, message: str = "") -> Self:
        return cls(status="failed", message=message, reason=reason)

    @classmethod
    def skipped(cls, reason: str, *, message: str = "") -> Self:
        return cls(status="skipped", message=message, reason=reason)


@dataclass(slots=True, frozen=True)
class DaemonConfig:
    token_budget_per_run: int = 4_096
    cost_budget_per_run: float = 1.0
    lease_ttl_seconds: float = 300
    tick_interval_seconds: float = 1

    def __post_init__(self) -> None:
        if self.token_budget_per_run < 0:
            raise ValueError("token_budget_per_run must be non-negative")
        if self.cost_budget_per_run < 0:
            raise ValueError("cost_budget_per_run must be non-negative")
        if self.lease_ttl_seconds <= 0:
            raise ValueError("lease_ttl_seconds must be positive")
        if self.tick_interval_seconds <= 0:
            raise ValueError("tick_interval_seconds must be positive")


@dataclass(slots=True, frozen=True)
class JobRunRecord:
    job_id: str
    run_id: str
    status: JobStatus
    attempt: int
    started_at: datetime
    finished_at: datetime
    message: str = ""
    reason: str | None = None
    tokens_used: int = 0
    cost_used: float = 0
    data: Mapping[str, Any] = field(default_factory=dict)
    next_run_at: datetime | None = None
    last_heartbeat_at: datetime | None = None


@dataclass(slots=True, frozen=True)
class JobContext:
    job_id: str
    run_id: str
    started_at: datetime
    token_budget: int
    cost_budget: float
    token_lease: BudgetLease
    cost_lease: BudgetLease
    heartbeat: Callable[[datetime | None], None]


class IdleJob(Protocol):
    id: str
    interval_seconds: float
    estimated_tokens: int
    estimated_cost: float
    max_retries: int
    backoff_seconds: float

    def run(self, context: JobContext) -> Coroutine[Any, Any, JobResult]: ...


@dataclass(slots=True)
class _Lease:
    job_id: str
    owner_id: str
    acquired_at: datetime
    expires_at: datetime
    last_heartbeat_at: datetime


class LeaseStore:
    def __init__(self, *, ttl_seconds: float) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        self._ttl_seconds = ttl_seconds
        self._leases: dict[str, _Lease] = {}

    def acquire(self, job_id: str, owner_id: str, now: datetime) -> bool:
        lease = self._leases.get(job_id)
        if lease is not None and lease.expires_at > now:
            return False
        self._leases[job_id] = _Lease(
            job_id=job_id,
            owner_id=owner_id,
            acquired_at=now,
            expires_at=now + timedelta(seconds=self._ttl_seconds),
            last_heartbeat_at=now,
        )
        return True

    def release(self, job_id: str, owner_id: str) -> None:
        lease = self._leases.get(job_id)
        if lease is not None and lease.owner_id == owner_id:
            del self._leases[job_id]

    def heartbeat(self, job_id: str, owner_id: str, now: datetime) -> bool:
        lease = self._leases.get(job_id)
        if lease is None or lease.owner_id != owner_id:
            return False
        lease.last_heartbeat_at = now
        lease.expires_at = now + timedelta(seconds=self._ttl_seconds)
        return True

    def get(self, job_id: str) -> _Lease | None:
        return self._leases.get(job_id)


@dataclass(slots=True)
class _JobState:
    job: IdleJob
    next_run_at: datetime | None
    failed_attempts: int = 0


class QuilinDaemon:
    def __init__(
        self,
        *,
        config: DaemonConfig | None = None,
        logger: Callable[[dict[str, Any]], None] | None = None,
        clock: Callable[[], datetime] = _utcnow,
    ) -> None:
        self.config = config or DaemonConfig()
        self.lease_store = LeaseStore(ttl_seconds=self.config.lease_ttl_seconds)
        self.records: dict[str, list[JobRunRecord]] = {}
        self._jobs: dict[str, _JobState] = {}
        self._active_tasks: dict[str, asyncio.Task[JobResult]] = {}
        self._logger = logger or _stderr_logger
        self._clock = clock
        self._running = False
        self._stopping = False
        self._stop_time: datetime | None = None

    def register(self, job: IdleJob, *, next_run_at: datetime | None = None) -> None:
        self._validate_job(job)
        if job.id in self._jobs:
            raise ValueError(f"job already registered: {job.id}")
        self._jobs[job.id] = _JobState(job=job, next_run_at=next_run_at or self._clock())
        self.records.setdefault(job.id, [])

    def start(self) -> None:
        self._running = True
        self._stopping = False
        self._stop_time = None
        self._emit("daemon.started")

    async def stop(self, *, now: datetime | None = None) -> None:
        self._running = False
        self._stopping = True
        self._stop_time = now or self._clock()
        for task in list(self._active_tasks.values()):
            task.cancel()
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks.values(), return_exceptions=True)
        self._emit("daemon.stopped")

    def next_run_at(self, job_id: str) -> datetime | None:
        return self._state(job_id).next_run_at

    async def run_once(self, job_id: str, *, now: datetime | None = None) -> JobRunRecord:
        state = self._state(job_id)
        job = state.job
        started_at = now or self._clock()
        run_id = str(uuid4())
        attempt = state.failed_attempts + 1

        if job.id in self._active_tasks:
            record = self._record(
                job=job,
                run_id=run_id,
                status="skipped",
                attempt=attempt,
                started_at=started_at,
                finished_at=started_at,
                reason="already_running",
                next_run_at=state.next_run_at,
            )
            self._emit_record("daemon.job_skipped", record)
            return record

        if not self.lease_store.acquire(job.id, run_id, started_at):
            record = self._record(
                job=job,
                run_id=run_id,
                status="skipped",
                attempt=attempt,
                started_at=started_at,
                finished_at=started_at,
                reason="lease_busy",
                next_run_at=state.next_run_at,
            )
            self._emit_record("daemon.job_skipped", record)
            return record

        budget_skip = self._budget_skip_reason(job)
        if budget_skip is not None:
            self.lease_store.release(job.id, run_id)
            state.next_run_at = started_at + timedelta(seconds=job.interval_seconds)
            record = self._record(
                job=job,
                run_id=run_id,
                status="skipped",
                attempt=attempt,
                started_at=started_at,
                finished_at=started_at,
                reason=budget_skip,
                next_run_at=state.next_run_at,
            )
            self._emit_record("daemon.job_skipped", record)
            return record

        def heartbeat(heartbeat_at: datetime | None = None) -> None:
            self.lease_store.heartbeat(
                job.id,
                run_id,
                heartbeat_at or self._clock(),
            )

        context = JobContext(
            job_id=job.id,
            run_id=run_id,
            started_at=started_at,
            token_budget=self.config.token_budget_per_run,
            cost_budget=self.config.cost_budget_per_run,
            token_lease=BudgetLease(kind="token", granted=self.config.token_budget_per_run),
            cost_lease=BudgetLease(kind="cost", granted=self.config.cost_budget_per_run),
            heartbeat=heartbeat,
        )

        task: asyncio.Task[JobResult] = asyncio.create_task(job.run(context))
        self._active_tasks[job.id] = task
        try:
            result = await task
        except asyncio.CancelledError:
            finished_at = self._stop_time or self._clock()
            record = self._record(
                job=job,
                run_id=run_id,
                status="cancelled",
                attempt=attempt,
                started_at=started_at,
                finished_at=finished_at,
                reason="daemon_stopped" if self._stopping else "cancelled",
                next_run_at=state.next_run_at,
            )
            self._emit_record("daemon.job_cancelled", record)
            return record
        except Exception as exc:  # noqa: BLE001
            result = JobResult.failed(type(exc).__name__, message=str(exc))
        finally:
            self._active_tasks.pop(job.id, None)
            lease = self.lease_store.get(job.id)
            last_heartbeat_at = lease.last_heartbeat_at if lease is not None else None
            self.lease_store.release(job.id, run_id)

        finished_at = started_at if now is not None else self._clock()
        if result.status == "succeeded":
            state.failed_attempts = 0
            state.next_run_at = started_at + timedelta(seconds=job.interval_seconds)
        elif result.status == "failed":
            state.failed_attempts = attempt
            state.next_run_at = self._next_retry_at(job, attempt, started_at)
        else:
            state.next_run_at = started_at + timedelta(seconds=job.interval_seconds)

        record = self._record(
            job=job,
            run_id=run_id,
            status=result.status,
            attempt=attempt,
            started_at=started_at,
            finished_at=finished_at,
            message=result.message,
            reason=result.reason,
            tokens_used=result.tokens_used,
            cost_used=result.cost_used,
            data=result.data,
            next_run_at=state.next_run_at,
            last_heartbeat_at=last_heartbeat_at,
        )
        self._emit_record(f"daemon.job_{result.status}", record)
        return record

    async def tick_due(self, now: datetime | None = None) -> list[JobRunRecord]:
        tick_at = now or self._clock()
        due_job_ids = [
            job_id
            for job_id, state in self._jobs.items()
            if state.next_run_at is not None and state.next_run_at <= tick_at
        ]
        records: list[JobRunRecord] = []
        for job_id in due_job_ids:
            records.append(await self.run_once(job_id, now=tick_at))
        return records

    async def run_forever(self, stop_event: asyncio.Event | None = None) -> None:
        self.start()
        try:
            while self._running and not self._stopping:
                if stop_event is not None and stop_event.is_set():
                    break
                await self.tick_due()
                try:
                    if stop_event is None:
                        await asyncio.sleep(self.config.tick_interval_seconds)
                    else:
                        await asyncio.wait_for(
                            stop_event.wait(),
                            timeout=self.config.tick_interval_seconds,
                        )
                except TimeoutError:
                    continue
        finally:
            await self.stop()

    def _state(self, job_id: str) -> _JobState:
        try:
            return self._jobs[job_id]
        except KeyError as exc:
            raise KeyError(f"unknown job: {job_id}") from exc

    def _budget_skip_reason(self, job: IdleJob) -> str | None:
        if job.estimated_tokens > self.config.token_budget_per_run:
            return "token_budget_exceeded"
        if job.estimated_cost > self.config.cost_budget_per_run:
            return "cost_budget_exceeded"
        return None

    def _next_retry_at(self, job: IdleJob, attempt: int, started_at: datetime) -> datetime | None:
        if attempt > job.max_retries:
            return None
        return started_at + timedelta(seconds=job.backoff_seconds)

    def _record(
        self,
        *,
        job: IdleJob,
        run_id: str,
        status: JobStatus,
        attempt: int,
        started_at: datetime,
        finished_at: datetime,
        message: str = "",
        reason: str | None = None,
        tokens_used: int = 0,
        cost_used: float = 0,
        data: Mapping[str, Any] | None = None,
        next_run_at: datetime | None = None,
        last_heartbeat_at: datetime | None = None,
    ) -> JobRunRecord:
        record = JobRunRecord(
            job_id=job.id,
            run_id=run_id,
            status=status,
            attempt=attempt,
            started_at=started_at,
            finished_at=finished_at,
            message=message,
            reason=reason,
            tokens_used=tokens_used,
            cost_used=cost_used,
            data=data or {},
            next_run_at=next_run_at,
            last_heartbeat_at=last_heartbeat_at,
        )
        self.records.setdefault(job.id, []).append(record)
        return record

    def _emit_record(self, event: str, record: JobRunRecord) -> None:
        payload = {
            "job_id": record.job_id,
            "run_id": record.run_id,
            "status": record.status,
            "attempt": record.attempt,
            "reason": record.reason,
            "message": record.message,
            "tokens_used": record.tokens_used,
            "cost_used": record.cost_used,
            "next_run_at": record.next_run_at,
        }
        self._emit(event, **payload)

    def _emit(self, event: str, **fields: Any) -> None:
        payload = {"event": event, **fields}
        self._logger(payload)

    @staticmethod
    def _validate_job(job: IdleJob) -> None:
        if not job.id.strip():
            raise ValueError("job id must not be empty")
        if job.interval_seconds <= 0:
            raise ValueError("job interval_seconds must be positive")
        if job.estimated_tokens < 0:
            raise ValueError("job estimated_tokens must be non-negative")
        if job.estimated_cost < 0:
            raise ValueError("job estimated_cost must be non-negative")
        if job.max_retries < 0:
            raise ValueError("job max_retries must be non-negative")
        if job.backoff_seconds <= 0:
            raise ValueError("job backoff_seconds must be positive")


__all__ = [
    "BudgetLease",
    "DaemonConfig",
    "IdleJob",
    "JobContext",
    "JobResult",
    "JobRunRecord",
    "JobStatus",
    "LeaseStore",
    "QuilinDaemon",
]
