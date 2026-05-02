from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from .event_log_schema import (
    DEFAULT_TOP_N,
    EVENT_LOG_COMPONENT,
    EVENT_LOG_SCHEMA_VERSION,
    ensure_event_log_schema,
)
from .types import MemoryItem


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _resolve_db_path(db_path: str | None) -> str:
    if db_path is not None:
        return db_path

    if os.environ.get("QUILIN_ENV") == "test":
        return ":memory:"

    return os.environ.get(
        "OMNIMEM_EVENT_LOG_PATH",
        str(Path.home() / ".quilin" / "memory-events.db"),
    )


def _serialize_metadata(metadata: dict[str, object]) -> str:
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True)


def _deserialize_metadata(metadata_json: str | None) -> dict[str, object]:
    if not metadata_json:
        return {}

    loaded = json.loads(metadata_json)
    return dict(loaded) if isinstance(loaded, dict) else {}


def hash_query(query: str) -> str:
    normalized = query.strip().encode("utf-8")
    return hashlib.sha256(normalized).hexdigest()


TRACEPARENT_RE = re.compile(r"^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$")


@dataclass(slots=True, frozen=True)
class TraceContext:
    trace_id: str
    span_id: str
    request_id: str | None = None
    trace_flags: str = "01"

    @property
    def traceparent(self) -> str:
        return f"00-{self.trace_id}-{self.span_id}-{self.trace_flags}"


class SpanEventEmitter(Protocol):
    def add_event(self, name: str, attributes: dict[str, object]) -> None: ...


SpanEventSink = Callable[[str, dict[str, object]], None] | SpanEventEmitter


def parse_traceparent(
    traceparent: str | None,
    *,
    request_id: str | None = None,
) -> TraceContext | None:
    if traceparent is None:
        return None

    match = TRACEPARENT_RE.match(traceparent.strip())
    if match is None:
        return None

    trace_id, span_id, trace_flags = match.groups()
    return TraceContext(
        trace_id=trace_id,
        span_id=span_id,
        request_id=request_id,
        trace_flags=trace_flags,
    )


def _emit_span_event(
    sink: SpanEventSink | None,
    name: str,
    attributes: dict[str, object],
) -> None:
    if sink is None:
        return

    try:
        if hasattr(sink, "add_event"):
            sink.add_event(name, attributes)
        else:
            sink(name, attributes)
    except Exception:
        return


@dataclass(slots=True, frozen=True)
class CitationStats:
    memory_id: str
    impressions: int
    citations: int

    @property
    def citation_rate(self) -> float:
        if self.impressions == 0:
            return 0.0

        return self.citations / self.impressions


@dataclass(slots=True, frozen=True)
class RetrievalEvent:
    event_id: str
    run_id: str
    query_hash: str
    query_raw: str | None
    memory_id: str
    rank: int
    score: float
    source_layer: str
    source: str
    metadata: dict[str, object]
    was_cited: bool
    timestamp: datetime
    schema_version: int
    trace_id: str | None = None
    request_id: str | None = None
    span_id: str | None = None


