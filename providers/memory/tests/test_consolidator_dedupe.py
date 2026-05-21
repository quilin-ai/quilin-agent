from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from quilin_mem.consolidator import (
    Consolidator,
    DedupeJudgeResult,
    DedupePlan,
    cosine_similarity,
)
from quilin_mem.idle_budget import IdleBudgetProvider
from quilin_mem.reflector import Reflector, ReflectorConfig
from quilin_mem.server import create_server
from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem

SEMANTIC_METADATA = {
    "schema_version": 1,
    "source": "dedupe_test",
    "stability_reason": "test fixture",
}


class StaticEmbeddingProvider:
    def __init__(self, embeddings: dict[str, list[float]]) -> None:
        self._embeddings = embeddings

    def embed_many(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embeddings[text] for text in texts]


def _dedupe_plan(store: QuilinMemStore, **kwargs: object):
    proposal = Consolidator(store=store, **kwargs).propose(strategy="dedupe", tier="semantic")
    assert proposal.actions
    groups = proposal.actions[0].metadata["dedupe_groups"]
    return proposal, groups


async def _store_semantic(
    store: QuilinMemStore,
    *,
    memory_id: str,
    content: str,
    created_at: datetime,
    embedding: list[float] | None = None,
) -> None:
    await store.add(
        MemoryItem(
            id=memory_id,
            content=content,
            layer="semantic",
            metadata=dict(SEMANTIC_METADATA),
            created_at=created_at,
            embedding=embedding,
        )
    )


def _decode_call_tool_result(result: object) -> dict[str, object]:
    if hasattr(result, "root"):
        content_items = getattr(result.root, "content", [])  # type: ignore[attr-defined]
        text = "\n".join(
            item.text for item in content_items if getattr(item, "type", None) == "text"
        )
        return json.loads(text)

    _content, metadata = result  # type: ignore[misc]
    return json.loads(metadata["result"])


async def test_dedupe_plan_groups_exact_duplicates_and_keeps_newest() -> None:
    base = datetime(2026, 5, 20, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="old",
            content="用户叫小明",
            created_at=base,
        )
        await _store_semantic(
            store,
            memory_id="new",
            content=" 用户叫小明 ",
            created_at=base + timedelta(minutes=1),
        )

        proposal, groups = _dedupe_plan(
            store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
        )

    assert proposal.to_wire_dict()["totalDelete"] == 1
    assert len(groups) == 1
    group = groups[0]  # type: ignore[index]
    assert group["strategy"] == "exact"
    assert group["keepId"] == "new"
    assert group["deleteIds"] == ["old"]
    assert "精确重复" in group["reason"]


async def test_dedupe_plan_groups_high_embedding_similarity_without_llm() -> None:
    base = datetime(2026, 5, 20, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="old-name",
            content="我是小明,是老孟的助手",
            created_at=base,
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="new-name",
            content="我是小花,也是孟哥的助手",
            created_at=base + timedelta(minutes=1),
            embedding=[0.99, 0.01],
        )

        proposal, groups = _dedupe_plan(
            store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
        )

    assert proposal.to_wire_dict()["totalDelete"] == 1
    group = groups[0]  # type: ignore[index]
    assert group["strategy"] == "embedding"
    assert group["keepId"] == "new-name"
    assert group["deleteIds"] == ["old-name"]
    assert group["score"] >= 0.85


async def test_dedupe_plan_does_not_transitively_merge_embedding_chain() -> None:
    base = datetime(2026, 5, 20, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="a",
            content="用户住在上海",
            created_at=base,
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="b",
            content="用户最近在华东城市工作",
            created_at=base + timedelta(minutes=1),
            embedding=[0.9, 0.43589],
        )
        await _store_semantic(
            store,
            memory_id="c",
            content="用户住在北京",
            created_at=base + timedelta(minutes=2),
            embedding=[0.62, 0.7846],
        )

        proposal, groups = _dedupe_plan(
            store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
        )

    assert proposal.to_wire_dict()["totalDelete"] == 1
    assert len(groups) == 1
    assert len(groups[0]["deleteIds"]) == 1  # type: ignore[index]


