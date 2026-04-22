---
title: Iter E1-b — SWE-bench Lite task loader + iterator
status: in-progress
owner: Claude (impl while Codex token-depleted)
created: 2026-04-22
last_updated: 2026-04-22
predecessors:
  - docs/planning/2026-04-22-10-iter-e1-harness-bootstrap.md  # §Phase E1-b
  - docs/planning/2026-04-22-11-iter-e1-a-benchmarks-workspace.md  # dataset parser landed
threat_surface_delta:
  # E1-b is a pure read-side adapter over the E1-a cache. No new ingress/egress/persistence
  # beyond what E1-a already introduced — this tracking doc records zero delta on purpose.
  new_ingress: []
  new_egress: []
  new_persistence: []
---

# Iter E1-b — SWE-bench Lite task loader + iterator

## Context

E1-a (`2bb25d7`) landed `benchmarks/src/swe-bench-lite/dataset.ts` with fetcher + JSONL
cache + sha256 manifest + parser. The raw record type is `SweBenchLiteRecord` with field
name `patch` for the golden patch (matching upstream HuggingFace schema).

E1-c (runner) needs a **task-facing view**: the `patch` field is the *golden solution*,
and downstream runner code will be clearer reading it as `golden_patch`. Rather than
renaming at the cache boundary (would break manifest sha256 parity with upstream), we
add a thin task-loader that renames on read.

## Goal

Ship a minimal task-loader that:

- Reads from the E1-a cache (via `loadSweBenchLiteFromCache`)
- Exposes a task iterator (`iterateSweBenchLiteTasks`) yielding one `SweBenchLiteTask`
  record at a time — suitable for `for await` in runner
- Exposes a sync `loadSweBenchLiteTasks` returning an immutable array — suitable for
  the "pre-slice first 10" path in E1-c
- Provides `takeFirstN(records, n)` as a pure helper (matches E1 decision: "前 10 题
  按官方顺序")
- Normalizes `patch` → `golden_patch` in the task view
- Allows a fixture override (`records?: readonly SweBenchLiteRecord[]`) so tests don't
  need a real cache on disk

## Scope

- In scope:
  - `benchmarks/src/swe-bench-lite/task-loader.ts`
  - `benchmarks/src/swe-bench-lite/task-loader.test.ts` (3-5 task fixture)
  - Public re-export from `benchmarks/src/index.ts` *only if it exists*; otherwise skip
    (E1-a didn't add a barrel yet)
- Out of scope:
  - runner wiring (E1-c)
  - evaluator (E1-d)
  - per-task repo clone
  - any network / LLM calls

## Decisions

- **Renaming `patch` → `golden_patch` at task-loader boundary** (not at dataset-parser
  boundary). Keeps upstream-field fidelity in `SweBenchLiteRecord` + manifest sha256
  stable; aligns runner-facing vocabulary with E1 tracking doc contract.
- **No new persistence** — task-loader is a pure read adapter. `threat_surface_delta`
  is explicitly empty.
- **Fixture override over filesystem mocking** — tests accept `records` option directly
  so unit tests run without touching `.benchmarks/`. Cache-backed path still covered by
  `loadSweBenchLiteFromCache` in E1-a's test suite.

## Definition of Done

- [x] `SweBenchLiteTask` interface defined with `golden_patch` field
- [x] `loadSweBenchLiteTasks({ cacheRoot?, records? })` returns `readonly SweBenchLiteTask[]`
- [x] `iterateSweBenchLiteTasks({ cacheRoot?, records? })` is an async iterable yielding tasks
- [x] `takeFirstN(tasks, n)` returns a new readonly array (no mutation of input)
- [x] Fixture test covering 3 tasks: field renaming + iterator + takeFirstN — 7 new tests, 12/12 passing
- [x] `pnpm --filter @quilin/benchmarks test` passes (12/12)
- [x] `pnpm --filter @quilin/benchmarks build` clean (tsc --noEmit)
- [x] Biome lint clean
- [ ] Commit + push + CI + Docs Lint green on master
