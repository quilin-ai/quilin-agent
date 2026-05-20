"""Tests for working → episodic promotion (QUI-22 L3a).

Covers:
* the three orthogonal promotion criteria (multi_access / aged_working /
  high_importance) — each independently sufficient,
* the decay-policy suppression of low-signal scratch records,
* all five documented :data:`PromotionTrigger` literals propagate onto the
  emitted proposal,
* WriteAuthority allow/deny gating at commit time,
* end-to-end working → observer-style propose → episodic landing in a real
  :class:`QuilinMemStore`.

The end-to-end test is the integration evidence required by QUI-22: it stores
working records through the real store, runs the promoter, commits the
approved proposals, and asserts the promoted records are queryable from the
episodic tier afterwards.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

import pytest

from quilin_mem import promotion as promotion_module
from quilin_mem.promotion import (
    AGED_WORKING_THRESHOLD,
    HIGH_IMPORTANCE_THRESHOLD,
    MIN_ACCESS_COUNT_FOR_PROMOTION,
    PROMOTER_SCHEMA_VERSION,
    PromoterConfig,
    PromotionProposal,
    PromotionTrigger,
    WorkingToEpisodicPromoter,
    propose_promotions,
)
from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem

FIXED_NOW = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)


def _working(
    memory_id: str,
    *,
    content: str = "working scratch",
    access_count: int = 0,
    importance_score: float = 0.5,
    created_at: datetime | None = None,
    metadata: Mapping[str, object] | None = None,
) -> MemoryItem:
    return MemoryItem(
        id=memory_id,
        content=content,
        layer="working",
        metadata={
            "schema_version": 1,
            "source": "test",
            **(dict(metadata) if metadata else {}),
        },
        access_count=access_count,
        importance_score=importance_score,
        created_at=created_at or FIXED_NOW,
        last_accessed=created_at or FIXED_NOW,
    )


# ---------------------------------------------------------------------------
# 1-3. Three orthogonal promotion criteria
# ---------------------------------------------------------------------------


def test_multi_access_promotes_working_record() -> None:
    record = _working(
        "w-multi",
        access_count=MIN_ACCESS_COUNT_FOR_PROMOTION,
        importance_score=0.5,
        created_at=FIXED_NOW - timedelta(minutes=10),
    )

    proposals = WorkingToEpisodicPromoter().propose(
        [record],
        trigger="count_threshold",
        now=FIXED_NOW,
    )

    assert len(proposals) == 1
    proposal = proposals[0]
    assert proposal.source_id == "w-multi"
    assert proposal.target_layer == "episodic"
    assert proposal.reason_kind == "multi_access"
    assert proposal.trigger == "count_threshold"
    assert "access_count=2" in proposal.reason
    assert proposal.requiresApproval is True


def test_aged_working_record_is_promoted_after_24h() -> None:
    record = _working(
        "w-aged",
        access_count=0,
        importance_score=0.4,
        created_at=FIXED_NOW - (AGED_WORKING_THRESHOLD + timedelta(minutes=5)),
    )

    proposals = WorkingToEpisodicPromoter().propose(
        [record],
        trigger="idle_interval",
        now=FIXED_NOW,
    )

    assert len(proposals) == 1
    proposal = proposals[0]
    assert proposal.reason_kind == "aged_working"
    # importance below high-importance threshold so the aged branch must own
    # the decision, not high_importance.
    assert proposal.confidence == 0.7


def test_high_importance_record_promotes_immediately() -> None:
    record = _working(
        "w-high",
        access_count=0,
        importance_score=HIGH_IMPORTANCE_THRESHOLD + 0.05,
        created_at=FIXED_NOW - timedelta(minutes=2),
    )

    proposals = WorkingToEpisodicPromoter().propose(
        [record],
        trigger="explicit",
        now=FIXED_NOW,
    )

    assert len(proposals) == 1
    proposal = proposals[0]
    assert proposal.reason_kind == "high_importance"
    # high_importance branch derives confidence from importance_score.
    assert proposal.confidence == pytest.approx(0.5 + (HIGH_IMPORTANCE_THRESHOLD + 0.05) / 2)


# ---------------------------------------------------------------------------
# 4. Decay policy — low importance + no access + fresh -> no promotion
# ---------------------------------------------------------------------------


def test_decay_policy_suppresses_low_signal_scratch() -> None:
    record = _working(
        "w-decay",
        access_count=0,
        importance_score=0.1,
        created_at=FIXED_NOW - timedelta(minutes=5),
    )

    proposals = WorkingToEpisodicPromoter().propose(
        [record],
        trigger="idle_interval",
        now=FIXED_NOW,
    )

    assert proposals == []


def test_decay_policy_does_not_suppress_aged_records() -> None:
    """Even a low-importance, no-access record is rescued after 24h.

    Confirms the decay branch is *only* short-circuiting fresh scratch records;
    once a record crosses ``AGED_WORKING_THRESHOLD`` the aged_working branch
    must still fire.
    """

    record = _working(
        "w-decay-aged",
        access_count=0,
        importance_score=0.1,
        created_at=FIXED_NOW - (AGED_WORKING_THRESHOLD + timedelta(hours=1)),
    )

    proposals = WorkingToEpisodicPromoter().propose(
        [record],
        trigger="idle_interval",
        now=FIXED_NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].reason_kind == "aged_working"


# ---------------------------------------------------------------------------
# 5. All 5 documented PromotionTrigger literals propagate onto the proposal.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "trigger",
    [
        "session_end",
        "idle_interval",
        "count_threshold",
        "explicit",
        "startup",
    ],
)
def test_all_five_triggers_round_trip_on_proposal(trigger: PromotionTrigger) -> None:
    record = _working(
        "w-trigger",
        access_count=MIN_ACCESS_COUNT_FOR_PROMOTION,
        importance_score=0.5,
        created_at=FIXED_NOW - timedelta(minutes=1),
    )

    proposals = WorkingToEpisodicPromoter().propose(
        [record],
        trigger=trigger,
        now=FIXED_NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].trigger == trigger
    # Schema version is part of the wire contract for downstream consumers.
    assert proposals[0].schema_version == PROMOTER_SCHEMA_VERSION
    wire = proposals[0].to_wire_dict()
    assert wire["kind"] == "promote_to_episodic"
    assert wire["trigger"] == trigger


# ---------------------------------------------------------------------------
# 6. Non-working records are ignored.
# ---------------------------------------------------------------------------


def test_non_working_records_are_ignored() -> None:
    episodic = MemoryItem(
        id="ep-1",
        content="already episodic",
        layer="episodic",
        metadata={"schema_version": 1, "source": "test"},
        access_count=5,
        importance_score=0.9,
        created_at=FIXED_NOW - timedelta(days=2),
        last_accessed=FIXED_NOW,
    )

    proposals = WorkingToEpisodicPromoter().propose(
        [episodic],
        trigger="explicit",
        now=FIXED_NOW,
    )

    assert proposals == []


# ---------------------------------------------------------------------------
# 7. WriteAuthority deny -> no promotion lands.
# ---------------------------------------------------------------------------


async def test_write_authority_denies_promotion_commit() -> None:
    class DenyGate:
        def authorize(self, _request: Mapping[str, object]) -> Mapping[str, object]:
            return {"allowed": False}

    proposal = PromotionProposal(
        source_id="w-denied",
        target_layer="episodic",
        promoted_content="must not land",
        promoted_metadata={"schema_version": 1, "source": "test"},
        reason="multi_access denied",
        reason_kind="multi_access",
        confidence=0.65,
        trigger="explicit",
        created_at=FIXED_NOW,
    )

    async with QuilinMemStore(db_path=":memory:") as store:
        with contextlib.suppress(PermissionError):
            await WorkingToEpisodicPromoter().commit(
                proposal,
                store=store,
                write_authority=DenyGate(),
            )

        assert await store.count({"layer": "episodic"}) == 0


# ---------------------------------------------------------------------------
# 8. End-to-end working → observer-style propose → episodic landing.
# ---------------------------------------------------------------------------


async def test_end_to_end_working_to_episodic_promotion() -> None:
    """Drive the propose+commit path against a real QuilinMemStore.

    Verifies the 4-tier contract: a record stored in the working tier with the
    high-importance signal is observed via the promoter, the proposal commits
    successfully through an allow-gate, and the resulting record is queryable
    from the episodic tier with the promotion provenance preserved on the
    metadata.
    """

    class AllowGate:
        def __init__(self) -> None:
            self.calls: list[Mapping[str, object]] = []

        def authorize(self, request: Mapping[str, object]) -> Mapping[str, object]:
            self.calls.append(request)
            return {"allowed": True}

    gate = AllowGate()

    async with QuilinMemStore(db_path=":memory:") as store:
        # 1. Store a working record that satisfies the high-importance branch.
        working_record = await store.store(
            "User prefers concise summaries with citations.",
            tier="working",
            metadata={"schema_version": 1, "source": "observer"},
            importance_score=0.8,
        )

        assert await store.count({"layer": "working"}) == 1
        assert await store.count({"layer": "episodic"}) == 0

        # 2. Observer-style scan -> proposer
        records = await store.list_by_layer("working", limit=50, offset=0)
        proposals = WorkingToEpisodicPromoter().propose(
            records,
            trigger="session_end",
            now=FIXED_NOW,
        )
        assert len(proposals) == 1
        assert proposals[0].source_id == working_record.id
        assert proposals[0].reason_kind == "high_importance"

        # 3. Commit through allow-gate
        result = await WorkingToEpisodicPromoter().commit(
            proposals[0],
            store=store,
            write_authority=gate,
            now=FIXED_NOW,
        )

        # 4. 4-tier contract — promoted record is in episodic, working soft-deleted.
        assert result.target_layer == "episodic"
        assert result.reason_kind == "high_importance"
        assert await store.count({"layer": "episodic"}) == 1
        assert await store.count({"layer": "working"}) == 0

        promoted = await store.get(result.promoted_id)
        assert promoted is not None
        assert promoted.layer == "episodic"
        assert promoted.metadata["source"] == "promoter"
        # original working-tier source preserved on dedicated key for provenance.
        assert promoted.metadata["original_source"] == "observer"
        assert promoted.metadata["promotion_source_id"] == working_record.id
        assert promoted.metadata["promotion_reason_kind"] == "high_importance"
        assert promoted.metadata["promotion_trigger"] == "session_end"

        # WriteAuthority gate was consulted with the documented contract.
        assert len(gate.calls) == 1
        assert gate.calls[0]["origin"] == "idle"
        assert gate.calls[0]["tool"] == "memory_promote_working_to_episodic"


# ---------------------------------------------------------------------------
# 9. Helper function mirrors Reflector.propose_reflection.
# ---------------------------------------------------------------------------


def test_propose_promotions_helper_matches_class_behaviour() -> None:
    record = _working(
        "w-helper",
        access_count=MIN_ACCESS_COUNT_FOR_PROMOTION,
        importance_score=0.5,
        created_at=FIXED_NOW - timedelta(minutes=1),
    )

    via_helper = propose_promotions(
        [record],
        trigger="count_threshold",
        now=FIXED_NOW,
    )
    via_class = WorkingToEpisodicPromoter().propose(
        [record],
        trigger="count_threshold",
        now=FIXED_NOW,
    )

    assert len(via_helper) == 1
    assert len(via_class) == 1
    assert via_helper[0].source_id == via_class[0].source_id
    assert via_helper[0].reason_kind == via_class[0].reason_kind
    assert via_helper[0].trigger == via_class[0].trigger


# ---------------------------------------------------------------------------
# 10. PromoterConfig override path.
# ---------------------------------------------------------------------------


def test_promoter_config_can_override_thresholds() -> None:
    record = _working(
        "w-cfg",
        access_count=1,
        importance_score=0.4,
        created_at=FIXED_NOW - timedelta(minutes=1),
    )

    # Defaults -> no promotion (only 1 access, fresh, mid importance, decay
    # ceiling 0.3 < 0.4 so doesn't suppress, but no positive branch fires).
    assert WorkingToEpisodicPromoter().propose([record], now=FIXED_NOW) == []

    # Lower the multi-access bar to 1 -> the same record promotes.
    config = PromoterConfig(min_access_count=1)
    proposals = WorkingToEpisodicPromoter(config).propose(
        [record],
        trigger="explicit",
        now=FIXED_NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].reason_kind == "multi_access"


# ---------------------------------------------------------------------------
# 11. QUI-22 Reviewer 1 REAL #1 fix: commit 幂等性 — 同 proposal 二次 commit
# 不产生第二个 episodic record。
# ---------------------------------------------------------------------------


async def test_commit_is_idempotent_for_same_proposal() -> None:
    """重复 commit 同一 PromotionProposal 必须返回同一 promoted_id, episodic
    count 保持 1, working 仍 soft-deleted。"""

    class AllowGate:
        def authorize(self, request: Mapping[str, object]) -> Mapping[str, object]:
            return {"allowed": True}

    async with QuilinMemStore(db_path=":memory:") as store:
        working_record = await store.store(
            "Idempotent commit test record.",
            tier="working",
            metadata={"schema_version": 1, "source": "observer"},
            importance_score=0.8,
        )
        records = await store.list_by_layer("working", limit=50, offset=0)
        proposals = WorkingToEpisodicPromoter().propose(records, trigger="explicit", now=FIXED_NOW)
        assert len(proposals) == 1

        # First commit
        result1 = await WorkingToEpisodicPromoter().commit(
            proposals[0], store=store, write_authority=AllowGate(), now=FIXED_NOW
        )
        assert await store.count({"layer": "episodic"}) == 1

        # Second commit (idempotent) — same proposal, no new episodic record
        result2 = await WorkingToEpisodicPromoter().commit(
            proposals[0], store=store, write_authority=AllowGate(), now=FIXED_NOW
        )
        assert result2.promoted_id == result1.promoted_id
        assert await store.count({"layer": "episodic"}) == 1
        assert await store.count({"layer": "working"}) == 0

        # working_record should not exist anymore
        assert await store.get(working_record.id) is None


async def test_commit_is_idempotent_under_concurrency() -> None:
    class AllowGate:
        def authorize(self, request: Mapping[str, object]) -> Mapping[str, object]:
            return {"allowed": True}

    async with QuilinMemStore(db_path=":memory:") as store:
        await store.store(
            "Concurrent promotion test record.",
            tier="working",
            metadata={"schema_version": 1, "source": "observer"},
            importance_score=0.8,
        )
        records = await store.list_by_layer("working", limit=50, offset=0)
        proposal = WorkingToEpisodicPromoter().propose(
            records,
            trigger="explicit",
            now=FIXED_NOW,
        )[0]

        results = await asyncio.gather(
            WorkingToEpisodicPromoter().commit(
                proposal,
                store=store,
                write_authority=AllowGate(),
                now=FIXED_NOW,
            ),
            WorkingToEpisodicPromoter().commit(
                proposal,
                store=store,
                write_authority=AllowGate(),
                now=FIXED_NOW,
            ),
        )

        assert results[0].promoted_id == results[1].promoted_id
        assert await store.count({"layer": "episodic"}) == 1
        assert await store.count({"layer": "working"}) == 0


# ---------------------------------------------------------------------------
# 12. QUI-22 Reviewer 1 REAL #3 fix: partial-commit rollback — store.delete
# 失败时 promoted episodic record 被回滚物理删除。
# ---------------------------------------------------------------------------


async def test_commit_rolls_back_episodic_when_delete_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """模拟 store.delete 抛 RuntimeError, 验证 commit 抛错且 episodic 已
    rollback (count=0), 不留 double-count 残骸。"""

    class AllowGate:
        def authorize(self, request: Mapping[str, object]) -> Mapping[str, object]:
            return {"allowed": True}

    async def no_atomic(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(promotion_module, "_commit_promotion_atomic_if_sqlite", no_atomic)

    async with QuilinMemStore(db_path=":memory:") as store:
        await store.store(
            "Partial-commit rollback test.",
            tier="working",
            metadata={"schema_version": 1, "source": "observer"},
            importance_score=0.8,
        )
        records = await store.list_by_layer("working", limit=50, offset=0)
        proposals = WorkingToEpisodicPromoter().propose(records, trigger="explicit", now=FIXED_NOW)

        # Monkey-patch store.delete to raise — 模拟 partial-commit 失败
        original_delete = store.delete

        async def broken_delete(record_id: str) -> bool:
            raise RuntimeError("simulated store.delete failure")

        store.delete = broken_delete  # type: ignore[method-assign]
        try:
            with pytest.raises(RuntimeError, match="promotion commit partial-failed"):
                await WorkingToEpisodicPromoter().commit(
                    proposals[0],
                    store=store,
                    write_authority=AllowGate(),
                    now=FIXED_NOW,
                )
        finally:
            store.delete = original_delete  # type: ignore[method-assign]

        # Episodic 应回滚 — 0 record (working 仍存在因为 delete 失败前未被删)
        assert await store.count({"layer": "episodic"}) == 0
        assert await store.count({"layer": "working"}) == 1
        orphan_count = store._conn.execute(  # type: ignore[attr-defined]
            """
            SELECT COUNT(*)
            FROM memory_records_fts AS fts
            LEFT JOIN memory_records AS records ON records.id = fts.id
            WHERE records.id IS NULL
            """
        ).fetchone()[0]
        assert orphan_count == 0


async def test_commit_rolls_back_episodic_when_delete_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """store.delete 返回 False 也必须视为 partial-commit 失败。"""

    class AllowGate:
        def authorize(self, request: Mapping[str, object]) -> Mapping[str, object]:
            return {"allowed": True}

    async def no_atomic(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(promotion_module, "_commit_promotion_atomic_if_sqlite", no_atomic)

    async with QuilinMemStore(db_path=":memory:") as store:
        await store.store(
            "Delete false rollback test.",
            tier="working",
            metadata={"schema_version": 1, "source": "observer"},
            importance_score=0.8,
        )
        records = await store.list_by_layer("working", limit=50, offset=0)
        proposals = WorkingToEpisodicPromoter().propose(records, trigger="explicit", now=FIXED_NOW)

        original_delete = store.delete

        async def false_delete(record_id: str) -> bool:
            return False

        store.delete = false_delete  # type: ignore[method-assign]
        try:
            with pytest.raises(RuntimeError, match="promotion commit partial-failed"):
                await WorkingToEpisodicPromoter().commit(
                    proposals[0],
                    store=store,
                    write_authority=AllowGate(),
                    now=FIXED_NOW,
                )
        finally:
            store.delete = original_delete  # type: ignore[method-assign]

        assert await store.count({"layer": "episodic"}) == 0
        assert await store.count({"layer": "working"}) == 1
        orphan_count = store._conn.execute(  # type: ignore[attr-defined]
            """
            SELECT COUNT(*)
            FROM memory_records_fts AS fts
            LEFT JOIN memory_records AS records ON records.id = fts.id
            WHERE records.id IS NULL
            """
        ).fetchone()[0]
        assert orphan_count == 0


# ---------------------------------------------------------------------------
# 13. QUI-22 Reviewer 3 REAL #1 fix: idempotent check 不能受 list_by_layer
# 默认 limit=50 影响。Episodic > 50 后旧 promotion 仍要能被发现。
# ---------------------------------------------------------------------------


async def test_commit_idempotent_when_episodic_exceeds_default_limit() -> None:
    """Episodic 累积 > 50 条后,二次 commit 同 proposal 仍 idempotent。

    Reviewer 3 发现 `_find_existing_promotion` 之前用 `list_by_layer("episodic")`
    默认 limit=50,episodic > 50 时旧 promotion 被切窗 → 幂等失效。修后用 raw SQL
    全表 metadata_json LIKE 查询,不受 limit 影响。
    """

    class AllowGate:
        def authorize(self, request: Mapping[str, object]) -> Mapping[str, object]:
            return {"allowed": True}

    async with QuilinMemStore(db_path=":memory:") as store:
        # 1. 先存一个 working record 准备 promote
        await store.store(
            "Target record for idempotent test.",
            tier="working",
            metadata={"schema_version": 1, "source": "observer"},
            importance_score=0.8,
        )

        # 2. 灌满 60 个 episodic record(模拟历史累积)— 不带 promotion_source_id
        for i in range(60):
            await store.store(
                f"Filler episodic {i}",
                tier="episodic",
                metadata={"schema_version": 1, "source": "filler"},
                importance_score=0.5,
            )

        assert await store.count({"layer": "episodic"}) == 60

        # 3. propose + first commit
        records = await store.list_by_layer("working", limit=50, offset=0)
        proposals = WorkingToEpisodicPromoter().propose(records, trigger="explicit", now=FIXED_NOW)
        assert len(proposals) == 1

        result1 = await WorkingToEpisodicPromoter().commit(
            proposals[0], store=store, write_authority=AllowGate(), now=FIXED_NOW
        )
        assert await store.count({"layer": "episodic"}) == 61  # 60 filler + 1 promoted

        # 4. second commit — 即使 episodic 已超 50 条,_find_existing_promotion
        # 仍能通过 raw SQL 找到第一次 promote 的 record,返同 id
        result2 = await WorkingToEpisodicPromoter().commit(
            proposals[0], store=store, write_authority=AllowGate(), now=FIXED_NOW
        )
        assert result2.promoted_id == result1.promoted_id
        assert await store.count({"layer": "episodic"}) == 61  # 不增加
