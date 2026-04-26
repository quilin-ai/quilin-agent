# BFCL v4 Multi-turn Stateful Runner Re-spike — E3c1b Day 0

> **Date**: 2026-04-27
> **Status**: Proposed
> **Scope**: Spike only. No runtime implementation is authorized by this note.
> **Decision**: **Split E3c1b into E3c1b1 + E3c1b2**. First build a benchmark-local Python stateful runtime worker with a TS thin adapter, then wire a BFCL-specific stateful runner adapter. Keep E3c2 agentic/web-search/memory separate.

## 0. Why This Re-spike Exists

E3c1a closed the fixture-trajectory path: Quilin can load BFCL v4 multi-turn tasks, replay archived trajectories through a pinned Python checker bundle, and emit `stateful_eval=false` submissions. E3c1b is different: it must execute model tool calls against live BFCL backend objects across multiple user turns. That is a stateful runtime problem, not a normal single-call benchmark runner extension.

The previous E3c1 re-spike deliberately deferred this because official BFCL multi-turn uses Python backend instances, mutates them across turns, and checks final state plus execution responses. This document reassesses the implementation shape before code.

## 1. Sources And Local Evidence

Official pinned sources checked at `f7cf735`:

- `bfcl_eval/model_handler/base_handler.py`
- `bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py`
- `bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py`
- `bfcl_eval/constants/executable_backend_config.py`
- `bfcl_eval/constants/category_mapping.py`
- `bfcl_eval/data/BFCL_v4_multi_turn_{base,miss_func,miss_param,long_context}.json`
- `bfcl_eval/data/possible_answer/BFCL_v4_multi_turn_{base,miss_func,miss_param,long_context}.json`

Local evidence commands run:

```bash
python3 - <<'PY'
# fetched pinned BaseHandler / multi_turn_utils / checker / config and printed class/function/import lines
PY
python3 - <<'PY'
# counted four multi_turn categories and inspected first prompt + possible_answer records
PY
python3 - <<'PY'
# counted involved_classes across all 800 pinned multi_turn rows
PY
```

Key measured facts:

| Fact | Evidence |
|---|---|
| Four categories | `multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`, `multi_turn_long_context` |
| Row count | 200 rows each, 800 total |
| Turn count | base/long_context: 1-7 turns, avg 3.67; miss_func/miss_param: 2-8 turns, avg 4.67 |
| Empty holdout turns | `multi_turn_miss_func` has 200 empty user-message holdout turns |
| Involved backend classes in 800 rows | `GorillaFileSystem` 200, `VehicleControlAPI` 200, `TradingBot` 200, `TravelAPI` 200, `MessageAPI` 160, `TwitterAPI` 156, `TicketAPI` 124, `MathAPI` 100 |
| Web/memory classes | 0 rows in E3c1 categories; config lists them only as shared future pipeline classes |
| Official execution | `execute_multi_turn_func_call` creates/reuses Python class instances via module globals and calls `eval(func_call)` after limited method filtering |
| Existing E3c1a dependency surprise | `MathAPI` imports `mpmath`; E3c1a now vendors pinned wheel and throws adapter errors |

## 2. Official Runtime Semantics That Matter

### 2.1 State Lives In Python Backend Instances

`execute_multi_turn_func_call` maps class names from `CLASS_FILE_PATH_MAPPING`, imports backend classes, initializes each class from `initial_config`, then stores instances in Python module globals keyed by model/test/class. Subsequent calls reuse those instances. This is the state that official checking compares.

Implication: E3c1b must preserve Python object identity and mutation across all steps and turns of a task. OmniMem scratchpad or TS JSON snapshots are not a correct substitute for the backend state.

### 2.2 The Official Handler Is Too Model-Coupled To Import Directly

`BaseHandler.inference_multi_turn_FC` has the right loop shape, but it depends on BFCL model handler subclasses for `_query_FC`, `_compile_tools`, `_parse_query_response_FC`, `_add_execution_results_FC`, prompt formatting, model style, and result path conventions.

