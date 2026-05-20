from __future__ import annotations

from quilin_mem.consolidator import Consolidator
from quilin_mem.idle_budget import IdleBudgetProvider
from quilin_mem.reflector import Reflector


def test_propose_returns_reviewable_proposal_subset_without_mutating_storage() -> None:
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)

    proposal = Consolidator(budget).propose(
        task="qui-187.consolidator.propose",
        estimated_tokens=100,
    )
    payload = proposal.to_wire_dict()

    proposals = payload["proposals"]
    proposal_types = {item["kind"] for item in proposals}

    assert proposal_types <= {"dedupe", "kg-prune", "reflect-insight"}
    assert {"dedupe", "kg-prune", "reflect-insight"} & proposal_types
    assert payload["dryRun"] is True
    assert payload["writesPerformed"] == 0


def test_propose_includes_dedupe_and_kg_prune_as_preview_only_actions() -> None:
    budget = IdleBudgetProvider(enabled=True, token_budget=10_000)

    proposal = Consolidator(budget).propose(
        task="qui-187.consolidator.propose",
        estimated_tokens=100,
    )
    proposals = proposal.to_wire_dict()["proposals"]

    kg_prune = next(item for item in proposals if item["kind"] == "kg-prune")

    assert kg_prune["tier"] == "episodic"
    assert kg_prune["deleteIds"] == []


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
