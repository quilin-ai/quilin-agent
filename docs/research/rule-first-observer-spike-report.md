# Rule-first Observer Spike

Task #97 v2. This document is the multi-run evaluation report for the current `.spike/observer/` Tier 1 prototype.

Scope constraints respected during v2:

- detector logic was frozen
- only the evaluation shell and reporting slices were changed
- datasets were authored outside the rule implementation flow

## Executive Summary

**Formal gate answer at Run #3: NO.**

The current Tier 1 prototype still fails the D-20 gate on the final v2-r3 corpus:

| Gate | Requirement | v2-r3 Result | Pass |
|---|---:|---:|---|
| Recall | `>= 40%` | `21.4%` | No |
| False-positive rate | `<= 5%` | `2.8%` | Yes |
| p95 latency | `< 20 ms` | `4.19 ms` | Yes |
| Python 3.14 + `spaCy` install | Must work | Works | Yes |

My independent view is: the architecture question and the current prototype question have now diverged cleanly.

- The prototype is fast and conservative.
- The prototype is **not broad enough** to justify D-20 L3a as currently implemented.
- The main blockers are **coverage breadth**, **bilingual support**, and **escalation policy**, not runtime cost.

## Run Definitions

| Run | Dataset | Size | Composition |
|---|---|---:|---|
| `v1-baseline-inflated` | `.spike/observer/fixtures/dataset.json` | 70 | self-authored by the rule implementer; useful only as an optimistic prototype baseline |
| `v2-r1` | external hand-crafted draft | 288 | Claude-authored hand set only |
| `v2-r2` | `snapshots/dataset-r2.json` | 719 | hand + MSC + PersonaChat; still contains `37` inherited noisy rows |
| `v2-r3` | final `dataset.json` | 1039 | r2 + `320` noise variants; formal gate run |

Important nuance: `v2-r2` is not literally "zero noise". The snapshot already contains a small inherited noisy slice (`37` rows) from earlier data assembly. The major robustness jump happens at `v2-r3`, where the dedicated `320`-row noise batch is added.

## Headline Comparison

| Run | Samples | Precision | Recall | F1 | FPR | Tier 1 hit rate | Tier 2 escalation | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `v1-baseline-inflated` | 70 | `100.0%` | `90.0%` | `94.7%` | `0.0%` | `64.3%` | `7.1%` | `2.97 ms` | `3.58 ms` |
| `v2-r1` | 288 | `89.5%` | `7.3%` | `13.5%` | `3.6%` | `6.6%` | `1.7%` | `2.84 ms` | `4.35 ms` |
| `v2-r2` | 719 | `97.4%` | `26.1%` | `41.1%` | `2.9%` | `21.7%` | `1.1%` | `2.67 ms` | `4.21 ms` |
| `v2-r3` | 1039 | `96.7%` | `21.4%` | `35.0%` | `2.8%` | `17.5%` | `1.1%` | `2.64 ms` | `4.19 ms` |

Three things stand out:

1. `v1` was dramatically inflated.
2. `v2-r2` improves sharply over `v2-r1`, mainly because the public corpora align better with the prototype's English intent/preference patterns.
3. `v2-r3` drops again once large-scale noise variants are introduced, confirming a robustness problem.

## What Changed Between Runs

### v2-r1 -> v2-r2

Adding public data moved recall from `7.3%` to `26.1%` and F1 from `13.5%` to `41.1%`.

Interpretation:

- the external hand-only set in `v2-r1` was unusually hard for the current rule inventory
- MSC and PersonaChat are easier for this prototype because they are mostly English and contain more pattern-aligned intent/preference language
- this is not evidence that the prototype is "good"; it is evidence that the prototype is **source-sensitive**

### v2-r2 -> v2-r3

Adding the 320-row noise batch moved:

- recall from `26.1%` to `21.4%` (`-4.7` pts)
- F1 from `41.1%` to `35.0%`
- Tier 1 hit rate from `21.7%` to `17.5%`
- FPR from `2.9%` to `2.8%` (essentially stable)

Interpretation:

- noise hurts recall materially
- noise does **not** blow up false positives
- the current prototype remains conservative, but fragile

## Final Gate Metrics (v2-r3)

Confusion counts:

| | Predicted observation | Predicted none |
|---|---:|---:|
| Gold observation | 176 | 648 |
| Gold none | 6 | 209 |

Derived metrics:

