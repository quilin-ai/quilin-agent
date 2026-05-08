# 反应式执行 / Reactive Execution

> Core Loop's adaptive-execution model — how Quilin should pick foreground / background dispatch, detect stuck tools, and fall back to alternatives **without re-entering the Planner on every event**. Filed 2026-05-08 from a live trajectory: a 24 GB `uv cache clean` hung at 0 % CPU near a full disk; the harness backgrounded the cleanup, opened parallel work, polled progress, detected the hang from process state, and switched to `rm -rf` — all without explicit user re-planning.
>
> Core Loop 的自适应执行模型 — Quilin 该怎么自己决定前台/后台调度、识别卡住的工具、降级到备选工具，**而不是每次事件都回到 Planner 重新规划**。本文成文于 2026-05-08，触发 trajectory 是真实的：一次 24 GB 的 `uv cache clean` 在磁盘几乎写满时挂死、CPU 占用为零；harness 把清理转后台、并行开了 Phase 1 的活、定期看进度、靠进程状态判断"它卡了"、再切换到 `rm -rf` 完成清理 — 整个过程没有显式回到 Planner 重规划。

---

## 零、一句话总结 / TL;DR

This is not "dynamic planning"; it is **Core Loop's intrinsic reactive capability**. Plan supplies direction; Loop supplies adaptivity. The two have different jobs: Plan operates at the strategic level ("switch to a fundamentally different approach"); Loop operates at the tactical level ("swap tools or dispatch modes within the same goal"). Quilin already has both Plan and a non-blocking Loop in skeletal form. The missing pieces are three fields in tool metadata — `expectedRuntime`, `progressObservability`, `equivalentAlternatives` — plus the execution-expectation tracking mechanism. With those landed, the Core Loop can make every judgment this session demonstrated **on its own**, instead of re-deriving them via LLM at runtime each time.

不是"动态 Plan"，是 **"Core Loop 自带反应能力"**。Plan 给方向，Loop 给适应力。两者职责不同：Plan 是策略级（"换一个完全不同的方法"），Loop 是战术级（"同一个目标里换工具/换调度模式"）。麒麟现在已经有 Plan 和非阻塞 Loop 的雏形，**关键缺的是 tool metadata 里的 `expectedRuntime` / `progressObservability` / `equivalentAlternatives` 三个字段，以及 execution expectation 这个机制**——有了这些，Core Loop 就能自己做今天 session 里展示的所有判断，不必每次靠 LLM 现场推理。

### 优先级表 / Priority Table

| 优先级<br>Priority | 改动<br>Change | 在哪<br>Where |
|---|---|---|
| P0 | Tool metadata 增加 `expectedRuntime`（instant / short / long / open-ended）和 `progressObservability`（none / process / file / log）<br>Tool metadata adds `expectedRuntime` (instant / short / long / open-ended) and `progressObservability` (none / process / file / log) | 05-tool spec + `tool-metadata.ts` |
| P0 | Core Loop 根据上面两个字段，**自动决定** sync / parallel / background dispatch（不靠 LLM 推理）<br>Core Loop **auto-decides** sync / parallel / background dispatch from the two fields above (no LLM in the loop) | 00-core-loop spec |
| P1 | Tool metadata 增加 `equivalentAlternatives`（同目标的备选工具）<br>Tool metadata adds `equivalentAlternatives` (alternative tools for the same goal) | 05-tool spec |
| P1 | 引入 **execution expectation**：每次 tool call 记录预期 runtime + 预期产物变化；observer 监控实际偏差，超阈值触发 re-plan<br>Introduce **execution expectation**: every tool call records predicted runtime + predicted side-effects; observer watches the gap and triggers re-plan when threshold is exceeded | 08-observability ⨯ 04-planning，开新章节 / new cross-cutting section |
| P2 | 把"长任务卡住的常见模式"落成 skill（如 `disk-full-cache-clean-fallback`），让 self-evolution 模块从这种 trajectory 中提取<br>Lift "long task gets stuck" common patterns into skills (e.g., `disk-full-cache-clean-fallback`) so the self-evolution module can mine such trajectories | 13-skills + 10-self-evolution |
| P2 | 给 04-Planning 加一个 **"trigger conditions for re-plan"** 字段（什么时候 Planner 重新介入，什么时候 Core Loop 自己处理）<br>04-Planning adds a **"trigger conditions for re-plan"** contract (when Planner re-enters, when Core Loop handles it locally) | 04-planning spec |

---

## 一、核心论点 / Core Thesis

