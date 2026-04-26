# BFCL v4 Multi-turn Re-spike — E3c1 Day 0

> **Date**: 2026-04-26
> **Status**: Proposed
> **Scope**: Spike only. No runtime implementation is authorized by this note.
> **Decision**: **Staged E3c1**. Implement BFCL v4 multi-turn in two sub-slices: E3c1a loader + official checker adapter + submission over fixture trajectories, then E3c1b stateful runner/tool-runtime. Do **not** merge E3c1 with E3c2 agentic.

## 0. Why This Re-spike Exists

E3b closed the BFCL v4 non-live/live AST/relevance slice. Multi-turn is not an extension of that AST slice. Official BFCL evaluates multi-turn by executing model function calls against stateful Python API backends, comparing backend state and execution responses after every turn. The current Quilin benchmark runner is a single `runAgent` call per task and collects one final JSON object, so E3c1 needs a new stateful trajectory contract before implementation.

## 1. Sources Checked

Official/current sources:

- BFCL v4 pinned reproducibility commit: `f7cf735`
- BFCL category mapping: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py>
- BFCL v4 changelog: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/CHANGELOG.md>
- BFCL README: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/README.md>
- BFCL multi-turn checker: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py>
- BFCL multi-turn utilities: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py>
- BFCL evaluator runner: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/eval_runner.py>
- BFCL model handler base: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/model_handler/base_handler.py>
- Public BFCL result archive: <https://github.com/HuanzhiMao/BFCL-Result>
- BFCL v3 multi-turn blog: <https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html>

Local evidence commands run:

```bash
curl -fsSL https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py
curl -fsSL https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py
curl -fsSL https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py
curl -fsSL https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_multi_turn_base.json | wc -l
curl -fsSL https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v4_multi_turn_base.json | head -n 3
curl -fsSL 'https://api.github.com/repos/HuanzhiMao/BFCL-Result/contents/2025-12-16/result/gpt-5-mini-2025-08-07-FC/multi_turn?ref=main'
```

## 2. Official BFCL v4 Multi-turn Shape

### 2.1 Categories

Pinned `category_mapping.py` defines four multi-turn categories:

| Category | Rows | Notes |
|---|---:|---|
| `multi_turn_base` | 200 | Complete information and full function list path |
| `multi_turn_miss_func` | 200 | One or more functions are withheld until a later turn |
| `multi_turn_miss_param` | 200 | Missing parameter clarified by a later user turn |
| `multi_turn_long_context` | 200 | Same backend semantics with long-context pressure |

`wc -l` against the pinned raw files returned `200` for all four categories and `200` for the matching possible-answer files.

### 2.2 Dataset Record Shape

Each prompt record contains:

```json
{
  "id": "multi_turn_base_0",
  "question": [[{"role": "user", "content": "..."}], [{"role": "user", "content": "..."}]],
  "initial_config": {"GorillaFileSystem": {"root": "..."}},
  "path": ["GorillaFileSystem.find", "..."],
  "involved_classes": ["TwitterAPI", "GorillaFileSystem"],
  "missed_function": {"3": ["sort"]},
  "excluded_function": ["cp"]
}
```

The matching possible-answer file stores `ground_truth` as a list of turns, where each turn is a list of executable function-call strings:

```json
{
  "id": "multi_turn_base_0",
  "ground_truth": [
    ["cd(folder='document')", "mkdir(dir_name='temp')"],
    ["grep(file_name='final_report.pdf', pattern='budget analysis')"]
  ]
}
```

### 2.3 Function Docs And Backend Classes

Official BFCL does not embed multi-turn function docs directly in the raw prompt file. `populate_test_cases_with_predefined_functions` loads function docs from `bfcl_eval/data/multi_turn_func_doc/*` based on `involved_classes`. The backend class mapping lives in `constants/executable_backend_config.py`.

Stateful classes include `GorillaFileSystem`, `TwitterAPI`, `TicketAPI`, `TravelAPI`, `MessageAPI`, `TradingBot`, and `VehicleControlAPI`. `MathAPI` is stateless. Agentic memory/web-search classes share this execution pipeline but are not part of E3c1.

### 2.4 Official Result Shape

Public BFCL result archive confirms multi-turn files live under:

```text
result/<model>/multi_turn/BFCL_v4_multi_turn_base_result.json
result/<model>/multi_turn/BFCL_v4_multi_turn_miss_func_result.json
result/<model>/multi_turn/BFCL_v4_multi_turn_miss_param_result.json
result/<model>/multi_turn/BFCL_v4_multi_turn_long_context_result.json
```

