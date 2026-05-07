from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from quilin_mem.observer import (
    L3aObserver,
    MemoryObserver,
    NoOpMemoryObserver,
    ObservationArchiveGateDecision,
    ObservationCandidate,
    ObservationTurn,
    ObserverConfig,
    RuleFirstMemoryObserver,
    _call_deepseek_api,
    _format_turn_buffer,
    _parse_l3a_llm_response,
    build_observation_archive_gate_report,
    build_observation_extraction_report,
    decide_observation_archive_gate,
    detect_observation_language,
    evaluate_observation_batch_quality,
    evaluate_observation_candidate_quality,
    evaluate_observation_candidates_quality,
    extract_observation_candidates,
    normalize_observation_candidate,
    normalize_observation_candidates,
    normalize_observation_turn,
    observe_safely,
)


def _archive_gate_decision(candidates: list[object]) -> ObservationArchiveGateDecision:
    return decide_observation_archive_gate(
        evaluate_observation_batch_quality(candidates).archive_readiness
    )


def _allowed_archive_gate_decision() -> ObservationArchiveGateDecision:
    return _archive_gate_decision(
        [
            {
                "content": "The user wants bilingual docs.",
                "confidence": 0.95,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            }
        ]
    )


def _mixed_archive_gate_decision() -> ObservationArchiveGateDecision:
    return _archive_gate_decision(
        [
            {
                "content": "The user wants bilingual docs.",
                "confidence": 0.95,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            },
            {
                "content": "The user prefers direct status updates.",
                "confidence": 0.8,
                "kind": "preference",
                "source_turn_id": "turn-2",
            },
            {"content": "", "confidence": 0.9, "kind": "fact"},
        ]
    )


def _low_confidence_archive_gate_decision() -> ObservationArchiveGateDecision:
    return _archive_gate_decision(
        [
            {
                "content": "The user wants direct status updates.",
                "confidence": 0.0,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            }
        ]
    )


def _rejected_archive_gate_decision() -> ObservationArchiveGateDecision:
    return _archive_gate_decision(
        [
            {
                "content": "The user prefers brief summaries.",
                "confidence": True,
                "kind": "preference",
                "source_turn_id": "turn-2",
                "metadata": {"evidence": ["turn-2"]},
            }
        ]
    )


def _archive_gate_snapshot(
    decision_id: str,
    decision: ObservationArchiveGateDecision,
) -> dict[str, object]:
    return {"id": decision_id, **decision.to_dict()}


def _assert_secret_absent_from_candidates(
    candidates: tuple[ObservationCandidate, ...],
    raw_secret: str,
) -> None:
    assert candidates
    for candidate in candidates:
        assert raw_secret not in candidate.content
        source_excerpt = candidate.metadata["source_excerpt"]
        assert isinstance(source_excerpt, str)
        assert raw_secret not in source_excerpt


async def test_default_observer_is_noop() -> None:
    observer = NoOpMemoryObserver()
    turn = ObservationTurn(content="remember I prefer brief status updates", role="user")

    candidates = await observer.observe(turn)

    assert candidates == []
    assert isinstance(observer, MemoryObserver)


async def test_default_observer_accepts_wire_turn_schema() -> None:
    observer = NoOpMemoryObserver()
    wire_turn = {
        "content": "用户喜欢中文总结",
        "role": "user",
        "turn_id": "turn-1",
        "session_id": "session-1",
        "user_id": "user-1",
        "metadata": {"source": "test"},
    }

    normalized = normalize_observation_turn(wire_turn)
    candidates = await observer.observe(wire_turn)

    assert normalized.content == "用户喜欢中文总结"
    assert normalized.role == "user"
    assert normalized.turn_id == "turn-1"
    assert normalized.session_id == "session-1"
    assert normalized.user_id == "user-1"
    assert normalized.metadata == {"source": "test"}
    assert candidates == []


def test_observation_language_detection_covers_bilingual_turns() -> None:
    assert detect_observation_language("Please keep updates concise") == "en"
    assert detect_observation_language("用户喜欢中文总结") == "zh"
    assert detect_observation_language("用户喜欢中文总结 and English headings") == "mixed"
    assert detect_observation_language("  ") == "unknown"


async def test_rule_first_observer_extracts_bilingual_multi_pattern_candidates() -> None:
    observer = RuleFirstMemoryObserver()
    turn = {
        "content": (
            "用户喜欢中文总结。Please keep status updates concise. "
            "Track this in QUI-16 and providers/memory/src/quilin_mem/observer.py."
        ),
        "role": "user",
        "turn_id": "turn-bilingual-1",
        "session_id": "session-1",
        "user_id": "user-1",
    }

    candidates = await observer.observe(turn)
    report = build_observation_extraction_report(turn)

    assert isinstance(observer, MemoryObserver)
    assert report.language == "mixed"
    assert report.extraction_path == "deterministic_escalation"
    assert report.escalation_required is True
    assert report.escalation_reasons == ("mixed_language_input",)
    assert report.pattern_ids == (
        "en_please_instruction",
        "zh_explicit_preference",
        "linear_issue_reference",
        "project_path_reference",
    )
    assert [candidate.content for candidate in candidates] == [
        "User requested: status updates concise",
        "User preference: 中文总结",
        "Referenced Linear issue: QUI-16",
        "Referenced project path: providers/memory/src/quilin_mem/observer.py",
    ]
    assert all(candidate.source_turn_id == "turn-bilingual-1" for candidate in candidates)
    assert all(candidate.metadata["source"] == "rule_first_observer" for candidate in candidates)
    assert all(candidate.metadata["needs_escalation"] is True for candidate in candidates)
    assert all(candidate.metadata["needs_policy_review"] is True for candidate in candidates)
    assert [candidate.content for candidate in candidates] == [
        candidate.content for candidate in report.candidates
    ]


def test_rule_first_extraction_marks_mixed_candidates_not_archive_ready() -> None:
    report = evaluate_observation_batch_quality(
        extract_observation_candidates(
            {
                "content": "用户喜欢中文总结 and please keep replies direct.",
                "role": "user",
                "turn_id": "turn-mixed-1",
            }
        )
    )

    assert report.status == "mixed"
    assert report.archive_ready is False
    assert report.accepted_candidates == 2
    assert report.high_quality_candidates == 0
    assert report.archive_readiness.blocking_reasons == (
        "escalation_required",
        "policy_review_required",
        "low_quality_candidates",
        "no_high_quality_candidates",
    )
    assert [quality.needs_escalation for quality in report.qualities] == [True, True]
    assert [quality.needs_policy_review for quality in report.qualities] == [True, True]


def test_rule_first_observer_escalates_ambiguous_memory_requests_without_silent_drop() -> None:
    report = build_observation_extraction_report(
        {
            "content": "Maybe keep this for later, but I am not sure yet.",
            "role": "user",
            "turn_id": "turn-ambiguous-1",
        }
    )

    assert report.language == "en"
    assert report.extraction_path == "deterministic_escalation"
    assert report.escalation_required is True
    assert report.escalation_reasons == (
        "ambiguous_memory_request",
        "no_deterministic_candidate",
    )
    assert len(report.candidates) == 1
    candidate = report.candidates[0]
    assert candidate.kind == "unknown"
    assert candidate.confidence == 0.0
    assert candidate.content == "Escalate observation review for turn-ambiguous-1"
    assert candidate.metadata["needs_escalation"] is True
    assert candidate.metadata["needs_policy_review"] is True


