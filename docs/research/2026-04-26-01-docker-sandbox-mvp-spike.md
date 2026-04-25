# DockerSandbox MVP Spike — Iter E2 Day 0

> **日期**: 2026-04-26
> **范围**: ADR-011 draft / Iter E2 Day 0 feasibility
> **结论**: **Pivot Linux-only** for Docker hard isolation gate

---

## 0. Executive Summary

My independent view is: 继续 DockerSandbox，但 E2 hard isolation gate 只承诺 Linux runner。macOS 可以跑 non-Docker unit tests 和本地开发 smoke；official / untrusted SWE-bench Verified run 不应依赖 macOS Docker。

本机实测：Docker CLI 存在，但 daemon 不通，当前 context 是 `orbstack`。

```text
docker version
Client Version: 28.5.2
OS/Arch: darwin/arm64
Context: orbstack
Cannot connect to the Docker daemon at unix:///Users/raysonmeng/.orbstack/run/docker.sock
```

`docker context ls` 显示 `default` / `desktop-linux` / `orbstack` 三个 context；三个 context 均不能连接 daemon。因此本机不能完成 `docker run` smoke。

---

## 1. macOS GitHub Actions Runner

**结论**: macOS runner 不作为 DockerSandbox gate。E2 CI gate 使用 Linux hosted runner 或 self-hosted Linux runner。

依据：

- GitHub-hosted runners 文档列出 Linux / Windows / macOS runner，并明确 macOS arm64 runner 不支持 nested virtualization；这会影响需要 VM/daemon 的 Docker-on-macOS 方案。
- GitHub self-hosted runner 文档说明，如果 workflow 使用 Docker container actions 或 service containers，runner machine 必须是 Linux 且安装 Docker。
- Docker Desktop / OrbStack 在 macOS 本地可作为 optional developer smoke，但不是 CI hard gate。

Sources:

- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.github.com/en/actions/reference/runners/self-hosted-runners

Decision: **Pivot Linux-only**。E2 workflow 应拆：

- `ubuntu-latest`: DockerSandbox smoke + SWE-bench shard gate
- `macos-latest`: non-Docker unit tests only
- optional `self-hosted, linux, docker`: long-running SWE-bench shard

---

## 2. Dependency Choice

**MVP 不需要新 npm 依赖**。优先用 Docker CLI via existing process runner / shell-exec-compatible executor。

Options:

| 方案 | 评价 |
|---|---|
| Docker CLI | 最小依赖；容易复现；CI debug 直接看命令；MVP 推荐 |
| Docker Engine API over Unix socket | 无 npm 依赖也可做，但要手写 HTTP socket client；不适合 Day 0 |
| `dockerode` | `npm view dockerode` 实测 `5.0.0`，Apache-2.0，依赖 `docker-modem` / grpc / protobuf / tar 等；更适合后续流式 logs / attach / stats |
| Python `docker` SDK | Docker 官方 SDK 文档推荐 Python SDK；但 benchmarks workspace 是 TS，跨语言控制面会增加复杂度 |

Docker 官方 SDK 文档：Docker Engine API 是 REST API；官方 SDK 覆盖 Go/Python，NodeJS `dockerode` 列在 community libraries。MVP 先 CLI，后续若需要稳定 attach/log streaming 再评估 `dockerode`。

Source: https://docs.docker.com/reference/api/engine/sdk/

---

## 3. Workspace Mount Strategy

Recommended MVP:

```text
host run dir
  base/        read-only repo checkout or extracted fixture
  task/        read-write per-task workspace
  artifacts/   read-write export dir
  cache/       read-only dataset/package cache
```

Container mounts:

```text
--read-only
--mount type=bind,src=<base>,dst=/workspace/base,readonly
--mount type=bind,src=<task>,dst=/workspace/task
--mount type=bind,src=<artifacts>,dst=/workspace/artifacts
--mount type=bind,src=<cache>,dst=/workspace/cache,readonly
-w /workspace/task
```

Do **not** rely on Docker overlayfs inside the container for MVP; overlayfs often needs elevated permissions and is less portable on Docker Desktop. Instead, host prepares the writable task workspace by copying, extracting, or `git worktree`/checkout materialization before `docker run`.

Boyle scratchpad remains host-side logical state keyed by `task_id`. Container filesystem scratch is `/workspace/task` plus `/workspace/artifacts`; do not mount user-level memory DB into container.

