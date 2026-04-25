# Iter E3 Day 0 Spike: GAIA + BFCL v4

Date: 2026-04-26
Scope: spike-only research for Iter E3 Bohr/Hilbert tracks. No runtime code changes.

## Decision

**Decision: split sub-iter.**

Do not start GAIA and full BFCL v4 in one parallel slice. The next implementation should be:

1. **E3a GAIA**: loader + exact-match scorer + JSONL submission adapter + attachment cache mounting.
2. **E3b BFCL v4 single-turn**: GitHub-backed v4 loader + AST scorer wrapper for non-live/live single-turn categories.
3. **E3c BFCL v4 multi-turn/agentic**: stateful evaluator/session contract after E3b. If the stateful evaluator contract cannot be frozen quickly, downgrade multi-turn/agentic to E4 rather than blocking E3a/E3b.

Rationale: GAIA is gated but structurally straightforward. BFCL v4 is not just "single/multiple/parallel/live"; the official v4 taxonomy includes multi-turn, memory, web-search, and agentic categories, and the multi-turn path executes stateful tool calls across turns. A single dual-track implementation would either under-implement BFCL v4 or create another review loop around implicit state.

## Git Evidence

- `git rev-parse --short HEAD`: `f3b286a`
- `benchmarks/src/wire/task.ts` still accepts only `swe-bench-lite` / `swe-bench-verified`.
- ADR-010 already states the Iter E3 enum must be `swe-bench-lite | swe-bench-verified | gaia | bfcl-v4`.

The zod enum sync should be the first implementation commit after this spike, not part of this spike-only report:

```ts
z.enum(["swe-bench-lite", "swe-bench-verified", "gaia", "bfcl-v4"])
```

## GAIA Findings

Official source: <https://huggingface.co/datasets/gaia-benchmark/GAIA>

- Access: HuggingFace dataset is `gated: auto`; implementation needs an HF token and must handle 401 as an actionable setup error.
- Format: Parquet-backed splits mirror the former JSONL structure. The API exposes configs for `2023_all`, `2023_level1`, `2023_level2`, and `2023_level3`.
- Size and levels: the official leaderboard app constants show validation has 165 tasks with level counts `53 / 86 / 26`; test has 301 tasks with level counts `93 / 159 / 49`.
- Attachments: HF API currently lists 38 validation attachments and 71 test attachments, with file types including PDF, MP3, PNG, JSON, MOV, TXT, XML, XLSX, CSV, and DOCX. Loader must treat `file_name` as a cache-relative artifact, not inline content.
- Normalized task shape should be:
  - `task_id`: GAIA `task_id`
  - `dataset`: `gaia`
  - `inputs`: `{ question, level, file_name?, file_attachments? }`
  - `expected`: `{ final_answer, eval_metadata }`
  - `scorer_type`: `gaia-exact-match`

DockerSandbox compatibility is acceptable for E3a: download metadata and attachments into the benchmark cache, mount cache read-only into the task container, and pass container-local attachment paths to the agent.

## GAIA Scoring And Submission

Official leaderboard source: <https://huggingface.co/spaces/gaia-benchmark/leaderboard>

- Scoring is **not LLM-as-judge**. The leaderboard uses `question_scorer`, described by its own submission text as quasi exact match with normalization tied to the ground-truth answer type.
- Official submission is JSONL. `task_id` and `model_answer` are mandatory; `reasoning_trace` is optional.
- The leaderboard app currently rejects validation submissions as no longer informative; official public submission is test-set oriented. Local E3 validation runs are still useful for smoke and regression tests.

Adapter implication: keep the plan's `gaia-jsonl` adapter, but validate the exact fields above and do not invent an upload endpoint.

## BFCL v4 Findings

Official code source: <https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard>

- The HuggingFace dataset `gorilla-llm/Berkeley-Function-Calling-Leaderboard` currently exposes BFCL v3 files. For **v4**, the authoritative source is the GitHub repo under `berkeley-function-call-leaderboard/bfcl_eval/data`.
- `category_mapping.py` sets `VERSION_PREFIX = "BFCL_v4"`.
- Official categories include:
  - single-turn non-live: `simple_python`, `simple_java`, `simple_javascript`, `multiple`, `parallel`, `parallel_multiple`, `irrelevance`
  - live: `live_simple`, `live_multiple`, `live_parallel`, `live_parallel_multiple`, `live_irrelevance`, `live_relevance`
  - multi-turn: `multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`, `multi_turn_long_context`
  - agentic: `memory_kv`, `memory_vector`, `memory_rec_sum`, `web_search_base`, `web_search_no_snippet`
  - non-scoring: `format_sensitivity`