def test_rule_first_observer_extracts_test_outcome_events() -> None:
    candidates = extract_observation_candidates(
        {
            "content": "uv run pytest tests/test_observer_contract.py passed with 0 failed",
            "role": "tool",
            "turn_id": "turn-test-1",
        }
    )

    assert [candidate.content for candidate in candidates] == [
        "Observed local validation result: uv run pytest tests/test_observer_contract.py "
        "passed with 0 failed"
    ]
    assert candidates[0].kind == "event"
    assert candidates[0].confidence == 0.9
    assert candidates[0].metadata["pattern_id"] == "test_outcome"
    assert candidates[0].metadata["escalation_reasons"] == ("non_user_source",)
    assert candidates[0].metadata["needs_policy_review"] is True


def test_rule_first_observer_redacts_api_keys_from_candidates() -> None:
    raw_api_key = "qln-test-api-key-1234567890abcdef"

    candidates = extract_observation_candidates(
        {
            "content": f"Remember that my API key is {raw_api_key} for local testing.",
            "role": "user",
            "turn_id": "turn-api-key-1",
        }
    )

    _assert_secret_absent_from_candidates(candidates, raw_api_key)
    assert candidates[0].content == (
        "Remembered fact: my API key is [REDACTED_SECRET] for local testing"
    )
    assert "[REDACTED_SECRET]" in candidates[0].metadata["source_excerpt"]
    assert candidates[0].metadata["escalation_reasons"] == ("safety_relevant",)
    assert candidates[0].metadata["needs_policy_review"] is True


def test_rule_first_observer_redacts_inline_env_secret_assignments() -> None:
    raw_api_key = "plain-openai-secret"

    candidates = extract_observation_candidates(
        {
            "content": f"Remember OPENAI_API_KEY={raw_api_key} for local tests.",
            "role": "user",
            "turn_id": "turn-inline-env-secret-1",
        }
    )

    _assert_secret_absent_from_candidates(candidates, raw_api_key)
    assert candidates[0].content == (
        "Remembered fact: OPENAI_API_KEY=[REDACTED_SECRET] for local tests"
    )
    assert candidates[0].metadata["source_excerpt"] == (
        "Remember OPENAI_API_KEY=[REDACTED_SECRET] for local tests."
    )
    assert candidates[0].metadata["escalation_reasons"] == ("safety_relevant",)
    assert candidates[0].metadata["needs_policy_review"] is True


def test_rule_first_observer_redacts_generic_inline_token_assignments() -> None:
    raw_token = "plain-token-secret"

    candidates = extract_observation_candidates(
        {
            "content": f"Please keep token={raw_token} outside summaries.",
            "role": "user",
            "turn_id": "turn-inline-token-secret-1",
        }
    )

    _assert_secret_absent_from_candidates(candidates, raw_token)
    assert candidates[0].content == (
        "User requested: token=[REDACTED_SECRET] outside summaries"
    )
    assert candidates[0].metadata["source_excerpt"] == (
        "Please keep token=[REDACTED_SECRET] outside summaries."
    )
    assert candidates[0].metadata["escalation_reasons"] == ("safety_relevant",)
    assert candidates[0].metadata["needs_policy_review"] is True


def test_rule_first_observer_does_not_double_redact_labeled_assignment() -> None:
    raw_api_key = "plain-api-secret"

    candidates = extract_observation_candidates(
        {
            "content": f"Remember api_key={raw_api_key} for local tests.",
            "role": "user",
            "turn_id": "turn-labeled-assignment-secret-1",
        }
    )

    _assert_secret_absent_from_candidates(candidates, raw_api_key)
    assert candidates[0].content == (
        "Remembered fact: api_key=[REDACTED_SECRET] for local tests"
    )
    assert "[REDACTED_SECRET]]" not in candidates[0].content
    assert "[REDACTED_SECRET]]" not in candidates[0].metadata["source_excerpt"]


def test_rule_first_observer_redacts_password_like_values_and_preserves_safe_extraction() -> None:
    raw_password = "qln-test-password-123456"

    candidates = extract_observation_candidates(
        {
            "content": (
                f"Please keep the password: {raw_password} out of logs. "
                "Please keep status updates concise."
            ),
            "role": "user",
            "turn_id": "turn-password-1",
        }
    )

    _assert_secret_absent_from_candidates(candidates, raw_password)
    assert [candidate.content for candidate in candidates] == [
        "User requested: the password: [REDACTED_SECRET] out of logs",
        "User requested: status updates concise",
    ]
    assert all(
        "[REDACTED_SECRET]" in candidate.metadata["source_excerpt"]
        for candidate in candidates
    )
    assert all(
        candidate.metadata["escalation_reasons"] == ("safety_relevant",)
        for candidate in candidates
    )


def test_rule_first_report_serializes_candidates_with_content_hash_evidence() -> None:
    report = build_observation_extraction_report(
        {
            "content": f"Please keep {'x' * 260}",
            "role": "user",
        }
    )

    snapshot = report.to_dict()
    candidate = snapshot["candidates"][0]  # type: ignore[index]
    metadata = candidate["metadata"]  # type: ignore[index]

    assert candidate["source_turn_id"] is None  # type: ignore[index]
    assert metadata["evidence"][0].startswith("content-sha256:")  # type: ignore[index]
    assert metadata["source_excerpt"].endswith("...")  # type: ignore[index]


def test_observation_turn_preserves_wire_observed_at() -> None:
    observed_at = "2026-05-02T03:04:05+00:00"

    normalized = normalize_observation_turn(
        {
            "content": "用户喜欢中文总结",
            "role": "user",
            "observed_at": observed_at,
        }
    )

    assert normalized.observed_at == datetime(2026, 5, 2, 3, 4, 5, tzinfo=UTC)


def test_turn_schema_rejects_invalid_input() -> None:
    with pytest.raises(TypeError, match="turn.content must be a string"):
        normalize_observation_turn({"role": "user"})

    with pytest.raises(ValueError, match="Invalid turn.role"):
        normalize_observation_turn({"content": "hello", "role": "invalid"})

    with pytest.raises(TypeError, match="turn.metadata must be a mapping"):
        normalize_observation_turn({"content": "hello", "metadata": "bad"})

    with pytest.raises(TypeError, match="turn.turn_id"):
        normalize_observation_turn({"content": "hello", "turn_id": 123})

    with pytest.raises(TypeError, match="turn.role"):
        normalize_observation_turn({"content": "hello", "role": 123})

    with pytest.raises(ValueError, match="turn.observed_at"):
        normalize_observation_turn({"content": "hello", "observed_at": "not-a-time"})


def test_observation_candidate_schema_is_frozen() -> None:
    candidate = ObservationCandidate(
        content="The user prefers concise updates.",
        confidence=0.8,
        kind="preference",
        source_turn_id="turn-1",
        metadata={"source": "test"},
    )

    assert candidate.confidence == 0.8
    assert candidate.kind == "preference"
    assert candidate.metadata == {"source": "test"}

    with pytest.raises(AttributeError):
        candidate.content = "mutated"  # type: ignore[misc]

    with pytest.raises(ValueError, match="candidate.confidence"):
        ObservationCandidate(content="bad", confidence=1.1)

    with pytest.raises(TypeError, match="candidate.content"):
        ObservationCandidate(content=123, confidence=0.5)  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="candidate.confidence"):
        ObservationCandidate(content="bad", confidence="high")  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="candidate.confidence"):
        ObservationCandidate(content="bad", confidence=True)  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="candidate.kind"):
        ObservationCandidate(content="bad", confidence=0.5, kind=123)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="Invalid candidate.kind"):
        ObservationCandidate(content="bad", confidence=0.5, kind="invalid")  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="candidate.source_turn_id"):
        ObservationCandidate(content="bad", confidence=0.5, source_turn_id=123)  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="turn must"):
        normalize_observation_turn(object())  # type: ignore[arg-type]


