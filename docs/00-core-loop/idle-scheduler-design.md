# 空闲调度器设计 / Idle Scheduler Design

> Status: architecture review spec for QUI-188. The user question is whether Quilin needs a broader idle scheduler, not whether `quilin-mem` alone should start an asyncio timer.
>
> 状态：QUI-188 架构评审规格。用户的问题是 Quilin 是否需要更广义的 idle scheduler，而不是 `quilin-mem` 是否单独启动 asyncio timer。

> Recommendation: introduce a separate `quilin-daemon` process as the global idle scheduler and control-plane worker. It should not be a second agent loop; it should own scheduling, leases, budget accounting, retries, observability, and WriteAuthority orchestration, while actual domain work remains in the existing component APIs.
>
> 推荐方案：引入独立 `quilin-daemon` 进程作为全局 idle scheduler 和 control-plane worker。它不应成为第二个 agent loop；它只负责调度、lease、预算核算、重试、可观测性和 WriteAuthority 编排，实际领域工作仍留在现有组件 API 内。

## 问题定义 / Problem Statement

Idle work is no longer memory-only. The system already has or plans several background activities: memory observation, reflection, consolidation, scaffold proposal generation, user insight mining, skill expansion, budget monitoring, and future replay or benchmark schedules.

Idle work 已经不只是 memory-only。系统已有或计划了多类后台活动：memory observation、reflection、consolidation、scaffold proposal generation、user insight mining、skill expansion、budget monitoring，以及未来 replay 或 benchmark schedules。

Putting all of these inside `quilin-mem` would make a memory provider responsible for global product behavior. Putting all of them inside the chat loop would bind long-running idle failures to the user-facing conversation path. The scheduler must therefore be a cross-domain runtime primitive.

把这些都放进 `quilin-mem` 会让 memory provider 承担全局产品行为。把这些都放进 chat loop 会把长时间 idle failure 绑到用户可见的对话路径。因此 scheduler 必须是跨域 runtime primitive。

## 覆盖任务清单 / Job Inventory

The initial job inventory should include L3a Observer proactive replay, Reflector idle proposals, and Consolidator auto-schedule from `docs/03-memory`.

首批 job inventory 应包括 `docs/03-memory` 中的 L3a Observer 主动 replay、Reflector idle proposals 和 Consolidator auto-schedule。

It should also include self-evolution scaffold patch proposal generation, User Insight Engine pattern mining, and skill background nudge or expansion from `docs/10-self-evolution` and `docs/13-skills`.

它还应包括 `docs/10-self-evolution` 与 `docs/13-skills` 中的 self-evolution scaffold patch proposal generation、User Insight Engine pattern mining，以及 skill background nudge 或 expansion。

Install-time skill import from `docs/16-soul-import` is not an idle loop, but the same scheduler can later own post-install follow-up jobs such as delayed scan verification, imported skill health checks, or migration retry. The install-time write path itself remains `origin:"install"`, not `origin:"idle"`.

`docs/16-soul-import` 的 install-time skill import 不是 idle loop，但同一个 scheduler 后续可以负责 post-install follow-up jobs，例如延迟扫描验证、已导入 skill health check 或 migration retry。install-time 写入路径本身仍是 `origin:"install"`，不是 `origin:"idle"`。

Token budget monitoring should be a first-class job because every other idle job depends on budget state. It should refresh daily/monthly usage, detect exhausted budgets, emit warnings, and block new leases when limits are reached.

token budget 监控应成为一等 job，因为所有其他 idle job 都依赖预算状态。它应刷新日/月用量、检测预算耗尽、输出 warning，并在达到限制时阻止新的 lease。

Memory dedupe batch LLM judging should share the same idle budget pool. The algorithm belongs to `docs/03-memory`, but the scheduler owns its lease, timeout, and global token accounting through settings such as `QUILIN_DEDUPE_BATCH_MAX_TOKENS` and `QUILIN_DEDUPE_BATCH_MAX_RECORDS`.

Memory dedupe batch LLM judge 应共享同一个 idle budget pool。算法属于 `docs/03-memory`，但 scheduler 通过 `QUILIN_DEDUPE_BATCH_MAX_TOKENS` 与 `QUILIN_DEDUPE_BATCH_MAX_RECORDS` 等设置拥有 lease、timeout 和全局 token accounting。

