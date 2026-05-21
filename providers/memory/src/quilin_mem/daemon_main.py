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
import inspect
import json
import os
import signal
import sqlite3
import sys
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .daemon import (
    DaemonConfig,
    JobContext,
    JobResult,
    QuilinDaemon,
)

# QUI-202/QUI-189 wire (2026-05-21):2 个 idle job 从 stub 接到真 backend。
# Reflector.propose() 是 sync,吃 episodic_records Sequence,返
# ReflectionProposal list(planning only,不写 DB)。真 commit 走
# Reflector.commit_insight() + WriteAuthorityGate,daemon 默认 dry_run
# 不 commit(等显式 opt-in 接 WriteAuthority 实例)。
# Consolidator.propose(strategy="dedupe") 是 sync,返 ConsolidationProposal
# (含 dedupe groups + memory_ids)。真 commit 复用 web route 的
# executeDeletions 等价路径:遍历 actions 的 delete_ids 调
# store.delete(memory_id)。daemon 默认 dry_run 不 delete。


def _is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in ("1", "true", "yes", "on")


def _json_default(value: object) -> object:
    if isinstance(value, datetime):
        normalized = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
        return normalized.isoformat().replace("+00:00", "Z")
    return str(value)


def _log_event(event: dict[str, Any]) -> None:
    payload = {
        "service": "quilin-daemon",
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        **event,
    }
    sys.stderr.write(json.dumps(payload, default=_json_default) + "\n")
    sys.stderr.flush()


@dataclass(frozen=True, slots=True)
class _TokenUsageSnapshot:
    tokens_used: int
    source: str
    error: str | None = None


PREDICTIVE_WARM_KIND = "predictive_warm"
PREDICTIVE_WARM_TTL = timedelta(hours=24)
_PREDICTIVE_WARM_STOP_TERMS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "context",
        "do",
        "for",
        "how",
        "i",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "prepare",
        "should",
        "the",
        "to",
        "what",
        "with",
    }
)


@dataclass(frozen=True, slots=True)
class _RecentUserQuery:
    query_id: str
    content: str
    observed_at: datetime


class _IncrementalBackfillStore:
    """Filtered store facade so KG backfill can keep its existing paging contract."""

    def __init__(self, base_store: Any, skip_memory_ids: set[str], *, page_size: int) -> None:
        self._base_store = base_store
        self._skip_memory_ids = skip_memory_ids
        self._page_size = max(1, page_size)
        self._cache: dict[str, list[Any]] = {}
        self.skipped_existing = 0

    async def list_by_layer(
        self,
        layer: str,
        limit: int = 50,
        offset: int = 0,
    ) -> Sequence[Any]:
        records = await self._records_for_layer(layer)
        return records[max(offset, 0) : max(offset, 0) + max(limit, 0)]

    async def _records_for_layer(self, layer: str) -> list[Any]:
        if layer in self._cache:
            return self._cache[layer]

        records: list[Any] = []
        source_offset = 0
        skipped_existing = 0
        while True:
            batch = await self._base_store.list_by_layer(
                layer,
                limit=self._page_size,
                offset=source_offset,
            )
            if not batch:
                break
            for record in batch:
                if str(getattr(record, "id", "")) in self._skip_memory_ids:
                    skipped_existing += 1
                    continue
                records.append(record)
            source_offset += len(batch)
            if len(batch) < self._page_size:
                break

        self.skipped_existing += skipped_existing
        self._cache[layer] = records
        return records


async def _close_resource(resource: Any) -> None:
    close = getattr(resource, "close", None)
    if close is None:
        return
    result = close()
    if inspect.isawaitable(result):
        await result


async def _memory_ids_with_edges(kg: Any) -> set[str]:
    method = getattr(kg, "memory_ids_with_edges", None)
    if callable(method):
        result = method()
        if inspect.isawaitable(result):
            result = await result
        return {str(memory_id) for memory_id in result if memory_id is not None}

    conn = getattr(kg, "_conn", None)
    if conn is None:
        return set()

    lock = getattr(kg, "_lock", None)

    def query() -> set[str]:
        cm = lock if lock is not None else contextlib.nullcontext()
        with cm:
            rows = conn.execute(
                "SELECT DISTINCT memory_id FROM kg_edges WHERE memory_id IS NOT NULL"
            ).fetchall()
        return {str(row[0]) for row in rows if row[0] is not None}

    return await asyncio.to_thread(query)


def _coerce_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _day_bounds(now: datetime) -> tuple[datetime, datetime]:
    start = _coerce_utc(now).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def _observability_db_path(explicit_path: str | None) -> Path:
    if explicit_path:
        return Path(explicit_path)
    env_path = os.environ.get("QUILIN_OBSERVABILITY_DB_PATH")
    if env_path:
        return Path(env_path)
    return Path.home() / ".quilin" / "observability.db"


def _observability_logs_dir(explicit_dir: str | None) -> Path:
    if explicit_dir:
        return Path(explicit_dir)
    env_dir = os.environ.get("QUILIN_OBSERVABILITY_LOGS_DIR")
    if env_dir:
        return Path(env_dir)
    return Path(".logs")


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _parse_datetime(raw_value: object, *, fallback: datetime) -> datetime:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return fallback
    try:
        return _coerce_utc(datetime.fromisoformat(raw_value))
    except ValueError:
        return fallback