Reactive execution is **not** a separate "dynamic Plan" component; it is the **Core Loop's intrinsic behavior**. Classical planners (PDDL, HTN) generate a static plan tree before execution. That model breaks down when reality contradicts the plan — when "should take 5 minutes" becomes "stuck for 8 minutes". The only sustainable fix is to demote planning from a one-shot upfront artifact to a **local decision the loop makes every step**, while keeping the Planner for **strategy-level re-plan** (changing the whole approach), not tactical adjustment (swapping tools toward the same goal).

反应式执行**不是**一个独立的"动态 Plan"组件，而是 **Core Loop 自身的本质属性**。经典 planner（PDDL、HTN）在执行前生成一棵静态 plan tree。这个范式遇到"现实和 plan 不符"就崩 — 比如"应该 5 分钟跑完"变成"卡了 8 分钟"。唯一可持续的修法是把规划从一次性的预生成产物**降级成 loop 每一步的局部决策**，同时让 Planner 只负责**策略级 re-plan**（换整个方法论），不下沉到战术调整（同一目标里换工具）。

| | Classical Plan-then-Execute | ReAct / Online / Reactive |
|---|---|---|
| Plan generation timing<br>规划生成时机 | Once, upfront<br>一次性、预生成 | Interleaved, every step<br>交错、每步发生 |
| Granularity<br>粒度 | Whole task tree<br>整棵任务树 | Next tool call<br>下一个 tool call |
| Failure handling<br>失败处理 | Re-plan whole tree<br>重新生成整棵树 | Local fallback ladder<br>局部降级阶梯 |
| Strength<br>优势 | Optimal under known dynamics<br>已知动力学下最优 | Robust to surprise<br>对意外鲁棒 |
| Weakness<br>劣势 | Brittle when reality drifts<br>现实漂移即崩 | Locally greedy, may lose globality<br>局部贪婪、可能丢全局 |

The two should coexist. Quilin already has the Planner (`docs/04-planning/`) and a non-blocking Core Loop (`packages/agent-core/src/loop/`). The missing piece is the **execution-side adaptation primitives** documented below.

两者应当共存。Quilin 已经有 Planner（见 `docs/04-planning/`）和非阻塞 Core Loop（见 `packages/agent-core/src/loop/`）。缺的是**执行侧的自适应原语**，下面逐条记录。

---

## 二、四个执行原语 / Four Execution Primitives

### 2.1 调度决策 / Dispatch Decision (Foreground vs Background)

The decision "should this tool run in the foreground or background" is **not** an LLM-time judgment — it should be **pre-declared in tool metadata** and resolved by the Core Loop. The trigger from the trajectory: "the cache clean will be long, my next work doesn't depend on its output, and progress is observable from the outside" — three conditions, all checkable from metadata.

"这个 tool 该前台还是后台跑"**不是** LLM 推理时的判断 — 它应该**预先声明在 tool metadata 里**，由 Core Loop 解析。trajectory 中的判断条件是："cache clean 会跑很久、我下一步工作不依赖它的输出、外部可观测它的进度" — 三个条件全都可以从 metadata 里查到。

Concretely, every tool in `tool-metadata.ts` should declare:

具体说，每个 tool 在 `tool-metadata.ts` 里都应当声明：

```typescript
interface ToolMetadata {
  // ... existing fields: riskLevel, category, sandboxOperation
  readonly expectedRuntime: "instant" | "short" | "long" | "open-ended";
  readonly progressObservability: "none" | "process_state" | "file_growth" | "structured_log";
  readonly equivalentAlternatives?: readonly string[]; // tool names, ordered by preference
}
```

`expectedRuntime: "long"` (≥30s) plus `progressObservability != "none"` plus `category != "interactive"` is sufficient signal for the Core Loop to dispatch in the background **without** asking the LLM. This collapses ~80 % of "should I background this" decisions to a metadata lookup.

`expectedRuntime: "long"`（≥30s）+ `progressObservability != "none"` + `category != "interactive"` 三个条件加起来，Core Loop 就可以**不问 LLM** 直接转后台。这把"要不要后台跑"约 80% 的判断折叠成元数据查表。

### 2.2 非阻塞主循环 / Non-blocking Main Loop

The main agent must never `sleep` or block on a long-running operation. While a backgrounded tool runs, the loop should advance to **independent next-step work** or wait on user input. This pattern is already canonized in CLAUDE.md as *Non-blocking Supervisor* (06 Multi-Agent), and partly implemented in the loop's parallel tool-call dispatch.

