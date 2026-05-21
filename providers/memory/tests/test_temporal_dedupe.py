from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from quilin_mem.consolidator import (
    BatchJudgeCluster,
    BatchJudgeResult,
    Consolidator,
    DedupeJudgeResult,
    _DeepseekBatchJudge,
    _DeepseekConsolidationJudge,
)
from quilin_mem.idle_budget import IdleBudgetProvider
from quilin_mem.server import create_server
from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem

BASE = datetime(2026, 5, 21, tzinfo=UTC)


def _metadata(
    *,
    source: str,
    valid_from: datetime | None = None,
    valid_to: datetime | None = None,
    version: int | None = None,
    supersedes: list[str] | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "schema_version": 1,
        "source": source,
        "stability_reason": "temporal dedupe fixture",
    }
    if valid_from is not None:
        metadata["valid_from"] = valid_from.isoformat()
    if valid_to is not None:
        metadata["valid_to"] = valid_to.isoformat()
    if version is not None:
        metadata["version"] = version
    if supersedes is not None:
        metadata["supersedes"] = supersedes
    return metadata


async def _store_semantic(
    store: QuilinMemStore,
    *,
    memory_id: str,
    content: str,
    created_at: datetime,
    metadata: dict[str, object],
    embedding: list[float] | None = None,
) -> None:
    await store.add(
        MemoryItem(
            id=memory_id,
            content=content,
            layer="semantic",
            metadata=metadata,
            created_at=created_at,
            embedding=embedding,
        )
    )


def _granted_budget() -> IdleBudgetProvider:
    return IdleBudgetProvider(enabled=True, token_budget=10_000)


def _dedupe_action(proposal: Any) -> Any:
    assert proposal.actions
    return proposal.actions[0]


def _dedupe_group(proposal: Any) -> dict[str, Any]:
    action = _dedupe_action(proposal)
    groups = action.metadata["dedupe_groups"]
    assert isinstance(groups, list)
    assert groups
    return groups[0]


async def test_old_nickname_update_proposes_supersedes_instead_of_plain_delete() -> None:
    def judge(_left: MemoryItem, _right: MemoryItem, _score: float) -> DedupeJudgeResult:
        return DedupeJudgeResult(decision="supersedes", reason="老孟更新称呼为孟哥")

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="old-name",
            content="老孟叫我小明",
            created_at=BASE,
            metadata=_metadata(source="chat-old", valid_from=BASE, version=1),
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="new-name",
            content="孟哥现在叫我小花",
            created_at=BASE + timedelta(minutes=2),
            metadata=_metadata(
                source="chat-new",
                valid_from=BASE + timedelta(minutes=2),
                version=2,
                supersedes=["old-name"],
            ),
            embedding=[0.6, 0.8],
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
            dedupe_judge=judge,
        ).propose(strategy="dedupe", tier="semantic")

    group = _dedupe_group(proposal)
    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert group["keepId"] == "new-name"
    assert group["deleteIds"] == ["old-name"]
    assert temporal["decision"] == "supersedes"
    assert temporal["superseded_by_edges"][0]["from_id"] == "old-name"
    assert temporal["superseded_by_edges"][0]["to_id"] == "new-name"
    assert temporal["superseded_by_edges"][0]["predicate"] == "superseded_by"


async def test_historical_fact_with_closed_valid_window_is_retained() -> None:
    def judge(_left: MemoryItem, _right: MemoryItem, _score: float) -> DedupeJudgeResult:
        return DedupeJudgeResult(decision="duplicate", reason="same entity profile slot")

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="lived-shanghai",
            content="用户在 2024 年住在上海",
            created_at=BASE - timedelta(days=400),
            metadata=_metadata(
                source="history",
                valid_from=datetime(2024, 1, 1, tzinfo=UTC),
                valid_to=datetime(2024, 12, 31, tzinfo=UTC),
            ),
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="lives-beijing",
            content="用户现在住在北京",
            created_at=BASE,
            metadata=_metadata(source="current", valid_from=BASE),
            embedding=[0.6, 0.8],
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
            dedupe_judge=judge,
        ).propose(strategy="dedupe", tier="semantic")

    group = _dedupe_group(proposal)
    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert group["keepId"] == "lives-beijing"
    assert group["deleteIds"] == []
    assert proposal.to_wire_dict()["totalDelete"] == 0
    assert temporal["decision"] == "retain_historical"
    assert temporal["retained_ids"] == ["lived-shanghai"]


async def test_valid_to_expired_duplicate_is_marked_temporal_not_deleted() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="expired-name",
            content="用户叫老孟",
            created_at=BASE - timedelta(days=365),
            metadata=_metadata(
                source="old-profile",
                valid_from=datetime(2024, 1, 1, tzinfo=UTC),
                valid_to=datetime(2024, 6, 1, tzinfo=UTC),
            ),
        )
        await _store_semantic(
            store,
            memory_id="current-name",
            content="用户叫老孟",
            created_at=BASE,
            metadata=_metadata(source="current-profile", valid_from=BASE),
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
        ).propose(strategy="dedupe", tier="semantic", now=BASE)

    group = _dedupe_group(proposal)
    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert group["deleteIds"] == []
    assert temporal["decision"] == "retain_historical"
    assert temporal["retained_ids"] == ["expired-name"]


