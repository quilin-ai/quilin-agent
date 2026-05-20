# 记忆空闲任务消费者视图 / Memory Idle Job Consumer View

> Status: memory-specific companion to the core idle scheduler design. The scheduler-level decision, candidate comparison, and cross-domain job contract live in [`docs/00-core-loop/idle-scheduler-design.md`](../00-core-loop/idle-scheduler-design.md).
>
> 状态：core idle scheduler 设计的记忆侧配套文档。调度器级决策、候选方案对比和跨域 job 合同见 [`docs/00-core-loop/idle-scheduler-design.md`](../00-core-loop/idle-scheduler-design.md)。

> Scope: this document defines how memory jobs behave when invoked by the global idle scheduler. It does not decide scheduler placement, does not create a new memory architecture, and does not redefine Reflector or Consolidator contracts.
>
> 范围：本文定义 memory jobs 被全局 idle scheduler 调用时应如何表现。它不决定 scheduler 放在哪里，不创建新的 memory 架构，也不重新定义 Reflector 或 Consolidator 契约。

## 角色定位 / Role

Memory is a consumer of the global idle scheduler. The scheduler owns timing, leases, retries, and cross-domain budget; `quilin-mem` owns memory semantics and exposes job handlers or MCP tools that execute memory-specific work.

Memory 是全局 idle scheduler 的消费者。scheduler 拥有 timing、leases、retries 和跨域 budget；`quilin-mem` 拥有 memory semantics，并暴露 job handlers 或 MCP tools 来执行 memory-specific work。

This split prevents `quilin-mem` from becoming the global background service while still keeping memory logic close to the Python store, observer, reflector, and consolidator implementations.

这种切分避免 `quilin-mem` 变成全局后台服务，同时仍让 memory logic 靠近 Python store、observer、reflector 和 consolidator 实现。

## 记忆任务清单 / Memory Job Inventory

The L3a Observer proactive job replays or drains memory inputs that were not observed during the normal per-turn `memory_observe` path. It must reuse `L3aObserver` and `ProfileUpdater`; it must not add a second observer implementation.

L3a Observer 主动 job 负责 replay 或 drain 正常每轮 `memory_observe` 路径未观察到的 memory inputs。它必须复用 `L3aObserver` 和 `ProfileUpdater`，不得新增第二套 observer 实现。

The Reflector job proposes semantic insights from recent episodic records. It must call `Reflector.propose(..., trigger="idle", task_outcome="unknown")` and preserve the existing trigger literal set: `task_complete`, `task_fail`, `discard_all`, `interval_turns`, and `idle`.

Reflector job 从近期 episodic records 中提议 semantic insights。它必须调用 `Reflector.propose(..., trigger="idle", task_outcome="unknown")`，并保持现有 trigger 字面值集合：`task_complete`、`task_fail`、`discard_all`、`interval_turns` 和 `idle`。

The Consolidator job calls `Consolidator.auto_schedule(interval_hours=...)`. `auto_schedule()` remains the memory-domain scheduling API; the global scheduler only decides whether this job receives a run slot.

Consolidator job 调用 `Consolidator.auto_schedule(interval_hours=...)`。`auto_schedule()` 仍是 memory-domain scheduling API；全局 scheduler 只决定该 job 是否获得一次 run slot。

Future memory jobs such as KG prune execution or verbatim recompression may be registered later, but they must reuse Consolidator strategy semantics rather than adding standalone helpers.

未来 memory jobs（例如 KG prune execution 或 verbatim recompression）可以后续注册，但必须复用 Consolidator strategy 语义，而不是新增 standalone helpers。

## 调用合同 / Invocation Contract

The scheduler invokes memory jobs with a run id, deadline, abort signal, budget lease, and WriteAuthority client. The memory handler returns a structured result containing status, summary, metrics, and proposal artifacts.

scheduler 调用 memory jobs 时应提供 run id、deadline、abort signal、budget lease 和 WriteAuthority client。memory handler 返回结构化 result，包含 status、summary、metrics 和 proposal artifacts。

The memory handler should use the same `QuilinMemStore` configuration as normal MCP tools. It may open its own short-lived store for the job, or use a provider-managed store, but it must not assume process-local state survives daemon restart.

memory handler 应使用与普通 MCP tools 相同的 `QuilinMemStore` 配置。它可以为 job 打开短生命周期 store，也可以使用 provider-managed store，但不得假设进程本地状态能跨 daemon restart 存活。

Any cursor needed for proactive Observer replay must be durable. Process-local cursors are acceptable only for cache hints, never as the source of truth for which records were already processed.

