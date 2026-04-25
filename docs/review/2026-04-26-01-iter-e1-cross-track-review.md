# Iter E1 R1 Cross-Track Review

## Scope / Evidence Summary

Review scope:
- Day 0 contract freeze: `8254f70`
- Selective restore: `b7e8e2f`
- Iter E1 first round four tracks: `a8f199d`

Read-only / verification commands used:
- `git show --stat 8254f70`, `git show --stat b7e8e2f`, `git show --stat a8f199d`
- `git diff --name-status b7e8e2f..a8f199d`, `git diff --check b7e8e2f..a8f199d`
- code-review-graph: `list_graph_stats`, `detect_changes(base=b7e8e2f)`, `get_review_context(base=b7e8e2f)`
- `pnpm -C benchmarks build`
- `pnpm -C benchmarks exec vitest run --configLoader runner`
- `pnpm -C benchmarks exec vitest run src/runner/runner.test.ts --configLoader runner`
- `just test-all`
- negative runtime probes:
  - `node -e "import('@quilin/agent-core/src/loop.js')..."`
  - `node -e "import('@quilin/agent-core/src/tools/builtin/shell-exec.js')..."`
- Official SWE-bench docs checked:
  - https://www.swebench.com/SWE-bench/guides/evaluation/
  - https://www.swebench.com/sb-cli/user-guide/submit/

## Findings

### BLOCKING

#### B1. Default runner / scorer lazy imports target private TS source subpaths that do not exist at Node runtime

Evidence:
- `benchmarks/src/runner/runner.ts:302-310` dynamically imports `@quilin/agent-core/src/loop.js`.
- `benchmarks/src/scorers/swe-bench-patch-apply.ts:95-103` dynamically imports `@quilin/agent-core/src/tools/builtin/shell-exec.js`.
- `packages/agent-core/src/index.ts:22-23` already exports `runAgentLoop` from the public package entrypoint.
- `packages/agent-core/package.json:5-6` declares `dist/index.js` / `dist/index.d.ts` as the package entrypoint; the source files present are `.ts`, not `.js`.

Impact:
- The runner test passes under Vitest's TS transform, but the same default import path fails under plain Node/package resolution:
  - `ERR_MODULE_NOT_FOUND Cannot find module ... @quilin/agent-core/src/loop.js`
  - `ERR_MODULE_NOT_FOUND Cannot find module ... @quilin/agent-core/src/tools/builtin/shell-exec.js`
- This breaks the non-injected default runner path and the non-injected default Lavoisier scorer path. It also bypasses the intended public `@quilin/agent-core` export contract from selective restore.

Contract drift:
- ADR-010 §3.2 says `agent_loop` calls exported `runAgentLoop()` (`docs/adr/adr-010-benchmark-harness-wire-schema.md:57-63`).
- Plan §7 requires `runAgentLoop` import from `@quilin/agent-core` without type/runtime issues (`docs/planning/2026-04-25-03-iter-e1-restart.md:136-138`).

#### B2. ADR-010 cwd containment / filesystem sandbox is not enforced by runner; the workspace is only passed as prompt text

Evidence:
- `benchmarks/src/runner/runner.ts:214-225` creates a tmpdir and writes the task to scratchpad, but does not bind tools or process cwd to that tmpdir.
- `benchmarks/src/runner/runner.ts:240-252` forwards `agentLoopConfig` unchanged and only includes `workspace_dir` inside the user message.
- `packages/agent-core/src/tools/builtin/shell-exec.ts:361-424` accepts arbitrary `cwd` from tool args and passes it to the runner; no benchmark-level containment wrapper is applied.
- `benchmarks/src/runner/runner.test.ts:30-108` verifies tmpdir creation/cleanup, not rejection of writes to `~`, `/etc`, or the repo root.

Impact:
- A benchmark task can still request tools with arbitrary cwd or paths if the provided agent tools allow them. Prompting the model to use `workspace_dir` is not containment.
- This violates ADR-010 §3.7 hard boundary: per-task scratchpad + tmpdir with cwd containment, no writes to `~`, `/etc`, `/var`, or outside the allowed workspace (`docs/adr/adr-010-benchmark-harness-wire-schema.md:133-142`).
- Plan §7 explicitly requires sandbox escape tests for `~/.quilin/secret.txt`, `/etc/hosts`, and repo-root writes (`docs/planning/2026-04-25-03-iter-e1-restart.md:140-142`); those tests are absent.

