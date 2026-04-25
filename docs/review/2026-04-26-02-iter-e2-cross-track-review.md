# Iter E2 R1 Independent Cross-Track Review

范围：`7ae93d7..16a3d2e`。本报告作为第六个独立 review subagent 输出，只基于当前 diff、当前代码、当前文档和本轮实测，不复用前面 R1-R5 的 finding 结论。

结论：**Iter E2 收口：NO**。当前有 `1` 个 BLOCKING 和 `3` 个 HIGH。可以继续 trusted/local spike，但不能 claim official / untrusted SWE-bench Verified hard isolation gate 已达成。

## Evidence Run

- `code-review-graph detect_changes(base=7ae93d7)`：16 changed files，59 changed functions/classes，risk score `0.55`；重点命中 `fetch-benchmark.ts`、`docker.ts`、`runner.ts`、Verified loader/tests。
- `code-review-graph get_review_context(base=7ae93d7)`：risk `high`，498 impacted nodes in 73 files。
- `git rev-parse --short HEAD && git rev-parse --short 7ae93d7 && git rev-parse --short 16a3d2e`：`HEAD=16a3d2e`，range endpoints match。
- `git diff --name-status 7ae93d7..16a3d2e`：16 files changed, including DockerSandbox, runner DI, CI smoke, SWE-bench Verified loader/fetch, ADR-010/011, E2 plan/spike.
- `docker version`：exit `1`; Docker CLI `28.5.2`, `darwin/arm64`, context `orbstack`, daemon unavailable at `/Users/raysonmeng/.orbstack/run/docker.sock`.
- `docker context ls`：`default`, `desktop-linux`, `orbstack`; active `orbstack`. No local daemon evidence. Real container behavior was not locally reproducible.
- `pnpm --filter @quilin/benchmarks build`：pass.
- `pnpm --filter @quilin/benchmarks lint`：pass, Biome checked 38 files.
- `pnpm --filter @quilin/benchmarks test`：13 files passed, 178 passed, 1 skipped.
- `pnpm --filter @quilin/benchmarks exec vitest run --coverage --configLoader runner`：pass, global statements `98.71%`, branches `96.22%`, functions `100%`, lines `98.7%`.
- `cd benchmarks && bun run scripts/docker-smoke.ts`：skipped on `darwin` with `{"event":"docker_smoke_skipped","reason":"DockerSandbox CI gate is Linux-only","platform":"darwin"}`.
- `bun run scripts/fetch-benchmark.ts --dataset verified --cache-root <tmp> --max-rows 1 --force`：real HuggingFace smoke fetched 1 row, `skipped=false`; second run without force returned `skipped=true`.
- `bun run scripts/fetch-benchmark.ts --dataset verified --cache-root <tmp> --max-rows 100 --force && bun run scripts/fetch-benchmark.ts --dataset verified --cache-root <tmp>`：reproduced BLOCKING-1. The second, full-intent run returned `rows=100`, `skipped=true`.
- `bun run scripts/fetch-benchmark.ts --dataset verified --cache-root <tmp> --max-rows 1 --retries 1 --rows-base-url http://127.0.0.1:9/rows`：exit `1`, attempted arbitrary loopback URL and failed with connection error.

External docs checked:

- GitHub hosted runner docs list `ubuntu-latest` / `ubuntu-24.04` Linux runners and note macOS arm64 nested virtualization is unsupported: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- GitHub runner-images Ubuntu 24.04 image currently includes Docker Client and Docker Server: <https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md>
- Docker resource docs state memory without `--memory-swap` can allow swap equal to memory: <https://docs.docker.com/engine/containers/resource_constraints/>
- Docker `rm -f` is the documented force-removal path for a running container: <https://docs.docker.com/reference/cli/docker/container/rm/>

## BLOCKING

### BLOCKING-1. Partial SWE-bench Verified fetch cache is reused as a full dataset cache

Evidence:

- `benchmarks/scripts/fetch-benchmark.ts:71-81` builds `source_url` only from the first page URL. With default `pageSize=100`, both `--max-rows 100` and a full fetch use the same first-page URL.
- `benchmarks/scripts/fetch-benchmark.ts:82-99` skips fetch when `tryReadValidManifest()` returns a manifest.
- `benchmarks/scripts/fetch-benchmark.ts:200-225` validates `schema_version`, `dataset`, `source_url`, `sha256`, and that `rows` is a non-negative number, but it does not compare `rows` to the requested fetch intent or to `SWE_BENCH_VERIFIED_EXPECTED_ROWS=500`.
- Repro command above: after a forced `--max-rows 100` fetch, a second run without `--max-rows` returned `rows=100`, `skipped=true`.