主动 Observer replay 需要的任何 cursor 都必须 durable。进程本地 cursor 只适合作为 cache hints，不能作为“哪些 records 已经处理过”的真源。

## 预算行为 / Budget Behavior

Memory jobs that can spend model tokens must respect the scheduler-provided budget lease before calling LLMs or expensive pairwise judges. If no lease is granted, the expensive part of the job is skipped.

可能消耗模型 token 的 memory jobs 必须在调用 LLM 或昂贵 pairwise judges 前遵守 scheduler 提供的 budget lease。如果没有获得 lease，job 的昂贵部分应被跳过。

A budget-denied memory run is `skipped`, not `failed`. It should emit metrics such as records scanned, proposals omitted, and budget reason so the global idle timeline explains why no memory work happened.

预算拒绝的 memory run 是 `skipped`，不是 `failed`。它应输出 metrics，例如 records scanned、proposals omitted 和 budget reason，让全局 idle timeline 能解释为什么没有执行 memory work。

User-triggered tools such as `memory_consolidate_plan` may use a different budget policy because explicit user requests are not the same as background idle work.

用户主动触发的 tools（例如 `memory_consolidate_plan`）可以使用不同预算策略，因为显式用户请求不等同于后台 idle work。

## 批量 LLM Judge / Batch LLM Judge

Consolidator dedupe should prefer batch LLM judging over per-pair judging when the input fits the configured limits. `deepseek-v4-flash` has a 128K context window, and typical Chinese short memory records average about 50-100 tokens, so a 10K input slot can hold roughly 80-150 records.

Consolidator dedupe 在输入符合配置上限时，应优先使用 batch LLM judge，而不是 per-pair judge。`deepseek-v4-flash` 拥有 128K context window，典型中文短记忆平均约 50-100 tokens，因此 10K input slot 大约可容纳 80-150 条 records。

The current 9-record user case should fit into one batch call and finish in roughly 3-5 seconds. The per-pair path has 36 pairs for 9 records; at about 2.5 seconds per pair, that is about 90 seconds and exceeds a 30-second MCP timeout. Batch judging is therefore expected to be about 20x faster for this class of case.

当前 9 条记录的 user case 应能放进 1 次 batch call，并在约 3-5 秒内完成。per-pair 路径对 9 条记录有 36 对；按每对约 2.5 秒计算，约 90 秒，会超过 30 秒 MCP timeout。因此对这类 case，batch judge 预期约有 20x 提速。

The default configuration should be:

默认配置应为：

```bash
QUILIN_DEDUPE_BATCH_MAX_TOKENS=10000
QUILIN_DEDUPE_BATCH_MAX_RECORDS=150
```

If `records <= 150` and estimated total tokens are `<= 10_000`, Consolidator should make one batch LLM call. Otherwise, it should split records into batches that each stay below both limits.

如果 `records <= 150` 且估算总 tokens `<= 10_000`，Consolidator 应执行 1 次 batch LLM call。否则，应把 records 分批，保证每批同时低于两个上限。

The batch judge should return all clusters in one structured JSON response instead of returning one verdict per pair:

batch judge 应在一次结构化 JSON response 中返回全部 clusters，而不是为每一对返回一个 verdict：

```json
{
  "clusters": [
    {
      "keepId": "uuid",
      "deleteIds": ["uuid"],
      "reason": "newer user-name memory supersedes older alias"
    }
  ]
}
```

Invalid JSON should fall back to the current per-pair path. A batch timeout, with a recommended 60-second limit, should also fall back to per-pair. If the LLM API is unavailable, Consolidator should fall back to exact-only dedupe.

invalid JSON 应 fallback 到当前 per-pair 路径。batch timeout（建议 60 秒上限）也应 fallback 到 per-pair。如果 LLM API 不可用，Consolidator 应 fallback 到 exact-only dedupe。

This is an internal Consolidator algorithm replacement. The consumer-facing `memory_consolidate_plan` MCP tool wire shape must not change, and callers should still receive the existing dedupe group metadata.

这是 Consolidator 内部算法替换。consumer-facing `memory_consolidate_plan` MCP tool wire shape 不得改变，调用方仍应收到现有 dedupe group metadata。

Batch LLM judging must use the shared idle scheduler budget pool when running as an idle job. User-triggered consolidation may use the user-triggered budget policy, but it should still report estimated and actual token use for accounting.

batch LLM judge 在作为 idle job 运行时必须使用共享 idle scheduler budget pool。用户主动触发的 consolidation 可以使用 user-triggered budget policy，但仍应上报 estimated 和 actual token use 供核算。

