# Graphiti Dependency Spike

Task #93. Goal: determine whether `graphiti-core` can replace OmniMem Layer 3 KG as the default Iter C backend without changing production code.

## Executive Summary

**Recommendation: no, do not switch Iter C to Graphiti by default yet.**

Graphiti is promising, but the current `0.28.2` package is not "zero-config" in the way Iter C needs:

- Python 3.14 compatibility is only a **qualified yes**.
  Base `graphiti-core` installs and imports on Python 3.14, but the only embedded backend found in the package is Kuzu, and `kuzu==0.11.3` had to be compiled from source in the spike environment.
- The default Graphiti path is **not embedded and not zero-config**.
  `Graphiti()` without an explicit `graph_driver` immediately fails with `ValueError: uri must be provided when graph_driver is None`, and the constructor defaults to Neo4j + OpenAI-family clients.
- The embedded Kuzu path is **not production-ready out of the box** in `0.28.2`.
  Even after `kuzu` was installed, the first `add_episode()` failed because Graphiti's Kuzu driver does not create the full-text-search indexes that its own search pipeline requires.
- The minimal API can run **only after a workaround**:
  inject `KuzuDriver(db=":memory:")`, inject fake LLM/embedder/reranker clients, and manually execute the Kuzu FTS index setup.

My independent view is: Graphiti is a viable future experiment, but not a safe default swap for Iter C. Revisit only after upstream or local adapter work closes the zero-config gap.

## Environment

- Host Python: `Python 3.14.4`
- Tooling: `uv 0.9.13`
- Spike env: `.spike/graphiti/.venv`
- Package versions:
  - `graphiti-core==0.28.2`
  - `kuzu==0.11.3`
- `graphiti-core` metadata:
  - `Requires-Python: <4,>=3.10`

## Question 1. Does Graphiti install on Python 3.14?

### Result

**Yes for the base package, but not cleanly for the embedded backend path.**

### Evidence

1. Base package install succeeded:

```bash
cd .spike/graphiti
uv pip install graphiti-core==0.28.2
```

2. Base package imports succeeded:

- `graphiti_core.graphiti`
- `graphiti_core.driver.neo4j_driver`

3. Embedded backend import initially failed because `kuzu` was missing:

- `graphiti_core.driver.kuzu_driver` raised `ModuleNotFoundError: No module named 'kuzu'`

4. The clean `uv sync` path for `graphiti-core[kuzu]==0.28.2` was not zero-effort on Python 3.14.
   In the spike session, `kuzu` fell back to source build and initially failed until local build prerequisites were added.

5. After manual intervention, the backend package did install:

```text
Built kuzu==0.11.3
Installed 1 package
+ kuzu==0.11.3
```

### Conclusion

Install compatibility is **not the blocker**. The blocker is that Python 3.14 currently pushes the embedded backend down a manual source-build path, which is too heavy for "default Iter C dependency" standards.

## Question 2. Can Graphiti run zero-config without Neo4j Docker?

### Result

**No. Not in the form Iter C needs.**

### Evidence

1. Default constructor is Neo4j-oriented:

```python
Graphiti()
# ValueError: uri must be provided when graph_driver is None
```

2. Source inspection shows the constructor defaults to:

- `Neo4jDriver`
- `OpenAIClient`
- `OpenAIEmbedder`
- `OpenAIRerankerClient`

3. An embedded backend does exist in source:

```python
KuzuDriver(db=":memory:")
```

4. There is **no SQLite backend** in `graphiti_core` source. A repository-wide grep of the installed package found no `sqlite` implementation path.

5. Even the Kuzu path is not really zero-config in `0.28.2`.
   The first `add_episode()` against in-memory Kuzu failed with:

```text
Binder exception: Table Entity doesn't have an index with name node_name_and_summary.
```

The failure comes from Graphiti calling Kuzu full-text search before the required FTS indexes exist.

6. Package internals are inconsistent here:

- `graphiti_core.graph_queries.get_fulltext_indices(GraphProvider.KUZU)` defines the needed Kuzu FTS setup
- `KuzuDriver.build_indices_and_constraints()` is a no-op

That means the embedded Kuzu path needs manual bootstrapping even though the package already knows which indexes it needs.

### Conclusion

Graphiti does **not** currently satisfy "zero-config embedded backend" for Quilin:

- default path -> Neo4j + OpenAI
- embedded path -> Kuzu only
- Kuzu path -> manual build + manual index bootstrap

## Question 3. Can the minimal API run?

### Result

