---
title: Iter E1-a — benchmarks workspace + SWE-bench Lite dataset bootstrap
status: in-progress
owner: Codex
created: 2026-04-22
last_updated: 2026-04-22
predecessors:
  - docs/planning/2026-04-22-10-iter-e1-harness-bootstrap.md
  - docs/planning/2026-04-22-09-ci-restoration.md
threat_surface_delta:
  new_ingress:
    - source: SWE-bench Lite dataset rows API / mirror download
      trust: untrusted
      mitigations:
        - configurable-default-hf-rows-endpoint  # CLI --rows-base-url may override default (Hugging Face datasets-server); allowlist deferred to E1-b
        - local-cache-only-after-validation  # rows validated before write
        - json-schema-shape-validation-before-write
        - sha256-manifest-verified-on-load  # loadSweBenchLiteFromCache re-verifies sha256 against manifest
  new_egress: []
  new_persistence:
    - location: .benchmarks/datasets/swe-bench-lite/
      sensitivity: low
      mitigations:
        - gitignore
        - schemaVersion-1-manifest
        - no-secrets-expected
---

# Iter E1-a — benchmarks workspace + SWE-bench Lite dataset bootstrap

## Goal

Land the packaging and dataset bootstrap needed for Iter E1:

- create a dedicated `benchmarks/` TS workspace
- add a fetch/cache path for SWE-bench Lite into `.benchmarks/`
- add parse/validation tests for cached dataset rows
- expose `runAgentLoop` publicly from `@quilin/agent-core`

## Scope

- In scope:
  - `benchmarks/` workspace skeleton
  - dataset fetch CLI
  - JSONL cache format + checksum manifest
  - parser/validator tests
  - `runAgentLoop` public re-export
- Out of scope:
  - task loader iteration logic beyond dataset parsing
  - repo clone / runner / evaluator
  - cost tracker
  - justfile integration

## Decisions

- Use a TS workspace for E1-a/E1-b/E1-c.
- Cache SWE-bench Lite locally as JSONL even if upstream transport changes.
- Treat checksum sidecar as local integrity verification for E1-a.
- Publicly re-export `runAgentLoop` from `@quilin/agent-core`; do not rely on internal import paths.

## Definition of Done

- [ ] `benchmarks/` is a pnpm workspace package with `build/test/lint/format`
- [ ] `benchmarks/scripts/fetch-benchmark.ts --dataset=swe-bench-lite` writes cache + manifest into `.benchmarks/`
- [ ] dataset parser validates required SWE-bench Lite fields
- [ ] `packages/agent-core/src/index.ts` publicly exports `runAgentLoop`
- [ ] local verification passes (`benchmarks` tests + agent-core tsc)