Future jobs may include idle-time dream replay, trajectory replay, project health checks, or benchmark schedules. Benchmark remains frozen unless explicitly reactivated, so the scheduler contract may support it but must not add benchmark work by default.

未来 job 可以包括 idle-time dream replay、trajectory replay、project health checks 或 benchmark schedules。Benchmark 仍是 frozen，除非用户明确重新启用；因此 scheduler contract 可以支持它，但不得默认新增 benchmark 工作。

## 候选方案 / Candidate Options

Option A is a new `quilin-daemon` independent process managed by `launchd`, `pm2`, `systemd`, or the local `just start` stack. It owns scheduling and calls component APIs over MCP or internal control-plane APIs.

方案 A 是新增独立 `quilin-daemon` 进程，由 `launchd`、`pm2`、`systemd` 或本地 `just start` stack 管理。它拥有调度，并通过 MCP 或内部 control-plane API 调用组件。

Option B is distributed background tasks inside each MCP server: `quilin-mem` starts memory loops, a future evolution server starts self-evolution loops, and a skill server starts skill loops.

方案 B 是把 background task 分散放进各 MCP server：`quilin-mem` 启动 memory loops，未来 evolution server 启动 self-evolution loops，skill server 启动 skill loops。

Option C is an idle scheduler module inside `packages/agent-core`, sharing the agent-core or web lifecycle and calling providers from there.

方案 C 是在 `packages/agent-core` 内新增 idle scheduler module，共享 agent-core 或 web 生命周期，并从那里调用 providers。

## 对比矩阵 / Comparison Matrix

| Dimension | A. `quilin-daemon` independent process | B. Distributed MCP server tasks | C. agent-core idle scheduler |
|---|---|---|---|
| Failure radius | Best isolation: daemon crash does not take down chat, web, or MCP providers. | Poor: provider-local loops can degrade provider request handling. | Medium-to-poor: scheduler bug shares lifecycle with conversation runtime or web server. |
| Cross-language | Clean: scheduler is orchestration-only and calls TS/Python/Rust handlers through APIs. | Fragmented: each language reinvents scheduling, lease, and retry semantics. | TS-native for scaffold and skills, but Python memory jobs still cross process boundaries. |
| Deployment | Clear service unit; can start after config and before/after providers with health checks. | Hidden inside providers; hard to know which loop is alive. | Easy in dev, risky in web/serverless or hot reload contexts. |
| Observability | One `idle.run.*` event stream, durable run table, OTel correlation, WebUI timeline. | Logs and metrics scattered across providers. | Good access to TS telemetry, weaker process isolation and restart semantics. |
| Dev/prod parity | Strong if `just start` launches daemon and prod uses the same process role. | Weak: local provider restarts alter idle behavior unexpectedly. | Weak when Next.js or agent-core hot reload restarts scheduler frequently. |
| Restart/upgrade | Durable leases can mark expired running jobs and resume or skip deterministically. | Each provider needs its own lease recovery. | In-flight jobs mix with chat/session process epoch. |
| WriteAuthority | Centralizes `origin:"idle"` gate orchestration before component mutation. | Each provider must learn how to reach WriteAuthority. | Has easiest direct TS access to WriteAuthority but couples gate availability to chat runtime. |
| Implementation cost | Highest initial plumbing, lowest long-term drift. | Lowest first patch, highest drift and duplicate semantics. | Medium initial cost, but risks another lifecycle tangle. |