def _deserialize_metadata(metadata_json: object) -> dict[str, object]:
    if not isinstance(metadata_json, str) or not metadata_json:
        return {}
    try:
        loaded = json.loads(metadata_json)
    except json.JSONDecodeError:
        return {}
    return dict(loaded) if isinstance(loaded, dict) else {}


def _metadata_marks_user_query(metadata: dict[str, object]) -> bool:
    role = str(metadata.get("role", "")).strip().lower()
    if role == "user":
        return True
    query_role = str(metadata.get("query_role", "")).strip().lower()
    if query_role == "user":
        return True
    source = str(metadata.get("source", "")).strip().lower()
    if source in {"conversation_user", "memory_recall_query", "user_query", "user_turn"}:
        return True
    return metadata.get("is_user_query") is True


def _recent_user_queries_from_store(
    store: Any,
    *,
    limit: int,
    now: datetime,
) -> list[_RecentUserQuery]:
    if limit <= 0:
        return []

    conn = getattr(store, "_conn", None)
    if conn is None:
        return []

    lock = getattr(store, "_lock", None)
    seen: set[str] = set()
    queries: list[_RecentUserQuery] = []

    def add_query(query_id: object, content: object, observed_at: object) -> None:
        if not isinstance(content, str):
            return
        normalized = " ".join(content.split())
        if not normalized:
            return
        dedupe_key = normalized.lower()
        if dedupe_key in seen:
            return
        seen.add(dedupe_key)
        queries.append(
            _RecentUserQuery(
                query_id=str(query_id),
                content=normalized,
                observed_at=_parse_datetime(observed_at, fallback=now),
            )
        )

    cm = lock if lock is not None else contextlib.nullcontext()
    with cm:
        if _table_exists(conn, "memory_observations"):
            rows = conn.execute(
                """
                SELECT id, content, observed_at
                FROM memory_observations
                WHERE lower(COALESCE(role, '')) = 'user'
                ORDER BY observed_at DESC, rowid DESC
                LIMIT ?
                """,
                (limit * 4,),
            ).fetchall()
            for row in rows:
                add_query(row["id"], row["content"], row["observed_at"])
                if len(queries) >= limit:
                    return queries

        if _table_exists(conn, "memory_records"):
            rows = conn.execute(
                """
                SELECT id, content, created_at, metadata_json
                FROM memory_records
                WHERE deleted = 0
                  AND is_latest = 1
                  AND (kind IS NULL OR kind != ?)
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
                """,
                (PREDICTIVE_WARM_KIND, limit * 4),
            ).fetchall()
            for row in rows:
                metadata = _deserialize_metadata(row["metadata_json"])
                if not _metadata_marks_user_query(metadata):
                    continue
                add_query(row["id"], row["content"], row["created_at"])
                if len(queries) >= limit:
                    break

    return queries


def _predictive_query_terms(queries: Sequence[_RecentUserQuery]) -> list[str]:
    from .store_search import extract_search_terms

    counter: Counter[str] = Counter()
    for query in queries:
        counter.update(
            term
            for term in extract_search_terms(query.content)
            if len(term) > 1 and term not in _PREDICTIVE_WARM_STOP_TERMS
        )
    return [term for term, _count in counter.most_common(12)]


def _excerpt(content: str, *, max_length: int = 220) -> str:
    collapsed = " ".join(content.split())
    if len(collapsed) <= max_length:
        return collapsed
    return f"{collapsed[: max_length - 1]}..."


def _build_predictive_warm_content(
    *,
    predicted_query: str,
    evidence: Sequence[Any],
) -> str:
    lines = [
        "Prepared predictive context for likely next user query.",
        f"Likely query: {predicted_query}",
        "Evidence cache:",
    ]
    for item in evidence:
        lines.append(f"- {item.id}: {_excerpt(item.content)}")
    return "\n".join(lines)


def _active_predictive_warm_exists(store: Any, *, predicted_query: str, now: datetime) -> bool:
    conn = getattr(store, "_conn", None)
    if conn is None:
        return False

    lock = getattr(store, "_lock", None)
    cm = lock if lock is not None else contextlib.nullcontext()
    with cm:
        rows = conn.execute(
            """
            SELECT metadata_json, forget_after, recovered_at
            FROM memory_records
            WHERE kind = ?
              AND deleted = 0
              AND is_latest = 1
            ORDER BY rowid DESC
            LIMIT 50
            """,
            (PREDICTIVE_WARM_KIND,),
        ).fetchall()

    for row in rows:
        metadata = _deserialize_metadata(row["metadata_json"])
        if metadata.get("predicted_query") != predicted_query:
            continue
        forget_after = _parse_datetime(row["forget_after"], fallback=now + PREDICTIVE_WARM_TTL)
        if row["recovered_at"] is not None or forget_after > now:
            return True
    return False


