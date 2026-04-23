# Rule-first Observer Spike — v3

Task #97 follow-up to the v2-r3 formal gate run (`docs/research/rule-first-observer-spike-report.md`). This document is the v3 multi-run evaluation report for the expanded `.spike/observer-v3/` Tier 1 prototype.

Scope constraints respected during v3:

- the 1039-sample gold dataset was **not modified** (`docs/research/fixtures/rule-first-observer/dataset.json`)
- the v2 spike directory (`.spike/observer/`) was **not modified** — v2-r3 results preserved
- the v3 code lives at `.spike/observer-v3/main.py` (948 LOC) and is gitignored per project policy
- no production code under `providers/memory/` was touched

## Executive Summary

**Formal gate answer at v3: NO.**

The v3 prototype clears three of four gate thresholds but fails on false-positive rate:

| Gate | Requirement | v3 Result | Pass |
|---|---:|---:|---|
| Recall | `>= 40%` | `44.8%` | Yes |
| False-positive rate | `<= 5%` | `10.2%` | No |
| p95 latency | `< 20 ms` | `3.90 ms` | Yes |
| zh recall (v2-r3 was 0%) | `>= 25%` | `39.1%` | Yes |

My independent view is: v3 is a qualitative improvement over v2-r3, but the fix pattern traded conservative silence for chatty confidence. The rule-first direction is now **closer to viable** than in v2-r3, yet still misses the gate on the dimension the rule-first design was supposed to guarantee — low FPR.

- Recall more than doubled (`21.4%` -> `44.8%`)
- Chinese went from `0%` to `39.1%` recall (the v2-r3 blocker is gone)
- FPR jumped from `2.8%` to `10.2%` (new blocker introduced)
- Tier 2 escalation rate jumped from `1.1%` to `28.2%` (escalation policy now actually fires)

The main open question is no longer "can the prototype cover Chinese?" but "can a rule-first prototype stay under a 5% FPR once it is broad enough to recall the long tail?"

## Run Definitions

| Run | Dataset | Size | Composition | Location |
|---|---|---:|---|---|
| `v1-baseline-inflated` | self-authored | 70 | prototype baseline, inflated | `.spike/observer/results-v1-baseline.json` |
| `v2-r1` | external hand-crafted | 288 | Claude-authored hand set only | `.spike/observer/results-v2-r1.json` |
| `v2-r2` | snapshot | 719 | hand + MSC + PersonaChat | `.spike/observer/results-v2-r2.json` |
| `v2-r3` | final | 1039 | r2 + 320 noise variants | `.spike/observer/results-v2-r3.json` |
| `v3` | **same** final | 1039 | identical dataset, new prototype | `.spike/observer-v3/results-v3.json` |

Important: the v3 dataset is bit-identical to v2-r3. Only the detector changed.

## Headline Comparison (v2-r3 vs v3)

| Metric | v2-r3 | v3 | Delta |
|---|---:|---:|---:|
| Precision | `96.7%` | `94.4%` | `-2.3` pts |
| Recall | `21.4%` | `44.8%` | **`+23.4` pts** |
| F1 | `35.0%` | `60.7%` | `+25.7` pts |
| FPR | `2.8%` | `10.2%` | **`+7.4` pts** |
| Tier 1 direct-hit rate | `17.5%` | `37.6%` | `+20.1` pts |
| Tier 2 escalation rate | `1.1%` | `28.2%` | **`+27.1` pts** |
| p50 latency | `2.64 ms` | `2.27 ms` | `-0.37 ms` |
| p95 latency | `4.19 ms` | `3.90 ms` | `-0.29 ms` |

Three things stand out:

1. Recall and escalation moved in step — the v3 escalation changes are doing real work, not just decorating the output.
2. FPR crossed the 5% gate ceiling because escalation on the `none` class fires at `24.2%` (v2-r3 was `~3%`). Escalation is counted as "predicted positive" by the gate definition, so the broader escalation policy directly inflates FPR.
3. Latency actually improved despite the much broader rule surface — CJK regex routing short-circuits the spaCy pipeline for Chinese text.

## What Changed Between Runs (v2-r3 -> v3)