Impact:

An official SWE-bench Verified run can silently run 100 tasks while presenting a valid cache and a full fetch intent. The hash is correct for the truncated file, so sha256 does not catch this. This invalidates benchmark coverage and any score produced from that cache.

Required fix:

Encode fetch intent in the manifest and skip key, for example `page_size`, `max_rows`, and `expected_rows`; for `swe-bench-verified` full mode, require `rows === 500` before cache reuse. A smoke/shard cache must not be accepted as a full dataset cache.

## HIGH

### HIGH-1. Timeout cleanup can leak Docker containers

Evidence:

- `benchmarks/src/sandbox/docker.ts:87-96` aborts the `docker run` child process and then calls `runner(["kill", containerName])`.
- `benchmarks/src/sandbox/docker.ts:131-134` only awaits that kill promise. There is no `docker rm -f`, `docker inspect`, retry, or "container never created" cleanup path.
- `docs/research/2026-04-26-01-docker-sandbox-mvp-spike.md:126-133` calls for host timeout and `docker rm -f <container>`.
- `docs/adr/adr-011-docker-sandbox-mvp.md:57-63` requires cleanup on timeout/failure.

Impact:

Killing the CLI process and killing the container are not the same cleanup guarantee. If the CLI process is aborted first, `--rm` cannot be treated as enough evidence that the daemon removed the container. If `docker kill` races before container creation or returns a handled error, the code reports a timeout and moves on. Repeated SWE-bench tasks can leave stopped/running containers and consume CI host resources.

Required fix:

Use a cleanup path that is idempotent and removal-oriented: `docker rm -f <containerName>` on timeout/failure, tolerate "not found", and optionally verify with `docker inspect`/`docker ps -a` in the Linux smoke. The unit test should assert removal, not only `kill`.

### HIGH-2. DockerSandbox has unbounded stdout/stderr capture and does not implement the ADR output cap

Evidence:

- `benchmarks/src/sandbox/docker.ts:177-188` appends child stdout/stderr to strings without any byte cap.
- `docs/adr/adr-011-docker-sandbox-mvp.md:57-63` lists stdout/stderr max bytes as a required per-task resource limit.
- Docker resource docs warn that uncontrolled resource consumption can destabilize the host; container memory limits do not cap host-side log accumulation by the supervising process.

Impact:

A container running `yes` or printing test logs in a loop can consume host memory through the Bun/Node process even if the container itself is memory-limited. The default `60_000ms` timeout is enough time to allocate a large amount of host RAM. This weakens the hard isolation gate.

Required fix:

Add `maxOutputBytes` or separate stdout/stderr caps to `DockerSandboxOptions`; truncate deterministically, mark the command as error or timed out when exceeded, and kill/remove the container. Add a unit test with a fake runner or real Linux smoke that exceeds the cap.

### HIGH-3. `--rows-base-url` is an unrestricted host-side fetch endpoint

Evidence:

- `benchmarks/scripts/fetch-benchmark.ts:5` defaults to HuggingFace datasets-server.
- `benchmarks/scripts/fetch-benchmark.ts:347-349` accepts any `--rows-base-url` string.
- `benchmarks/scripts/fetch-benchmark.ts:273-279` constructs a URL from that base without scheme/host/path allowlisting.
- The loopback probe above attempted `http://127.0.0.1:9/rows`; it failed only because nothing was listening.
- `benchmarks/scripts/fetch-benchmark.ts:140-170` paginates until the endpoint returns an empty/short page; with `maxRows` omitted, a malicious endpoint can keep returning full pages.

Impact:

This is host-side SSRF in the fetch CLI. In CI it could be aimed at internal services or metadata endpoints. It also lets a malicious mirror keep the process fetching indefinitely unless the caller remembers to set `--max-rows`.

Required fix:

Default to the HuggingFace URL and reject overrides unless an explicit unsafe flag or environment variable is set for tests. Enforce `https:` plus an allowlist for production fetches. Also cap `pageSize`, `retries`, and total rows per known dataset.

## MEDIUM

### MEDIUM-1. Linux CI smoke is runnable in principle, but does not prove the Day 0 DockerSandbox gate

Evidence:

