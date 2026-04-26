# Roadmap Reassessment — Codex View

Date: 2026-04-26

Scope: BFCL v4 official harness status and memory framework fit check. This is a research note for `docs/planning/2026-04-26-03-roadmap-reassess-2026-04.md`; it does not authorize implementation by itself.

## Sources

- BFCL live leaderboard: <https://gorilla.cs.berkeley.edu/leaderboard.html>
- BFCL GitHub README: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/README.md>
- BFCL raw category mapping: <https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py>
- BFCL `TEST_CATEGORIES.md`: <https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md>
- BFCL changelog: <https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/CHANGELOG.md>
- BFCL v4 web-search blog: <https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html>
- Mem0 OSS docs: <https://docs.mem0.ai/open-source/overview>
- Letta Docker / MemFS docs: <https://docs.letta.com/guides/docker>
- LangGraph memory docs: <https://docs.langchain.com/oss/javascript/concepts/memory>

## BFCL v4 Findings

### Official state

- The live leaderboard is BFCL V4 and says it was last updated 2026-04-12. It also pins reproducibility to a specific code commit and PyPI package version (`bfcl-eval==2025.12.17`).
- The current raw category mapping uses `VERSION_PREFIX = "BFCL_v4"` and splits scoring categories into:
  - `non_live`: `simple_python`, `simple_java`, `simple_javascript`, `multiple`, `parallel`, `parallel_multiple`, `irrelevance`
  - `live`: `live_simple`, `live_multiple`, `live_parallel`, `live_parallel_multiple`, `live_irrelevance`, `live_relevance`
  - `multi_turn`: `multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`, `multi_turn_long_context`
  - `agentic`: `web_search_base`, `web_search_no_snippet`, `memory_kv`, `memory_vector`, `memory_rec_sum`
  - `format_sensitivity` is non-scoring.
- The BFCL v4 blog changes the score weighting materially: Agentic 40%, Multi-Turn 30%, Live 10%, Non-Live 10%, Hallucination 10%. It is no longer a simple "single/live AST first" benchmark if the target is official leaderboard parity.
- The changelog documents a V4 directory layout overhaul:
  - `result/<model>/<general_category>/<category>.json`
  - `score/<model>/<general_category>/<category>.json`
  - Memory agentic tasks add one extra level: `result/<model>/agentic/<memory_backend>/<category>.json`
  - `general_category` is `{non_live, live, multi_turn, agentic, format_sensitivity}`.

### Drift from our existing spike

- The old spike assumption `result/MODEL_NAME/BFCL_v4_<category>_result.json` is not current. The README still contains older `BFCL_v3_*` examples, but the changelog explicitly supersedes this with the V4 two-level hierarchy. For implementation, use changelog + category mapping, not README path examples.
- "E3b = BFCL single/live AST" is still useful as a first executable slice, but it is not sufficient for an official BFCL V4 leaderboard run. It should be renamed to **E3b BFCL v4 non-live/live AST slice** and keep official-score parity out of scope.
- E3c should remain for multi-turn/agentic, but now needs a sharper split:
  - E3c1: multi-turn categories and state/response checker integration.
  - E3c2: agentic web-search + memory categories, because these introduce external service requirements and memory backend semantics.
  - `format_sensitivity` should be explicitly non-scoring and optional.

### Recommendation

Decision: **re-spike E3b for 1 small Day 0 contract before coding**, then implement only non-live/live AST categories.

The re-spike should freeze:

- BFCL category enum and grouping from current `category_mapping.py`.
- Result and score path layout from the V4 changelog.
- Adapter behavior for partial category runs: official `--partial-eval` exists, but our adapter must mark partial output as non-official.
- Submission contract: store Quilin-generated outputs in official BFCL result hierarchy, then optionally call upstream `bfcl evaluate` later. Do not invent a standalone official score format.
- Web-search and memory categories are explicitly out of E3b; they require SerpAPI / memory backend contracts and should not be silently skipped in "official" mode.

## Memory Framework Findings

### Mem0

Mem0 OSS is the closest external memory layer by shape: Python and Node usage, self-hosted option, and configurable vector stores. However, its library defaults still assume external providers (`OpenAI`, local Qdrant, SQLite history), and the server stack defaults to Postgres + pgvector. It can be watched or used for adapter experiments, but replacing OmniMem would violate Quilin's zero external DB / local-first Iter F assumptions unless ADR-002 changes.

Recommendation: **do not replace OmniMem**. Add/keep Mem0 in the watchlist and consider a later import/export adapter only after Iter F memory stabilizes.

### Letta

Letta is strong conceptually for stateful agents and memory management, but its server path is Postgres-centric. MemFS is promising because it is git-backed and closer to Quilin's durable editable memory direction, but the full git sync path needs extra server/sidecar support and its custom tool sandboxing excludes MCP tools. This conflicts with Quilin's Python MCP providers + unified WriteAuthority boundary.

Recommendation: **watch Letta / MemFS, do not adopt as runtime substrate**.

### Cognee / GraphRAG / LangGraph memory

Cognee and GraphRAG are useful as semantic/graph memory references, not drop-in replacements for four-tier working/episodic/semantic/skill memory. LangGraph memory explicitly treats long-term memory as namespace-backed custom storage and acknowledges memory design as application-specific; it does not remove Quilin's need to define layer semantics, WriteAuthority, and local storage.

Recommendation: **keep hand-rolled OmniMem 4-tier; borrow patterns only**.

## Merge Recommendations

1. **E3b**: re-spike before implementation. Keep BFCL plan, but update the scope to current V4 category grouping and path hierarchy.
2. **E3c**: split multi-turn and agentic categories; do not bundle web-search/memory agentic into the AST slice.
3. **Iter F memory**: preserve OmniMem 4-tier. Add `letta.md` to memory watchlist; continue "follow ideas, not code".
4. **§17 residuals**: LongMemEval remains relevant as the real memory benchmark gate, but no longer blocks BFCL E3b. It should stay in blocked/watch status until dataset vendoring is stable.