async def test_late_imported_expired_duplicate_does_not_replace_current_fact() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="current-name",
            content="用户叫老孟",
            created_at=BASE,
            metadata=_metadata(source="current-profile", valid_from=BASE),
        )
        await _store_semantic(
            store,
            memory_id="late-imported-expired-name",
            content="用户叫老孟",
            created_at=BASE + timedelta(days=1),
            metadata=_metadata(
                source="late-import",
                valid_from=datetime(2024, 1, 1, tzinfo=UTC),
                valid_to=datetime(2024, 6, 1, tzinfo=UTC),
            ),
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
        ).propose(strategy="dedupe", tier="semantic", now=BASE)

    group = _dedupe_group(proposal)
    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert group["keepId"] == "current-name"
    assert group["deleteIds"] == []
    assert temporal["decision"] == "retain_historical"
    assert temporal["retained_ids"] == ["late-imported-expired-name"]


async def test_bilingual_same_fact_without_temporal_conflict_still_dedupes() -> None:
    def judge(_left: MemoryItem, _right: MemoryItem, _score: float) -> DedupeJudgeResult:
        return DedupeJudgeResult(decision="duplicate", reason="中英文表达同一当前偏好")

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="pref-zh",
            content="用户喜欢 Vim 编辑器",
            created_at=BASE,
            metadata=_metadata(source="zh", valid_from=BASE),
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="pref-en",
            content="The user prefers the Vim editor",
            created_at=BASE + timedelta(minutes=1),
            metadata=_metadata(source="en", valid_from=BASE + timedelta(minutes=1)),
            embedding=[0.6, 0.8],
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
            dedupe_judge=judge,
        ).propose(strategy="dedupe", tier="semantic")

    group = _dedupe_group(proposal)
    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert group["keepId"] == "pref-en"
    assert group["deleteIds"] == ["pref-zh"]
    assert temporal["decision"] == "duplicate"


async def test_superseded_by_edge_metadata_is_attached_to_update_proposal() -> None:
    def judge(_left: MemoryItem, _right: MemoryItem, _score: float) -> DedupeJudgeResult:
        return DedupeJudgeResult(decision="supersedes", reason="profile slot was updated")

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="alias-v1",
            content="用户称呼是老孟",
            created_at=BASE,
            metadata=_metadata(source="source-a", valid_from=BASE, version=1),
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="alias-v2",
            content="用户称呼更新为孟哥",
            created_at=BASE + timedelta(minutes=5),
            metadata=_metadata(
                source="source-b",
                valid_from=BASE + timedelta(minutes=5),
                version=2,
            ),
            embedding=[0.6, 0.8],
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
            dedupe_judge=judge,
        ).propose(strategy="dedupe", tier="semantic")

    temporal = _dedupe_action(proposal).metadata["temporal"]
    edge = temporal["superseded_by_edges"][0]
    assert edge == {
        "from_id": "alias-v1",
        "to_id": "alias-v2",
        "predicate": "superseded_by",
        "valid_from": (BASE + timedelta(minutes=5)).isoformat(),
        "valid_to": None,
        "source_ids": ["alias-v1", "alias-v2"],
        "source_evidence": {
            "from_source": "source-a",
            "to_source": "source-b",
            "from_version": 1,
            "to_version": 2,
        },
    }


async def test_batch_supersedes_decision_emits_superseded_by_edges() -> None:
    def batch_judge(_records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(
            ok=True,
            clusters=(
                BatchJudgeCluster(
                    keep_id="batch-alias-v2",
                    delete_ids=("batch-alias-v1",),
                    reason="profile slot updated",
                    decision="supersedes",
                ),
            ),
        )

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="batch-alias-v1",
            content="用户称呼是老孟",
            created_at=BASE,
            metadata=_metadata(source="batch-a", valid_from=BASE, version=1),
        )
        await _store_semantic(
            store,
            memory_id="batch-alias-v2",
            content="用户称呼更新为孟哥",
            created_at=BASE + timedelta(minutes=5),
            metadata=_metadata(
                source="batch-b",
                valid_from=BASE + timedelta(minutes=5),
                version=2,
            ),
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
            batch_judge=batch_judge,
        ).propose(strategy="dedupe", tier="semantic")

    group = _dedupe_group(proposal)
    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert group["keepId"] == "batch-alias-v2"
    assert group["deleteIds"] == ["batch-alias-v1"]
    assert temporal["decision"] == "supersedes"
    assert temporal["superseded_by_edges"][0]["from_id"] == "batch-alias-v1"
    assert temporal["superseded_by_edges"][0]["to_id"] == "batch-alias-v2"