### HIGH

#### H1. Lavoisier's "real" shell_exec path is not verified and would be denied even after the import path is fixed

Evidence:
- `benchmarks/src/scorers/swe-bench-patch-apply.ts:95-103` creates the default shell executor via `createShellExecTool()` with no injected `WriteAuthority` / confirmation hook.
- `packages/agent-core/src/safety/write-authority.ts:49-50` defaults `WriteAuthority` to `mode: "ask"`.
- `packages/agent-core/src/safety/write-authority.ts:111-116` converts a confirmation request without a confirm hook into a deny decision.
- `packages/agent-core/src/tools/builtin/shell-exec.ts:406-419` gates every `shell_exec` command through `WriteAuthority`.
- `benchmarks/src/scorers/swe-bench-patch-apply.test.ts:149-180` only proves an injected fake `ShellExecTool` receives a `git apply --check` command; it does not exercise `defaultGitApplyCheckExecutor()`.

Impact:
- The current tests can pass while the real default scorer path never reaches `git apply --check`.
- If B1's import path is fixed but no authority/confirm path is added, the default scorer will map the denial into a failed git-apply result for every candidate patch.
- CRITICAL/high-risk boundaries are not automatically opened, which is good, but there is no usable human-confirmed path for benchmark scoring through the Iter B tool.

#### H2. Cache loader does not reject a `data_file` replacement attack when the manifest is replaced with matching sha256

Evidence:
- `benchmarks/src/datasets/cache.ts:13-22` accepts any non-empty `data_file` string in the manifest.
- `benchmarks/src/datasets/cache.ts:53-62` reads `join(cacheDir, manifest.data_file)` and verifies sha256 against the same manifest.
- `benchmarks/src/datasets/swe-bench-lite.test.ts:112-139` covers data tamper and `schema_version` mismatch.
- `benchmarks/src/datasets/swe-bench-lite.test.ts:153-164` covers a missing declared file, but not a valid replacement file with a matching manifest sha.

Impact:
- An attacker or corrupt cache process that can replace `manifest.json` can redirect the loader to a different local data file and provide the matching sha256. The loader accepts that dataset as valid.
- The user-specified attack set included tamper, schema mismatch, and `data_file` replacement. Only the first two are refused in the meaningful sense.
- ADR-010 §3.4 requires load-time sha256/schema verification (`docs/adr/adr-010-benchmark-harness-wire-schema.md:96-103`), but the current manifest schema does not pin the expected data filename or constrain it to the canonical cache artifact.

### MEDIUM

#### M1. SWE-bench adapter matches the harness JSONL format, but not the current sb-cli submit format

Evidence:
- `benchmarks/src/submissions/swe-bench-verified-jsonl.ts:67-83` emits `jsonl` lines with `instance_id`, `model_name_or_path`, and `model_patch`.
- SWE-bench evaluation guide says predictions are JSONL with those fields: https://www.swebench.com/SWE-bench/guides/evaluation/
- Current sb-cli submit guide says `--predictions_path` should point to a JSON file, either dictionary or list format: https://www.swebench.com/sb-cli/user-guide/submit/
- Plan soft acceptance says the first SWE-bench Verified submission package should be uploadable to the official flow (`docs/planning/2026-04-25-03-iter-e1-restart.md:148-151`).

Impact:
- For local `swebench.harness.run_evaluation`, the Mendeleev JSONL adapter is aligned.
- For the documented `sb-cli submit swe-bench_verified ... --predictions_path ...` path, this adapter is likely insufficient. If official upload means sb-cli, add a second JSON adapter or an explicit conversion step.

#### M2. `BenchmarkResult.score` is hard-clamped to [0, 1], while ADR-010 leaves room for leaderboard-specific scoring

Evidence:
- `benchmarks/src/wire/result.ts:12` uses `z.number().min(0).max(1)`.
- ADR-010 says `score: number // [0, 1] 或 leaderboard 自定义` (`docs/adr/adr-010-benchmark-harness-wire-schema.md:76-85`).

Impact:
- Current SWE-bench patch-apply scoring fits `[0, 1]`.
- Future GAIA / BFCL adapters may need leaderboard-specific numeric ranges or structured sub-scores. The current wire schema freezes a narrower contract than ADR-010 describes.

