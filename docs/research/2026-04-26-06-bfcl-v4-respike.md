# BFCL v4 Re-spike — E3b Day 0

> **Date**: 2026-04-26
> **Status**: Proposed
> **Scope**: Iter E3b Day 0 re-spike only. No benchmark runtime code is authorized by this note.
> **Decision**: Directly implement E3b as a **BFCL v4 non-live/live AST slice**, with explicit partial-eval labeling. Full BFCL v4 leaderboard parity remains out of scope until E3c/E4.

## 0. Why This Re-spike Exists

The week-old E3 plan assumed a flatter BFCL v4 output layout and a broad "single/live AST" implementation. Official BFCL v4 now has a two-level result/score hierarchy, a revised category map, a `--partial-eval` mode, and a score formula that heavily weights agentic and multi-turn categories. E3b must therefore freeze a narrower contract before coding.

## 1. Sources Checked

Official/current sources:

- BFCL live leaderboard: <https://gorilla.cs.berkeley.edu/leaderboard>
- BFCL pinned reproducibility commit: `f7cf735` from the live leaderboard
- BFCL category mapping at pinned commit: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py>
- BFCL CHANGELOG at pinned commit: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/CHANGELOG.md>
- BFCL CLI README: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/README.md>
- BFCL v4 web-search blog: <https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html>
- BFCL v4 memory blog: <https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html>
- Public result archive: <https://github.com/HuanzhiMao/BFCL-Result>

Local evidence commands run in this spike:

```bash
curl -fsSL 'https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py'
curl -fsSL 'https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/utils.py' | sed -n '275,350p'
curl -fsSL 'https://api.github.com/repos/HuanzhiMao/BFCL-Result/contents/2025-12-16/result/gpt-5-mini-2025-08-07-FC?ref=main' | jq -r '.[].name'
curl -fsSL 'https://api.github.com/repos/HuanzhiMao/BFCL-Result/contents/2025-12-16/result/gpt-5-mini-2025-08-07-FC/agentic/memory/kv?ref=main' | jq -r '.[].name'
```

I did not run `git clone` because this session has an explicit no-git-write constraint. The verification used the live leaderboard's pinned commit via raw GitHub URLs and the public BFCL result archive; no model API keys or official generation run were required.

## 2. Official State

### 2.1 Reproducibility Pin

The live BFCL v4 leaderboard says it was last updated on 2026-04-12 and evaluates models using commit `f7cf735`; it also names `bfcl-eval==2025.12.17` as the reproducible PyPI package version.

### 2.2 Category Enum

Pinned `category_mapping.py` defines:

| Group | Categories |
|---|---|
| `non_live` | `simple_python`, `simple_java`, `simple_javascript`, `multiple`, `parallel`, `parallel_multiple`, `irrelevance` |
| `live` | `live_simple`, `live_multiple`, `live_parallel`, `live_parallel_multiple`, `live_irrelevance`, `live_relevance` |
| `multi_turn` | `multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`, `multi_turn_long_context` |
| `agentic.web_search` | `web_search_base`, `web_search_no_snippet` |
| `agentic.memory` | `memory_kv`, `memory_vector`, `memory_rec_sum` |
| non-scoring | `format_sensitivity` |

Derived groups:

- `single_turn = non_live + live`
- `agentic = web_search + memory`
- `all_scoring = single_turn + multi_turn + agentic`
- `format_sensitivity` is explicitly non-scoring but still runnable.

### 2.3 Result And Score Hierarchy

The official v4 changelog freezes this layout:

```text
result/<model>/<general_category>/<category>.json
score/<model>/<general_category>/<category>.json
```

For memory-agentic tasks, there is an extra backend level:

```text
result/<model>/agentic/memory/<backend>/<category>.json
score/<model>/agentic/memory/<backend>/<category>.json
```

Pinned source confirms the same rule:

- `get_directory_structure_by_category("simple_python")` -> `non_live`
- `get_directory_structure_by_category("live_simple")` -> `live`
- `get_directory_structure_by_category("memory_kv")` -> `agentic/memory/kv`