async def test_dedupe_plan_uses_llm_for_gray_zone_supersede() -> None:
    base = datetime(2026, 5, 20, tzinfo=UTC)
    calls: list[tuple[str, str, float]] = []

    def judge(left: MemoryItem, right: MemoryItem, score: float) -> DedupeJudgeResult:
        calls.append((left.id, right.id, score))
        return DedupeJudgeResult(
            decision="supersedes",
            reason="小明改名为小花,老孟和孟哥是同一用户称呼",
        )

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="alias-old",
            content="老孟叫我小明",
            created_at=base,
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="alias-new",
            content="孟哥现在叫我小花",
            created_at=base + timedelta(minutes=2),
            embedding=[0.6, 0.8],
        )

        _proposal, groups = _dedupe_plan(
            store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            dedupe_judge=judge,
        )

    assert len(calls) == 1
    assert 0.5 <= calls[0][2] < 0.85
    group = groups[0]  # type: ignore[index]
    assert group["strategy"] == "llm"
    assert group["keepId"] == "alias-new"
    assert group["deleteIds"] == ["alias-old"]
    assert "小明改名为小花" in group["reason"]


async def test_dedupe_plan_skips_distinct_gray_zone_pairs() -> None:
    def judge(_left: MemoryItem, _right: MemoryItem, _score: float) -> DedupeJudgeResult:
        return DedupeJudgeResult(decision="distinct", reason="different facts")

    base = datetime(2026, 5, 20, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="a",
            content="用户喜欢 Vim",
            created_at=base,
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="b",
            content="用户住在上海",
            created_at=base + timedelta(minutes=1),
            embedding=[0.6, 0.8],
        )

        proposal = Consolidator(store=store, dedupe_judge=judge).propose(
            strategy="dedupe",
            tier="semantic",
        )

    assert proposal.to_wire_dict()["totalDelete"] == 0
    assert proposal.actions == []


async def test_dedupe_plan_skips_soft_judge_when_budget_denied() -> None:
    calls: list[tuple[str, str, float]] = []

    def judge(left: MemoryItem, right: MemoryItem, score: float) -> DedupeJudgeResult:
        calls.append((left.id, right.id, score))
        return DedupeJudgeResult(decision="duplicate", reason="should not run")

    base = datetime(2026, 5, 20, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="a",
            content="用户喜欢 Vim",
            created_at=base,
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="b",
            content="用户住在上海",
            created_at=base + timedelta(minutes=1),
            embedding=[0.6, 0.8],
        )

        proposal = Consolidator(
            IdleBudgetProvider(enabled=True, token_budget=0),
            store=store,
            dedupe_judge=judge,
        ).propose(strategy="dedupe", tier="semantic", estimated_tokens=1)

    assert calls == []
    assert proposal.actions == []


async def test_memory_consolidate_plan_tool_returns_preview_only() -> None:
    base = datetime(2026, 5, 20, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="mcp-old",
            content="用户叫小明",
            created_at=base,
        )
        await _store_semantic(
            store,
            memory_id="mcp-new",
            content="用户叫小明",
            created_at=base + timedelta(minutes=1),
        )
        server = create_server(store)

        result = _decode_call_tool_result(
            await server.call_tool(  # type: ignore[attr-defined]
                "memory_consolidate_plan",
                {"tier": "semantic", "strategy": "dedupe"},
            )
        )
        still_present = await store.get("mcp-old")

    assert result["totalDelete"] == 1
    proposals = result["proposals"]
    assert proposals[0]["keepId"] == "mcp-new"  # type: ignore[index]
    assert proposals[0]["deleteIds"] == ["mcp-old"]  # type: ignore[index]
    assert still_present is not None


def test_cosine_similarity_rejects_mismatched_vectors() -> None:
    assert cosine_similarity([1.0, 0.0], [1.0]) == 0.0
    assert cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0