class RetrievalEventLog:
    def __init__(
        self,
        db_path: str | None = None,
        *,
        persist_raw_query: bool = False,
        top_n: int = DEFAULT_TOP_N,
        span_event_sink: SpanEventSink | None = None,
    ) -> None:
        if top_n < 1:
            raise ValueError("RetrievalEventLog.top_n must be at least 1")

        resolved_db_path = _resolve_db_path(db_path)
        if resolved_db_path != ":memory:":
            Path(resolved_db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(
            resolved_db_path,
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._closed = False
        self._persist_raw_query = persist_raw_query
        self._top_n = top_n
        self._span_event_sink = span_event_sink
        self._conn.execute("PRAGMA journal_mode=WAL")
        ensure_event_log_schema(self._conn)

    async def __aenter__(self) -> RetrievalEventLog:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        if self._closed:
            return

        with self._lock:
            self._conn.commit()
            self._conn.close()
            self._closed = True

    async def reset(self) -> None:
        await asyncio.to_thread(self._reset_sync)

    def _reset_sync(self) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                self._conn.execute("DELETE FROM retrieval_event_log")

    async def record_retrieval(
        self,
        run_id: str,
        query: str,
        results: Sequence[MemoryItem],
        *,
        top_n: int | None = None,
        timestamp: datetime | None = None,
        trace_context: TraceContext | None = None,
    ) -> list[str]:
        return await asyncio.to_thread(
            self._record_retrieval_sync,
            run_id,
            query,
            list(results),
            top_n,
            timestamp,
            trace_context,
        )

    def _record_retrieval_sync(
        self,
        run_id: str,
        query: str,
        results: list[MemoryItem],
        top_n: int | None,
        timestamp: datetime | None,
        trace_context: TraceContext | None,
    ) -> list[str]:
        effective_top_n = self._top_n if top_n is None else max(top_n, 0)
        if effective_top_n == 0:
            return []

        resolved_timestamp = (timestamp or _utcnow()).isoformat()
        query_hash = hash_query(query)
        query_raw = query if self._persist_raw_query else None
        event_ids: list[str] = []

        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                for rank, item in enumerate(results[:effective_top_n], start=1):
                    event_id = str(uuid4())
                    event_ids.append(event_id)
                    metadata = self._top_n_metadata(item)
                    self._conn.execute(
                        """
                        INSERT INTO retrieval_event_log (
                            event_id,
                            run_id,
                            query_hash,
                            query_raw,
                            memory_id,
                            rank,
                            score,
                            source_layer,
                            source,
                            metadata_json,
                            was_cited,
                            timestamp,
                            schema_version,
                            trace_id,
                            request_id,
                            span_id
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
                        """,
                        (
                            event_id,
                            run_id,
                            query_hash,
                            query_raw,
                            item.id,
                            rank,
                            float(item.metadata.get("score", 0.0)),
                            self._source_layer(item),
                            str(item.metadata.get("source", item.layer)),
                            _serialize_metadata(metadata),
                            resolved_timestamp,
                            EVENT_LOG_SCHEMA_VERSION,
                            trace_context.trace_id if trace_context else None,
                            trace_context.request_id if trace_context else None,
                            trace_context.span_id if trace_context else None,
                        ),
                    )
                    self._emit_retrieval_sample(
                        event_id=event_id,
                        run_id=run_id,
                        query_hash=query_hash,
                        item=item,
                        rank=rank,
                        score=float(item.metadata.get("score", 0.0)),
                        trace_context=trace_context,
                    )

        return event_ids

    async def mark_cited(
        self,
        run_id: str,
        event_ids: Sequence[str],
        *,
        trace_context: TraceContext | None = None,
    ) -> int:
        return await asyncio.to_thread(
            self._mark_cited_sync,
            run_id,
            list(event_ids),
            trace_context,
        )

    def _mark_cited_sync(
        self,
        run_id: str,
        event_ids: list[str],
        trace_context: TraceContext | None,
    ) -> int:
        deduped_ids = sorted({event_id for event_id in event_ids if event_id})
        if not deduped_ids:
            return 0

        placeholders = ", ".join(["?"] * len(deduped_ids))
        sql = f"""
            UPDATE retrieval_event_log
            SET was_cited = 1
            WHERE run_id = ?
              AND event_id IN ({placeholders})
        """

        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                cursor = self._conn.execute(sql, [run_id, *deduped_ids])
            for event_id in deduped_ids:
                _emit_span_event(
                    self._span_event_sink,
                    "memory.citation_sample",
                    {
                        "memory.event_id": event_id,
                        "memory.run_id": run_id,
                        "memory.was_cited": True,
                        **self._trace_attributes(trace_context),
                    },
                )

        return int(cursor.rowcount or 0)

    async def list_events(
        self,
        *,
        run_id: str | None = None,
        cited_only: bool = False,
        limit: int = 100,
    ) -> list[RetrievalEvent]:
        return await asyncio.to_thread(self._list_events_sync, run_id, cited_only, limit)

    def _list_events_sync(
        self,
        run_id: str | None,
        cited_only: bool,
        limit: int,
    ) -> list[RetrievalEvent]:
        predicates = ["1 = 1"]
        params: list[object] = []
        if run_id is not None:
            predicates.append("run_id = ?")
            params.append(run_id)
        if cited_only:
            predicates.append("was_cited = 1")

        query = f"""
            SELECT
                event_id,
                run_id,
                query_hash,
                query_raw,
                memory_id,
                rank,
                score,
                source_layer,
                source,
                metadata_json,
                was_cited,
                timestamp,
                schema_version,
                trace_id,
                request_id,
                span_id
            FROM retrieval_event_log
            WHERE {" AND ".join(predicates)}
            ORDER BY timestamp DESC, rank ASC
            LIMIT ?
        """
        params.append(max(limit, 0))

        with self._lock:
            rows = self._conn.execute(query, params).fetchall()

        return [
            RetrievalEvent(
                event_id=row["event_id"],
                run_id=row["run_id"],
                query_hash=row["query_hash"],
                query_raw=row["query_raw"],
                memory_id=row["memory_id"],
                rank=int(row["rank"]),
                score=float(row["score"]),
                source_layer=row["source_layer"],
                source=row["source"],
                metadata=_deserialize_metadata(row["metadata_json"]),
                was_cited=bool(row["was_cited"]),
                timestamp=datetime.fromisoformat(row["timestamp"]),
                schema_version=int(row["schema_version"]),
                trace_id=row["trace_id"],
                request_id=row["request_id"],
                span_id=row["span_id"],
            )
            for row in rows
        ]

    def _emit_retrieval_sample(
        self,
        *,
        event_id: str,
        run_id: str,
        query_hash: str,
        item: MemoryItem,
        rank: int,
        score: float,
        trace_context: TraceContext | None,
    ) -> None:
        _emit_span_event(
            self._span_event_sink,
            "memory.retrieval_sample",
            {
                "memory.event_id": event_id,
                "memory.run_id": run_id,
                "memory.query_hash": query_hash,
                "memory.memory_id": item.id,
                "memory.rank.index": rank,
                "memory.score_ratio": score,
                "memory.source_layer": self._source_layer(item),
                **self._trace_attributes(trace_context),
            },
        )

    @staticmethod
    def _trace_attributes(trace_context: TraceContext | None) -> dict[str, object]:
        if trace_context is None:
            return {}

        attributes: dict[str, object] = {
            "trace.trace_id": trace_context.trace_id,
            "trace.span_id": trace_context.span_id,
        }
        if trace_context.request_id is not None:
            attributes["trace.request_id"] = trace_context.request_id

        return attributes

    async def citation_stats(self, memory_ids: Sequence[str]) -> dict[str, CitationStats]:
        return await asyncio.to_thread(self._citation_stats_sync, list(memory_ids))

    def _citation_stats_sync(self, memory_ids: list[str]) -> dict[str, CitationStats]:
        deduped_ids = sorted({memory_id for memory_id in memory_ids if memory_id})
        if not deduped_ids:
            return {}

        placeholders = ", ".join(["?"] * len(deduped_ids))
        query = f"""
            SELECT
                memory_id,
                COUNT(*) AS impressions,
                COALESCE(SUM(was_cited), 0) AS citations
            FROM retrieval_event_log
            WHERE memory_id IN ({placeholders})
            GROUP BY memory_id
        """

        with self._lock:
            rows = self._conn.execute(query, deduped_ids).fetchall()

        stats = {
            memory_id: CitationStats(memory_id=memory_id, impressions=0, citations=0)
            for memory_id in deduped_ids
        }
        for row in rows:
            stats[row["memory_id"]] = CitationStats(
                memory_id=row["memory_id"],
                impressions=int(row["impressions"]),
                citations=int(row["citations"]),
            )

        return stats

    @staticmethod
    def _top_n_metadata(item: MemoryItem) -> dict[str, object]:
        selected: dict[str, object] = {}
        for key in (
            "source",
            "memory_source",
            "layer",
            "score",
            "staleness",
            "cache_key",
            "block_version",
            "source_layers",
            "graph_distance",
            "valid_from",
            "valid_to",
        ):
            value = item.metadata.get(key)
            if value is not None:
                selected[key] = value

        return selected

    @staticmethod
    def _source_layer(item: MemoryItem) -> str:
        source_layers = item.metadata.get("source_layers")
        if isinstance(source_layers, list) and source_layers:
            first = source_layers[0]
            if isinstance(first, str) and first:
                return first

        if item.metadata.get("source") == "kg_subgraph":
            return "kg"

        return str(item.layer)


__all__ = [
    "CitationStats",
    "EVENT_LOG_COMPONENT",
    "EVENT_LOG_SCHEMA_VERSION",
    "RetrievalEvent",
    "RetrievalEventLog",
    "TraceContext",
    "hash_query",
    "parse_traceparent",
]
