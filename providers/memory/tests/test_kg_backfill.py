"""Tests for `kg_backfill` — UX-4 KG memory Slice 2.

Hermetic — no real Store or KG, no network. We pass tiny in-memory
fakes that satisfy the Protocol contracts.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest

from quilin_mem.kg_backfill import (
    DEFAULT_BATCH_SIZE,
    HARD_MAX_RECORDS,
    MAX_BATCH_SIZE,
    MIN_BATCH_SIZE,
    backfill_kg_from_memory,
)
from quilin_mem.kg_extractor import ExtractedTriple

_T0 = datetime(2026, 5, 15, 0, 0, 0, tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class FakeRecord:
    id: str
    content: str
    created_at: datetime


class FakeStore:
    """In-memory store keyed by layer → list of records."""

    def __init__(self, by_layer: dict[str, list[FakeRecord]]) -> None:
        self._by_layer = by_layer

    async def list_by_layer(
        self, layer: str, limit: int = 50, offset: int = 0
    ) -> Sequence[FakeRecord]:
        return self._by_layer.get(layer, [])[offset : offset + limit]


class FakeKG:
    """Records every successful add_edge call. Optionally raises on Nth invocation
    (counter is incremented even for failures, so subsequent calls don't
    re-trigger the simulated failure).
    """

    def __init__(self, *, fail_on_call: int | None = None) -> None:
        self.calls: list[tuple] = []
        self._fail_on = fail_on_call
        self._invocation_count = 0

    async def add_edge(
        self,
        subject: str,
        predicate: str,
        obj: str,
        *,
        valid_from=None,
        valid_to=None,
        memory_id=None,
        weight=1.0,
        metadata=None,
    ) -> str:
        self._invocation_count += 1
        if self._fail_on is not None and self._invocation_count == self._fail_on:
            raise RuntimeError("simulated KG failure")
        self.calls.append((subject, predicate, obj, memory_id, weight, metadata))
        return f"edge-{len(self.calls)}"


def _triple(subject: str, predicate: str, obj: str) -> ExtractedTriple:
    return ExtractedTriple(
        subject=subject,
        predicate=predicate,
        object=obj,
        valid_from=_T0,
        source_quote="quoted",
        confidence=0.9,
    )


@pytest.mark.asyncio
async def test_dry_run_counts_edges_but_does_not_write() -> None:
    """Default dry_run=True: extractor runs, counts increment, no add_edge call."""
    store = FakeStore(
        {
            "working": [FakeRecord("r1", "Ada works at Anthropic.", _T0)],
            "episodic": [],
            "semantic": [],
            "skill": [],
        }
    )
    kg = FakeKG()
    captured_text: list[str] = []

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        captured_text.append(text)
        return [_triple("Ada", "works at", "Anthropic")]

    result = await backfill_kg_from_memory(
        store=store,
        kg=kg,
        extractor_fn=fake_extractor,
    )

    assert result.dry_run is True
    assert result.processed == 1
    assert result.edges_added == 1
    assert result.skipped == 0
    assert result.errors == []
    assert kg.calls == []  # NO write
    assert captured_text == ["Ada works at Anthropic."]


@pytest.mark.asyncio
async def test_real_run_writes_edges_with_correct_metadata() -> None:
    """dry_run=False persists edges with source_quote in metadata and memory_id linkage."""
    store = FakeStore(
        {
            "working": [FakeRecord("r99", "Ada works at Anthropic.", _T0)],
            "episodic": [],
            "semantic": [],
            "skill": [],
        }
    )
    kg = FakeKG()
    triple = ExtractedTriple(
        subject="Ada",
        predicate="works at",
        object="Anthropic",
        valid_from=_T0,
        source_quote="Ada works at Anthropic",
        confidence=0.85,
    )

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return [triple]

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor, dry_run=False
    )

    assert result.dry_run is False
    assert result.edges_added == 1
    assert len(kg.calls) == 1
    subj, pred, obj, memory_id, weight, metadata = kg.calls[0]
    assert (subj, pred, obj) == ("Ada", "works at", "Anthropic")
    assert memory_id == "r99"
    assert weight == pytest.approx(0.85)
    assert metadata is not None
    assert metadata["source_quote"] == "Ada works at Anthropic"
    assert metadata["extractor"] == "kg_extractor.extract_triples_from_text"


@pytest.mark.asyncio
async def test_max_records_caps_processing() -> None:
    """max_records=2 stops after 2 records even if more exist."""
    records = [FakeRecord(f"r{i}", f"text {i}", _T0) for i in range(5)]
    store = FakeStore({"working": records, "episodic": [], "semantic": [], "skill": []})
    kg = FakeKG()

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return [_triple("S", "p", "O")]

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor, max_records=2
    )

    assert result.processed == 2
    assert result.edges_added == 2


@pytest.mark.asyncio
async def test_empty_content_is_skipped() -> None:
    """Records with blank content are skipped (no extractor call, no edge)."""
    store = FakeStore(
        {
            "working": [
                FakeRecord("r1", "", _T0),
                FakeRecord("r2", "   ", _T0),
                FakeRecord("r3", "real content", _T0),
            ],
            "episodic": [], "semantic": [], "skill": [],
        }
    )
    kg = FakeKG()

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return [_triple("X", "y", "Z")]

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor
    )
    assert result.processed == 3
    assert result.skipped == 2  # r1 and r2 blank → skipped
    assert result.edges_added == 1  # only r3 produces an edge


@pytest.mark.asyncio
async def test_extractor_returning_empty_list_increments_skipped() -> None:
    """Record processed but no triples extracted → counts as skipped (not error)."""
    store = FakeStore(
        {
            "working": [FakeRecord("r1", "ambiguous text", _T0)],
            "episodic": [],
            "semantic": [],
            "skill": [],
        }
    )
    kg = FakeKG()

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return []

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor
    )
    assert result.processed == 1
    assert result.skipped == 1
    assert result.edges_added == 0


@pytest.mark.asyncio
async def test_batch_size_clamped_to_max() -> None:
    """batch_size > MAX_BATCH_SIZE is clamped down."""
    records = [FakeRecord(f"r{i}", f"x{i}", _T0) for i in range(3)]
    store = FakeStore({"working": records, "episodic": [], "semantic": [], "skill": []})
    kg = FakeKG()

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return []

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor, batch_size=999_999
    )
    assert result.processed == 3
    # Implicit: didn't raise — clamping path executed.


@pytest.mark.asyncio
async def test_walks_all_default_layers() -> None:
    """Default `layers` = working/episodic/semantic/skill; backfill visits each."""
    store = FakeStore(
        {
            "working": [FakeRecord("w1", "a", _T0)],
            "episodic": [FakeRecord("e1", "b", _T0)],
            "semantic": [FakeRecord("s1", "c", _T0)],
            "skill": [FakeRecord("k1", "d", _T0)],
        }
    )
    kg = FakeKG()

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return [_triple("S", "p", text)]

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor
    )
    assert result.processed == 4
    assert result.edges_added == 4


@pytest.mark.asyncio
async def test_custom_layers_override_default() -> None:
    """Passing `layers=["working"]` restricts the walk to that layer."""
    store = FakeStore(
        {
            "working": [FakeRecord("w1", "a", _T0)],
            "episodic": [FakeRecord("e1", "b", _T0)],
            "semantic": [],
            "skill": [],
        }
    )
    kg = FakeKG()

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return [_triple("S", "p", "O")]

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor, layers=["working"]
    )
    assert result.processed == 1


@pytest.mark.asyncio
async def test_kg_add_edge_failure_recorded_in_errors() -> None:
    """When kg.add_edge raises, the failure is captured in errors[] but
    processing continues for remaining triples / records.
    """
    store = FakeStore(
        {"working": [FakeRecord("r1", "txt", _T0)], "episodic": [], "semantic": [], "skill": []}
    )
    kg = FakeKG(fail_on_call=1)  # first add_edge raises

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return [_triple("A", "p", "B"), _triple("C", "p", "D")]

    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor, dry_run=False
    )
    # 1 call failed, 1 call succeeded
    assert len(kg.calls) == 1
    assert result.edges_added == 1
    assert len(result.errors) == 1
    assert "simulated KG failure" in result.errors[0]


@pytest.mark.asyncio
async def test_to_dict_serializes_result() -> None:
    """`BackfillResult.to_dict` returns a JSON-friendly mapping."""
    store = FakeStore({"working": [], "episodic": [], "semantic": [], "skill": []})
    kg = FakeKG()
    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=lambda *_a, **_k: []
    )
    d = result.to_dict()
    assert set(d.keys()) == {"processed", "edges_added", "skipped", "errors", "dry_run"}
    assert d["processed"] == 0


@pytest.mark.asyncio
async def test_constants_are_exported_correctly() -> None:
    """Sanity check: the exported tuning constants are sane."""
    assert MIN_BATCH_SIZE == 1
    assert MAX_BATCH_SIZE >= 50
    assert DEFAULT_BATCH_SIZE == 50
    assert HARD_MAX_RECORDS >= 1000


@pytest.mark.asyncio
async def test_max_records_clamps_to_hard_cap() -> None:
    """max_records can't exceed HARD_MAX_RECORDS."""
    records = [FakeRecord(f"r{i}", f"x{i}", _T0) for i in range(3)]
    store = FakeStore({"working": records, "episodic": [], "semantic": [], "skill": []})
    kg = FakeKG()

    def fake_extractor(text: str, **_kwargs: object) -> list[ExtractedTriple]:
        return []

    # Pass a deliberately huge max_records; should silently clamp.
    result = await backfill_kg_from_memory(
        store=store, kg=kg, extractor_fn=fake_extractor, max_records=10_000_000
    )
    # Whatever the cap, with only 3 records we get processed=3.
    assert result.processed == 3
