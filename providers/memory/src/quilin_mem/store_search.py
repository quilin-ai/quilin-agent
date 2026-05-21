from __future__ import annotations

import json
import math
import re
import sqlite3
from collections.abc import Callable

from .salience import compute_retrieval_ranking_score
from .types import MemoryLayer

ASCII_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+")
CJK_RUN_PATTERN = re.compile(r"[\u4e00-\u9fff]+")
RECALL_QUERY_EXPANSIONS = (
    (
        ("记得", "记住", "回忆", "想起", "以前", "之前"),
        {"记得", "记忆", "名字", "称呼", "身份", "用户"},
    ),
    (
        ("叫什么", "名字", "称呼", "我是谁", "是谁", "叫我"),
        {"名字", "称呼", "身份", "用户"},
    ),
)
MAX_EXPANDED_QUERY_TERMS = 64
RERANK_POOL_MIN_SIZE = 50
RERANK_POOL_MULTIPLIER = 8


def build_keywords(content: str) -> str:
    return " ".join(sorted(extract_search_terms(content)))


def candidate_rows(
    conn: sqlite3.Connection,
    *,
    query: str,
    layer_filter: MemoryLayer | None,
    limit: int | None = None,
    active_at: str | None = None,
) -> list[sqlite3.Row]:
    if not query:
        return _all_rows(
            conn,
            layer_filter=layer_filter,
            limit=limit,
            active_at=active_at,
        )

    rows = recall_with_fts(
        conn,
        query=query,
        layer_filter=layer_filter,
        limit=limit,
        active_at=active_at,
    )
    if rows:
        return rows

    return _like_rows(
        conn,
        query=query,
        layer_filter=layer_filter,
        limit=limit,
        active_at=active_at,
    )


def recall_with_fts(
    conn: sqlite3.Connection,
    *,
    query: str,
    layer_filter: MemoryLayer | None,
    limit: int | None = None,
    active_at: str | None = None,
) -> list[sqlite3.Row]:
    match_query = build_match_query(query)
    if match_query is None:
        return []

    limit_clause = _limit_clause(_rerank_pool_limit(limit))
    active_predicate, active_params = _active_visibility_clause("mr", active_at)
    if layer_filter is None:
        rows = conn.execute(
            f"""
            SELECT {record_columns("mr")}
            FROM memory_records_fts fts
            JOIN memory_records mr ON mr.id = fts.id
            WHERE memory_records_fts MATCH ?
              AND mr.deleted = 0
              AND mr.is_latest = 1
              {active_predicate}
            ORDER BY bm25(memory_records_fts), mr.rowid ASC
            {limit_clause}
            """,
            (match_query, *active_params),
        ).fetchall()
        return _rank_rows(rows, limit=limit)

    rows = conn.execute(
        f"""
        SELECT {record_columns("mr")}
        FROM memory_records_fts fts
        JOIN memory_records mr ON mr.id = fts.id
        WHERE memory_records_fts MATCH ?
          AND mr.deleted = 0
          AND mr.is_latest = 1
          {active_predicate}
          AND mr.tier = ?
        ORDER BY bm25(memory_records_fts), mr.rowid ASC
        {limit_clause}
        """,
        (match_query, *active_params, layer_filter),
    ).fetchall()
    return _rank_rows(rows, limit=limit)


def rebuild_fts_index(
    conn: sqlite3.Connection,
    *,
    build_keywords_func: Callable[[str], str],
) -> None:
    conn.execute("DELETE FROM memory_records_fts")
    conn.execute(
        """
        INSERT INTO memory_records_fts (id, content, keywords)
        SELECT id, content, ''
        FROM memory_records
        WHERE deleted = 0 AND is_latest = 1
        """
    )
    rows = conn.execute(
        """
        SELECT id, content
        FROM memory_records
        WHERE deleted = 0 AND is_latest = 1
        ORDER BY rowid ASC
        """
    ).fetchall()
    for row in rows:
        conn.execute(
            """
            UPDATE memory_records_fts
            SET keywords = ?
            WHERE id = ?
            """,
            (build_keywords_func(row["content"]), row["id"]),
        )


def record_columns(alias: str | None = None) -> str:
    prefix = f"{alias}." if alias else ""
    return ",\n".join(
        f"{prefix}{column}"
        for column in (
            "id",
            "content",
            "tier",
            "content_type",
            "metadata_json",
            "embedding_json",
            "created_at",
            "last_accessed",
            "last_written_at",
            "access_count",
            "importance_score",
            "last_writer_client",
            "last_writer_session_id",
            "project_scope",
            "salience_json",
            "kind",
            "deadline_at",
            "prospective_action",
            "resource_pointer_json",
        )
    )


def build_match_query(query: str) -> str | None:
    terms = sorted(term for term in expand_query_terms(query) if term)
    if not terms:
        return None

    escaped_terms = []
    for term in terms:
        escaped = term.replace('"', '""')
        escaped_terms.append(f'"{escaped}"')

    return " OR ".join(escaped_terms)


def extract_search_terms(text: str) -> set[str]:
    lowered = text.lower()
    return set(ASCII_TOKEN_PATTERN.findall(lowered)) | extract_cjk_terms(text)