| 维度 | A. `quilin-daemon` 独立进程 | B. 分散 MCP server tasks | C. agent-core idle scheduler |
|---|---|---|---|
| 失败半径 | 隔离最好：daemon 崩溃不拖垮 chat、web 或 MCP providers。 | 较差：provider 本地 loop 可能影响 provider 请求处理。 | 中到较差：scheduler bug 与对话 runtime 或 web server 共生命周期。 |
| 跨语言 | 干净：scheduler 只做编排，通过 API 调 TS/Python/Rust handlers。 | 碎片化：每种语言重复发明 scheduling、lease 和 retry 语义。 | scaffold 和 skills 对 TS 友好，但 Python memory jobs 仍需跨进程。 |
| 部署 | 服务单元清晰；可配 health check，按配置在 providers 前后启动。 | 隐藏在 provider 内，很难判断哪个 loop 活着。 | dev 容易，但 web/serverless 或 hot reload 场景风险高。 |
| 可观测 | 单一 `idle.run.*` event stream、durable run table、OTel correlation、WebUI timeline。 | logs 和 metrics 分散到各 provider。 | TS telemetry 接入方便，但进程隔离和重启语义较弱。 |
| dev/prod 一致 | 如果 `just start` 和 prod 都启动同一 daemon role，一致性强。 | 弱：本地 provider restart 会意外改变 idle 行为。 | 弱：Next.js 或 agent-core hot reload 会频繁重启 scheduler。 |
| 重启/升级 | durable lease 可把过期 running jobs 标记并确定性 resume 或 skip。 | 每个 provider 都要实现自己的 lease recovery。 | in-flight jobs 与 chat/session process epoch 混在一起。 |
| WriteAuthority | 集中编排 `origin:"idle"` gate，再进入组件 mutation。 | 每个 provider 都要学会如何访问 WriteAuthority。 | 最容易直接访问 TS WriteAuthority，但 gate 可用性绑定 chat runtime。 |
| 实现成本 | 初始 plumbing 最高，长期漂移最低。 | 首 patch 最低，长期语义重复和漂移最高。 | 初始成本中等，但容易形成新的生命周期缠绕。 |

## 推荐方案 / Recommendation

My independent view is that Option A is the right target: create `quilin-daemon` as a small independent scheduler/control-plane worker. It should be deliberately boring: no model loop, no planning loop, no new memory logic, no direct scaffold patch application.

My independent view is：方案 A 是正确目标，即创建小型独立 `quilin-daemon`，定位为 scheduler/control-plane worker。它应刻意保持朴素：没有模型 loop，没有 planning loop，没有新的 memory logic，也不直接应用 scaffold patch。

The reason is failure isolation plus scope control. Idle work is inherently cross-domain and long-running; tying it to chat makes the user-facing path fragile, while scattering it across providers repeats scheduling semantics and makes audits harder.

理由是失败隔离和 scope control。Idle work 天然跨域且长时间运行；把它绑到 chat 会让用户可见路径变脆，把它分散到 providers 又会重复调度语义并提高审计难度。

The near-term implementation should still be conservative. `quilin-daemon` should call existing MCP tools or component job handlers, and every job should remain disabled by default. The scheduler owns when and whether to run; component domains own what a run means.

近期实现仍应保守。`quilin-daemon` 应调用现有 MCP tools 或 component job handlers，且每个 job 默认关闭。scheduler 拥有“何时、是否运行”；组件领域拥有“一次运行意味着什么”。

Option C can be a transitional harness only for unit tests or local experiments, not the production architecture. Option B should be avoided except for short-lived provider-local maintenance that has no tokens, no writes, and no cross-domain coordination.

方案 C 可以作为单元测试或本地实验的过渡 harness，但不应成为生产架构。方案 B 应避免使用，除非是无 token、无写入、无跨域协调的短生命周期 provider-local maintenance。

## 任务注册接口 / Job Registration Interface

The scheduler core should be plugin-like. Adding a future job should register a descriptor and handler, not edit the scheduler loop.

scheduler core 应是 plugin-like。未来新增 job 应注册 descriptor 和 handler，而不是修改 scheduler loop。

```ts
interface IdleJob {
  id: string;
  interval: { kind: "cron" | "tick"; spec: string };
  budget: { tokens: number; costUsd: number };
  run(ctx: JobContext): Promise<JobResult>;
}

interface JobContext {
  runId: string;
  now: Date;
  signal: AbortSignal;
  budgetLease: BudgetLease;
  writeAuthority: WriteAuthorityClient;
  logger: IdleLogger;
  trace: IdleTraceContext;
  config: IdleJobConfig;
}

interface JobResult {
  status: "completed" | "skipped" | "failed";
  summary: string;
  metrics?: Record<string, number>;
  artifacts?: readonly IdleArtifact[];
}
```