Docker docs confirm bind mounts are supported by `--mount type=bind`, target paths must be absolute, and bind mounts are read-write by default unless marked read-only.

Source: https://docs.docker.com/engine/containers/run/

---

## 4. Network Policy

**Native Docker can deny all egress easily; precise domain whitelist is not native.**

MVP recommendation:

1. Default official task command containers run with `--network none`.
2. Dataset fetch, leaderboard upload, and LLM calls happen host-side.
3. If a task truly needs network for setup, route through an explicit host egress proxy in a dedicated Docker network and log the exception in task metadata.

Why not iptables-only:

- Docker network rules are IP-level; HF / leaderboard / LLM providers use DNS, CDNs, changing IPs, and TLS.
- Domain whitelist requires proxy/SNI/HTTP-layer control, not just Docker network flags.
- Granting container `CAP_NET_ADMIN` to manage iptables weakens sandbox.

E2 Day 0 should test:

- `--network none` blocks outbound.
- A proxy-network mode can reach exactly one test endpoint and deny another.
- No Docker socket is mounted into the container.

---

## 5. Timeout / Resource Limits

MVP controls:

- Host-side wall timeout via AbortController / process timeout; on expiry `docker rm -f <container>`.
- Docker memory via `--memory=<bytes>` and `--memory-swap=<bytes>`.
- Docker CPU via `--cpus=<float>` or `--cpu-quota/--cpu-period`.
- stdout/stderr max bytes enforced host-side while collecting logs.

Docker docs state containers have no resource constraints by default, but Docker provides memory/CPU runtime flags. `--cpus` is equivalent to CFS quota/period for CPU limits. On macOS these controls are mediated by the Docker Desktop / OrbStack Linux VM and must not be treated as CI-equivalent. Linux runner is the source of truth.

Sources:

- https://docs.docker.com/engine/containers/run/
- https://docs.docker.com/engine/containers/resource_constraints/

---

## 6. Artifact Export

Use an explicit writable artifact mount:

```text
/workspace/artifacts/candidate.patch
/workspace/artifacts/command.log
/workspace/artifacts/result.json
/workspace/artifacts/trace.jsonl
/workspace/artifacts/sandbox.json
```

Container commands write outputs there; host reads after container exit. Host also records Docker metadata: image digest, command, exit code, timeout flag, memory/CPU limits, network mode, mount map.

Do not infer patch output from arbitrary modified files in the host repo. The task workspace can be diffed inside the container and written to `candidate.patch`.

---

## 7. LLM API Egress

Default: API keys do **not** enter the container.

Preferred architecture:

- Host-side runner calls LLM / agent loop.
- Container only executes repo commands needed for setup/scoring.
- If containerized agent loop becomes necessary, use a short-lived scoped token injected for that run only, never the user's long-lived provider key.

This keeps DockerSandbox focused on repo command isolation and avoids turning the container into a credential boundary.

---

## 8. Spike Decision

Chosen path: **Pivot Linux-only**.

Meaning:

- Continue DockerSandbox MVP.
- E2 hard isolation and official/untrusted SWE-bench Verified run only gate on Linux Docker.
- macOS remains non-Docker development/test surface.
- No `dockerode` dependency in MVP; start with Docker CLI.
- Network whitelist starts as `--network none` + host-side fetch/LLM/upload. Domain whitelist via proxy is a follow-up if task setup requires network.

Not chosen:

- Continue Docker everywhere: rejected because macOS daemon / nested virtualization / CI parity is not reliable.
- Pivot self-hosted only: premature; first test `ubuntu-latest`.
- Abandon Docker: rejected; lexical guard is not enough for E2 official/untrusted runs.

---

## 9. E2 Follow-up DoD

Before implementing SWE-bench Verified full run:

- [ ] Linux Docker smoke: `docker version` + `docker run --rm alpine:...`
- [ ] read-only base mount cannot be modified
- [ ] task workspace mount is writable
- [ ] artifact mount exports patch/log/result
- [ ] `--network none` denies outbound
- [ ] timeout kills a long-running command and removes container
- [ ] memory/CPU limits are present in Docker inspect metadata
- [ ] E2 plan updated with Linux-only gate and optional self-hosted runner fallback
- [ ] ADR-011 promoted from Draft only after smoke evidence is attached