Implication: importing `BaseHandler` wholesale would couple Quilin to the BFCL model registry. For Quilin, the model query stays in TS through `runAgent`; only BFCL backend execution should live in Python.

### 2.3 `multi_turn_miss_func` Requires Dynamic Tool Surface

Official code extends `test_entry["function"]` when a holdout turn is reached and re-compiles tools. The holdout turn has no normal user message; official code injects a default user prompt for additional functions.

Implication: the TS stateful runner must support per-turn tool definition updates. E3c1b cannot be only "same tools across all turns".

### 2.4 Security Boundary Is Hard

Official execution uses Python `eval` on model-derived function-call strings. E3c1b must not run this on the host. It belongs in the Linux-only DockerSandbox or an equivalent hard-isolation boundary with `--network none`, CPU/memory/pids/time/output bounds, and read-only BFCL source/cache mounts.

## 3. Architecture Options

### Option A — Put Stateful Logic In `benchmarks/src/runner/runner.ts`

Add BFCL multi-turn branches directly into `runBenchmarkTask`.

- Pros: fewer files, direct reuse of phase plumbing.
- Cons: pollutes the generic 5-phase runner with one leaderboard's turn/step semantics, dynamic tool surface, backend worker lifecycle, and checker-specific trajectory shape.
- Verdict: **Reject**. This repeats the risk E3a/E3b avoided by keeping dataset-specific logic at the edges.

### Option B — `providers/bfcl-runtime` MCP Server

Create a Python MCP server parallel to OmniMem that owns BFCL backend state and exposes tool dispatch.

- Pros: clean long-lived Python process model; natural state ownership.
- Cons: promotes benchmark-only runtime into product provider surface, adds MCP protocol overhead, and risks confusing BFCL state with product memory/tool runtime. It also expands review scope beyond Iter E.
- Verdict: **Reject for E3c1b**. Reconsider only if later BFCL agentic work needs reusable product-like runtime.

### Option C — Per-turn Short Python Process With Serialized State

Spawn Python per tool step or per turn and serialize backend state to JSON/pickle between calls.

- Pros: easy timeout cleanup; no long-running worker protocol.
- Cons: object identity and hidden/private fields are not guaranteed serializable; official state comparison operates on live Python objects. Pickle also widens the attack surface and ties cache artifacts to Python implementation details.
- Verdict: **Reject**.

### Option D — Benchmark-local Python Stateful Worker + TS Thin Adapter

Create a small Python worker script under `benchmarks/scripts/` that imports the pinned BFCL backend bundle inside Docker, initializes one task session, receives JSON-RPC-like commands over stdin/stdout, executes decoded function calls through official `execute_multi_turn_func_call`, and returns execution results. TS owns agent prompting, dynamic tool surface, and trajectory collection.

- Pros: preserves official Python backend state, keeps benchmark-only code in `benchmarks/`, avoids BFCL model handler coupling, and reuses E3c1a checker adapter for scoring.
- Cons: needs new interactive process/session lifecycle and DockerSandbox extension for long-running exec.
- Verdict: **Accept, staged**.

## 4. Recommended E3c1b Split

### E3c1b1 — Stateful BFCL Runtime Worker MVP

Scope:

- New Python worker: `benchmarks/scripts/bfcl-multi-turn-runtime.py`.
- New TS adapter: `benchmarks/src/bfcl/runtime-session.ts` or `benchmarks/src/runtime/bfcl-multi-turn.ts`.
- Input command protocol:
  - `init_task`: load `initial_config`, `involved_classes`, `task_id`, `category`, `long_context`.
  - `execute`: accept decoded calls as BFCL executable strings or structured calls convertible to strings.
  - `state_snapshot` (debug-only): sanitized non-private public state for tests/logging.
  - `close`.