- `.github/workflows/ci.yml:26-36` adds a Linux `benchmarks-docker-smoke` job using `ubuntu-latest`, `docker version`, benchmark build, and `bun run scripts/docker-smoke.ts`.
- Current GitHub docs map `ubuntu-latest` to Ubuntu 24.04, and the runner image docs list Docker Client/Server, so the job is plausible.
- `benchmarks/scripts/docker-smoke.ts:25-37` skips non-Linux and requires Docker on Linux. This macOS skip is reasonable for the hard gate.
- The actual smoke command at `benchmarks/scripts/docker-smoke.ts:75-78` only reads from `/workspace/base` and writes to `/workspace/artifacts`.
- It does not attempt to write the read-only base mount, write the read-only cache mount, prove `--network none`, prove timeout removal, or record/inspect resource metadata.
- `docs/adr/adr-011-docker-sandbox-mvp.md:109-117` and `docs/planning/2026-04-26-01-iter-e2-swe-bench-verified.md:46-53` require those Day 0 behaviors.

Impact:

The workflow can catch "Docker daemon absent" and "artifact export works", but it cannot justify the stronger hard-isolation claim in ADR-011 or the E2 plan.

Required fix:

Extend the Linux smoke with real container assertions: base/cache write denial, task/artifacts write success, outbound network failure under `--network none`, timeout cleanup with no leftover container, and inspect/logged CPU/memory/pids settings.

### MEDIUM-2. Memory limit is looser than the spike text implies

Evidence:

- `benchmarks/src/sandbox/docker.ts:224-229` passes `--cpus`, `--memory`, and `--pids-limit`, but no `--memory-swap`.
- Docker docs state that when `--memory` is set and `--memory-swap` is unset, total memory plus swap may be double the memory value if host swap is configured.
- `docs/research/2026-04-26-01-docker-sandbox-mvp-spike.md:128-133` explicitly mentions `--memory=<bytes>` and `--memory-swap=<bytes>`.

Impact:

This is still a memory limit, but not the stricter no-swap limit the spike describes. For CI parity, the smoke should not depend on host swap behavior.

Required fix:

Set `--memory-swap` equal to `--memory` when the goal is no swap, or document that swap is allowed and log it in sandbox metadata.

## LOW

### LOW-1. Plan residual ownership is mostly stable, but the DockerSandbox blocked row is now stale

Evidence:

- `docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md:983-989` still has the M1.1 / LongMemEval / Arm L resource-blocked items with clear unlock rules. Those remain stable.
- `docs/planning/00-implementation-plan.md:548-550` mirrors the same resource-blocked items. Stable.
- `docs/planning/00-implementation-plan.md:552` still lists `DockerSandbox / LocalSandbox / CloudSandbox` as blocked and owned by Iter D 后期 or Iter F, while this E2 range has already activated a DockerSandbox MVP in `benchmarks/src/sandbox/**` and `docs/planning/2026-04-26-01-iter-e2-swe-bench-verified.md:61-64`.

Impact:

This does not break runtime behavior, but it gives future reviewers two sources of truth for DockerSandbox ownership.

Required fix:

Update the blocked table to say DockerSandbox MVP is activated in Iter E2, while LocalSandbox/CloudSandbox remain deferred.

## Positive Checks

- Docker command injection at the shell-command-to-Docker-CLI layer looks OK: `benchmarks/src/sandbox/docker.ts:217-245` passes Docker args as an argv array, and the task command is the final `/bin/sh -lc <command>` argument after the image. The shell still interprets the command inside the container, which is intended.
- Docker mount split matches the MVP shape: base read-only, task read-write, artifacts read-write, cache read-only at `benchmarks/src/sandbox/docker.ts:230-238`.
- `--network none` is present at `benchmarks/src/sandbox/docker.ts:222-223`.
- Runner DI direction is sound: injected sandbox routes string `shell_exec.command` to `sandbox.runShellCommand()` and does not call the host shell tool (`benchmarks/src/runner/runner.ts:404-414`). Without a sandbox, the E1 best-effort guard remains on `shell_exec` cwd/path/command tokens (`benchmarks/src/runner/runner.ts:435-442` and `:495-642`).
- Verified loader cache containment is solid for the local file threat model: strict manifest schema (`benchmarks/src/datasets/cache.ts:16-26`), canonical data file and realpath containment (`:68-109`), sha256 validation (`:56-63`), and row-count mismatch rejection (`benchmarks/src/datasets/swe-bench-verified.ts:66-70`) are covered by tests (`benchmarks/src/datasets/swe-bench-verified.test.ts:150-205`).

## Decision

Iter E2 收口：**NO**.

Minimum closure before yes:

1. Fix partial-cache reuse for SWE-bench Verified full fetch.
2. Replace timeout cleanup with force removal and verify no leftover container in Linux smoke.
3. Add stdout/stderr caps.
4. Restrict or explicitly unsafe-gate `--rows-base-url`.
5. Expand Linux CI smoke to cover ADR-011 Day 0 Docker behaviors.