async def test_batch_supersedes_decision_survives_exact_match_group() -> None:
    def batch_judge(_records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(
            ok=True,
            clusters=(
                BatchJudgeCluster(
                    keep_id="exact-batch-v2",
                    delete_ids=("exact-batch-v1",),
                    reason="new version keeps same wording",
                    decision="supersedes",
                ),
            ),
        )

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="exact-batch-v1",
            content="用户称呼是孟哥",
            created_at=BASE,
            metadata=_metadata(source="exact-a", valid_from=BASE),
        )
        await _store_semantic(
            store,
            memory_id="exact-batch-v2",
            content="用户称呼是孟哥",
            created_at=BASE + timedelta(minutes=5),
            metadata=_metadata(source="exact-b", valid_from=BASE + timedelta(minutes=5)),
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
            batch_judge=batch_judge,
        ).propose(strategy="dedupe", tier="semantic")

    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert temporal["decision"] == "supersedes"
    assert temporal["superseded_by_edges"][0]["from_id"] == "exact-batch-v1"
    assert temporal["superseded_by_edges"][0]["to_id"] == "exact-batch-v2"


async def test_batch_supersedes_decision_survives_overlapping_duplicate_cluster() -> None:
    def batch_judge(_records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(
            ok=True,
            clusters=(
                BatchJudgeCluster(
                    keep_id="mixed-a",
                    delete_ids=("mixed-b",),
                    reason="same fact duplicate wording",
                    decision="duplicate",
                ),
                BatchJudgeCluster(
                    keep_id="mixed-c",
                    delete_ids=("mixed-b",),
                    reason="newer profile slot supersedes older wording",
                    decision="supersedes",
                ),
            ),
        )

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="mixed-a",
            content="用户称呼是老孟",
            created_at=BASE,
            metadata=_metadata(source="mixed-a", valid_from=BASE),
        )
        await _store_semantic(
            store,
            memory_id="mixed-b",
            content="用户之前叫老孟",
            created_at=BASE + timedelta(minutes=1),
            metadata=_metadata(source="mixed-b", valid_from=BASE + timedelta(minutes=1)),
        )
        await _store_semantic(
            store,
            memory_id="mixed-c",
            content="用户希望被称呼为孟哥",
            created_at=BASE + timedelta(minutes=2),
            metadata=_metadata(source="mixed-c", valid_from=BASE + timedelta(minutes=2)),
        )

        proposal = Consolidator(
            store=store,
            budget_provider=_granted_budget(),
            batch_judge=batch_judge,
        ).propose(strategy="dedupe", tier="semantic")

    temporal = _dedupe_action(proposal).metadata["temporal"]
    assert temporal["decision"] == "supersedes"
    assert temporal["superseded_by_edges"]
    assert {edge["to_id"] for edge in temporal["superseded_by_edges"]} == {"mixed-c"}


async def test_mcp_wire_shape_stays_unchanged_for_temporal_dedupe() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="wire-old",
            content="用户喜欢 Vim",
            created_at=BASE,
            metadata=_metadata(source="wire-old", valid_from=BASE),
        )
        await _store_semantic(
            store,
            memory_id="wire-new",
            content="用户喜欢 Vim",
            created_at=BASE + timedelta(minutes=1),
            metadata=_metadata(source="wire-new", valid_from=BASE + timedelta(minutes=1)),
        )
        server = create_server(store)

        result = await server.call_tool(  # type: ignore[attr-defined]
            "memory_consolidate_plan",
            {"tier": "semantic", "strategy": "dedupe"},
        )

    if hasattr(result, "root"):
        text = "\n".join(
            item.text
            for item in getattr(result.root, "content", [])  # type: ignore[attr-defined]
            if getattr(item, "type", None) == "text"
        )
    else:
        _content, metadata = result  # type: ignore[misc]
        text = metadata["result"]
    payload = __import__("json").loads(text)
    proposal = payload["proposals"][0]
    assert set(proposal) == {
        "kind",
        "tier",
        "keepId",
        "deleteIds",
        "reason",
        "strategy",
        "score",
        "memoryIds",
    }


def test_llm_prompts_include_temporal_version_and_source_evidence() -> None:
    left = MemoryItem(
        id="left",
        content="用户称呼是老孟",
        layer="semantic",
        metadata=_metadata(source="chat-a", valid_from=BASE, version=1),
        created_at=BASE,
    )
    right = MemoryItem(
        id="right",
        content="用户称呼更新为孟哥",
        layer="semantic",
        metadata=_metadata(
            source="chat-b",
            valid_from=BASE + timedelta(minutes=1),
            version=2,
            supersedes=["left"],
        ),
        created_at=BASE + timedelta(minutes=1),
    )

    pair_prompt = _DeepseekConsolidationJudge(api_key="test")._build_prompt(left, right, 0.6)
    system_prompt, user_prompt, _boundary = _DeepseekBatchJudge(api_key="test")._build_prompt(
        [left, right]
    )

    assert "valid_from" in pair_prompt
    assert "valid_to" in pair_prompt
    assert "version=1" in pair_prompt
    assert "source=chat-b" in pair_prompt
    assert "supersedes=['left']" in pair_prompt
    assert "valid_from" in system_prompt
    assert "source=chat-a" in user_prompt
    assert "version=2" in user_prompt
