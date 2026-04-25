# ADR-011: DockerSandbox MVP — Iter E2 Draft

> **状态**: Draft（Iter E2 Day 0 spike 后再定稿）
> **日期**: 2026-04-26
> **决策者**: Quilin Agent 团队
> **前置**: [ADR-010](./adr-010-benchmark-harness-wire-schema.md) Benchmark Harness Wire Schema

---

## 1. Status

Draft. 本 ADR 先记录 DockerSandbox MVP 的待验证契约，不在 E1 定稿。E2 Day 0 spike 必须用实际 Docker smoke 验证可行性后，再把状态改为 Proposed / Accepted。

---

## 2. Context

Iter E1 的 runner 已有 best-effort workspace guard：per-task tmpdir、workspace cwd、path-like 参数拦截、`file://` / 常见 redirect path 保护、fetch whitelist。R1-R5 review 证明 lexical shell parser 无法提供 hard isolation；shell 语义、工具自身 URL/path 解释、环境变量、glob、命令替换等都不是字符串检查能完整证明的范围。

E2 要跑 SWE-bench Verified。公开 benchmark task 通常不是 attacker-controlled，但 official / untrusted leaderboard run 仍需要 hard isolation，避免污染主仓库、用户目录、系统路径或 CI runner。

---

## 3. Draft Decision

### 3.1 Threat model

- E1 best-effort guard：防意外污染，不防恶意 task。
- E2 DockerSandbox：防 benchmark repo command 逃出 workspace、污染 host 文件系统、任意 outbound network。
- LLM provider 调用默认 host-side，不把长期 API key 放入容器。

### 3.2 Workspace mount

MVP mount 拆分：

- `repo_checkout`: read-only，供 task 读取原始 repo 状态。
- `task_workspace`: read-write，容器内唯一可写工作区。
- `artifacts`: read-write，容器退出后导出 patch、logs、score details。
- `cache`: read-only by default；dataset cache 更新只在 host fetch 阶段发生。

容器内工作目录固定为 `/workspace/task`。任何需要修改 repo 的命令先在 `task_workspace` 中完成 checkout/copy，不直接写 host master 工作树。

### 3.3 Network policy

默认 deny outbound。允许项必须显式配置：

- dataset / leaderboard endpoint
- LLM provider endpoint（仅当容器内必须调用 LLM；默认不需要）
- GitHub / package registry（仅当 SWE-bench setup 明确需要；必须记录在 task metadata）

Day 0 spike 要验证 Docker 网络限制实现方式：优先自定义 network + proxy/egress guard；如果只能做到 host-level best-effort，不能 claim hard network isolation。

### 3.4 Resource limits

每 task 必须有：

- wall-clock timeout
- CPU limit
- memory limit
- stdout / stderr max bytes
- cleanup on timeout / failure

MVP 默认值由 E2 plan 冻结；user config 可覆盖，但不能关闭 hard timeout。

### 3.5 Artifact export

容器结束后 host 收集：

- candidate patch
- command logs
- BenchmarkResult details
- OTel trace jsonl
- sandbox metadata（image digest、limits、network mode、exit code）

Artifacts 必须写入 `benchmarks.output_dir` / `benchmarks.submissions_dir` 下的 per-run 子目录。

### 3.6 CI feasibility

E2 Day 0 只把 Linux Docker runner 作为 gate。GitHub-hosted macOS runner 不作为 DockerSandbox gate；macOS 可跑 non-Docker unit tests。

当前外部依据：

- GitHub-hosted runner docs 列出 macOS arm64 nested virtualization 不支持；这会影响 Docker-in-VM 类方案。
- GitHub self-hosted runner docs 对 Docker container actions / service containers 要求 Linux machine + Docker installed。

Sources:
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.github.com/en/actions/reference/runners/self-hosted-runners

---

## 4. Open Questions

1. Docker image：使用 upstream SWE-bench image、Quilin-maintained image，还是 per-task dynamic build？
2. Network deny：采用 Docker network none + host proxy，还是 egress proxy sidecar？
3. Package install：允许联网安装依赖，还是预bake image/cache？
4. Mac local dev：Docker Desktop 可选支持是否进入 DoD？
5. CI：`ubuntu-latest` 是否稳定跑 Docker smoke，还是需要 self-hosted Linux runner？

---

## 5. Day 0 Spike DoD

- `docker version` / `docker run --rm` smoke 通过
- read-only repo mount 不可写；task workspace 可写；artifacts 可导出
- timeout 能 kill long-running command
- memory / CPU limit 可配置并记录
- network deny/allow 行为有真实 smoke
- E2 implementation breakdown 更新到 `docs/planning/2026-04-26-01-iter-e2-swe-bench-verified.md`

---

## 6. Consequences

- E1 可以诚实收口：best-effort guard + documented limitation，不再追 shell token 全覆盖。
- E2 timeline 增加 DockerSandbox gate，但减少后续 R6/R7 lexical parser 循环。
- Official / untrusted leaderboard run 的安全声明只在 DockerSandbox gate 通过后成立。
