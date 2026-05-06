# Rule-first Observer — Evaluation Fixtures

Reusable labeled dataset for D-20 quilin-mem v2 L3a Observation layer evaluation.

## Purpose

1. **Task #97 v2** — replace Codex's self-authored 70-sample fixture with a 1000+ statistically meaningful set, removing the experimenter-author coupling that inflated v1 recall numbers
2. **M0 Sprint 1 regression suite** — lock expected precision/recall per observation type; CI fails if rule updates regress on it

## Structure

- `SCHEMA.md` — labeling spec, field semantics, category/difficulty enumerations
- `dataset.json` — all samples (top-level array)
- `README.md` — this file (provenance, version history)

## Data provenance

| source value | origin | relabeling |
|--------------|--------|-----------|
| `hand` | Claude-authored, diverse phrasing across 6 observation types × 4 difficulties × EN/ZH | n/a |
| `msc` | Multi-Session Chat (Facebook AI Research) persona-grounded turns | manual re-label against our schema |
| `personachat` | PersonaChat (ACL 2018) persona statements | manual re-label |
| `locomo` | LoCoMo (long conversation memory eval) turns | manual re-label |
| `noise-variant` | derived from existing sample by programmatic noise injection (typo / emoji / truncation) | inherits base label |

Public sources are **read-only** — raw text is quoted under fair-use for research evaluation; no derivative distribution implied. `source_ref` records the origin turn ID for traceability.

## Authors

Dataset curated by **Claude (Opus 4.7)** as planner-side work in Task #98. The implementer running the rule-first prototype (Codex, Task #97 v2) does not receive provenance information — only `dataset.json`.

## Scripts

- `scripts/relabel_public.py` — fetch PersonaChat / MSC samples from HF Datasets Server, apply regex-based heuristics + gold generation, balance-cap per (type, difficulty) bucket
- `scripts/noise_variants.py` — derive 6-mode noise variants (typo / emoji / code / short / long / mixed-lang) from existing samples; `short` mode forces `should_extract=false` (negative test)

## Version history

| version | date | samples | notes |
|---------|------|---------|-------|
| v2-draft-r1 | 2026-04-20 | 288 (all `hand`) | Run #1 baseline: Claude-authored 6-category 2-lang scale-up from v1's 70 |
| v2-draft-r2 | 2026-04-20 | 719 (hand 288 + msc 340 + personachat 91) | Run #2: add public-data re-labels. LoCoMo not accessible via HF Datasets Server as of 2026-04-20 — substituted MemGPT/MSC-Self-Instruct as second-source MSC surrogate. |
| v2-draft-r3 | 2026-04-20 | 1039 (hand 288 + msc 340 + personachat 91 + noise 320) | Run #3: add 6-mode noise variants (typo/emoji/code/short/long/mixed-lang). Short-truncation variants intentionally labeled as negative tests (signal destroyed). |

## License

Internal evaluation asset. Public-source excerpts quoted under fair-use for research. Redistribution requires original dataset terms (see `source_ref`).