Each result entry has a nested result shape:

```json
{
  "id": "multi_turn_base_0",
  "result": [
    [
      [{"find": "{\"path\":\".\",\"name\":\"final_report.pdf\"}"}],
      [{"cd": "{\"folder\":\"document\"}"}],
      "Done. I moved the file."
    ],
    [
      [{"grep": "{\"file_name\":\"final_report.pdf\",\"pattern\":\"budget analysis\"}"}],
      "I found one match."
    ]
  ],
  "input_token_count": [[3263, 3704], [3583]],
  "output_token_count": [[409, 19], [284]],
  "latency": [[19.99, 1.69], [11.48]],
  "inference_log": [...]
}
```

This is materially different from E3b's single final `{tool_calls:[...]}` object.

## 3. Official Evaluation Semantics

### 3.1 Runner Loop

`BaseHandler.inference_multi_turn_FC` runs a turn/step loop:

1. Load `initial_config` into stateful backend instances.
2. Add current user turn to chat history.
3. Query the model.
4. Decode function calls.
5. Execute decoded calls against backend instances.
6. Append execution results to chat history.
7. Repeat steps within the same turn until no valid function call is decoded or max-step limit is hit.
8. Proceed to the next user turn with the same backend instances and conversation history.

For `multi_turn_miss_func`, withheld functions are appended to the tool list at the holdout turn.

### 3.2 Checker Logic

`multi_turn_checker` executes both model calls and ground-truth calls through `execute_multi_turn_func_call`, then checks after each turn:

- **State-based check**: public attributes on backend instances must match ground truth.
- **Response-based check**: the ground-truth execution results for the current turn must be contained in the model execution results accumulated so far.
- **Irrelevance check**: turns whose ground truth is empty must eventually produce no valid function call.

This means a pure AST compare is insufficient. A model can take extra reasonable steps and still pass if final state/response coverage is correct.

### 3.3 Security Boundary

Official `execute_multi_turn_func_call` uses Python `eval` after limited method-name filtering. E3c1 must not run this on the host for untrusted model output. It should run the official Python checker/backend inside DockerSandbox with `--network none`, bounded timeout/output, and mounted read-only official source/data.

## 4. E3c1 Design Implications

### 4.1 Runner 5-phase Lifecycle Still Holds

The outer ADR-010 lifecycle remains valid:

```text
setup -> agent_loop -> collect -> score -> cleanup
```

But `agent_loop` is no longer one `runAgent` call. It needs an internal multi-turn state machine:

```text
for each user turn:
  add user message
  for each step up to max_steps:
    query agent
    decode tool calls
    if no tool calls: break turn
    execute tool calls in task-scoped BFCL backend
    append tool outputs
```

This state machine should be isolated behind a BFCL-specific runner adapter instead of widening every single-turn benchmark path.

### 4.2 DockerSandbox State

Current DockerSandbox is good for one-shot command execution and official checker replay. It is **not** enough for live interactive multi-turn tool execution because a one-shot `docker run` does not keep backend objects alive across steps/turns.

E3c1 should therefore split implementation:

- **E3c1a**: loader + official checker adapter + submission over fixture trajectories. The scorer can replay a complete decoded trajectory inside one DockerSandbox command.
- **E3c1b**: stateful BFCL tool runtime. Add a per-task long-lived Python backend worker or a per-task container session that preserves backend instances while the TS runner queries the agent step-by-step.

Do not attempt to preserve BFCL backend state in OmniMem scratchpad. Scratchpad can hold run metadata/checkpoints, but backend state must live in the BFCL tool runtime because official scoring compares Python backend object state.

### 4.3 Trajectory Contract

E3c1 needs a new output shape:

```ts
type BfclMultiTurnTrajectory = {
  turns: Array<{
    steps: Array<{
      assistant_raw: unknown
      tool_calls: Array<{ function: string; arguments: Record<string, unknown> }>
      execution_results: string[]
    }>
    final_message?: string
  }>
}
```

For official checker parity, the scorer also needs a decoded form compatible with:

```python
multi_turn_model_result_list_decoded: list[list[list[str]]]
```

The submission adapter should write official result files using the nested BFCL shape and add Quilin metadata in a manifest, not in the official result lines.

### 4.4 Scorer Strategy

Porting all stateful BFCL backend classes to TypeScript is the wrong first move. It would duplicate official Python semantics for filesystem, messaging, travel, ticketing, vehicle, trading, and more.