Public result archive probe confirmed real generated directories for `gpt-5-mini-2025-08-07-FC`:

```text
result/gpt-5-mini-2025-08-07-FC/non_live/BFCL_v4_simple_python_result.json
result/gpt-5-mini-2025-08-07-FC/agentic/BFCL_v4_web_search_base_result.json
result/gpt-5-mini-2025-08-07-FC/agentic/memory/kv/BFCL_v4_memory_kv_result.json
```

### 2.4 Partial Eval

Official CLI supports:

```bash
bfcl evaluate --model MODEL_NAME --test-category TEST_CATEGORY --partial-eval
```

`--partial-eval` lets evaluation skip missing IDs in model result files and compute accuracy over the remaining entries. Official docs warn that this score can differ from a full-set run and may not match leaderboard numbers. The evaluator also treats unevaluated categories as `N/A` for detail tables and as zero for summary columns.

Implication for Quilin: E3b outputs must carry a `partial_eval: true` / `official_parity: false` metadata marker whenever only non-live/live AST categories or first-N smoke rows are run.

### 2.5 Submission / Result File Shape

BFCL's native "submission" is not a single upload JSONL. It is a result directory tree consumed by `bfcl evaluate`. Result files are JSONL-style line-delimited JSON where each entry minimally contains:

```json
{"id":"simple_python_0","result":[{"function_name":"..."}]}
```

Official generated results also include telemetry such as `input_token_count`, `output_token_count`, `latency`, and sometimes reasoning content. Evaluation score files mirror result paths and begin with an aggregate header object:

```json
{"accuracy":0.7875,"correct_count":315,"total_count":400}
```

Implication for Quilin:

- E3b adapter should write official BFCL result hierarchy, not invent a standalone JSONL upload shape.
- Existing Quilin submission adapter can produce a manifest around that tree, but the official artifact is the directory.
- `BFCL_PROJECT_ROOT` / `--result-dir` / `--score-dir` map cleanly to `benchmarks.output_dir`.

## 3. Scorer Formula

### 3.1 Full BFCL v4

The v4 blog and `eval_runner_helper.py` agree on the official weighted score:

```text
Overall = Agentic * 40% + Multi-Turn * 30% + Live * 10% + Non-Live * 10% + Hallucination * 10%
```

Within-category handling:

- Agentic: unweighted average of web search and memory summaries.
- Multi-turn: unweighted average of the four multi-turn categories.
- Live: weighted by actual test counts for AST categories; relevance/irrelevance reported separately.
- Non-live: unweighted over simple/multiple/parallel/parallel_multiple; irrelevance reported separately.
- Hallucination is represented by relevance/irrelevance behavior in the overall table, not by a separate E3b-only file.

### 3.2 E3b AST Slice

E3b should only implement deterministic single-turn AST categories:

- Non-live AST: `simple_python`, `simple_java`, `simple_javascript`, `multiple`, `parallel`, `parallel_multiple`, plus `irrelevance` as refusal/no-call detection.
- Live AST: `live_simple`, `live_multiple`, `live_parallel`, `live_parallel_multiple`, plus `live_irrelevance` and `live_relevance`.

Official BFCL scorer dispatch:

- Relevance/irrelevance: decode whether a function call exists.
- Simple/multiple/parallel AST: parse model output into function-call AST and compare function name, parameter presence, type, and value.
- Java and JavaScript simple categories require language-specific converters.

E3b should not claim official BFCL v4 parity because it excludes:

- Multi-turn state-transition checks.
- Agentic web-search answer extraction.
- Agentic memory backend setup and snapshot/reload.
- Format-sensitivity non-scoring variation suite.

## 4. E3b Contract Proposal

### 4.1 Dataset Naming

Keep wire dataset as:

```ts
dataset: "bfcl-v4"
```

Do **not** add `bfcl-v4-ast` as a dataset enum. Instead freeze a BFCL-specific run subset:

```ts
metadata.bfcl = {
  version: "v4",
  general_categories: ["non_live", "live"],
  categories: [...],
  partial_eval: true,
  official_parity: false
}
```