## 写入权限 / WriteAuthority

Reflector insight commit remains gated inside `Reflector.commit_insight(...)` with `origin:"idle"`. A memory idle handler that commits reflection insights must call that method and pass the scheduler-provided WriteAuthority client.

Reflector insight commit 仍在 `Reflector.commit_insight(...)` 内部用 `origin:"idle"` 接 gate。执行 commit 的 memory idle handler 必须调用该方法，并传入 scheduler 提供的 WriteAuthority client。

Consolidator proposals are dry-run today. If a future job performs true batch deletion or soft deletion, the batch executor must ask WriteAuthority before mutating records, and a denial must skip the whole batch.

Consolidator 目前只产 dry-run proposal。如果未来 job 执行真实批量删除或 soft deletion，batch executor 必须在修改 records 前询问 WriteAuthority，且一次拒绝必须跳过整个 batch。

If WriteAuthority is unavailable, memory jobs degrade to proposal-only or skipped writes. They must not silently allow background mutation.

如果 WriteAuthority 不可用，memory jobs 应降级为 proposal-only 或跳过写入。它们不得静默允许后台 mutation。

## 日志与结果 / Logs And Results

Memory handlers should return machine-readable artifacts: reflection proposals, dedupe groups, KG prune candidates, recompression candidates, and skipped-write reasons.

memory handlers 应返回机器可读 artifacts：reflection proposals、dedupe groups、KG prune candidates、recompression candidates 和 skipped-write reasons。

Logs should include `run_id`, `job_id`, `memory_store_id` or database path hash, `records_scanned`, `proposal_count`, `budget_decision`, `write_decision`, and `duration_ms`. Secrets, raw API keys, and full private memory content should not be logged.

日志应包含 `run_id`、`job_id`、`memory_store_id` 或数据库路径 hash、`records_scanned`、`proposal_count`、`budget_decision`、`write_decision` 和 `duration_ms`。不得记录 secrets、raw API keys 或完整私密记忆内容。

The WebUI report should read these artifacts through the global idle scheduler history rather than scraping provider stderr.

WebUI report 应通过全局 idle scheduler history 读取这些 artifacts，而不是抓取 provider stderr。

## 与 03-memory 契约对齐 / Alignment With 03-Memory Contracts

The Reflector contract remains singular: module `reflector.py`, class `Reflector`, default `reflect_model="claude-sonnet-4-6"`, and maximum episodic input `N=10`.

Reflector 契约保持单数：模块 `reflector.py`、class `Reflector`、默认 `reflect_model="claude-sonnet-4-6"`，以及 episodic 输入上限 `N=10`。

The Consolidator contract remains `Consolidator.propose(...)` and `Consolidator.auto_schedule(...)`, with strategy values `dedupe`, `reflect`, `kg-prune`, and `all`.

Consolidator 契约保持为 `Consolidator.propose(...)` 和 `Consolidator.auto_schedule(...)`，strategy 值为 `dedupe`、`reflect`、`kg-prune` 和 `all`。

Skill body creation is not in memory scope. Memory Layer 4 may keep usage counters and suggestions, but SKILL.md files remain owned by `docs/13-skills` and written through `skill_manage`.

skill body creation 不在 memory scope 内。Memory Layer 4 可以保留 usage counters 和 suggestions，但 SKILL.md 文件仍归 `docs/13-skills` 所有，并通过 `skill_manage` 写入。

## 记忆侧验收 / Memory-Side Acceptance

Tests should prove that Reflector idle invocation uses `trigger="idle"` and caps episodic input at 10.

测试应证明 Reflector idle invocation 使用 `trigger="idle"`，并把 episodic 输入限制在 10 条以内。

Tests should prove that Consolidator idle invocation goes through `Consolidator.auto_schedule(...)` and does not execute ungated deletes.

测试应证明 Consolidator idle invocation 走 `Consolidator.auto_schedule(...)`，且不执行未过 gate 的删除。

Tests should use temporary stores, fake budgets, fake WriteAuthority, and fake LLMs. They must not touch real `~/.quilin`, real model APIs, or web application files.

测试应使用 temporary stores、fake budgets、fake WriteAuthority 和 fake LLMs。它们不得触碰真实 `~/.quilin`、真实模型 API 或 web application files。

The global scheduler tests live with the core-loop implementation; this document only defines memory job behavior that those tests can assert through handler fakes or MCP calls.

全局 scheduler 测试随 core-loop 实现放置；本文只定义 memory job behavior，供那些测试通过 handler fakes 或 MCP calls 断言。