**Yes, but only with a workaround and fake clients.**

### What was run

The spike used:

- `KuzuDriver(db=":memory:")`
- manual Kuzu FTS creation via `get_fulltext_indices(GraphProvider.KUZU)`
- fake `LLMClient`
- fake `EmbedderClient`
- fake `CrossEncoderClient`

The episode inserted 3 facts in one call:

1. `Alice Zhang works at Acme Corporation.`
2. `Alice Zhang leads Project Lantern.`
3. `Acme Corporation is headquartered in Shanghai.`

### Minimal example that worked

```python
driver = KuzuDriver(db=":memory:")
await create_kuzu_fts_indices(driver)  # required workaround

graphiti = Graphiti(
    graph_driver=driver,
    llm_client=FakeLLMClient(),
    embedder=FakeEmbedder(),
    cross_encoder=FakeCrossEncoder(),
)

await graphiti.add_episode(
    name="graphiti-spike-episode",
    episode_body=EPISODE_BODY,
    source_description="Graphiti dependency spike",
    reference_time=datetime(2026, 4, 20, 12, 0, tzinfo=UTC),
    source=EpisodeType.text,
)

edges = await graphiti.search("Alice Zhang works at Acme Corporation")
nodes = await graphiti.search_(query="Project Lantern", config=NODE_HYBRID_SEARCH_RRF)
```

### Observed output

- `add_episode()` succeeded
- `search()` returned `3` edges
- node-level retrieval returned `4` nodes

### `node_search` naming note

There is **no public `Graphiti.node_search()` method** in `0.28.2`.

What exists instead:

- public `Graphiti.search_()` with a node-only config such as `NODE_HYBRID_SEARCH_RRF`
- internal helper `graphiti_core.search.search.node_search(...)`

The internal helper was also invoked directly during the spike and returned 4 nodes successfully.

### Important caveat

This POC proves the storage/search path can run with Kuzu in memory.
It does **not** prove production readiness, because the spike deliberately replaced the default OpenAI-based extraction stack with fake local clients to avoid network coupling and billing noise.

## Question 4. What are the latency baselines?

### Result

With in-memory Kuzu and fake local clients, the storage/search layer was fast:

| Operation | Latency |
|-----------|---------|
| Cold start | `183.49 ms` |
| First `add_episode()` | `80.76 ms` |
| `search()` | `5.50 ms` |
| public `search_(NODE_HYBRID_SEARCH_RRF)` node retrieval | `2.37 ms` |

The internal `graphiti_core.search.search.node_search(...)` helper was also invoked directly and completed in the same range:

- `2.47 ms`

### Interpretation

If Graphiti is already running with:

- Kuzu installed
- Kuzu FTS indexes manually created
- local fake clients or equivalent non-networked inference

then the graph storage and search layer is comfortably below the brief's `< 500 ms / triple` target.

But this number is **not enough to justify adoption**, because it excludes the real operational friction:

- source-building `kuzu`
- manual FTS bootstrap
- real LLM extraction cost
- OpenAI/default-client configuration

## Recommendation

### Decision

**No, do not replace Iter C's default KG backend with Graphiti yet.**

### Why

1. The default package posture is wrong for Quilin's current needs.
   Graphiti assumes Neo4j + OpenAI unless the caller injects a different graph driver and client stack.

2. The only embedded path found in practice is Kuzu, not SQLite.
   That already narrows deployment options.

3. The Kuzu path is not zero-config in `0.28.2`.
   It required both source compilation and a manual index bootstrap workaround before the first `add_episode()` could succeed.

4. The API surface is slightly rougher than the brief implies.
   There is no public `Graphiti.node_search()` method; node search is available through `search_()` or internal helpers.

5. The fast latency numbers are encouraging but incomplete.
   They describe a worked-around local POC, not a production-ready default path.

## What Would Change This to "Yes"

Revisit Graphiti if one of these becomes true:

1. Upstream ships a Kuzu path that is actually self-bootstrapping on first run.
   At minimum, `build_indices_and_constraints()` needs to create the Kuzu FTS indexes it already knows about.

2. Python 3.14 installation becomes routine.
   Prefer wheels or a documented, dependency-light install path instead of a source-build detour.

3. Quilin is willing to own a local adapter/wrapper layer.
   That wrapper would:
   - always inject Kuzu
   - always inject non-default clients
   - bootstrap FTS indexes
   - expose a stable public node-search API

Until then, Graphiti is best treated as a **research candidate**, not Iter C's default dependency.