主 agent 永远不能 `sleep` 等待长任务。后台 tool 跑着的同时，loop 要推进到**独立的下一步工作**或等用户输入。这个模式已经在 CLAUDE.md 里定型为 *Non-blocking Supervisor*（06 Multi-Agent 章节），部分能力也已经在 loop 的并行 tool-call dispatch 里实现。

The gap: today the loop does parallel **tool calls** but not parallel **tool-call + planner-thinking**. When a backgrounded tool runs, the loop currently waits for user input rather than proactively scanning the task list for unblocked work. A tighter design would have the loop pull the next pending task from the task list whenever no foreground action is in flight.

差距在哪：今天 loop 能并行**多个 tool call**，但不能**让 tool 在后台跑、自己推进规划**。后台 tool 跑着时，loop 现在是等用户输入，而不是主动从任务清单里捞下一项独立工作。更紧的设计是：只要前台没有动作在飞，loop 就从 TaskList 拉下一个未阻塞的任务自己推进。

### 2.3 观察驱动的异常检测 / Observation-driven Anomaly Detection

Detecting "the tool is stuck" requires comparing **expectation** with **observation**. In the trajectory: expected = "24 GB cache cleaned in 5–10 minutes"; observed = "8 minutes elapsed, 0 % CPU, cache size unchanged". The gap between expectation and observation, not the absolute observation alone, triggered the re-plan.

判断"这个 tool 卡了"需要**预期**和**观测**对比。trajectory 里的对比：预期 = "24 GB 缓存 5–10 分钟跑完"；观测 = "8 分钟已过、CPU 0%、缓存大小不变"。是预期与观测的偏差触发了 re-plan，不是单看绝对观测值。

This requires a primitive Quilin does not yet have: **execution expectation tracking**. Every tool dispatch should record:

这要求 Quilin 现在还没有的一个原语：**execution expectation tracking**。每次 tool 派发都要记录：