| Metric | Value |
|---|---:|
| Precision | `96.7%` |
| Recall | `21.4%` |
| F1 | `35.0%` |
| False-positive rate | `2.8%` |
| True-negative rate | `97.2%` |
| Tier 1 direct-hit rate | `17.5%` |
| Tier 2 escalation rate | `1.1%` |
| Average latency | `2.80 ms` |
| p50 latency | `2.64 ms` |
| p95 latency | `4.19 ms` |

The `1.1%` escalation rate remains one of the most important findings in the whole spike.

Current consensus:

- the prototype does not fail because it overfires
- it fails because it misses too much and escalates too little

## By Type (v2-r3)

| Type | Support | Recall | Precision | F1 | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| `entity` | 276 | `17.8%` | `100.0%` | `30.2%` | `2.70 ms` | `4.22 ms` |
| `time` | 113 | `8.0%` | `100.0%` | `14.8%` | `2.73 ms` | `4.82 ms` |
| `preference` | 185 | `20.0%` | `100.0%` | `33.3%` | `2.47 ms` | `3.91 ms` |
| `emotion` | 101 | `2.0%` | `100.0%` | `3.9%` | `2.44 ms` | `5.73 ms` |
| `intent` | 149 | `53.0%` | `100.0%` | `69.3%` | `2.70 ms` | `3.64 ms` |
| `none` | 215 | `n/a` | `n/a` | `n/a` | `2.63 ms` | `4.03 ms` |

Interpretation:

- `intent` is the only class that looks plausibly production-ward
- `emotion` is effectively absent
- `entity` and `preference` are partially alive but far below gate quality
- `time` underperforms despite low latency

## By Difficulty (v2-r3)

| Difficulty | Support | Recall | FPR | Tier 1 hit rate | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| `explicit` | 409 | `33.5%` | `n/a` | `33.5%` | `2.70 ms` | `4.27 ms` |
| `implicit` | 143 | `9.8%` | `n/a` | `9.8%` | `2.58 ms` | `3.66 ms` |
| `trap` | 130 | `n/a` | `3.1%` | `3.1%` mis-extracted | `3.08 ms` | `4.13 ms` |
| `noisy` | 357 | `9.2%` | `2.4%` | `7.6%` | `2.39 ms` | `4.23 ms` |

This is the decisive difficulty split:

- even **explicit** samples only reach `33.5%` recall
- that is the closest slice to the gate and it still fails
- the problem is not merely implicit reasoning

## By Language (v2-r3)

| Language | Support | Recall | Precision | FPR | Tier 1 hit rate | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `en` | 699 | `30.7%` | `96.6%` | `4.1%` | `25.2%` | `2.85 ms` | `4.42 ms` |
| `zh` | 205 | `0.0%` | `0.0%` | `0.0%` | `0.0%` | `2.00 ms` | `2.72 ms` |
| `mixed` | 135 | `5.2%` | `100.0%` | `0.0%` | `4.4%` | `2.54 ms` | `4.07 ms` |

This remains the strongest no-go signal:

- English-only performance still misses the gate
- Chinese performance is zero
- mixed-language performance is effectively negligible

If D-20 expects bilingual or mixed-language behavior, the current Tier 1 implementation is nowhere close.

## By Source

### v2-r2 source split

| Source | Support | Recall | Precision | FPR | Tier 1 hit rate |
|---|---:|---:|---:|---:|---:|
| `hand` | 288 | `7.3%` | `89.5%` | `3.6%` | `6.6%` |
| `msc` | 340 | `38.2%` | `100.0%` | `0.0%` | `33.2%` |
| `personachat` | 91 | `40.0%` | `91.7%` | `5.6%` | `26.4%` |

### v2-r3 source split

| Source | Support | Recall | Precision | FPR | Tier 1 hit rate |
|---|---:|---:|---:|---:|---:|
| `hand` | 288 | `7.3%` | `89.5%` | `3.6%` | `6.6%` |
| `msc` | 340 | `38.2%` | `100.0%` | `0.0%` | `33.2%` |
| `personachat` | 91 | `40.0%` | `91.7%` | `5.6%` | `26.4%` |
| `noise-variant` | 320 | `10.0%` | `92.3%` | `2.5%` | `8.1%` |

Interpretation:

- the current prototype is dramatically source-sensitive
- public dialog corpora are easier for it than the Claude hand set
- noise variants drag performance back toward the hand-crafted floor

This means "author bias" is not one-dimensional. The self-authored baseline was inflated, but the externally hand-authored set is also materially harder than the public corpora.