Reason: official BFCL has one dataset/version with selectable test categories. Inventing a dataset enum for the AST subset would blur official naming.

### 4.2 Loader

E3b loader should:

- Read BFCL v4 native category files into one `BenchmarkTask` per entry.
- Preserve `task_id = id`.
- Set `dataset = "bfcl-v4"`.
- Set `scorer_type = "bfcl-v4-ast"` for AST categories and `bfcl-v4-relevance` for relevance/irrelevance, or use one scorer with category dispatch.
- Normalize official category names exactly; no legacy `simple/java/javascript` aliases in stored tasks.
- Support `takeFirstN` / smoke selection but mark output as partial.

### 4.3 Scorer

Implementation options:

1. **Port minimal AST checker to TS** for E3b categories.
2. **Shell out to official `bfcl evaluate`** after writing result files.

My independent view is: start with option 1 for unit-testable E3b smoke and add option 2 as an optional compatibility check. Directly shelling out to official BFCL pulls a large Python dependency graph and model registry into the hot path, and it does not fit Quilin's current TS harness shape. However, E3b R1 must compare TS scorer fixtures against official AST cases to catch drift.

### 4.4 Submission Adapter

Adapter should write:

```text
result/<model>/<general_category>/BFCL_v4_<category>_result.json
result/<model>/agentic/memory/<backend>/BFCL_v4_<category>_result.json  # E3c2 only
```

For E3b, only `non_live` and `live` paths are generated. Score files are not produced by the submission adapter; they are produced by scorer/evaluator.

### 4.5 Partial-eval Marker

Every E3b output manifest must include:

```json
{
  "dataset": "bfcl-v4",
  "bfcl_version": "v4",
  "categories_requested": ["simple_python", "..."],
  "general_categories_requested": ["non_live", "live"],
  "partial_eval": true,
  "official_parity": false,
  "reason": "E3b implements the non-live/live AST slice only"
}
```

If a future run covers all scoring categories, then and only then can `official_parity` become true.

## 5. E3c/E4 Split

| Scope | Categories | Why Not E3b |
|---|---|---|
| E3c1 multi-turn | `multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`, `multi_turn_long_context` | Requires stateful turn handling and official multi-turn checker semantics |
| E3c2 agentic web-search | `web_search_base`, `web_search_no_snippet` | Requires web-search tool contract and final answer extraction |
| E3c2 agentic memory | `memory_kv`, `memory_vector`, `memory_rec_sum` | Requires memory backend setup, prereq result files, snapshot/reload, and extra path level |
| E4 / Iter F+ | hallucination/relevance weighting + full official score parity | Tied to agentic categories and long trajectory behavior |

## 6. Risks And Review Gates

Required E3b R1 review checks:

- Official category enum copied from `category_mapping.py` exactly.
- No legacy README `BFCL_v3_*` path assumptions.
- Result adapter writes two-level official v4 paths.
- `partial_eval` and `official_parity=false` cannot be omitted for subset runs.
- AST scorer fixtures include Python, Java, JavaScript, multiple, parallel, parallel_multiple, relevance, and irrelevance.
- Optional official BFCL compatibility smoke either passes or is documented as blocked by dependency/model-registry setup.

## 7. Spike Decision

Decision: **directly implement E3b non-live/live AST slice**.

Rejected alternatives:

- **Split non-live first, live later**: not necessary. Live AST uses the same scorer shape; the only extra work is larger fixtures and relevance detection.
- **Implement full BFCL v4 now**: not acceptable. Agentic + multi-turn are 70% of official score and need new runtime contracts.
- **Abandon BFCL v4**: not justified. Official v4 is current, reproducible, and fits Quilin's benchmark ascent once scoped correctly.

Next documents before code:

1. `docs/planning/2026-04-26-04-iter-e3b-day0-respike.md` — freeze E3b contract from this research.
2. `docs/planning/2026-04-26-05-iter-e3b-bfcl-ast.md` — implementation breakdown.
3. ADR-010 amendment — add BFCL v4 metadata / partial-eval / official-parity fields if not already covered by the wire schema.
