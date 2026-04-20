# Tier-1 Tiny LLM Spike (D-21 / Subagent-B2)

## Scope

Objective: validate whether tiny LLM can replace pure-rule Tier-1 classifier on the fixed 1039-sample dataset.

Dataset:
- `docs/research/fixtures/rule-first-observer/dataset.json` (1039 samples)

Baseline source reused:
- `.spike/observer/results-v2-r3.json`
- `docs/research/rule-first-observer-spike-report.md`

Output:
- `docs/research/tier1-tiny-llm-spike/results.json`

## Experimental Design

Arms:
1. `rule_v2_r3_baseline` (pure rule, reuse existing report numbers)
2. `haiku_only` (all samples classified by Haiku)
3. `rule_prefilter_to_haiku` (rule predicts positive => accept rule result; otherwise call Haiku)
4. `local_2b` (Ollama local model, default `qwen2.5:1.5b-instruct`)

Metrics (same outcome semantics as baseline runner):
- `recall` = TP / gold positives
- `fpr` = FP / gold negatives
- `p95_latency_ms` = p95 end-to-end per sample
- `cost_per_1k_calls_usd`

Outcome semantics:
- TP requires **both** `should_extract=true` and correct `type` match.
- Any positive with wrong type is counted as FN (same as baseline script behavior).

Pricing assumptions:
- Haiku list pricing set as input `$0.80 / 1M tokens`, output `$4.00 / 1M tokens`.
- Local 2B arm cost treated as direct API cost = `$0` (compute not monetized in this spike).
- Reference: Anthropic pricing page (`https://platform.claude.com/docs/en/docs/about-claude/pricing`), checked on 2026-04-20.

## Actual Runnable Matrix

| Arm | Planned | Status | Notes |
|---|---|---|---|
| `rule_v2_r3_baseline` | Reuse existing run | ✅ `ok` | numbers loaded from `.spike/observer/results-v2-r3.json` |
| `haiku_only` | Full 1039 eval | ⛔ `blocked` | `ANTHROPIC_API_KEY unavailable` |
| `rule_prefilter_to_haiku` | Full 1039 eval | ⛔ `blocked` | `ANTHROPIC_API_KEY unavailable` |
| `local_2b` | Full 1039 eval | ⛔ `blocked` | local Ollama endpoint/model unavailable |

## Numbers

### 1) Pure Rule v2-r3 Baseline

- recall: `0.2136` (21.36%)
- FPR: `0.0279` (2.79%)
- p95 latency: `4.1928 ms`
- cost per 1k calls: `$0.0000`
- confusion: `TP=176, FN=648, FP=6, TN=209`

### 2) Haiku-only

- status: `blocked`
- blocker: `ANTHROPIC_API_KEY unavailable`
- metrics: `N/A`

### 3) Rule Prefilter -> Haiku

- status: `blocked`
- blocker: `ANTHROPIC_API_KEY unavailable`
- metrics: `N/A`

### 4) Local 2B

- status: `blocked`
- blocker: `ollama unavailable` / endpoint not serving target model
- metrics: `N/A`

## Blockers and Repro Steps

Environment probe commands used:

```bash
python3 - <<'PY'
import os
print('ANTHROPIC_API_KEY', 'available' if bool(os.environ.get('ANTHROPIC_API_KEY')) else 'unavailable')
PY

ollama --version
ollama list

python3 .spike/tier1-tiny-llm/run_spike.py
```

Observed blockers:
- Anthropic key unavailable in this execution environment.
- No working local Ollama runtime/model for 2B-class arm.

## Independent Gate Judgment

Current D-20 gate: `recall >= 40%`, `FPR <= 5%`, `p95 < 20ms`.

Judgment:
- For **pure-rule Tier-1**, gate is directionally reasonable and currently fails mainly on recall.
- For **remote API tiny LLM** (Haiku-only), `p95 < 20ms` is likely over-strict in real network conditions.
- Gate lacks an explicit cost constraint while this spike explicitly tracks cost; that is under-specified.

Suggested gate refinement by deployment mode:
- Rule/local model mode: keep strict latency (`<20ms`) and add minimal recall/FPR bar.
- Remote API mode: add separate latency envelope and explicit cost cap (per 1k calls).

## Recommendation

Decision: **先做更小验证（not continue full substitution yet）**

Reason:
- Three LLM arms are environment-blocked; there is no empirical evidence yet for replacement value.
- Only baseline is runnable, and it still misses recall gate significantly.

Proposed next smallest validation:
1. Unblock one remote arm (`haiku_only`) with non-production key in isolated env.
2. Run a stratified 120-sample smoke set first (en/zh/mixed + noisy/trap included) to estimate recall/FPR/cost quickly.
3. If smoke recall is not at least `+10~15 pts` over baseline, stop; if yes, run full 1039.
