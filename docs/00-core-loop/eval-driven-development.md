# 评测驱动开发 / Eval-Driven Development (EDD)

> Lightweight self-owned trace-eval layer that gates every Quilin harness change. **Prerequisite for Iter L / L+1 / L+2 / K / I** — without EDD, harness improvements cannot be measured and will silently regress. Tracking iteration: **Iter L+0**.
>
> 轻量级自有 trace eval 层，作为每次 Quilin harness 改动的合入闸门。**Iter L / L+1 / L+2 / K / I 的先决条件**——没有 EDD，harness 改动无法量化，会在无声中退化。追踪 iteration：**Iter L+0**。

---

## 一、为什么需要 EDD / Why EDD

The 2026-05-08 reactive-execution work surfaced a hidden requirement: **every harness improvement is a behavior change, and every behavior change without measurement is a blind change**. We can land a perfect tool-metadata schema, a beautiful descriptor catalog, an elegant context auto-load policy — and we will not know whether the agent now feels **smarter** or **dumber** in real usage. Today, the only signal is the user's gut feel, which is unreliable, slow, and not falsifiable.

2026-05-08 的反应式执行工作揭示了一个隐藏需求：**每次 harness 改进都是行为变化，每次没有量化的行为变化都是盲改**。我们可以落地完美的 tool-metadata schema、漂亮的 descriptor catalog、优雅的上下文自动 load 策略——但我们无法知道真实使用中 agent 是变得**更聪明**还是**更笨**。今天，唯一信号是用户的直觉，它不可靠、滞后、不可证伪。

The 14-Benchmark project (SWE-bench / GAIA / BFCL leaderboards) was frozen on 2026-05-02 because it consumes disproportionate effort relative to product value for a self-hosted agent team. **EDD is fundamentally different**: it tracks internal regression on the team's own usage trajectories, not external leaderboard ranking. It is small, cheap, and runs every PR.

14-Benchmark project（SWE-bench / GAIA / BFCL 排行榜）已于 2026-05-02 被冻结，因为对自托管 agent 团队来说投入产出比过低。**EDD 与之根本不同**：它追踪团队自己使用 trajectory 上的内部回归，不追外部排名。它体量小、成本低，每个 PR 都跑。

---

## 二、当前状态 / Current State

| 组件 / Component | 状态 / State |
|---|---|
| Trace 采集 / Trace capture | 🚧 部分：08-Observability 已有 OTel-style structured logs，但缺"session 完整 trace"概念。<br>Partial: 08-Observability has OTel-style structured logs, but no "complete session trace" concept. |
| Trace catalog | ❌ 不存在 / Does not exist |
| EDD runner | ❌ 不存在 / Does not exist |
| CI hook | ❌ 不存在 / Does not exist |
| Annotation TUI | ❌ 不存在 / Does not exist |
| 14-Benchmark | ❄️ Frozen 2026-05-02; 历史代码保留为 read-only 事实，本 iter 不动它. / Frozen 2026-05-02; existing code retained read-only; this iter does not touch it. |

---

## 三、设计 / Design

### 3.1 6 个核心指标 / Six Core Metrics

| 指标 / Metric | 定义 / Definition | 信号源 / Signal Source |
|---|---|---|
| **Goal completion rate / 目标完成率** | session 结束时用户主动关闭或标注"完成"的比例 / Ratio of sessions where user closes or marks "done" at end | 用户行为 / user action |
| **Clarification turns / 澄清轮数** | 用户在任务中为澄清意图发的消息数 / Count of user messages clarifying intent within a task | 消息分类 / message classification |
| **Correction turns / 纠正轮数** | 用户主动否定 agent 决策的次数（"不对"/"重做"/"撤销"）<br>Count of user-initiated negations of agent decisions ("no"/"redo"/"undo") | 消息分类 / message classification |
| **Tool-call success rate / 工具调用成功率** | 单次 tool call 返回非错误 / 总调用次数 / Successful (non-error) tool calls / total | 05-Tool result 字段 |
| **Token efficiency / token 效率** | 任务完成所用 input + output tokens / 任务复杂度估计 / Total input + output tokens / task complexity estimate | 01-LLM usage 字段 |
| **Time to first useful output / 首个有用输出时间** | 用户最后输入到 agent 给出实质性进展（非"我来看看"）的秒数 / Seconds from last user input to agent's first substantive progress (not "let me look") | 04-Planning + 时间戳 |

