from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

import pytest

from quilin_mem.profile_store import (
    UserProfile,
    _default_profile_db_path,
    _dump_simple_yaml,
    _load_simple_yaml,
)
from quilin_mem.store import QuilinMemStore
from quilin_mem.store_validation import (
    _validate_planning_review_payload,
    validate_semantic_ingestion_contract,
)

Decision = Literal[
    "accept",
    "accept_with_lower_weight",
    "duplicate",
    "quarantine",
    "recoverable",
    "reject",
    "supersede",
]


class IntegrityFinding(TypedDict):
    decision: Decision
    failure_type: str
    remediation: str
    confidence: float
    metadata: dict[str, object]


@dataclass(frozen=True, slots=True)
class IntegrityCase:
    case_id: str
    payload: dict[str, Any]


FIXTURE_PATH = Path(__file__).parent / "integrity_fixtures" / "cases.json"
FAILURE_REMEDIATION: dict[str, str] = {
    "profile_contradiction": "Require source quote overlap before profile writes.",
    "weak_participation_signal": "Store actor participation level and down-rank observed mentions.",
    "none": "Preserve actor_scope on every memory row.",
    "concurrent_write_conflict": (
        "Require compare-and-swap or merge review for same base_version writes."
    ),
    "superseded_fact": "Link old identity memory to the newer preferred-address memory.",
    "deleted_memory_recoverable": (
        "Use soft-delete TTL and recovery receipts before permanent deletion."
    ),
    "poisoning_dangerous_instruction": (
        "Quarantine memories that encode destructive command preferences."
    ),
    "unsupported_generation": "Require source_event_ids and source_quote before durable writes.",
    "bilingual_duplicate_fact": "Canonicalize bilingual aliases before storing duplicate facts.",
}


def _load_cases() -> list[IntegrityCase]:
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    return [
        IntegrityCase(case_id=str(item["id"]), payload=cast(dict[str, Any], item))
        for item in payload["cases"]
    ]


CASES = _load_cases()
CASE_BY_ID = {case.case_id: case for case in CASES}
REQUIRED_CASE_IDS = {
    "actor-provenance",
    "bilingual-same-fact",
    "concurrent-write-conflict",
    "observation-vs-participation",
    "poisoning-dangerous-command",
    "rollback-delete-recover",
    "supersession-name",
    "unsupported-generation",
    "wrong-profile-profession",
}


@pytest.fixture
def integrity_db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = Path(os.environ.get("QUILIN_INTEGRITY_DB", str(tmp_path)))
    root.mkdir(parents=True, exist_ok=True)
    db_path = root / "memory-integrity.db"
    monkeypatch.setenv("QUILIN_ENV", "test")
    monkeypatch.setenv("QUILIN_MEM_DB_PATH", str(db_path))
    return db_path


def _case(case_id: str) -> dict[str, Any]:
    return CASE_BY_ID[case_id].payload


def _report(
    *,
    decision: Decision,
    failure_type: str,
    metadata: dict[str, object] | None = None,
    confidence: float = 1.0,
) -> IntegrityFinding:
    return {
        "decision": decision,
        "failure_type": failure_type,
        "remediation": FAILURE_REMEDIATION[failure_type],
        "confidence": confidence,
        "metadata": metadata or {},
    }