def test_observation_candidate_accepts_wire_schema() -> None:
    candidate = normalize_observation_candidate(
        {
            "content": "The user prefers concise status updates.",
            "confidence": 0.9,
            "kind": "preference",
            "source_turn_id": "turn-1",
            "metadata": {"source": "observer-fixture"},
            "created_at": "2026-05-02T03:04:05Z",
        }
    )

    assert candidate.content == "The user prefers concise status updates."
    assert candidate.confidence == 0.9
    assert candidate.kind == "preference"
    assert candidate.source_turn_id == "turn-1"
    assert candidate.metadata == {"source": "observer-fixture"}
    assert candidate.created_at == datetime(2026, 5, 2, 3, 4, 5, tzinfo=UTC)


def test_observation_candidate_quality_accepts_full_evidence() -> None:
    candidate = ObservationCandidate(
        content="The user prefers concise status updates.",
        confidence=0.9,
        kind="preference",
        source_turn_id="turn-1",
        metadata={"source": "observer-fixture", "evidence": ["turn-1"]},
    )

    quality = evaluate_observation_candidate_quality(candidate)

    assert quality.has_content is True
    assert quality.has_source is True
    assert quality.has_evidence is True
    assert quality.has_confidence is True
    assert quality.has_valid_confidence is True
    assert quality.has_known_kind is True
    assert quality.evidence_coverage == 1.0
    assert quality.confidence_value == 0.9
    assert quality.quality_score == 0.98
    assert quality.issues == ()


def test_observation_candidate_quality_flags_missing_evidence() -> None:
    candidate = ObservationCandidate(
        content="The user prefers brief summaries.",
        confidence=0.7,
        kind="preference",
        source_turn_id="turn-2",
    )

    quality = evaluate_observation_candidate_quality(candidate)

    assert quality.has_content is True
    assert quality.has_source is True
    assert quality.has_evidence is False
    assert quality.evidence_coverage == 0.5
    assert quality.confidence_value == 0.7
    assert quality.quality_score == 0.815
    assert quality.issues == ("missing_evidence",)


def test_observation_candidate_quality_rejects_bool_confidence() -> None:
    raw_candidate = {
        "content": "The user prefers brief summaries.",
        "confidence": True,
        "kind": "preference",
        "source_turn_id": "turn-2",
    }

    quality = evaluate_observation_candidate_quality(raw_candidate)

    assert quality.has_confidence is False
    assert quality.has_valid_confidence is False
    assert quality.quality_score == 0.675
    assert quality.issues == ("missing_evidence", "missing_confidence")


def test_observation_candidate_quality_flags_empty_content_without_raising() -> None:
    raw_candidate = {
        "content": " ",
        "confidence": 0.9,
        "kind": "fact",
        "source_turn_id": "turn-3",
        "metadata": {"evidence": "quoted user turn"},
    }

    quality = evaluate_observation_candidate_quality(raw_candidate)

    assert quality.has_content is False
    assert quality.has_source is True
    assert quality.has_evidence is True
    assert quality.quality_score == 0.0
    assert quality.issues == ("missing_content",)
    assert normalize_observation_candidates([raw_candidate]) == []


def test_observation_candidates_quality_handles_mixed_batch() -> None:
    candidates = [
        ObservationCandidate(
            content="The user wants bilingual docs.",
            confidence=0.95,
            kind="preference",
            source_turn_id="turn-1",
            metadata={"evidence": ["turn-1"]},
        ),
        {
            "content": "The user prefers direct status updates.",
            "confidence": 0.8,
            "kind": "preference",
            "source_turn_id": "turn-2",
        },
        {"content": "", "confidence": 0.9, "kind": "fact"},
    ]

    quality = evaluate_observation_candidates_quality(candidates)
    normalized = normalize_observation_candidates(candidates)

    assert [item.has_content for item in quality] == [True, True, False]
    assert [item.has_evidence for item in quality] == [True, False, False]
    assert quality[0].issues == ()
    assert quality[1].issues == ("missing_evidence",)
    assert quality[2].issues == (
        "missing_content",
        "missing_source",
        "missing_evidence",
    )
    assert [candidate.content for candidate in normalized] == [
        "The user wants bilingual docs.",
        "The user prefers direct status updates.",
    ]


def test_observation_batch_quality_reports_high_quality_archive_ready_batch() -> None:
    report = evaluate_observation_batch_quality(
        [
            ObservationCandidate(
                content="The user wants bilingual docs.",
                confidence=0.95,
                kind="preference",
                source_turn_id="turn-1",
                metadata={"evidence": ["turn-1"]},
            ),
            {
                "content": "The user prefers direct status updates.",
                "confidence": 0.9,
                "kind": "preference",
                "source_turn_id": "turn-2",
                "metadata": {"source_excerpt": "Keep status updates direct."},
            },
        ]
    )

    assert report.status == "high_quality"
    assert report.archive_ready is True
    assert report.archive_readiness.ready is True
    assert report.total_candidates == 2
    assert report.accepted_candidates == 2
    assert report.rejected_candidates == 0
    assert report.high_quality_candidates == 2
    assert report.average_quality_score == 0.985
    assert report.issues == ()
    assert report.archive_readiness.to_dict() == {
        "ready": True,
        "status": "high_quality",
        "accepted": 2,
        "rejected": 0,
        "high_quality": 2,
        "average_quality_score": 0.985,
        "blocking_reasons": (),
    }


def test_observation_archive_gate_allows_ready_projection() -> None:
    report = evaluate_observation_batch_quality(
        [
            {
                "content": "The user wants bilingual docs.",
                "confidence": 0.95,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            },
            {
                "content": "The user prefers direct status updates.",
                "confidence": 0.9,
                "kind": "preference",
                "source_turn_id": "turn-2",
                "metadata": {"source_excerpt": "Keep status updates direct."},
            },
        ]
    )

    decision = decide_observation_archive_gate(report.archive_readiness)

    assert decision.to_dict() == {
        "allowed": True,
        "status": "high_quality",
        "blocking_reasons": (),
        "accepted": 2,
        "rejected": 0,
        "high_quality": 2,
        "summary": (
            "allowed: status=high_quality; reasons=none; accepted=2; rejected=0; high_quality=2"
        ),
    }


def test_observation_batch_quality_reports_mixed_batch() -> None:
    candidates = [
        ObservationCandidate(
            content="The user wants bilingual docs.",
            confidence=0.95,
            kind="preference",
            source_turn_id="turn-1",
            metadata={"evidence": ["turn-1"]},
        ),
        {
            "content": "The user prefers direct status updates.",
            "confidence": 0.8,
            "kind": "preference",
            "source_turn_id": "turn-2",
        },
        {"content": "", "confidence": 0.9, "kind": "fact"},
    ]

    report = evaluate_observation_batch_quality(candidates)

    assert report.status == "mixed"
    assert report.archive_ready is False
    assert report.archive_readiness.ready is False
    assert report.total_candidates == 3
    assert report.accepted_candidates == 2
    assert report.rejected_candidates == 1
    assert report.high_quality_candidates == 1
    assert report.average_quality_score == 0.912
    assert report.issues == ("rejected_candidates", "low_quality_candidates")
    assert report.archive_readiness.to_dict() == {
        "ready": False,
        "status": "mixed",
        "accepted": 2,
        "rejected": 1,
        "high_quality": 1,
        "average_quality_score": 0.912,
        "blocking_reasons": (
            "mixed_batch",
            "rejected_candidates",
            "low_confidence_candidates",
            "low_quality_candidates",
        ),
    }
    assert [quality.issues for quality in report.qualities] == [
        (),
        ("missing_evidence",),
        ("missing_content", "missing_source", "missing_evidence"),
    ]