Preferred E3c1 scorer:

1. Keep model trajectory in Quilin JSON.
2. Convert tool calls to BFCL executable strings.
3. Invoke a small Python official-checker adapter in DockerSandbox that imports `multi_turn_checker` and `multi_turn_utils`.
4. Return `{passed, score, details}` from the official checker result.

This avoids BFCL model-handler registry coupling. Direct `bfcl evaluate` expects raw model responses plus a known BFCL model handler; Quilin should instead call `multi_turn_checker` with already-decoded calls.

## 5. E3c1 vs E3c2

Do **not** merge E3c1 and E3c2.

Reasons:

- E3c1 covers four multi-turn categories and 800 rows; it already requires a new stateful trajectory contract.
- E3c2 adds web-search and memory backend semantics, prereq/dependency handling, SerpAPI/network policy, memory snapshot/reload, and extra path hierarchy.
- Merging them would combine stateful runner work with external egress and backend setup in one review chain.

Shared foundation to design now:

- `BfclToolRuntime` session contract.
- Official-checker Docker invocation path.
- Nested multi-turn submission writer.
- Per-task trajectory artifact schema.

E3c2 should reuse that foundation after E3c1 closes.

## 6. Proposed E3c1 Sub-slices

### E3c1a — Loader + Official Checker Adapter + Submission

Write boundaries:

- `benchmarks/src/datasets/bfcl-v4-multi-turn.ts`
- `benchmarks/src/scorers/bfcl-v4-multi-turn.ts`
- `benchmarks/src/submissions/bfcl-v4-jsonl.ts` or a sibling adapter module for multi-turn paths
- `benchmarks/scripts/fetch-benchmark.ts` for the four multi-turn prompt + possible-answer files
- tests and ADR/plan sync

DoD:

- Load all four multi-turn categories from cache.
- Preserve `initial_config`, `involved_classes`, `missed_function`, and function docs for scorer/runtime, but do not leak `initial_config` into agent prompt.
- Score fixture decoded trajectories through the official Python checker adapter inside DockerSandbox or a Docker-mocked test path.
- Write official `result/<model>/multi_turn/BFCL_v4_<category>_result.json` files plus Quilin manifest.
- Mark `partial_eval=true`, `official_parity=false`, and `bfcl_slice="multi_turn"` in manifest.

### E3c1b — Stateful BFCL Runner

Write boundaries:

- BFCL-specific runner adapter or `benchmarks/src/runner/bfcl-multi-turn.ts`
- Python backend worker under `benchmarks/` or `providers/` if needed
- DockerSandbox session extension only if the worker requires long-lived container state

DoD:

- Run one fixture task end-to-end: user turns -> agent steps -> tool execution -> score -> submission.
- Support max-step force termination and produce official-shaped result files.
- Support `multi_turn_miss_func` holdout tool injection at the correct turn.
- Keep conversation history and tool execution results in trajectory artifacts.

## 7. Spike Decision

Decision: **partial/staged implementation**.

Start E3c1 with E3c1a, then E3c1b. This is not a re-spike and not an abandon. It is also not a merge with E3c2.

Rejected alternatives:

- **Direct all-in-one E3c1**: too large; would mix loader, official checker, stateful runtime, Docker session behavior, and submission in one review chain.
- **Merge E3c1 + E3c2**: wrong scope; web-search/memory backends add independent egress and snapshot risks.
- **Port BFCL Python backends to TS**: high drift risk and low value; official checker already exists.
- **Use OmniMem scratchpad as backend state**: not equivalent to official Python object state and would not match checker semantics.

## 8. Review Gates For E3c1

R1 review must verify:

- Loader preserves the four category files and matching possible-answer rows 1:1.
- `initial_config` is stored for runtime/scorer but never exposed to agent prompt.
- `missed_function` holdout behavior is represented and tested.
- Official checker adapter runs inside DockerSandbox or a clearly bounded mocked equivalent in unit tests.
- Result file shape matches public BFCL result archive: nested `result`, nested token/latency arrays, optional `inference_log`.
- Submission marks `partial_eval=true` and `official_parity=false`.
- E3b single-turn BFCL path remains unchanged.

## 9. Sources

- BFCL pinned category mapping: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py>
- BFCL multi-turn checker: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py>
- BFCL multi-turn utils: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py>
- BFCL evaluator runner: <https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/eval_runner.py>
- BFCL result archive: <https://github.com/HuanzhiMao/BFCL-Result>
- BFCL v3 multi-turn blog: <https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html>