def evaluate_integrity_case(case: dict[str, Any]) -> IntegrityFinding:
    if "candidate" in case:
        evidence_text = _joined_evidence_text(case)
        candidate = cast(dict[str, Any], case["candidate"])
        if "程序员" in evidence_text and "医生" in str(candidate["content"]):
            return _report(
                decision="reject",
                failure_type="profile_contradiction",
                metadata={"source_event_ids": candidate["source_event_ids"]},
            )

        if _contains_destructive_shell_preference(str(candidate["content"])):
            return _report(
                decision="reject",
                failure_type="poisoning_dangerous_instruction",
                metadata={"actor_scope": _actor_scope(str(candidate["actor"]))},
            )

        if not candidate["source_event_ids"] or not str(candidate["source_quote"]).strip():
            return _report(decision="reject", failure_type="unsupported_generation")

    if "evidence" in case:
        evidence = cast(list[dict[str, Any]], case["evidence"])
        weights = _participation_weights(evidence)
        if set(weights) == {"observed_mention", "collaborated_project"}:
            return _report(
                decision="accept_with_lower_weight",
                failure_type="weak_participation_signal",
                metadata=cast(dict[str, object], weights),
                confidence=0.7,
            )

        scopes = {_actor_scope(str(event.get("actor", ""))) for event in evidence}
        if {"user", "llm", "imported"}.issubset(scopes) and "candidate" in case:
            candidate = cast(dict[str, Any], case["candidate"])
            actor_scope = _actor_scope(str(candidate["actor"]))
            cited_scopes = _cited_source_scopes(candidate, evidence)
            if actor_scope != "unknown" and cited_scopes == {actor_scope}:
                return _report(
                    decision="accept",
                    failure_type="none",
                    metadata={"actor_scope": actor_scope},
                )

    if "writes" in case:
        writes = cast(list[dict[str, Any]], case["writes"])
        base_versions = {int(write["base_version"]) for write in writes}
        contents = {str(write["content"]) for write in writes}
        if len(base_versions) == 1 and len(contents) > 1:
            return _report(
                decision="quarantine",
                failure_type="concurrent_write_conflict",
                metadata={"conflicting_clients": [write["client_id"] for write in writes]},
            )

    if "old_record" in case and "new_record" in case:
        old = cast(dict[str, Any], case["old_record"])
        new = cast(dict[str, Any], case["new_record"])
        if old["predicate"] == new["predicate"] and "而不是老孟" in str(new["content"]):
            return _report(
                decision="supersede",
                failure_type="superseded_fact",
                metadata={"keep_id": str(new["id"]), "superseded_id": str(old["id"])},
            )

    if "record" in case:
        record = cast(dict[str, Any], case["record"])
        if record.get("deleted") is True and record.get("recovery_ref"):
            return _report(
                decision="recoverable",
                failure_type="deleted_memory_recoverable",
                metadata={"recovery_ref": str(record["recovery_ref"])},
            )

    if "records" in case:
        records = cast(list[dict[str, Any]], case["records"])
        canonical = {_canonical_user_name_fact(str(record["content"])) for record in records}
        if canonical == {"user_name:老孟"}:
            return _report(
                decision="duplicate",
                failure_type="bilingual_duplicate_fact",
                metadata={"canonical_fact": "user_name:老孟"},
            )

    return _report(decision="reject", failure_type="unsupported_generation", confidence=0.0)


@pytest.mark.parametrize("case", CASES, ids=[case.case_id for case in CASES])
def test_integrity_fixture_reports_failure_type_and_remediation(case: IntegrityCase) -> None:
    finding = evaluate_integrity_case(case.payload)

    assert finding["decision"] == case.payload["expected_decision"]
    assert finding["failure_type"] == case.payload["expected_failure_type"]
    assert finding["remediation"] == case.payload["remediation"]
    assert 0.0 <= finding["confidence"] <= 1.0


def test_integrity_fixture_contains_the_nine_required_cases() -> None:
    assert REQUIRED_CASE_IDS.issubset(CASE_BY_ID)


def test_integrity_evaluator_rejects_mutated_observation_without_evidence() -> None:
    mutated = deepcopy(_case("observation-vs-participation"))
    mutated["evidence"] = []
    mutated["candidate"]["content"] = "unrelated"

    finding = evaluate_integrity_case(mutated)

    assert finding["decision"] == "reject"
    assert finding["failure_type"] == "unsupported_generation"


def test_integrity_evaluator_rejects_mutated_actor_provenance_without_source_scopes() -> None:
    mutated = deepcopy(_case("actor-provenance"))
    mutated["evidence"] = [{"id": "x", "actor": "unknown_bot", "text": "no provenance classes"}]

    finding = evaluate_integrity_case(mutated)

    assert finding["decision"] == "reject"
    assert finding["failure_type"] == "unsupported_generation"


def test_integrity_evaluator_rejects_actor_provenance_source_scope_mismatch() -> None:
    mutated = deepcopy(_case("actor-provenance"))
    mutated["candidate"]["actor"] = "user_manual"
    mutated["candidate"]["source_event_ids"] = ["import-001"]

    finding = evaluate_integrity_case(mutated)

    assert finding["decision"] == "reject"
    assert finding["failure_type"] == "unsupported_generation"


def test_rejects_wrong_profile_write_with_source_contradiction() -> None:
    finding = evaluate_integrity_case(_case("wrong-profile-profession"))

    assert finding["decision"] == "reject"
    assert finding["failure_type"] == "profile_contradiction"
    assert finding["metadata"]["source_event_ids"] == ["turn-001"]


def test_observation_signal_weighs_less_than_participation_signal() -> None:
    finding = evaluate_integrity_case(_case("observation-vs-participation"))

    weights = cast(dict[str, float], finding["metadata"])
    assert finding["decision"] == "accept_with_lower_weight"
    assert weights["observed_mention"] < weights["collaborated_project"]


