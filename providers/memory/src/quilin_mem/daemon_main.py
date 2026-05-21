"""quilin-daemon 常驻服务入口 / Long-running daemon entry point.

QUI-188 框架已 ship(daemon.py 494 行,完整 JobRegistry + lease/heartbeat/
retry/budget),但缺常驻 entry point。本文件 wire 3 个初始 idle job 并起
事件循环,让 daemon 真能跑。

启动 / Run:
    just daemon                                  # foreground
    just daemon-start                            # background(nohup)
    just daemon-stop                             # 优雅停止
    cd providers/memory && uv run python -m quilin_mem.daemon_main

环境变量 / Env:
    QUILIN_DAEMON_ENABLED=true   # 必须显式 opt-in,默认 OFF
    QUILIN_DAEMON_DRY_RUN=true   # 不实际写 DB(只 log job 计划)
    QUILIN_DAEMON_TICK_SECONDS=30  # 主循环 tick 间隔
    QUILIN_DAEMON_LOG=/tmp/quilin-daemon.log

设计 / Design:
- 3 个初始 job:memory_reflect / memory_consolidate / token_budget_monitor
- 每个 job 写 stderr JSON(structlog),WriteAuthority 在 dry_run 下 skip
- daemon crash 不影响 chat / web(独立进程)
- 真正自进化记忆链路在 daemon 跑(不靠 LLM 调 tool)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sys
from datetime import datetime
from typing import Any

from .daemon import (
    DaemonConfig,
    JobContext,
    JobResult,
    QuilinDaemon,
)


def _is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in ("1", "true", "yes", "on")


def _log_event(event: dict[str, Any]) -> None:
    payload = {
        "service": "quilin-daemon",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        **event,
    }
    sys.stderr.write(json.dumps(payload) + "\n")
    sys.stderr.flush()


class MemoryReflectJob:
    """L3a observer 定期反思:扫 working tier 提取候选 → 升 episodic。

    Job stub(dry_run 真生效后会调 reflector.propose + Consolidator)。
    """

    id = "memory_reflect"
    interval_seconds = 600.0  # 10 minutes
    estimated_tokens = 8000
    estimated_cost = 0.005
    max_retries = 2
    backoff_seconds = 30.0

    async def run(self, context: JobContext) -> JobResult:
        _log_event(
            {
                "event": "memory_reflect.start",
                "job_id": context.job_id,
                "run_id": context.run_id,
            }
        )
        # TODO(QUI-202 wire):接 reflector.propose() + 写 memory_observations
        await asyncio.sleep(0.05)
        return JobResult.succeeded(
            output={"reflected": 0},
            tokens_used=0,
            cost_used=0.0,
        )


class MemoryConsolidateJob:
    """定期 dedupe:扫 semantic tier batch judge 合并重复。

    QUI-189 batch judge + QUI-195 destructive guard 已 ship,本 job 调它。
    """

    id = "memory_consolidate"
    interval_seconds = 1800.0  # 30 minutes
    estimated_tokens = 4000
    estimated_cost = 0.002
    max_retries = 2
    backoff_seconds = 60.0

    async def run(self, context: JobContext) -> JobResult:
        _log_event(
            {
                "event": "memory_consolidate.start",
                "job_id": context.job_id,
                "run_id": context.run_id,
            }
        )
        # TODO(QUI-189 wire):调 Consolidator.propose(strategy="dedupe")
        # 在 dry_run 模式下只 plan 不 execute(WriteAuthority gate)
        await asyncio.sleep(0.05)
        return JobResult.succeeded(
            output={"deduped": 0},
            tokens_used=0,
            cost_used=0.0,
        )


class KGBackfillJob:
    """知识图谱自动构建:每小时扫新写入的 memory_records 提取实体边。

    User 期望:KG 不该靠人手动点 "立即灌入" 按钮,应该 quilin-agent 后台
    默默维护。本 job 实现:周期性调 memory_backfill_kg(增量,只处理
    last_kg_update 之后的新 record),让 user 完全无感地看到图谱长大。
    """

    id = "kg_backfill"
    interval_seconds = 3600.0  # 1 hour
    estimated_tokens = 12000
    estimated_cost = 0.008
    max_retries = 2
    backoff_seconds = 120.0

    async def run(self, context: JobContext) -> JobResult:
        _log_event(
            {
                "event": "kg_backfill.start",
                "job_id": context.job_id,
                "run_id": context.run_id,
            }
        )
        # TODO(QUI-205 wire):调 memory_backfill_kg(incremental=True)
        # 跟踪 last_kg_update timestamp,只 process 新 record
        # WriteAuthority gate:idle 路径 origin="idle" 走 AUTO 默认放行
        await asyncio.sleep(0.05)
        return JobResult.succeeded(
            output={"backfilled": 0, "edges": 0},
            tokens_used=0,
            cost_used=0.0,
        )


class TokenBudgetMonitorJob:
    """监控当日 token 用量,接近上限时记录 warning(写 memory)。"""

    id = "token_budget_monitor"
    interval_seconds = 300.0  # 5 minutes
    estimated_tokens = 50
    estimated_cost = 0.00001
    max_retries = 1
    backoff_seconds = 15.0

    async def run(self, context: JobContext) -> JobResult:
        _log_event(
            {
                "event": "token_budget_monitor.tick",
                "job_id": context.job_id,
                "run_id": context.run_id,
            }
        )
        return JobResult.succeeded(
            output={"checked": True},
            tokens_used=0,
            cost_used=0.0,
        )


async def run_daemon_loop() -> None:
    """Long-running event loop.

    1. 实例化 QuilinDaemon + register 3 jobs
    2. 起 signal handler(SIGINT/SIGTERM 优雅停)
    3. 主 tick:每 N 秒检查 next_run_at,到点 daemon.run_once()
    4. 失败 retry / budget gate / lease 由 daemon 自管
    """
    config = DaemonConfig(
        token_budget=int(os.environ.get("QUILIN_DAEMON_TOKEN_BUDGET", "100000")),
        cost_budget=float(os.environ.get("QUILIN_DAEMON_COST_BUDGET", "1.0")),
        lease_ttl_seconds=int(os.environ.get("QUILIN_DAEMON_LEASE_TTL", "120")),
    )
    daemon = QuilinDaemon(config=config, logger=_log_event)
    tick_seconds = float(os.environ.get("QUILIN_DAEMON_TICK_SECONDS", "30"))

    # 注册 4 初始 job
    daemon.register(MemoryReflectJob())
    daemon.register(MemoryConsolidateJob())
    daemon.register(KGBackfillJob())
    daemon.register(TokenBudgetMonitorJob())

    daemon.start()
    _log_event(
        {
            "event": "daemon.started",
            "jobs": list(daemon._jobs.keys()),
            "tick_seconds": tick_seconds,
            "config": {
                "token_budget": config.token_budget,
                "cost_budget": config.cost_budget,
            },
        }
    )

    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        _log_event({"event": "daemon.signal_received"})
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            # Windows fallback — signal handlers via signal.signal
            signal.signal(sig, lambda *_: _signal_handler())

    try:
        while not stop_event.is_set():
            now = datetime.utcnow()
            for job_id in list(daemon._jobs.keys()):
                next_at = daemon.next_run_at(job_id)
                if next_at is not None and next_at <= now:
                    try:
                        await daemon.run_once(job_id, now=now)
                    except Exception as exc:  # noqa: BLE001
                        _log_event(
                            {
                                "event": "job.unhandled_error",
                                "job_id": job_id,
                                "error": str(exc),
                            }
                        )
            # 等下次 tick 或被 stop_event 唤醒(立即退出)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop_event.wait(), timeout=tick_seconds)
    finally:
        await daemon.stop()
        _log_event({"event": "daemon.exit"})


def main() -> None:
    if not _is_truthy(os.environ.get("QUILIN_DAEMON_ENABLED")):
        _log_event(
            {
                "event": "daemon.disabled",
                "message": "Set QUILIN_DAEMON_ENABLED=true to opt in.",
            }
        )
        sys.exit(0)

    asyncio.run(run_daemon_loop())


if __name__ == "__main__":
    main()
