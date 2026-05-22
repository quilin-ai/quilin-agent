from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from os import PathLike
from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from .consolidation_log import ConsolidationLogStore
from .consolidator import ConsolidationStrategy, Consolidator
from .event_log import TraceContext, parse_traceparent
from .kg import TemporalKnowledgeGraph
from .kg_backfill import backfill_kg_from_memory
from .logging import configure_once, logger
from .observer import (
    L3aObserver,
    ObservationTurnInput,
    ObserverConfig,
    _candidate_to_dict,
    observe_safely,
)
from .profile_store import ProfileStore
from .profile_updater import ProfileUpdater
from .prospective import (
    cancel_prospective,
    list_due_prospective,
    mark_prospective_done,
    snooze_prospective,
    validate_resource_pointer,
)
from .retrieval_profile import RetrievalProfileStore
from .retriever import MemoryRetriever
from .salience import DEFAULT_STALENESS_THRESHOLD_DAYS
from .scratchpad import ScratchpadStore
from .store import QuilinMemStore
from .types import MemoryItem, MemoryKind, MemoryLayer, MemoryTier

MAX_RECALL_QUERY_LENGTH = 512
MAX_TOOL_METADATA_DEPTH = 4
MAX_TOOL_METADATA_ITEMS = 32
MAX_TOOL_METADATA_STRING_LENGTH = 512
MAX_TOOL_METADATA_BYTES = 4 * 1024
MAX_OBSERVE_TEXT_LENGTH = 32 * 1024  # cap per-text field at 32KB
DEFAULT_OBSERVER_FREQUENCY = 10
DEFAULT_OBSERVER_BASE_URL = "https://api.deepseek.com/v1/chat/completions"
DEFAULT_OBSERVER_MODEL = "deepseek-v4-flash"
STALENESS_THRESHOLD_DAYS_ENV = "QUILIN_STALENESS_THRESHOLD_DAYS"
# User-triggered MCP previews must fail fast enough to degrade to exact-only
# before the stdio caller gives up. Background daemon paths can still use the
# batch judge's longer default timeout.
DEFAULT_MCP_CONSOLIDATE_BATCH_TIMEOUT_SECONDS = 20
# Cap on the per-server (user_id, session_id) → L3aObserver cache so that a
# misbehaving caller (e.g. random session ids) cannot make the server leak
# memory unboundedly. Eviction is LRU via OrderedDict.move_to_end + popitem.
#
# 缓存 (user_id, session_id) → L3aObserver 的上限，防止调用方滥用（例如
# 每次都传随机 session id）导致内存无界增长。基于 OrderedDict 的 LRU。
MAX_OBSERVER_SESSIONS = 256
ALLOWED_TOOL_METADATA_KEYS = frozenset(
    {
        "block_version",
        "blocked_reason",
        "budget_decision",
        "cache_key",
        "event_seq",
        "graph_distance",
        "layer",
        "memory_source",
        "origin_layer",
        "phase",
        "reranker_rank",
        "reranker_score",
        "retrieval_score",
        "run_id",
        "schema_version",
        "score",
        "session_id",
        "source",
        "source_excerpt",
        "source_layers",
        "source_turn_id",
        "stability_reason",
        "staleness",
        "supporting_turns",
        "task_hash",
        "trace_id",
        "turn_id",
        "user_id",
        "valid_from",
        "valid_to",
        "evidence",
        "evidence_ids",
        "evidence_refs",
        "citations",
    }
)


class MemoryOperationError(RuntimeError):
    """Sanitized tool error exposed over MCP."""


def _raise_memory_operation_error(operation: str, exc: Exception) -> None:
    logger.error(f"{operation} failed", error=str(exc))
    raise MemoryOperationError(f"{operation} failed") from exc


def _validate_memory_recall_query(query: str) -> None:
    if len(query) > MAX_RECALL_QUERY_LENGTH:
        raise ValueError(
            f"memory_recall query must be at most {MAX_RECALL_QUERY_LENGTH} characters"
        )


def _validate_metadata_value(value: object, *, depth: int) -> None:
    if depth > MAX_TOOL_METADATA_DEPTH:
        raise ValueError(
            f"memory_store metadata nesting must be at most {MAX_TOOL_METADATA_DEPTH} levels"
        )

    if value is None or isinstance(value, bool | int | float):
        return

    if isinstance(value, str):
        if len(value) > MAX_TOOL_METADATA_STRING_LENGTH:
            raise ValueError(
                "memory_store metadata string values must be at most "
                f"{MAX_TOOL_METADATA_STRING_LENGTH} characters"
            )
        return

    if isinstance(value, list):
        if len(value) > MAX_TOOL_METADATA_ITEMS:
            raise ValueError(
                f"memory_store metadata lists must contain at most {MAX_TOOL_METADATA_ITEMS} items"
            )
        for item in value:
            _validate_metadata_value(item, depth=depth + 1)
        return

    if isinstance(value, dict):
        if len(value) > MAX_TOOL_METADATA_ITEMS:
            raise ValueError(
                f"memory_store metadata objects must contain at most {MAX_TOOL_METADATA_ITEMS} keys"
            )
        for nested_key, nested_value in value.items():
            if not isinstance(nested_key, str) or not nested_key:
                raise ValueError("memory_store metadata keys must be non-empty strings")
            _validate_metadata_value(nested_value, depth=depth + 1)
        return

    raise ValueError("memory_store metadata values must be JSON-serializable scalars")