def _insert_predictive_warm(
    store: Any,
    *,
    context: JobContext,
    predicted_query: str,
    queries: Sequence[_RecentUserQuery],
    evidence: Sequence[Any],
    query_terms: Sequence[str],
    now: datetime,
) -> str:
    from .store_records import insert_memory
    from .store_search import build_keywords
    from .types import MemoryItem

    expires_at = now + PREDICTIVE_WARM_TTL
    metadata: dict[str, object] = {
        "schema_version": 1,
        "source": "daemon_predictive_warmer",
        "run_id": context.run_id,
        "predicted_query": predicted_query,
        "query_terms": list(query_terms),
        "recent_query_ids": [query.query_id for query in queries],
        "evidence_ids": [item.id for item in evidence],
        "evidence_count": len(evidence),
        "expires_at": expires_at.isoformat(),
        "expiry_field": "forget_after",
        "preanswer": False,
    }
    record = MemoryItem(
        content=_build_predictive_warm_content(
            predicted_query=predicted_query,
            evidence=evidence,
        ),
        layer="episodic",
        metadata=metadata,
        created_at=now,
        last_accessed=now,
        importance_score=0.95,
        salience={
            "schema_version": 2,
            "utility": 0.86,
            "personal_relevance": 0.75,
            "actionability": 0.82,
            "temporal_relevance": 0.92,
            "stability": 0.35,
        },
        kind=PREDICTIVE_WARM_KIND,
    )

    conn = store._conn
    lock = getattr(store, "_lock", None)
    cm = lock if lock is not None else contextlib.nullcontext()
    with cm:
        conn.execute("BEGIN IMMEDIATE")
        with conn:
            insert_memory(
                conn,
                record,
                build_keywords=build_keywords,
                source_event_id=context.run_id,
                forget_after=expires_at,
                strength=0.35,
            )
    return record.id


def _metric_tokens_for_day(
    conn: sqlite3.Connection,
    day_start: datetime,
    day_end: datetime,
) -> int | None:
    if not _table_exists(conn, "metrics_hourly"):
        return None

    row = conn.execute(
        """
        SELECT COUNT(*) AS row_count, COALESCE(SUM(sum), 0) AS token_sum
        FROM metrics_hourly
        WHERE metric_name = 'quilin_llm_tokens_total'
          AND hour_ts >= ?
          AND hour_ts < ?
        """,
        (int(day_start.timestamp()), int(day_end.timestamp())),
    ).fetchone()
    if row is None or int(row["row_count"]) == 0:
        return None
    return int(row["token_sum"] or 0)


def _agent_run_tokens_for_day(
    conn: sqlite3.Connection,
    day_start: datetime,
    day_end: datetime,
) -> int | None:
    if not _table_exists(conn, "agent_runs"):
        return None

    start_s = int(day_start.timestamp())
    end_s = int(day_end.timestamp())
    start_ms = start_s * 1000
    end_ms = end_s * 1000
    row = conn.execute(
        """
        SELECT COUNT(*) AS row_count, COALESCE(SUM(tokens_used), 0) AS token_sum
        FROM agent_runs
        WHERE (started_at >= ? AND started_at < ?)
           OR (started_at >= ? AND started_at < ?)
        """,
        (start_ms, end_ms, start_s, end_s),
    ).fetchone()
    if row is None or int(row["row_count"]) == 0:
        return None
    return int(row["token_sum"] or 0)


def _read_tokens_from_observability_db(path: Path, now: datetime) -> _TokenUsageSnapshot | None:
    if not path.exists():
        return None

    day_start, day_end = _day_bounds(now)
    try:
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            metric_tokens = _metric_tokens_for_day(conn, day_start, day_end)
            if metric_tokens is not None:
                return _TokenUsageSnapshot(metric_tokens, "observability.metrics_hourly")
            agent_run_tokens = _agent_run_tokens_for_day(conn, day_start, day_end)
            if agent_run_tokens is not None:
                return _TokenUsageSnapshot(agent_run_tokens, "observability.agent_runs")
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return _TokenUsageSnapshot(
            0,
            "observability.db_error",
            error=f"{type(exc).__name__}: {exc}",
        )
    return None


def _read_tokens_from_trace_log(logs_dir: Path, now: datetime) -> _TokenUsageSnapshot | None:
    log_path = logs_dir / f"traces-{_coerce_utc(now).date().isoformat()}.jsonl"
    if not log_path.exists() or not log_path.is_file():
        return None

    tokens = 0
    spans_seen = 0
    try:
        with log_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    span = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if span.get("name") != "llm.invoke":
                    continue
                attrs = span.get("attributes")
                if not isinstance(attrs, dict):
                    continue
                spans_seen += 1
                for key in ("llm.tokens_input", "llm.tokens_output", "llm.tokens_thinking"):
                    value = attrs.get(key)
                    if isinstance(value, int | float):
                        tokens += int(value)
    except OSError as exc:
        return _TokenUsageSnapshot(
            0,
            "observability.trace_log_error",
            error=f"{type(exc).__name__}: {exc}",
        )

    if spans_seen == 0:
        return None
    return _TokenUsageSnapshot(tokens, "observability.trace_log")


def _read_daily_token_usage(
    *,
    observability_db_path: str | None,
    logs_dir: str | None,
    now: datetime,
) -> _TokenUsageSnapshot:
    db_snapshot = _read_tokens_from_observability_db(
        _observability_db_path(observability_db_path),
        now,
    )
    if db_snapshot is not None and db_snapshot.source != "observability.db_error":
        return db_snapshot

    log_snapshot = _read_tokens_from_trace_log(_observability_logs_dir(logs_dir), now)
    if log_snapshot is not None:
        return log_snapshot
    if db_snapshot is not None:
        return db_snapshot
    return _TokenUsageSnapshot(0, "observability.unavailable")


def _warning_already_recorded(store: Any, warning_date: str) -> bool:
    conn = getattr(store, "_conn", None)
    if conn is None:
        return False

    lock = getattr(store, "_lock", None)
    cm = lock if lock is not None else contextlib.nullcontext()
    with cm:
        rows = conn.execute(
            """
            SELECT metadata_json
            FROM memory_records
            WHERE deleted = 0 AND is_latest = 1
            """
        ).fetchall()
    for row in rows:
        try:
            metadata = json.loads(row["metadata_json"] or "{}")
        except (KeyError, TypeError, json.JSONDecodeError):
            continue
        if not isinstance(metadata, dict):
            continue
        if (
            metadata.get("source") == "daemon_token_budget_monitor"
            and metadata.get("warning_date") == warning_date
        ):
            return True
    return False


