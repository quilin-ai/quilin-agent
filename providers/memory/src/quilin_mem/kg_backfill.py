"""Knowledge-graph backfill — UX-4 KG Slice 2.

Walks the `memory_records` table, runs each record's text body through
the LLM triple extractor (`kg_extractor.extract_triples_from_text`),
and persists the resulting edges into the `TemporalKnowledgeGraph`.
Designed for one-shot bulk backfill of pre-existing memory records
that were never seen by the extractor at write time.

Default mode is `dry_run=True` so the caller (LLM via MCP tool) must
explicitly opt in to mutating the KG. This keeps the tool safe to
invoke for inspection.

UX-4 Slice 2:把已有的 memory_records 表一次性灌进 KG。默认 dry_run,
真要写入 KG 才显式 dry_run=False。返回处理计数 + 错误。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from .kg_extractor import ExtractedTriple, extract_triples_from_text

MAX_BATCH_SIZE = 200
MIN_BATCH_SIZE = 1
DEFAULT_BATCH_SIZE = 50
HARD_MAX_RECORDS = 10_000
MEMORY_LAYERS_TO_BACKFILL: tuple[str, ...] = ("working", "episodic", "semantic", "skill")


class MemoryRecordLike(Protocol):
    """Subset of `MemoryItem` we actually consume during backfill.

    Defined as a Protocol so tests can pass plain dataclasses without
    constructing a full ``MemoryItem`` (which carries embedding / FTS
    state that's irrelevant here).
    """

    id: str
    content: str
    created_at: datetime


class StoreLike(Protocol):
    """Subset of `QuilinMemStore` we depend on. Same Protocol rationale
    as ``MemoryRecordLike``: simplifies testing + decouples the
    backfill logic from full Store wiring.
    """

    async def list_by_layer(
        self,
        layer: str,
        limit: int = ...,
        offset: int = ...,
    ) -> Sequence[MemoryRecordLike]: ...


class KGLike(Protocol):
    """Subset of `TemporalKnowledgeGraph` we call. Async ``add_edge``
    matches the production class signature so the production caller
    can pass `TemporalKnowledgeGraph` directly with no adapter.
    """

    async def add_edge(
        self,
        subject: str,
        predicate: str,
        object: str,
        *,
        valid_from: datetime | str | None = ...,
        valid_to: datetime | str | None = ...,
        memory_id: str | None = ...,
        weight: float = ...,
        metadata: dict[str, object] | None = ...,
    ) -> str: ...


@dataclass(frozen=True, slots=True)
class BackfillResult:
    """Outcome of a `backfill_kg_from_memory` run."""

    processed: int
    edges_added: int
    skipped: int
    errors: list[str] = field(default_factory=list)
    dry_run: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "processed": self.processed,
            "edges_added": self.edges_added,
            "skipped": self.skipped,
            "errors": list(self.errors),
            "dry_run": self.dry_run,
        }


ExtractorFn = Callable[..., list[ExtractedTriple]]


async def backfill_kg_from_memory(
    *,
    store: StoreLike,
    kg: KGLike,
    batch_size: int = DEFAULT_BATCH_SIZE,
    max_records: int | None = None,
    dry_run: bool = True,
    extractor_fn: ExtractorFn | None = None,
    layers: Sequence[str] | None = None,
) -> BackfillResult:
    """Walk memory records and persist extracted triples into the KG.

    Args:
        store: Memory store to read from (``QuilinMemStore`` in production).
        kg: ``TemporalKnowledgeGraph`` to write into.
        batch_size: How many records to pull per ``list_by_layer`` call.
            Clamped to ``[MIN_BATCH_SIZE, MAX_BATCH_SIZE]``.
        max_records: Hard cap on records to process across all layers.
            ``None`` means "all available" (still clamped by
            ``HARD_MAX_RECORDS`` to prevent runaway).
        dry_run: When True (default), extraction runs but no edges are
            written. ``BackfillResult.edges_added`` reflects what
            *would* have been written.
        extractor_fn: DI seam — defaults to
            ``kg_extractor.extract_triples_from_text``. Tests pass a
            mock that returns deterministic triples.
        layers: Override the default memory layers to walk.
    """
    effective_batch = max(MIN_BATCH_SIZE, min(MAX_BATCH_SIZE, batch_size))
    effective_max = HARD_MAX_RECORDS if max_records is None else min(
        max(1, max_records), HARD_MAX_RECORDS
    )
    extractor = extractor_fn or extract_triples_from_text
    target_layers = layers if layers is not None else MEMORY_LAYERS_TO_BACKFILL

    processed = 0
    edges_added = 0
    skipped = 0
    errors: list[str] = []

    for layer in target_layers:
        offset = 0
        while processed < effective_max:
            try:
                batch = await store.list_by_layer(layer, limit=effective_batch, offset=offset)
            except Exception as exc:  # pragma: no cover — error path
                errors.append(f"list_by_layer({layer}) failed: {exc!r}")
                break
            if not batch:
                break

            for record in batch:
                if processed >= effective_max:
                    break
                processed += 1
                text = (record.content or "").strip()
                if not text:
                    skipped += 1
                    continue

                try:
                    triples = await asyncio.to_thread(
                        extractor,
                        text,
                        default_valid_from=record.created_at,
                    )
                except Exception as exc:  # pragma: no cover — extractor error path
                    errors.append(f"extract({record.id}) failed: {exc!r}")
                    continue

                if not triples:
                    skipped += 1
                    continue

                for triple in triples:
                    if dry_run:
                        edges_added += 1
                        continue
                    try:
                        await kg.add_edge(
                            triple.subject,
                            triple.predicate,
                            triple.object,
                            valid_from=triple.valid_from,
                            memory_id=record.id,
                            weight=triple.confidence,
                            metadata={
                                "source_quote": triple.source_quote,
                                "extractor": "kg_extractor.extract_triples_from_text",
                            },
                        )
                        edges_added += 1
                    except Exception as exc:  # pragma: no cover — KG write error
                        errors.append(
                            f"add_edge({record.id}, {triple.subject!r}/{triple.predicate!r}/"
                            f"{triple.object!r}) failed: {exc!r}"
                        )

            offset += len(batch)
            if len(batch) < effective_batch:
                break

    return BackfillResult(
        processed=processed,
        edges_added=edges_added,
        skipped=skipped,
        errors=errors,
        dry_run=dry_run,
    )
