from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable

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

    limit_clause = _limit_clause(limit)
    active_predicate, active_params = _active_visibility_clause("mr", active_at)
    if layer_filter is None:
        return conn.execute(
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

    return conn.execute(
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
            "access_count",
            "importance_score",
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
    limit_clause = _limit_clause(limit)
    active_predicate, active_params = _active_visibility_clause(None, active_at)
    if layer_filter is None:
        return conn.execute(
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

    return conn.execute(
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


def _like_rows(
    conn: sqlite3.Connection,
    *,
    query: str,
    layer_filter: MemoryLayer | None,
    limit: int | None = None,
    active_at: str | None = None,
) -> list[sqlite3.Row]:
    like_query = f"%{query.lower()}%"
    limit_clause = _limit_clause(limit)
    active_predicate, active_params = _active_visibility_clause(None, active_at)
    if layer_filter is None:
        return conn.execute(
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

    return conn.execute(
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


def _active_visibility_clause(
    alias: str | None,
    active_at: str | None,
) -> tuple[str, tuple[str, ...]]:
    if active_at is None:
        return "", ()

    prefix = f"{alias}." if alias else ""
    return f"AND ({prefix}forget_after IS NULL OR {prefix}forget_after > ?)", (active_at,)


def _limit_clause(limit: int | None) -> str:
    if limit is None:
        return ""
    return f"LIMIT {max(int(limit), 0)}"