- Output protocol: `{ok, execution_results, decoded_calls?, error?}` JSON lines.
- Hard isolation: run worker in DockerSandbox with read-only BFCL source/cache + writable per-task tmp/artifacts; network none.
- Verification: fixture calls against `GorillaFileSystem`, `MathAPI`, and one API with login/state mutation; compare worker-produced trajectory with E3c1a checker returning pass.

Do not call the LLM yet. E3c1b1 proves the runtime worker can preserve state and execute official calls.

### E3c1b2 — BFCL Stateful Runner Adapter

Scope:

- New TS orchestrator, not generic `runner.ts` branch explosion. Candidate path: `benchmarks/src/runner/bfcl-multi-turn-runner.ts`.
- It may call shared setup/score utilities, but should own BFCL turn/step loop.
- For each turn:
  - add user messages;
  - expose current function definitions;
  - call injected `runAgent`;
  - parse strict JSON `{ tool_calls: [...] }`;
  - send calls to runtime worker;
  - append execution results to the next prompt;
  - stop turn on empty tool calls, decode failure, or max steps.
- Handle `multi_turn_miss_func` by adding held-out functions at the official holdout turn and injecting the additional-function prompt.
- Output official-compatible nested `result` and Quilin detailed trajectory.
- Score by reusing E3c1a `bfcl-v4-multi-turn` scorer/checker.

This is the first place to wire an actual agent loop.

## 5. DockerSandbox Compatibility

Current DockerSandbox is one-shot `docker run`. E3c1b1 needs either:

1. **Long-running container session API**: start container once, keep Python worker alive, stream JSONL over stdin/stdout, then stop/cleanup; or
2. **One-shot worker command per full task**: put the whole turn loop inside a single Python command and have Python call back to TS for agent queries.

Option 2 is awkward because model queries and tools are TS-owned. Option 1 is the right direction, but should be added as a new interface rather than changing `runShellCommand` semantics.

Recommended interface shape:

```ts
interface BenchmarkProcessSession {
  send(input: unknown): Promise<unknown>
  close(): Promise<void>
}

interface BenchmarkStatefulSandbox extends BenchmarkSandbox {
  startProcess(input: {
    command: readonly string[]
    cwd: string
    workspaceDir: string
    timeoutMs?: number
    maxOutputBytes?: number
  }): Promise<BenchmarkProcessSession>
}
```

E3c1b1 can implement this only for DockerSandbox CLI. Keep macOS behavior as structured skip/fail-loud for real Docker smoke, same as E2.

## 6. Tool Dispatch Contract

The TS runner should not send arbitrary Python strings from the model directly. It should parse model JSON into structured calls first:

```ts
type BfclToolCall = {
  function: string
  arguments: Record<string, unknown>
}
```

Then convert to BFCL executable strings in a dedicated encoder:

```text
function_name(arg1=<python literal>, arg2=<python literal>)
```

Rules:

- Function name must exist in the currently exposed function definitions.
- Argument names must be known from function schema.
- Values are encoded through a Python-literal-safe serializer, not string concatenation.
- The Python worker still runs official `_process_method_calls` + `eval`, but the TS side reduces accidental malformed calls.

R1/R2 review should pay attention to escaping, nested arrays/objects, booleans/null, and strings containing quotes/newlines.

## 7. Trajectory And Scratchpad

Do not use OmniMem scratchpad to hold BFCL backend state. The official state lives in Python backend objects.

Scratchpad can be used later for run checkpoints or user-visible progress if needed, but E3c1b should first produce a local benchmark trajectory:

```ts
type BfclStatefulTrajectory = {
  turns: Array<{
    user_messages: unknown[]
    steps: Array<{
      assistant_raw: string
      tool_calls: BfclToolCall[]
      bfcl_calls: string[]
      execution_results: string[]
      input_tokens?: number
      output_tokens?: number
      latency_ms?: number
    }>
    stop_reason: "empty_tool_calls" | "decode_error" | "max_steps" | "agent_error"
  }>
}
```

Submission adapter converts this to official nested `result` while manifest keeps Quilin metadata.

## 8. Scorer Reuse

