from __future__ import annotations

import contextlib
from datetime import UTC, datetime
from typing import Any

from quilin_mem.reflector import (
    DEFAULT_REFLECT_MODEL,
    REFLECT_MODEL_ENV,
    ReflectionProposal,
    Reflector,
    ReflectorConfig,
    propose_reflection,
)
from quilin_mem.store import QuilinMemStore
from quilin_mem.types import MemoryItem


def _episodic(memory_id: str, content: str) -> MemoryItem:
    return MemoryItem(
        id=memory_id,
        content=content,
        layer="episodic",
        metadata={"schema_version": 1, "source": "test"},
    )


def test_low_information_records_do_not_produce_proposal() -> None:
    records = [
        _episodic("ep-1", "ok"),
        _episodic("ep-2", "ok"),
        _episodic("ep-3", "ok"),
    ]

    proposals = Reflector().propose(records)

    assert proposals == []


def test_too_few_records_do_not_produce_proposal() -> None:
    records = [
        _episodic("ep-1", "Detailed reflection evidence one."),
        _episodic("ep-2", "Detailed reflection evidence two."),
    ]

    proposals = Reflector().propose(records)

    assert proposals == []


def test_enough_episodic_records_produce_structured_approval_proposal() -> None:
    now = datetime(2026, 5, 20, tzinfo=UTC)
    records = [
        _episodic(
            "ep-1",
            "Planning succeeded after comparing current docs with implementation evidence.",
        ),
        _episodic(
            "ep-2",
            "Implementation stayed reliable when tests were scoped to the changed memory module.",
        ),
        _episodic(
            "ep-3",
            "Review found that evidence-first planning reduced integration mistakes.",
        ),
        _episodic(
            "ep-4",
            "Failure was avoided by keeping proposal writes separate from semantic storage.",
        ),
    ]

    proposals = Reflector().propose(records, task_outcome="success", now=now)

    assert len(proposals) == 1
    proposal = proposals[0]
    assert proposal.kind == "reflection_insight"
    assert proposal.sourceIds == ["ep-1", "ep-2", "ep-3", "ep-4"]
    assert proposal.proposedContent
    assert proposal.reason
    assert proposal.confidence >= 0.55
    assert proposal.requiresApproval is True
    assert proposal.created_at == now


def test_llm_caller_can_be_injected_without_network() -> None:
    calls: list[dict[str, Any]] = []

    def fake_llm(
        *,
        model: str,
        episodic_summaries: list[str],
        task_outcome: str,
    ) -> dict[str, object]:
        calls.append(
            {
                "model": model,
                "episodic_summaries": episodic_summaries,
                "task_outcome": task_outcome,
            }
        )
        return {
            "proposedContent": "When memory work is narrow, keep output as approval proposals.",
            "reason": "LLM distilled recurring memory implementation pattern.",
            "confidence": 0.87,
        }

    records = [
        _episodic(
            "ep-1",
            "Memory reflection gathered evidence, compared traces, and proposed approval insight.",
        ),
        _episodic(
            "ep-2",
            (
                "Memory reflection avoided semantic writes and kept approval insight "
                "boundaries explicit."
            ),
        ),
        _episodic(
            "ep-3",
            "Memory reflection compared traces again before proposing approval insight updates.",
        ),
        _episodic(
            "ep-4",
            (
                "Memory reflection found recurring approval insight evidence across "
                "semantic proposals."
            ),
        ),
    ]

    proposals = Reflector(llm_caller=fake_llm).propose(records, task_outcome="failure")

    assert len(calls) == 1
    assert calls[0]["model"] == DEFAULT_REFLECT_MODEL
    assert calls[0]["task_outcome"] == "failure"
    assert len(calls[0]["episodic_summaries"]) == 4
    assert proposals[0].proposedContent == (
        "When memory work is narrow, keep output as approval proposals."
    )
    assert proposals[0].reason == "LLM distilled recurring memory implementation pattern."
    assert proposals[0].confidence == 0.87


def test_default_reflect_model_matches_docs(monkeypatch: Any) -> None:
    monkeypatch.delenv(REFLECT_MODEL_ENV, raising=False)

    assert ReflectorConfig().reflect_model == "claude-sonnet-4-6"
    assert Reflector().config.reflect_model == DEFAULT_REFLECT_MODEL


def test_reflect_model_can_be_overridden_from_env(monkeypatch: Any) -> None:
    monkeypatch.setenv(REFLECT_MODEL_ENV, "local-reflect-model")

    assert ReflectorConfig().reflect_model == "local-reflect-model"


