# ADR-010: Benchmark Harness Wire Schema — Iter E1 Day 0 契约冻结

> **状态**: Proposed (Iter E1 Day 0 contract freeze)
> **日期**: 2026-04-25
> **决策者**: Quilin Agent 团队
> **前置**: [ADR-008](./adr-008-observability-span-schema.md) Observability Span Schema；[ADR-009](./adr-009-config-cascade.md) Config Cascade

---

## 1. 状态

Iter E（Benchmark Ascent，§Iteration E）启动前，必须冻结 benchmark harness 跨 leaderboard 的 wire schema、runner 生命周期、cache 完整性、sandbox/egress 边界、scorer 协议、submission adapter 协议、以及对 Iter D OTel/config/scratchpad 的复用契约。

`docs/planning/2026-04-25-03-iter-e1-restart.md` 是 Iter E1 执行清单；与本 ADR 冲突时以本 ADR 为准。

本 ADR 不冻结具体 leaderboard 的提交格式（每 leaderboard 一个 adapter，动态注册），仅冻结跨 leaderboard 的通用接口与 wire schema。

---

## 2. Context

E1-a (`2bb25d7`) + E1-b (`1298f3d`) 已被 `1eecb84` / `d538736` revert 掉，master 当前没有 tracked benchmarks 源码。Iter D 已落地 OTel cost/latency tracking、Boyle scratchpad、Kelvin user-config——这些是 E1 必须复用的基础。

风险来自四个方向：

1. **跨 leaderboard 漂移**：SWE-bench Verified / GAIA / BFCL v4 任务结构差异大；如果不冻结通用 wire，每个 leaderboard 各写一套 task 类型会让 runner / scorer 无法复用。
2. **Cost-tracking 重复**：Iter D OTel 已记录 `agent.turn.cost_usd` / `total_latency_ms`，benchmark runner 不应自建第二套 cost-tracking，应抽取 OTel attribute。
3. **Sandbox/egress 边界**：benchmark 跑大量未知任务，必须有 per-task 文件系统隔离 + 网络白名单；DockerSandbox 留 Iter F，本 Iter 用 per-task scratchpad + tmpdir + cwd containment。
4. **Cache 完整性**：dataset fetch 一次几百 MB，必须 sha256 manifest verify on load；旧 E1-a 已有此设计，本 ADR 把它升级为通用 cache 协议。

---

## 3. Decision

### 3.1 Task wire schema（跨 leaderboard 通用）

冻结 TS interface（zod schema 在 `benchmarks/src/wire/task.ts`）：

```
BenchmarkTask {
  task_id: string                 // 跨 leaderboard 唯一
  dataset: string                 // "swe-bench-verified" / "gaia" / "bfcl-v4"
  inputs: Record<string, unknown> // leaderboard-specific 输入
  expected: Record<string, unknown> // leaderboard-specific 预期（scorer 用）
  scorer_type: string             // "patch-apply" / "exact-match" / "tool-call" / ...
  token_budget?: number           // 可选；缺省按 dataset 默认
  metadata?: Record<string, unknown>
}
```

`inputs` / `expected` 字段保持 leaderboard-specific，但顶层 `task_id` / `dataset` / `scorer_type` 必须冻结，scorer 与 runner 通过这些字段路由。

### 3.2 Run 生命周期

冻结 5 阶段（runner 必须按顺序走，每阶段对应 OTel span）：

1. **setup**：从 dataset 读 task；准备 per-task scratchpad；准备 tmpdir；按 `cwd containment` 锁工作目录
2. **agent_loop**：调用 `runAgentLoop()`（agent-core 已 export）；OTel `agent.session/turn/state_node/llm/tool` 自动埋点
3. **collect**：读 agent loop output；从 OTel attribute 抽 cost/latency；合成 BenchmarkResult
4. **score**：调 scorer 协议（§3.5）打分
5. **cleanup**：清 scratchpad TTL；清 tmpdir；清网络连接

任何阶段抛错必须包成 `BenchmarkRunError`；不允许 runner 直接抛业务异常。

### 3.3 Run / Result wire schema

```
BenchmarkRun {
  run_id: string                  // crypto.randomUUID
  task_id: string
  agent_session_id: string        // 对应 OTel agent.session.id
  started_at: ISO8601
  finished_at: ISO8601
}

BenchmarkResult {
  run_id: string
  task_id: string
  output: Record<string, unknown> // agent 最终产出
  passed: boolean
  score: number                   // [0, 1] 或 leaderboard 自定义
  details: Record<string, unknown>
  cost: BenchmarkCost
  latency_ms: number
}

BenchmarkCost {
  input_tokens: number
  output_tokens: number
  thinking_tokens: number
  total_usd: number               // 从 OTel agent.turn.cost_usd 累加
  per_model_usd: Record<string, number>
}
```

### 3.4 Cache / checksum 契约

所有 dataset fetch 必须落盘到 `.benchmarks/datasets/<name>/`（已在 .gitignore）：

- `manifest.json`：`{ schema_version: 1, dataset, fetched_at, rows: number, sha256: string, source_url: string }`
- 数据文件（jsonl 或原始格式）+ sha256 哈希进 manifest
- **Load 时强制 verify**：sha256 不匹配 / `schema_version != 1` 直接拒载并报 `CacheError`
- Fetch 时分页 + retry；幂等：相同 source_url 已有合法 manifest 时跳过

