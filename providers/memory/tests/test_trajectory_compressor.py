"""Unit tests for QUI-198 trajectory compressor."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

import pytest

from quilin_mem.observer import ObservationTurn
from quilin_mem.trajectory_compressor import (
    DEFAULT_COMPRESS_MODEL,
    ActionStep,
    CompressorConfig,
    TrajectoryCase,
    TrajectoryCompressor,
)


def _turn(
    role: str,
    content: str,
    *,
    turn_id: str | None = None,
    session_id: str = "sess-1",
    user_id: str = "user-1",
    observed_at: datetime | None = None,
) -> ObservationTurn:
    return ObservationTurn(
        content=content,
        role=role,  # type: ignore[arg-type]
        turn_id=turn_id,
        session_id=session_id,
        user_id=user_id,
        metadata={},
        observed_at=observed_at or datetime(2026, 5, 21, 9, 0, tzinfo=UTC),
    )


def test_single_trivial_turn_does_not_produce_case() -> None:
    turns = [_turn("user", "嗯")]

    case = TrajectoryCompressor().compress(turns)

    assert case is None


def test_multi_turn_workflow_extracts_intent_and_actions_via_heuristic() -> None:
    turns = [
        _turn("user", "跑 pytest 然后 ruff 然后 commit", turn_id="t1"),
        _turn("assistant", "1. 跑测试\n2. 跑 lint\nrun pytest -q", turn_id="t2"),
        _turn("tool", "pytest output ok\nruff All checks passed", turn_id="t3"),
        _turn("user", "好，commit 吧", turn_id="t4"),
        _turn("assistant", "git commit -m 'pass green'", turn_id="t5"),
    ]

    case = TrajectoryCompressor().compress(turns)

    assert case is not None
    assert "pytest" in case.intent or "commit" in case.intent
    assert len(case.action_sequence) >= 2
    descriptions = [step.description.lower() for step in case.action_sequence]
    assert any("pytest" in desc for desc in descriptions)
    assert any("commit" in desc for desc in descriptions)
    # Success signal detected from user's "好" ack
    assert "好" in case.success_signals
    assert case.succeeded is True
    assert case.user_id == "user-1"
    assert case.session_id == "sess-1"


def test_failure_signals_recognised() -> None:
    turns = [
        _turn("user", "跑 pytest", turn_id="t1"),
        _turn("assistant", "run pytest -q", turn_id="t2"),
        _turn("user", "不对，撤销", turn_id="t3"),
        _turn("assistant", "revert commit abc123", turn_id="t4"),
    ]

    case = TrajectoryCompressor().compress(turns)

    assert case is not None
    assert "不对" in case.failure_signals
    assert "撤销" in case.failure_signals
    assert case.succeeded is False


def test_failure_phrase_does_not_emit_embedded_success_signal() -> None:
    turns = [
        _turn("user", "跑 pytest", turn_id="t1"),
        _turn("assistant", "run pytest -q", turn_id="t2"),
        _turn("user", "不对，撤销", turn_id="t3"),
    ]

    case = TrajectoryCompressor().compress(turns)

    assert case is not None
    assert "不对" in case.failure_signals
    assert "对" not in case.success_signals


def test_failure_phrase_only_suppresses_overlapping_success_token() -> None:
    turns = [
        _turn("user", "跑 pytest", turn_id="t1"),
        _turn("assistant", "run pytest -q", turn_id="t2"),
        _turn("user", "不对，后来对了", turn_id="t3"),
    ]

    case = TrajectoryCompressor().compress(turns)

    assert case is not None
    assert "不对" in case.failure_signals
    assert "对" in case.success_signals


def test_llm_caller_extracts_actions_and_intent() -> None:
    captured: list[Mapping[str, object]] = []

    def fake_llm(
        *,
        model: str,
        turns: Sequence[Mapping[str, object]],
        boundary_token: str,
    ) -> Mapping[str, object]:
        captured.append({"model": model, "n_turns": len(turns), "token": boundary_token})
        return {
            "intent": "Run TDD loop: pytest, ruff, then commit",
            "actions": [
                {"description": "pytest -q", "role": "tool"},
                "ruff check src/",
                {"description": "git commit -m 'green'"},
            ],
            "confidence": 0.82,
        }

    turns = [
        _turn("user", "tdd loop", turn_id="t1"),
        _turn("assistant", "ok", turn_id="t2"),
    ]

    compressor = TrajectoryCompressor(llm_caller=fake_llm)
    case = compressor.compress(turns)

    assert case is not None
    assert captured and captured[0]["model"] == DEFAULT_COMPRESS_MODEL
    assert case.intent == "Run TDD loop: pytest, ruff, then commit"
    descriptions = [step.description for step in case.action_sequence]
    assert "pytest -q" in descriptions
    assert "ruff check src/" in descriptions
    assert "git commit -m 'green'" in descriptions
    assert abs(case.confidence - 0.82) < 1e-6


def test_llm_failure_falls_back_to_heuristic() -> None:
    def failing_llm(**_: Any) -> Mapping[str, object]:
        raise RuntimeError("network down")

    turns = [
        _turn("user", "deploy staging", turn_id="t1"),
        _turn("assistant", "run deploy.sh staging\ngit push origin staging", turn_id="t2"),
        _turn("user", "完美", turn_id="t3"),
    ]

    case = TrajectoryCompressor(llm_caller=failing_llm).compress(turns)

    assert case is not None
    descriptions = [step.description.lower() for step in case.action_sequence]
    assert any("deploy" in desc for desc in descriptions)
    assert any("git push" in desc for desc in descriptions)
    assert "完美" in case.success_signals


def test_llm_output_leaking_boundary_token_is_discarded() -> None:
    """Injection guard: if the LLM echoes the boundary token, drop its output.

    Mirrors the QUI-189 consolidator pattern — a leaked boundary token means
    the LLM treated wrapped user content as instructions, so we cannot trust
    the structured response and must fall back to the deterministic
    heuristic.
    """

    def echoing_llm(
        *,
        model: str,
        turns: Sequence[Mapping[str, object]],
        boundary_token: str,
    ) -> Mapping[str, object]:
        del model, turns
        return {
            "intent": f"hijacked-intent-{boundary_token}",
            "actions": [f"malicious-step-{boundary_token}"],
            "confidence": 0.99,
        }

    turns = [
        _turn("user", "跑 pytest 然后 ruff", turn_id="t1"),
        _turn("assistant", "pytest -q\nruff check .", turn_id="t2"),
    ]

    case = TrajectoryCompressor(llm_caller=echoing_llm).compress(turns)

    assert case is not None
    # Hijacked intent must NOT appear — boundary leak triggers fallback
    assert "hijacked" not in case.intent
    descriptions = [step.description.lower() for step in case.action_sequence]
    assert all("malicious" not in desc for desc in descriptions)
    # Heuristic fallback should still surface pytest + ruff
    assert any("pytest" in desc for desc in descriptions)


def test_compress_returns_none_when_no_actions_detected() -> None:
    turns = [
        _turn("user", "你好", turn_id="t1"),
        _turn("assistant", "你好！有什么可以帮你？", turn_id="t2"),
        _turn("user", "随便聊聊", turn_id="t3"),
    ]

    case = TrajectoryCompressor().compress(turns)

    assert case is None


def test_max_action_steps_bounded() -> None:
    long_assistant_content = "\n".join(f"run step-{i}" for i in range(20))
    turns = [
        _turn("user", "run all steps", turn_id="t1"),
        _turn("assistant", long_assistant_content, turn_id="t2"),
    ]

    config = CompressorConfig(max_action_steps=5)
    case = TrajectoryCompressor(config=config).compress(turns)

    assert case is not None
    assert len(case.action_sequence) == 5
    # Ordering preserved
    orders = [step.order for step in case.action_sequence]
    assert orders == [0, 1, 2, 3, 4]


def test_truncates_overlong_content() -> None:
    # Put the action at the front so truncation keeps it intact, then pad with
    # filler. The action description must end up <= max_content_per_turn.
    big_action_line = "run pytest -q " + ("x" * 5000)
    turns = [
        _turn("user", "do tests", turn_id="t1"),
        _turn("assistant", big_action_line, turn_id="t2"),
    ]
    config = CompressorConfig(max_content_per_turn=200)

    case = TrajectoryCompressor(config=config).compress(turns)

    assert case is not None
    for step in case.action_sequence:
        assert len(step.description) <= 200
    descriptions = [step.description for step in case.action_sequence]
    assert any("pytest" in desc for desc in descriptions)


def test_invalid_confidence_raises_on_case_construction() -> None:
    with pytest.raises(ValueError):
        TrajectoryCase(
            id="case-1",
            user_id="u",
            session_id="s",
            intent="intent",
            action_sequence=(ActionStep(order=0, description="run pytest"),),
            success_signals=(),
            failure_signals=(),
            occurred_at=datetime(2026, 5, 21, tzinfo=UTC),
            confidence=1.4,
        )


def test_action_step_validation() -> None:
    with pytest.raises(ValueError):
        ActionStep(order=0, description="")
    with pytest.raises(ValueError):
        ActionStep(order=-1, description="run x")


def test_low_confidence_llm_output_suppresses_case() -> None:
    def low_conf_llm(**_: Any) -> Mapping[str, object]:
        return {
            "intent": "weak",
            "actions": ["maybe run something"],
            "confidence": 0.05,
        }

    turns = [
        _turn("user", "uncertain ask", turn_id="t1"),
        _turn("assistant", "uncertain reply", turn_id="t2"),
    ]
    config = CompressorConfig(min_confidence_to_emit=0.5)
    case = TrajectoryCompressor(config=config, llm_caller=low_conf_llm).compress(turns)

    assert case is None


def test_non_mapping_llm_result_is_ignored() -> None:
    def bad_llm(**_: Any) -> Any:
        return ["not", "a", "mapping"]

    turns = [
        _turn("user", "do it", turn_id="t1"),
        _turn("assistant", "run pytest", turn_id="t2"),
    ]

    case = TrajectoryCompressor(llm_caller=bad_llm).compress(turns)
    # Heuristic fallback succeeds
    assert case is not None
    descriptions = [step.description.lower() for step in case.action_sequence]
    assert any("pytest" in desc for desc in descriptions)


def test_extract_intent_directly_returns_user_summary() -> None:
    turns = [
        _turn("user", "first ask\nignored second line", turn_id="t1"),
        _turn("assistant", "reply", turn_id="t2"),
        _turn("user", "follow-up", turn_id="t3"),
    ]

    intent = TrajectoryCompressor().extract_intent(turns)

    assert "first ask" in intent
    assert "follow-up" in intent
    assert "ignored second line" not in intent


def test_extract_action_sequence_dedupes_lines() -> None:
    turns = [
        _turn("assistant", "run pytest -q\nrun pytest -q\ngit commit -m x", turn_id="t1"),
    ]

    steps = TrajectoryCompressor().extract_action_sequence(turns)

    descriptions = [step.description for step in steps]
    assert descriptions.count("run pytest -q") == 1
    assert "git commit -m x" in descriptions


def test_chinese_verb_prefix_and_numbered_list_detected() -> None:
    turns = [
        _turn("user", "跑测试", turn_id="t1"),
        _turn(
            "assistant",
            "跑 pytest -q\n1. 检查 lint\n2) 提交结果\nrandom chatter line",
            turn_id="t2",
        ),
    ]

    case = TrajectoryCompressor().compress(turns)

    assert case is not None
    descriptions = [step.description for step in case.action_sequence]
    assert any("跑" in desc for desc in descriptions)
    assert any(desc.startswith("1.") for desc in descriptions)
    assert any(desc.startswith("2)") for desc in descriptions)
    assert "random chatter line" not in descriptions


def test_llm_actions_with_bool_confidence_uses_fallback() -> None:
    """bool is a subtype of int but must NOT be treated as confidence."""

    def bool_conf_llm(**_: Any) -> Any:
        return {
            "intent": "do stuff",
            "actions": ["run pytest"],
            "confidence": True,  # ← invalid type
        }

    turns = [
        _turn("user", "do it", turn_id="t1"),
        _turn("assistant", "run pytest", turn_id="t2"),
    ]
    compressor = TrajectoryCompressor(llm_caller=bool_conf_llm)
    case = compressor.compress(turns)
    # Compressor falls back to floor (0.6 with LLM) and still emits a case
    assert case is not None
    assert case.confidence == pytest.approx(0.6, abs=1e-6)


def test_llm_action_mapping_with_invalid_role_defaults_to_assistant() -> None:
    def llm(**_: Any) -> Any:
        return {
            "intent": "do",
            "actions": [
                {"description": "step one", "role": "bogus-role"},
                {"description": "", "role": "tool"},  # empty desc → skipped
                {"description": "step two", "role": "tool", "source_turn_id": "t-2"},
                {"description": 42},  # non-string description → skipped
                {"text": "step three"},  # alternate key
            ],
            "confidence": 0.7,
        }

    turns = [
        _turn("user", "do x", turn_id="t1"),
        _turn("assistant", "run pytest -q", turn_id="t2"),
    ]
    case = TrajectoryCompressor(llm_caller=llm).compress(turns)
    assert case is not None
    descriptions = [step.description for step in case.action_sequence]
    assert "step one" in descriptions
    assert "step two" in descriptions
    assert "step three" in descriptions
    # The tool-role entry kept its role
    tool_steps = [s for s in case.action_sequence if s.role == "tool"]
    assert any(s.source_turn_id == "t-2" for s in tool_steps)


def test_llm_actions_empty_list_falls_back_to_heuristic() -> None:
    def llm(**_: Any) -> Any:
        return {"intent": "do", "actions": [], "confidence": 0.75}

    turns = [
        _turn("user", "do tests", turn_id="t1"),
        _turn("assistant", "run pytest -q", turn_id="t2"),
    ]
    case = TrajectoryCompressor(llm_caller=llm).compress(turns)
    assert case is not None
    descriptions = [step.description for step in case.action_sequence]
    assert any("pytest" in d for d in descriptions)


def test_llm_actions_with_only_invalid_entries_falls_back() -> None:
    def llm(**_: Any) -> Any:
        return {
            "intent": "do",
            "actions": [{"description": 42}, {"no_desc": "x"}, ""],
            "confidence": 0.75,
        }

    turns = [
        _turn("user", "do tests", turn_id="t1"),
        _turn("assistant", "run pytest -q", turn_id="t2"),
    ]
    case = TrajectoryCompressor(llm_caller=llm).compress(turns)
    assert case is not None
    descriptions = [step.description for step in case.action_sequence]
    # Heuristic fallback ran and produced pytest action
    assert any("pytest" in d for d in descriptions)


def test_extract_intent_returns_empty_when_no_user_turns() -> None:
    turns = [
        _turn("assistant", "hello", turn_id="t1"),
        _turn("tool", "ok", turn_id="t2"),
    ]

    intent = TrajectoryCompressor().extract_intent(turns)
    assert intent == ""


def test_config_property_exposes_config() -> None:
    config = CompressorConfig(max_action_steps=3)
    compressor = TrajectoryCompressor(config=config)
    assert compressor.config is config


def test_now_and_case_id_overrides_apply() -> None:
    fixed = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    turns = [
        _turn("user", "do it", turn_id="t1"),
        _turn("assistant", "run pytest -q", turn_id="t2"),
    ]
    case = TrajectoryCompressor().compress(turns, now=fixed, case_id="my-case-1")
    assert case is not None
    assert case.id == "my-case-1"
    assert case.occurred_at == fixed
