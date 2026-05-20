"""Working → Episodic promotion (QUI-22 L3a).

This module proposes (and, when explicitly committed, applies) promotions of
working-tier memory records into the episodic tier. The design mirrors the
Reflector pattern in :mod:`quilin_mem.reflector`:

* ``WorkingToEpisodicPromoter.propose`` is **pure** — it scans candidate working
  records against three orthogonal eligibility signals and emits structured
  :class:`PromotionProposal` records. It never mutates the store.
* ``WorkingToEpisodicPromoter.commit`` is the only path that writes. Every
  commit routes through a :class:`WriteAuthorityGate` (same Protocol shape as
  Reflector) so the WriteAuthority discipline (`07-safety` §2.6.4) is not
  bypassed for idle/automatic promotions.

The three orthogonal promotion criteria (each independently sufficient) come
straight from ``docs/03-memory/README.md`` lines 396–433:

1. **Multi-access** — ``access_count >= 2``: the record has been read at least
   twice in working tier, indicating it is not transient.
2. **Aged working** — ``age >= 24h``: the record has lingered in working tier
   beyond a session boundary; FIFO eviction would lose it otherwise.
3. **High importance** — ``importance_score >= 0.6``: the upstream observer /
   ingestion layer already marked the record as significant; promote
   immediately so episodic search/decay weighting can take over.

A **decay policy** suppresses noisy promotion of low-signal records:

* ``importance_score < 0.3`` *and* ``access_count == 0`` *and* ``age < 1h``
  → skipped. These records are expected to be FIFO-evicted naturally without
  episodic carry-over, matching the "discard low-signal scratch" intent of the
  working tier.

Triggers (``session_end / idle_interval / count_threshold / explicit /
startup``) are recorded on the proposal for downstream observability; the
scoring logic itself is trigger-agnostic so behaviour is stable across the
call sites that invoke promotion.
"""

from __future__ import annotations

import contextlib
import inspect
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol, cast

from .store import QuilinMemStore
from .store_records import insert_memory
from .store_search import build_keywords as _build_keywords
from .store_search import record_columns
from .store_serialization import row_to_record as _row_to_record
from .types import MemoryItem, MemoryMetadata

PROMOTER_SCHEMA_VERSION = 1

PromotionTrigger = Literal[
    "session_end",
    "idle_interval",
    "count_threshold",
    "explicit",
    "startup",
]

PromotionReasonKind = Literal[
    "multi_access",
    "aged_working",
    "high_importance",
]

PROMOTION_TARGET_LAYER: Literal["episodic"] = "episodic"


# Promotion thresholds — single source of truth for both runtime and tests.
MIN_ACCESS_COUNT_FOR_PROMOTION = 2
AGED_WORKING_THRESHOLD = timedelta(hours=24)
HIGH_IMPORTANCE_THRESHOLD = 0.6

# Decay policy thresholds — suppress promotion of low-signal scratch records.
DECAY_IMPORTANCE_CEILING = 0.3
DECAY_RECENCY_WINDOW = timedelta(hours=1)


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True, frozen=True)
class PromoterConfig:
    """Tunable thresholds for the promoter.

    Defaults match the constants documented above; tests and callers may
    override individual values without monkeypatching module-level constants.
    """

    min_access_count: int = MIN_ACCESS_COUNT_FOR_PROMOTION
    aged_working_threshold: timedelta = AGED_WORKING_THRESHOLD
    high_importance_threshold: float = HIGH_IMPORTANCE_THRESHOLD
    decay_importance_ceiling: float = DECAY_IMPORTANCE_CEILING
    decay_recency_window: timedelta = DECAY_RECENCY_WINDOW


@dataclass(slots=True, frozen=True)
class PromotionProposal:
    """A structured proposal to promote one working record into episodic.

    The proposal is content-addressed by ``source_id`` (the original working
    record) and carries enough metadata to commit independently — the commit
    step does not need to re-read the working record.
    """

    source_id: str
    target_layer: Literal["episodic"]
    promoted_content: str
    promoted_metadata: MemoryMetadata
    reason: str
    reason_kind: PromotionReasonKind
    confidence: float
    trigger: PromotionTrigger
    created_at: datetime = field(default_factory=_utcnow)
    schema_version: int = PROMOTER_SCHEMA_VERSION
    requiresApproval: bool = True  # noqa: N815 - wire contract uses camelCase.

    def to_wire_dict(self) -> dict[str, object]:
        return {
            "kind": "promote_to_episodic",
            "sourceId": self.source_id,
            "targetLayer": self.target_layer,
            "promotedContent": self.promoted_content,
            "promotedMetadata": dict(self.promoted_metadata),
            "reason": self.reason,
            "reasonKind": self.reason_kind,
            "confidence": self.confidence,
            "trigger": self.trigger,
            "createdAt": self.created_at.isoformat(),
            "schemaVersion": self.schema_version,
            "requiresApproval": self.requiresApproval,
        }


