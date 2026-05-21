from __future__ import annotations

from quilin_mem.consolidator import Consolidator
from quilin_mem.idle_budget import IdleBudgetProvider
from quilin_mem.reflector import Reflector


def test_propose_without_store_returns_empty_preview_without_mutating_storage() -> None:
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)

    proposal = Consolidator(budget).propose(
        task="qui-187.consolidator.propose",
        estimated_tokens=100,
    )
    payload = proposal.to_wire_dict()

    proposals = payload["proposals"]
    proposal_types = {item["kind"] for item in proposals}

    assert proposal_types <= {"dedupe", "kg-prune", "reflect-insight"}
    assert proposals == []
    assert payload["dryRun"] is True
    assert payload["writesPerformed"] == 0


def test_kg_prune_without_concrete_candidates_is_not_emitted() -> None:
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)

    proposal = Consolidator(budget).propose(
        task="qui-187.consolidator.propose",
        estimated_tokens=100,
    )
    proposals = proposal.to_wire_dict()["proposals"]

    assert all(item["kind"] != "kg-prune" for item in proposals)


def test_budget_denial_skips_expensive_llm_reflection() -> None:
    calls = 0

    def fake_llm(**_kwargs: object) -> dict[str, object]:
        nonlocal calls
        calls += 1
        return {"proposedContent": "unused"}

    reflector = Reflector(llm_caller=fake_llm)
    budget = IdleBudgetProvider(enabled=True, token_budget=10)

    proposal = Consolidator(
        budget,
        reflector=reflector,
    ).propose(task="qui-187.consolidator.propose", estimated_tokens=1_000)
    payload = proposal.to_wire_dict()

    assert payload["budget"]["decision"] == "denied"
    assert calls == 0
    assert proposal.reflections == ()