`IdleJob.id` must be globally stable, for example `memory.l3a_observer`, `memory.reflector`, `memory.consolidator`, `self_evolution.scaffold_propose`, `self_evolution.user_insight_mine`, `skills.background_nudge`, and `budget.monitor`.

`IdleJob.id` 必须全局稳定，例如 `memory.l3a_observer`、`memory.reflector`、`memory.consolidator`、`self_evolution.scaffold_propose`、`self_evolution.user_insight_mine`、`skills.background_nudge` 和 `budget.monitor`。

The descriptor is owned by the domain package, but the scheduler owns registration, lease acquisition, timeout, retry, and telemetry. Domain handlers should be idempotent or lease-aware.

descriptor 由领域 package 拥有，但 scheduler 拥有注册、lease acquisition、timeout、retry 和 telemetry。领域 handler 应是幂等的，或至少 lease-aware。

## 状态与租约 / State And Leases

The daemon needs a durable job table. Minimum fields are `job_id`, `run_id`, `status`, `scheduled_at`, `started_at`, `finished_at`, `lease_expires_at`, `attempt`, `budget_tokens_reserved`, `budget_cost_reserved_usd`, and `last_error`.

daemon 需要 durable job table。最小字段包括 `job_id`、`run_id`、`status`、`scheduled_at`、`started_at`、`finished_at`、`lease_expires_at`、`attempt`、`budget_tokens_reserved`、`budget_cost_reserved_usd` 和 `last_error`。

On startup, the daemon should mark expired `running` jobs as `failed` or `abandoned` before scheduling new work. Jobs that are explicitly resumable may requeue themselves with a new `run_id`; non-resumable jobs should be skipped until the next interval.

启动时，daemon 应先把过期的 `running` jobs 标记为 `failed` 或 `abandoned`，再调度新工作。显式可恢复的 job 可以用新的 `run_id` 重新入队；不可恢复的 job 应跳过，直到下一个 interval。

The scheduler must support singleton jobs by default. A job should not run concurrently with itself unless its descriptor explicitly declares sharding or concurrency.

scheduler 默认应支持 singleton jobs。同一个 job 不应并发运行多个实例，除非 descriptor 显式声明 sharding 或 concurrency。

## 预算策略 / Budget Policy

Idle budget is a shared resource across memory, self-evolution, skills, and insight mining. The budget monitor job refreshes usage, while each job run acquires a lease before model calls or paid external work.

Idle budget 是 memory、self-evolution、skills 和 insight mining 共享的资源。budget monitor job 负责刷新 usage；每个 job run 在模型调用或付费外部工作前获取 lease。

A budget lease should reserve both tokens and estimated cost. If the job finishes under budget, the unused reservation is released; if it exceeds the estimate, the overage is recorded and future scheduling becomes more conservative.

budget lease 应同时预留 tokens 和 estimated cost。如果 job 低于预算完成，未使用额度释放；如果超过估算，记录 overage，并让后续调度更保守。

Denied budget means `skipped`, not `failed`. A skipped run should emit an audit event and set `next_run_at` according to policy, usually after the next budget refresh or normal interval.

预算拒绝意味着 `skipped`，不是 `failed`。被跳过的 run 应输出 audit event，并按策略设置 `next_run_at`，通常在下一次预算刷新或正常 interval 后再试。

## WriteAuthority Gate

Every idle-origin write must use WriteAuthority with `origin:"idle"`. The daemon may centralize the call, but component handlers must still keep their own domain gates where the existing docs require them.

每个 idle-origin 写入都必须使用 `origin:"idle"` 的 WriteAuthority。daemon 可以集中调用，但当现有 docs 要求组件内部 gate 时，component handlers 仍必须保留自己的领域 gate。

For memory, Reflector commit stays inside `Reflector.commit_insight(...)`; Consolidator true delete must gate the batch before mutation. For self-evolution, scaffold proposals and proposal append semantics stay aligned with `docs/10-self-evolution`. For skills, writes must still go through `skill_manage` and 13-skills validation.