async def _write_token_budget_warning(
    store: Any,
    *,
    now: datetime,
    tokens_used: int,
    daily_token_limit: int,
    threshold_ratio: float,
    usage_source: str,
) -> None:
    from .types import MemoryItem

    warning_date = _coerce_utc(now).date().isoformat()
    percent = round(tokens_used / daily_token_limit * 100, 1)
    await store.add(
        MemoryItem(
            content=(
                "Daemon token budget warning: "
                f"{tokens_used} / {daily_token_limit} tokens used today ({percent}%)."
            ),
            layer="working",
            metadata={
                "schema_version": 1,
                "source": "daemon_token_budget_monitor",
                "warning_date": warning_date,
                "token_usage": tokens_used,
                "token_limit": daily_token_limit,
                "threshold_ratio": threshold_ratio,
                "usage_source": usage_source,
            },
            kind="workflow",
            created_at=_coerce_utc(now),
        )
    )


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
        # QUI-202 wire:接 Reflector.propose 真路径。
        # 当前阶段(2026-05-21):only plan,不 commit。
        #   - Reflector.propose 是 sync,吃 episodic_records,返 ReflectionProposal list
        #   - 真 commit 走 reflector.commit_insight(proposal, store, write_authority)
        #     需要 WriteAuthorityGate 实例。daemon 进程默认 dry_run 不接 gate。
        # 后续接入 WriteAuthority 后(env QUILIN_DAEMON_DRY_RUN=false + gate),
        # 这里可调 reflector.commit_insight 真写 semantic。
        from .reflector import Reflector
        from .store import QuilinMemStore

        dry_run = _is_truthy(os.environ.get("QUILIN_DAEMON_DRY_RUN", "true"))
        proposals_count = 0
        records_seen = 0
        error: str | None = None

        store: QuilinMemStore | None = None
        try:
            store = QuilinMemStore()
            # _count_sync / _list_by_layer_sync 是 store 内部 sync helper,
            # 在 daemon async 上下文里直接调安全(短查询,无阻塞 IO 风险)。
            episodic_count = store._count_sync({"layer": "episodic"})
            records_seen = episodic_count
            if episodic_count > 0:
                records = store._list_by_layer_sync(
                    "episodic",
                    limit=episodic_count,
                    offset=0,
                )
                reflector = Reflector()
                proposals = reflector.propose(records)
                proposals_count = len(proposals)
        except Exception as exc:  # noqa: BLE001 — best-effort,不阻塞后续 job
            error = f"{type(exc).__name__}: {exc}"
            _log_event(
                {
                    "event": "memory_reflect.error",
                    "job_id": context.job_id,
                    "run_id": context.run_id,
                    "error": error,
                }
            )
        finally:
            if store is not None:
                with contextlib.suppress(Exception):
                    store._close_sync()

        _log_event(
            {
                "event": "memory_reflect.done",
                "job_id": context.job_id,
                "run_id": context.run_id,
                "dry_run": dry_run,
                "records_seen": records_seen,
                "proposals": proposals_count,
                "promoted": 0,  # commit_insight 未接,实际未写
                "error": error,
            }
        )
        return JobResult.succeeded(
            data={
                "records_seen": records_seen,
                "proposals": proposals_count,
                "promoted": 0,
                "dry_run": dry_run,
                "error": error,
            },
            # Reflector.propose 本身不消耗 LLM(deterministic info-gain gate);
            # 只有 commit_insight 调 LLM_caller 才花 token。这里返 0 是准的。
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
        # QUI-189 wire:接 Consolidator.propose(strategy="dedupe") 真路径。
        # Consolidator.propose 是 sync,返 ConsolidationProposal(含 dedupe groups)。
        #   - dry_run=true(默认):only plan,不动 DB
        #   - dry_run=false:遍历 proposal.actions,对每个 dedupe action 调
        #     store.delete(delete_id) 真合并(等价 web route executeDeletions)
        # IdleBudgetProvider 默认 enabled=False 会让 dedupe 永远拒,daemon 这里
        # 注入 enabled=True 跟 web 的 user-triggered preview 路径对齐(参见
        # server._memory_consolidate_plan_with_store)。
        from .consolidator import (
            DEFAULT_PER_PAIR_FALLBACK_MAX_RECORDS,
            Consolidator,
            _DeepseekBatchJudge,
            _DeepseekConsolidationJudge,
            _env_flag_disabled,
        )
        from .idle_budget import IdleBudgetProvider
        from .store import QuilinMemStore

        dry_run = _is_truthy(os.environ.get("QUILIN_DAEMON_DRY_RUN", "true"))
        proposals_count = 0
        delete_candidates = 0
        writes_performed = 0
        error: str | None = None

        store: QuilinMemStore | None = None
        try:
            store = QuilinMemStore()
            budget_provider = IdleBudgetProvider(enabled=True, token_budget=1_000_000)
            # batch judge 优先,失败 fallback per-pair。无 DEEPSEEK_API_KEY 时
            # 两条 judge 都会返 distinct / ok=False,降级走 exact-only 路径。
            dedupe_judge = _DeepseekConsolidationJudge().judge
            batch_judge = None
            if not _env_flag_disabled("QUILIN_DEDUPE_BATCH_ENABLED"):
                batch_judge = _DeepseekBatchJudge().judge_batch

            consolidator = Consolidator(
                budget_provider=budget_provider,
                store=store,
                dedupe_judge=dedupe_judge,
                batch_judge=batch_judge,
                batch_max_calls=1,
                per_pair_fallback_max_records=DEFAULT_PER_PAIR_FALLBACK_MAX_RECORDS,
            )
            proposal = consolidator.propose(
                strategy="dedupe",
                task="quilin_mem.daemon.memory_consolidate",
            )
            proposals_count = len(proposal.actions)
            for action in proposal.actions:
                if action.kind != "dedupe":
                    continue
                raw_delete_ids = action.metadata.get("delete_ids")
                if not isinstance(raw_delete_ids, list | tuple):
                    continue
                delete_candidates += len(raw_delete_ids)
                if dry_run:
                    continue
                # Real-execute path:逐条 store.delete,任一失败不阻塞其余。
                for delete_id in raw_delete_ids:
                    if not isinstance(delete_id, str):
                        continue
                    try:
                        store._delete_sync(delete_id)
                        writes_performed += 1
                    except Exception as exc:  # noqa: BLE001
                        _log_event(
                            {
                                "event": "memory_consolidate.delete_failed",
                                "memory_id": delete_id,
                                "error": f"{type(exc).__name__}: {exc}",
                            }
                        )
        except Exception as exc:  # noqa: BLE001 — best-effort,不阻塞后续 job
            error = f"{type(exc).__name__}: {exc}"
            _log_event(
                {
                    "event": "memory_consolidate.error",
                    "job_id": context.job_id,
                    "run_id": context.run_id,
                    "error": error,
                }
            )
        finally:
            if store is not None:
                with contextlib.suppress(Exception):
                    store._close_sync()

        _log_event(
            {
                "event": "memory_consolidate.done",
                "job_id": context.job_id,
                "run_id": context.run_id,
                "dry_run": dry_run,
                "proposals": proposals_count,
                "delete_candidates": delete_candidates,
                "executed": writes_performed,
                "error": error,
            }
        )
        return JobResult.succeeded(
            data={
                "proposals": proposals_count,
                "delete_candidates": delete_candidates,
                "executed": writes_performed,
                "dry_run": dry_run,
                "error": error,
            },
            # Batch LLM judge 实际 token 消耗在 _DeepseekBatchJudge 内部,
            # 没暴露 caller-visible counter。这里返 estimated_tokens 占位,
            # daemon budget gate 用的是 job.estimated_tokens 不是 result。
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

    def __init__(
        self,
        *,
        store_factory: Callable[[], Any] | None = None,
        kg_factory: Callable[[], Any] | None = None,
        extractor_fn: Callable[..., Any] | None = None,
        batch_size: int = 100,
        max_records: int | None = None,
        dry_run: bool | None = None,
        incremental: bool = True,
    ) -> None:
        self._store_factory = store_factory
        self._kg_factory = kg_factory
        self._extractor_fn = extractor_fn
        self._batch_size = batch_size
        self._max_records = max_records
        self._dry_run = dry_run
        self._incremental = incremental

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
        from .kg import TemporalKnowledgeGraph
        from .kg_backfill import backfill_kg_from_memory
        from .store import QuilinMemStore

        dry_run = (
            self._dry_run
            if self._dry_run is not None
            else _is_truthy(
                os.environ.get("QUILIN_DAEMON_KG_DRY_RUN")
                or os.environ.get("QUILIN_DAEMON_DRY_RUN")
            )
        )
        store = (self._store_factory or QuilinMemStore)()
        kg = (self._kg_factory or TemporalKnowledgeGraph)()
        skipped_existing = 0
        try:
            incremental_store: _IncrementalBackfillStore | None = None
            backfill_store = store
            if self._incremental:
                existing_memory_ids = await _memory_ids_with_edges(kg)
                if existing_memory_ids:
                    incremental_store = _IncrementalBackfillStore(
                        store,
                        existing_memory_ids,
                        page_size=self._batch_size,
                    )
                    backfill_store = incremental_store

            result = await backfill_kg_from_memory(
                store=backfill_store,
                kg=kg,
                batch_size=self._batch_size,
                max_records=self._max_records,
                dry_run=dry_run,
                extractor_fn=self._extractor_fn,
            )
            if incremental_store is not None:
                skipped_existing = incremental_store.skipped_existing
            data = {
                **result.to_dict(),
                "incremental": self._incremental,
                "skipped_existing": skipped_existing,
            }
            _log_event(
                {
                    "event": "kg_backfill.done",
                    "job_id": context.job_id,
                    "run_id": context.run_id,
                    **data,
                }
            )
            return JobResult.succeeded(
                (
                    f"processed {result.processed} memory records, "
                    f"added {result.edges_added} KG edges"
                ),
                data=data,
                tokens_used=0,
                cost_used=0.0,
            )
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
            _log_event(
                {
                    "event": "kg_backfill.error",
                    "job_id": context.job_id,
                    "run_id": context.run_id,
                    "error": error,
                }
            )
            return JobResult.failed(type(exc).__name__, message=str(exc))
        finally:
            with contextlib.suppress(Exception):
                await _close_resource(kg)
            with contextlib.suppress(Exception):
                await _close_resource(store)


class _NoopWriteAuthorityGate:
    """Default WriteAuthority gate for daemon use.

    Under dry_run(daemon default)nothing reaches disk, so a permissive gate
    is safe and keeps the gate-call instrumented in logs. When the operator
    opts into real writes(``QUILIN_DAEMON_DRY_RUN=false``)they must supply
    a real CRITICAL gate via :class:`SkillCandidateProposerJob`'s factory
    parameter — we deliberately refuse to ship a "yes-man" default into the
    write path.

    daemon 默认 dry_run 路径用的占位 gate。真启用写盘必须显式注入 CRITICAL gate,
    避免静默放过 skill_create / origin="proposal" 这类高风险操作。
    """

    def __init__(self, *, allow: bool) -> None:
        self._allow = allow

    def authorize(self, _request: dict[str, object]) -> dict[str, object]:
        return {"allowed": self._allow}


class SkillCandidateProposerJob:
    """Periodically propose SKILL.md candidates and route writes through
    WriteAuthority.

    Wiring strategy:

    * The daemon does not yet own a store-backed ``TrajectoryCase`` pipeline
      (the observer collects raw turns; the compressor expects buffered
      ``ObservationTurn`` sequences). To avoid faking that pipeline, we accept
      an injectable ``case_provider`` callable returning a sequence of
      :class:`TrajectoryCase`. When the provider is unset or returns an
      empty list, we log "no cases" and skip — no fake propose path.
    * Writes always traverse ``write_authority``. When ``QUILIN_DAEMON_DRY_RUN``
      is truthy(daemon default), the writer is invoked with ``dry_run=True``
      so it only authorises + logs; nothing reaches disk.

    周期触发 SKILL.md 候选写盘任务。daemon 当前没有 store-backed 的
    ``TrajectoryCase`` 流水线(observer 只采原始 turn,compressor 吃缓冲),
    所以这里要求显式注入 ``case_provider``,缺省返回空列表 + 日志告警,而不是
    伪造数据触发写盘。``QUILIN_DAEMON_DRY_RUN`` 默认 truthy,写盘只授权 + 记日志。
    """

    id = "skill_candidate_proposer"
    interval_seconds = 3600.0  # 60 minutes — propose conservatively
    estimated_tokens = 2000
    estimated_cost = 0.001
    max_retries = 1
    backoff_seconds = 90.0

    def __init__(
        self,
        *,
        case_provider: Callable[[], Sequence[Any]] | None = None,
        proposer_factory: Callable[[], Any] | None = None,
        writer_factory: Callable[[], Any] | None = None,
        write_authority_factory: Callable[[], Any] | None = None,
        dry_run: bool | None = None,
    ) -> None:
        self._case_provider = case_provider
        self._proposer_factory = proposer_factory
        self._writer_factory = writer_factory
        self._write_authority_factory = write_authority_factory
        self._dry_run = dry_run

    async def run(self, context: JobContext) -> JobResult:
        from .skill_proposer import (
            SkillProposer,
            SkillProposerWriter,
        )

        dry_run = (
            self._dry_run
            if self._dry_run is not None
            else _is_truthy(os.environ.get("QUILIN_DAEMON_DRY_RUN", "true"))
        )

        _log_event(
            {
                "event": "skill_candidate_proposer.start",
                "job_id": context.job_id,
                "run_id": context.run_id,
                "dry_run": dry_run,
            }
        )

        cases = list(self._case_provider() if self._case_provider is not None else ())
        if not cases:
            _log_event(
                {
                    "event": "skill_candidate_proposer.no_cases",
                    "job_id": context.job_id,
                    "run_id": context.run_id,
                    "dry_run": dry_run,
                    "note": (
                        "No TrajectoryCase provider wired — daemon does not yet have a "
                        "store-backed pipeline. Inject case_provider to enable."
                    ),
                }
            )
            return JobResult.succeeded(
                "no cases — nothing to propose",
                data={
                    "cases_seen": 0,
                    "proposals": 0,
                    "written": 0,
                    "denied": 0,
                    "dry_run": dry_run,
                },
                tokens_used=0,
                cost_used=0.0,
            )

        proposer = (self._proposer_factory or SkillProposer)()
        writer = (self._writer_factory or SkillProposerWriter)()
        gate_factory = self._write_authority_factory or (
            # Default daemon gate:dry_run path → allow(safe, no disk write).
            # Real-write path → DENY by default until operator wires a CRITICAL gate.
            lambda: _NoopWriteAuthorityGate(allow=dry_run)
        )
        gate = gate_factory()

        proposals = proposer.propose(cases)
        written = 0
        denied = 0
        write_results: list[dict[str, object]] = []
        error: str | None = None
        try:
            for proposal in proposals:
                result = await writer.write_candidate_to_disk(
                    proposal,
                    write_authority=gate,
                    dry_run=dry_run,
                )
                write_results.append(
                    {
                        "skill_name": proposal.name,
                        "reason": result.reason,
                        "path": str(result.path) if result.path is not None else None,
                        "bytes_written": result.bytes_written,
                    }
                )
                if result.reason == "written":
                    written += 1
                elif result.reason == "denied":
                    denied += 1
        except Exception as exc:  # noqa: BLE001 — best-effort,不阻塞后续 job
            error = f"{type(exc).__name__}: {exc}"
            _log_event(
                {
                    "event": "skill_candidate_proposer.error",
                    "job_id": context.job_id,
                    "run_id": context.run_id,
                    "error": error,
                }
            )

        data: dict[str, object] = {
            "cases_seen": len(cases),
            "proposals": len(proposals),
            "written": written,
            "denied": denied,
            "dry_run": dry_run,
            "results": write_results,
            "error": error,
        }
        _log_event(
            {
                "event": "skill_candidate_proposer.done",
                "job_id": context.job_id,
                "run_id": context.run_id,
                **data,
            }
        )
        return JobResult.succeeded(
            f"proposed {len(proposals)} skill candidates (written={written}, denied={denied})",
            data=data,
            tokens_used=0,
            cost_used=0.0,
        )


class PredictiveWarmerJob:
    """Idle-time predictive warmer: prepare short-lived evidence caches only.

    It never answers the predicted query. It reads recent user query observations,
    precomputes likely context from existing memory, and stores an expiring
    ``predictive_warm`` record for the retriever to reuse if the user asks a
    related follow-up.
    """

    id = "predictive_warmer"
    interval_seconds = 900.0  # 15 minutes
    estimated_tokens = 200
    estimated_cost = 0.0
    max_retries = 1
    backoff_seconds = 30.0

    def __init__(
        self,
        *,
        store_factory: Callable[[], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        recent_query_limit: int = 12,
        evidence_limit: int = 5,
        dry_run: bool | None = None,
    ) -> None:
        self._store_factory = store_factory
        self._clock = clock or (lambda: datetime.now(UTC))
        self._recent_query_limit = max(1, recent_query_limit)
        self._evidence_limit = max(1, evidence_limit)
        self._dry_run = dry_run

    async def run(self, context: JobContext) -> JobResult:
        from .store import QuilinMemStore

        now = _coerce_utc(self._clock())
        dry_run = (
            self._dry_run
            if self._dry_run is not None
            else _is_truthy(os.environ.get("QUILIN_DAEMON_DRY_RUN", "true"))
        )
        store = (self._store_factory or QuilinMemStore)()
        data: dict[str, object] = {
            "queries_seen": 0,
            "evidence_count": 0,
            "written": 0,
            "skipped_reason": None,
            "expiry_field": "forget_after",
            "ttl_hours": 24,
            "dry_run": dry_run,
        }
        try:
            queries = _recent_user_queries_from_store(
                store,
                limit=self._recent_query_limit,
                now=now,
            )
            data["queries_seen"] = len(queries)
            if not queries:
                data["skipped_reason"] = "no_recent_user_queries"
                return JobResult.succeeded("no recent user queries", data=data)

            predicted_query = queries[0].content
            query_terms = _predictive_query_terms(queries)
            if _active_predictive_warm_exists(store, predicted_query=predicted_query, now=now):
                data["skipped_reason"] = "already_warm"
                data["predicted_query"] = predicted_query
                return JobResult.succeeded("predictive warm already active", data=data)

            evidence = await store.search(
                predicted_query,
                limit=max(self._evidence_limit * 3, self._evidence_limit),
                filters={"layer": "episodic"},
            )
            query_ids = {query.query_id for query in queries}
            evidence = [
                item
                for item in evidence
                if item.kind != PREDICTIVE_WARM_KIND
                and item.id not in query_ids
                and not _metadata_marks_user_query(dict(item.metadata))
            ][: self._evidence_limit]
            data["evidence_count"] = len(evidence)
            data["predicted_query"] = predicted_query
            if not evidence:
                data["skipped_reason"] = "no_relevant_evidence"
                return JobResult.succeeded("no evidence to warm", data=data)
            if dry_run:
                data["skipped_reason"] = "dry_run"
                data["valid_until"] = (now + PREDICTIVE_WARM_TTL).isoformat()
                return JobResult.succeeded("predictive warm planned (dry_run)", data=data)

            warm_id = _insert_predictive_warm(
                store,
                context=context,
                predicted_query=predicted_query,
                queries=queries,
                evidence=evidence,
                query_terms=query_terms,
                now=now,
            )
            data["written"] = 1
            data["memory_id"] = warm_id
            data["valid_until"] = (now + PREDICTIVE_WARM_TTL).isoformat()
            _log_event(
                {
                    "event": "predictive_warmer.written",
                    "job_id": context.job_id,
                    "run_id": context.run_id,
                    **data,
                }
            )
            return JobResult.succeeded("predictive warm cache written", data=data)
        finally:
            with contextlib.suppress(Exception):
                await _close_resource(store)


class TokenBudgetMonitorJob:
    """监控当日 token 用量,接近上限时记录 warning(写 memory)。"""

    id = "token_budget_monitor"
    interval_seconds = 300.0  # 5 minutes
    estimated_tokens = 50
    estimated_cost = 0.00001
    max_retries = 1
    backoff_seconds = 15.0

    def __init__(
        self,
        *,
        store_factory: Callable[[], Any] | None = None,
        observability_db_path: str | None = None,
        logs_dir: str | None = None,
        daily_token_limit: int | None = None,
        warning_threshold_ratio: float | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._store_factory = store_factory
        self._observability_db_path = observability_db_path
        self._logs_dir = logs_dir
        self._daily_token_limit = daily_token_limit
        self._warning_threshold_ratio = warning_threshold_ratio
        self._clock = clock or (lambda: datetime.now(UTC))

    async def run(self, context: JobContext) -> JobResult:
        now = self._clock()
        daily_token_limit = self._resolve_daily_token_limit()
        warning_threshold_ratio = self._resolve_warning_threshold_ratio()
        usage = _read_daily_token_usage(
            observability_db_path=self._observability_db_path,
            logs_dir=self._logs_dir,
            now=now,
        )
        threshold_tokens = int(daily_token_limit * warning_threshold_ratio)
        warning_written = False
        warning_reason: str | None = None

        _log_event(
            {
                "event": "token_budget_monitor.tick",
                "job_id": context.job_id,
                "run_id": context.run_id,
                "tokens_used_today": usage.tokens_used,
                "usage_source": usage.source,
                "daily_token_limit": daily_token_limit,
                "warning_threshold_ratio": warning_threshold_ratio,
                "usage_error": usage.error,
            }
        )

        if daily_token_limit <= 0:
            warning_reason = "budget_disabled"
        elif usage.tokens_used < threshold_tokens:
            warning_reason = "below_threshold"
        else:
            from .store import QuilinMemStore

            warning_date = _coerce_utc(now).date().isoformat()
            store = (self._store_factory or QuilinMemStore)()
            try:
                if _warning_already_recorded(store, warning_date):
                    warning_reason = "already_recorded"
                else:
                    await _write_token_budget_warning(
                        store,
                        now=now,
                        tokens_used=usage.tokens_used,
                        daily_token_limit=daily_token_limit,
                        threshold_ratio=warning_threshold_ratio,
                        usage_source=usage.source,
                    )
                    warning_written = True
                    warning_reason = "written"
            finally:
                with contextlib.suppress(Exception):
                    await _close_resource(store)

        data = {
            "checked": True,
            "tokens_used_today": usage.tokens_used,
            "usage_source": usage.source,
            "usage_error": usage.error,
            "daily_token_limit": daily_token_limit,
            "warning_threshold_ratio": warning_threshold_ratio,
            "warning_threshold_tokens": threshold_tokens,
            "warning_written": warning_written,
            "warning_reason": warning_reason,
        }
        _log_event(
            {
                "event": "token_budget_monitor.done",
                "job_id": context.job_id,
                "run_id": context.run_id,
                **data,
            }
        )
        return JobResult.succeeded(
            "checked token budget",
            data=data,
            tokens_used=0,
            cost_used=0.0,
        )

    def _resolve_daily_token_limit(self) -> int:
        if self._daily_token_limit is not None:
            return max(0, self._daily_token_limit)
        raw = os.environ.get("QUILIN_DAEMON_DAILY_TOKEN_LIMIT") or os.environ.get(
            "QUILIN_DAEMON_TOKEN_BUDGET",
            "100000",
        )
        try:
            return max(0, int(raw))
        except ValueError:
            return 100_000

    def _resolve_warning_threshold_ratio(self) -> float:
        if self._warning_threshold_ratio is not None:
            ratio = self._warning_threshold_ratio
        else:
            raw = os.environ.get("QUILIN_DAEMON_TOKEN_WARNING_RATIO", "0.8")
            try:
                ratio = float(raw)
            except ValueError:
                ratio = 0.8
        return min(1.0, max(0.0, ratio))


def _register_initial_idle_jobs(daemon: QuilinDaemon) -> None:
    daemon.register(MemoryReflectJob())
    daemon.register(MemoryConsolidateJob())
    daemon.register(KGBackfillJob())
    daemon.register(TokenBudgetMonitorJob())
    daemon.register(PredictiveWarmerJob())
    # QUI-198 disk-write gap fix (2026-05-21):skill proposer 写盘 job。
    # 默认 case_provider=None → 每次 tick 走 "no_cases" 路径(空闲)。
    # 真启用需注入 case_provider + CRITICAL gate(operator opt-in)。
    daemon.register(SkillCandidateProposerJob())


async def run_daemon_loop() -> None:
    """Long-running event loop.

    1. 实例化 QuilinDaemon + register initial idle jobs
    2. 起 signal handler(SIGINT/SIGTERM 优雅停)
    3. 主 tick:每 N 秒检查 next_run_at,到点 daemon.run_once()
    4. 失败 retry / budget gate / lease 由 daemon 自管
    """
    # dogfood fix 2026-05-21:DaemonConfig 字段是 `*_per_run`(daemon.py:68),
    # 不是 `token_budget/cost_budget`。前一版 ship 时写错 kwarg,daemon 真启动
    # 会 TypeError 立即崩 — subagent 1 报告发现。
    config = DaemonConfig(
        token_budget_per_run=int(os.environ.get("QUILIN_DAEMON_TOKEN_BUDGET", "100000")),
        cost_budget_per_run=float(os.environ.get("QUILIN_DAEMON_COST_BUDGET", "1.0")),
        lease_ttl_seconds=int(os.environ.get("QUILIN_DAEMON_LEASE_TTL", "120")),
    )
    daemon = QuilinDaemon(config=config, logger=_log_event)
    tick_seconds = float(os.environ.get("QUILIN_DAEMON_TICK_SECONDS", "30"))

    # 注册初始 idle job
    _register_initial_idle_jobs(daemon)

    daemon.start()
    _log_event(
        {
            "event": "daemon.started",
            "jobs": list(daemon._jobs.keys()),
            "tick_seconds": tick_seconds,
            "config": {
                "token_budget_per_run": config.token_budget_per_run,
                "cost_budget_per_run": config.cost_budget_per_run,
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
            # dogfood fix 2026-05-21:datetime.utcnow() 返 naive,但 daemon.py
            # 内部用 datetime.now(UTC) aware,naive vs aware 比较 TypeError 崩。
            # Codex subagent 3 实证发现 daemon 启动即崩。
            now = datetime.now(UTC)
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
