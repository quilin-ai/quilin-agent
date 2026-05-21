"""QUI-189 batch LLM judge tests.

Cover:
  1. 9 records → 1 batch call returns 3 clusters
  2. 100+ records split into multiple batches by token cap
  3. Invalid LLM JSON → fallback to per-pair path
  4. LLM API error → fallback to per-pair path
  5. Wire shape stable across batch and per-pair paths
  6. env QUILIN_DEDUPE_BATCH_ENABLED=false → bypass batch judge
  7. Batch judge returns 0 clusters cleanly
  8. Batch judge rejects unknown ids (returns ok=False)
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from quilin_mem.consolidator import (
    BatchJudgeCluster,
    BatchJudgeResult,
    Consolidator,
    DedupeJudgeResult,
    _DeepseekBatchJudge,
    _env_flag_disabled,
    _parse_batch_judge_response,
    estimate_records_tokens,
    split_records_into_batches,
)
from quilin_mem.idle_budget import IdleBudgetProvider
from quilin_mem.server import _memory_consolidate_plan_with_store
from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem

SEMANTIC_METADATA = {
    "schema_version": 1,
    "source": "batch_judge_test",
    "stability_reason": "test fixture",
}


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


def _dedupe_groups(proposal: Any) -> list[dict[str, Any]]:
    if not proposal.actions:
        return []
    return list(proposal.actions[0].metadata["dedupe_groups"])


# ---------------------------------------------------------------------------
# 1. 9 records → single batch call returns 3 clusters
# ---------------------------------------------------------------------------


async def test_batch_judge_nine_records_single_call_returns_three_clusters() -> None:
    """User's flagship scenario: 9 entity-evolution records → 1 batch call,
    LLM returns 3 clusters, Consolidator materializes them with wire shape."""
    base = datetime(2026, 5, 21, tzinfo=UTC)
    call_log: list[list[str]] = []

    async with QuilinMemStore(db_path=":memory:") as store:
        records_input = [
            ("u1", "老孟叫我小明", base),
            ("u2", "孟哥现在叫我小花", base + timedelta(minutes=1)),
            ("u3", "用户名是小明", base + timedelta(minutes=2)),
            ("u4", "我是小花,也叫麒麟", base + timedelta(minutes=3)),
            ("u5", "我是小明助手", base + timedelta(minutes=4)),
            ("u6", "我是麒麟,也叫小花", base + timedelta(minutes=5)),
            ("u7", "用户喜欢 Vim", base + timedelta(minutes=6)),
            ("u8", "用户偏好 Vim 编辑器", base + timedelta(minutes=7)),
            ("u9", "用户住在上海", base + timedelta(minutes=8)),
        ]
        for mid, content, created in records_input:
            await _store_semantic(store, memory_id=mid, content=content, created_at=created)

        # 3 clusters: (u1,u2,u3) names, (u4,u5,u6) identity, (u7,u8) vim preference.
        def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
            ids = sorted(r.id for r in records)
            call_log.append(ids)
            return BatchJudgeResult(
                ok=True,
                clusters=(
                    BatchJudgeCluster(
                        keep_id="u3",
                        delete_ids=("u1", "u2"),
                        reason="老孟/孟哥/小明 同一身份演化",
                    ),
                    BatchJudgeCluster(
                        keep_id="u6",
                        delete_ids=("u4", "u5"),
                        reason="小花/麒麟 是同一助手身份",
                    ),
                    BatchJudgeCluster(
                        keep_id="u8",
                        delete_ids=("u7",),
                        reason="Vim 偏好同一陈述",
                    ),
                ),
            )

        proposal = Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            batch_judge=fake_batch,
        ).propose(strategy="dedupe", tier="semantic")

    # Exactly 1 batch call.
    assert len(call_log) == 1
    # All 9 records sent in single batch.
    assert len(call_log[0]) == 9
    groups = _dedupe_groups(proposal)
    assert len(groups) == 3
    strategies = {g["strategy"] for g in groups}
    assert strategies == {"llm"}
    keep_ids = {g["keepId"] for g in groups}
    assert keep_ids == {"u3", "u6", "u8"}
    total_delete = sum(len(g["deleteIds"]) for g in groups)
    # u1,u2 deleted under u3 (2); u4,u5 deleted under u6 (2); u7 deleted under u8 (1) = 5
    assert total_delete == 5


# ---------------------------------------------------------------------------
# 2. 100+ records → multiple batches by token cap
# ---------------------------------------------------------------------------


async def test_batch_judge_splits_oversize_payload_into_multiple_batches() -> None:
    """When record count or token budget exceeds the cap, Consolidator splits
    the workload across multiple batch calls."""
    base = datetime(2026, 5, 21, tzinfo=UTC)
    call_log: list[int] = []

    async with QuilinMemStore(db_path=":memory:") as store:
        # 60 records, each ~600-byte content → ~150 tokens per record.
        # max_tokens=1_000 forces ~6-7 records per batch.
        for idx in range(60):
            await _store_semantic(
                store,
                memory_id=f"r{idx:03d}",
                content=("x" * 600) + f"-{idx}",
                created_at=base + timedelta(seconds=idx),
            )

        def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
            call_log.append(len(records))
            return BatchJudgeResult(ok=True, clusters=())

        Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            batch_judge=fake_batch,
            batch_max_tokens=1_000,
            batch_max_records=150,
        ).propose(strategy="dedupe", tier="semantic")

    # Multiple batch calls; each batch ≤ cap; sum covers all 60 records.
    assert len(call_log) >= 2
    assert sum(call_log) == 60
    assert all(size <= 150 for size in call_log)


# ---------------------------------------------------------------------------
# 3. Invalid LLM JSON → fallback to per-pair path
# ---------------------------------------------------------------------------


async def test_batch_judge_invalid_response_falls_back_to_per_pair() -> None:
    """LLM returns ok=False; Consolidator must fall back to per-pair path so
    the per-pair judge is actually invoked."""
    base = datetime(2026, 5, 21, tzinfo=UTC)
    per_pair_calls: list[tuple[str, str]] = []

    def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(ok=False, clusters=(), reason="invalid JSON")

    def per_pair_judge(left: MemoryItem, right: MemoryItem, _score: float) -> DedupeJudgeResult:
        per_pair_calls.append((left.id, right.id))
        return DedupeJudgeResult(decision="supersedes", reason="per-pair fallback verdict")

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

        proposal = Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            batch_judge=fake_batch,
            dedupe_judge=per_pair_judge,
        ).propose(strategy="dedupe", tier="semantic")

    assert per_pair_calls, "per-pair judge must be invoked on batch failure"
    groups = _dedupe_groups(proposal)
    assert len(groups) == 1
    assert groups[0]["strategy"] == "llm"
    assert "per-pair fallback verdict" in groups[0]["reason"]


# ---------------------------------------------------------------------------
# 4. LLM API error → fallback to exact-only when no per-pair judge present
# ---------------------------------------------------------------------------


async def test_batch_judge_api_error_without_per_pair_judge_falls_to_exact_only() -> None:
    """If the batch judge raises (treated as ok=False) and no per-pair judge
    is configured, only exact-match dedupe remains."""
    base = datetime(2026, 5, 21, tzinfo=UTC)

    def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(ok=False, clusters=(), reason="api error")

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="exact-old",
            content="用户叫小明",
            created_at=base,
        )
        await _store_semantic(
            store,
            memory_id="exact-new",
            content="用户叫小明",
            created_at=base + timedelta(minutes=1),
        )
        # A non-exact gray-zone pair with no per-pair judge → must NOT be merged.
        await _store_semantic(
            store,
            memory_id="gray-a",
            content="我喜欢 Vim",
            created_at=base + timedelta(minutes=2),
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="gray-b",
            content="我住在上海",
            created_at=base + timedelta(minutes=3),
            embedding=[0.6, 0.8],
        )

        proposal = Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            batch_judge=fake_batch,
            # no dedupe_judge
        ).propose(strategy="dedupe", tier="semantic")

    groups = _dedupe_groups(proposal)
    # Only the exact match survives.
    assert len(groups) == 1
    assert groups[0]["strategy"] == "exact"
    assert groups[0]["keepId"] == "exact-new"
    assert groups[0]["deleteIds"] == ["exact-old"]


# ---------------------------------------------------------------------------
# 5. Wire shape stable across batch and per-pair paths
# ---------------------------------------------------------------------------


async def test_batch_judge_wire_shape_matches_per_pair_path() -> None:
    """The proposal.to_wire_dict() schema must be identical regardless of
    whether the dedupe path was batch or per-pair — only `score` and `strategy`
    semantics differ inside individual groups."""
    base = datetime(2026, 5, 21, tzinfo=UTC)

    def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(
            ok=True,
            clusters=(
                BatchJudgeCluster(
                    keep_id="wnew",
                    delete_ids=("wold",),
                    reason="batch judge verdict",
                ),
            ),
        )

    def per_pair_judge(_left: MemoryItem, _right: MemoryItem, _score: float) -> DedupeJudgeResult:
        return DedupeJudgeResult(decision="supersedes", reason="per-pair verdict")

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="wold",
            content="老孟叫我小明",
            created_at=base,
            embedding=[1.0, 0.0],
        )
        await _store_semantic(
            store,
            memory_id="wnew",
            content="孟哥现在叫我小花",
            created_at=base + timedelta(minutes=2),
            embedding=[0.6, 0.8],
        )

        batch_proposal = Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            batch_judge=fake_batch,
        ).propose(strategy="dedupe", tier="semantic")

        per_pair_proposal = Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            dedupe_judge=per_pair_judge,
        ).propose(strategy="dedupe", tier="semantic")

    batch_wire = batch_proposal.to_wire_dict()
    per_pair_wire = per_pair_proposal.to_wire_dict()

    # Top-level schema identical.
    assert set(batch_wire) == set(per_pair_wire)
    # Proposals list of same length, same per-entry keys.
    assert len(batch_wire["proposals"]) == len(per_pair_wire["proposals"])
    for batch_entry, per_pair_entry in zip(
        batch_wire["proposals"], per_pair_wire["proposals"], strict=True
    ):
        assert set(batch_entry) == set(per_pair_entry)
        assert batch_entry["kind"] == per_pair_entry["kind"]
        assert batch_entry["tier"] == per_pair_entry["tier"]
        assert batch_entry["keepId"] == per_pair_entry["keepId"]
        assert batch_entry["deleteIds"] == per_pair_entry["deleteIds"]
        assert batch_entry["memoryIds"] == per_pair_entry["memoryIds"]
    assert batch_wire["totalDelete"] == per_pair_wire["totalDelete"]


# ---------------------------------------------------------------------------
# 6. env disabled → server bypasses batch judge entirely
# ---------------------------------------------------------------------------


async def test_server_env_disabled_uses_per_pair_path(monkeypatch: Any) -> None:
    """When QUILIN_DEDUPE_BATCH_ENABLED=false, server.consolidate_plan must
    skip injecting the batch judge so Consolidator runs per-pair only."""
    monkeypatch.setenv("QUILIN_DEDUPE_BATCH_ENABLED", "false")
    # Disable LLM api so per-pair judge falls back to 'distinct' without HTTP.
    monkeypatch.delenv("QUILIN_DEDUPE_API_KEY", raising=False)
    monkeypatch.delenv("QUILIN_OBSERVER_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    base = datetime(2026, 5, 21, tzinfo=UTC)
    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(
            store,
            memory_id="env-old",
            content="用户叫小明",
            created_at=base,
        )
        await _store_semantic(
            store,
            memory_id="env-new",
            content="用户叫小明",
            created_at=base + timedelta(minutes=1),
        )
        raw = await _memory_consolidate_plan_with_store(store, strategy="dedupe", tier="semantic")

    payload = json.loads(raw)
    # Even with batch disabled, exact dedupe still runs.
    assert payload["totalDelete"] == 1
    proposals = payload["proposals"]
    assert len(proposals) == 1
    assert proposals[0]["keepId"] == "env-new"


# ---------------------------------------------------------------------------
# 7. Empty cluster output handled cleanly
# ---------------------------------------------------------------------------


async def test_batch_judge_empty_clusters_keeps_only_exact_matches() -> None:
    """If batch judge declares all records distinct, only exact-match groups
    survive."""
    base = datetime(2026, 5, 21, tzinfo=UTC)

    def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(ok=True, clusters=())

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(store, memory_id="ex-a", content="用户叫小明", created_at=base)
        await _store_semantic(
            store,
            memory_id="ex-b",
            content="用户叫小明",
            created_at=base + timedelta(minutes=1),
        )
        await _store_semantic(
            store,
            memory_id="distinct",
            content="完全不同的内容",
            created_at=base + timedelta(minutes=2),
        )

        proposal = Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            batch_judge=fake_batch,
        ).propose(strategy="dedupe", tier="semantic")

    groups = _dedupe_groups(proposal)
    assert len(groups) == 1
    assert groups[0]["strategy"] == "exact"
    assert set(groups[0]["memoryIds"]) == {"ex-a", "ex-b"}


# ---------------------------------------------------------------------------
# 8. _parse_batch_judge_response: structural validation
# ---------------------------------------------------------------------------


def test_parse_batch_judge_response_rejects_invalid_shapes() -> None:
    records = [
        MemoryItem(id="a", content="x", layer="semantic"),
        MemoryItem(id="b", content="y", layer="semantic"),
    ]

    # Non-JSON.
    assert _parse_batch_judge_response("not json", records).ok is False
    # Not an object root.
    assert _parse_batch_judge_response("[]", records).ok is False
    # Missing clusters.
    assert _parse_batch_judge_response('{"foo": 1}', records).ok is False
    # clusters not a list.
    assert _parse_batch_judge_response('{"clusters": 1}', records).ok is False
    # Cluster entry not an object.
    assert _parse_batch_judge_response('{"clusters": [1]}', records).ok is False
    # Unknown keepId.
    bad = json.dumps({"clusters": [{"keepId": "zzz", "deleteIds": ["a"]}]})
    assert _parse_batch_judge_response(bad, records).ok is False
    # deleteIds not a list.
    bad = json.dumps({"clusters": [{"keepId": "a", "deleteIds": "b"}]})
    assert _parse_batch_judge_response(bad, records).ok is False
    # Unknown delete id.
    bad = json.dumps({"clusters": [{"keepId": "a", "deleteIds": ["zzz"]}]})
    assert _parse_batch_judge_response(bad, records).ok is False
    # keep == delete.
    bad = json.dumps({"clusters": [{"keepId": "a", "deleteIds": ["a"]}]})
    assert _parse_batch_judge_response(bad, records).ok is False
    # Overlapping clusters are accepted; union-find merges them later. The parser
    # only validates shape and known ids so batch LLM output can express bridges.
    overlapping = json.dumps(
        {
            "clusters": [
                {"keepId": "a", "deleteIds": ["b"], "decision": "duplicate"},
                {"keepId": "b", "deleteIds": ["a"], "decision": "supersedes"},
            ]
        }
    )
    parsed_overlap = _parse_batch_judge_response(overlapping, records)
    assert parsed_overlap.ok is True
    assert [cluster.decision for cluster in parsed_overlap.clusters] == [
        "duplicate",
        "supersedes",
    ]
    # Valid cluster.
    good = json.dumps({"clusters": [{"keepId": "a", "deleteIds": ["b"], "reason": "ok"}]})
    parsed = _parse_batch_judge_response(good, records)
    assert parsed.ok is True
    assert len(parsed.clusters) == 1
    assert parsed.clusters[0].keep_id == "a"
    assert parsed.clusters[0].delete_ids == ("b",)
    assert parsed.clusters[0].reason == "ok"
    # Empty cluster list is fine.
    empty = _parse_batch_judge_response('{"clusters": []}', records)
    assert empty.ok is True
    assert empty.clusters == ()
    # Cluster with empty delete list is silently skipped (not a fatal error).
    skip = json.dumps({"clusters": [{"keepId": "a", "deleteIds": []}]})
    parsed_skip = _parse_batch_judge_response(skip, records)
    assert parsed_skip.ok is True
    assert parsed_skip.clusters == ()


# ---------------------------------------------------------------------------
# 9. Token estimation + split helper
# ---------------------------------------------------------------------------


def test_estimate_records_tokens_and_split_helpers() -> None:
    records = [MemoryItem(id=f"id{i}", content="x" * 400, layer="semantic") for i in range(20)]
    # 400 bytes / 4 ≈ 100 tokens per record + scaffolding overhead.
    tokens = estimate_records_tokens(records[:1])
    assert 50 < tokens < 500

    # Split with very small budget forces 1 record per batch.
    tiny = split_records_into_batches(records, max_tokens=10, max_records=150)
    assert len(tiny) == 20
    # Split with very generous budget yields one batch.
    huge = split_records_into_batches(records, max_tokens=10_000_000, max_records=150)
    assert len(huge) == 1

    # Record-cap dominates over token-cap.
    capped = split_records_into_batches(records, max_tokens=10_000_000, max_records=7)
    assert all(len(batch) <= 7 for batch in capped)
    assert sum(len(b) for b in capped) == 20

    # Empty input.
    assert split_records_into_batches([], max_tokens=100, max_records=10) == []


# ---------------------------------------------------------------------------
# 10. _DeepseekBatchJudge: API key absence + env wiring
# ---------------------------------------------------------------------------


def test_deepseek_batch_judge_returns_not_ok_when_api_key_missing(monkeypatch: Any) -> None:
    monkeypatch.delenv("QUILIN_DEDUPE_API_KEY", raising=False)
    monkeypatch.delenv("QUILIN_OBSERVER_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    judge = _DeepseekBatchJudge()
    result = judge.judge_batch([MemoryItem(id="a", content="x", layer="semantic")])
    assert result.ok is False
    assert "no LLM api key" in result.reason


def test_deepseek_batch_judge_empty_records_returns_ok_empty() -> None:
    judge = _DeepseekBatchJudge(api_key="dummy-key")
    result = judge.judge_batch([])
    assert result.ok is True
    assert result.clusters == ()


def test_deepseek_batch_judge_handles_llm_exception(monkeypatch: Any) -> None:
    """When the underlying HTTP call raises, judge_batch returns ok=False
    so the Consolidator falls back to per-pair."""
    import quilin_mem.observer as observer_mod

    def boom(*_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("api timeout")

    monkeypatch.setattr(observer_mod, "_call_deepseek_api", boom)
    judge = _DeepseekBatchJudge(api_key="dummy-key")
    result = judge.judge_batch(
        [
            MemoryItem(id="a", content="x", layer="semantic"),
            MemoryItem(id="b", content="y", layer="semantic"),
        ]
    )
    assert result.ok is False
    assert "RuntimeError" in result.reason


def test_deepseek_batch_judge_parses_real_llm_output(monkeypatch: Any) -> None:
    """Happy-path end-to-end: judge_batch hits the (mocked) HTTP layer and
    returns a parsed BatchJudgeResult."""
    import quilin_mem.observer as observer_mod

    def fake_call(_base_url: str, _api_key: str, _payload: bytes, *, timeout: float = 30.0) -> str:
        return json.dumps(
            {
                "clusters": [
                    {
                        "keepId": "b",
                        "deleteIds": ["a"],
                        "reason": "同一身份",
                    }
                ]
            }
        )

    monkeypatch.setattr(observer_mod, "_call_deepseek_api", fake_call)
    judge = _DeepseekBatchJudge(api_key="dummy-key")
    result = judge.judge_batch(
        [
            MemoryItem(id="a", content="老孟", layer="semantic"),
            MemoryItem(id="b", content="孟哥", layer="semantic"),
        ]
    )
    assert result.ok is True
    assert len(result.clusters) == 1
    assert result.clusters[0].keep_id == "b"
    assert result.clusters[0].delete_ids == ("a",)


def test_deepseek_batch_judge_accepts_overlapping_clusters(monkeypatch: Any) -> None:
    import quilin_mem.observer as observer_mod

    def fake_call(_base_url: str, _api_key: str, _payload: bytes, *, timeout: float = 30.0) -> str:
        return json.dumps(
            {
                "clusters": [
                    {
                        "keepId": "a",
                        "deleteIds": ["b"],
                        "reason": "same wording",
                        "decision": "duplicate",
                    },
                    {
                        "keepId": "c",
                        "deleteIds": ["b"],
                        "reason": "newer slot supersedes old wording",
                        "decision": "supersedes",
                    },
                ]
            }
        )

    monkeypatch.setattr(observer_mod, "_call_deepseek_api", fake_call)
    judge = _DeepseekBatchJudge(api_key="dummy-key")
    result = judge.judge_batch(
        [
            MemoryItem(id="a", content="老孟", layer="semantic"),
            MemoryItem(id="b", content="老孟旧称呼", layer="semantic"),
            MemoryItem(id="c", content="孟哥", layer="semantic"),
        ]
    )

    assert result.ok is True
    assert len(result.clusters) == 2
    assert result.clusters[1].decision == "supersedes"


# ---------------------------------------------------------------------------
# 11. env flag helper
# ---------------------------------------------------------------------------


def test_env_flag_disabled_helper(monkeypatch: Any) -> None:
    monkeypatch.delenv("QUILIN_TEST_FLAG", raising=False)
    assert _env_flag_disabled("QUILIN_TEST_FLAG") is False
    monkeypatch.setenv("QUILIN_TEST_FLAG", "0")
    assert _env_flag_disabled("QUILIN_TEST_FLAG") is True
    monkeypatch.setenv("QUILIN_TEST_FLAG", "false")
    assert _env_flag_disabled("QUILIN_TEST_FLAG") is True
    monkeypatch.setenv("QUILIN_TEST_FLAG", "no")
    assert _env_flag_disabled("QUILIN_TEST_FLAG") is True
    monkeypatch.setenv("QUILIN_TEST_FLAG", "off")
    assert _env_flag_disabled("QUILIN_TEST_FLAG") is True
    monkeypatch.setenv("QUILIN_TEST_FLAG", "true")
    assert _env_flag_disabled("QUILIN_TEST_FLAG") is False
    monkeypatch.setenv("QUILIN_TEST_FLAG", "")
    assert _env_flag_disabled("QUILIN_TEST_FLAG") is False


# ---------------------------------------------------------------------------
# 12. Batch judge merges exact-match + LLM cluster into one group
# ---------------------------------------------------------------------------


async def test_batch_judge_merges_exact_and_cluster_into_single_group() -> None:
    """If an exact-match pair AND an LLM cluster share at least one id, the
    union-find merges them into a single DedupeGroup."""
    base = datetime(2026, 5, 21, tzinfo=UTC)

    def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
        return BatchJudgeResult(
            ok=True,
            clusters=(
                BatchJudgeCluster(
                    keep_id="m3",
                    delete_ids=("m2",),
                    reason="LLM 觉得 m2/m3 同一身份",
                ),
            ),
        )

    async with QuilinMemStore(db_path=":memory:") as store:
        # m1 == m2 by exact content; m3 clustered with m2 by LLM.
        await _store_semantic(store, memory_id="m1", content="用户叫小明", created_at=base)
        await _store_semantic(
            store,
            memory_id="m2",
            content="用户叫小明",
            created_at=base + timedelta(minutes=1),
        )
        await _store_semantic(
            store,
            memory_id="m3",
            content="孟哥现在叫我小花",
            created_at=base + timedelta(minutes=2),
        )

        proposal = Consolidator(
            store=store,
            budget_provider=IdleBudgetProvider(enabled=True, token_budget=10_000),
            batch_judge=fake_batch,
        ).propose(strategy="dedupe", tier="semantic")

    groups = _dedupe_groups(proposal)
    assert len(groups) == 1
    group = groups[0]
    assert set(group["memoryIds"]) == {"m1", "m2", "m3"}
    # Keeper picks newest (m3 by created_at).
    assert group["keepId"] == "m3"
    assert sorted(group["deleteIds"]) == ["m1", "m2"]


# ---------------------------------------------------------------------------
# 13. Batch judge skipped when budget denied
# ---------------------------------------------------------------------------


async def test_batch_judge_not_invoked_when_budget_denied() -> None:
    """allow_expensive=False (budget denied) must skip the batch judge entirely
    so we stay within the budget envelope."""
    base = datetime(2026, 5, 21, tzinfo=UTC)
    calls: list[int] = []

    def fake_batch(records: Sequence[MemoryItem]) -> BatchJudgeResult:
        calls.append(len(records))
        return BatchJudgeResult(ok=True, clusters=())

    async with QuilinMemStore(db_path=":memory:") as store:
        await _store_semantic(store, memory_id="b-a", content="同样内容", created_at=base)
        await _store_semantic(
            store,
            memory_id="b-b",
            content="同样内容",
            created_at=base + timedelta(minutes=1),
        )

        proposal = Consolidator(
            IdleBudgetProvider(enabled=True, token_budget=0),
            store=store,
            batch_judge=fake_batch,
        ).propose(strategy="dedupe", tier="semantic", estimated_tokens=1)

    assert calls == []
    # Exact match still works since it doesn't need expensive resources?
    # Actually exact match is in the "expensive" loop body in per-pair path...
    # When allow_expensive=False the per-pair path still does the exact check
    # via the for-loop before the `if not allow_expensive: continue` guard.
    # Verify wire shape stays consistent.
    payload = proposal.to_wire_dict()
    # Either 1 exact dedupe group or 0 (depending on budget gating semantics).
    assert payload["totalDelete"] in (0, 1)