对 memory，Reflector commit 仍留在 `Reflector.commit_insight(...)` 内；Consolidator 真实删除必须在 mutation 前对 batch 过 gate。对 self-evolution，scaffold proposals 和 proposal append 语义仍对齐 `docs/10-self-evolution`。对 skills，写入仍必须经过 `skill_manage` 和 13-skills validation。

If WriteAuthority is unavailable, write-capable jobs must degrade to proposal-only or skip. They must not silently allow writes because the daemon is running in the background.

如果 WriteAuthority 不可用，具备写入能力的 jobs 必须降级为 proposal-only 或 skip。它们不得因为 daemon 在后台运行就静默 allow writes。

## 可观测性 / Observability

The daemon should emit a common event vocabulary: `idle.run.scheduled`, `idle.run.started`, `idle.run.completed`, `idle.run.skipped`, `idle.run.failed`, `idle.budget.lease_granted`, `idle.budget.lease_denied`, and `idle.write_authority.decision`.

daemon 应输出统一事件词汇：`idle.run.scheduled`、`idle.run.started`、`idle.run.completed`、`idle.run.skipped`、`idle.run.failed`、`idle.budget.lease_granted`、`idle.budget.lease_denied` 和 `idle.write_authority.decision`。

Every event should carry `run_id`, `job_id`, `component`, `origin:"idle"`, `attempt`, `duration_ms`, `budget_tokens`, `budget_cost_usd`, `decision`, and a trace correlation id when available.

每个事件都应携带 `run_id`、`job_id`、`component`、`origin:"idle"`、`attempt`、`duration_ms`、`budget_tokens`、`budget_cost_usd`、`decision`，以及可用时的 trace correlation id。

The WebUI dashboard can render the daemon run table as an idle activity timeline. The next-session report-back in `docs/10-self-evolution` should read from this same durable history instead of scraping logs.

WebUI dashboard 可以把 daemon run table 渲染成 idle activity timeline。`docs/10-self-evolution` 中的 next-session report-back 应读取同一份 durable history，而不是抓取 logs。

## 配置面 / Configuration Surface

The global switch should be `idle.enabled=false`. Domain switches should be separate: `idle.memory.enabled`, `idle.self_evolution.enabled`, `idle.user_insight.enabled`, `idle.skills.enabled`, and `idle.budget_monitor.enabled`.

全局开关应为 `idle.enabled=false`。领域开关应分开：`idle.memory.enabled`、`idle.self_evolution.enabled`、`idle.user_insight.enabled`、`idle.skills.enabled` 和 `idle.budget_monitor.enabled`。

Each job should have interval, max runtime, budget, and retry configuration. Environment variables can exist for local development, but the durable user config should be the source of truth.

每个 job 都应有 interval、max runtime、budget 和 retry configuration。环境变量可以用于本地开发，但持久化 user config 应是真源。

Default-off is mandatory. Enabling `idle.memory.enabled` must not enable scaffold self-evolution, and enabling `idle.self_evolution.enabled` must not enable memory deletion or skill writes.

默认关闭是强制要求。启用 `idle.memory.enabled` 不得启用 scaffold self-evolution；启用 `idle.self_evolution.enabled` 也不得启用 memory deletion 或 skill writes。

## 失败与重试 / Failure And Retry

Job failure should be contained to the run. The daemon records failure, releases or finalizes the budget lease, computes backoff, and continues running other jobs.

job failure 应限制在本次 run 内。daemon 记录失败、释放或结算 budget lease、计算 backoff，并继续运行其他 jobs。

Retries should use exponential backoff with jitter and a per-job cap. Permanent validation failures, missing credentials, disabled config, and budget denial should not burn retry loops.

重试应使用带 jitter 的指数退避，并有 per-job cap。永久性 validation failures、缺少 credentials、disabled config 和 budget denial 不应消耗 retry loops。

Handlers must receive an `AbortSignal` and honor shutdown promptly. Long model calls or MCP calls should have explicit timeouts so in-flight jobs can be marked deterministically during shutdown.

handlers 必须收到 `AbortSignal` 并快速响应 shutdown。长时间模型调用或 MCP 调用应有显式 timeout，让 in-flight jobs 在 shutdown 时可以被确定性标记。

