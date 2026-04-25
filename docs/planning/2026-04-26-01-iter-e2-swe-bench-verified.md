# Iter E2 — SWE-bench Verified + DockerSandbox Gate

> **状态**: Draft（E2 Day 0 spike 待执行）
> **日期**: 2026-04-26
> **owner**: Quilin Agent 团队
> **前置**: Iter E1 benchmark harness infra；ADR-010 best-effort workspace guard；ADR-011 DockerSandbox MVP draft

Iter E2 的目标是把 E1 的通用 benchmark harness 推进到 SWE-bench Verified 可运行路径，并在跑 official / untrusted leaderboard run 前冻结 DockerSandbox hard isolation gate。E1 的 lexical workspace guard 只防意外污染，不再承诺防恶意 command。

---

## 0. Day 0 Spike

### 0.1 入场状态

- Iter E1 已完成 benchmark workspace、wire schema、runner、dataset loader、scorer、submission adapter。
- R1-R5 review 链证明 lexical shell sandbox 会持续出现新 token 形态；ADR-010 §3.7 已改为 best-effort workspace guard。
- E2 hard isolation gate 转入 DockerSandbox MVP，ADR-011 先以 draft 启动，spike 后再定稿。

### 0.2 Spike 问题

| 主题 | Spike 输出 |
|---|---|
| workspace mount | 明确 repo checkout、task workspace、artifact dir 的 read-only / read-write 切分；默认主仓库 read-only，per-task workspace read-write |
| network policy | 白名单 dataset / leaderboard / LLM provider；其他 deny；确认 Docker 网络限制实现方式 |
| timeout / CPU / memory | 每 task timeout、CPU shares / cpus、memory limit、process kill 策略 |
| artifact export | 导出 candidate patch、logs、trace jsonl、score details；容器退出后由 host 收集 |
| LLM API egress | API key 不进容器；优先 host-side agent loop 调 LLM，容器只跑 repo commands；若必须进容器，采用短期 scoped env |
| CI 可行性 | Linux GitHub-hosted runner 跑 Docker smoke；macOS runner 不作为 Docker gate；必要时 self-hosted Linux runner |

### 0.3 CI 初判

- GitHub-hosted runner 文档列出 Linux / Windows / macOS hosted runners，并说明 macOS arm64 不支持 nested virtualization；因此 E2 不把 macOS runner 作为 DockerSandbox gate。
- GitHub self-hosted runner 文档说明使用 Docker container actions / service containers 需要 Linux machine + Docker installed；E2 CI gate 优先 `ubuntu-latest`，self-hosted Linux 作为后备。
- Day 0 必须用实际 workflow 或本地命令验证 `docker version`、`docker run --rm alpine:...`、bind mount、network deny/allow 是否成立。

Sources:
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.github.com/en/actions/reference/runners/self-hosted-runners

### 0.4 Day 0 DoD

- [ ] ADR-011 从 draft 收敛到 Proposed / Accepted 之一
- [ ] DockerSandbox MVP smoke：Linux 本地或 CI `docker run` + bind mount + timeout + artifact export 通过
- [ ] 网络策略 spike：deny-by-default 可执行；LLM / dataset / leaderboard 白名单路径明确
- [ ] E2 implementation breakdown 产出，明确 runner / SWE-bench dataset / harness / Docker / submission 五轨道写边界
- [ ] 若 Docker 不可用：E2 降级为 trusted/local smoke，不 claim official Verified hard isolation

---

## 1. E2 范围

### 1.1 做

- SWE-bench Verified dataset loader / cache manifest / task iterator
- Official harness compatible prediction generation
- DockerSandbox MVP 接入 runner setup / agent_loop / score 阶段
- Patch apply + test command execution inside container
- Cost / latency / trace output 与 E1 BenchmarkResult 对齐
- Small shard smoke（先 1-5 tasks，再扩大）

### 1.2 不做

- GAIA / BFCL v4（留 E3）
- Full cloud sandbox / Kubernetes autoscaling
- LongMemEval / L3a observer blocked 项
- 未授权 leaderboard 上传；submission adapter 可生成包，但 upload gate 另开

---

## 2. 并行轨道草案

| 轨道 | 范围 | 写边界 |
|---|---|---|
| Docker | DockerSandbox MVP：image selection、bind mount、network policy、limits、artifact export | `benchmarks/src/sandbox/**` + tests + ADR-011 |
| SWE Dataset | SWE-bench Verified fetch/load/cache/iterator；兼容 E1 wire task | `benchmarks/src/datasets/**` + tests |
| Harness | runner 接入 sandbox lifecycle；per-task workspace mount；score 阶段执行 test command | `benchmarks/src/runner/**` + tests |
| Scoring | SWE-bench Verified result scorer；区分 patch apply / tests passed / infra error | `benchmarks/src/scorers/**` + tests |
| Submission | Verified prediction package + metadata manifest；不默认上传 | `benchmarks/src/submissions/**` + tests |

---

## 3. 收口门槛

- DockerSandbox gate：official / untrusted run 必须在 DockerSandbox 中执行 repo commands
- Coverage：benchmarks lines / branches / functions / statements ≥ 95%
- `pnpm --filter @quilin/benchmarks build` / lint / test 全绿
- `just test-all` 三语言全绿
- AMB 100k p95 ≤ 300ms
- E2 review gate：独立 subagent review BLOCKING/HIGH 0

---

## 4. References

- [ADR-010 Benchmark Harness Wire Schema](../adr/adr-010-benchmark-harness-wire-schema.md)
- [ADR-011 DockerSandbox MVP draft](../adr/adr-011-docker-sandbox-mvp.md)
- [Iter E1 Restart](./2026-04-25-03-iter-e1-restart.md)