def expand_query_terms(query: str) -> set[str]:
    terms = extract_search_terms(query)
    for triggers, expansions in RECALL_QUERY_EXPANSIONS:
        if any(trigger in query for trigger in triggers):
            terms.update(expansions)

    if len(terms) <= MAX_EXPANDED_QUERY_TERMS:
        return terms

    return set(sorted(terms)[:MAX_EXPANDED_QUERY_TERMS])


def extract_cjk_terms(text: str) -> set[str]:
    terms: set[str] = set()
    for run in CJK_RUN_PATTERN.findall(text):
        if len(run) <= 3:
            terms.add(run)

        for size in (2, 3):
            if len(run) < size:
                continue

            for index in range(len(run) - size + 1):
                terms.add(run[index : index + size])

    return terms


def _all_rows(
    conn: sqlite3.Connection,
    *,
    layer_filter: MemoryLayer | None,
    limit: int | None = None,
    active_at: str | None = None,
) -> list[sqlite3.Row]:
    limit_clause = _limit_clause(_rerank_pool_limit(limit))
    active_predicate, active_params = _active_visibility_clause(None, active_at)
    if layer_filter is None:
        rows = conn.execute(
            f"""
            SELECT {record_columns()}
            FROM memory_records
            WHERE deleted = 0 AND is_latest = 1
              {active_predicate}
            ORDER BY rowid ASC
            {limit_clause}
            """,
            active_params,
        ).fetchall()
        return _rank_rows(rows, limit=limit)

    rows = conn.execute(
        f"""
        SELECT {record_columns()}
        FROM memory_records
        WHERE deleted = 0 AND is_latest = 1
          {active_predicate}
          AND tier = ?
        ORDER BY rowid ASC
        {limit_clause}
        """,
        (*active_params, layer_filter),
    ).fetchall()
    return _rank_rows(rows, limit=limit)


def _like_rows(
    conn: sqlite3.Connection,
    *,
    query: str,
    layer_filter: MemoryLayer | None,
    limit: int | None = None,
    active_at: str | None = None,
) -> list[sqlite3.Row]:
    like_query = f"%{query.lower()}%"
    limit_clause = _limit_clause(_rerank_pool_limit(limit))
    active_predicate, active_params = _active_visibility_clause(None, active_at)
    if layer_filter is None:
        rows = conn.execute(
            f"""
            SELECT {record_columns()}
            FROM memory_records
            WHERE deleted = 0
              AND is_latest = 1
              {active_predicate}
              AND lower(content) LIKE ?
            ORDER BY rowid ASC
            {limit_clause}
            """,
            (*active_params, like_query),
        ).fetchall()
        return _rank_rows(rows, limit=limit)

    rows = conn.execute(
        f"""
        SELECT {record_columns()}
        FROM memory_records
        WHERE deleted = 0
          AND is_latest = 1
          {active_predicate}
          AND tier = ?
          AND lower(content) LIKE ?
        ORDER BY rowid ASC
        {limit_clause}
        """,
        (*active_params, layer_filter, like_query),
    ).fetchall()
    return _rank_rows(rows, limit=limit)


def _active_visibility_clause(
    alias: str | None,
    active_at: str | None,
) -> tuple[str, tuple[str, ...]]:
    if active_at is None:
        return "", ()

    prefix = f"{alias}." if alias else ""
    return (
        f"AND ({prefix}forget_after IS NULL OR {prefix}forget_after > ? "
        f"OR {prefix}recovered_at IS NOT NULL)"
    ), (active_at,)


def _rerank_pool_limit(limit: int | None) -> int | None:
    if limit is None:
        return None
    normalized = max(int(limit), 0)
    if normalized == 0:
        return 0
    return max(normalized * RERANK_POOL_MULTIPLIER, RERANK_POOL_MIN_SIZE)


def _limit_clause(limit: int | None) -> str:
    if limit is None:
        return ""
    return f"LIMIT {max(int(limit), 0)}"


def _rank_rows(rows: list[sqlite3.Row], *, limit: int | None) -> list[sqlite3.Row]:
    if not rows:
        return []

    ranked = sorted(
        enumerate(rows),
        key=lambda indexed_row: (
            -_row_ranking_score(indexed_row[1], indexed_row[0]),
            indexed_row[0],
        ),
    )
    ranked_rows = [row for _, row in ranked]
    if limit is None:
        return ranked_rows
    return ranked_rows[: max(int(limit), 0)]


def _row_ranking_score(row: sqlite3.Row, index: int) -> float:
    # The base score is a tiny stable tie-breaker preserving SQL relevance when
    # salience is equal; the multiplier comes from salience/importance.
    base_score = max(0.0, 1.0 - (index * 0.000001))
    return compute_retrieval_ranking_score(
        base_score,
        _row_salience_payload(row),
        importance_score=_row_float(row, "importance_score", default=0.5),
        kind=_row_str(row, "kind"),
    )


def _row_salience_payload(row: sqlite3.Row) -> dict[str, object] | None:
    raw_payload = _row_str(row, "salience_json")
    if not raw_payload:
        return None

    try:
        loaded = json.loads(raw_payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict):
        return None
    return dict(loaded)


def _row_float(row: sqlite3.Row, key: str, *, default: float) -> float:
    if key not in tuple(row.keys()):
        return default
    try:
        value = float(row[key])
    except TypeError, ValueError:
        return default
    return value if math.isfinite(value) else default


def _row_str(row: sqlite3.Row, key: str) -> str | None:
    if key not in tuple(row.keys()):
        return None
    raw = row[key]
    return raw if isinstance(raw, str) else None
