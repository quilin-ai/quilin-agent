# Arm L Observer Spike Report (M0.9a)

> Date: 2026-04-23
> Status: blocked by missing Arm L inference resource; S4 records this as
> blocked, not pass or fail

## Scope

This report covers Iter M M0.9a for the L3a Observer Arm L path.

Authoritative gates:

- `recall >= 60%`
- `FPR <= 3%`
- `p95 latency <= 50 ms`

The gates come from ADR-004 lines 145-146 and were restated in the old planning
section 6.1. Current status is in `docs/STATUS.md`.
Cost is recorded as a deployment qualifier, not as the hard go/no-go gate.

## Dataset

The ADR-004 dataset path exists and is readable:

```bash
test -f docs/03-memory/l3a-observer/fixtures/dataset.json
# exit 0

wc -l docs/03-memory/l3a-observer/fixtures/dataset.json
# 14236 docs/03-memory/l3a-observer/fixtures/dataset.json

cd providers/memory && uv run python - <<'PY'
import json
from pathlib import Path
path = Path('../../docs/03-memory/l3a-observer/fixtures/dataset.json')
data = json.loads(path.read_text())
print(type(data).__name__)
print(len(data))
if isinstance(data, list) and data:
    print(sorted(data[0].keys()))
PY
# list
# 1039
# ['difficulty', 'gold_observation', 'id', 'language', 'noise_features', 'source', 'source_ref', 'text', 'trap_reason', 'type']
```

Dataset conclusion: the fixed 1039-sample fixture required by ADR-004 is
available for a comparable Arm L run.

## Resource Check

Non-sensitive resource checks were executed without printing secrets:

```bash
test -n "$ANTHROPIC_API_KEY"
# exit 1
```

Result: `ANTHROPIC_API_KEY` is unset in this session.

```bash
command -v ollama
# exit 1
```

Result: local `ollama` binary is not available on `PATH`.

```bash
curl -sSf http://localhost:11434/api/tags
# exit 7
# curl: (7) Failed to connect to localhost port 11434 after 0 ms: Couldn't connect to server
```

Result: no local Ollama server is listening on the default endpoint.

## M0.9a Result

Arm L inference did not run because neither approved inference resource is
available:

| Arm | Status | Evidence |
|---|---|---|
| Anthropic Haiku-class API | blocked | `test -n "$ANTHROPIC_API_KEY"` exit `1` |
| Local Ollama model | blocked | `command -v ollama` exit `1`; `/api/tags` curl exit `7` |

Metrics are therefore not measured in this run:

| Metric | Value |
|---|---|
| recall | N/A - blocked before inference |
| FPR | N/A - blocked before inference |
| p95 latency | N/A - blocked before inference |
| cost | N/A - blocked before inference |

Gate judgment: **blocked**, not pass or fail.

## S4 Arm L Spike Gate Record

S4 is closed for the current resource state as an executable gate record, not
as an Arm L technical pass/fail decision:

| Gate item | Current record |
|---|---|
| Dataset readiness | ready: fixed 1039-sample fixture exists and is readable |
| Resource readiness | blocked: `ANTHROPIC_API_KEY` unset, `ollama` absent, `localhost:11434` unavailable |
| Arm L metrics | unmeasured because inference did not start |
| Gate status | **blocked**, not pass or fail |
| M0.9b path | **blocked/deferred**; do not implement ML-first production observer yet |
| M0 hard gate | unchanged: L3a remains outside L1/L2 + FTS/BM25 + fusion retrieval gates |

This is also not enough evidence to choose d3 opt-in/default-off as the final
observer strategy. ADR-004 only permits that branch after a measured Arm L
failure, not after missing local or API resources.

After the blocker is removed, rerun the non-secret resource checks and record
only set/unset or exit codes:

```bash
test -n "$ANTHROPIC_API_KEY"
command -v ollama
curl -sSf http://localhost:11434/api/tags
```

Then run an ADR-approved Arm L inference pipeline over
`docs/03-memory/l3a-observer/fixtures/dataset.json` and publish:

| Required output | Gate use |
|---|---|
| recall | compare to ADR-004 `>= 60%` |
| FPR | compare to ADR-004 `<= 3%` |
| p95 latency | compare to ADR-004 `<= 50 ms` |
| cost | record as deployment qualifier, not the hard gate |

## Prior Comparable Context

Existing research artifacts show why Arm L is required before M0.9b:

- `docs/03-memory/l3a-observer/rule-first-observer-v3-report.md`: rule-first v3 reached
  recall `44.8%` and p95 `3.90 ms`, but failed FPR at `10.2%`.
- `docs/03-memory/l3a-observer/tier1-tiny-llm-spike/README.md`: an earlier tier-1 tiny LLM
  spike also found Haiku and local model arms blocked by missing resources.

These are prior context only; they are not a fresh M0.9a Arm L run.

## Next Unblock Steps

1. Provide a non-production `ANTHROPIC_API_KEY` for a Haiku-class model, or
   install and start Ollama with a tiny local model such as `qwen2.5:3b` or
   `llama3.2:3b`.
2. Re-run the 1039-sample fixture and report recall, FPR, p95 latency, and
   cost under ADR-004's `60/3/50` gate.
3. Only after a measured Arm L result exists, decide M0.9b:
   ML-first observer if Arm L passes, or d3 opt-in/default-off if it fails.

## Boundary

This report does not implement the production L3a observer and does not change
the Memory M0 hard gate. M0 remains scoped to L1/L2, FTS/BM25, and fusion
retrieval, with L3a final implementation excluded until M0.9b. While S4 is
blocked, M0.9b remains blocked/deferred rather than a production implementation
task.