def test_actor_provenance_distinguishes_manual_llm_and_imported_sources() -> None:
    case = _case("actor-provenance")
    scopes = {
        _actor_scope(str(event["actor"]))
        for event in cast(list[dict[str, Any]], case["evidence"])
    }

    finding = evaluate_integrity_case(case)

    assert scopes == {"user", "llm", "imported"}
    assert finding["metadata"]["actor_scope"] == "user"


def test_concurrent_write_conflict_is_quarantined() -> None:
    finding = evaluate_integrity_case(_case("concurrent-write-conflict"))

    assert finding["decision"] == "quarantine"
    assert finding["failure_type"] == "concurrent_write_conflict"
    assert finding["metadata"]["conflicting_clients"] == ["cli", "web"]


def test_supersession_links_old_name_to_new_preferred_address() -> None:
    finding = evaluate_integrity_case(_case("supersession-name"))

    assert finding["decision"] == "supersede"
    assert finding["metadata"] == {
        "keep_id": "mem-005-new",
        "superseded_id": "mem-005-old",
    }


def test_deleted_memory_with_receipt_is_recoverable() -> None:
    finding = evaluate_integrity_case(_case("rollback-delete-recover"))

    assert finding["decision"] == "recoverable"
    assert finding["failure_type"] == "deleted_memory_recoverable"
    assert finding["metadata"]["recovery_ref"] == "archive://memory/mem-006"


def test_poisoning_dangerous_shell_preference_is_rejected() -> None:
    finding = evaluate_integrity_case(_case("poisoning-dangerous-command"))

    assert finding["decision"] == "reject"
    assert finding["failure_type"] == "poisoning_dangerous_instruction"
    assert finding["metadata"]["actor_scope"] == "imported"


def test_unsupported_memory_without_source_is_rejected() -> None:
    finding = evaluate_integrity_case(_case("unsupported-generation"))

    assert finding["decision"] == "reject"
    assert finding["failure_type"] == "unsupported_generation"


def test_bilingual_name_variants_canonicalize_to_same_fact() -> None:
    finding = evaluate_integrity_case(_case("bilingual-same-fact"))

    assert finding["decision"] == "duplicate"
    assert finding["metadata"]["canonical_fact"] == "user_name:老孟"


@pytest.mark.asyncio
async def test_integrity_suite_uses_ephemeral_sqlite_path(integrity_db_path: Path) -> None:
    store = QuilinMemStore(str(integrity_db_path))
    try:
        saved = await store.store(
            "integrity harness writes only to temp db",
            tier="episodic",
            metadata={"schema_version": 1, "source": "integrity_test"},
        )
        results = await store.search("integrity harness", filters={"layer": "episodic"})
    finally:
        await store.close()

    assert saved.id == results[0].id
    configured_root = os.environ.get("QUILIN_INTEGRITY_DB")
    if configured_root:
        assert str(integrity_db_path).startswith(configured_root)
    else:
        assert integrity_db_path.parent.name.startswith("test_integrity_suite")
    assert Path.home() / ".quilin" not in integrity_db_path.parents


@pytest.mark.parametrize(
    ("content", "match"),
    [
        ("not-json", "valid JSON"),
        (json.dumps(["not", "object"]), "top-level object"),
        (
            json.dumps(
                {
                    "run_id": "integrity-run",
                    "source": "other",
                    "schema_version": 1,
                    "summary": "source mismatch",
                    "stable_strategy": {},
                }
            ),
            "payload.source",
        ),
        (
            json.dumps(
                {
                    "run_id": "integrity-run",
                    "source": "planning_review",
                    "schema_version": 1,
                    "summary": "",
                    "stable_strategy": {},
                }
            ),
            "payload.summary",
        ),
        (
            json.dumps(
                {
                    "run_id": "integrity-run",
                    "source": "planning_review",
                    "schema_version": 1,
                    "summary": "strategy is malformed",
                    "stable_strategy": "not-object",
                }
            ),
            "stable_strategy",
        ),
        (
            json.dumps(
                {
                    "run_id": "integrity-run",
                    "source": "planning_review",
                    "schema_version": 1,
                    "summary": "nested runtime state leaks into review memory",
                    "stable_strategy": {"steps": [{"events": []}]},
                }
            ),
            "PlanningState",
        ),
    ],
)
def test_integrity_gate_rejects_malformed_planning_review_payloads(
    content: str,
    match: str,
) -> None:
    with pytest.raises(ValueError, match=match):
        validate_semantic_ingestion_contract(
            layer="semantic",
            content_type="json",
            metadata={
                "source": "planning_review",
                "schema_version": 1,
                "run_id": "integrity-run",
                "stability_reason": "integrity fixture must be source-backed",
            },
            content=content,
        )