### LOW

#### L1. Iter E1 first-round commit touched files outside plan §5 track write boundaries

Evidence:
- Plan §5 declares track write boundaries as:
  - Pasteur: `benchmarks/src/runner/**` + tests
  - Galois: `benchmarks/src/datasets/**` + tests
  - Lavoisier: `benchmarks/src/scorers/**` + tests
  - Mendeleev: `benchmarks/src/submissions/**` + tests
  (`docs/planning/2026-04-25-03-iter-e1-restart.md:96-104`)
- `git diff --name-status b7e8e2f..a8f199d` also includes `benchmarks/package.json`, `pnpm-lock.yaml`, and `docs/planning/2026-04-25-03-iter-e1-restart.md`.
- `benchmarks/package.json:13-15` adds `@quilin/agent-core`.

Impact:
- The dependency addition is understandable for runner integration, but it was not declared in the four-track write boundary. This is a process/isolation drift, not a functional bug by itself.

#### L2. The 95% benchmark coverage number does not cover the highest-risk default/runtime paths

Evidence:
- `benchmarks/src/runner/runner.test.ts:170-196` exercises the agent-core default runner under Vitest, but the Node import probe for the same package subpath fails.
- `benchmarks/src/scorers/swe-bench-patch-apply.test.ts:149-180` verifies a fake `ShellExecTool`, not the default Iter B shell_exec integration.
- No test in `benchmarks/src/runner/runner.test.ts` covers sandbox escape rejection required by plan §7.
- No test in `benchmarks/src/datasets/swe-bench-lite.test.ts` covers manifest `data_file` replacement with matching sha256.

Impact:
- The line/branch coverage gate is green, but it is currently weighted toward happy paths and injected fakes. The missing paths map directly to B1, B2, H1, and H2.

## Open Questions / Residual Risk

- ADR-010 uses the phrase `agent.turn.cost_usd` (`docs/adr/adr-010-benchmark-harness-wire-schema.md:146`), while ADR-008 and the implementation use span name `agent.turn` plus attribute `turn.cost_usd` (`packages/agent-core/src/observability/span.ts:77-83`). I treated this as wording drift, not an implementation bug, because ADR-008 is the concrete span-schema source.
- Plan §17 residual ownership still looks stable: M1.1 / M0.9b, LongMemEval, and Arm L gate remain resource/data blocked in `docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md:983-989` and `docs/planning/00-implementation-plan.md:542-550`.
- 25-02 cleanup sweep is closed and no longer applies to E1: `docs/planning/2026-04-25-02-c-m-cleanup-sweep.md:71-80`.
- I did not find evidence that `benchmarks.network_whitelist` is enforced anywhere in E1. This is covered under B2 for sandbox/egress boundary, but the exact network clamp design remains open.

## Verification Evidence

- code-review-graph:
  - Stats: 249 files, 2619 nodes, 26078 edges, last updated `2026-04-26T00:15:23`.
  - `detect_changes(base=b7e8e2f)`: 24 changed files, 138 changed functions/classes, 74 test gaps, risk score `0.45`.
  - `get_review_context(base=b7e8e2f)`: high risk, 496 impacted nodes in 76 files.
- Git:
  - `8254f70`: 3 files / 359 insertions.
  - `b7e8e2f`: 16 files / 789 insertions.
  - `a8f199d`: 23 files / 2443 insertions.
  - `git diff --check b7e8e2f..a8f199d`: clean.
- Tests / builds:
  - `pnpm -C benchmarks build`: exit 0.
  - `pnpm -C benchmarks exec vitest run --configLoader runner`: 11 files / 104 tests passed.
  - `pnpm -C benchmarks exec vitest run src/runner/runner.test.ts --configLoader runner`: 1 file / 11 tests passed.
  - `just test-all`: TS 717 passed, Python 187 passed with TOTAL coverage 95.28%, Rust 1 passed.
- Negative runtime probes:
  - Plain Node import of `@quilin/agent-core/src/loop.js`: `ERR_MODULE_NOT_FOUND`.
  - Plain Node import of `@quilin/agent-core/src/tools/builtin/shell-exec.js`: `ERR_MODULE_NOT_FOUND`.