任何 harness 改动必须在这 6 个指标上 **不显著恶化**（< 1 σ 退步）才能合入 master。改动若显著改进某指标，commit message 必须附 EDD 曲线截图作为实证。

Any harness change must **not significantly regress** these six metrics (< 1 σ degradation) to merge to master. If a change significantly improves a metric, the commit message must attach the EDD curve as evidence.

### 3.2 Trace catalog 构成 / Trace Catalog Composition

100-300 条精选真实 session，分布在以下任务类别：

100–300 curated real sessions, distributed across:

* **代码导航 / code navigation** (~25 %): grep / glob / read-file / 跨文件追踪
* **代码修改 / code edit** (~25 %): bug 修复 / 小重构 / 新功能添加
* **调试 / debug** (~15 %): 错误诊断 / 复现 / 修复
* **多文件 / multi-file** (~15 %): 跨多个文件的协调改动
* **需要 subagent / needs subagent** (~10 %): 大范围重构 / 复杂搜索
* **对话 / conversation** (~10 %): 解释代码 / 计划讨论 / 决策

每条 trace 需要标注：

Each trace requires annotation:

* `session_id`: 唯一标识 / unique id
* `goal`: 用户实际想完成的事 / what the user actually wanted to accomplish
* `key_steps`: 应当达成的中间步骤清单 / list of expected intermediate steps
* `expected_artifacts`: 应当产出的文件 / 修改 / commit / expected output files / edits / commits
* `category`: 上述 6 类之一 / one of the above 6 categories
* `complexity_score`: 1-5 主观评分 / 1-5 subjective complexity score

### 3.3 EDD runner 设计 / EDD Runner Design

```
just eval-trace [--filter <category>] [--baseline <git-ref>]
```

* 从 trace catalog 重放每条 session 的用户输入序列
* 用当前 harness（git HEAD）跑相同输入，记录新 trace
* 计算 6 个指标，对比 `--baseline`（默认上次 main 合入点）
* 输出 markdown 报告 + JSON 指标，便于 CI post 到 PR comment

* Replay each session's user-input sequence from the trace catalog.
* Run against current harness (git HEAD), record new trace.
* Compute the 6 metrics, diff vs `--baseline` (default: last main merge point).
* Emit markdown report + JSON metrics for CI to post as PR comment.

### 3.4 CI 集成 / CI Integration

GitHub Actions / GitLab CI hook：

* 每个 PR 触发 `just eval-trace --baseline origin/master`
* 结果 post 为 PR comment
* 任意 metric 退步超过 1 σ → block merge（reviewer 可手动 override 但需附理由）
* 任意 metric 改进超过 1 σ → 自动添加 `eval-improved` label

GitHub Actions / GitLab CI hook:

* PR triggers `just eval-trace --baseline origin/master`.
* Result posted as PR comment.
* Any metric regressing > 1 σ → block merge (reviewer can manually override with justification).
* Any metric improving > 1 σ → auto-label `eval-improved`.

### 3.5 Annotation TUI / 标注 TUI

轻量 TUI 给真实 session trace 加标注：

Lightweight TUI for annotating real session traces:

```
just eval-annotate ~/.quilin/traces/<session-id>.ndjson
```

* 终端里逐条 trace 渲染：用户消息 / agent 输出 / tool calls / 时间戳
* 用户填 `goal` / `key_steps` / `expected_artifacts` / `category` / `complexity_score`
* 写入 `eval/catalog/<session-id>.yaml`
* 标注完即可纳入 catalog

* Renders trace in terminal: user messages / agent outputs / tool calls / timestamps.
* User fills in `goal` / `key_steps` / `expected_artifacts` / `category` / `complexity_score`.
* Writes to `eval/catalog/<session-id>.yaml`.
* After annotation, trace enters the catalog.

---

## 四、行动项 / Action Items