def test_observation_archive_gate_blocks_mixed_projection() -> None:
    report = evaluate_observation_batch_quality(
        [
            {
                "content": "The user wants bilingual docs.",
                "confidence": 0.95,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            },
            {
                "content": "The user prefers direct status updates.",
                "confidence": 0.8,
                "kind": "preference",
                "source_turn_id": "turn-2",
            },
            {"content": "", "confidence": 0.9, "kind": "fact"},
        ]
    )

    decision = decide_observation_archive_gate(report.archive_readiness)

    assert decision.to_dict() == {
        "allowed": False,
        "status": "mixed",
        "blocking_reasons": (
            "mixed_batch",
            "rejected_candidates",
            "low_confidence_candidates",
            "low_quality_candidates",
        ),
        "accepted": 2,
        "rejected": 1,
        "high_quality": 1,
        "summary": (
            "blocked: status=mixed; "
            "reasons=mixed_batch,rejected_candidates,"
            "low_confidence_candidates,low_quality_candidates; "
            "accepted=2; rejected=1; high_quality=1"
        ),
    }


def test_observation_batch_quality_reports_rejected_bool_confidence_batch() -> None:
    raw_candidate = {
        "content": "The user prefers brief summaries.",
        "confidence": True,
        "kind": "preference",
        "source_turn_id": "turn-2",
        "metadata": {"evidence": ["turn-2"]},
    }

    report = evaluate_observation_batch_quality([raw_candidate])

    assert report.status == "rejected"
    assert report.archive_ready is False
    assert report.archive_readiness.ready is False
    assert report.total_candidates == 1
    assert report.accepted_candidates == 0
    assert report.rejected_candidates == 1
    assert report.high_quality_candidates == 0
    assert report.average_quality_score == 0.0
    assert report.qualities[0].has_confidence is False
    assert report.qualities[0].has_valid_confidence is False
    assert report.issues == ("rejected_candidates", "no_high_quality_candidates")
    assert report.archive_readiness.to_dict() == {
        "ready": False,
        "status": "rejected",
        "accepted": 0,
        "rejected": 1,
        "high_quality": 0,
        "average_quality_score": 0.0,
        "blocking_reasons": (
            "all_candidates_rejected",
            "no_high_quality_candidates",
        ),
    }
    assert normalize_observation_candidates([raw_candidate]) == []


def test_observation_archive_gate_blocks_rejected_projection() -> None:
    report = evaluate_observation_batch_quality(
        [
            {
                "content": "The user prefers brief summaries.",
                "confidence": True,
                "kind": "preference",
                "source_turn_id": "turn-2",
                "metadata": {"evidence": ["turn-2"]},
            }
        ]
    )

    decision = decide_observation_archive_gate(report.archive_readiness)

    assert decision.to_dict() == {
        "allowed": False,
        "status": "rejected",
        "blocking_reasons": (
            "all_candidates_rejected",
            "no_high_quality_candidates",
        ),
        "accepted": 0,
        "rejected": 1,
        "high_quality": 0,
        "summary": (
            "blocked: status=rejected; "
            "reasons=all_candidates_rejected,no_high_quality_candidates; "
            "accepted=0; rejected=1; high_quality=0"
        ),
    }


def test_observation_batch_quality_requires_high_confidence_for_archive_ready() -> None:
    report = evaluate_observation_batch_quality(
        [
            {
                "content": "The user wants direct status updates.",
                "confidence": 0.0,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            },
            {
                "content": "The user wants bilingual docs.",
                "confidence": 0.8,
                "kind": "preference",
                "source_turn_id": "turn-2",
                "metadata": {"evidence": ["turn-2"]},
            },
        ]
    )

    assert report.status == "mixed"
    assert report.archive_ready is False
    assert report.archive_readiness.ready is False
    assert report.accepted_candidates == 2
    assert report.rejected_candidates == 0
    assert report.high_quality_candidates == 0
    assert report.average_quality_score == 0.88
    assert [quality.confidence_value for quality in report.qualities] == [0.0, 0.8]
    assert report.issues == ("low_quality_candidates", "no_high_quality_candidates")
    assert report.archive_readiness.to_dict() == {
        "ready": False,
        "status": "mixed",
        "accepted": 2,
        "rejected": 0,
        "high_quality": 0,
        "average_quality_score": 0.88,
        "blocking_reasons": (
            "low_confidence_candidates",
            "low_quality_candidates",
            "no_high_quality_candidates",
        ),
    }


def test_observation_archive_gate_blocks_low_confidence_projection() -> None:
    report = evaluate_observation_batch_quality(
        [
            {
                "content": "The user wants direct status updates.",
                "confidence": 0.0,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            },
            {
                "content": "The user wants bilingual docs.",
                "confidence": 0.8,
                "kind": "preference",
                "source_turn_id": "turn-2",
                "metadata": {"evidence": ["turn-2"]},
            },
        ]
    )

    decision = decide_observation_archive_gate(report.archive_readiness)

    assert decision.to_dict() == {
        "allowed": False,
        "status": "mixed",
        "blocking_reasons": (
            "low_confidence_candidates",
            "low_quality_candidates",
            "no_high_quality_candidates",
        ),
        "accepted": 2,
        "rejected": 0,
        "high_quality": 0,
        "summary": (
            "blocked: status=mixed; "
            "reasons=low_confidence_candidates,"
            "low_quality_candidates,no_high_quality_candidates; "
            "accepted=2; rejected=0; high_quality=0"
        ),
    }


@pytest.mark.parametrize(
    ("case_name", "candidates", "expected_readiness", "expected_decision"),
    [
        (
            "high_quality",
            [
                {
                    "content": "The user wants bilingual release notes.",
                    "confidence": 0.99,
                    "kind": "preference",
                    "source_turn_id": "turn-10",
                    "metadata": {"evidence_refs": ["turn-10"]},
                }
            ],
            {
                "ready": True,
                "status": "high_quality",
                "accepted": 1,
                "rejected": 0,
                "high_quality": 1,
                "average_quality_score": 0.998,
                "blocking_reasons": (),
            },
            {
                "allowed": True,
                "status": "high_quality",
                "blocking_reasons": (),
                "accepted": 1,
                "rejected": 0,
                "high_quality": 1,
                "summary": (
                    "allowed: status=high_quality; reasons=none; "
                    "accepted=1; rejected=0; high_quality=1"
                ),
            },
        ),
        (
            "mixed",
            [
                {
                    "content": "The user wants bilingual release notes.",
                    "confidence": 0.95,
                    "kind": "preference",
                    "source_turn_id": "turn-11",
                    "metadata": {"evidence": ["turn-11"]},
                },
                {
                    "content": "The user prefers direct status updates.",
                    "confidence": 0.89,
                    "kind": "preference",
                    "source_turn_id": "turn-12",
                    "metadata": {"evidence": ["turn-12"]},
                },
                {
                    "content": " ",
                    "confidence": 0.9,
                    "kind": "fact",
                    "source_turn_id": "turn-13",
                    "metadata": {"evidence": ["turn-13"]},
                },
            ],
            {
                "ready": False,
                "status": "mixed",
                "accepted": 2,
                "rejected": 1,
                "high_quality": 1,
                "average_quality_score": 0.984,
                "blocking_reasons": (
                    "mixed_batch",
                    "rejected_candidates",
                    "low_confidence_candidates",
                    "low_quality_candidates",
                ),
            },
            {
                "allowed": False,
                "status": "mixed",
                "blocking_reasons": (
                    "mixed_batch",
                    "rejected_candidates",
                    "low_confidence_candidates",
                    "low_quality_candidates",
                ),
                "accepted": 2,
                "rejected": 1,
                "high_quality": 1,
                "summary": (
                    "blocked: status=mixed; "
                    "reasons=mixed_batch,rejected_candidates,"
                    "low_confidence_candidates,low_quality_candidates; "
                    "accepted=2; rejected=1; high_quality=1"
                ),
            },
        ),
        (
            "rejected",
            [
                {
                    "content": "The user prefers terse summaries.",
                    "confidence": True,
                    "kind": "preference",
                    "source_turn_id": "turn-14",
                    "metadata": {"evidence": ["turn-14"]},
                },
                {
                    "content": "",
                    "confidence": 0.99,
                    "kind": "fact",
                    "source_turn_id": "turn-15",
                    "metadata": {"evidence": ["turn-15"]},
                },
            ],
            {
                "ready": False,
                "status": "rejected",
                "accepted": 0,
                "rejected": 2,
                "high_quality": 0,
                "average_quality_score": 0.0,
                "blocking_reasons": (
                    "all_candidates_rejected",
                    "no_high_quality_candidates",
                ),
            },
            {
                "allowed": False,
                "status": "rejected",
                "blocking_reasons": (
                    "all_candidates_rejected",
                    "no_high_quality_candidates",
                ),
                "accepted": 0,
                "rejected": 2,
                "high_quality": 0,
                "summary": (
                    "blocked: status=rejected; "
                    "reasons=all_candidates_rejected,no_high_quality_candidates; "
                    "accepted=0; rejected=2; high_quality=0"
                ),
            },
        ),
    ],
)
def test_observation_archive_gate_semantic_snapshots_are_stable(
    case_name: str,
    candidates: list[object],
    expected_readiness: dict[str, object],
    expected_decision: dict[str, object],
) -> None:
    report = evaluate_observation_batch_quality(candidates)
    decision = decide_observation_archive_gate(report.archive_readiness)

    assert case_name in {"high_quality", "mixed", "rejected"}
    assert report.archive_readiness.to_dict() == expected_readiness
    assert decision.to_dict() == expected_decision