## Noise Robustness (v2-r3)

By `noise_features`:

| Noise Feature | Support | Recall | FPR | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| `typo` | 60 | `7.3%` | `0.0%` | `2.15 ms` | `3.44 ms` |
| `emoji` | 65 | `6.6%` | `0.0%` | `2.29 ms` | `3.19 ms` |
| `code` | 65 | `8.2%` | `0.0%` | `2.82 ms` | `4.20 ms` |
| `short` | 67 | `0.0%` | `3.6%` | `1.93 ms` | `2.25 ms` |
| `long` | 61 | `11.1%` | `0.0%` | `3.55 ms` | `5.73 ms` |
| `mixed-lang` | 53 | `14.6%` | `0.0%` | `2.41 ms` | `4.16 ms` |

Most damaging noise modes by recall:

1. `short` -> `0.0%`
2. `emoji` -> `6.6%`
3. `typo` -> `7.3%`
4. `code` -> `8.2%`

Notes:

- `short` is intentionally adversarial because those variants were forced to `should_extract=false` when signal was destroyed
- `long` has the highest latency, but still stays far below the latency gate
- `mixed-lang` is bad, but not as catastrophic as pure Chinese because English fragments occasionally rescue a match

## Trap Matrix (v2-r3)

| Trap Reason | Support | Mis-extracted | Safe-rejected | Mis-extract rate |
|---|---:|---:|---:|---:|
| `rhetorical_question` | 44 | 1 | 43 | `2.3%` |
| `hypothetical` | 13 | 0 | 13 | `0.0%` |
| `quoted_other` | 15 | 1 | 14 | `6.7%` |
| `generic_statement` | 20 | 0 | 20 | `0.0%` |
| `negation_of_fact` | 0 | 0 | 0 | `n/a` |
| `past_abandoned` | 11 | 1 | 10 | `9.1%` |
| `command_or_request` | 6 | 0 | 6 | `0.0%` |
| `meta_conversation` | 58 | 1 | 57 | `1.7%` |

The trap picture remains acceptable overall, but it reinforces an earlier theme:

- false positives come from **naive time parsing** and **speaker attribution mistakes**
- the current prototype's main problem is still under-recall, not reckless over-extraction

## Failure Pattern Summary

Across all runs, the same four failure families keep showing up:

1. **Narrow entity phrasing**
   The prototype mainly recognizes a small set of exact English lead-ins such as `I work at`, `I live in`, `my manager is`. It misses broader but natural forms like `Based in`, `Reporting to`, `Cofounded`, `Day job is`, `My tech stack is`.

2. **Single-language assumptions**
   English regex + English spaCy model means Chinese is essentially unsupported and mixed-language only occasionally works through English fragments.

3. **Weak escalation behavior**
   Tier 2 escalation stays around `1.1%` to `1.7%` even when recall is failing hard. This confirms a "silent miss" problem, not just a lack of direct matches.

4. **Sparse emotion coverage**
   Emotion rules only hit a tiny subset of explicit English phrasings. Realistic emotion language in external corpora and noisy variants mostly falls through.

## Final D-20 Gate Decision

The gate definition for the final run was:

- recall `>= 40%`
- false-positive rate `<= 5%`
- p95 latency `< 20 ms`

v2-r3 results:

- recall `21.4%`
- false-positive rate `2.8%`
- p95 latency `4.19 ms`

### Decision

**NO.**

The current rule-first Tier 1 prototype does **not** pass the formal D-20 L3a gate.

### Why

- recall misses by a wide margin
- Chinese support is zero
- mixed-language support is still negligible
- escalation remains too low to compensate for narrow direct matches

### What this does not mean

It does **not** mean the two-tier architecture should be discarded.
It means the current prototype is too narrow to justify shipping Tier 1 into M0 Sprint 1 without a significant rule-expansion pass.

## Recommended Next Step

Tier 1 can still be a viable M0 path, but only after explicit expansion in three areas:

1. broader entity/time/preference/emotion phrase inventory
2. bilingual or multilingual rule surface
3. much stronger escalation heuristics so low-confidence misses route to Tier 2 instead of disappearing

Current consensus:

- `v1` remains in the report only as an inflated prototype baseline
- `v2-r1` exposed the first credible external failure
- `v2-r2` showed the prototype can do something useful on English public corpora
- `v2-r3` is the formal gate run, and the answer is **NO**