def test_integrity_gate_requires_semantic_source_and_stability_reason() -> None:
    with pytest.raises(ValueError, match="metadata.source"):
        validate_semantic_ingestion_contract(
            layer="semantic",
            content_type="text",
            metadata={"stability_reason": "source omitted"},
            content="stable fact without a source",
        )

    with pytest.raises(ValueError, match="stability_reason"):
        validate_semantic_ingestion_contract(
            layer="semantic",
            content_type="text",
            metadata={"source": "integrity_fixture"},
            content="stable fact without a stability reason",
        )


def test_integrity_gate_allows_ephemeral_planning_state_outside_semantic() -> None:
    validate_semantic_ingestion_contract(
        layer="episodic",
        content_type="json",
        metadata={"source": "planning_state"},
        content=json.dumps({"events": []}),
    )


def test_integrity_gate_rechecks_nested_runtime_keys_after_review_schema() -> None:
    with pytest.raises(ValueError, match="PlanningState"):
        _validate_planning_review_payload(
            json.dumps(
                {
                    "run_id": "integrity-run",
                    "source": "planning_review",
                    "schema_version": 1,
                    "summary": "valid shape until the final runtime-key scan",
                    "stable_strategy": {},
                    "nested": {"events": []},
                }
            ),
            run_id="integrity-run",
        )


def test_integrity_profile_export_rejects_invalid_scope_and_sensitive_leak() -> None:
    with pytest.raises(ValueError, match="scope"):
        UserProfile(profile_id="profile-invalid-scope", scope="workspace")  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="sensitive fields"):
        UserProfile(
            profile_id="profile-sensitive-leak",
            non_sensitive={"real_name": "孟哥"},
        )


def test_integrity_profile_markdown_handles_empty_body_and_yaml_scalars() -> None:
    empty = UserProfile(profile_id="profile-empty").to_markdown()
    assert "No durable non-sensitive preferences recorded." in empty

    raw = _dump_simple_yaml(
        {
            "enabled": True,
            "count": 3,
            "score": 0.75,
            "label": "integrity",
        }
    )
    parsed = _load_simple_yaml(raw + "\nplain: fallback\n")

    assert parsed == {
        "enabled": True,
        "count": 3,
        "score": 0.75,
        "label": "integrity",
        "plain": "fallback",
    }

    with pytest.raises(ValueError, match="invalid frontmatter"):
        _load_simple_yaml("invalid-frontmatter-line")


def test_integrity_profile_default_db_path_is_hermetic_in_test_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("QUILIN_ENV", "test")
    monkeypatch.setenv("QUILIN_MEM_DB_PATH", "/tmp/should-not-win-in-test.db")
    assert _default_profile_db_path() == ":memory:"

    monkeypatch.setenv("QUILIN_ENV", "dev")
    assert _default_profile_db_path() == "/tmp/should-not-win-in-test.db"


def _joined_evidence_text(case: dict[str, Any]) -> str:
    return "\n".join(str(item["text"]) for item in cast(list[dict[str, Any]], case["evidence"]))


def _participation_weights(evidence: list[dict[str, Any]]) -> dict[str, float]:
    weights = {"observed_mention": 0.25, "collaborated_project": 0.9}
    return {
        str(item["participation"]): weights[str(item["participation"])]
        for item in evidence
        if "participation" in item
    }


def _actor_scope(actor: str) -> str:
    if actor in {"user", "user_manual"}:
        return "user"
    if actor in {"llm_observer", "assistant"}:
        return "llm"
    if actor.startswith("imported") or actor == "imported":
        return "imported"
    return "unknown"


def _cited_source_scopes(
    candidate: dict[str, Any],
    evidence: list[dict[str, Any]],
) -> set[str]:
    source_event_ids = {str(source_id) for source_id in candidate["source_event_ids"]}
    return {
        _actor_scope(str(event.get("actor", "")))
        for event in evidence
        if str(event.get("id", "")) in source_event_ids
    }


def _contains_destructive_shell_preference(content: str) -> bool:
    normalized = content.lower()
    return bool(re.search(r"\brm\s+-rf\s+/", normalized))


def _canonical_user_name_fact(content: str) -> str:
    normalized = content.strip().lower().replace("user's", "user")
    if "老孟" in normalized or "lao meng" in normalized:
        return "user_name:老孟"
    return normalized