def _validate_tool_metadata(metadata: dict[str, object] | None) -> dict[str, object] | None:
    if metadata is None:
        return None

    normalized = dict(metadata)
    unexpected_keys = sorted(key for key in normalized if key not in ALLOWED_TOOL_METADATA_KEYS)
    if unexpected_keys:
        raise ValueError("memory_store metadata keys not allowed: " + ", ".join(unexpected_keys))

    _validate_metadata_value(normalized, depth=1)
    encoded = json.dumps(normalized, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_TOOL_METADATA_BYTES:
        raise ValueError(f"memory_store metadata must be at most {MAX_TOOL_METADATA_BYTES} bytes")

    return normalized


def _parse_tool_datetime(value: str | None, *, field_name: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be an ISO datetime string")
    return datetime.fromisoformat(value)


def _staleness_threshold_days_from_env() -> int:
    raw_value = os.environ.get(STALENESS_THRESHOLD_DAYS_ENV)
    if raw_value is None or not raw_value.strip():
        return DEFAULT_STALENESS_THRESHOLD_DAYS
    try:
        return int(raw_value)
    except ValueError:
        return DEFAULT_STALENESS_THRESHOLD_DAYS


def _normalize_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _stale_age_days(
    created_at: datetime,
    *,
    now: datetime,
    threshold_days: int,
) -> int | None:
    if threshold_days <= 0:
        return None
    age = _normalize_utc(now) - _normalize_utc(created_at)
    if age.total_seconds() < 0:
        return None
    days = max(int(age.total_seconds() // 86400), 1)
    if days < threshold_days:
        return None
    return days


def _memory_recall_record_to_wire_dict(
    record: MemoryItem,
    *,
    now: datetime,
    staleness_threshold_days: int,
) -> dict[str, object]:
    payload = record.to_wire_dict()
    stale_days = _stale_age_days(
        record.created_at,
        now=now,
        threshold_days=staleness_threshold_days,
    )
    if stale_days is not None:
        payload["content"] = (
            f"<system-reminder>这条记忆来自 {stale_days} 天前,信息可能已过时</system-reminder>\n"
            f"{payload['content']}"
        )
    return payload


def _is_blank_string(value: object) -> bool:
    return not isinstance(value, str) or not value.strip()


def _tool_metadata_with_defaults(
    tier: MemoryTier,
    layer: MemoryLayer | None,
    metadata: dict[str, object] | None,
) -> dict[str, object] | None:
    resolved_layer = layer or tier
    if resolved_layer != "semantic":
        return metadata

    normalized = dict(metadata or {})
    normalized.setdefault("schema_version", 1)
    if _is_blank_string(normalized.get("source")):
        normalized["source"] = "memory_store_tool"
    if _is_blank_string(normalized.get("stability_reason")):
        normalized["stability_reason"] = "caller_selected_semantic_tier"

    return normalized


async def _memory_recall_with_store(
    store: QuilinMemStore,
    query: str,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    project_scope: str | None = None,
    retrieval_profile_store: RetrievalProfileStore | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    """Recall memory records matching a query string (substring, case-insensitive).

    Returns all records if query is empty.
    """
    _validate_memory_recall_query(query)
    filters: dict[str, object] = {}
    if project_scope is not None:
        filters["project_scope"] = project_scope
    try:
        raw_results = await store.recall(query, filters or None)
    except Exception as exc:
        _raise_memory_operation_error("memory_recall", exc)

    task_context: dict[str, object] = {}
    if user_id is not None and user_id.strip():
        task_context["user_id"] = user_id.strip()
    if session_id is not None and session_id.strip():
        task_context["session_id"] = session_id.strip()
    task_context_or_none = task_context or None
    context_filters = MemoryRetriever._filters_from_task_context(task_context_or_none)
    if context_filters is not None:
        metadata_filters = context_filters.get("metadata")
        if isinstance(metadata_filters, dict):
            raw_results = [
                item
                for item in raw_results
                if all(item.metadata.get(key) == value for key, value in metadata_filters.items())
            ]

    retriever = MemoryRetriever(
        store,
        retrieval_profiles=store.retrieval_profiles,
    )
    results = retriever.annotate_recall_results(
        query,
        raw_results,
        task_context_or_none,
        limit=len(raw_results),
    )
    if user_id is not None and user_id.strip():
        try:
            profile_store = retrieval_profile_store or store.retrieval_profiles
            results = profile_store.get(user_id.strip()).apply_to(results)
        except Exception as exc:
            _raise_memory_operation_error("memory_recall", exc)

    # QUI-194 cross-review Reviewer 1 REAL #1 fix (2026-05-21):
    # MCP memory_recall handler 必须 wire 到 RetrievalSafetyGate,否则
    # 用户 export QUILIN_RETRIEVAL_SAFETY_ENABLED=true 也无效(gate 三策略
    # 一条都不跑)。env disabled 时 scrub 直接返回原 list,不破坏现有行为。
    from .retrieval_safety_gate import RetrievalSafetyGate, load_config_from_env
    from .safety_lesson_store import open_default_safety_lesson_store

    _safety_config = load_config_from_env()
    if _safety_config.enabled:
        _lesson_store = open_default_safety_lesson_store()
        try:
            _safety_gate = RetrievalSafetyGate(
                config=_safety_config,
                lesson_store=_lesson_store,
            )
            results = _safety_gate.scrub(query, list(results))
        finally:
            _lesson_store.close()

    staleness_now = datetime.now(UTC)
    staleness_threshold_days = _staleness_threshold_days_from_env()
    payload: dict[str, object] = {
        "records": [
            _memory_recall_record_to_wire_dict(
                record,
                now=staleness_now,
                staleness_threshold_days=staleness_threshold_days,
            )
            for record in results
        ]
    }
    if trace_context is not None:
        payload["traceparent"] = trace_context.traceparent

    return json.dumps(payload)


def _request_meta_to_dict(ctx: Context[object, Any, object] | None) -> dict[str, object]:
    if ctx is None or getattr(ctx, "_request_context", None) is None:
        return {}

    meta = ctx.request_context.meta
    if meta is None:
        return {}

    if hasattr(meta, "model_dump"):
        return {key: value for key, value in meta.model_dump().items() if value is not None}

    if isinstance(meta, dict):
        return dict(meta)

    return {}


def _trace_context_from_context(
    ctx: Context[object, Any, object] | None,
) -> TraceContext | None:
    meta = _request_meta_to_dict(ctx)
    traceparent = meta.get("traceparent")
    request_id = meta.get("request_id")
    if not isinstance(traceparent, str):
        return None

    return parse_traceparent(
        traceparent,
        request_id=request_id if isinstance(request_id, str) else None,
    )


def _child_trace_context(parent: TraceContext | None) -> TraceContext | None:
    if parent is None:
        return None

    return TraceContext(
        trace_id=parent.trace_id,
        span_id=secrets.token_hex(8),
        request_id=parent.request_id,
        trace_flags=parent.trace_flags,
    )


async def _memory_store_with_store(
    store: QuilinMemStore,
    content: str,
    tier: MemoryTier = "working",
    layer: MemoryLayer | None = None,
    metadata: dict[str, object] | None = None,
    content_type: str = "text",
    last_writer_client: str | None = None,
    last_writer_session_id: str | None = None,
    project_scope: str | None = None,
    salience: dict[str, object] | None = None,
    kind: MemoryKind | None = None,
    deadline_at: str | None = None,
    prospective_action: str | None = None,
    resource_pointer: dict[str, object] | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    """Store a new memory record.

    Args:
        content: The text content to store.
        tier: Memory tier (default "working").
    """
    metadata_with_defaults = _tool_metadata_with_defaults(tier, layer, metadata)
    validated_metadata = _validate_tool_metadata(metadata_with_defaults)
    if salience is not None:
        _validate_metadata_value(salience, depth=1)
    validated_resource_pointer = validate_resource_pointer(resource_pointer)
    if resource_pointer is not None:
        _validate_metadata_value(validated_resource_pointer, depth=1)
    parsed_deadline_at = _parse_tool_datetime(deadline_at, field_name="deadline_at")
    try:
        if layer is None:
            record = await store.store(
                content,
                tier=tier,
                metadata=validated_metadata,
                content_type=content_type,
                last_writer_client=last_writer_client,
                last_writer_session_id=last_writer_session_id,
                project_scope=project_scope,
                salience=salience,
                kind=kind,
                deadline_at=parsed_deadline_at,
                prospective_action=prospective_action,
                resource_pointer=validated_resource_pointer,
            )
        else:
            record = await store.store(
                content,
                tier=tier,
                layer=layer,
                metadata=validated_metadata,
                content_type=content_type,
                last_writer_client=last_writer_client,
                last_writer_session_id=last_writer_session_id,
                project_scope=project_scope,
                salience=salience,
                kind=kind,
                deadline_at=parsed_deadline_at,
                prospective_action=prospective_action,
                resource_pointer=validated_resource_pointer,
            )
    except Exception as exc:
        _raise_memory_operation_error("memory_store", exc)

    return json.dumps({"id": record.id, **_trace_payload(trace_context)})


async def _memory_resolve_conflict_with_store(
    store: QuilinMemStore,
    memory_id: str,
    decision: str,
    merged_content: str | None = None,
    conflict_token: str | None = None,
    *,
    trace_context: TraceContext | None = None,
) -> str:
    try:
        resolved = await store.resolve_conflict(
            memory_id,
            decision,
            merged_content=merged_content,
            conflict_token=conflict_token,
        )
    except Exception as exc:
        _raise_memory_operation_error("memory_resolve_conflict", exc)

    payload: dict[str, object] = {
        "ok": resolved is not None,
        "resolved": resolved is not None,
        "memory_id": memory_id,
        "decision": decision,
    }
    if resolved is not None:
        payload["record"] = resolved.to_wire_dict()
    if trace_context is not None:
        payload["traceparent"] = trace_context.traceparent
    return json.dumps(payload, ensure_ascii=False)


async def _memory_consolidate_plan_with_store(
    store: QuilinMemStore,
    *,
    strategy: ConsolidationStrategy = "all",
    tier: MemoryTier | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    """Run user-triggered consolidation preview.

    QUI-187 Reviewer F follow-up (2026-05-20):用户在 web 手动点"智能整理"是
    explicit user-triggered preview,**不是 idle-time reflection**。默认
    IdleBudgetProvider(enabled=False)让所有 expensive soft dedupe 永远 denied,
    9 条明显语义重复的记忆"0 条整理"是 user-facing bug。

    user-triggered preview 不该被 idle_budget gate(idle_budget 设计是给后台周期性
    reflection 用的,见 docs/03-memory line 269-275)。这里注入 enabled=True +
    充足 token budget,允许 dedupe 完整跑(embedding + LLM judge)。
    实际写入(execute=True 路径)仍走 WriteAuthority gate。
    """
    from .consolidator import (
        DEFAULT_PER_PAIR_FALLBACK_MAX_RECORDS,
        _DeepseekBatchJudge,
        _DeepseekConsolidationJudge,
        _env_flag_disabled,
        _env_int,
    )
    from .idle_budget import IdleBudgetProvider as _IdleBudgetProvider

    budget_provider = _IdleBudgetProvider(enabled=True, token_budget=1_000_000)
    # QUI-189 batch LLM judge — 默认启用 1 次 batch call 替代 per-pair LLM
    # judge,9 条记忆场景 5s 内完成 vs 之前 ~90s 超 MCP timeout。
    # env `QUILIN_DEDUPE_BATCH_ENABLED=false` opt-out 退回 per-pair 路径。
    # 注入 per-pair judge 作为 batch 失败时的 fallback(LLM JSON invalid /
    # API error / timeout / 无 key)。
    dedupe_judge = _DeepseekConsolidationJudge().judge
    batch_judge = None
    if not _env_flag_disabled("QUILIN_DEDUPE_BATCH_ENABLED"):
        batch_judge = _DeepseekBatchJudge(
            timeout_seconds=float(
                _env_int(
                    "QUILIN_DEDUPE_MCP_BATCH_TIMEOUT_SECONDS",
                    DEFAULT_MCP_CONSOLIDATE_BATCH_TIMEOUT_SECONDS,
                )
            )
        ).judge_batch
    log_store: ConsolidationLogStore | None = None
    log_db_path = _log_store_db_path_for_store(store)
    if log_db_path is not None:
        try:
            log_store = ConsolidationLogStore(log_db_path)
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory_consolidate_plan log_store bootstrap failed", error=str(exc))
    try:
        proposal = Consolidator(
            budget_provider=budget_provider,
            store=store,
            dedupe_judge=dedupe_judge,
            batch_judge=batch_judge,
            batch_max_calls=1,
            log_store=log_store,
            per_pair_fallback_max_records=_env_int(
                "QUILIN_DEDUPE_PER_PAIR_FALLBACK_MAX_RECORDS",
                DEFAULT_PER_PAIR_FALLBACK_MAX_RECORDS,
            ),
        ).propose(
            strategy=strategy,
            tier=tier,
            task="quilin_mem.memory_consolidate_plan",
            estimated_tokens=1024,
        )
    except Exception as exc:
        _raise_memory_operation_error("memory_consolidate_plan", exc)
    finally:
        if log_store is not None:
            try:
                log_store.close()
            except Exception as exc:  # noqa: BLE001
                logger.warning("memory_consolidate_plan log_store close failed", error=str(exc))

    return json.dumps({**proposal.to_wire_dict(), **_trace_payload(trace_context)})


def _trace_payload(trace_context: TraceContext | None) -> dict[str, str]:
    if trace_context is None:
        return {}

    return {"traceparent": trace_context.traceparent}


async def _scratchpad_write_with_store(
    scratchpad_store: ScratchpadStore,
    *,
    task_id: str,
    session_id: str,
    key: str,
    value: str,
    ttl_sec: int | None = None,
    capacity_per_task: int | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    try:
        await scratchpad_store.write(
            task_id=task_id,
            session_id=session_id,
            key=key,
            value=value,
            ttl_sec=ttl_sec,
            capacity_per_task=capacity_per_task,
        )
    except Exception as exc:
        _raise_memory_operation_error("scratchpad_write", exc)

    return json.dumps({"ok": True, **_trace_payload(trace_context)})


async def _scratchpad_read_with_store(
    scratchpad_store: ScratchpadStore,
    *,
    task_id: str,
    session_id: str,
    key: str,
    trace_context: TraceContext | None = None,
) -> str:
    try:
        value = await scratchpad_store.read(
            task_id=task_id,
            session_id=session_id,
            key=key,
        )
    except Exception as exc:
        _raise_memory_operation_error("scratchpad_read", exc)

    return json.dumps({"value": value, **_trace_payload(trace_context)})


def _build_observer_config_from_env() -> ObserverConfig:
    """Build ObserverConfig from environment variables.

    Defaults match observer.py's ObserverConfig:
        model = QUILIN_OBSERVER_MODEL or deepseek-v4-flash
        api_key = QUILIN_OBSERVER_API_KEY (preferred) or DEEPSEEK_API_KEY
        frequency = QUILIN_OBSERVER_FREQUENCY (>=1) or 10
        base_url = QUILIN_OBSERVER_BASE_URL or DeepSeek chat completions URL

    API keys must come from env only — never from MCP arguments.
    """
    model = os.environ.get("QUILIN_OBSERVER_MODEL", DEFAULT_OBSERVER_MODEL)
    # QUILIN_OBSERVER_API_KEY takes precedence; fall back to DEEPSEEK_API_KEY
    # to align with the existing ObserverConfig default factory.
    api_key = os.environ.get("QUILIN_OBSERVER_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or ""
    base_url = os.environ.get("QUILIN_OBSERVER_BASE_URL", DEFAULT_OBSERVER_BASE_URL)
    raw_frequency = os.environ.get("QUILIN_OBSERVER_FREQUENCY")
    frequency = DEFAULT_OBSERVER_FREQUENCY
    if raw_frequency is not None and raw_frequency.strip():
        try:
            parsed = int(raw_frequency)
            if parsed >= 1:
                frequency = parsed
        except ValueError:
            # Invalid env value — fall back to default rather than crash.
            logger.warning(
                "memory_observe ignoring invalid QUILIN_OBSERVER_FREQUENCY",
                value=raw_frequency,
            )

    return ObserverConfig(
        model=model,
        api_key=api_key,
        frequency=frequency,
        base_url=base_url,
    )


def _validate_observe_text(text: str, field: str) -> str:
    """Cap per-text field length at MAX_OBSERVE_TEXT_LENGTH bytes."""
    if not isinstance(text, str):
        raise ValueError(f"memory_observe {field} must be a string")
    if len(text) > MAX_OBSERVE_TEXT_LENGTH:
        raise ValueError(
            f"memory_observe {field} must be at most {MAX_OBSERVE_TEXT_LENGTH} characters"
        )
    return text


def _observation_source_event_id(metadata: dict[str, object] | None) -> str | None:
    if not metadata:
        return None
    for key in ("source_event_id", "turn_id", "trace_id", "event_id"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _log_store_db_path_for_store(store: QuilinMemStore) -> str | None:
    db_path = getattr(store, "_db_path", None)
    if db_path == ":memory:":
        return None
    if isinstance(db_path, str):
        return db_path
    if isinstance(db_path, PathLike):
        return os.fspath(db_path)
    return None


def _bounded_observe_turn_metadata(metadata: dict[str, object] | None) -> dict[str, object] | None:
    if metadata is None:
        return None

    normalized = dict(metadata)
    _validate_metadata_value(normalized, depth=1)
    encoded = json.dumps(normalized, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_TOOL_METADATA_BYTES:
        raise ValueError(
            f"memory_observe metadata must be at most {MAX_TOOL_METADATA_BYTES} bytes"
        )
    return normalized


def _build_observer_session_key(
    user_id: str | None,
    session_id: str | None,
) -> str:
    """Compose the cache key for the per-session observer instance.

    None values normalize to literal "_" so we still produce a stable key.
    """
    safe_user = (user_id or "").strip() or "_"
    safe_session = (session_id or "").strip() or "_"
    return f"{safe_user}|{safe_session}"


async def _memory_observe_with_observer(
    observer: L3aObserver,
    *,
    user_text: str,
    assistant_text: str,
    user_id: str | None,
    session_id: str | None,
    store: QuilinMemStore | None = None,
    metadata: dict[str, object] | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    """Run the observer over a single (user, assistant) turn pair.

    Both texts are concatenated into one ObservationTurn with role=user
    (a single turn captures the full exchange). On candidate yield this
    returns wire-format JSON `{"candidates": [...]}`.
    Errors are sanitized via MemoryOperationError.
    """
    try:
        safe_user_text = _validate_observe_text(user_text, "user_text")
        safe_assistant_text = _validate_observe_text(assistant_text, "assistant_text")
    except ValueError as exc:
        _raise_memory_operation_error("memory_observe", exc)

    combined_content_parts: list[str] = []
    if safe_user_text.strip():
        combined_content_parts.append(f"[user]: {safe_user_text.strip()}")
    if safe_assistant_text.strip():
        combined_content_parts.append(f"[assistant]: {safe_assistant_text.strip()}")
    combined_content = "\n".join(combined_content_parts) or "(empty turn)"
    if store is not None:
        observation_metadata: dict[str, object] = {
            "source": "memory_observe",
            "schema_version": 1,
        }
        if user_id and user_id.strip():
            observation_metadata["user_id"] = user_id.strip()
        if session_id and session_id.strip():
            observation_metadata["session_id"] = session_id.strip()
        if metadata:
            try:
                observation_metadata["turn_metadata"] = _bounded_observe_turn_metadata(metadata)
            except ValueError as exc:
                observation_metadata["turn_metadata_dropped"] = str(exc)
        try:
            await store.record_observation(
                content=combined_content,
                source_event_id=_observation_source_event_id(metadata),
                observed_at=None,
                actor_id=user_id.strip() if user_id and user_id.strip() else None,
                role="user",
                metadata=observation_metadata,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory_observe observation archive failed", error=str(exc))

    turn_input: ObservationTurnInput = {
        "content": combined_content,
        "role": "user",
        **({"user_id": user_id} if user_id and user_id.strip() else {}),
        **({"session_id": session_id} if session_id and session_id.strip() else {}),
        **({"metadata": metadata} if metadata else {}),
    }

    try:
        candidates = await observe_safely(observer, turn_input)
    except Exception as exc:
        _raise_memory_operation_error("memory_observe", exc)

    payload: dict[str, object] = {
        "candidates": [_candidate_to_dict(candidate) for candidate in candidates],
    }
    if trace_context is not None:
        payload["traceparent"] = trace_context.traceparent

    return json.dumps(payload)


async def _scratchpad_clear_with_store(
    scratchpad_store: ScratchpadStore,
    *,
    task_id: str,
    session_id: str,
    key: str | None = None,
    trace_context: TraceContext | None = None,
) -> str:
    try:
        cleared = await scratchpad_store.clear(
            task_id=task_id,
            session_id=session_id,
            key=key,
        )
    except Exception as exc:
        _raise_memory_operation_error("scratchpad_clear", exc)

    return json.dumps({"cleared": cleared, **_trace_payload(trace_context)})


def _get_store_from_context(ctx: Context[object, Any, object] | None) -> QuilinMemStore | None:
    if ctx is None or getattr(ctx, "_request_context", None) is None:
        return None

    lifespan_context = ctx.request_context.lifespan_context
    if not isinstance(lifespan_context, dict):
        return None

    store = lifespan_context.get("store")
    return store if isinstance(store, QuilinMemStore) else None


def _build_store_lifespan(
    store: QuilinMemStore | None,
):
    @asynccontextmanager
    async def lifespan(_app: FastMCP):
        if store is not None:
            yield {"store": store}
            return

        lifespan_store = await asyncio.to_thread(QuilinMemStore)
        try:
            yield {"store": lifespan_store}
        finally:
            await lifespan_store.close()

    return lifespan


async def memory_recall(
    query: str,
    user_id: str | None = None,
    session_id: str | None = None,
    project_scope: str | None = None,
) -> str:
    """Legacy direct helper that opens a store per call."""
    async with QuilinMemStore() as store:
        return await _memory_recall_with_store(
            store,
            query,
            user_id=user_id,
            session_id=session_id,
            project_scope=project_scope,
        )


async def memory_store(
    content: str,
    tier: MemoryTier = "working",
    *,
    layer: MemoryLayer | None = None,
    metadata: dict[str, object] | None = None,
    content_type: str = "text",
    last_writer_client: str | None = None,
    last_writer_session_id: str | None = None,
    project_scope: str | None = None,
    salience: dict[str, object] | None = None,
    kind: MemoryKind | None = None,
    deadline_at: str | None = None,
    prospective_action: str | None = None,
    resource_pointer: dict[str, object] | None = None,
) -> str:
    """Legacy direct helper that opens a store per call."""
    async with QuilinMemStore() as store:
        return await _memory_store_with_store(
            store,
            content,
            tier,
            layer,
            metadata,
            content_type,
            last_writer_client,
            last_writer_session_id,
            project_scope,
            salience,
            kind,
            deadline_at,
            prospective_action,
            resource_pointer,
        )


def create_server(
    store: QuilinMemStore | None = None,
    scratchpad_store: ScratchpadStore | None = None,
    *,
    observer_factory: object | None = None,
    profile_updater_factory: object | None = None,
) -> FastMCP:
    """Build the quilin-mem MCP server.

    Optional injection points:
        observer_factory: zero-arg callable returning ``L3aObserver``;
            defaults to constructing one from env-derived ``ObserverConfig``.
            Used by tests to inject deterministic LLM stubs without env vars.
        profile_updater_factory: zero-arg callable returning ``ProfileUpdater``
            or ``None``. Defaults to lazy ``ProfileStore`` per server.

    L3a observer instances are cached per ``(user_id, session_id)`` so a
    long-running session accumulates buffer state across ``memory_observe``
    calls.
    """
    server_store: QuilinMemStore | None = store
    server_scratchpad_store: ScratchpadStore | None = scratchpad_store
    observer_sessions: OrderedDict[str, L3aObserver] = OrderedDict()
    server_profile_updater: ProfileUpdater | None = None
    server = FastMCP("quilin-mem", lifespan=_build_store_lifespan(store))

    async def resolve_store(
        ctx: Context[object, Any, object] | None = None,
    ) -> QuilinMemStore:
        context_store = _get_store_from_context(ctx)
        if context_store is not None:
            return context_store

        nonlocal server_store
        if server_store is None:
            server_store = QuilinMemStore()

        return server_store

    async def resolve_scratchpad_store() -> ScratchpadStore:
        nonlocal server_scratchpad_store
        if server_scratchpad_store is None:
            server_scratchpad_store = ScratchpadStore()

        return server_scratchpad_store

    def resolve_profile_updater() -> ProfileUpdater | None:
        """Lazily construct a ProfileUpdater for L3a profile sync.

        Returns None if the factory yields None or raises (best-effort).
        Without a profile updater, observer.observe() still runs but high-
        confidence findings are not mirrored to ~/.quilin/user.md.
        """
        nonlocal server_profile_updater
        if server_profile_updater is not None:
            return server_profile_updater

        if profile_updater_factory is not None:
            try:
                candidate = profile_updater_factory()  # type: ignore[misc]
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "memory_observe profile_updater_factory failed",
                    error=str(exc),
                )
                return None

            if candidate is None:
                return None

            if not isinstance(candidate, ProfileUpdater):
                logger.warning(
                    "memory_observe profile_updater_factory returned wrong type",
                    type=type(candidate).__name__,
                )
                return None

            server_profile_updater = candidate
            return server_profile_updater

        try:
            store_instance = ProfileStore()
            server_profile_updater = ProfileUpdater(store_instance)
            return server_profile_updater
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "memory_observe profile_updater bootstrap failed",
                error=str(exc),
            )
            return None

    def _store_observer(key: str, observer: L3aObserver) -> None:
        """Insert or refresh an observer entry with LRU eviction.

        Adding a new entry past ``MAX_OBSERVER_SESSIONS`` evicts the oldest
        (least recently used) entry. Existing entries are moved to the end
        (most recently used) to refresh their LRU position.

        新增条目超过 ``MAX_OBSERVER_SESSIONS`` 时驱逐最久未用的条目；
        已存在的条目移到末尾以刷新 LRU 位置。
        """
        if key in observer_sessions:
            observer_sessions.move_to_end(key)
            observer_sessions[key] = observer
            return
        observer_sessions[key] = observer
        while len(observer_sessions) > MAX_OBSERVER_SESSIONS:
            observer_sessions.popitem(last=False)

    def resolve_observer(
        user_id: str | None,
        session_id: str | None,
    ) -> L3aObserver:
        """Get-or-create the per-session L3aObserver instance.

        We key on (user_id, session_id) so observer turn buffers grow
        across multiple memory_observe calls for the same session.
        Cache is bounded at ``MAX_OBSERVER_SESSIONS`` with LRU eviction.
        """
        key = _build_observer_session_key(user_id, session_id)
        cached = observer_sessions.get(key)
        if cached is not None:
            # Refresh LRU position so frequently-used sessions survive.
            observer_sessions.move_to_end(key)
            return cached

        if observer_factory is not None:
            try:
                created = observer_factory()  # type: ignore[misc]
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "memory_observe observer_factory failed; using env defaults",
                    error=str(exc),
                )
                created = None

            if isinstance(created, L3aObserver):
                _store_observer(key, created)
                return created

        config = _build_observer_config_from_env()
        # Wire profile updater only if api_key configured (matches observer
        # behavior: no api_key → no LLM trigger → no profile mirror).
        profile_updater = resolve_profile_updater() if config.api_key else None
        observer = L3aObserver(config, profile_updater=profile_updater)
        _store_observer(key, observer)
        return observer

    @server.tool(name="memory_recall")
    async def memory_recall_tool(
        query: str,
        user_id: str | None = None,
        session_id: str | None = None,
        project_scope: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Recall memory records matching a query string (substring, case-insensitive).

        Returns all records if query is empty.
        """
        parent_trace = _trace_context_from_context(ctx)
        return await _memory_recall_with_store(
            await resolve_store(ctx),
            query,
            user_id=user_id,
            session_id=session_id,
            project_scope=project_scope,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="memory_store")
    async def memory_store_tool(
        content: str,
        tier: MemoryTier = "working",
        layer: MemoryLayer | None = None,
        metadata: dict[str, object] | None = None,
        content_type: str = "text",
        last_writer_client: str | None = None,
        last_writer_session_id: str | None = None,
        project_scope: str | None = None,
        salience: dict[str, object] | None = None,
        kind: MemoryKind | None = None,
        deadline_at: str | None = None,
        prospective_action: str | None = None,
        resource_pointer: dict[str, object] | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Store a new memory record.

        IMPORTANT: classify the `tier` yourself based on content semantics;
        do NOT blindly default to "working".

        Tier 选择规则 / How to pick tier:
          - working: 当前对话/短期任务/临时状态,会过时
            (例:今天下午要开会、暂存的中间结果)
          - episodic: 具体事件/时间点/个人经历
            (例:用户今天用 Emacs 写了脚本、上周 ship 了 v2)
          - semantic: 稳定事实/概念/偏好/关系
            (例:用户的 GitHub 用户名是 X、用户用 Cursor、project A 依赖 B)
          - skill: 可复用流程/how-to(例:部署步骤、调试技巧)
            一般由 Consolidator 自动升级,LLM 慎重直接写 skill。

        关键例子 / Examples:
          - "用户的名字是孟孟" → semantic(稳定事实)
          - "用户今天午饭吃了拉面" → episodic(一次性事件)
          - "用户希望 15:00 开会" → working(短期 + 会过时)
          - "用户偏好用中文回复" → semantic(稳定偏好)

        Args:
            content: The text content to store.
            tier: working/episodic/semantic/skill — 按上述规则选,不要默认 working.
            layer: Canonical memory layer. Takes precedence over tier.
            kind: Optional finer-grained kind
                (decision/fact/preference/task/note).
            metadata: Free-form JSON metadata.
            last_writer_client: Identify the client that wrote this
                (web/cli/repl).
            last_writer_session_id: Session id of the writing client.
            project_scope: Restrict memory visibility to a project scope.
            salience: Optional 6-dim salience hints
                (novelty/utility/personal_relevance/actionability/recency/stability).
            deadline_at: ISO-8601 datetime for time-bounded working memory.
            prospective_action: Brief action description for prospective memory.
            resource_pointer: Pointer to external resource (file path / URL).
        """
        parent_trace = _trace_context_from_context(ctx)
        return await _memory_store_with_store(
            await resolve_store(ctx),
            content,
            tier,
            layer,
            metadata,
            content_type,
            last_writer_client,
            last_writer_session_id,
            project_scope,
            salience,
            kind,
            deadline_at,
            prospective_action,
            resource_pointer,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="memory_resolve_conflict")
    async def memory_resolve_conflict_tool(
        memory_id: str,
        decision: str,
        merged_content: str | None = None,
        conflict_token: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Resolve a pending multi-client conflict on a memory record."""
        parent_trace = _trace_context_from_context(ctx)
        return await _memory_resolve_conflict_with_store(
            await resolve_store(ctx),
            memory_id,
            decision,
            merged_content,
            conflict_token,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="memory_prospective_list_due")
    async def memory_prospective_list_due_tool(
        now: str,
        project_scope: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """List due prospective memories for scheduler pickup."""
        parsed_now = _parse_tool_datetime(now, field_name="now")
        if parsed_now is None:
            raise ValueError("now must be an ISO datetime string")
        items = await list_due_prospective(
            await resolve_store(ctx),
            now=parsed_now,
            project_scope=project_scope,
            user_id=user_id,
            session_id=session_id,
        )
        return json.dumps(
            {"items": [item.to_wire_dict() for item in items]},
            ensure_ascii=False,
        )

    @server.tool(name="memory_prospective_mark_done")
    async def memory_prospective_mark_done_tool(
        memory_id: str,
        now: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Mark a prospective memory done and archive it via soft-delete."""
        parsed_now = _parse_tool_datetime(now, field_name="now")
        payload = await mark_prospective_done(
            await resolve_store(ctx),
            memory_id,
            now=parsed_now,
        )
        return json.dumps(payload, ensure_ascii=False)

    @server.tool(name="memory_prospective_snooze")
    async def memory_prospective_snooze_tool(
        memory_id: str,
        snooze_until: str,
        now: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Snooze a prospective memory to a later deadline."""
        parsed_snooze_until = _parse_tool_datetime(snooze_until, field_name="snooze_until")
        if parsed_snooze_until is None:
            raise ValueError("snooze_until must be an ISO datetime string")
        parsed_now = _parse_tool_datetime(now, field_name="now")
        payload = await snooze_prospective(
            await resolve_store(ctx),
            memory_id,
            parsed_snooze_until,
            now=parsed_now,
        )
        return json.dumps(payload, ensure_ascii=False)

    @server.tool(name="memory_prospective_cancel")
    async def memory_prospective_cancel_tool(
        memory_id: str,
        now: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Cancel a prospective memory and archive it via soft-delete."""
        parsed_now = _parse_tool_datetime(now, field_name="now")
        payload = await cancel_prospective(
            await resolve_store(ctx),
            memory_id,
            now=parsed_now,
        )
        return json.dumps(payload, ensure_ascii=False)

    @server.tool(name="memory_delete")
    async def memory_delete_tool(
        memory_id: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Soft-delete one memory record by id.

        Use this when the agent recognizes duplicate or stale memory
        records and wants to clean them up. The record is marked
        `deleted=1` in SQLite and removed from the FTS index so future
        `memory_recall` calls won't surface it; the row itself is
        retained for audit. Idempotent: deleting an already-deleted
        or non-existent id is a no-op (returns ok=true with deleted=false).

        Args:
            memory_id: Record id returned by `memory_store` or surfaced
                by `memory_recall`.

        Returns:
            JSON string `{"ok": true, "memory_id": <id>}`.
        """
        store = await resolve_store(ctx)
        await store.delete(memory_id)
        return json.dumps({"ok": True, "memory_id": memory_id})

    @server.tool(name="memory_delete_preview")
    async def memory_delete_preview_tool(
        memory_id: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Preview the impact of archiving one memory record without mutating storage."""
        store = await resolve_store(ctx)
        preview = await store.preview_delete(memory_id)
        return json.dumps(preview.to_wire_dict(), ensure_ascii=False)

    @server.tool(name="memory_recover")
    async def memory_recover_tool(
        memory_id: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Recover a recently archived memory record within the soft-delete window."""
        store = await resolve_store(ctx)
        recovered = await store.recover_memory(memory_id)
        return json.dumps(
            {"ok": True, "memory_id": memory_id, "recovered": recovered},
            ensure_ascii=False,
        )

    @server.tool(name="memory_consolidate_plan")
    async def memory_consolidate_plan_tool(
        strategy: ConsolidationStrategy = "all",
        tier: MemoryTier | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Preview memory consolidation proposals without mutating storage.

        Strategies: ``dedupe`` groups duplicate records, ``reflect``
        proposes semantic insights from episodic memory, ``kg-prune``
        previews stale temporal edge cleanup, and ``all`` combines them.
        It returns a preview only; callers must confirm and execute writes
        through WriteAuthority-gated tools.
        """
        parent_trace = _trace_context_from_context(ctx)
        return await _memory_consolidate_plan_with_store(
            await resolve_store(ctx),
            strategy=strategy,
            tier=tier,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="scratchpad_write")
    async def scratchpad_write_tool(
        task_id: str,
        session_id: str,
        key: str,
        value: str,
        ttl_sec: int | None = None,
        capacity_per_task: int | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Write a task-scoped scratchpad value."""
        parent_trace = _trace_context_from_context(ctx)
        return await _scratchpad_write_with_store(
            await resolve_scratchpad_store(),
            task_id=task_id,
            session_id=session_id,
            key=key,
            value=value,
            ttl_sec=ttl_sec,
            capacity_per_task=capacity_per_task,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="scratchpad_read")
    async def scratchpad_read_tool(
        task_id: str,
        session_id: str,
        key: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Read a task-scoped scratchpad value."""
        parent_trace = _trace_context_from_context(ctx)
        return await _scratchpad_read_with_store(
            await resolve_scratchpad_store(),
            task_id=task_id,
            session_id=session_id,
            key=key,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="memory_observe")
    async def memory_observe_tool(
        user_text: str,
        assistant_text: str,
        user_id: str | None = None,
        session_id: str | None = None,
        metadata: dict[str, object] | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Observe a single agent turn and return profile-worthy candidates.

        L3a observer instances are cached per (user_id, session_id), so
        consecutive calls for the same session accumulate buffer state.

        Args:
            user_text: The user message text for this turn.
            assistant_text: The assistant response text for this turn.
            user_id: Optional user identifier (used to scope observer).
            session_id: Optional session identifier (used to scope observer).
            metadata: Optional turn metadata propagated to ObservationTurn.

        Returns:
            JSON string ``{"candidates": [...]}`` (deterministic + optional L3a).
        """
        parent_trace = _trace_context_from_context(ctx)
        observer = resolve_observer(user_id, session_id)
        try:
            archive_store = await resolve_store(ctx)
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory_observe archive store bootstrap failed", error=str(exc))
            archive_store = None
        return await _memory_observe_with_observer(
            observer,
            user_text=user_text,
            assistant_text=assistant_text,
            user_id=user_id,
            session_id=session_id,
            store=archive_store,
            metadata=metadata,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="scratchpad_clear")
    async def scratchpad_clear_tool(
        task_id: str,
        session_id: str,
        key: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Clear one scratchpad key, or all keys for a task/session."""
        parent_trace = _trace_context_from_context(ctx)
        return await _scratchpad_clear_with_store(
            await resolve_scratchpad_store(),
            task_id=task_id,
            session_id=session_id,
            key=key,
            trace_context=_child_trace_context(parent_trace),
        )

    @server.tool(name="consolidation_log_recent")
    async def consolidation_log_recent_tool(
        limit: int = 100,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Return the N most-recent consolidation proposals as JSON.

        UX-4 Slice 4 backend. Reads from `ConsolidationLogStore` (which the
        `Consolidator` writes to on every `propose()`). Used by the
        /memory page consolidation timeline tab.

        Returns JSON: `{available: bool, total: int, entries: [...]}`.
        Each entry: `{id, task, dry_run, budget_decision, actions[],
        writes_performed, created_at, schema_version}`. `actions[]` is
        the JSON-decoded list of action dicts originally produced by
        the Consolidator.

        Args:
            limit: How many entries (clamped to [1, 1000]). Default 100.

        Returns:
            JSON string suitable for `JSON.parse` on the TS side.
        """
        memory_store = await resolve_store(ctx)
        log_db_path = _log_store_db_path_for_store(memory_store)
        if log_db_path is None:
            return json.dumps({"available": True, "total": 0, "entries": []})
        with ConsolidationLogStore(log_db_path) as store:
            entries = store.list_recent(limit=limit)
            total = store.count()
        return json.dumps(
            {
                "available": True,
                "total": total,
                "entries": [
                    {
                        "id": e.id,
                        "task": e.task,
                        "dry_run": e.dry_run,
                        "budget_decision": e.budget_decision,
                        "actions": e.actions,
                        "writes_performed": e.writes_performed,
                        "created_at": e.created_at.isoformat(),
                        "schema_version": e.schema_version,
                    }
                    for e in entries
                ],
            }
        )

    @server.tool(name="consolidation_log_record_execute")
    async def consolidation_log_record_execute_tool(
        task: str,
        writes_performed: int,
        actions: list[dict[str, object]] | None = None,
        budget_decision: str = "allowed",
        schema_version: int = 1,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Record an EXECUTE-stage consolidation entry into the log.

        D.1 fix: Web /api/memory/dedupe execute path used to bypass the
        ConsolidationLogStore entirely (it called memory_delete directly),
        so the /memory timeline only showed plan entries with
        writes_performed=0 — UI silently disagreed with the DB which had
        truly deleted N rows.

        This tool lets the Web execute path append a synthetic "execute"
        log entry capturing the real write count + actions actually
        performed, so the timeline reflects the truth.

        Args:
            task: Task name for the entry (e.g. "web.memory_dedupe.execute").
            writes_performed: Number of real deletions performed.
            actions: Optional list of action records (already-deleted ids etc).
            budget_decision: Budget decision string.
            schema_version: Schema version for the entry.

        Returns:
            JSON: {ok: true, id: int} — id is the rowid of the appended entry.
        """
        from datetime import datetime, timezone

        memory_store = await resolve_store(ctx)
        log_db_path = _log_store_db_path_for_store(memory_store)
        if log_db_path is None:
            return json.dumps({"ok": False, "error": "log_store_unavailable"})
        actions_json = json.dumps(list(actions or []), ensure_ascii=False)
        with ConsolidationLogStore(log_db_path) as store:
            with store._txn():  # noqa: SLF001 — internal txn for direct insert
                cursor = store._conn.execute(  # noqa: SLF001
                    """
                    INSERT INTO consolidation_log (
                        task, dry_run, budget_decision, actions_json,
                        writes_performed, created_at, schema_version
                    )
                    VALUES (?, 0, ?, ?, ?, ?, ?)
                    """,
                    (
                        task,
                        budget_decision,
                        actions_json,
                        int(writes_performed),
                        datetime.now(timezone.utc).isoformat(),
                        int(schema_version),
                    ),
                )
                rowid = int(cursor.lastrowid or 0)
        return json.dumps({"ok": True, "id": rowid})

    @server.tool(name="kg_dump_for_viz")
    async def kg_dump_for_viz_tool(
        limit: int = 500,
        as_of: str | None = None,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Bulk-dump KG edges for /api/memory/graph visualization.

        Returns up to `limit` edges as a JSON-encoded `{nodes, edges}`
        payload sized for reactflow / cytoscape:
        - nodes:  [{id: entity, label: entity}]  (deduplicated)
        - edges:  [{id, source, target, label, valid_from, valid_to,
                    memory_id, weight}]

        UX-4 Slice 3 backend. limit clamped to [1, 2000]. `as_of`,
        if provided as ISO 8601, filters edges to those temporally
        valid at that moment.
        """
        del ctx  # not used; signature compatibility with other tools
        # Use the class's async context manager so a future maintainer who
        # adds work after `dump_edges` doesn't accidentally trip a
        # use-after-close on `kg`. The `raw_edges` list is plain Python
        # dicts so the post-processing below works either way, but
        # `async with` makes the resource scope unambiguous.
        async with TemporalKnowledgeGraph() as kg:
            raw_edges = await kg.dump_edges(limit=limit, as_of=as_of)

        # Deduplicate nodes by entity name.
        node_set: set[str] = set()
        for edge in raw_edges:
            node_set.add(str(edge["subject"]))
            node_set.add(str(edge["object"]))
        nodes = [{"id": name, "label": name} for name in sorted(node_set)]

        edges = [
            {
                "id": edge["edge_id"],
                "source": edge["subject"],
                "target": edge["object"],
                "label": edge["predicate"],
                "valid_from": edge["valid_from"],
                "valid_to": edge["valid_to"],
                "memory_id": edge["memory_id"],
                "weight": edge["weight"],
            }
            for edge in raw_edges
        ]
        return json.dumps({"nodes": nodes, "edges": edges})

    @server.tool(name="memory_backfill_kg")
    async def memory_backfill_kg_tool(
        batch_size: int = 50,
        max_records: int | None = None,
        dry_run: bool = True,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Backfill the knowledge graph from existing memory records.

        Walks `memory_records` across the working / episodic / semantic /
        skill layers, runs the LLM triple extractor on each record's
        text body, and (if `dry_run=False`) persists the resulting
        edges into the TemporalKnowledgeGraph with `memory_id` linkage.

        UX-4 Slice 2. Anti-hallucination filter (source_quote must be
        verbatim substring) + anti-injection (random per-call boundary
        token + system+user role split) run inside the extractor.

        Args:
            batch_size: Records to fetch per `list_by_layer` page
                (1-200; clamped). Default 50.
            max_records: Hard cap across all layers (1-10000; clamped).
                None means "all available, up to the hard cap".
            dry_run: When True (default), counts what would be added
                without writing to the KG. Flip to False to persist.

        Returns:
            JSON string with `{processed, edges_added, skipped, errors, dry_run}`.
        """
        store = await resolve_store(ctx)
        # Construct a per-call KG using the same DB path the store
        # writes to — `TemporalKnowledgeGraph` shares the `memory.db`
        # SQLite file with `memory_records`. Close on completion to
        # release the connection.
        kg = TemporalKnowledgeGraph()
        try:
            result = await backfill_kg_from_memory(
                store=store,
                kg=kg,
                batch_size=batch_size,
                max_records=max_records,
                dry_run=dry_run,
            )
        finally:
            await kg.close()
        return json.dumps(result.to_dict())

    @server.tool(name="memory_evidence_graph")
    async def memory_evidence_graph_tool(
        memory_id: str,
        ctx: Context[object, Any, object] | None = None,
    ) -> str:
        """Build evidence graph for one memory record(QUI-199 evidence viz).

        Walks supersede chain(parent_id / supersedes_json),evidence sources
        (`memory_sources` → `memory_observations`),and returns reactflow-ready
        JSON for the Web `/memory` page evidence visualization tab.

        Args:
            memory_id: Target memory record id(from memory_recall list).

        Returns:
            JSON `{nodes:[{id, kind, label, ...}], edges:[{from, to, kind}]}` —
            kinds:
            - `memory` — the target memory record + its older versions
            - `observation` — raw conversation turn(memory_observations row)
            - `source` — memory_sources linkage
            edge kinds:
            - `supersedes` — newer version → older version
            - `source_of` — observation → memory (raw evidence)
            - `evidence_of` — memory_source link

        构建一条记忆的"证据图":版本链 + 原始观察 + 出处。让 Web 用户
        直观看到这条记忆的来龙去脉。
        """
        store = await resolve_store(ctx)
        try:
            graph = await _build_evidence_graph(store, memory_id)
        except Exception as exc:
            _raise_memory_operation_error("memory_evidence_graph", exc)
        return json.dumps(graph)

    return server


async def _build_evidence_graph(
    store: QuilinMemStore,
    memory_id: str,
) -> dict[str, Any]:
    """Helper:walk supersede chain + sources + observations → reactflow JSON."""
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    seen_memory_ids: set[str] = set()
    seen_obs_ids: set[str] = set()

    def query_chain() -> tuple[
        list[dict[str, Any]],
        list[dict[str, Any]],
        list[dict[str, Any]],
    ]:
        conn = store._conn  # noqa: SLF001 — daemon read-only access
        records: list[dict[str, Any]] = []
        sources: list[dict[str, Any]] = []
        observations: list[dict[str, Any]] = []

        # Walk up the supersede chain(parent_id)
        cursor_id: str | None = memory_id
        depth = 0
        while cursor_id is not None and depth < 32:
            row = conn.execute(
                """
                SELECT id, content, tier, version, parent_id, is_latest,
                       last_writer_client, created_at
                FROM memory_records
                WHERE id = ?
                """,
                (cursor_id,),
            ).fetchone()
            if row is None:
                break
            rec = dict(row)
            records.append(rec)
            cursor_id = rec.get("parent_id")
            depth += 1

        # Pull sources + observations for all records in chain
        if records:
            ids_tuple = tuple(r["id"] for r in records)
            placeholders = ",".join("?" * len(ids_tuple))
            source_rows = conn.execute(
                f"""
                SELECT id, memory_record_id, observation_id, source_type, source_uri
                FROM memory_sources
                WHERE memory_record_id IN ({placeholders})
                """,  # noqa: S608 — placeholders bound below
                ids_tuple,
            ).fetchall()
            sources = [dict(r) for r in source_rows]

            obs_ids = {s["observation_id"] for s in sources if s["observation_id"]}
            if obs_ids:
                obs_placeholders = ",".join("?" * len(obs_ids))
                obs_rows = conn.execute(
                    f"""
                    SELECT id, content, role, observed_at, actor_id
                    FROM memory_observations
                    WHERE id IN ({obs_placeholders})
                    """,  # noqa: S608
                    tuple(obs_ids),
                ).fetchall()
                observations = [dict(r) for r in obs_rows]

        return records, sources, observations

    records, sources, observations = await asyncio.to_thread(query_chain)

    # Build nodes for memory records(supersede chain)
    for rec in records:
        if rec["id"] in seen_memory_ids:
            continue
        seen_memory_ids.add(rec["id"])
        label = (rec["content"] or "")[:60]
        if len(rec["content"] or "") > 60:
            label += "…"
        nodes.append(
            {
                "id": rec["id"],
                "kind": "memory",
                "label": f"v{rec.get('version') or 1}: {label}",
                "tier": rec["tier"],
                "is_latest": bool(rec.get("is_latest", 1)),
                "last_writer_client": rec.get("last_writer_client"),
                "created_at": rec.get("created_at"),
            }
        )

    # Edges: parent_id chain → supersedes
    for rec in records:
        if rec.get("parent_id") and rec["parent_id"] in seen_memory_ids:
            edges.append(
                {
                    "id": f"sup-{rec['id']}",
                    "from": rec["id"],
                    "to": rec["parent_id"],
                    "kind": "supersedes",
                }
            )

    # Build nodes for observations + edges
    for obs in observations:
        if obs["id"] in seen_obs_ids:
            continue
        seen_obs_ids.add(obs["id"])
        label = (obs["content"] or "")[:80]
        if len(obs["content"] or "") > 80:
            label += "…"
        nodes.append(
            {
                "id": obs["id"],
                "kind": "observation",
                "label": label,
                "role": obs.get("role"),
                "observed_at": obs.get("observed_at"),
            }
        )

    # Edges: source links observation → memory
    for src in sources:
        obs_id = src.get("observation_id")
        rec_id = src.get("memory_record_id")
        if obs_id and rec_id and obs_id in seen_obs_ids and rec_id in seen_memory_ids:
            edges.append(
                {
                    "id": f"src-{src['id']}",
                    "from": obs_id,
                    "to": rec_id,
                    "kind": "source_of",
                }
            )

    return {
        "nodes": nodes,
        "edges": edges,
        "counts": {
            "memories": len(seen_memory_ids),
            "observations": len(seen_obs_ids),
            "supersedes_edges": sum(1 for e in edges if e["kind"] == "supersedes"),
            "source_edges": sum(1 for e in edges if e["kind"] == "source_of"),
        },
    }


mcp = create_server()


def main() -> None:
    configure_once()
    logger.info("quilin-mem server starting", transport="stdio")
    mcp.run(transport="stdio")