The v3 detector lives at `.spike/observer-v3/main.py` (948 LOC, vs. v2's ~700). The five named changes from the implementer docstring:

1. **Language routing** (`CJK_RANGE` regex detected before any spaCy load). In v2-r3 Chinese text flowed through `en_core_web_sm` and got zero NER anchors, forcing every zh sample to miss silently.
2. **Chinese regex inventory** covering `entity-zh-*`, `time-zh-*`, `pref-zh-*`, `emotion-zh-*`, `intent-zh-*` surface patterns mined from the fixture.
3. **English phrase expansion** — `Based in` / `Reporting to` / `Cofounded` / `Day job` / `My tech stack` / `From NYC` / `I'm a <role>` / sentence-initial `At <Org>` fragments that v2-r3's narrow `I work at` / `I live in` inventory missed.
4. **Emotion breadth (en)** — `I feel` / `I'm so` / `makes me` / adjective fragments (`burned out`, `exhausted`, `anxious`). v2-r3 emotion recall was `2.0%`.
5. **Earned escalation** — a hit still escalates when top-2 candidate types are within `AMBIGUITY_MARGIN = 0.08`, when an entity rule fires without an NER anchor, when a pronoun has no referent, or when CJK text has no matched zh rule. v2-r3 only escalated on `confidence < 0.6` and escalated at `1.1%`; v3 escalates at `28.2%`.

Plus one infrastructure caveat:

6. **spaCy Chinese model status** — `zh_core_web_sm` installs successfully on Python 3.14 (`spacy-pkuseg==1.0.1`, `zh-core-web-sm==3.8.0`). The v3 detector still records `"model_zh": "regex-only"` because the design decision was to route zh through hand-authored regex rather than depend on `pkuseg` tokenisation for correctness. The install friction the implementer worried about did not materialise; the regex-only path is intentional, not forced.

## Final Gate Metrics (v3)

Confusion counts on the full 1039-sample corpus:

| | Predicted observation | Predicted none |
|---|---:|---:|
| Gold observation (824) | 369 | 455 |
| Gold none (215) | 22 | 193 |

Derived metrics:

| Metric | v3 Value |
|---|---:|
| Precision | `94.4%` |
| Recall | `44.8%` |
| F1 | `60.7%` |
| False-positive rate | `10.2%` |
| True-negative rate | `89.8%` |
| Tier 1 direct-hit rate | `37.6%` |
| Tier 2 escalation rate | `28.2%` |
| Average latency | `1.89 ms` |
| p50 latency | `2.27 ms` |
| p95 latency | `3.90 ms` |

The `28.2%` escalation rate is the central mechanical change. It is 25x the v2-r3 escalation rate and is what bought the recall gains — but it is also what drives the FPR overshoot, because the `none` class now escalates at `24.2%`.

Current consensus:

- the v3 prototype **no longer fails because it is silent** — it fails because it is too willing to hand cases to Tier 2
- the ceiling for a rule-first design at low FPR is plausibly somewhere between `21.4%` and `44.8%` recall

## By Type (v3)

| Type | Support | Recall | Precision | F1 | Tier 1 hit | Tier 2 escalation | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `entity` | 276 | `19.9%` | `100.0%` | `33.2%` | `19.9%` | `55.4%` | `2.31 ms` | `4.15 ms` |
| `time` | 113 | `46.0%` | `100.0%` | `63.0%` | `46.0%` | `19.5%` | `2.19 ms` | `4.21 ms` |
| `preference` | 185 | `62.2%` | `100.0%` | `76.7%` | `62.2%` | `15.7%` | `2.24 ms` | `3.67 ms` |
| `emotion` | 101 | `47.5%` | `100.0%` | `64.4%` | `47.5%` | `12.9%` | `1.81 ms` | `4.81 ms` |
| `intent` | 149 | `66.4%` | `100.0%` | `79.8%` | `66.4%` | `16.1%` | `2.34 ms` | `3.37 ms` |
| `none` | 215 | `n/a` | `0.0%` | `n/a` | `10.2%` (FPR) | `24.2%` | `1.82 ms` | `3.75 ms` |

Interpretation:

- **emotion** went from `2.0%` to `47.5%` recall — the single biggest improvement, driven by the en adjective fragment expansion.
- **preference** went from `20.0%` to `62.2%` — the expansion is clearly working on explicit-preference phrasing.
- **intent** improved from `53.0%` to `66.4%`, confirming that intent was already the strongest class and got modest additional lift.
- **entity** still crawls at `19.9%`. This is the surprise: entity recall barely moved. `55.4%` of entity samples escalate to Tier 2 instead of hitting a Tier 1 rule. The "broader phrase inventory" pass landed — but not on entity.
- **time** recovered from `8.0%` to `46.0%` — fixtures-aligned time regex expansion worked.

## By Difficulty (v3)

| Difficulty | Support | Recall | FPR | Tier 1 hit | Tier 2 escalation | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `explicit` | 409 | `62.8%` | `n/a` | `62.8%` | `30.8%` | `2.44 ms` | `4.23 ms` |
| `implicit` | 143 | `10.5%` | `n/a` | `10.5%` | `55.2%` | `2.38 ms` | `3.34 ms` |
| `trap` | 130 | `n/a` | `6.2%` | `6.2%` mis-extracted | `26.2%` | `2.75 ms` | `3.84 ms` |
| `noisy` | 357 | `35.7%` | `16.5%` | `31.1%` | `15.1%` | `0.02 ms` | `3.75 ms` |

Key movements from v2-r3:

- `explicit` almost doubled (`33.5%` -> `62.8%`). Explicit is now recoverable.
- `implicit` crept up slightly (`9.8%` -> `10.5%`) — still the hardest slice, as expected for a rule-first design. Most implicit rows escalate (`55.2%`).
- `trap` mis-extraction doubled (`3.1%` -> `6.2%`). The broader rule surface is now touching samples the trap guards were supposed to silence, most visibly on `past_abandoned` (see trap matrix below).
- `noisy` improved on recall (`9.2%` -> `35.7%`) but FPR on noisy negatives jumped from `2.4%` to `16.5%`.

## By Language (v3)

| Language | Support | Recall | Precision | FPR | Tier 1 hit | Tier 2 escalation | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `en` | 699 | `49.4%` | `95.8%` | `8.2%` | `40.8%` | `36.5%` | `2.68 ms` | `4.19 ms` |
| `zh` | 205 | `39.1%` | `89.7%` | `14.3%` | `33.2%` | `14.1%` | `0.01 ms` | `0.02 ms` |
| `mixed` | 135 | `30.4%` | `92.1%` | `15.0%` | `28.1%` | `6.7%` | `0.02 ms` | `2.32 ms` |

This is the most important slice in the v3 run:

- Chinese moved from `0.0%` to `39.1%` recall. The v2-r3 "zh is zero" blocker is resolved.
- mixed-language moved from `5.2%` to `30.4%`. Still below the `40%` gate line, but no longer trivially broken.
- English recall improved `30.7%` -> `49.4%`.
- The cost is that **every language slice now has FPR above 5%**:
  - `en` FPR `4.1%` -> `8.2%`
  - `zh` FPR `0.0%` -> `14.3%`
  - `mixed` FPR `0.0%` -> `15.0%`

zh latency is dramatically lower than en because the zh path short-circuits spaCy entirely.

## By Source

### v3 source split

| Source | Support | Recall | Precision | FPR | Tier 1 hit | Tier 2 escalation |
|---|---:|---:|---:|---:|---:|---:|
| `hand` | 288 | `42.2%` | `96.1%` | `7.1%` | `35.4%` | `20.1%` |
| `msc` | 340 | `53.7%` | `100.0%` | `0.0%` | `46.8%` | `41.2%` |
| `personachat` | 91 | `45.5%` | `86.2%` | `11.1%` | `31.9%` | `46.2%` |
| `noise-variant` | 320 | `36.1%` | `86.1%` | `17.7%` | `31.6%` | `16.6%` |

### Delta vs. v2-r3 source split

| Source | v2-r3 Recall | v3 Recall | v2-r3 FPR | v3 FPR |
|---|---:|---:|---:|---:|
| `hand` | `7.3%` | `42.2%` | `3.6%` | `7.1%` |
| `msc` | `38.2%` | `53.7%` | `0.0%` | `0.0%` |
| `personachat` | `40.0%` | `45.5%` | `5.6%` | `11.1%` |
| `noise-variant` | `10.0%` | `36.1%` | `2.5%` | `17.7%` |

Interpretation:

- `hand` recall jumped dramatically (`7.3%` -> `42.2%`), confirming the en phrase expansion was exactly what the Claude-authored hand corpus needed.
- `msc` maintained zero FPR and moved from `38.2%` to `53.7%` — best-behaved slice.
- `noise-variant` is the FPR hot spot (`17.7%`): the broader rule surface fires on adversarial noisy negatives.

## Noise Robustness (v3)

By `noise_features`:

| Noise Feature | Support | Recall | Precision | FPR | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| `typo` | 60 | `32.7%` | `94.7%` | `20.0%` | `0.02 ms` | `3.15 ms` |
| `emoji` | 65 | `44.3%` | `100.0%` | `0.0%` | `0.02 ms` | `3.07 ms` |
| `code` | 65 | `42.6%` | `92.9%` | `50.0%` | `0.03 ms` | `4.10 ms` |
| `short` | 67 | `36.4%` | `26.7%` | `19.6%` | `1.69 ms` | `2.15 ms` |
| `long` | 61 | `33.3%` | `100.0%` | `0.0%` | `0.02 ms` | `4.84 ms` |
| `mixed-lang` | 53 | `19.5%` | `100.0%` | `0.0%` | `0.02 ms` | `0.04 ms` |

Most damaging noise modes by FPR (new concern in v3):

1. `code` FPR `50.0%` — code fragments now trigger zh/en patterns that weren't loaded in v2-r3.
2. `typo` FPR `20.0%` — typo variants sometimes fall into the expanded pattern surface by accident.
3. `short` FPR `19.6%` — short adversarial negatives where a single token now matches an expanded rule.

Most recovered noise modes by recall:

1. `short` `0.0%` -> `36.4%` (note the FPR cost)
2. `emoji` `6.6%` -> `44.3%` (with zero FPR — clean win)
3. `long` `11.1%` -> `33.3%` (with zero FPR — clean win)
4. `typo` `7.3%` -> `32.7%`

`short` remains the hardest robustness case: recall bought mostly at the cost of precision.

## Trap Matrix (v3)

| Trap Reason | Support | Mis-extracted | Safe-rejected | Mis-extract rate | Change vs. v2-r3 |
|---|---:|---:|---:|---:|---|
| `rhetorical_question` | 44 | 1 | 43 | `2.3%` | stable |
| `hypothetical` | 13 | 0 | 13 | `0.0%` | stable |
| `quoted_other` | 15 | 1 | 14 | `6.7%` | stable |
| `generic_statement` | 20 | 0 | 20 | `0.0%` | stable |
| `negation_of_fact` | 0 | 0 | 0 | `n/a` | n/a |
| `past_abandoned` | 11 | 5 | 6 | **`45.5%`** | **`9.1%` -> `45.5%`** |
| `command_or_request` | 6 | 0 | 6 | `0.0%` | stable |
| `meta_conversation` | 58 | 4 | 54 | `6.9%` | `1.7%` -> `6.9%` |

Two trap classes regressed in v3:

- `past_abandoned` mis-extract rate went from `9.1%` (1/11) to `45.5%` (5/11). The expanded time/preference patterns now match sentences like `I used to wake up at 5am but not for years.` as confidently positive even when the "but not for years" negation is present. The `_looks_observational` and ambiguity guards don't catch this class — they focus on speaker/NER anchors, not tense/abandonment markers.
- `meta_conversation` doubled from `1.7%` to `6.9%` mis-extraction — four mis-extractions where meta-conversational scaffolding now trips intent or preference rules.

Other trap classes are stable.

## Escalation Reasons (v3)

| Reason | Count |
|---|---:|
| `no-rule-match-but-observational` | 189 |
| `entity-no-ner-anchor` | 72 |
| `ambiguous-types:intent/time` | 14 |
| `low-confidence` | 8 |
| `pronoun-no-referent` | 4 |
| `ambiguous-types:emotion/time` | 2 |
| `ambiguous-types:entity/time` | 2 |
| `ambiguous-types:time/intent` | 1 |
| `entity-no-ner-anchor,pronoun-no-referent` | 1 |

Interpretation:

- The dominant reason is `no-rule-match-but-observational` (189 of 293 escalations). This single sentinel explains the jump from `1.1%` to `28.2%` escalation rate — and it is also the reason FPR overshoots: the sentinel fires on `none` samples that look surface-observational but are actually noise or meta-text.
- `entity-no-ner-anchor` (72) is the second-biggest driver and directly reflects the entity class's persistent recall gap (only `19.9%`).

## Failure Pattern Summary

v3 eliminates two v2-r3 failure families and introduces one new family:

### Solved in v3

1. **Single-language assumptions.** CJK routing + zh regex closed the `0% zh recall` blocker. zh and mixed both have real recall now.
2. **Sparse emotion coverage.** Emotion recall moved from `2.0%` to `47.5%` on the same gold set.

### Still present, partially mitigated

3. **Narrow entity phrasing.** Entity recall only moved from `17.8%` to `19.9%`, despite phrase expansion. The expansion hit preference/time/emotion more than entity. `55.4%` of entity rows now escalate rather than Tier 1 hit.
4. **Implicit reasoning.** Implicit difficulty is still at `10.5%` recall. Rule-first cannot meaningfully handle implicit inferential observation.

### New in v3

5. **Observational-but-negative FPR inflation.** The `no-rule-match-but-observational` escalation sentinel is the single biggest source of FPR. It fires on `none` samples that resemble surface observation shape, pushing the `none` class to `24.2%` escalation and overall FPR to `10.2%`.
6. **Trap regression on tense-based classes.** `past_abandoned` mis-extraction jumped 5x. The broader patterns now match abandoned-past sentences that were silent in v2-r3, and the trap guards do not check tense or abandonment markers.

## Final D-20 Gate Decision

Gate definition for the v3 run (adds the bilingual target from the 2026-04-22 brief):

- recall `>= 40%`
- false-positive rate `<= 5%`
- p95 latency `< 20 ms`
- zh recall `>= 25%`

v3 results:

- recall `44.8%` — **pass**
- FPR `10.2%` — **fail**
- p95 latency `3.90 ms` — **pass**
- zh recall `39.1%` — **pass**

### Decision

**NO.**

The v3 rule-first Tier 1 prototype does **not** pass the D-20 L3a gate, but the failure mode is meaningfully different from v2-r3.

### Why

- v2-r3 failed on under-recall (`21.4%`) with near-zero escalation.
- v3 fails on over-positivity (`10.2%` FPR) driven mostly by one escalation sentinel.
- This suggests the rule-first ceiling is not far above v3's numbers, but it also suggests the v3 design bought recall at the cost of precision — and the FPR gate is the one where rule-first was supposed to dominate LLM-based alternatives.

### What this does not mean

It does **not** mean the two-tier architecture should be discarded.
It does **not** mean rule-first is unreachable — a more targeted escalation policy (don't escalate on "observational shape" alone) might land both gates.
It **does** mean the current v3 prototype is not shippable as M0 Sprint 1 Tier 1 without at least one more iteration that reins in the `no-rule-match-but-observational` sentinel and adds tense/abandonment guards.

## Recommended Next Step

Three credible next actions (ordered by risk/cost):

1. **v4 rule-first tightening** — keep v3 recall / zh / latency wins, reduce FPR:
   - drop the `no-rule-match-but-observational` sentinel or scope it to rows with explicit speaker anchors
   - add `past_abandoned` tense-aware guard (detect `used to ... but`, `planned to ... but gave up`, etc.)
   - tighten the noisy-variant code/typo path so "code" samples don't trigger general patterns
2. **Arm L tiny-LLM spike** — blocked today (see ADR-004 §Evidence). Unblock by provisioning an ANTHROPIC_API_KEY or a local `ollama` Haiku-class model; then run the same 1039-sample gate on Arm L for a clean comparison.
3. **Decision**: if v4 or Arm L lands gate-pass, keep Tier 1. If both fail, downgrade L3a to opt-in per ADR-004 §Decision d3.

Current consensus after v3:

- the two-tier architecture is still the right shape
- rule-first is plausibly reachable but needs one more pass specifically targeted at FPR
- the 2026-04-20 gate blocker (zh `0%`) is gone; the 2026-04-23 gate blocker (FPR `10.2%`) is the new one