## 启动与关闭 / Startup And Shutdown

In development, `just start` should eventually launch agent-core, memory providers, web, and `quilin-daemon`. `just dev` may keep the daemon optional, but `just dev-idle` or an equivalent command should reproduce production scheduler behavior.

开发环境中，`just start` 最终应启动 agent-core、memory providers、web 和 `quilin-daemon`。`just dev` 可以让 daemon 可选，但应提供 `just dev-idle` 或等价命令来复现生产 scheduler 行为。

In production, `quilin-daemon` should be supervised as its own service. It can start after config is readable and before all providers are healthy, because job execution should perform per-provider health checks and skip unavailable handlers.

生产环境中，`quilin-daemon` 应作为独立服务被 supervisor 管理。它可以在 config 可读后启动，不必等待所有 provider 健康，因为 job execution 应执行 per-provider health check 并跳过不可用 handlers。

Shutdown should stop accepting new leases, signal active handlers, wait up to a bounded grace period, then mark unfinished jobs as interrupted. Restart should not duplicate non-idempotent work.

shutdown 应停止接受新 lease，向 active handlers 发 signal，等待有界 grace period，然后把未完成 jobs 标记为 interrupted。restart 不应重复执行非幂等工作。

## 与现有文档对齐 / Alignment With Existing Docs

This design does not redefine `docs/03-memory`. Memory-specific details remain in [`docs/03-memory/idle-runner-design.md`](../03-memory/idle-runner-design.md), now as a consumer view for the global scheduler.

本设计不重新定义 `docs/03-memory`。memory-specific 细节保留在 [`docs/03-memory/idle-runner-design.md`](../03-memory/idle-runner-design.md)，现在它是全局 scheduler 的 consumer view。

This design does not redefine `docs/10-self-evolution`. Scaffold proposal generation remains default-off, budget-gated, proposal-only, and human-reviewed. The daemon schedules it; it does not apply patches.

本设计不重新定义 `docs/10-self-evolution`。scaffold proposal generation 仍默认关闭、受预算约束、只产 proposal、需人审。daemon 只调度它，不应用 patches。

This design does not redefine `docs/13-skills`. Skill files remain owned by 13-skills and written through `skill_manage` with validation and WriteAuthority. The daemon may schedule a background nudge, but it does not write SKILL.md directly.

本设计不重新定义 `docs/13-skills`。Skill files 仍由 13-skills 拥有，并通过带 validation 与 WriteAuthority 的 `skill_manage` 写入。daemon 可以调度 background nudge，但不直接写 SKILL.md。

This design does not redefine `docs/16-soul-import`. Install-time scanning remains an install-origin flow with explicit confirmation. The daemon may later schedule post-install verification, not install-time writes.

本设计不重新定义 `docs/16-soul-import`。install-time scanning 仍是 install-origin flow，并要求显式确认。daemon 后续可以调度 post-install verification，而不是 install-time writes。

## QUI-188 验收建议 / QUI-188 Acceptance Guidance

The first implementation slice should build the scheduler shell, job registry, durable run table, budget lease interface, and fake jobs. It should not implement every domain job at once.

第一实现切片应搭建 scheduler shell、job registry、durable run table、budget lease interface 和 fake jobs。不应一次实现所有领域 job。

The second slice should register memory jobs through existing MCP or Python handlers and prove that scheduler failure does not break chat or MCP request handling.

第二切片应通过现有 MCP 或 Python handlers 注册 memory jobs，并证明 scheduler failure 不会破坏 chat 或 MCP request handling。

The third slice should register self-evolution and skill jobs only after WriteAuthority, budget, and report-back behavior are proven with tests.

第三切片应在 WriteAuthority、budget 和 report-back 行为有测试实证后，再注册 self-evolution 和 skill jobs。

No slice should touch `packages/agent-core/src/index.ts` as part of this design review. Startup integration can be planned later once the daemon boundary is accepted.

在本设计评审阶段，任何切片都不应触碰 `packages/agent-core/src/index.ts`。只有 daemon 边界被接受后，才规划 startup integration。