E3c1a scorer remains the score source. E3c1b should feed its generated nested `model_output_trajectory` into `scoreBfclV4MultiTurn`.

Required guard: E3c1b must preserve the exact decoded shape expected by E3c1a:

```python
list[list[list[str]]]
```

The official checker will independently execute the model calls and ground-truth calls from clean initial state, so runtime execution during the agent loop is for feedback and trajectory collection, not the final scoring state source.

## 9. Fetch / Bundle Scope

E3c1a already fetched the minimal checker/runtime class bundle plus mpmath. E3c1b can reuse and extend that bundle. Current E3c1 non-agentic classes needed by all 800 rows:

- `GorillaFileSystem`
- `TwitterAPI`
- `TicketAPI`
- `MessageAPI`
- `MathAPI`
- `VehicleControlAPI`
- `TradingBot`
- `TravelAPI`

No pinned E3c1 row uses `WebSearchAPI` or `MemoryAPI_*`. Those remain E3c2/E4.

## 10. Risks And Review Focus

| Risk | Severity | Mitigation |
|---|---|---|
| Python worker protocol deadlock | HIGH | JSONL framing, bounded stdout/stderr, per-command timeout, close on parse error |
| Docker long-session cleanup leaves containers | HIGH | container name ownership, SIGTERM/SIGKILL fallback, R1 real timeout test |
| BFCL executable string escaping | HIGH | structured call schema + Python literal encoder tests with quotes/newlines/nested data |
| `multi_turn_miss_func` holdout semantics drift | HIGH | dedicated fixture test where new function appears on holdout turn |
| Generic runner pollution | MEDIUM | BFCL-specific runner adapter; do not add turn loop into generic `runBenchmarkTask` |
| Official parity claim too broad | MEDIUM | keep `partial_eval=true`; set `stateful_eval=true` only for E3c1b output; keep `official_parity=false` until official eval runner parity review |

## 11. Decision

**Decision: split E3c1b into E3c1b1 + E3c1b2.**

- **E3c1b1**: Docker-backed stateful BFCL Python runtime worker MVP. No LLM runner. Prove official backend instance state survives command sequence and E3c1a checker can score generated trajectory.
- **E3c1b2**: BFCL-specific stateful runner adapter that calls injected `runAgent`, handles dynamic tool surface, collects trajectory, reuses E3c1a scorer and E3b/E3c1a submission patterns.

Do **not** merge E3c1b with E3c2. Do **not** build a `providers/bfcl-runtime` MCP server for E3c1b. Do **not** extend OmniMem scratchpad to hold BFCL backend state.

## 12. Next Plan Draft

Create `docs/planning/2026-04-27-01-iter-e3c1b-stateful-runner.md` with:

1. Day 0 contract: runtime session protocol, Docker long-session API, tool-call encoder, trajectory schema.
2. First implementation slice E3c1b1:
   - `benchmarks/scripts/bfcl-multi-turn-runtime.py`
   - `benchmarks/src/bfcl/runtime-session.ts`
   - `benchmarks/src/sandbox/docker-session.ts` or extension behind new interface
   - tests: state mutation, MathAPI/mpmath, timeout cleanup, malformed command, quote escaping.
3. Second implementation slice E3c1b2:
   - `benchmarks/src/runner/bfcl-multi-turn-runner.ts`
   - dynamic tool docs from `multi_turn_func_doc`
   - `multi_turn_miss_func` holdout tool update
   - trajectory -> E3c1a scorer -> E3c1a submission adapter.
4. Review chain: independent R1 after E3c1b1, independent R2 after E3c1b2 or earlier if R1 finds lifecycle risk.

## 13. Four-way Decision Output

| Option | Decision |
|---|---|
| Directly implement full E3c1b in one slice | No |
| Split E3c1b1 runtime worker + E3c1b2 runner adapter | **Yes** |
| Merge E3c1b with E3c2 agentic web/memory | No |
| Defer all stateful work to E4 | No |