def test_observation_archive_gate_report_deduplicates_reasons_in_stable_order() -> None:
    mixed_a = _mixed_archive_gate_decision()
    mixed_b = _mixed_archive_gate_decision()
    low_confidence = _low_confidence_archive_gate_decision()
    allowed = _allowed_archive_gate_decision()

    report = build_observation_archive_gate_report(
        (
            ("mixed-z", mixed_b),
            ("allowed", allowed),
            ("low-confidence", low_confidence),
            ("mixed-a", mixed_a),
        )
    )

    assert report.to_dict() == {
        "total_count": 4,
        "allowed_count": 1,
        "blocked_count": 3,
        "allowed_ids": ("allowed",),
        "blocked_ids": ("low-confidence", "mixed-a", "mixed-z"),
        "reason_codes": (
            "mixed_batch",
            "rejected_candidates",
            "low_confidence_candidates",
            "low_quality_candidates",
            "no_high_quality_candidates",
        ),
        "decisions": (
            _archive_gate_snapshot("allowed", allowed),
            _archive_gate_snapshot("low-confidence", low_confidence),
            _archive_gate_snapshot("mixed-a", mixed_a),
            _archive_gate_snapshot("mixed-z", mixed_b),
        ),
    }


def test_observation_archive_gate_report_allows_all_decisions() -> None:
    batch_a = _allowed_archive_gate_decision()
    batch_b = _allowed_archive_gate_decision()

    report = build_observation_archive_gate_report(
        {
            "batch-b": batch_b,
            "batch-a": batch_a,
        }
    )

    assert report.to_dict() == {
        "total_count": 2,
        "allowed_count": 2,
        "blocked_count": 0,
        "allowed_ids": ("batch-a", "batch-b"),
        "blocked_ids": (),
        "reason_codes": (),
        "decisions": (
            _archive_gate_snapshot("batch-a", batch_a),
            _archive_gate_snapshot("batch-b", batch_b),
        ),
    }


def test_observation_archive_gate_report_handles_mixed_decisions() -> None:
    allowed = _allowed_archive_gate_decision()
    mixed = _mixed_archive_gate_decision()
    rejected = _rejected_archive_gate_decision()

    report = build_observation_archive_gate_report(
        (
            ("batch-c", rejected),
            ("batch-a", allowed),
            ("batch-b", mixed),
        )
    )

    assert report.to_dict() == {
        "total_count": 3,
        "allowed_count": 1,
        "blocked_count": 2,
        "allowed_ids": ("batch-a",),
        "blocked_ids": ("batch-b", "batch-c"),
        "reason_codes": (
            "all_candidates_rejected",
            "mixed_batch",
            "rejected_candidates",
            "low_confidence_candidates",
            "low_quality_candidates",
            "no_high_quality_candidates",
        ),
        "decisions": (
            _archive_gate_snapshot("batch-a", allowed),
            _archive_gate_snapshot("batch-b", mixed),
            _archive_gate_snapshot("batch-c", rejected),
        ),
    }


def test_observation_archive_gate_report_blocks_all_decisions() -> None:
    low_confidence = _low_confidence_archive_gate_decision()
    rejected = _rejected_archive_gate_decision()

    report = build_observation_archive_gate_report(
        {
            "blocked-z": rejected,
            "blocked-a": low_confidence,
        }
    )

    assert report.to_dict() == {
        "total_count": 2,
        "allowed_count": 0,
        "blocked_count": 2,
        "allowed_ids": (),
        "blocked_ids": ("blocked-a", "blocked-z"),
        "reason_codes": (
            "all_candidates_rejected",
            "low_confidence_candidates",
            "low_quality_candidates",
            "no_high_quality_candidates",
        ),
        "decisions": (
            _archive_gate_snapshot("blocked-a", low_confidence),
            _archive_gate_snapshot("blocked-z", rejected),
        ),
    }


def test_observation_archive_gate_report_handles_empty_input() -> None:
    report = build_observation_archive_gate_report({})

    assert report.to_dict() == {
        "total_count": 0,
        "allowed_count": 0,
        "blocked_count": 0,
        "allowed_ids": (),
        "blocked_ids": (),
        "reason_codes": (),
        "decisions": (),
    }


def test_observation_archive_gate_report_rejects_blank_and_duplicate_gate_ids() -> None:
    allowed = _allowed_archive_gate_decision()

    with pytest.raises(ValueError, match="archive gate decision id must be non-empty"):
        build_observation_archive_gate_report(((" ", allowed),))

    with pytest.raises(ValueError, match="duplicate archive gate decision id: batch-a"):
        build_observation_archive_gate_report(
            (
                ("batch-a", allowed),
                (" batch-a ", allowed),
            )
        )


@pytest.mark.parametrize("decision", [None, {"allowed": True}, object()])
def test_observation_archive_gate_report_rejects_invalid_decision_values(
    decision: object,
) -> None:
    with pytest.raises(
        TypeError,
        match="archive gate decision must be an ObservationArchiveGateDecision",
    ):
        build_observation_archive_gate_report((("batch-a", decision),))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "candidates",
    [
        {"content": "The user wants direct updates.", "confidence": 0.9},
        "not-a-candidate-batch",
        b"not-a-candidate-batch",
        object(),
    ],
)
def test_observation_batch_quality_rejects_non_batch_candidate_inputs(
    candidates: object,
) -> None:
    with pytest.raises(TypeError, match="candidates must be an iterable of observation candidates"):
        evaluate_observation_batch_quality(candidates)  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="candidates must be an iterable of observation candidates"):
        evaluate_observation_candidates_quality(candidates)  # type: ignore[arg-type]