@dataclass(slots=True, frozen=True)
class PromotionResult:
    """Outcome of a successful commit — what landed in episodic tier."""

    source_id: str
    promoted_id: str
    target_layer: Literal["episodic"]
    committed_at: datetime
    reason_kind: PromotionReasonKind


class WriteAuthorityGate(Protocol):
    """Same shape as :class:`quilin_mem.reflector.WriteAuthorityGate`.

    Re-declared locally to avoid importing across sibling modules; the
    structural protocol means any object exposing ``authorize(request)`` is
    accepted at the call site (Reflector gates work transparently).
    """

    def authorize(self, request: Mapping[str, object]) -> object: ...


class WorkingToEpisodicPromoter:
    """Pure proposer + WriteAuthority-gated committer for L3a promotion."""

    def __init__(self, config: PromoterConfig | None = None) -> None:
        self._config = config or PromoterConfig()

    @property
    def config(self) -> PromoterConfig:
        return self._config

    def propose(
        self,
        records: Sequence[MemoryItem],
        *,
        trigger: PromotionTrigger = "idle_interval",
        now: datetime | None = None,
    ) -> list[PromotionProposal]:
        """Scan working-tier ``records`` and emit zero or more proposals.

        Records on non-working tiers are ignored — the proposer only operates
        on the working → episodic boundary.
        """

        evaluation_time = now or _utcnow()
        proposals: list[PromotionProposal] = []
        for record in records:
            if record.layer != "working":
                continue

            decision = self._classify(record, now=evaluation_time)
            if decision is None:
                continue

            reason_kind, reason_text, confidence = decision
            proposals.append(
                PromotionProposal(
                    source_id=record.id,
                    target_layer=PROMOTION_TARGET_LAYER,
                    promoted_content=record.content,
                    promoted_metadata=_promotion_metadata(record),
                    reason=reason_text,
                    reason_kind=reason_kind,
                    confidence=confidence,
                    trigger=trigger,
                    created_at=evaluation_time,
                )
            )
        return proposals

    def _classify(
        self,
        record: MemoryItem,
        *,
        now: datetime,
    ) -> tuple[PromotionReasonKind, str, float] | None:
        """Return ``(reason_kind, reason_text, confidence)`` or ``None``.

        Evaluates the three orthogonal eligibility criteria and the decay
        suppression policy in a single pass. Returning ``None`` means the
        record should stay in working tier (or be left for natural FIFO
        eviction) for this proposal round.
        """

        age = max(now - record.created_at, timedelta(0))

        # High importance wins first — the upstream pipeline already vouched
        # for the record so we want it on the episodic timeline immediately.
        if record.importance_score >= self._config.high_importance_threshold:
            confidence = min(1.0, 0.5 + record.importance_score / 2)
            return (
                "high_importance",
                (
                    f"importance_score={record.importance_score:.2f} "
                    f">= {self._config.high_importance_threshold:.2f}"
                ),
                confidence,
            )

        # Aged working — past the 24h boundary the record is no longer "recent"
        # for working-tier purposes; promote before FIFO eviction loses it.
        if age >= self._config.aged_working_threshold:
            confidence = 0.7
            return (
                "aged_working",
                (
                    f"age={age.total_seconds() / 3600:.1f}h "
                    f">= {self._config.aged_working_threshold.total_seconds() / 3600:.1f}h"
                ),
                confidence,
            )

        # Multi-access — repeat reads in working tier indicate the record is
        # being actively reused, so it should survive in episodic memory.
        if record.access_count >= self._config.min_access_count:
            confidence = 0.65
            return (
                "multi_access",
                (f"access_count={record.access_count} >= {self._config.min_access_count}"),
                confidence,
            )

        # Decay policy — low importance, no accesses, and still fresh: skip.
        # These records are expected to age out naturally without episodic
        # carry-over. The check is informational; falling out here returns
        # ``None`` regardless, but we keep the branch explicit for clarity
        # and future auditability.
        if (
            record.importance_score < self._config.decay_importance_ceiling
            and record.access_count == 0
            and age < self._config.decay_recency_window
        ):
            return None

        return None

    async def commit(
        self,
        proposal: PromotionProposal,
        *,
        store: QuilinMemStore,
        write_authority: WriteAuthorityGate,
        now: datetime | None = None,
    ) -> PromotionResult:
        """Apply one approved promotion proposal.

        Routes through ``write_authority`` first (mirrors Reflector), then
        inserts the promoted record into the episodic tier and soft-deletes
        the original working record. The newly created episodic record gets a
        fresh id — callers should treat ``proposal.source_id`` and the
        returned ``promoted_id`` as distinct identifiers.
        """

        decision = await _authorize_write(
            write_authority,
            {
                "tool": "memory_promote_working_to_episodic",
                "origin": "idle",
                "riskLevel": "low",
                "summary": ("Promote working record into episodic tier per L3a observer policy"),
                "metadata": {
                    "schema_version": PROMOTER_SCHEMA_VERSION,
                    "source_id": proposal.source_id,
                    "reason_kind": proposal.reason_kind,
                    "trigger": proposal.trigger,
                },
            },
        )
        if not _decision_allowed(decision):
            raise PermissionError("WriteAuthority denied working→episodic promotion")

        committed_at = now or _utcnow()
        promoted_metadata: dict[str, object] = dict(proposal.promoted_metadata)
        promoted_metadata.setdefault("schema_version", PROMOTER_SCHEMA_VERSION)
        # The commit step always rebrands ``source`` to ``promoter`` so episodic
        # readers can distinguish promoted carry-overs from native episodic
        # ingestion. The original working-tier ``source`` is preserved on the
        # ``original_source`` key for provenance.
        original_source = promoted_metadata.get("source")
        if isinstance(original_source, str) and original_source != "promoter":
            promoted_metadata["original_source"] = original_source
        promoted_metadata["source"] = "promoter"
        promoted_metadata["source_layers"] = ["working"]
        promoted_metadata["promotion_source_id"] = proposal.source_id
        promoted_metadata["promotion_reason_kind"] = proposal.reason_kind
        promoted_metadata["promotion_trigger"] = proposal.trigger

        atomic_result = await _commit_promotion_atomic_if_sqlite(
            store,
            proposal=proposal,
            promoted_metadata=promoted_metadata,
            confidence=proposal.confidence,
            committed_at=committed_at,
        )
        if atomic_result is not None:
            return atomic_result

        # Fallback for mock/non-SQLite stores. The real QuilinMemStore path above
        # holds the store lock across check/insert/delete so concurrent commits
        # cannot double-promote.
        existing = await _find_existing_promotion(store, proposal.source_id)
        if existing is not None:
            return PromotionResult(
                source_id=proposal.source_id,
                promoted_id=existing.id,
                target_layer=PROMOTION_TARGET_LAYER,
                committed_at=committed_at,
                reason_kind=proposal.reason_kind,
            )

        # QUI-22 Reviewer 1 REAL #3 fix (2026-05-21):commit 原子性 — store.store
        # 与 store.delete 是两步独立异步,中间任一失败会留下 episodic 已建 +
        # working 未删的不一致状态。用 try/except 补偿:store.delete 失败时
        # 回滚 episodic insert(物理删除 — 这是补偿,不走 supersede 历史路径)。
        promoted_record = await store.store(
            proposal.promoted_content,
            tier="episodic",
            metadata=promoted_metadata,
            importance_score=proposal.confidence,
        )

        try:
            delete_ok = await cast(Any, store.delete)(proposal.source_id)
            if delete_ok is False:
                raise RuntimeError("store.delete returned False")
        except Exception as exc:
            # 补偿:如果 working delete 失败,回滚 episodic insert 避免 double-count。
            # 用 store._lock + raw SQL 物理删除新建的 episodic record,绕开
            # supersede 历史路径(它不是用户行为产生的,是 partial-commit 残骸)。
            # 回滚也失败时 best-effort 静默吞掉(原始错误已经 raise)。
            with contextlib.suppress(Exception):
                await _hard_delete_promoted_record(store, promoted_record.id)
            raise RuntimeError(
                f"promotion commit partial-failed: source={proposal.source_id} "
                f"promoted={promoted_record.id} delete_err={type(exc).__name__}: {exc}"
            ) from exc

        return PromotionResult(
            source_id=proposal.source_id,
            promoted_id=promoted_record.id,
            target_layer=PROMOTION_TARGET_LAYER,
            committed_at=committed_at,
            reason_kind=proposal.reason_kind,
        )