### 3.5 Scorer 协议

```
type Scorer<T extends BenchmarkTask = BenchmarkTask> = (
  task: T,
  output: Record<string, unknown>,
) => Promise<{
  passed: boolean
  score: number
  details: Record<string, unknown>
}>
```

Scorer 按 `scorer_type` 注册（动态 registry）；新增 leaderboard 加新 scorer，不动现有 scorer。

### 3.6 Submission adapter 协议

```
type SubmissionAdapter<T extends BenchmarkTask = BenchmarkTask> = {
  dataset: string                          // 匹配 BenchmarkTask.dataset
  format: "jsonl" | "json" | "csv"
  serialize: (results: BenchmarkResult[]) => string
  filename: (run_id: string) => string
}
```

每 leaderboard 一个 adapter；submission 包通过 registry 动态生成。

### 3.7 Sandbox / Egress 边界

本 Iter E1（包括 E2/E3）：

- **文件系统**：per-task scratchpad（Iter D Boyle）+ tmpdir（cwd containment）；禁止 task 写 `~`、`/etc`、`/var`、master 工作树以外的路径
- **网络**：白名单仅 dataset endpoint（Hugging Face datasets-server / 各 leaderboard 官方）+ LLM provider endpoint；禁止任意 outbound
- **shell exec**：复用 Iter B 的 shell-exec 工具；CRITICAL 保持 confirm（不因 benchmark 自动放开）
- **DockerSandbox**：仍 defer Iter F；本 Iter 不实现

破坏沙箱边界视为 BLOCKING，必须停 run 不计分。

### 3.8 Iter D 复用契约

- **OTel cost/latency**：runner 从 OTel `agent.turn.cost_usd / llm.tokens_input / llm.tokens_output / llm.tokens_thinking / total_latency_ms` 抽取；不重复实现 cost-tracking
- **Boyle scratchpad**：每 task 一个 `task_id` 维度的 scratchpad，作为 per-task working set；run 结束 cleanup 清空
- **Kelvin user-config**：新增 `benchmarks.*` namespace（`output_dir / submissions_dir / cache_dir / max_concurrent_tasks / network_whitelist`）；ADR-009 §3.4 顶层 namespace 表本 ADR 修订时同步加 `benchmarks`

### 3.9 Memory 降级（plan §E2 约束）

E2 baseline 不使用跨会话 OmniMem 4 层（episodic / semantic / skill）；只使用 per-task working set + SQLite FTS5。完整 4 层留 Iter F。这条降级是**性能 / 可解释性 / 提交可复现性** 的 trade-off：跨会话记忆引入 noise，benchmark 提交需要每 task 独立可复现。

---

## 4. Consequences

### 正向后果

- 跨 SWE-bench / GAIA / BFCL v4 共用同一 runner / wire schema / cache 协议；新增 leaderboard 只加 scorer + adapter
- Cost-tracking 单一真相源（OTel），不会 runner / agent-loop 双写不一致
- Cache integrity 强制（sha256 + schema_version）；submission 包可复现
- Sandbox/egress 边界清晰；E2 任务跑大批量代码不会污染主仓库

### 约束

- 新增 leaderboard 必须扩展 `dataset` 枚举值 + 注册 scorer + 注册 adapter；不允许 ad-hoc 跑 task
- DockerSandbox 不存在意味着跑高风险 task（任意 shell）必须保持 CRITICAL confirm；不允许 benchmark 自动 unlock
- 任何破坏 §3.7 沙箱边界的 task 视为 BLOCKING 并放弃成绩
- ADR-009 顶层 namespace 表必须同步加 `benchmarks`（本 ADR 修订时执行）

### 后续工作

- Day 0 同 commit：`docs/planning/2026-04-25-03-iter-e1-restart.md` 起草 + ADR-009 §3.4 加 `benchmarks` namespace
- E1 Pasteur 轨道：`benchmarks/src/runner.ts` 实现 §3.2 5 阶段生命周期 + §3.8 OTel 抽取
- E1 Galois 轨道：`benchmarks/src/datasets/` 实现 §3.4 cache 协议 + 至少 SWE-bench-lite loader
- E1 Lavoisier 轨道：`benchmarks/src/scorers/` 实现 §3.5 协议 + SWE-bench patch-apply scorer
- E1 Mendeleev 轨道：`benchmarks/src/submissions/` 实现 §3.6 协议 + 第一个 SWE-bench Verified jsonl adapter

---

## 5. References

- [Iter E1 restart 计划](../planning/2026-04-25-03-iter-e1-restart.md) — 执行清单
- [00-implementation-plan §Iteration E](../planning/00-implementation-plan.md) — Iter E 总范围 E1-E4
- [ADR-008 Observability Span Schema](./adr-008-observability-span-schema.md) — runner 复用的 cost/latency attribute 规范
- [ADR-009 Config Cascade](./adr-009-config-cascade.md) — `benchmarks.*` namespace 同步修订
- [ADR-005 Memory Contracts](./adr-005-memory-contracts.md) — Memory 降级（per-task working set 不进 4 层）
- 历史参考：commit `2bb25d7` E1-a + `1298f3d` E1-b 的 dataset / task-loader 设计（已 revert，但 sha256 manifest / iterator / takeFirstN 的接口形态值得借鉴）
