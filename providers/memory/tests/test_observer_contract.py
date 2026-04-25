from __future__ import annotations

import pytest

from omnimem.observer import (
    MemoryObserver,
    NoOpMemoryObserver,
    ObservationCandidate,
    ObservationTurn,
    normalize_observation_turn,
    observe_safely,
)


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

    with pytest.raises(TypeError, match="candidate.kind"):
        ObservationCandidate(content="bad", confidence=0.5, kind=123)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="Invalid candidate.kind"):
        ObservationCandidate(content="bad", confidence=0.5, kind="invalid")  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="candidate.source_turn_id"):
        ObservationCandidate(content="bad", confidence=0.5, source_turn_id=123)  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="turn must"):
        normalize_observation_turn(object())  # type: ignore[arg-type]


async def test_observer_failure_does_not_affect_main_path() -> None:
    class FailingObserver:
        async def observe(self, turn: object) -> list[ObservationCandidate]:
            raise RuntimeError("upstream model unavailable")

    candidates = await observe_safely(
        FailingObserver(),
        {"content": "this should not block memory_store", "role": "user"},
    )

    assert candidates == []