def _promotion_metadata(record: MemoryItem) -> MemoryMetadata:
    """Copy working metadata into an episodic-ready shape.

    Drops layer-specific keys that no longer apply once the record crosses
    the tier boundary (``layer``) and seeds the schema_version. The actual
    ``source_layers`` / ``promotion_source_id`` / ``promotion_reason_kind``
    annotations are added at commit time, so the proposal stays inspectable
    independent of the committer.
    """

    metadata: dict[str, object] = dict(record.metadata)
    metadata["schema_version"] = metadata.get("schema_version", 1)
    metadata.pop("layer", None)
    return cast(MemoryMetadata, metadata)


async def _authorize_write(
    write_authority: WriteAuthorityGate,
    request: Mapping[str, object],
) -> object:
    decision = write_authority.authorize(request)
    if inspect.isawaitable(decision):
        return await cast(Any, decision)
    return decision


async def _find_existing_promotion(store: QuilinMemStore, source_id: str) -> MemoryItem | None:
    """QUI-22 Reviewer 1 REAL #1 fix + Reviewer 3 REAL #1 fix:查找 source_id 是否已 promote 过。

    通过 SQL LIKE 直接查 `metadata_json` 含 `"promotion_source_id":"<source_id>"`
    substring,**不受 `list_by_layer` 默认 limit=50 影响**。

    Reviewer 3 (2026-05-21) 发现:用 `store.list_by_layer("episodic")` 默认 50 条
    上限,episodic 累积 > 50 后旧 promotion 被切窗 → 幂等检测漏判 → double-promote。
    修法:走 raw SQL 直接查 metadata_json,O(N) 全表扫但有 is_latest=1 + deleted=0
    + tier='episodic' 三个 index 过滤,实际行数远小于全表。
    """
    conn = getattr(store, "_conn", None)
    lock = getattr(store, "_lock", None)
    if conn is None or lock is None:
        # store API 不可用时(e.g. mock store),fallback 到 list_by_layer 路径
        # 保持兼容(小数据集场景仍正确)。
        try:
            episodic_records = await store.list_by_layer("episodic")
        except Exception:  # noqa: BLE001
            return None
        for record in episodic_records:
            existing_source = record.metadata.get("promotion_source_id")
            if existing_source == source_id:
                return record
        return None

    # metadata_json 用 json.dumps(sort_keys=True) — 默认 separators 是 ", "
    # 和 ": "(冒号后**有空格**),所以稳定 substring 是 `"promotion_source_id": "X"`
    # 不是 `"promotion_source_id":"X"`。同时把 source_id 内的 SQL LIKE 元字符 escape。
    escaped_source = source_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    needle = f'%"promotion_source_id": "{escaped_source}"%'

    def _query_sync() -> str | None:
        cursor = conn.execute(
            """
            SELECT id FROM memory_records
            WHERE tier = 'episodic'
              AND deleted = 0
              AND is_latest = 1
              AND metadata_json LIKE ? ESCAPE '\\'
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (needle,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return row["id"] if hasattr(row, "keys") else row[0]

    import asyncio

    def _locked_query() -> str | None:
        with lock:
            return _query_sync()

    try:
        existing_id = await asyncio.to_thread(_locked_query)
    except Exception:  # noqa: BLE001
        return None

    if existing_id is None:
        return None

    return await store.get(existing_id)


async def _commit_promotion_atomic_if_sqlite(
    store: QuilinMemStore,
    *,
    proposal: PromotionProposal,
    promoted_metadata: dict[str, object],
    confidence: float,
    committed_at: datetime,
) -> PromotionResult | None:
    """Atomically check, insert promotion, and archive source for QuilinMemStore."""

    conn = getattr(store, "_conn", None)
    lock = getattr(store, "_lock", None)
    if conn is None or lock is None:
        return None

    promoted = MemoryItem(
        content=proposal.promoted_content,
        layer=PROMOTION_TARGET_LAYER,
        metadata=promoted_metadata,
        importance_score=confidence,
    )
    escaped_source = (
        proposal.source_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )
    needle = f'%"promotion_source_id": "{escaped_source}"%'

    def _commit_sync() -> PromotionResult:
        with lock:
            conn.execute("BEGIN IMMEDIATE")
            with conn:
                existing = conn.execute(
                    """
                    SELECT id FROM memory_records
                    WHERE tier = 'episodic'
                      AND deleted = 0
                      AND is_latest = 1
                      AND metadata_json LIKE ? ESCAPE '\\'
                    ORDER BY created_at ASC
                    LIMIT 1
                    """,
                    (needle,),
                ).fetchone()
                if existing is not None:
                    return PromotionResult(
                        source_id=proposal.source_id,
                        promoted_id=existing["id"] if hasattr(existing, "keys") else existing[0],
                        target_layer=PROMOTION_TARGET_LAYER,
                        committed_at=committed_at,
                        reason_kind=proposal.reason_kind,
                    )

                source_row = conn.execute(
                    f"""
                    SELECT {record_columns()}
                    FROM memory_records
                    WHERE id = ? AND tier = 'working' AND deleted = 0 AND is_latest = 1
                    """,
                    (proposal.source_id,),
                ).fetchone()
                if source_row is None:
                    raise RuntimeError("promotion source is no longer active")

                insert_memory(conn, promoted, build_keywords=_build_keywords)
                snapshot = getattr(store, "_record_history_snapshot_locked", None)
                if callable(snapshot):
                    snapshot(
                        memory_id=proposal.source_id,
                        record=_row_to_record(source_row, now=_utcnow),
                        label_kind="delete",
                        snapshot_at=committed_at,
                    )
                conn.execute(
                    """
                    UPDATE memory_records
                    SET deleted = 1, archived_at = ?, forget_after = ?, recovered_at = NULL
                    WHERE id = ? AND deleted = 0 AND is_latest = 1
                    """,
                    (
                        committed_at.isoformat(),
                        committed_at.isoformat(),
                        proposal.source_id,
                    ),
                )
                conn.execute(
                    "DELETE FROM memory_records_fts WHERE id = ?",
                    (proposal.source_id,),
                )

        return PromotionResult(
            source_id=proposal.source_id,
            promoted_id=promoted.id,
            target_layer=PROMOTION_TARGET_LAYER,
            committed_at=committed_at,
            reason_kind=proposal.reason_kind,
        )

    import asyncio

    return await asyncio.to_thread(_commit_sync)


async def _hard_delete_promoted_record(store: QuilinMemStore, record_id: str) -> None:
    """QUI-22 Reviewer 1 REAL #3 fix:补偿性物理删除 partial-commit 残留。

    `store.delete` 走 soft-delete + forget_after history-preserve(QUI-193 设计),
    会留 row 在 DB 中 + 创建 forget_after 历史快照。partial-commit 补偿场景下,
    我们要的是"当作这条 record 从未存在过",所以必须**物理删除**(`DELETE FROM
    memory_records WHERE id = ?`)。

    通过 store._conn + _lock 走 raw SQL,绕开 soft-delete 业务逻辑。如果 store
    没暴露 _conn(例如 mock store),静默失败(caller 仍 raise 原始错误)。
    """
    conn = getattr(store, "_conn", None)
    lock = getattr(store, "_lock", None)
    if conn is None or lock is None:
        return

    def _hard_delete_sync() -> None:
        with conn:
            conn.execute("DELETE FROM memory_records WHERE id = ?", (record_id,))
            conn.execute("DELETE FROM memory_records_fts WHERE id = ?", (record_id,))
            conn.execute("DELETE FROM memory_sources WHERE memory_record_id = ?", (record_id,))

    # 用 asyncio.to_thread 避免 sync SQL 阻塞 event loop。但 lock 是 threading.Lock,
    # 需在 thread 内 acquire。
    import asyncio

    def _locked_delete() -> None:
        with lock:
            _hard_delete_sync()

    await asyncio.to_thread(_locked_delete)


def _decision_allowed(decision: object) -> bool:
    if isinstance(decision, bool):
        return decision
    if isinstance(decision, Mapping):
        allowed = decision.get("allowed")
        if isinstance(allowed, bool):
            return allowed
        decision_value = decision.get("decision")
        return decision_value in {"allow", "allowed", "approved"}
    allowed = getattr(decision, "allowed", None)
    if isinstance(allowed, bool):
        return allowed
    decision_value = getattr(decision, "decision", None)
    return decision_value in {"allow", "allowed", "approved"}


def propose_promotions(
    records: Sequence[MemoryItem],
    *,
    config: PromoterConfig | None = None,
    trigger: PromotionTrigger = "idle_interval",
    now: datetime | None = None,
) -> list[PromotionProposal]:
    """Helper mirroring :func:`quilin_mem.reflector.propose_reflection`."""

    return WorkingToEpisodicPromoter(config).propose(
        records,
        trigger=trigger,
        now=now,
    )


__all__ = [
    "AGED_WORKING_THRESHOLD",
    "DECAY_IMPORTANCE_CEILING",
    "DECAY_RECENCY_WINDOW",
    "HIGH_IMPORTANCE_THRESHOLD",
    "MIN_ACCESS_COUNT_FOR_PROMOTION",
    "PROMOTER_SCHEMA_VERSION",
    "PROMOTION_TARGET_LAYER",
    "PromoterConfig",
    "PromotionProposal",
    "PromotionReasonKind",
    "PromotionResult",
    "PromotionTrigger",
    "WorkingToEpisodicPromoter",
    "WriteAuthorityGate",
    "propose_promotions",
]