def test_propose_reflection_helper_accepts_documented_trigger() -> None:
    records = [
        _episodic(
            "ep-1",
            "Helper reflection compares architecture docs and implementation traces.",
        ),
        _episodic(
            "ep-2",
            "Helper reflection keeps implementation traces aligned with docs evidence.",
        ),
        _episodic("ep-3", "Helper reflection records recurring docs evidence for later approval."),
        _episodic("ep-4", "Helper reflection avoids direct semantic writes before approval."),
    ]

    proposals = propose_reflection(records, trigger="task_complete", task_outcome="success")

    assert len(proposals) == 1


def test_info_gain_rejects_records_below_threshold() -> None:
    records = [
        _episodic("ep-1", "alpha beta gamma delta epsilon zeta eta theta"),
        _episodic("ep-2", "iota kappa lambda mu nu xi omicron pi"),
        _episodic("ep-3", "rho sigma tau upsilon phi chi psi omega"),
    ]

    gate = Reflector(ReflectorConfig(min_info_gain_score=0.99)).evaluate_info_gain(records)

    assert gate.allowed is False
    assert "below reflector threshold" in gate.reason


def test_reflector_limits_episodic_records_to_configured_max() -> None:
    records = [
        _episodic(
            f"ep-{idx}",
            (
                f"Memory reflection record {idx} carries detailed recurring approval evidence "
                f"for planning docs integration tests reviewer signal source trace {idx}."
            ),
        )
        for idx in range(12)
    ]

    proposals = Reflector(ReflectorConfig(max_episodic_for_reflect=10)).propose(records)

    assert len(proposals) == 1
    assert proposals[0].sourceIds == [f"ep-{idx}" for idx in range(10)]


async def test_commit_insight_routes_write_authority_inside_reflector() -> None:
    calls: list[dict[str, object]] = []

    class AllowGate:
        def authorize(self, request: dict[str, object]) -> dict[str, object]:
            calls.append(request)
            return {"allowed": True}

    proposal = ReflectionProposal(
        kind="reflection_insight",
        sourceIds=["ep-1", "ep-2"],
        proposedContent="Evidence-first memory work should keep writes behind approval.",
        reason="stable reflection pattern",
        confidence=0.91,
    )
    async with QuilinMemStore(db_path=":memory:") as store:
        insight = await Reflector().commit_insight(
            proposal,
            store=store,
            write_authority=AllowGate(),  # type: ignore[arg-type]
        )
        stored = await store.get(insight.id)

    assert calls
    assert calls[0]["origin"] == "idle"
    assert calls[0]["tool"] == "memory_reflect_commit"
    assert stored is not None
    assert stored.layer == "semantic"
    assert stored.metadata["source"] == "reflector"


async def test_commit_insight_denies_without_store_write() -> None:
    class DenyGate:
        def authorize(self, _request: dict[str, object]) -> dict[str, object]:
            return {"allowed": False}

    proposal = ReflectionProposal(
        kind="reflection_insight",
        sourceIds=["ep-1"],
        proposedContent="Denied insight should not be stored.",
        reason="test denial",
        confidence=0.7,
    )
    async with QuilinMemStore(db_path=":memory:") as store:
        with contextlib.suppress(PermissionError):
            await Reflector().commit_insight(
                proposal,
                store=store,
                write_authority=DenyGate(),  # type: ignore[arg-type]
            )

        assert await store.count({"layer": "semantic"}) == 0


async def test_commit_insight_accepts_async_write_authority_decision_string() -> None:
    class AsyncGate:
        async def authorize(self, _request: dict[str, object]) -> dict[str, object]:
            return {"decision": "approved"}

    proposal = ReflectionProposal(
        kind="reflection_insight",
        sourceIds=["ep-1"],
        proposedContent="Async WriteAuthority approvals can commit reflection insight.",
        reason="async approval",
        confidence=0.7,
    )
    async with QuilinMemStore(db_path=":memory:") as store:
        insight = await Reflector().commit_insight(
            proposal,
            store=store,
            write_authority=AsyncGate(),  # type: ignore[arg-type]
        )

        assert await store.get(insight.id) is not None


async def test_commit_insight_accepts_object_write_authority_decision() -> None:
    class Decision:
        allowed = True

    class ObjectGate:
        def authorize(self, _request: dict[str, object]) -> Decision:
            return Decision()

    proposal = ReflectionProposal(
        kind="reflection_insight",
        sourceIds=["ep-1"],
        proposedContent="Object WriteAuthority approvals can commit reflection insight.",
        reason="object approval",
        confidence=0.7,
    )
    async with QuilinMemStore(db_path=":memory:") as store:
        insight = await Reflector().commit_insight(
            proposal,
            store=store,
            write_authority=ObjectGate(),  # type: ignore[arg-type]
        )

        assert await store.get(insight.id) is not None
