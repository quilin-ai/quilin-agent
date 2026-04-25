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
3. **Workspace guard / egress 边界**：benchmark 跑大量公开 dataset task，E1 用 best-effort workspace guard + 网络白名单降低意外污染风险；恶意 task 的 hard isolation 不由 lexical guard 承诺，DockerSandbox 提前到 E2 作为 gate。
4. **Cache 完整性**：dataset fetch 一次几百 MB，必须 sha256 manifest verify on load；旧 E1-a 已有此设计，本 ADR 把它升级为通用 cache 协议。

---

## 3. Decision

### 3.1 Task wire schema（跨 leaderboard 通用）

冻结 TS interface（zod schema 在 `benchmarks/src/wire/task.ts`）：

```
BenchmarkTask {
  task_id: string                 // 跨 leaderboard 唯一
  dataset: string                 // "swe-bench-lite" / "swe-bench-verified"
  inputs: Record<string, unknown> // leaderboard-specific 输入
  expected: Record<string, unknown> // leaderboard-specific 预期（scorer 用）
  scorer_type: string             // "patch-apply" / "exact-match" / "tool-call" / ...
  token_budget?: number           // 可选；缺省按 dataset 默认
  metadata?: Record<string, unknown>
}
```

`inputs` / `expected` 字段保持 leaderboard-specific，但顶层 `task_id` / `dataset` / `scorer_type` 必须冻结，scorer 与 runner 通过这些字段路由。
Iter E1/E2 接受 `swe-bench-lite` / `swe-bench-verified`；**Iter E3（2026-04-26 修订）扩展为 `swe-bench-lite | swe-bench-verified | gaia | bfcl-v4`**，zod literal union 严格对齐这四个值；新增 leaderboard 仍须修订本 ADR 并扩展 zod enum，不允许 ad-hoc string。

新增两个 dataset 的字段约束：

- `gaia`：`inputs.{question, level, file_name?, file_path?, file_attachments?}`；`expected.{final_answer, eval_metadata}`；`scorer_type = "gaia-exact-match"`。`file_path` 必须是 Docker/container 视角路径（当前 `/workspace/cache/datasets/gaia/attachments/<file>`），不得暴露 host 绝对路径。`file_attachments[]` 元素冻结为 `{container_path, file_name, file_path, sha256, size_bytes}`；禁止包含 `host_path` / `file_host_path` / `relative_path` 等 host filesystem 细节。
- `bfcl-v4`：`inputs.{prompt, candidate_functions, multi_turn?}`；`expected.{ground_truth_calls}`；`scorer_type = "bfcl-tool-call-match"`

每个新 dataset 由独立 scorer + submission adapter 实现；runner 5 阶段生命周期 + DockerSandbox MVP DI 不变。

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

- `manifest.json`：`{ schema_version: 1, dataset, fetched_at, rows: number, requested_max_rows: number | null, sha256: string, source_url: string, data_file: string }`
- 数据文件（jsonl 或原始格式）+ sha256 哈希进 manifest
- **Load 时强制 verify**：sha256 不匹配 / `schema_version != 1` 直接拒载并报 `CacheError`
- Fetch 时分页 + retry；幂等：相同 source_url 已有合法 manifest 且 `requested_max_rows` 能覆盖当前请求时跳过。`requested_max_rows: null` 表示 full fetch；partial cache 不能满足 full fetch intent。
- 兼容性：E2 之前写出的 legacy manifest 若缺少 `requested_max_rows`，loader 归一化为 `null`；fetch CLI 的 cache hit 判断仍按当前 intent 重新校验 rows/sha/source，legacy partial 不能满足 full fetch intent。

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

#### Submission format 选择

SWE-bench 本地 harness 的 prediction 文件使用 JSONL，每行包含 `{instance_id, model_name_or_path, model_patch}`。`sb-cli submit` 上传路径当前使用 JSON dict/list 形态；E2 接入官方上传时必须按实际 submit 入口选择独立 adapter。本 ADR 的 `swe-bench-verified-jsonl` 只声明本地 harness prediction adapter，不声明最终上传包格式。

### 3.7 Best-effort Workspace Guard / Egress 边界

本 Iter E1 的 runner 只承诺 **best-effort workspace guard**，不承诺 hard sandbox。原因是 shell command 的真实文件系统影响无法通过 lexical token parser 完整证明：重定向、命令替换、环境变量展开、glob、tool-specific URL/path 语义都会绕过单纯字符串检查。E1 threat model 是防止开发者或 benchmark task **意外污染主仓库 / 用户主目录 / 系统路径**，不是防御恶意 task。

本 Iter E1：

- **文件系统**：per-task scratchpad（Iter D Boyle）+ tmpdir（cwd containment）；禁止 task 写 `~`、`/etc`、`/var`、master 工作树以外的路径
- **网络**：白名单仅 dataset endpoint（Hugging Face datasets-server / 各 leaderboard 官方）+ LLM provider endpoint；禁止任意 outbound
- **shell exec**：复用 Iter B 的 shell-exec 工具；CRITICAL 保持 confirm（不因 benchmark 自动放开）
- **DockerSandbox**：提前到 Iter E2 作为 hard isolation gate；E2 Day 0 先冻结 MVP 契约（workspace mount / network policy / timeout / resource limits / artifact export / LLM-API egress 白名单 / CI 可行性）

E1 实施边界：在 DockerSandbox / OS namespace 不存在时，runner 只接受显式注入的 agent runner，并对注入到 runner config 的工具做 best-effort workspace guard 包装；`shell_exec` 默认 cwd 强制为 per-task tmpdir，明显 path-like 参数、`file://` 本地 URL、常见 redirect-attached path token 必须落在 workspace 内。网络侧使用 runner 作用域内的 fetch guard 执行 whitelist。任何绕过注入工具 / fetch guard 的 benchmark runner 都视为不合规，不能注册进正式 leaderboard run。

E1 的 best-effort guard 回归（例如已覆盖的绝对路径、`..`、workspace symlink escape、`file://`、常见 redirect path 又被放行）视为 BLOCKING，必须停 run 不计分。未覆盖的 shell 语义不再作为 E1 收口 blocker；它们必须由 E2 DockerSandbox gate 解决。官方 leaderboard / untrusted task 的 hard isolation 不能依赖 E1 lexical guard。

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