### P0 — Trace 采集与 catalog / Trace Capture and Catalog

* [ ] 08-Observability 增加 "session-level trace" 概念：从 session 开始到结束的所有事件（user message / tool call / agent response / decision branch / error）以 NDJSON 落盘到 `~/.quilin/traces/<session-id>.ndjson`
* [ ] Trace schema 中英双语段落对照写入 `docs/08-observability/trace-schema.md`
* [ ] Annotation TUI 落地（`packages/agent-core/src/tools/builtin/eval-annotate.ts`），`just eval-annotate` 可用
* [ ] 收集 100 条真实 session trace 作为 catalog v0
* [ ] 6 个核心指标计算函数落地，单测覆盖率 ≥ 95 %

### P0 — EDD runner 与 CI hook / EDD Runner and CI Hook

* [ ] `just eval-trace [--filter] [--baseline]` 命令落地
* [ ] EDD runner 重放 trace catalog 跑当前 harness、对比 baseline、输出 markdown + JSON 报告
* [ ] CI workflow（GitHub Actions / GitLab CI）每个 PR 触发 `just eval-trace`，post comment
* [ ] 1 σ 退步 → block merge；改进 → 自动 label

### P1 — Catalog 扩展与质量 / Catalog Expansion and Quality

* [ ] 把 catalog 扩到 200-300 条
* [ ] 6 类任务的分布覆盖率达标（每类至少 15 %）
* [ ] 标注审核流程：每条 trace 至少 2 人独立标注，分歧时讨论
* [ ] Catalog 版本化：`eval/catalog-v1.0/`、`v1.1/` 等

### P2 — 高级评测 / Advanced Evaluation

* [ ] LLM-as-judge 评估 "agent 输出质量"（成本可控版本，只对关键 trace 跑）
* [ ] 自动 trace category classifier，新 trace 进 catalog 时自动分类
* [ ] EDD dashboard 可视化历史曲线（08-Observability WebUI 集成）

---

## 五、不做 / Out of Scope

* 不复活 14-Benchmark（SWE-bench / GAIA / BFCL leaderboard 追求）
* No revival of 14-Benchmark (SWE-bench / GAIA / BFCL leaderboard pursuit)
* 不做合成 trace（先用真实使用 trace）
* No synthetic traces (real-usage traces only)
* 不做"AI 自动写 catalog 标注"（先人工 + 双人审核）
* No AI-generated catalog annotations (manual + dual-review first)
* 不替换 08-Observability 现有 OTel structured logging（在它之上加 session 抽象）
* No replacement of 08-Observability's OTel structured logging (build session abstraction on top)

---

## 六、关联 / Cross-References

### Linear

* **Iter L+0 project**: [评测驱动开发 / Eval-Driven Development](https://linear.app/quilin-agent/project/iter-l0评测驱动开发-eval-driven-development-b5b29b157f46)
* **Tracker issue**: [QUI-135 — Iter L+0 tracker: EDD trace catalog + runner + CI hook](https://linear.app/quilin-agent/issue/QUI-135/iter-l0-tracker-edd-trace-catalog-runner-ci-hook) (priority High)

### 文档 / Docs

* [`intelligence-roadmap.md`](./intelligence-roadmap.md) — 总索引；EDD 是其底座 / master index; EDD is its foundation
* [`reactive-execution.md`](./reactive-execution.md) — Iter L 设计；其改动需要 EDD 验证 / Iter L design; its changes require EDD verification
* [`../08-observability/README.md`](../08-observability/README.md) — Observability 当前状态；EDD 在其之上 / observability current state; EDD builds on top
* [`../14-benchmark-harness/README.md`](../14-benchmark-harness/README.md) — Frozen，不动 / frozen, untouched

### 相关 iteration / Related Iterations

EDD 是这些 iteration 合入前的 prerequisite gate：

EDD is the prerequisite gate before these iterations merge:

* **Iter L** — tool metadata + dispatcher 改动
* **Iter L+1** — tool descriptor 重写
* **Iter L+2** — context auto-load 策略
* **Iter K** — 对话工程 6 层注入
* **Iter I** — 自进化产出的 skill / patch