def test_observation_batch_quality_materializes_candidate_generators_once() -> None:
    def candidate_generator():
        yield {
            "content": "The user wants bilingual docs.",
            "confidence": 0.95,
            "kind": "preference",
            "source_turn_id": "turn-1",
            "metadata": {"evidence": ["turn-1"]},
        }
        yield {
            "content": " ",
            "confidence": 0.9,
            "kind": "fact",
            "source_turn_id": "turn-2",
            "metadata": {"evidence": ["turn-2"]},
        }

    report = evaluate_observation_batch_quality(candidate_generator())
    decision = decide_observation_archive_gate(report.archive_readiness)

    assert report.archive_readiness.to_dict() == {
        "ready": False,
        "status": "mixed",
        "accepted": 1,
        "rejected": 1,
        "high_quality": 1,
        "average_quality_score": 0.99,
        "blocking_reasons": ("mixed_batch", "rejected_candidates"),
    }
    assert report.issues == ("rejected_candidates",)
    assert [quality.issues for quality in report.qualities] == [(), ("missing_content",)]
    assert decision.to_dict() == {
        "allowed": False,
        "status": "mixed",
        "blocking_reasons": ("mixed_batch", "rejected_candidates"),
        "accepted": 1,
        "rejected": 1,
        "high_quality": 1,
        "summary": (
            "blocked: status=mixed; reasons=mixed_batch,rejected_candidates; "
            "accepted=1; rejected=1; high_quality=1"
        ),
    }


def test_observation_archive_gate_report_accepts_decision_generators() -> None:
    allowed = _allowed_archive_gate_decision()
    mixed = _mixed_archive_gate_decision()

    def decision_generator():
        yield ("batch-z", mixed)
        yield ("batch-a", allowed)

    report = build_observation_archive_gate_report(decision_generator())

    assert report.to_dict() == {
        "total_count": 2,
        "allowed_count": 1,
        "blocked_count": 1,
        "allowed_ids": ("batch-a",),
        "blocked_ids": ("batch-z",),
        "reason_codes": (
            "mixed_batch",
            "rejected_candidates",
            "low_confidence_candidates",
            "low_quality_candidates",
        ),
        "decisions": (
            _archive_gate_snapshot("batch-a", allowed),
            _archive_gate_snapshot("batch-z", mixed),
        ),
    }


def test_observation_batch_quality_rejected_candidates_do_not_raise_average() -> None:
    report = evaluate_observation_batch_quality(
        [
            {
                "content": "The user wants brief summaries.",
                "confidence": False,
                "kind": "preference",
                "source_turn_id": "turn-1",
                "metadata": {"evidence": ["turn-1"]},
            },
            {
                "content": "The user wants bilingual docs.",
                "confidence": 1.1,
                "kind": "preference",
                "source_turn_id": "turn-2",
                "metadata": {"evidence": ["turn-2"]},
            },
            {
                "content": "The user wants concise status.",
                "confidence": -0.1,
                "kind": "preference",
                "source_turn_id": "turn-3",
                "metadata": {"evidence": ["turn-3"]},
            },
            {
                "content": "The user wants factual updates.",
                "confidence": float("nan"),
                "kind": "preference",
                "source_turn_id": "turn-4",
                "metadata": {"evidence": ["turn-4"]},
            },
        ]
    )

    assert report.status == "rejected"
    assert report.archive_ready is False
    assert report.archive_readiness.ready is False
    assert report.accepted_candidates == 0
    assert report.rejected_candidates == 4
    assert report.high_quality_candidates == 0
    assert report.average_quality_score == 0.0
    assert report.archive_readiness.to_dict() == {
        "ready": False,
        "status": "rejected",
        "accepted": 0,
        "rejected": 4,
        "high_quality": 0,
        "average_quality_score": 0.0,
        "blocking_reasons": (
            "all_candidates_rejected",
            "no_high_quality_candidates",
        ),
    }
    assert report.qualities[0].issues == ("missing_confidence",)
    assert [quality.issues for quality in report.qualities[1:]] == [
        ("invalid_confidence",),
        ("invalid_confidence",),
        ("invalid_confidence",),
    ]


def test_observation_candidate_rejects_invalid_wire_schema() -> None:
    with pytest.raises(ValueError, match="candidate.content"):
        normalize_observation_candidate({"content": " ", "confidence": 0.5})

    with pytest.raises(TypeError, match="candidate.metadata"):
        normalize_observation_candidate({"content": "valid", "confidence": 0.5, "metadata": "bad"})

    with pytest.raises(TypeError, match="candidate.source_turn_id"):
        normalize_observation_candidate(
            {"content": "valid", "confidence": 0.5, "source_turn_id": 123}
        )

    with pytest.raises(TypeError, match="observer.observe"):
        normalize_observation_candidates({"content": "valid", "confidence": 0.5})  # type: ignore[arg-type]


async def test_observer_failure_does_not_affect_main_path() -> None:
    class FailingObserver:
        async def observe(self, turn: object) -> list[ObservationCandidate]:
            raise RuntimeError("upstream model unavailable")

    candidates = await observe_safely(
        FailingObserver(),
        {"content": "this should not block memory_store", "role": "user"},
    )

    assert candidates == []


async def test_observe_safely_normalizes_wire_candidates() -> None:
    class WireObserver:
        async def observe(self, turn: object) -> list[dict[str, object]]:
            assert isinstance(turn, ObservationTurn)
            return [
                {
                    "content": "The user prefers Chinese summaries.",
                    "confidence": 0.75,
                    "kind": "preference",
                    "source_turn_id": "turn-1",
                    "metadata": {"source": "fixture"},
                }
            ]

    candidates = await observe_safely(
        WireObserver(),  # type: ignore[arg-type]
        {"content": "用户喜欢中文总结", "role": "user", "turn_id": "turn-1"},
    )

    assert len(candidates) == 1
    assert candidates[0].content == "The user prefers Chinese summaries."
    assert candidates[0].confidence == 0.75
    assert candidates[0].kind == "preference"
    assert candidates[0].source_turn_id == "turn-1"
    assert candidates[0].metadata == {"source": "fixture"}


async def test_observe_safely_drops_invalid_candidate_output() -> None:
    class InvalidObserver:
        async def observe(self, turn: object) -> list[dict[str, object]]:
            return [{"content": "", "confidence": 0.9, "kind": "fact"}]

    candidates = await observe_safely(
        InvalidObserver(),  # type: ignore[arg-type]
        {"content": "this should not leak invalid observer output", "role": "user"},
    )

    assert candidates == []


async def test_observe_safely_keeps_valid_candidates_when_one_candidate_is_invalid() -> None:
    class MixedObserver:
        async def observe(self, turn: object) -> list[dict[str, object]]:
            return [
                {
                    "content": "The user prefers direct status updates.",
                    "confidence": 0.8,
                    "kind": "preference",
                },
                {"content": "", "confidence": 0.9, "kind": "fact"},
                {
                    "content": "The user wants bilingual docs.",
                    "confidence": 0.95,
                    "kind": "preference",
                },
            ]

    candidates = await observe_safely(
        MixedObserver(),  # type: ignore[arg-type]
        {"content": "remember my preferences", "role": "user"},
    )

    assert [candidate.content for candidate in candidates] == [
        "The user prefers direct status updates.",
        "The user wants bilingual docs.",
    ]


# ----------------------------------------------------------------- L3a observer -


def _llm_caller_json_response(base_url: str, api_key: str, payload: bytes) -> str:
    """Fake LLM caller returning valid JSON."""
    return json.dumps(
        {
            "patterns": [
                "User consistently prefers Chinese summaries",
                "User has a habit of asking for unit tests before implementation",
            ],
            "suggestions": [
                "Default to Chinese-language summaries in profile",
                "Proactively suggest test-first workflow in planning phase",
            ],
            "confidence": 0.87,
        }
    )


def _llm_caller_invalid_json(base_url: str, api_key: str, payload: bytes) -> str:
    """Fake LLM caller returning invalid JSON."""
    return "not valid json { broken"