- Predicted runtime range (from metadata's `expectedRuntime` + historical p50/p95)
- Predicted side-effect (e.g., "free disk should grow", "file at path should appear")
- Polling cadence + anomaly threshold (e.g., 0 % CPU for ≥3× expected runtime → flag)

- 预期 runtime 区间（来自 metadata 的 `expectedRuntime` 加历史 p50/p95）
- 预期副作用（比如"free disk 会涨"、"某路径下文件会出现"）
- 巡检节奏 + 异常阈值（比如 CPU 0% 持续超过 3 倍预期 runtime → flag）

Observation feeds 08-Observability metrics; the comparator that flips "expected vs observed → anomaly" lives in the Core Loop, not the Planner.

观测进 08-Observability 的 metrics 流；负责把"预期 vs 观测 → 异常"这个判断翻成事件的 comparator 应该住在 Core Loop 里，不是 Planner 里。

### 2.4 降级阶梯 / Fallback Ladder

For a given goal, multiple tools may exist with different cost / robustness trade-offs. "Free disk" is reachable via `uv cache clean` (clean, slow) → `rm -rf ~/.cache/uv` (fast, brutal) → `purge` (system-level, requires privileges). The Core Loop should walk this ladder when the higher-priority option fails, **without** re-engaging the Planner.

同一目标可能有多个工具完成，成本/鲁棒性 trade-off 不同。"释放磁盘"这个目标可以走：`uv cache clean`（优雅、慢）→ `rm -rf ~/.cache/uv`（快、粗）→ `purge`（系统级、需要权限）。Core Loop 应该在高优工具失败时自动沿着阶梯下沉，**不必**回到 Planner。

This depends on tool metadata declaring `equivalentAlternatives` (see 2.1). Without it, the LLM has to recall every alternative from training-data knowledge — fragile and expensive.

这依赖 tool metadata 声明 `equivalentAlternatives`（见 2.1）。没有它的话 LLM 要靠训练数据里的通用知识现想备选 — 脆弱且贵。

---

## 三、Plan 与 Loop 的职责切分 / Plan vs Loop Responsibility

| | Planner (04) handles<br>由 Planner（04）负责 | Core Loop (00) handles<br>由 Core Loop（00）负责 |
|---|---|---|
| Trigger<br>触发时机 | New user task; current strategy clearly failing<br>新用户任务；当前策略明显失效 | Every tool call<br>每一次 tool call |
| Granularity<br>粒度 | Task-level ("E2E test three PRs")<br>任务级（如"E2E 三个 PR"） | Step-level ("which tool", "fg vs bg", "stuck → swap")<br>步骤级（"用哪个 tool"、"前台还是后台"、"卡了换招"） |
| Input<br>输入 | User intent + accumulated context<br>用户意图 + 累积上下文 | Tool result + expectation/observation gap<br>工具调用结果 + 预期与观测的偏差 |
| Output<br>输出 | Subtask list (TaskList)<br>子任务清单（TaskList） | Next tool dispatch<br>下一次 tool 派发 |
| Re-entry<br>重入条件 | Strategy invalidated, scope changed<br>策略失效、范围变更 | Stays in loop; only escalates to Planner on **strategy-level** failure<br>常驻；只在**策略级**失败时才升到 Planner |

The escalation threshold is intentional. If the loop kicks the Planner on every tactical hiccup, replanning overhead dominates. If the loop never escalates, it can keep walking a doomed strategy indefinitely. The escalation rule should be: **escalate when none of the equivalent alternatives reach the goal** — not on first tool failure.

升级到 Planner 的阈值要刻意设计。loop 每次小坎都踢 Planner，replan overhead 会压垮系统；loop 永远不升级，又会在死胡同里一直走。规则应该是：**所有 equivalent alternatives 都失败了才升级 Planner** — 不是单个 tool 第一次失败就升级。

---

## 四、当前差距 / Current Gaps

| Gap<br>差距 | Owner<br>归属 | Severity<br>严重度 |
|---|---|---|
| `tool-metadata.ts` lacks `expectedRuntime` / `progressObservability` / `equivalentAlternatives`<br>`tool-metadata.ts` 缺 `expectedRuntime` / `progressObservability` / `equivalentAlternatives` | 05-tool | P0 |
| Core Loop dispatcher does not auto-decide foreground vs background from metadata<br>Core Loop 调度器不会按 metadata 自动决定前台/后台 | 00-core-loop | P0 |
| No execution expectation tracking; no comparator between predicted and observed side-effects<br>没有 execution expectation tracking；没有预期与观测的对比器 | 00-core-loop ⨯ 08-observability | P1 |
| Fallback ladder is implicit (LLM recalls alternatives); should be metadata-driven<br>降级阶梯是隐式的（LLM 凭知识现想），应该 metadata 驱动 | 05-tool ⨯ 00-core-loop | P1 |
| Planner has no formal "trigger conditions for re-entry" contract — when Loop escalates is currently ad-hoc<br>Planner 缺正式的"重入触发条件"契约 — Loop 何时升级到 Planner 现在是临时拍 | 04-planning | P2 |

---

## 五、行动项 / Action Items

P0 — Tool metadata + dispatcher / 工具元数据 + 调度器：
1. Extend `ToolMetadata` with the three fields above; backfill all existing builtin tools.
2. Core Loop dispatcher reads `expectedRuntime + progressObservability` and chooses fg/bg without LLM involvement.
3. Add unit tests asserting "long + observable + non-interactive → background dispatch".

P0 — 工具元数据 + 调度器：
1. 给 `ToolMetadata` 加上面三个字段；回填所有已有的 builtin tool。
2. Core Loop 调度器读 `expectedRuntime + progressObservability` 决定前台/后台，不走 LLM。
3. 加单测断言"long + observable + non-interactive → 走后台"。

P1 — Execution expectation tracking / 执行预期跟踪：
1. Every tool dispatch records predicted runtime + predicted side-effect + polling cadence.
2. 08-Observability subscribes to dispatch records, periodically samples reality, emits anomaly event when threshold exceeded.
3. Core Loop subscribes to anomaly events; on anomaly, walks the fallback ladder.

P1 — 执行预期跟踪：
1. 每次 tool 派发记录预期 runtime + 预期副作用 + 巡检节奏。
2. 08-Observability 订阅这些派发记录、定期采样现实状态、阈值超出时发异常事件。
3. Core Loop 订阅异常事件；异常发生时沿降级阶梯走。

P2 — Planner re-entry contract / Planner 重入契约：
1. 04-Planning spec adds a "re-entry triggers" section: under what observable conditions Loop escalates to Planner.
2. Initial draft: "all equivalent_alternatives exhausted" + "destructive operation about to happen" + "user-supplied new constraint".

P2 — Planner 重入契约：
1. 04-Planning spec 增加"重入触发条件"章节：在什么可观测条件下 Loop 应当升级到 Planner。
2. 初稿三条："所有 equivalent_alternatives 用尽" + "即将进行破坏性操作" + "用户新增了约束"。

P2 — Skill extraction from trajectory / 从 trajectory 抽 skill：
1. The disk-full + uv-stuck + rm-fallback trajectory is a reusable pattern.
2. 10-Self-Evolution should be able to mine this kind of trajectory and propose a skill (e.g., `disk-full-cache-clean-fallback.md`).

P2 — 从 trajectory 抽 skill：
1. "磁盘满 + uv 卡死 + rm 兜底"是一个可复用模式。
2. 10-Self-Evolution 应当能从这种 trajectory 里挖掘并提议一个 skill（比如 `disk-full-cache-clean-fallback.md`）。

---

## 六、Worked Example — 2026-05-08 trajectory

The session that prompted this RFC:

触发本 RFC 的会话：

1. User asked for E2E testing of three landed PRs. Disk was at 100 % usage (3.4 GB free). Phase 2 / 3 needed ~600 MB–1 GB of browser binaries.
2. After negotiating cleanup scope with the user, the harness ran `uv cache clean` to reclaim 24 GB. **Decision: foreground or background?** Reasoning: long runtime + Phase 1 work is independent + progress externally observable → background. (Without metadata, this reasoning was implicit LLM judgment.)
3. In parallel, the harness read `web-fetch.ts` source, identified Phase 1 acceptance points, and drafted the e2e script.
4. Periodic polling (`pgrep`, `ps -o state,etime`, `du -sh`) showed `uv cache clean` had been sleeping for 8 minutes at 0 % CPU; cache size unchanged. **Anomaly detected: expected progress vs observed progress diverged.**
5. **Fallback decision:** kill `uv cache clean`, run `rm -rf ~/.cache/uv`. The two are functionally equivalent; the `rm` form is faster because it skips uv's metadata bookkeeping. Authorization scope was already granted by the user for "clean uv cache", so no re-prompt was needed.
6. Recovered 12 GB of disk; resumed Phase 1 e2e work.

1. 用户要求对三个 land 的 PR 做 E2E 测试。磁盘 100% 占用（剩 3.4 GB）。Phase 2 / 3 加起来要 ~600 MB–1 GB 浏览器二进制。
2. 跟用户对齐清理范围后，harness 启动 `uv cache clean` 来回收 24 GB。**判断：前台还是后台？** 推理：runtime 长 + Phase 1 工作独立 + 进度可外部观测 → 后台。（在没有 metadata 的情况下，这个推理是 LLM 隐式判断。）
3. 并行同时，harness 读了 `web-fetch.ts` 源码、识别 Phase 1 验收点、起草了 e2e 脚本。
4. 定期 poll（`pgrep`、`ps -o state,etime`、`du -sh`）显示 `uv cache clean` 已经 sleeping 8 分钟、CPU 0%；缓存大小没变。**异常被识别：预期进度与观测进度不一致。**
5. **降级决策：**kill `uv cache clean`，跑 `rm -rf ~/.cache/uv`。两者功能等价；`rm` 更快是因为跳过了 uv 自己的元数据登记。"清理 uv 缓存"这个权限范围已经被用户授权，不需要再问。
6. 回收 12 GB；继续 Phase 1 e2e 工作。

Every step in this trajectory is a candidate primitive for the gaps in §4. Filing this RFC + Linear issue locks the lessons in.

trajectory 里的每一步都是 §4 那张差距表的候选原语。把这份 RFC 加 Linear issue 记下来，就是把这次的教训固化成系统能力。

---

## 七、关联 / Cross-References

- [Core Loop README](./README.md) — Core Loop 当前真相源 / current truth source
- [04 Planning README](../04-planning/README.md) — Planner 当前实现 / Planner current implementation
- [05 Tool README](../05-tool/README.md) — Tool metadata 当前定义 / Tool metadata current definition
- [06 Multi-Agent README](../06-multi-agent/README.md) — Non-blocking supervisor 已有约束 / non-blocking supervisor existing constraint
- [08 Observability README](../08-observability/README.md) — Metrics / structured logs 接入点 / metrics + log ingestion point
- [10 Self-Evolution README](../10-self-evolution/README.md) — Trajectory mining 落地点 / trajectory-mining landing point

Linear tracking issue: [QUI-132](https://linear.app/quilin-agent/issue/QUI-132/reactive-execution-tool-metadata-dispatch-execution-expectation) — Reactive Execution: tool metadata + dispatch + execution expectation tracking (Iter F1, priority Medium).

Linear 跟踪 issue：[QUI-132](https://linear.app/quilin-agent/issue/QUI-132/reactive-execution-tool-metadata-dispatch-execution-expectation) — Reactive Execution: tool metadata + dispatch + execution expectation tracking（归属 Iter F1，优先级 Medium）。