- Prompt files are JSONL-like records with `id`, nested `question` turns, and `function` docs. Multi-turn records also include `initial_config`, `path`, and `involved_classes`.
- Ground truth lives under `data/possible_answer/BFCL_v4_*.json` with `ground_truth` function-call structures.

Fetch implication: BFCL v4 should use GitHub raw/API allowlist (`raw.githubusercontent.com` and optionally `api.github.com`) rather than the HF v3 dataset.

## BFCL v4 Scoring And Submission

Official README: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/README.md>

- Official generation writes result files under `result/MODEL_NAME/BFCL_v4_<category>_result.json`.
- Official evaluation writes score files and CSV summaries under `score/`, including `data_overall.csv`, `data_live.csv`, `data_non_live.csv`, `data_multi_turn.csv`, `data_agentic.csv`, and `data_format_sensitivity.csv`.
- The AST scorer dispatches simple vs multiple vs parallel cases. Multi-turn uses a separate evaluator that executes predicted calls turn-by-turn against initialized class instances.
- Public leaderboard submission is not a simple HTTP upload contract in the docs. The README describes local generation/evaluation and contribution through the project workflow. The current plan's `bfcl-csv` adapter should be tightened to "BFCL result tree + score CSV package" unless a later official upload endpoint is verified.

Implementation implication: do not hand-roll the full BFCL scorer in TS first. Prefer wrapping the official Python evaluator inside the DockerSandbox for E3b/E3c, with a TS adapter that normalizes Quilin results into official `BFCL_v4_*_result.json` shape.

## DockerSandbox Compatibility

- GAIA: compatible with current stateless per-task DockerSandbox if attachments are cache-mounted read-only and outputs are exported through artifacts.
- BFCL single-turn/live: compatible if the scorer wrapper runs official evaluator in Docker after the model result file is produced.
- BFCL multi-turn: needs a stateful task session. The official evaluator executes function calls across turns and preserves involved instances. The current DockerSandbox CLI MVP is command-oriented; E3c should freeze either:
  - a task-level container session API, or
  - an official-evaluator wrapper that owns state entirely inside one Docker invocation.
- BFCL agentic web-search requires SerpAPI or equivalent credentials per official README. That should be a separate gated sub-slice, not bundled into E3b.

## Fetch CLI Changes

Required allowlist additions:

- GAIA: `huggingface.co/datasets/gaia-benchmark/GAIA`, `huggingface.co/api/datasets/gaia-benchmark/GAIA`, and resolved HF file URLs for gated Parquet/attachments.
- BFCL v4: `raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data/` plus GitHub contents API if the fetcher needs to enumerate v4 files.

Do not add a broad `github.com/*` or `huggingface.co/*` allowlist. Keep endpoint-specific checks, because E2 already fixed SSRF/cache pitfalls.

## Next Implementation Plan

1. Sync `benchmarks/src/wire/task.ts` enum and tests to include `gaia` and `bfcl-v4`.
2. E3a Bohr:
   - GAIA cache/fetch loader with HF token setup errors.
   - Attachment manifest and cache-contained path checks.
   - `gaia-exact-match` scorer based on the official normalization behavior.
   - `gaia-jsonl` adapter with mandatory `task_id` / `model_answer` and optional `reasoning_trace`.
3. E3b Hilbert:
   - BFCL v4 GitHub raw loader for single-turn non-live/live categories first.
   - Official AST evaluator wrapper in Docker.
   - Result tree + score CSV package adapter.
4. E3c Hilbert stateful:
   - Multi-turn and agentic evaluator contract.
   - Decide whether web-search/memory categories need external credentials or are deferred.

## Sources

- GAIA dataset card and file listing: <https://huggingface.co/datasets/gaia-benchmark/GAIA>
- GAIA leaderboard app and scorer: <https://huggingface.co/spaces/gaia-benchmark/leaderboard>
- GAIA paper: <https://arxiv.org/abs/2311.12983>
- BFCL official repo: <https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard>
- BFCL test categories: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md>
- BFCL v4 category mapping: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py>
- BFCL AST checker: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/ast_eval/ast_checker.py>
- BFCL multi-turn evaluator utilities: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py>