def test_empty_dedupe_plan_wire_shape() -> None:
    assert DedupePlan(groups=(), total_delete=0, total_keep=0).to_wire_dict() == {
        "groups": [],
        "totalDelete": 0,
        "totalKeep": 0,
    }


def test_dedupe_strategy_without_store_returns_empty_preview() -> None:
    proposal = Consolidator().propose(strategy="dedupe")

    assert proposal.actions == []
    assert proposal.to_wire_dict()["totalDelete"] == 0


async def test_reflect_strategy_with_empty_store_returns_no_reflections() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        proposal = Consolidator(store=store).propose(strategy="reflect")

    assert proposal.reflections == ()


async def test_cross_tier_fetch_only_returns_current_visible_records() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        old = await store.store(
            "Old visible fact",
            tier="semantic",
            metadata=dict(SEMANTIC_METADATA),
        )
        await store.supersede_memory(
            old.id,
            MemoryItem(
                id="latest-visible",
                content="Latest visible fact",
                layer="semantic",
                metadata=dict(SEMANTIC_METADATA),
                created_at=old.created_at + timedelta(minutes=1),
            ),
        )
        expired = await store.store("Expired hidden fact", tier="working")
        store._conn.execute(  # type: ignore[attr-defined]
            "UPDATE memory_records SET forget_after = ? WHERE id = ?",
            ((datetime.now(UTC) - timedelta(days=1)).isoformat(), expired.id),
        )

        records = Consolidator(store=store)._fetch_all_active_records()

    assert [record.id for record in records] == ["latest-visible"]


async def test_reflect_strategy_uses_store_episodic_records_when_budget_allows() -> None:
    base = datetime(2026, 5, 20, tzinfo=UTC)
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)
    async with QuilinMemStore(db_path=":memory:") as store:
        for idx in range(4):
            await store.add(
                MemoryItem(
                    id=f"ep-{idx}",
                    content=(
                        f"Reflection store record {idx} carries recurring docs evidence "
                        f"approval traces implementation review signal {idx}."
                    ),
                    layer="episodic",
                    metadata={"schema_version": 1, "source": "test"},
                    created_at=base + timedelta(minutes=idx),
                )
            )

        proposal = Consolidator(
            budget,
            store=store,
            reflector=Reflector(ReflectorConfig(min_info_gain_score=0.1)),
        ).propose(
            strategy="reflect",
            estimated_tokens=100,
        )

    assert len(proposal.reflections) == 1


async def test_reflect_strategy_wire_contains_only_real_reflector_output() -> None:
    base = datetime(2026, 5, 20, tzinfo=UTC)
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)
    async with QuilinMemStore(db_path=":memory:") as store:
        for idx in range(4):
            await store.add(
                MemoryItem(
                    id=f"real-reflect-{idx}",
                    content=(
                        f"Real reflector evidence {idx} repeats review approval context "
                        f"and implementation trace details for insight {idx}."
                    ),
                    layer="episodic",
                    metadata={"schema_version": 1, "source": "observer"},
                    created_at=base + timedelta(minutes=idx),
                )
            )

        proposal = Consolidator(
            budget,
            store=store,
            reflector=Reflector(ReflectorConfig(min_info_gain_score=0.1)),
        ).propose(strategy="reflect", estimated_tokens=100)

    payload = proposal.to_wire_dict()
    reflect_items = [item for item in payload["proposals"] if item["kind"] == "reflect-insight"]

    assert proposal.actions == []
    assert len(reflect_items) == 1
    assert reflect_items[0]["memoryIds"] == [
        "real-reflect-0",
        "real-reflect-1",
        "real-reflect-2",
        "real-reflect-3",
    ]
    assert "insertContent" in reflect_items[0]


def test_kg_prune_strategy_without_concrete_candidates_returns_no_stub() -> None:
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)

    proposal = Consolidator(budget).propose(strategy="kg-prune", estimated_tokens=100)

    assert proposal.actions == []
    assert proposal.to_wire_dict()["proposals"] == []