def _llm_caller_empty_response(base_url: str, api_key: str, payload: bytes) -> str:
    """Fake LLM caller returning empty JSON."""
    return "{}"


def _llm_caller_network_error(base_url: str, api_key: str, payload: bytes) -> str:
    """Fake LLM caller that raises a network error."""
    raise OSError("connection refused")


# -- ObserverConfig tests --


def test_observer_config_defaults() -> None:
    cfg = ObserverConfig()
    assert cfg.model == "deepseek-v4-flash"
    assert cfg.api_key == ""
    assert cfg.frequency == 10
    assert cfg.base_url == "https://api.deepseek.com/v1/chat/completions"


def test_observer_config_custom_values() -> None:
    cfg = ObserverConfig(
        model="custom-model",
        api_key="test-key",
        frequency=5,
        base_url="https://example.com/api",
    )
    assert cfg.model == "custom-model"
    assert cfg.api_key == "test-key"
    assert cfg.frequency == 5
    assert cfg.base_url == "https://example.com/api"


def test_observer_config_is_immutable() -> None:
    cfg = ObserverConfig(frequency=3)
    with pytest.raises(AttributeError):
        cfg.frequency = 7  # type: ignore[misc]


def test_observer_config_rejects_invalid_frequency() -> None:
    with pytest.raises(ValueError, match="ObserverConfig.frequency must be >= 1"):
        ObserverConfig(frequency=0)

    with pytest.raises(ValueError, match="ObserverConfig.frequency must be >= 1"):
        ObserverConfig(frequency=-1)


# -- L3aObserver frequency control tests --


async def test_l3a_observer_no_llm_before_frequency_threshold() -> None:
    """LLM should not be called before the frequency threshold (10 turns)."""
    call_log: list[object] = []

    def tracking_caller(base_url: str, api_key: str, payload: bytes) -> str:
        call_log.append(payload)
        return _llm_caller_json_response(base_url, api_key, payload)

    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=10),
        _llm_caller=tracking_caller,
    )

    for i in range(9):
        candidates = await observer.observe(
            {"content": f"turn {i + 1}: I prefer Chinese summaries", "role": "user"}
        )
        # Should have deterministic candidates
        assert any("Chinese" in c.content for c in candidates)

    assert len(call_log) == 0  # LLM never called


async def test_l3a_observer_triggers_llm_at_frequency_boundary() -> None:
    """LLM should be called exactly at the frequency boundary."""
    call_log: list[object] = []

    def tracking_caller(base_url: str, api_key: str, payload: bytes) -> str:
        call_log.append(payload)
        return _llm_caller_json_response(base_url, api_key, payload)

    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=5),
        _llm_caller=tracking_caller,
    )

    for i in range(5):
        await observer.observe(
            {"content": f"turn {i + 1}: remember I prefer Chinese", "role": "user"}
        )

    assert len(call_log) == 1  # Called at turn 5


async def test_l3a_observer_no_api_key_skips_llm() -> None:
    """When api_key is empty, LLM should never be called."""
    call_log: list[object] = []

    def tracking_caller(base_url: str, api_key: str, payload: bytes) -> str:
        call_log.append(payload)
        return "{}"

    observer = L3aObserver(
        ObserverConfig(api_key="", frequency=1),
        _llm_caller=tracking_caller,
    )

    # Even with frequency=1, no API key means no LLM call
    for _ in range(5):
        await observer.observe({"content": "I prefer concise updates", "role": "user"})

    assert len(call_log) == 0


async def test_l3a_observer_yields_deterministic_plus_llm_candidates() -> None:
    """At frequency boundary, output includes both deterministic + LLM candidates."""
    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=3),
        _llm_caller=_llm_caller_json_response,
    )

    for i in range(2):
        await observer.observe({"content": f"turn {i + 1}: hello", "role": "user"})

    # Turn 3 triggers LLM
    candidates = await observer.observe(
        {"content": "remember I prefer Chinese", "role": "user"}
    )

    # Should have deterministic candidate + LLM candidates
    deterministic = [c for c in candidates if c.metadata.get("source") != "l3a_observer"]
    llm_candidates = [c for c in candidates if c.metadata.get("source") == "l3a_observer"]

    assert len(deterministic) >= 1
    assert len(llm_candidates) >= 2  # 2 patterns + 2 suggestions


async def test_l3a_observer_llm_failure_is_silent() -> None:
    """Network failure in LLM should not raise — just fall back to deterministic."""
    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=1),
        _llm_caller=_llm_caller_network_error,
    )

    candidates = await observer.observe(
        {"content": "remember I prefer Chinese summaries", "role": "user"}
    )

    # Should still have deterministic candidates
    assert len(candidates) >= 1
    assert all(c.metadata.get("source") != "l3a_observer" for c in candidates)


async def test_l3a_observer_invalid_json_is_silent() -> None:
    """Invalid JSON from LLM should not raise — just skip LLM candidates."""
    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=1),
        _llm_caller=_llm_caller_invalid_json,
    )

    candidates = await observer.observe(
        {"content": "remember I prefer Chinese summaries", "role": "user"}
    )

    # Should still have deterministic candidates but no LLM extras
    assert len(candidates) >= 1
    assert all(c.metadata.get("source") != "l3a_observer" for c in candidates)


# -- L3aObserver implements MemoryObserver protocol --


async def test_l3a_observer_satisfies_memory_observer_protocol() -> None:
    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=10),
        _llm_caller=_llm_caller_json_response,
    )
    assert isinstance(observer, MemoryObserver)


# -- _call_deepseek_api function tests --


async def test_call_deepseek_api_with_mock() -> None:
    """Test _call_deepseek_api by injecting a custom handler."""

    def fake_urlopen(req, timeout=None):
        class FakeResponse:
            def read(self):
                return json.dumps(
                    {
                        "choices": [
                            {
                        "message": {
                            "content": '{"patterns":[],"suggestions":[],"confidence":0.5}'
                        }
                    }
                        ]
                    }
                ).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        return FakeResponse()

    import quilin_mem.observer as obs_mod

    original = getattr(obs_mod, "urlopen", None)
    obs_mod.urlopen = fake_urlopen  # type: ignore[attr-defined]
    try:
        result = _call_deepseek_api(
            "https://test.example.com/v1/chat",
            "test-key",
            b'{"model":"test"}',
        )
        assert "patterns" in result
    finally:
        if original is not None:
            obs_mod.urlopen = original


# -- _format_turn_buffer tests --


def test_format_turn_buffer_basic() -> None:
    turns = [
        ObservationTurn(content="I prefer Chinese", role="user", turn_id="t1"),
        ObservationTurn(content="Understood.", role="assistant", turn_id="t2"),
        ObservationTurn(content="请保持简洁", role="user", turn_id="t3"),
    ]
    formatted = _format_turn_buffer(turns)

    assert "[Turn 1] (user): I prefer Chinese" in formatted
    assert "[Turn 2] (assistant): Understood." in formatted
    assert "[Turn 3] (user): 请保持简洁" in formatted


def test_format_turn_buffer_empty() -> None:
    assert _format_turn_buffer([]) == ""


def test_format_turn_buffer_unknown_role() -> None:
    turns = [ObservationTurn(content="hello", role="unknown", turn_id="t1")]
    formatted = _format_turn_buffer(turns)
    assert "(message)" in formatted


def test_format_turn_buffer_truncates_long_content() -> None:
    long_content = "x" * 500
    turns = [ObservationTurn(content=long_content, role="user")]
    formatted = _format_turn_buffer(turns)
    assert len(formatted) < 500  # Should be truncated


# -- _parse_l3a_llm_response tests --


def test_parse_l3a_llm_response_valid() -> None:
    buffer = [ObservationTurn(content="test", role="user", turn_id="t1")]
    raw = json.dumps(
        {
            "patterns": ["User prefers short answers", "User likes Chinese"],
            "suggestions": ["Set default language to zh"],
            "confidence": 0.85,
        }
    )

    candidates = _parse_l3a_llm_response(raw, buffer)

    assert len(candidates) == 3  # 2 patterns + 1 suggestion
    pattern_candidates = [c for c in candidates if c.kind == "preference"]
    suggestion_candidates = [c for c in candidates if c.kind == "intent"]

    assert len(pattern_candidates) == 2
    assert len(suggestion_candidates) == 1
    assert all(c.confidence == 0.85 for c in pattern_candidates)
    assert suggestion_candidates[0].confidence == round(0.85 * 0.9, 3)
    assert all(c.metadata["source"] == "l3a_observer" for c in candidates)
    assert all(c.metadata["observer_version"] == "l3a-observer-v1" for c in candidates)
    assert all(c.source_turn_id == "t1" for c in candidates)


def test_parse_l3a_llm_response_invalid_json() -> None:
    buffer = [ObservationTurn(content="test", role="user")]
    candidates = _parse_l3a_llm_response("not json", buffer)
    assert candidates == []


def test_parse_l3a_llm_response_non_dict() -> None:
    buffer = [ObservationTurn(content="test", role="user")]
    candidates = _parse_l3a_llm_response('["not a dict"]', buffer)
    assert candidates == []


def test_parse_l3a_llm_response_empty_object() -> None:
    buffer = [ObservationTurn(content="test", role="user")]
    candidates = _parse_l3a_llm_response("{}", buffer)
    assert candidates == []


def test_parse_l3a_llm_response_clamps_confidence() -> None:
    buffer = [ObservationTurn(content="test", role="user")]
    raw = json.dumps({"patterns": ["test"], "confidence": 1.5})
    candidates = _parse_l3a_llm_response(raw, buffer)
    # confidence gets clamped to 1.0 (max)
    assert candidates[0].confidence == 1.0

    raw2 = json.dumps({"patterns": ["test"], "confidence": -0.5})
    candidates2 = _parse_l3a_llm_response(raw2, buffer)
    # Negative gets clamped to 0.0
    assert candidates2[0].confidence == 0.0


def test_parse_l3a_llm_response_filters_non_string_items() -> None:
    buffer = [ObservationTurn(content="test", role="user")]
    raw = json.dumps(
        {
            "patterns": ["valid pattern", 123, None, "  ", "another pattern"],
            "suggestions": [],
            "confidence": 0.5,
        }
    )
    candidates = _parse_l3a_llm_response(raw, buffer)

    pattern_contents = [c.content for c in candidates if c.kind == "preference"]
    assert len(pattern_contents) == 2
    assert any("valid pattern" in content for content in pattern_contents)


def test_parse_l3a_llm_response_null_source_turn_id_when_buffer_empty() -> None:
    candidates = _parse_l3a_llm_response(
        json.dumps({"patterns": ["test"], "confidence": 0.5}),
        [],
    )
    assert candidates[0].source_turn_id is None


# -- L3aObserver + ProfileUpdater integration tests --


async def test_l3a_observer_calls_profile_updater_on_high_confidence_patterns(
    tmp_path: object,
) -> None:
    """L3aObserver should write high-confidence patterns to profile via ProfileUpdater."""
    from pathlib import Path as _Path

    from quilin_mem.profile_store import ProfileStore
    from quilin_mem.profile_updater import ProfileUpdater

    store = ProfileStore(str(_Path(str(tmp_path)) / "memory.db"))
    updater = ProfileUpdater(store)

    # Patch user.md path
    user_md_dir = _Path(str(tmp_path)) / ".quilin"
    import quilin_mem.profile_updater as pu

    orig_dir = pu._USER_MD_DIR
    orig_path = pu._USER_MD_PATH
    pu._USER_MD_DIR = user_md_dir
    pu._USER_MD_PATH = user_md_dir / "user.md"
    try:
        observer = L3aObserver(
            ObserverConfig(api_key="test-key", frequency=2),
            profile_updater=updater,
            _llm_caller=_llm_caller_json_response,
        )

        # Fill two turns to trigger LLM
        await observer.observe({"content": "I prefer Chinese summaries", "role": "user"})
        candidates = await observer.observe(
            {"content": "Please keep updates concise", "role": "user"}
        )

        # Verify LLM candidates were produced
        llm_candidates = [
            c for c in candidates if c.metadata.get("source") == "l3a_observer"
        ]
        assert len(llm_candidates) >= 2, "Expected LLM candidates"

        # Verify profile was updated
        profile = store.get_profile("default")
        assert profile is not None, "Profile should exist after L3a write"
        assert (
            "observer_l3a_finding" in profile.non_sensitive
        ), "observer_l3a_finding should be in non_sensitive"

        # Verify user.md was synchronized
        user_md_path = user_md_dir / "user.md"
        assert user_md_path.exists(), "user.md should exist after L3a write"
        content = user_md_path.read_text(encoding="utf-8")
        assert "observer_l3a_finding" in content
        assert "# 关于用户" in content
    finally:
        pu._USER_MD_DIR = orig_dir
        pu._USER_MD_PATH = orig_path


async def test_l3a_observer_skips_low_confidence_candidates_for_profile(
    tmp_path: object,
) -> None:
    """Candidates with confidence < 0.7 should NOT be written to profile."""
    from pathlib import Path as _Path

    from quilin_mem.profile_store import ProfileStore
    from quilin_mem.profile_updater import ProfileUpdater

    store = ProfileStore(str(_Path(str(tmp_path)) / "memory.db"))
    updater = ProfileUpdater(store)

    def low_confidence_llm(
        base_url: str, api_key: str, payload: bytes  # noqa: ARG001
    ) -> str:
        return json.dumps(
            {
                "patterns": ["User seems slightly more engaged on Mondays"],
                "suggestions": [],
                "confidence": 0.3,  # below 0.7 threshold
            }
        )

    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=1),
        profile_updater=updater,
        _llm_caller=low_confidence_llm,
    )

    await observer.observe({"content": "hello", "role": "user"})

    # Profile should not have been created (all low confidence)
    profile = store.get_profile("default")
    assert profile is None, "Low-confidence patterns should not create profile"


async def test_l3a_observer_apply_to_profile_survives_updater_errors(
    tmp_path: object,
) -> None:
    """_apply_to_profile should catch exceptions silently (best-effort)."""
    class BrokenUpdater:
        def apply_signal(self, *args: object, **kwargs: object) -> None:
            msg = "disk full"
            raise OSError(msg)

        # No bulk_update — triggers the hasattr fallback path
        def __getattr__(self, name: str) -> object:
            if name == "bulk_update":
                raise AttributeError(name)
            return object.__getattribute__(self, name)

    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=1),
        profile_updater=BrokenUpdater(),
        _llm_caller=_llm_caller_json_response,
    )

    # Should not raise — profile update is best-effort
    candidates = await observer.observe(
        {"content": "I prefer concise updates", "role": "user"}
    )
    assert len(candidates) >= 1  # deterministic candidates still returned


async def test_l3a_observer_without_profile_updater_still_returns_candidates() -> None:
    """When profile_updater is None, observe() should still work fine."""
    observer = L3aObserver(
        ObserverConfig(api_key="test-key", frequency=1),
        profile_updater=None,
        _llm_caller=_llm_caller_json_response,
    )

    candidates = await observer.observe(
        {"content": "I prefer concise updates", "role": "user"}
    )

    # Should have deterministic + LLM candidates (not blocked by missing updater)
    assert len(candidates) >= 1
    llm_candidates = [
        c for c in candidates if c.metadata.get("source") == "l3a_observer"
    ]
    assert len(llm_candidates) >= 2
