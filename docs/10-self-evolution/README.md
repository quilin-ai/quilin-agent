# 自进化工程（Self-Evolution Engineering）

> **实现状态（2026-05-07 校准）**
> - ✅ **已实现**：`self-evolution/` 目录 14 个 TS 文件已落地：`trajectory-store.ts`（JSONL 轨迹持久化）、`failure-analyzer.ts`（失败分类：tool_error/schema_violation/budget_exhaustion 等）、`patch-proposal.ts`（基于失败分析的补丁建议）、`proposal-store.ts`（提案去重存储）、`offline-optimizer.ts`（离线优化器，当前 local-noop）、`sanitize.ts`（轨迹数据消毒）、`jsonl-path.ts`（文件路径管理）、`hash.ts`（SHA-256 内容哈希），以及 `skill_manage` + WriteAuthority + skills_guard、ProfileStore / ProfileUpdater、soul schema validator、idle_budget + consolidator dry-run。
> - 🚧 **部分实现 / 延期**：Offline Optimizer 仅有 `local-noop`，无实际优化逻辑；完整的 trajectory → failure analysis → propose patch → human review 自动闭环尚未落地（基础设施已就绪，人工审核环节待接）；idle_evolution 配置已存在但运行时激活待验证。
> - Linear 后续项：[QUI-12](https://linear.app/quilin-agent/issue/QUI-12/iter-f-implement-trajectory-to-patch-self-evolution-loop)（trajectory-to-patch 闭环）、[QUI-94](https://linear.app/quilin-agent/issue/QUI-94/m5-实现-self-evolution-审批闭环确保所有自动补丁需人工审核)（审批闭环，确保自动补丁需人工审核）。

> 本文档是 Quilin Agent 工程规格系列的第 10 篇，也是最具野心的一篇。自进化是让 Agent 能够从失败中学习、自动改进自身 scaffold（提示词/工具配置/工作流）的能力——这是我们区别于绝大多数竞品的核心竞争力。核心设计受 MiniMax M2.7 的自进化闭环启发，系统化地融合了 DSPy、Voyager、ADAS 等最前沿的自动优化研究成果。
>
> **ADR-001 对齐说明**：自进化系统作为异步后台子系统运行，不阻塞主 Loop。DSPy 优化器等 ML 依赖封装为 Python MCP Server。本文档中的 Python 代码示例仅表达设计意图。`quilin/` 路径为规划参考。详见 [Core Loop](../00-core-loop/README.md)。

---

## 一、问题定义

### 1.1 静态 Scaffold 的根本局限

当前绝大多数 Agent 框架（包括 LangGraph、AutoGen、CrewAI 等主流框架）都存在一个共同的根本性缺陷：**scaffold 是静态的**。

所谓 scaffold，指 Agent 运行时所依赖的"骨架"——系统提示词、工具配置、工作流拓扑、推理策略选择。这些组件一旦由开发者写定，在 Agent 生命周期中就不再改变。这带来了三个深层问题：

**问题一：提示词写死后无法适应新场景**

开发者在编写系统提示词时，只能基于已知的任务场景进行设计。当 Agent 遇到未预见的任务类型时，静态提示词往往给出次优甚至错误的指导。例如：一个针对代码审查任务调优的提示词，遇到数学推理任务时可能因过于强调"代码风格"而产生偏差。这种不匹配是系统性的，而非偶发的——任务空间是无限的，任何有限的静态提示词都无法覆盖全部。

**问题二：人工调优的效率瓶颈**

传统的 Agent 改进依赖人类开发者的介入：观察失败案例 → 分析原因 → 修改提示词 → 重新测试 → 迭代。这个循环通常需要数小时到数天，且高度依赖开发者对任务领域的专业理解。更根本的问题是，这个过程**无法扩展**：一个开发者团队无法同时为 90 个不同领域的 Agent 实例进行持续调优。

**问题三：任务多样性挑战**

同一套推理策略无法适配所有任务类型。ReAct 策略在工具调用密集型任务上表现优秀，但在需要长链推理的数学证明任务上表现较差；PlanAndExecute 策略适合明确目标的工程任务，但在探索性研究任务上会产生过度规划的问题。静态的策略选择意味着 Agent 要么针对某类任务过度优化，要么在全部任务上都次优。

### 1.2 自进化 vs 手动调优的效率对比

| 维度 | 手动调优 | 自进化 |
|------|---------|--------|
| 响应速度 | 数小时～数天 | 数分钟（自动触发） |
| 覆盖范围 | 人类能注意到的失败 | 所有记录的失败 |
| 改进粒度 | 开发者能想到的修改 | LLM 搜索空间内的所有修改 |
| 扩展性 | 受限于开发团队规模 | 线性扩展（并行分析多个失败） |
| 知识积累 | 依赖文档/注释 | 自动沉淀到技能库 |
| 一致性 | 因人而异 | 评估标准统一 |

MiniMax M2.7 的自进化实验证明：通过 100+ 轮自进化闭环，性能可提升 **30%**，且提升曲线持续向上而不是快速饱和。这个数字比任何手动调优项目的历史记录都高出一个量级。

### 1.3 业界现状：几乎所有框架都是静态的

对主流 Agent 框架的全面审视：

| 框架 | 自动改进能力 | 说明 |
|------|------------|------|
| LangGraph | 无 | 状态机拓扑由开发者定义，不自动修改 |
| AutoGen | 无 | 多 Agent 对话，但 Agent 配置静态 |
| CrewAI | 无 | 角色/任务由用户定义，运行时不修改 |
| OpenAI Agents SDK | 无 | Handoff 逻辑静态 |
| LangChain | 无 | Chain 结构静态 |
| **DSPy** | **有（Prompt 层）** | **自动优化 prompt/few-shot，但不修改工作流结构** |
| **MiniMax M2.7** | **有（Scaffold 层）** | **自动修改 scaffold 代码，100+ 轮闭环，性能+30%** |
| Hermes/GEPA | 有（协议层） | 定义了自进化协议框架，但实现较早期 |

**结论**：真正意义上的 Agent 自进化是尚未被主流框架系统性解决的开放问题。DSPy 走得最远（在 prompt 优化层），MiniMax M2.7 更激进（修改 scaffold 代码本身）。我们的目标是在 Harness 中系统化地实现两者，并添加技能自创、数据飞轮等层次。

---

## 二、设计方案

### 2.1 自进化闭环架构

整个自进化系统由 7 个步骤构成一个闭环，受 MiniMax M2.7 设计启发：

```
┌─────────────────────────────────────────────────────────────────┐
│                       自进化闭环                                  │
│                                                                  │
│  ① 运行任务 ──→ ② 记录轨迹 ──→ ③ 分析失败 ──→ ④ 规划修改        │
│       ↑                                              ↓          │
│       └──── ⑦ 决定保留/回滚 ←── ⑥ 评估对比 ←── ⑤ 执行修改       │
│                                                                  │
│  每次循环平均耗时：5-20 分钟（取决于评估任务集大小）                │
│  MiniMax M2.7 实测：100+ 轮后性能提升 30%                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**步骤详解：**

- **① 运行任务**：Quilin 正常执行用户任务，TrajectoryStore 开始实时记录
- **② 记录轨迹**：完整记录每一步的输入/输出/推理/工具调用/结果（见 2.2 节）
- **③ 分析失败**：任务结束后，FailureAnalyzer 对失败轨迹进行 LLM 驱动的原因分析（见 2.3 节）
- **④ 规划修改**：ScaffoldModifier 根据分析结果生成具体修改方案（见 2.4 节）
- **⑤ 执行修改**：在沙箱环境中应用修改，生成新版本 scaffold
- **⑥ 评估对比**：ABEvaluator 在标准任务集上对比修改前后的性能指标（见 2.6 节）
- **⑦ 决定保留/回滚**：根据评估结果决定是否保留修改（见 2.6 节）

### 2.2 TrajectoryStore 轨迹记录设计

轨迹是自进化的原材料。没有高质量的轨迹记录，后续所有分析都是无根之木。

**记录的完整轨迹事件序列：**

```
TaskStart         { task_id, user_input, intent, timestamp }
    ↓
IntentRecognized  { task_type, complexity, strategy_selected }
    ↓
PlanCreated       { steps[], sub_goals[], estimated_tokens }
    ↓
StepStart         { step_id, thought, action_type }
    ↓
ToolCall          { tool_name, params, call_id }
    ↓
ToolResult        { call_id, output, success, duration_ms }
    ↓
StepEnd           { step_id, observation, next_thought }
    ↓
  ... (循环 StepStart → StepEnd)
    ↓
TaskEnd           { success, failure_reason?, total_steps,
                    total_tokens, total_duration_ms, output }
```

**轨迹格式**：JSON Lines，每行一个事件，支持流式写入

```python
# 每个事件的标准格式
{
    "event_type": "ToolCall",
    "task_id": "task_20260413_001",
    "step_id": 3,
    "timestamp": "2026-04-13T10:23:45.123Z",
    "data": {
        "tool_name": "bash",
        "params": {"command": "ls -la"},
        "call_id": "call_xyz789"
    },
    "metadata": {
        "model_id": "claude-sonnet-4-6",
        "thinking_mode": "interleaved",
        "token_budget_remaining": 45230
    }
}
```

**存储策略：**
- 主存储：SQLite 本地持久化（`~/.quilin/trajectories.db`）
- 保留策略：最近 N=1000 条轨迹（可配置），按时间戳 + 任务类型分组
- 索引：`(task_type, success, timestamp)` 复合索引，支持快速检索失败轨迹
- 压缩：30 天以上的轨迹自动 GZIP 压缩归档

**标注信息（每条轨迹的元数据）：**

```python
class TrajectoryMeta:
    task_id: str
    task_type: str          # coding | research | qa | planning | ...
    strategy_used: str      # ReAct | PlanAndExecute | CoT
    total_steps: int
    total_tokens: int
    success: bool
    failure_reason: str | None   # None 表示成功
    failure_step: int | None     # 在哪一步失败
    failure_category: str | None # 失败类别（见 2.3 节）
    duration_ms: int
    scaffold_version: str   # 记录执行时的 scaffold 版本号
```

### 2.3 失败分析器（FailureAnalyzer）

失败分析是整个自进化的"诊断层"。目标是从原始轨迹中精确识别失败根因，而不是泛泛地说"失败了"。

**LLM 驱动的失败模式分类：**

| 失败类别 | 描述 | 常见表现 |
|---------|------|---------|
| `WRONG_TOOL_SELECTION` | 工具选择错误 | 选了不合适的工具，或遗漏了应该使用的工具 |
| `REASONING_BIAS` | 推理偏差 | 逻辑推导出错，中间步骤有误 |
| `INSUFFICIENT_CONTEXT` | 信息不足 | 缺少必要上下文，未触发正确的信息检索 |
| `WRONG_STRATEGY` | 策略不当 | 用了错误的推理策略（如简单问题用了过度规划） |
| `INFINITE_LOOP` | 死循环 | 重复相同动作超过 3 次，未能跳出 |
| `TIMEOUT_RESOURCE` | 超时/资源耗尽 | 单步骤超时或总 token 超出预算 |
| `TOOL_FAILURE` | 工具执行失败 | 工具本身报错，但 Agent 未正确处理错误 |
| `VERIFICATION_GAP` | 验证缺失 | 输出质量低但未被验证层拦截 |

**分析 Prompt 设计（简化版）：**

```
你是一个 Agent 失败分析专家。请分析以下执行轨迹并识别失败根因。

[轨迹内容]
{trajectory_json}

[任务目标]
{task_description}

[实际结果]
{actual_output}

[期望结果类型]
{expected_output_type}

请回答：
1. 失败发生在第几步？
2. 失败类别（从预定义列表中选择）
3. 具体失败原因（1-2 句话）
4. 如果是 scaffold 问题，哪个组件需要修改？（系统提示/工具配置/推理策略/工作流）
5. 修改建议（具体说明应该如何修改）

输出格式：JSON
```

**模式聚合**：单次分析识别个例，聚合分析发现规律

```python
class PatternAggregator:
    """跨多次失败发现共性模式"""

    def aggregate(self, failures: list[FailureRecord]) -> list[FailurePattern]:
        # 按 (task_type, failure_category) 分组
        # 统计各组的失败频率
        # 识别"在 X 类型任务中，Y 类失败频率 > 阈值"的模式
        # 生成模式报告供 ScaffoldModifier 使用
        pass
```

**示例聚合结论**：
> "在 `research` 类型任务中，`INSUFFICIENT_CONTEXT` 类失败占比 67%（过去 30 次任务中 20 次），集中在第 2-3 步，表现为未主动检索背景知识就直接开始推理。建议在系统提示中增加'研究类任务必须先执行至少一次信息检索'的约束。"

### 2.4 Scaffold 自修改（人在回路，核心创新）

> **D-01 决策（2026-04-17 ultra-review）**：所有 Scaffold 自修改均需人工审批，不再保留"自动应用"路径。Agent 只生成建议（proposal）+ 沙箱验证报告，由人类通过 PR 评审决定合并。
>
> **运行时闸门（Task #90）**：proposal 从 `FailureAnalyzer` 走到 PR 之前，**必须**过 [07 §2.6.4 WriteAuthority](../07-safety-guardrails/README.md#264-writeauthority-gate权限模式的运行时执行器) gate：`origin:"agent"`（Idle Evolution 触发时为 `origin:"idle"`）、`riskLevel:"critical"`（所有 4 个 Level 均强制 `critical`，因为均触及 `packages/agent-core/` 安全代码可能面）、`summary` 含 patch 摘要、`detail` 含完整 diff。Gate 的 `confirm` 决策等价于 PR 评审环节——禁止任何绕过 gate 的直接写路径。

这是自进化中最具创新性、也最需要谨慎设计的部分。自修改按变更幅度分为 4 层，**所有层级都走 human-in-loop PR 合并**；差别仅在建议结构、沙箱验证强度与回滚代价。

**修改层级矩阵：**

```
Level 1（低风险）：系统提示调整
┌─────────────────────────────────────────────────────┐
│ 修改内容：增/删规则、调整示例、补充约束              │
│ 审批要求：人工 PR review（轻量 template）           │
│ 沙箱验证：同任务类型 20 条历史轨迹重放              │
│ 回滚复杂度：即时（revert commit）                   │
│ 影响范围：全局行为偏好                              │
└─────────────────────────────────────────────────────┘

Level 2（中风险）：工具配置修改
┌─────────────────────────────────────────────────────┐
│ 修改内容：添加/禁用工具、调整工具优先级、修改参数    │
│ 审批要求：人工 PR review（需沙箱测试报告）          │
│ 沙箱验证：隔离环境执行核心任务集                    │
│ 回滚复杂度：即时（切换配置文件）                    │
│ 影响范围：可用工具集合                              │
└─────────────────────────────────────────────────────┘

Level 3（高风险）：推理策略切换
┌─────────────────────────────────────────────────────┐
│ 修改内容：ReAct→PlanAndExecute、调整 ThinkingMode   │
│ 审批要求：人工 PR review + A/B 对比报告             │
│ 沙箱验证：benchmark 子集回归                        │
│ 回滚复杂度：即时（策略枚举切换）                    │
│ 影响范围：所有任务的推理过程                        │
└─────────────────────────────────────────────────────┘

Level 4（极高风险）：工作流重构
┌─────────────────────────────────────────────────────┐
│ 修改内容：修改状态机节点顺序、添加新节点、删除节点  │
│ 审批要求：人工 PR review + 完整 benchmark 报告      │
│ 沙箱验证：全量 benchmark 回归 + 人类 QA            │
│ 回滚复杂度：从版本历史恢复（< 5 秒）               │
│ 影响范围：整体 Agent 执行流程                       │
└─────────────────────────────────────────────────────┘
```

**修改生成流程：**

```
失败模式分析报告
      │
      ▼
ScaffoldModifier.generate_proposals(pattern_report)
      │
      ├── 确定修改层级（Level 1-4）
      │
      ├── 生成修改方案（LLM 生成，JSON Schema 约束）
      │     {
      │       "level": 1,
      │       "target": "system_prompt.research_rules",
      │       "operation": "append",
      │       "content": "研究类任务必须先执行...",
      │       "rationale": "过去 30 次任务中...",
      │       "confidence": 0.87,
      │       "sandbox_report": { pass: 18, fail: 2, regressions: [...] }
      │     }
      │
      ├── 所有 Level：写入 .patches/scaffold/<ts>-<level>.patch
      │                + 自动开 PR + 等待人工 review
      └── 合并后：记录 scaffold 版本号 + 发布发行说明
```

**Scaffold 版本控制：**
每次**合并后的**修改都会生成新的版本号，格式 `scaffold-v{major}.{minor}.{patch}`：
- patch：Level 1 合并
- minor：Level 2 合并
- major：Level 3-4 合并

> **为什么砍掉 Level 1-2 的自动应用**？Ultra-review 发现原设计存在"静默 drift"风险（Agent 悄悄改自己行为但用户不知），且绕过了 safety-guardrails 的 4 层验证链。保留 human-in-loop 并不会削弱自进化能力——多数 Agent 框架的失败源于缺少高质量 pattern 分析，而不是缺少自动应用通道。

### 2.4.0 Phase 0 实现：PromptRewriteOptimizer + IdleEvolutionRunner

The Phase 0 implementation of §2.4 (`ScaffoldModifier.generate_proposals(...)`) ships as a native TypeScript module `PromptRewriteOptimizer` rather than the DSPy/GEPA Python framework hinted at in the original spec. Phase 1+ may swap in DSPy/GEPA, but Phase 0 stays dependency-free and deterministic so the proposal pipeline can run on the same Bun process as the REPL.

§2.4 中 `ScaffoldModifier.generate_proposals(...)` 的 Phase 0 实现是原生 TypeScript 模块 `PromptRewriteOptimizer`，**不是**原 spec 暗示的 DSPy/GEPA Python 框架。Phase 1+ 可能切换到 DSPy/GEPA，但 Phase 0 保持零依赖、确定性，让提案流水线能跟 REPL 跑在同一个 Bun 进程里。

**位置 / Location**:
- Optimizer 接口：`packages/agent-core/src/self-evolution/types.ts` 的 `OfflineOptimizer`
- 默认 noop 实现：`packages/agent-core/src/self-evolution/offline-optimizer.ts` `LocalNoopOfflineOptimizer`
- Phase 0 真实实现：`packages/agent-core/src/self-evolution/prompt-rewrite-optimizer.ts`
- 调用方：`packages/agent-core/src/self-evolution/idle-runner.ts` `IdleEvolutionRunner.tryRun()`

**算法 / Algorithm**: PromptRewriteOptimizer 按 `FailureCategory`（来自 §2.3 FailureAnalyzer）对 trajectories 做聚类，每个 cluster 用 deterministic 模板生成一条 prompt-rewrite candidate（不调 LLM），写入 proposal 草稿。`estimatedFailureReduction` 是基于 cluster 大小 / confidence 的启发式估计，封顶 0.9。`maxCandidates` 限制每次 optimize 的 fan-out。

PromptRewriteOptimizer clusters trajectories by `FailureCategory` (from §2.3 FailureAnalyzer) and emits one prompt-rewrite candidate per cluster via a deterministic template (no LLM call), producing draft proposals. `estimatedFailureReduction` is a heuristic capped at 0.9 driven by cluster size + confidence; `maxCandidates` bounds fan-out per `optimize()` call.

**Persistence 责任 / Persistence responsibility**: `optimize()` 不直接写 store——它只产 `OptimizationProposalDraft[]` 草稿。持久化是 caller 的职责（`IdleEvolutionRunner.tryRun()`）。这个分工有意为之，确保 **WriteAuthority gate 是单一写入闸门**，optimizer 实现层无法绕过。

`optimize()` does **not** write to the store itself — it only returns `OptimizationProposalDraft[]`. Persistence is the caller's responsibility (`IdleEvolutionRunner.tryRun()`). This split is intentional: it keeps **WriteAuthority gate as the single write entry**, so no optimizer implementation can bypass it.

**WriteAuthority gate（强制 / mandatory）**: 按 [07 §2.6.4](../07-safety-guardrails/README.md#264-writeauthority-gate权限模式的运行时执行器) invariant 3，**任何 idle 触发的 proposal append 都必须经 WriteAuthority 授权**。`IdleEvolutionRunner` 在调 `proposalStore.append(proposal)` **之前**先调 `writeAuthority.authorize({ tool: "self_evolution_proposal_append", origin: "idle", riskLevel: "medium", summary, detail })`：

Per [07 §2.6.4](../07-safety-guardrails/README.md#264-writeauthority-gate权限模式的运行时执行器) invariant 3, **every idle-triggered proposal append must route through WriteAuthority**. `IdleEvolutionRunner` calls `writeAuthority.authorize({ tool: "self_evolution_proposal_append", origin: "idle", riskLevel: "medium", summary, detail })` **before** invoking `proposalStore.append(proposal)`:

| WriteAuthority decision | IdleRunner 行为 / behavior |
|---|---|
| `allow` | append 执行 / append proceeds |
| `deny` (e.g. `ask` mode + idle origin) | append 被跳过，logger.warn 记录 reason / skipped, reason logged via logger.warn |
| `requires_confirmation` | 当前 idle 路径不展示 prompt（idle 是后台 tick），等价 deny / current idle path does not show prompts (it's a background tick), treated as deny |
| `writeAuthority` 未注入（null） | **default-deny**：跳过 append + warn — 不允许"漏配置就静默写入" / **default-deny**: skip + warn — "miswiring silently writes" is forbidden |

**Late-binding hook**: 因为 `IdleEvolutionRunner` 在 `startRepl` 之前就被构造（`packages/agent-core/src/index.ts` 启动序列要求），WriteAuthority 在 REPL 启动后才创建。我们用 `ReplOptions.onWriteAuthorityReady?: (authority) => void` 钩子让宿主在 REPL 构造好 WriteAuthority 后调 `idleRunner.setWriteAuthority(authority)`。这样既不破坏构造序列，也保证 idle 启动前 gate 已就位。

Because `IdleEvolutionRunner` is constructed before `startRepl` (per the launch sequence in `packages/agent-core/src/index.ts`), but the WriteAuthority instance is created inside `startRepl`, we use the `ReplOptions.onWriteAuthorityReady?: (authority) => void` hook so the embedder can call `idleRunner.setWriteAuthority(authority)` once the gate is live. This preserves construction order without sacrificing the rule that the gate must be in place before any idle tick fires.

**dryRun semantics**: `OfflineOptimizerInput.dryRun` 是**信息性**字段，optimizer 自己不持久化所以 dryRun 不影响其输出。caller (`IdleEvolutionRunner`) 收到 `dryRun=true` 时跳过 `proposalStore.append`，这样人类可以观察 optimizer 在某条 trajectory 集合上的输出而不污染 store。

`OfflineOptimizerInput.dryRun` is **informational**: optimizers don't persist, so flipping `dryRun` doesn't change their output. The caller (`IdleEvolutionRunner`) observes `dryRun=true` and skips `proposalStore.append`, so a reviewer can dry-run the optimizer against a trajectory set without polluting the store.

**Sandbox 强制点 / Sandbox enforcement on apply (QUI-97)**

`scaffold_patch` 类提案的 `JsonlProposalStore.applyApproved(...)` 调用方必须传入 `sandboxPolicyGate: ProposalSandboxPolicyGate`（见 `packages/agent-core/src/self-evolution/sandbox-policy-gate.ts`）。`applyApproved` 在 WriteAuthority 返回 `allow` 之后会再咨询该闸门，按 [07 §2.6.4](../07-safety-guardrails/README.md#264-writeauthority-gate权限模式的运行时执行器) 高风险写路径走沙箱隔离的纪律选择 `docker` / `native+warning` / `deny`。`docker` 决策时 applier 收到 `{ sandbox: { kind: "docker", provider: "docker" } }` 上下文（在 `DockerSandboxRouter` 容器内执行）；Docker 不可达时降级到 `native` 并打 `logger.warn` audit；闸门显式 `deny` 时 `applyApproved` 跳过 applier，记录 `reasonCode: "sandbox_denied"`。

For `scaffold_patch` proposals the caller of `JsonlProposalStore.applyApproved(...)` MUST pass `sandboxPolicyGate: ProposalSandboxPolicyGate` (see `packages/agent-core/src/self-evolution/sandbox-policy-gate.ts`). After `WriteAuthority` returns `allow`, `applyApproved` consults this gate and decides between `docker` / `native+warning` / `deny` per the high-risk-write sandbox-isolation rule in [07 §2.6.4](../07-safety-guardrails/README.md#264-writeauthority-gate权限模式的运行时执行器). On `docker`, the applier receives a `{ sandbox: { kind: "docker", provider: "docker" } }` context and runs the patch inside a `DockerSandboxRouter` container. On `native` (Docker unavailable), the gate logs a `logger.warn` audit entry and lets the applier run on the host. On `deny`, `applyApproved` skips the applier and records `reasonCode: "sandbox_denied"`.

非 `scaffold_patch`（artifact-only review proposal）短路返回 `native`（warning 为空），保持既有 review-only 流程的零行为变化；caller 不传入 gate 时，artifact-only 提案保留既有 native applier 行为，便于单元测试与本地脚本调用。

Non-`scaffold_patch` (artifact-only review) proposals short-circuit to `native` with an empty warning so the existing review-only flow is unchanged; for those proposals, omitting the gate keeps the original native-applier behavior so unit tests and local scripts can keep their current call sites.

**Round-2 修复 / Round-2 hardening (QUI-97, 2026-05-09)**：scaffold_patch 类提案 **必须** 传 `sandboxPolicyGate`，否则 `applyApproved` 返回 `skipped` + `reasonCode: "sandbox_gate_missing"`，不允许"无 gate 就 native apply"绕过沙箱（详见 [07 §2.6.5](../07-safety-guardrails/README.md#26-writeauthority-写授权统一闸门)）。REPL 的 `/proposal-apply` 在调用 `applyApproved` 时，如果 embedder 未注入自定义 gate，会自动使用默认 `DockerProposalSandboxPolicyGate`。

Round-2 hardening (QUI-97, 2026-05-09): `scaffold_patch` proposals **must** pass `sandboxPolicyGate`; omitting it makes `applyApproved` return `skipped` + `reasonCode: "sandbox_gate_missing"` instead of silently bypassing sandbox enforcement (see [07 §2.6.5](../07-safety-guardrails/README.md#26-writeauthority-写授权统一闸门)). The REPL's `/proposal-apply` falls back to a default `DockerProposalSandboxPolicyGate` when the embedder did not provide one.

**生产部署 trade-off / Production deployment trade-off**：`DockerProposalSandboxPolicyGate` 接受 `requireDocker?: boolean` 选项。`true`（生产推荐）→ Docker 不可达时 `deny`，强制 scaffold patch apply 必须在容器内执行；`false`（默认）→ `native + warning` fallback，便于本地开发与单元测试。每次 gate 决策（含 `no_gate` / `probe_error`）发出 `proposal.sandbox_decision` agent-run 事件，便于审计。

Production trade-off: `DockerProposalSandboxPolicyGate` accepts a `requireDocker?: boolean` option. `true` (recommended for production) → `deny` whenever Docker is unreachable, hard-failing scaffold-patch apply if the container runtime is missing; `false` (default) → `native + warning` fallback, friendlier for local dev / tests. Every gate decision (including `no_gate` and `probe_error`) emits a `proposal.sandbox_decision` agent-run event for audit.

### 2.4.0.1 Phase 1+ 决策：DSPy 路径 / Phase 1+ Decision: DSPy Path

**Status (2026-05-09)**: Stage A (`providers/optimizer/` Python MCP server skeleton) and Stage B/B+ (`DspyOfflineOptimizer` + IoC factory + `self_evolution.optimizer` config) are sealed at master commits `7dc076c` and `70eba77` (QUI-118 closed Done). The DSPy path is **placeholder-only** — `providers/optimizer/src/quilin_optimizer/server.py` returns deterministic stub proposals; no `dspy-ai` dependency is imported.

**状态（2026-05-09）**：Stage A（`providers/optimizer/` Python MCP server 骨架）和 Stage B/B+（`DspyOfflineOptimizer` + IoC factory + `self_evolution.optimizer` 配置）已封存于 master 提交 `7dc076c` 和 `70eba77`（QUI-118 已 Done）。DSPy 通路目前仅是 **占位实现** —— `providers/optimizer/src/quilin_optimizer/server.py` 返回确定性 stub 提案，没有引入 `dspy-ai` 依赖。

**Decision: go straight to real DSPy + benchmark, not Phase 0.5 stepping-stone.** After weighing the trade-offs — (a) DSPy ($\geq 4$ years of Stanford NLP optimizer research, BootstrapFewShot + MIPROv2 are SOTA for prompt + few-shot search), (b) Stage A scaffolding already shaped for DSPy, (c) project preference for the strongest practical solution over staged experimentation — the next iteration installs real DSPy in `providers/optimizer/` with an LLM-judge scoring path. We deliberately reject the "Phase 0.5 (LLM-driven TS optimizer first, validate hypothesis) → Stage C (DSPy after evidence)" route because the user has prioritized maximum ceiling over fastest validation; the resulting risk (Python dependency weight, cross-language coordination) is accepted.

**决策：直接做真 DSPy + benchmark，不走 Phase 0.5 跳板**。在权衡之后 ——（a）DSPy 是 4+ 年的 Stanford NLP 优化器研究，BootstrapFewShot + MIPROv2 是 prompt + few-shot 搜索的当前 SOTA；（b）Stage A 骨架本就为 DSPy 设计；（c）项目偏向"最强可行方案"而非分阶段实验 —— 下一轮迭代在 `providers/optimizer/` 安装真 DSPy，并接入 LLM-judge 评分通路。我们刻意拒绝了"Phase 0.5（先 TS 自研 LLM 优化器验证假设）→ Stage C（按证据再上 DSPy）"的路线，因为用户优先选择"最高上限"而非"最快验证"；由此带来的风险（Python 依赖体量、跨语言协作开销）已被接受。

**Optimizer scope** — within DSPy 2.5+, ship both `MIPROv2` (Bayesian search over instruction + few-shot subsets, the DSPy 2.x flagship) and `GEPA` (Genetic-Pareto, available as `dspy.GEPA` since 2.5; emits a Pareto frontier so accuracy / cost trade-offs can be inspected). Both compilers use DSPy's default single-judge scoring path: one user-configured judge LLM (default = user's primary LLM via Vercel AI SDK). **Multi-judge ensemble is intentionally deferred** — Stage C ships single-judge first to keep the implementation small enough for one user-key path; if Stage D's benchmark shows GEPA's known single-judge variance hurts lift, ensemble is revisited in Stage E together with Trace optimizer evaluation.

**Optimizer 范围** —— 在 DSPy 2.5+ 框架内同时接入 `MIPROv2`（在 instruction + few-shot 子集两维上跑 Bayesian 搜索，DSPy 2.x 旗舰算法）与 `GEPA`（Genetic-Pareto，DSPy 2.5+ 已内置 `dspy.GEPA`；输出 Pareto 前沿，可以看到 accuracy / cost 的权衡）。两个 compiler 都走 DSPy 的默认单 judge 评分路径：一个用户配置的 judge LLM（默认 = 用户主 LLM，经 Vercel AI SDK 调用）。**Multi-judge ensemble 刻意推后** —— Stage C 先做单 judge 版，让实现规模适配单 user-key 用户；如果 Stage D 的 benchmark 显示 GEPA 已知的单 judge 方差伤到 lift，再在 Stage E 与 Trace optimizer 评估一起重启 ensemble。

**单 judge 即可用 / Single judge keeps it usable**: only one LLM provider key is required. If no key is configured, the optimizer is disabled and `IdleEvolutionRunner` falls back to the `PromptRewriteOptimizer` baseline with a warn-level log.

**单 judge 即可用**：用户只需配置任意一个 LLM provider key 即可使用。如果没有可用 key，optimizer 自动禁用，`IdleEvolutionRunner` 回退到 `PromptRewriteOptimizer` 基线并 warn-level 打日志。

**Excluded from scope (项目约束 / project constraint)**: model finetuning paths (GRPO / DeepSeek R1-zero / open-weights RL) are off-limits — Quilin is an agent project that consumes models through API only, with no GPU cluster or open-weights training pipeline. PromptBreeder / OPRO / Trace optimizer also deferred (only revisited if Stage D shows MIPROv2 + GEPA lift insufficient).

**排除范围（项目约束）**：model finetuning 通路（GRPO / DeepSeek R1-zero / open-weights RL）一律不做 —— Quilin 是 agent 项目，所有模型都通过 API 接入，没有 GPU 集群也没有 open-weights 训练管线。PromptBreeder / OPRO / Trace optimizer 同样推后（仅在 Stage D 显示 MIPROv2 + GEPA 提升不足时才重新评估）。

**Stage C — Real DSPy integration ([Linear QUI-146](https://linear.app/quilin-agent/issue/QUI-146))**: Replace the Stage A placeholder with a `dspy-ai`-backed optimizer that runs both MIPROv2 and GEPA compilers over trajectories, scored by the **single user-configured judge** described above. Detailed acceptance criteria are tracked on the issue. Predecessor: QUI-118 (Stage A+B done). Blocks: QUI-147 (Stage D).

**Stage C — 真 DSPy 集成（[Linear QUI-146](https://linear.app/quilin-agent/issue/QUI-146)）**：把 Stage A 占位换成基于 `dspy-ai` 的真实优化器，同时跑 MIPROv2 与 GEPA 两个 compiler，由上述**单用户配置 judge** 评分。详细验收条目以 issue 为准。前置：QUI-118（Stage A+B 已 done）。阻塞：QUI-147（Stage D）。

**Implementation evidence (Stage C, 2026-05-10)** — Real DSPy integration shipped in this worktree (cherry-pick pending master review). Reference points for downstream consumers:

- `providers/optimizer/pyproject.toml` — `dspy-ai>=2.5` added under `[project.optional-dependencies] dspy`; default install does NOT pull dspy-ai (heavy dep).
- `providers/optimizer/src/quilin_optimizer/server.py` — full Stage C body: lazy `import dspy`, `OptimizerConfig.from_env` reads `QUILIN_OPTIMIZER_JUDGE_{MODEL,API_KEY,BASE_URL}`, MIPROv2 + GEPA compiler dispatch via `optimizer_choice` arg, four graceful-degradation gates (extra missing / key missing / trainset < 5 / compile error → empty proposals + structured `insufficient_signal` reason).
- `providers/optimizer/tests/test_server.py` + `test_server_real_dspy.py` — 44 tests passing at 99% line coverage on `server.py` (pyproject `--cov-fail-under=95` enforced); fake-DSPy `sys.modules` injection means tests run without the heavy extra installed.
- `packages/agent-core/src/self-evolution/dspy-offline-optimizer.ts` — `DspyOptimizerChoice = "mipro" | "gepa"` type added; `optimizerChoice` option forwarded as `optimizer_choice` arg to the Python `optimize` tool.
- `packages/agent-core/src/self-evolution/optimizer-factory.ts` — accepts `dspyOptimizerChoice` in factory options and threads it through to `DspyOfflineOptimizer`.
- `packages/agent-core/src/config/user-config-schema.ts` — `selfEvolutionConfigSchema` extended with `optimizer_choice: z.enum(["mipro", "gepa"]).default("mipro")`.
- `packages/agent-core/src/config/loader.ts` — `quilin-optimizer` MCP server entry added to default capabilities config, gated on (a) `providers/optimizer/` exists AND (b) `QUILIN_OPTIMIZER_JUDGE_API_KEY` env var present; absence of either skips the spawn.
- TS test count: 1962 passing (+ 1 skipped) — was 1958 baseline; +4 new tests in `dspy-offline-optimizer.test.ts` (2 — `optimizer_choice` default + override) and `optimizer-factory.test.ts` (2 — `dspyOptimizerChoice` flow-through).

**Deferred to follow-up**: a real `dspyClientFactory` wiring inside `index.ts` that connects to the spawned `quilin-optimizer` MCP server through the existing `MCPClientManager`. Until that lands, `createOfflineOptimizer({ choice: "dspy" })` falls back to `PromptRewriteOptimizer` with a warn-level log even when the optimizer server is spawned. Tracked as a Stage C+ follow-up.

**实现实证（Stage C，2026-05-10）** —— 真实 DSPy 集成已在本 worktree 落地（master cherry-pick 待 review）。下游消费者参考点：

- `providers/optimizer/pyproject.toml` —— 在 `[project.optional-dependencies] dspy` 下加入 `dspy-ai>=2.5`；默认安装**不**拉 dspy-ai（依赖体量重）。
- `providers/optimizer/src/quilin_optimizer/server.py` —— Stage C 主体：lazy `import dspy`、`OptimizerConfig.from_env` 读取 `QUILIN_OPTIMIZER_JUDGE_{MODEL,API_KEY,BASE_URL}`、按 `optimizer_choice` 参数分发 MIPROv2 与 GEPA、四道优雅降级门（extra 缺失 / key 缺失 / trainset < 5 / compile 失败 → 空 proposals + 结构化 `insufficient_signal` 原因）。
- `providers/optimizer/tests/test_server.py` + `test_server_real_dspy.py` —— 44 个测试全部通过，`server.py` line coverage 99%（pyproject `--cov-fail-under=95` 强制）；通过 `sys.modules` 注入伪造 dspy 让测试无需安装重型 extra。
- `packages/agent-core/src/self-evolution/dspy-offline-optimizer.ts` —— 新增 `DspyOptimizerChoice = "mipro" | "gepa"` 类型；`optimizerChoice` 选项作为 `optimizer_choice` 参数转发给 Python `optimize` 工具。
- `packages/agent-core/src/self-evolution/optimizer-factory.ts` —— factory options 支持 `dspyOptimizerChoice`，串到 `DspyOfflineOptimizer`。
- `packages/agent-core/src/config/user-config-schema.ts` —— `selfEvolutionConfigSchema` 扩展 `optimizer_choice: z.enum(["mipro", "gepa"]).default("mipro")`。
- `packages/agent-core/src/config/loader.ts` —— 默认 capabilities config 新增 `quilin-optimizer` MCP server，门控为：（a）`providers/optimizer/` 目录存在 **并且**（b）`QUILIN_OPTIMIZER_JUDGE_API_KEY` 环境变量已配置；任一不满足则不 spawn。
- TS 测试数：1962 通过（+1 跳过）—— baseline 1958；新增 4 条测试，分布在 `dspy-offline-optimizer.test.ts`（2 条：`optimizer_choice` 默认 + 覆盖）和 `optimizer-factory.test.ts`（2 条：`dspyOptimizerChoice` 流转）。

**待后续完成**：在 `index.ts` 通过现有 `MCPClientManager` 连接到已 spawn 的 `quilin-optimizer` MCP server 的真实 `dspyClientFactory` 接线。在该 follow-up 落地前，`createOfflineOptimizer({ choice: "dspy" })` 即使 optimizer server 已 spawn 也会退化到 `PromptRewriteOptimizer` 并 warn-level 打日志。作为 Stage C+ follow-up 跟踪。

**Stage D — Benchmark validation ([Linear QUI-147](https://linear.app/quilin-agent/issue/QUI-147), blocked by QUI-146)**: Build trajectory-replay harness and run a 3-way A/B against `PromptRewriteOptimizer` baseline / DSPy + MIPROv2 / DSPy + GEPA. Decision branches: lift ≥ 30% → make DSPy default; lift 10–30% → DSPy stays opt-in; lift < 10% → trigger Stage E follow-up to evaluate Trace optimizer / OPRO / PromptBreeder alternatives. Detailed acceptance criteria tracked on the issue.

**Stage D — Benchmark 验证（[Linear QUI-147](https://linear.app/quilin-agent/issue/QUI-147)，blocked by QUI-146）**：建立 trajectory-replay 框架并跑 3-way A/B：`PromptRewriteOptimizer` 基线 / DSPy + MIPROv2 / DSPy + GEPA。决策分支：lift ≥ 30% → DSPy 转默认；lift 10–30% → DSPy 仍 opt-in；lift < 10% → 触发 Stage E follow-up 评估 Trace optimizer / OPRO / PromptBreeder 等替代算法。详细验收以 issue 为准。

**Stage E (conditional, not pre-created)**: only kicked off if Stage D shows MIPROv2 + GEPA lift insufficient. Will evaluate Trace optimizer (UCSD 2024, multi-step trace-level feedback — agent-flow-friendly but unverified), OPRO (Google 2023, simpler LLM-as-optimizer), or PromptBreeder (DeepMind 2023, self-referential mutation operators). Per Linear free-plan budget discipline, this issue is not pre-created.

**Stage E（条件触发，未预创建）**：仅当 Stage D 显示 MIPROv2 + GEPA 提升不够时才启动。届时评估 Trace optimizer（UCSD 2024，多步 trace-level 反馈 —— 对 agent flow 友好但未广泛验证）、OPRO（Google 2023，更简单的 LLM-as-optimizer）或 PromptBreeder（DeepMind 2023，自指 mutation 算子）。按 Linear 免费额度纪律，本 issue 暂不预创建。

**Why split C and D into separate Linear issues**: Stage D is blocked by Stage C (you can't benchmark code that doesn't exist), but it has independent acceptance evidence (benchmark dataset + validation report) and can run in parallel with Stage C development for the dataset-curation slice. The split lets Stage C land + cherry-pick before benchmark data is fully curated.

**为什么把 C 和 D 拆成独立 Linear issue**：Stage D 被 Stage C 阻塞（不存在的代码无法被 benchmark），但它有独立的验收证据（benchmark 数据集 + 验证报告），且数据策划那一段可以与 Stage C 工程实现并行。拆分让 Stage C 落地 cherry-pick 不必等到 benchmark 数据策划完成。

**Stage D Validation Outcome (2026-05-10, mocked harness only — round-2 numbers)** — Trajectory-replay harness `packages/agent-core/src/self-evolution/replay-harness.ts` and bench script `scripts/bench-self-evolution.ts` shipped on 2026-05-10 with cross-review round-2 fixes (Wilson CI now pooled across all seeds; mock client seed multiplier widened so 3 seeds produce non-degenerate variance; per-entry `sourceRefs`-targeted scoring). On the synthetic 50-trajectory corpus (`docs/10-self-evolution/benchmark/trajectories.jsonl`, covering 4 `FailureCategory` types — `tool_error`, `schema_violation`, `budget_exhaustion`, `missing_evidence`, plus one `unknown`), the 3-seed pooled run measured: baseline `PromptRewriteOptimizer` 24.0% [17.9%, 31.4%], DSPy MIPROv2 19.3% [13.8%, 26.4%] with relative lift 19.4%, DSPy GEPA 27.3% [20.8%, 35.0%] with relative lift **−13.9%** (i.e., GEPA regressed below baseline). **Only MIPROv2 produced a positive lift; GEPA was worse than baseline on this corpus.** **Important caveat**: both DSPy arms used a deterministic mock MCP client (no real `dspy-ai` install, no real LLM call), and the baseline / candidate confidence intervals overlap heavily — the 19.4% MIPROv2 lift is not statistically distinguishable at 95% on this 150-sample pool. The MIPROv2 number lands in the **10–30%** decision bucket which would keep DSPy opt-in if the lift were real. **Decision recorded as provisional** — real-LLM benchmarking against a curated production-trace corpus is the actual gate for the default-flip decision, and is deferred to a follow-up. The full report (Wilson 95% CI, ASCII chart, per-category breakdown including the `schema_violation` and `missing_evidence` regressions on the DSPy arms) is at [`docs/10-self-evolution/dspy-validation-report.md`](./dspy-validation-report.md). Linear issue: [QUI-147](https://linear.app/quilin-agent/issue/QUI-147).

**Stage D 验证产出（2026-05-10，仅 mock harness — round-2 数据）** —— 轨迹回放 harness `packages/agent-core/src/self-evolution/replay-harness.ts` 与 bench 脚本 `scripts/bench-self-evolution.ts` 已于 2026-05-10 落地，并经过 cross-review round-2 修正（Wilson CI 现按全部 seeds 池化、mock client 的 seed 乘子加宽让 3 seed 之间产生真实方差、按 `sourceRefs` 做 per-entry 定向评分）。在合成的 50 条轨迹语料（`docs/10-self-evolution/benchmark/trajectories.jsonl`，覆盖 4 个 `FailureCategory` —— `tool_error` / `schema_violation` / `budget_exhaustion` / `missing_evidence`，外加一条 `unknown`）上 3-seed 池化跑出：baseline `PromptRewriteOptimizer` 24.0% [17.9%, 31.4%]、DSPy MIPROv2 19.3% [13.8%, 26.4%]（相对 lift 19.4%）、DSPy GEPA 27.3% [20.8%, 35.0%]（相对 lift **−13.9%**，即 GEPA 在本语料上比 baseline 还差）。**只有 MIPROv2 跑出正 lift；GEPA 在本语料上回退**。**关键限制**：两个 DSPy arm 都用了确定性 mock MCP client（没有装真实 `dspy-ai`，也没有调用真实 LLM），且 baseline / candidate 的置信区间高度重叠 —— 19.4% 的 MIPROv2 lift 在 150-sample 池子上 95% 置信下并不能与 baseline 显著区分。MIPROv2 数字按 lift bucket 划分落在 **10–30%**，即"DSPy 仍 opt-in"（如果 lift 是真实的话）。**决策记录为暂定** —— 在策划好的真实 prod-trace 语料上跑真实 LLM 才是默认切换决策的正式 gate，推后到 follow-up。完整报告（Wilson 95% CI、ASCII 条形图、按类别拆分，含 DSPy 在 `schema_violation` 与 `missing_evidence` 的回退）见 [`docs/10-self-evolution/dspy-validation-report.md`](./dspy-validation-report.md)。Linear issue：[QUI-147](https://linear.app/quilin-agent/issue/QUI-147)。

**Next steps for Stage D follow-up / Stage D follow-up 的下一步**:

1. Curate ≥ 200 real production failure trajectories (current dataset is synthetic, 50 entries). Real prod traces are needed to make lift numbers meaningful.
2. Run the bench against a real `quilin-optimizer` MCP server connected to a real judge LLM (requires `QUILIN_OPTIMIZER_JUDGE_API_KEY` configured and `dspy-ai` installed). The Stage C+ wiring of `dspyClientFactory` in `index.ts` is the prerequisite.
3. Re-evaluate the lift bucket against the §2.4.0.1 decision rule with real numbers and decide whether to flip DSPy default, keep opt-in, or trigger Stage E.

1. 策划 ≥ 200 条真实生产失败轨迹（当前语料是合成的 50 条）。真实 prod trace 才能让 lift 数字有意义。
2. 在真实 `quilin-optimizer` MCP server（连真实 judge LLM）上跑 bench（需要配置 `QUILIN_OPTIMIZER_JUDGE_API_KEY` 并安装 `dspy-ai`）。前置条件是 Stage C+ 把 `dspyClientFactory` 接到 `index.ts`。
3. 用真实数字根据 §2.4.0.1 决策规则重新评估 lift bucket，决定是否把 DSPy 转默认 / 保持 opt-in / 触发 Stage E。

### 2.4.1 提案审核 REPL 命令 / Proposal Review REPL Commands

The four review actions (list / approve / reject / apply) are exposed as REPL slash commands so a reviewer can drive the human-in-loop gate from the same TUI that runs the agent. Each command operates on the JSONL `proposalStore` (see `packages/agent-core/src/self-evolution/proposal-store.ts`); when the store is not configured the commands print a clear "store not configured" message instead of silently no-ops.

四个审核动作（list / approve / reject / apply）作为 REPL 斜杠命令暴露，评审人可以在运行 Agent 的同一 TUI 中操作 human-in-loop 闸门。每个命令都直接读写 JSONL `proposalStore`（见 `packages/agent-core/src/self-evolution/proposal-store.ts`）；若未配置 store，命令会打印明确的"store 未配置"提示，而不是静默 no-op。

| Command 命令 | Purpose 用途 | Notes 说明 |
|---|---|---|
| `/proposals [--limit N]` | List pending proposals as a TUI table. 列出待审提案 | Default limit 20; pass `--limit N` to expand. 默认 20 条，使用 `--limit N` 扩展 |
| `/proposal-approve <id> [--reviewer <name>] [--yes]` | Approve a pending proposal. 批准提案 | Approval is the human-in-loop gate for a CRITICAL scaffold-patch apply (07 §2.6.4): trust mode (`auto-low` / `auto-medium`) MUST NOT auto-skip the confirm prompt; only an explicit `--yes` opts out. 提案批准是 CRITICAL scaffold-patch apply 的 human-in-loop 闸门：trust mode 不会自动跳过确认，只有显式 `--yes` 才能 opt-out |
| `/proposal-reject <id> --reason "..." [--reviewer <name>]` | Reject a pending proposal. 拒绝提案 | `--reason` is a greedy flag — multi-word reasons without quotes are joined with single spaces; the reason is sanitized (C0/DEL stripped, length capped at 4096) before persistence. `--reason` 为贪婪 flag，多词 reason 无需引号也会以空格 join；持久化前会清洗（剔除 C0/DEL，限长 4096）|
| `/proposal-apply [--limit N]` | Apply approved proposals via WriteAuthority. 通过 WriteAuthority 应用已批准提案 | Each apply is gated by `WriteAuthority` with `origin:"user"` + `riskLevel:"critical"`; the gate's confirm decision is the merge-equivalent. 每次 apply 都通过 `WriteAuthority` 把关，`origin:"user"` + `riskLevel:"critical"`；gate 的 confirm 决策等价于合并 |

The typical workflow ties trajectory analysis to scaffold-patch application:

典型 workflow 把轨迹分析串到 scaffold-patch 应用：

```
trajectory failure
      │
      ▼ FailureAnalyzer + offline-optimizer
proposal generated → proposalStore (status=pending_review)
      │
      ▼ user runs `/proposals`
review pending list (TUI table)
      │
      ▼ user runs `/proposal-approve <id>`  or  `/proposal-reject <id> --reason "..."`
status → approved / rejected
      │
      ▼ user runs `/proposal-apply`
WriteAuthority gate (CRITICAL → confirm prompt unless --trust auto + --yes)
      │
      ▼ on confirm
patch applied → proposalStore (status=applied)
```

Each command also emits a telemetry event into the agent-run JSONL log (`proposal.approved` / `proposal.rejected` / `proposal.applied` / `proposal.apply_skipped` / `proposal.apply_failed`) so the audit trail can reconstruct who approved / rejected / applied which proposal, with the rejection reason hashed (not stored verbatim) to keep the log free of free-form reviewer text.

每个命令同时往 agent-run JSONL 日志写一条遥测事件（`proposal.approved` / `proposal.rejected` / `proposal.applied` / `proposal.apply_skipped` / `proposal.apply_failed`），让审计链路能够还原"谁批准/拒绝/应用了哪条提案"；拒绝 reason 以 hash 形式记录，不留自由文本，避免日志包含评审人原文。

### 2.5 技能自创系统（Voyager 启发）

> **与 [13-技能工程](../13-skills/README.md) 的分工（D-05 合同）**：
> - 本节聚焦"技能如何从成功轨迹被**提取**出来"（SkillManager.extract → 产出 `SkillDescriptor` 草稿）。
> - **写入权归 13-skills**：本领域**不**直接落盘 SKILL.md 文件，必须通过 13-skills 暴露的 `skill_manage(create|update|delete)` 工具提交，由 13-skills 做路径/大小/ frontmatter 校验后生效。这保证了 Skill CRUD 单写方，避免 10 和 13 两边并行写造成的索引失真。
> - 技能的**文件格式（SKILL.md + YAML frontmatter）、目录化索引、按需加载、在 system prompt 中的组装顺序、沙箱安全加载**由 13-skills 领域统一定义。
> - 两者共用同一个 `SkillDescriptor` TS interface（见 13-skills §2.x）——10-自进化负责**提取草稿并调用 `skill_manage`**，13-技能工程负责**持久化、索引与渲染**。

成功的任务执行轨迹不应该被丢弃——它们是可复用经验的原材料。SkillManager 负责将成功轨迹转化为可调用的"技能模板"。

**技能提取流程：**

```
成功轨迹 (TrajectoryEvent[])
        │
        ▼ SkillManager.extract(trajectory)
        │
        ├── 1. 意图模式识别：这个轨迹解决了什么类型的问题？
        │      → { intent_pattern: "查找并修复 Python 函数的 off-by-one 错误" }
        │
        ├── 2. 步骤序列提取：核心执行步骤是什么？
        │      → [ "search_file", "read_context", "identify_error",
        │           "apply_fix", "run_tests", "verify_output" ]
        │
        ├── 3. 参数化：将具体值替换为占位符
        │      → { file_pattern: "{target_file}",
        │           error_type: "{error_type}",
        │           fix_strategy: "{fix_strategy}" }
        │
        └── 4. 生成 SkillDescriptor 草稿 → 调用 `skill_manage(create, descriptor)` 提交到 13-skills
               {
                 "skill_id": "fix_python_off_by_one_v1",
                 "description": "修复 Python 函数的 off-by-one 边界错误",
                 "trigger_pattern": "off-by-one OR 边界错误 OR index error",
                 "steps": [...],
                 "params": {...},
                 "success_rate": 1.0,   # 初始值
                 "usage_count": 0,
                 "created_from": "task_20260413_042"
               }
               ↓
               13-skills.skill_manage("create", descriptor)
                 → 路径/大小/frontmatter 校验
                 → 写入 SKILL.md
                 → 更新 catalog 索引
                 → 返回 skill_id 或 validation_error
```

**技能复用逻辑：**

```
新任务到达
    │
    ▼ SkillManager.match(task_description)
    │
    ├── 向量相似度检索（embedding 比较）
    ├── 关键词触发匹配（trigger_pattern）
    │
    ├── 匹配成功（相似度 > 阈值）→ 提示 Agent："发现相关技能，建议参考"
    │         → Agent 决策：套用模板（跳过探索阶段）OR 自主执行
    │
    └── 匹配失败 → 正常执行，执行成功后提取新技能
```

**技能生命周期管理：**
- 版本控制：技能改进时生成新版本（`v1 → v2`），保留历史版本
- 成功率追踪：每次使用后更新 `success_rate = (成功次数) / (使用次数)`
- 淘汰机制：`success_rate < 0.3` 且 `usage_count > 5` → 自动标记为 `deprecated`
- 跨 Agent 共享：技能存储在共享 Skill Memory（Layer 4），所有 Agent 实例可访问

### 2.6 A/B 评估框架

没有客观的评估，就无法判断修改是改进还是退步。ABEvaluator 提供严格的对照实验。

**评估设计：**

```
修改方案生成
      │
      ▼
标准任务集（N=50 个代表性任务，按 task_type 均匀分布）
      │
      ├── 版本 A（原始 scaffold）执行所有任务 → 记录指标
      │
      └── 版本 B（修改后 scaffold）执行所有任务 → 记录指标
                                                      │
                                                      ▼
                                              ABResult 对比报告
```

**评估指标：**

| 指标 | 计算方式 | 权重 |
|------|---------|------|
| `success_rate` | 成功任务数 / 总任务数 | 0.50 |
| `avg_steps` | 平均执行步数（越少越好） | 0.20 |
| `avg_tokens` | 平均 token 消耗（越少越好） | 0.20 |
| `avg_duration_ms` | 平均耗时（越少越好） | 0.10 |

**综合得分**：
```
score = 0.50 * Δsuccess_rate
      - 0.20 * Δavg_steps      # 步数减少为正
      - 0.20 * Δavg_tokens     # token 减少为正
      - 0.10 * Δavg_duration   # 耗时减少为正
```

**决策规则（可配置）：**

```python
class ABDecisionPolicy:
    # 保留修改的条件（满足任一即保留）
    KEEP_CONDITIONS = [
        lambda r: r.success_rate_delta > 0.05,    # 成功率提升 >5%
        lambda r: r.token_delta < -0.10,          # token 消耗降低 >10%
    ]

    # 强制回滚的条件（满足任一即回滚）
    ROLLBACK_CONDITIONS = [
        lambda r: r.success_rate_delta < -0.03,   # 成功率下降 >3%
        lambda r: r.success_rate_delta < 0 and r.token_delta > 0.05,  # 成功率下降且 token 增加
    ]

    # 其余情况：保持当前版本，下次修改中包含更多数据后再评估
```

**回滚机制：**
任何修改都保存完整的 diff，可在 1 步内回滚：
```python
scaffold_manager.rollback(version="scaffold-v2.3.1")  # 立即生效
```

### 2.7 安全约束体系

自修改能力如果没有严格约束，可能导致 Agent 行为不可控。安全约束是整个系统的最高优先级设计。

**约束层次：**

```
┌─────────────────────────────────────────────────────────────┐
│                     安全约束体系                             │
│                                                             │
│  Layer 1：修改范围白名单（不可修改项）                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ • 安全护栏规则（07-safety-guardrails 中定义的规则）   │  │
│  │ • 权限控制逻辑（PermissionManager 的决策规则）        │  │
│  │ • 自进化模块本身的代码（防止自修改自修改逻辑）        │  │
│  │ • 人类审批接口（不能绕过人类确认）                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Layer 2：修改频率限制（所有 Level 都需人工 PR review）      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ • Level 1 proposal：最多 1 次/小时（开 PR 即计数）   │  │
│  │ • Level 2 proposal：最多 1 次/天                     │  │
│  │ • Level 3 proposal：最多 1 次/天                     │  │
│  │ • Level 4 proposal：最多 1 次/周                     │  │
│  │ • 连续 3 次 proposal 被 reject → 暂停自进化 48 小时 │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Layer 3：沙箱验证（修改上线前）                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ • 所有修改先在隔离沙箱中运行标准测试集               │  │
│  │ • 测试集通过率 < 90% → 阻止上线                     │  │
│  │ • 沙箱环境无法访问生产数据                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Layer 4：回滚保证                                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ • 所有修改保留完整 diff 和回滚脚本                   │  │
│  │ • 任何版本可在 1 步内回滚                            │  │
│  │ • 保留最近 20 个历史版本                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**人类审批流程（所有 Level 统一 PR 路径）：**

```
自进化引擎生成修改方案
        │
        ▼
发送审批请求（含：修改内容、理由、预期收益、风险评估、沙箱报告）
        │
        ├── 超过 SLA（Level 1: 24h / Level 2-3: 48h / Level 4: 7d）无响应 → 自动关 PR，记录待审批队列
        │
        ├── 人类拒绝 → 记录拒绝原因 → 送回失败分析器参考
        │
        └── 人类批准 → 进入沙箱验证 → A/B 评估 → 上线
```

### 2.8 前沿研究辅助（跟踪主流 Agent 框架的设计演进）

> Quilin 通过系统性研究主流 Agent 框架获取设计灵感，最终由人类评审后以原生方式纳入路线图——不做自动补丁注入。

自进化不只针对 Agent 自身行为，也包括对主流 Agent 框架设计演进的持续跟踪与模式提炼。

**研究流程：**

```
sync-upstreams.py 检测到参考项目 commit
        │
        ▼
git diff 提取变更内容
        │
        ▼
Claude 分析 diff：
  ① 这个变更涉及哪个设计维度？
  ② 我们的现有实现在这一维度处于什么位置？
  ③ 这个变更是否揭示了新的设计取舍？
  ④ 是否值得在 Quilin 的路线图中立项借鉴？
        │
        ├── 不相关 → 记录到 fusion-index.md（观察状态）
        │
        └── 相关 → 生成研究摘要与设计建议
                    │
                    ▼
              merge-with-claude.sh 生成研究报告 PR
                    │
                    ▼
              人类评审 → 决策是否立项 → 更新 fusion-index.md
```

**相关性判断逻辑（Claude prompt 关键部分）：**

```
判断标准：
1. 设计相关性：这个 diff 涉及的设计维度是否在我们的研究计划中？
   参考 fusion-index.md 中的"研究中"或"规划中"条目
2. 启发价值：该变更是否揭示了我们尚未覆盖的设计取舍？
3. 兼容性：借鉴这个设计是否会破坏我们现有的架构约束？
4. 工作量：立项跟进大约需要多少工作量？

输出格式：
{
  "relevance": "high|medium|low|none",
  "affected_components": ["组件列表"],
  "integration_suggestion": "具体建议",
  "estimated_effort": "small|medium|large"
}
```

### 2.9 User Insight Engine（用户洞察引擎）

User Insight Engine 是自进化系统的一个子系统，专注于从用户行为数据中挖掘模式、产生洞察、实现 Aha Moment。

**核心理念**：好的 Agent 能帮用户觉察到自己都注意不到的事情。不是被动等待使用，而是主动理解用户、持续学习、在恰当时机给出让人惊喜的洞察。

**数据来源**：
- quilin-mem Layer 3（Semantic Memory）中的用户相关知识
- quilin-mem Layer 4（Skill Memory）中用户常用技能模式
- User Profile Store 中的用户画像
- TrajectoryStore 中的用户交互轨迹
- 02-Context 的时间感知数据（活跃时段、工作节奏）

**洞察类型**：

| 类型 | 示例 | 触发条件 |
|------|------|---------|
| **行为模式发现** | "你最近 3 天每次都在凌晨 2 点问 debug 问题，要不要设个提醒早点处理？" | 时间模式重复 >= 3 次 |
| **效率瓶颈识别** | "你在 CSS 布局问题上平均花费的时间是其他任务的 3 倍，要不要看一下 Flexbox 速查？" | 某类任务耗时显著高于均值 |
| **知识缺口提醒** | "你最近连续问了 5 个 TypeScript 泛型问题，要不要系统学习一下？" | 同一知识点反复提问 |
| **工作节奏洞察** | "你连续工作 6 小时了，上次这么长时间后你犯了几个低级错误" | 连续工作时长超过历史舒适区 |
| **项目进展感知** | "你已经 3 天没碰 Project X 了，上次说要这周完成的" | 项目活跃度下降 |
| **工具使用建议** | "你经常手动做 X，其实可以用 Y 工具自动化" | 重复人工操作模式 |

**运行机制**：

```
TrajectoryStore + User Profile + quilin-mem
         │
         ▼
  InsightMiner（后台异步运行，不阻塞主 Loop）
  │
  ├── 时间模式分析：检测重复的时间行为模式
  ├── 效率分析：对比不同任务类型的耗时分布
  ├── 知识图谱分析：从 KG 中发现知识缺口
  └── 行为序列分析：识别可自动化的重复操作
         │
         ▼
  InsightQueue（洞察队列，按紧急度排序）
         │
         ▼
  InsightDelivery（时机选择 + 表达策略）
  │
  ├── 紧急洞察：立即在当前对话中提出
  ├── 一般洞察：在下次对话开始时自然引入
  └── 低优先级：存入 Dashboard 供用户自行查看
```

**关键接口**：

```python
class InsightEngine(Protocol):
    async def mine_insights(self, user_id: str) -> list[Insight]: ...
    async def should_deliver(self, insight: Insight, context: ConversationContext) -> bool: ...
    async def format_delivery(self, insight: Insight) -> str: ...

@dataclass
class Insight:
    insight_type: str       # "behavior_pattern" | "efficiency" | "knowledge_gap" | "rhythm" | "progress" | "tool_suggestion"
    confidence: float       # 0.0 ~ 1.0，低于 0.7 不推送
    evidence: list[str]     # 支撑这个洞察的具体证据
    message: str            # 面向用户的自然语言表达
    urgency: str            # "immediate" | "next_session" | "dashboard_only"
    actionable: bool        # 是否包含可执行的建议
```

**与时间感知的协作**：InsightEngine 利用 02-Context 的时间感知数据构建用户时间画像（何时高效、何时疲劳、何时容易犯错），并在合适的时机推送相关洞察。

### 2.10 核心接口定义

```python
from typing import Protocol, runtime_checkable
from dataclasses import dataclass
from enum import Enum

# ── 轨迹记录 ──────────────────────────────────────────────────────

class EventType(str, Enum):
    TASK_START = "TaskStart"
    INTENT_RECOGNIZED = "IntentRecognized"
    PLAN_CREATED = "PlanCreated"
    STEP_START = "StepStart"
    TOOL_CALL = "ToolCall"
    TOOL_RESULT = "ToolResult"
    STEP_END = "StepEnd"
    TASK_END = "TaskEnd"

@dataclass
class TrajectoryEvent:
    event_type: EventType
    task_id: str
    step_id: int
    timestamp: str
    data: dict
    metadata: dict

@runtime_checkable
class TrajectoryStoreProtocol(Protocol):
    def record(self, event: TrajectoryEvent) -> None: ...
    def get_failures(
        self,
        task_type: str | None = None,
        limit: int = 100,
        since_version: str | None = None,
    ) -> list[TrajectoryEvent]: ...
    def get_successes(self, task_type: str | None = None, limit: int = 100) -> list[TrajectoryEvent]: ...
    def get_stats(self) -> dict: ...  # 返回成功率、平均步数等统计信息

# ── 失败分析 ──────────────────────────────────────────────────────

class FailureCategory(str, Enum):
    WRONG_TOOL_SELECTION = "WRONG_TOOL_SELECTION"
    REASONING_BIAS = "REASONING_BIAS"
    INSUFFICIENT_CONTEXT = "INSUFFICIENT_CONTEXT"
    WRONG_STRATEGY = "WRONG_STRATEGY"
    INFINITE_LOOP = "INFINITE_LOOP"
    TIMEOUT_RESOURCE = "TIMEOUT_RESOURCE"
    TOOL_FAILURE = "TOOL_FAILURE"
    VERIFICATION_GAP = "VERIFICATION_GAP"

@dataclass
class FailureAnalysis:
    task_id: str
    failure_step: int
    failure_category: FailureCategory
    root_cause: str
    affected_scaffold_component: str | None  # "system_prompt" | "tool_config" | "strategy" | "workflow"
    modification_suggestion: str
    confidence: float  # 0.0 - 1.0

@runtime_checkable
class FailureAnalyzerProtocol(Protocol):
    async def analyze(self, trajectory: list[TrajectoryEvent]) -> FailureAnalysis: ...
    async def aggregate_patterns(self, failures: list[FailureAnalysis]) -> list[dict]: ...

# ── Scaffold 修改 ─────────────────────────────────────────────────

class ModificationLevel(int, Enum):
    SYSTEM_PROMPT = 1    # 系统提示调整（自动）
    TOOL_CONFIG = 2      # 工具配置修改（自动）
    STRATEGY = 3         # 推理策略切换（需人类确认）
    WORKFLOW = 4         # 工作流重构（需人类确认）

@dataclass
class ScaffoldModification:
    level: ModificationLevel
    target: str           # 修改的具体目标路径
    operation: str        # "append" | "replace" | "delete" | "insert"
    content: str | dict   # 修改内容
    rationale: str        # 修改理由（引用失败分析）
    confidence: float     # LLM 对这个修改的置信度

@runtime_checkable
class ScaffoldModifierProtocol(Protocol):
    async def generate_proposals(
        self,
        pattern_report: list[dict],
    ) -> list[ScaffoldModification]: ...

    async def apply(
        self,
        modification: ScaffoldModification,
        sandbox: bool = True,
    ) -> str: ...  # 返回新版本号

    def rollback(self, version: str) -> None: ...
    def list_versions(self) -> list[dict]: ...

# ── 技能管理 ──────────────────────────────────────────────────────

@dataclass
class Skill:
    skill_id: str
    description: str
    trigger_pattern: str
    steps: list[dict]
    params: dict
    success_rate: float
    usage_count: int
    version: int
    status: str  # "active" | "deprecated"

@runtime_checkable
class SkillManagerProtocol(Protocol):
    async def extract(self, trajectory: list[TrajectoryEvent]) -> Skill | None: ...
    async def match(self, task_description: str) -> list[Skill]: ...
    def update_stats(self, skill_id: str, success: bool) -> None: ...
    def deprecate(self, skill_id: str) -> None: ...

# ── A/B 评估 ──────────────────────────────────────────────────────

@dataclass
class ABResult:
    version_a: str
    version_b: str
    success_rate_a: float
    success_rate_b: float
    success_rate_delta: float
    avg_steps_delta: float
    avg_tokens_delta: float
    avg_duration_delta: float
    composite_score: float
    decision: str  # "keep_b" | "keep_a" | "inconclusive"
    details: dict

@runtime_checkable
class ABEvaluatorProtocol(Protocol):
    async def evaluate(
        self,
        version_a: str,
        version_b: str,
        task_set: list[dict] | None = None,  # None 使用标准任务集
    ) -> ABResult: ...

# ── 自进化主引擎 ──────────────────────────────────────────────────

@runtime_checkable
class SelfEvolutionEngineProtocol(Protocol):
    async def run_cycle(self) -> dict: ...
    """
    执行一轮完整的自进化闭环：
    1. 从 TrajectoryStore 读取最近失败轨迹
    2. 调用 FailureAnalyzer 分析失败模式
    3. 调用 ScaffoldModifier 生成修改方案
    4. 执行修改（含人类审批流程）
    5. 调用 ABEvaluator 评估效果
    6. 决定保留或回滚
    7. 返回本轮摘要报告
    """

    async def extract_skills(self) -> list[Skill]: ...
    """从最近成功轨迹中提取技能"""

    def get_evolution_history(self) -> list[dict]: ...
    """返回历史自进化记录"""
```

### 2.11 用户自助吸收（User Self-Evolution）

> **核心理念**：用户不是被动接收官方更新的消费者，而是 Agent 能力生态的共建者。

自进化不仅是官方单向推送——用户可以自己发现并吸收 GitHub 上的仓库来升级自己的 Agent 实例，形成 **Agent 能力的 git 生态**。

**运作模型（类 git fork/merge）：**

```
用户："吸收 https://github.com/xxx/yyy"
    │
    ▼
Quilin 运行标准化深度调研（6 步流程，见 deep-code-research-methodology.md）
    │
    ▼
生成调研报告 + 吸收计划（展示给用户："发现 3 个可吸收功能"）
    │
    ▼
用户确认选择（"吸收第 1、3 项"）
    │
    ▼
生成 Scaffold 补丁（仅修改 scaffold：提示词 / 工具配置 / 工作流定义）
    │
    ▼
本地验证（运行标准测试集，确认吸收后表现不退化）
    │
    ▼
应用补丁 + 创建回滚点
    │
    ▼
变更上报官方（可选）
    │
    ├── 官方接受 → 合入主线，所有用户受益
    │
    └── 官方不接受 → 用户保留本地版本
         │
         └── 未来官方更新时，本地需要冲突检测与解决
```

**设计约束：**

| 约束 | 说明 |
|------|------|
| 仅修改 scaffold | 用户自助吸收不触碰核心代码，只修改提示词、工具配置、工作流定义 |
| 一键回滚 | 每次吸收自动创建回滚点，吸收后表现变差可立即回退 |
| 完全透明 | 用户能看到"改了什么、为什么改、预期效果是什么" |
| 共享基础设施 | 与官方自进化（2.4 Scaffold 自修改）共享同一套补丁系统 |

**冲突检测与解决：**

当用户本地有自助吸收的补丁，同时官方发布新版本时：

```
官方新版本到达
    │
    ▼
检测本地补丁与官方更新是否冲突
    │
    ├── 无冲突 → 自动合并（官方更新 + 本地补丁共存）
    │
    ├── 有冲突但可自动解决 → 生成合并建议，用户确认
    │
    └── 有冲突且需人工决策 → 展示冲突详情，用户选择：
         ├── 保留本地版本（跳过此官方更新）
         ├── 采用官方版本（丢弃本地补丁）
         └── 手动合并（交互式解决）
```

**与前沿研究（2.8）的关系**：
- 2.8 是**官方**对参考项目的自动变更跟踪与研究摘要
- 2.11 是**用户**对任意 GitHub 仓库的自助吸收
- 两者共享同一套调研流程；当前执行口径以本 README 为准
- 两者产出的补丁格式相同，通过同一套 Scaffold 修改系统应用

### 2.12 空闲自进化经济学（Idle Evolution Budget, 默认关闭）

> **D-01 决策（2026-04-17 ultra-review）**：Idle Evolution 默认 **OFF**，用户需在 `config.yaml` 中显式 opt-in (`idle_evolution.enabled: true`) 并设置预算。空闲期间产生的所有 scaffold proposal 仍需走 §2.4 的 human-in-loop PR，不会自动合入生产。

> **核心理念**：用户不在时，Agent 可以做**可回滚的准备工作**（整理记忆、提炼 proposal 草稿），但不会悄悄改变自己的行为。

大多数 Agent 在用户离开后完全闲置。Quilin 的设计哲学是：**用户离开的时间是 Agent 生成 proposal 的合适窗口**——不抢用户资源、不阻塞交互、不自动修改生产 scaffold。

#### 两种计费模式

| 模式 | 适用场景 | 预算来源 | 触发条件 |
|------|---------|---------|---------|
| **订阅套餐模式** | 用户按月/年订阅 | 闲置配额（不用白不用） | 用户空闲 + 配额有剩余 |
| **API 接入模式** | 用户按量付费 | 用户设置的每日自进化预算上限 | 用户空闲 + 当日预算未耗尽 |

#### 空闲检测机制

复用 02-Context 时间感知的 **gap 检测**（`DepartureContext`）：

```python
@dataclass
class IdleEvolutionTrigger:
    """空闲自进化触发条件"""
    min_idle_minutes: int = 30          # 用户至少空闲 N 分钟才触发
    no_pending_tasks: bool = True       # 无未完成的 Sub-Agent 任务
    budget_remaining: bool = True       # 当日预算仍有余额
    within_allowed_hours: bool = True   # 在允许的时间窗口内（避免半夜消耗）

    def should_trigger(self, ctx: DepartureContext, budget: BudgetState) -> bool:
        return (
            ctx.gap_minutes >= self.min_idle_minutes
            and not budget.exhausted
            and self._within_time_window()
            and not self._has_pending_subtasks()
        )
```

#### 空闲时活动类型

按优先级排序（预算有限时优先执行高价值活动）：

| 优先级 | 活动类型 | 消耗 | 产出 | 频率 |
|--------|---------|------|------|------|
| P0 | **记忆整合** | 低（本地计算为主） | Working → Episodic 归档、去重、KG 补充 | 每次空闲 |
| P1 | **Scaffold proposal 草稿** | 中（需 LLM 调用） | 基于积累轨迹生成 Level 1-2 proposal（开 PR 等人审） | 每日最多 1 轮 |
| P2 | **技能库扩充** | 中 | 从成功轨迹提取新技能、验证已有技能 | 每日最多 1 轮 |
| P3 | **浏览用户相关内容** | 高（浏览器 + LLM） | 用户关注领域的新动态、趋势摘要 | 每周 2-3 次 |
| P4 | **前沿跟踪加速** | 高 | 主动识别参考项目的设计演进与可借鉴模式 | 有新上游变更时 |

#### 预算核算协议

```python
@dataclass
class IdleBudgetState:
    """空闲自进化预算状态"""
    mode: str                           # "subscription" | "api"
    
    # 订阅模式
    monthly_quota_total: int = 0        # 月总配额（token）
    monthly_quota_used: int = 0         # 已使用
    idle_allocation_pct: float = 0.2    # 最多用剩余配额的 20% 做自进化
    
    # API 模式
    daily_budget_tokens: int = 0        # 每日自进化 token 上限
    daily_used_tokens: int = 0          # 今日已消耗
    
    def remaining(self) -> int:
        if self.mode == "subscription":
            idle_cap = int((self.monthly_quota_total - self.monthly_quota_used) * self.idle_allocation_pct)
            return max(0, idle_cap - self.daily_used_tokens)
        else:  # api
            return max(0, self.daily_budget_tokens - self.daily_used_tokens)
    
    @property
    def exhausted(self) -> bool:
        return self.remaining() <= 0
```

#### 透明汇报（Report-Back）

用户下次上线时，Agent 主动汇总空闲期间的活动：

```
🔄 空闲自进化报告（过去 8 小时）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 记忆整合：归档 23 条 Working 记忆 → Episodic，去重 5 条
🛠️ Scaffold 优化：系统提示微调 1 处（代码审查指令更清晰）
   → A/B 评估：成功率 +3.2%，已保留
📰 浏览摘要：发现 2 篇与你项目相关的新文章
   → [文章标题1] — 摘要...
   → [文章标题2] — 摘要...
💰 消耗：12,340 tokens（日预算剩余 87,660）
```

**汇报时机**：
- 用户首次发送消息时（非侵入式，可折叠）
- WebUI Dashboard 实时展示空闲活动日志
- 重大发现（如 scaffold 修改带来显著提升）可通过 IM 主动推送

#### 安全约束

| 约束 | 说明 |
|------|------|
| **默认关闭** | `idle_evolution.enabled` 默认 `false`，用户显式 opt-in 才生效 |
| 仅生成 Level 1-2 proposal | 空闲期间不生成 Level 3-4 提案，已生成的 proposal 必须走人工 PR |
| 不自动应用 scaffold | 即使 Level 1，也只能开 PR 等待人工合并（沿用 §2.4 决策） |
| 预算硬上限 | 超出预算立即停止，不借用下一日额度 |
| 活动白名单 | 仅允许上述 5 种活动类型，不执行任何用户任务 |
| 沙箱隔离 | 所有 scaffold proposal 在沙箱中验证，不影响生产环境 |
| 可随时关闭 | 用户可在 config.yaml 中 `idle_evolution.enabled: false` 立即停止 |

#### 与其他组件的协作

```
02-Context（时间感知）
    └── DepartureContext.gap_minutes → 判断用户是否空闲
    └── AbsoluteTimeAwareness → 判断当前是否在允许时间窗口

03-Memory（quilin-mem）
    └── 空闲时执行 Working → Episodic 归档、去重、KG 补充

05-Tool（浏览器）
    └── 空闲时浏览用户关注领域的网页内容

06-Multi-Agent（Sub-Agent）
    └── 确认无 pending Sub-Agent 任务后才触发空闲进化

08-Observability
    └── 记录空闲活动日志，供 Dashboard 展示

10-Self-Evolution（2.4 Scaffold 自修改）
    └── 空闲时运行 run_cycle() 的 Level 1-2 proposal 生成部分（PR 开给用户）
```

---

## 三、Top 10 参考项目

| # | 项目 | Stars | 核心吸收点 | 深度 |
|---|------|-------|-----------|------|
| 1 | **DSPy** (Stanford NLP) | ~23k | Optimizer/Compiler 设计、BootstrapFewShot/MIPROv2、签名式 prompt 编程 | 深入 |
| 2 | **Voyager** (MineDojo/NVIDIA) | ~6k | 技能库 Skill Library、Automatic Curriculum、代码生成验证循环 | 深入 |
| 3 | **OpenHands** (OpenDevin) | ~71k | AgentController、Observation/Action 循环、轨迹记录格式、沙箱执行 | 深入 |
| 4 | **SWE-agent** (Princeton/Stanford) | ~19k | ACI 设计、搜索/编辑/测试工具链、轨迹回放（run_replay.py） | 深入 |
| 5 | **ADAS** (UBC/Vector Institute) | ~1.5k | Meta Agent Search、Agent 搜索空间定义、代码级自修改 | 深入 |
| 6 | AutoGPT Forge | ~170k | Agent 基准框架、标准化评估接口 | 观察 |
| 7 | **Eureka** (NVIDIA) | ~2.5k | LLM 驱动奖励函数生成、进化式优化循环 | 观察 |
| 8 | **LATS** (Language Agent Tree Search) | ~1.5k | 蒙特卡洛树搜索、价值函数、自我反思 | 观察 |
| 9 | AgentTuning (THU) | ~1.5k | Agent 指令微调数据集、多任务泛化 | 观察 |
| 10 | GEPA (Hermes Agent) | — | 通用自进化协议框架（DSPy 内置实验性优化器）| 观察 |

---

## 四、吸收内化方案

### 4.1 DSPy → 自进化中的 Prompt 优化层

**DSPy 的核心洞察**（Stanford NLP, 2022-2026）：

将 prompt 工程视为**优化问题**而非手工艺。开发者定义"签名"（输入/输出类型约束），DSPy 的 Optimizer 自动搜索最优的指令和少样本示例组合。

**吸收的具体设计：**

1. **签名式 Prompt 编程**：在 Quilin 中，将系统提示的各个功能区分离为独立的"签名模块"，每个模块有明确的输入/输出定义。这使得 FailureAnalyzer 能够精准定位哪个模块需要优化，而不是把整个系统提示当作黑盒处理。

2. **BootstrapFewShot 启发**：ScaffoldModifier 的 Level 1 修改（系统提示调整）参考 DSPy 的 BootstrapFewShot 设计：从成功轨迹中自动提取高质量的少样本示例，补充到系统提示的示例区。

3. **MIPROv2 的贝叶斯搜索启发**：当单次修改效果不确定时，生成多个候选修改方案（不同的指令表达方式、不同的约束强度），通过 ABEvaluator 对比选出最优方案，而不是每次只尝试一个修改。

4. **BetterTogether 策略**：DSPy 2.0 的双阶段优化（先优化 prompt，再用 GRPO 微调权重）启示我们：自进化可以分两个层次——先通过修改 scaffold（prompt 层）快速迭代，积累到足够数据后生成微调数据集（提供给模型提供商做定向微调）。

**与 Harness 的映射：**
- `FailureAnalyzer.analyze()` → 类似 DSPy 的 trace 分析
- `ScaffoldModifier.generate_proposals()` → 类似 MIPROv2 的候选生成
- `ABEvaluator.evaluate()` → 类似 DSPy 的编译评估循环

### 4.2 Voyager → 技能自创系统

**Voyager 的核心洞察**（UT Austin + NVIDIA, 2023, TMLR 2024）：

在开放世界（Minecraft）中，Agent 通过三个组件实现终身学习：
1. **Automatic Curriculum**：自动生成递增难度的任务，确保持续探索
2. **Skill Library**：将成功的可执行代码存储为技能，按 embedding 索引
3. **迭代 Prompting 机制**：结合环境反馈、错误信息、自我验证持续改进代码

Voyager 实测：获得 3.3× 更多独特物品，技术树解锁速度 15.3× 于基线。

**吸收的具体设计：**

1. **Skill Library → SkillManager**：直接对应。不同之处在于：Voyager 的技能是 Minecraft 代码（JavaScript），我们的技能是 Agent 执行模板（步骤序列 + 参数化）。两者都按 embedding 索引，都支持组合（小技能合成大技能）。

2. **Automatic Curriculum 启发**：SkillManager 跟踪任务难度分布。当某类任务的技能库已经足够成熟（成功率 > 90%）时，SelfEvolutionEngine 会主动生成更高难度的测试任务，推动 Agent 持续学习边界情况。

3. **迭代 Prompting → 技能验证循环**：新提取的技能不直接进入 Active 状态，而是在沙箱中运行验证任务，通过后才激活。这对应 Voyager 的"代码生成→执行→错误修正→验证"循环。

4. **零样本泛化**：Voyager 最令人印象深刻的结果是：在新 Minecraft 世界中直接使用学到的技能解决新问题。对应我们的设计：技能模板的参数化程度要足够高，能在不同但相似的任务中复用，而不是过拟合到特定任务。

### 4.3 OpenHands → 轨迹记录设计

**OpenHands 的核心洞察**（原 OpenDevin，~71k Stars）：

OpenHands 的 AgentController 实现了严格的 **Observation/Action 交替记录**模式：每个 Action（Agent 决定做什么）之后必然产生一个 Observation（环境反馈），两者作为一对记录，构成完整的执行轨迹。

**吸收的具体设计：**

1. **Action/Observation 配对模式**：我们的 TrajectoryEvent 格式借鉴这种严格配对设计。`ToolCall`（Action）和 `ToolResult`（Observation）总是成对出现，便于后续分析"什么动作产生了什么结果"。

2. **轨迹回放**（OpenHands Issue #6049, 2025.3 完成）：OpenHands 实现了完整的轨迹回放功能（GUI + headless 模式），我们借鉴这个设计来实现 ABEvaluator 中的"重放验证"——在沙箱中回放历史轨迹，验证修改后的 scaffold 是否能产生不同（更好）的结果。

3. **步骤循环设计**：OpenHands 的 `AgentController.step()` 循环设计（从 PR #176 可见演变历程）为我们的 `SelfEvolutionEngine.run_cycle()` 提供了架构参考：单步执行、结果检查、状态更新的严格顺序。

4. **沙箱验证**：OpenHands 的 Docker 沙箱设计（已集成到我们的 09-deployment-runtime 文档）直接用于自进化中的修改验证——修改后的 scaffold 在隔离容器中运行，不影响生产环境。

### 4.4 SWE-agent → 工具链优化启发

**SWE-agent 的核心洞察**（Princeton + Stanford, NeurIPS 2024, ~19k Stars）：

**Agent-Computer Interface（ACI）**的核心理念：专门为 Agent 设计工具接口，而不是直接暴露原始系统接口。好的 ACI 让 Agent 更少出错、更高效地完成任务。

**吸收的具体设计：**

1. **ACI 设计原则 → FailureAnalyzer 的 `WRONG_TOOL_SELECTION` 类失败**：当 FailureAnalyzer 检测到频繁的工具选择错误时，ScaffoldModifier 的 Level 2 修改应当从 ACI 视角重新设计工具描述（而不仅仅是换工具）——让工具对 Agent 更友好，减少误用。

2. **搜索/编辑/测试三步工作流**：SWE-agent 的核心工作流（`search_file → view_file → edit_file → run_test`）被提炼为技能模板，存入 SkillManager 作为代码修改类任务的标准技能。

3. **轨迹回放**（`run_replay.py`）：SWE-agent 的回放功能是 OpenHands 实现相同功能的灵感来源。我们的 ABEvaluator 在评估时使用类似的回放机制，确保评估的可重现性。

4. **自动化回归测试验证**：SWE-agent 在每次代码修改后自动运行测试套件来验证修改是否正确，对应我们的 ABEvaluator 中的"修改验证"步骤——在标准任务集上验证 scaffold 修改的效果。

### 4.5 ADAS → 元级自修改能力

**ADAS 的核心洞察**（UBC + Vector Institute, ICLR 2025 Outstanding Paper, ~1.5k Stars）：

**Meta Agent Search**：一个"元 Agent"迭代生成新的 Agent 设计（以代码形式定义），评估每个设计的性能，将好的设计加入档案，持续搜索更好的设计。关键发现：**programming languages are Turing Complete**，这意味着在代码空间搜索理论上能找到任何可能的 Agent 设计。实测：F1 提升 13.6 分（阅读理解），准确率提升 14.4%（数学）。

**吸收的具体设计：**

1. **搜索空间定义**：ADAS 的核心贡献是明确定义了"什么可以被自动修改"（搜索空间）。对应我们的设计：ScaffoldModification 的 Level 矩阵（1-4）就是我们的搜索空间定义，比 ADAS 更保守但也更安全。

2. **Meta Agent 概念**：在 Level 4（工作流重构）的修改中，我们引入一个专用的"Meta Agent"角色（由更强的模型驱动），负责审视整个工作流设计并提出重构方案。这区别于普通的失败分析——Meta Agent 的视角更宏观，能发现跨步骤的系统性问题。

3. **档案积累（Archive）**：ADAS 的"ever-growing archive of previous discoveries"对应我们的技能库（SkillManager）和自进化历史记录（evolution_history）。每次修改的结果都存档，为后续修改提供参考。

4. **安全约束**：ADAS 论文明确指出其代码执行具有安全风险（"strongly advise users to be aware"）。我们在此基础上设计了严格的安全约束体系（见 2.7 节）和沙箱执行机制，确保自修改在受控环境中进行。

---

## 五、与 Harness 组件映射

### 5.1 模块文件映射

| 组件 | 文件路径 | 实现的 Protocol | 说明 |
|------|---------|----------------|------|
| `SelfEvolutionEngine` | `quilin/evolution/engine.py` | `SelfEvolutionEngineProtocol` | 自进化主循环，协调所有子组件 |
| `TrajectoryStore` | `quilin/evolution/trajectory.py` | `TrajectoryStoreProtocol` | 轨迹记录/查询，SQLite 持久化 |
| `FailureAnalyzer` | `quilin/evolution/analyzer.py` | `FailureAnalyzerProtocol` | LLM 驱动的失败模式分析 |
| `ScaffoldModifier` | `quilin/evolution/self_modify.py` | `ScaffoldModifierProtocol` | Scaffold 四级自修改 |
| `SkillManager` | `quilin/evolution/skill_manager.py` | `SkillManagerProtocol` | 技能自创/复用/管理 |
| `ABEvaluator` | `quilin/evolution/evaluator.py` | `ABEvaluatorProtocol` | A/B 对照评估 |
| `PatternAggregator` | `quilin/evolution/aggregator.py` | — | 跨失败聚合分析（工具类） |

### 5.2 与其他 Harness 组件的集成关系

```
Quilin（主循环）
    │
    ├── 每次 run() 调用：TrajectoryStore.record() 实时记录事件
    │
    ├── 每次任务结束：
    │   ├── 成功 → SkillManager.extract() 尝试提取技能
    │   └── 失败 → 标记轨迹，触发 FailureAnalyzer（异步，不阻塞主循环）
    │
    └── 定时触发（默认每 6 小时）：SelfEvolutionEngine.run_cycle()

13-skills（SKILL.md 真源）+ quilin-mem Layer 4（usage counter 镜像）
    └── SkillManager 只产出"草案" → 经 07 §2.6.4 WriteAuthority + 13-skills `skill_manage` 工具落盘 SKILL.md
    └── SkillManager 查 13-skills 注册表获取可复用 skill；调用后仅更新 quilin-mem Layer 4 的 usage counter（不写 body）
    └── 真源始终是 `~/.quilin/skills/**/SKILL.md`（D-11 2026-04-20 NEW-11 修复：03-memory 不再双写 skill body）

Verifier（验证层）
    └── ABEvaluator 借用 Verifier 的沙箱执行能力运行评估任务

LLMRouter（LLM 层）
    └── FailureAnalyzer 使用"强模型"（默认 claude-opus-4-5）进行失败分析
    └── ScaffoldModifier 使用"中等模型"生成修改方案

sync-upstreams.py（脚本层）
    └── 触发前沿研究跟踪流程（AI 生成 diff 分析 + 研究摘要，人类决定是否立项）
    └── 读取 fusion-index.md 确定跟踪目标
```

### 5.3 数据流图

```
用户任务
    │
    ▼
Quilin.run()
    │
    ├──[实时]──→ TrajectoryStore.record(events)
    │                        │
    │                        └──[任务结束]──→ 标注 success/failure
    │
    ├──[成功]──→ SkillManager.extract(trajectory)
    │                        │
    │                        └──→ 产出 skill 草案 → `skill_manage(create)` + WriteAuthority 落盘 SKILL.md（13-skills 真源）
    │                             同步 upsert quilin-mem Layer 4 的 usage counter（仅计数，不存 body）
    │
    └──[失败]──→ FailureAnalyzer.analyze(trajectory) [异步]
                            │
                            ▼
                PatternAggregator.aggregate(recent_failures)
                            │
                            ▼
                ScaffoldModifier.generate_proposals(pattern)
                            │
                    ┌───────┴───────┐
                    │               │
               Level 1-2       Level 3-4
               (自动)          (人类审批)
                    │               │
                    └───────┬───────┘
                            │
                            ▼
                ABEvaluator.evaluate(v_old, v_new)
                            │
                    ┌───────┴───────┐
                    │               │
                  保留            回滚
                    │
                    ▼
               更新 scaffold_version
               写入 evolution_history
```

### 5.4 配置项（config.yaml）

```yaml
self_evolution:
  enabled: true
  cycle_interval_hours: 6          # 自进化循环触发频率
  trajectory:
    db_path: "~/.quilin/trajectories.db"
    max_records: 1000              # 最大保留轨迹数
    retention_days: 90             # 归档前保留天数
  failure_analysis:
    model: "claude-opus-4-5"       # 失败分析使用的模型（用强模型）
    min_failures_to_trigger: 5     # 至少 N 次失败才触发分析
    lookback_hours: 24             # 分析过去 N 小时的失败
  modification:
    level_1_cooldown_hours: 1      # Level 1 修改冷却时间
    level_2_cooldown_hours: 6      # Level 2 修改冷却时间
    level_3_cooldown_hours: 24     # Level 3 修改冷却时间（+人类确认）
    level_4_cooldown_hours: 168    # Level 4 修改冷却时间（+人类确认）
    max_consecutive_failures: 3    # 连续失败 N 次后暂停自进化
    human_approval_timeout_hours: 24
  skill_manager:
    embedding_model: "text-embedding-3-small"
    similarity_threshold: 0.75     # 技能匹配的最小相似度
    min_success_rate: 0.30         # 低于此值自动 deprecated
    min_usage_for_deprecation: 5   # 至少使用 N 次才评估淘汰
  ab_evaluator:
    standard_task_set_size: 50     # 标准评估任务集大小
    success_rate_keep_delta: 0.05  # 成功率提升超过此值则保留
    token_delta_keep: -0.10        # token 消耗降低超过此值则保留
    success_rate_rollback_delta: -0.03  # 成功率下降超过此值则回滚
  upstream_monitor:
    enabled: true
    sync_interval_minutes: 5       # 同步间隔（与 sync-upstreams.py 一致）
    relevance_threshold: "medium"  # 最低相关性阈值
  idle_evolution:
    enabled: false                 # D-01: 默认 OFF，用户需显式 opt-in
    mode: "api"                    # "subscription" | "api"
    min_idle_minutes: 30           # 用户至少空闲 N 分钟才触发
    allowed_hours: "08:00-23:00"   # 允许运行的时间窗口
    subscription:
      idle_allocation_pct: 0.20    # 最多用剩余配额的 20%
    api:
      daily_budget_tokens: 100000  # 每日自进化 token 上限
    activities:                    # 各活动类型开关
      memory_consolidation: true
      scaffold_improvement: true
      skill_expansion: true
      web_browsing: true
      upstream_analysis: true
    max_scaffold_level: 2          # 空闲期间最高 proposal 级别（不超过 2；合入仍需人审）
    report_back: true              # 用户上线时汇报空闲活动
```

---

## 六、验证标准

### 6.1 单元测试要点

**TrajectoryStore 测试：**

```python
# 测试事件记录与检索
def test_trajectory_record_and_query():
    store = TrajectoryStore(db_path=":memory:")  # 内存数据库

    # 记录一条失败轨迹
    events = [make_task_start(), make_tool_call(), make_tool_result(), make_task_end(success=False)]
    for event in events:
        store.record(event)

    failures = store.get_failures(limit=10)
    assert len(failures) == 1
    assert failures[0].task_id == events[0].task_id

# 测试容量上限与淘汰
def test_trajectory_capacity_limit():
    store = TrajectoryStore(db_path=":memory:", max_records=10)
    for i in range(15):
        store.record(make_task_end(task_id=f"task_{i}"))
    assert store.count() == 10  # 超出部分被淘汰
```

**FailureAnalyzer 测试：**

```python
# 测试失败类别识别
async def test_failure_categorization():
    analyzer = FailureAnalyzer(llm_client=mock_llm)
    trajectory = load_fixture("infinite_loop_trajectory.jsonl")

    result = await analyzer.analyze(trajectory)

    assert result.failure_category == FailureCategory.INFINITE_LOOP
    assert result.failure_step == 7  # 在第 7 步开始死循环
    assert result.confidence > 0.7

# 测试模式聚合
async def test_pattern_aggregation():
    analyzer = FailureAnalyzer(llm_client=mock_llm)
    failures = [make_failure(FailureCategory.INSUFFICIENT_CONTEXT)] * 8 + \
               [make_failure(FailureCategory.WRONG_TOOL_SELECTION)] * 2

    patterns = await analyzer.aggregate_patterns(failures)

    assert patterns[0]["category"] == "INSUFFICIENT_CONTEXT"
    assert patterns[0]["frequency"] == 0.8
```

**ScaffoldModifier 测试：**

```python
# 测试版本控制
def test_scaffold_versioning():
    modifier = ScaffoldModifier()
    initial_version = modifier.current_version

    modifier.apply(make_modification(level=ModificationLevel.SYSTEM_PROMPT))
    assert modifier.current_version != initial_version
    assert modifier.current_version.endswith(".1")  # patch 版本递增

# 测试回滚
def test_scaffold_rollback():
    modifier = ScaffoldModifier()
    v1 = modifier.current_version
    modifier.apply(make_modification())
    modifier.rollback(v1)
    assert modifier.current_version == v1

# 测试安全白名单（不能修改安全护栏）
def test_cannot_modify_safety_rules():
    modifier = ScaffoldModifier()
    dangerous_modification = ScaffoldModification(
        target="safety_guardrails.injection_detection",
        operation="delete",
        ...
    )
    with pytest.raises(ForbiddenModificationError):
        modifier.apply(dangerous_modification)
```

**SkillManager 测试：**

```python
# 测试技能提取
async def test_skill_extraction():
    manager = SkillManager()
    trajectory = load_fixture("successful_code_fix_trajectory.jsonl")

    skill = await manager.extract(trajectory)

    assert skill is not None
    assert "fix" in skill.trigger_pattern.lower()
    assert len(skill.steps) > 0
    assert "{" in str(skill.params)  # 有参数化占位符

# 测试技能匹配
async def test_skill_matching():
    manager = SkillManager()
    manager.add_skill(make_skill(trigger_pattern="off-by-one error"))

    matches = await manager.match("修复数组索引越界的 off-by-one 错误")
    assert len(matches) > 0
    assert matches[0].skill_id == "fix_python_off_by_one_v1"

# 测试低效技能淘汰
def test_skill_deprecation():
    manager = SkillManager()
    skill = make_skill()
    for _ in range(6):
        manager.update_stats(skill.skill_id, success=False)

    updated = manager.get_skill(skill.skill_id)
    assert updated.status == "deprecated"
```

### 6.2 集成测试场景

**场景一：完整自进化循环**

```
前置条件：预置 10 条失败轨迹（INSUFFICIENT_CONTEXT 类型）
执行步骤：
  1. SelfEvolutionEngine.run_cycle()
  2. 验证 FailureAnalyzer 被调用
  3. 验证 ScaffoldModifier 生成了 Level 1 修改（系统提示中增加信息检索约束）
  4. 验证 ABEvaluator 运行了对照评估
  5. 如果修改有效（成功率提升），验证新版本被保留
  6. 如果修改无效，验证回滚到原版本

预期结果：3 次循环后，INSUFFICIENT_CONTEXT 类失败减少 > 30%
```

**场景二：技能提取与复用**

```
前置条件：执行 5 次成功的"修复 Python off-by-one 错误"任务
执行步骤：
  1. 验证 SkillManager 自动提取了相关技能
  2. 提交新的"修复 JavaScript 数组边界错误"任务
  3. 验证 SkillManager 成功匹配到相似技能
  4. 验证 Agent 能选择套用技能模板
  5. 验证使用模板的任务成功率 > 不使用模板的对照组

预期结果：技能复用后，同类任务成功率提升 > 20%，平均步数减少 > 30%
```

**场景三：安全约束验证**

```
前置条件：正常运行环境
执行步骤：
  1. 向 ScaffoldModifier 注入试图修改安全护栏的修改方案
  2. 验证系统抛出 ForbiddenModificationError
  3. 验证无任何文件被实际修改
  4. 验证操作被记录到审计日志

预期结果：安全约束 100% 拦截违规修改，零误放
```

**场景四：修改频率限制**

```
前置条件：Level 2 冷却时间设为 1 分钟（测试配置）
执行步骤：
  1. 触发 Level 2 修改（成功应用）
  2. 立即再次触发 Level 2 修改
  3. 验证第二次修改被拒绝（冷却中）
  4. 等待 1 分钟
  5. 再次触发 Level 2 修改
  6. 验证成功应用

预期结果：冷却机制 100% 有效，不影响冷却期后的正常修改
```

### 6.3 端到端验证方法

**性能基线建立：**

```bash
# 在 50 个标准任务上建立基线
python -m quilin.evolution.eval \
  --task-set tests/eval/standard_tasks.json \
  --scaffold-version baseline \
  --output baseline_metrics.json
```

**自进化效果验证（长期）：**

```bash
# 启动自进化守护模式（每 6 小时一轮）
python -m quilin.evolution.daemon --config config.yaml

# 7 天后查看演化历史
python -m quilin.evolution.report \
  --since 7days \
  --format markdown > evolution_report_7days.md
```

**验收指标（7 天自进化后）：**

| 指标 | 基线 | 验收标准 |
|------|------|---------|
| 整体任务成功率 | 基线值 | 提升 > 5% |
| 平均执行步数 | 基线值 | 降低 > 10% |
| 平均 token 消耗 | 基线值 | 降低 > 10% |
| INSUFFICIENT_CONTEXT 失败率 | 基线值 | 降低 > 30% |
| 技能复用覆盖率 | 0% | > 15%（15% 的任务使用了已有技能） |
| 非预期回滚率 | — | < 10%（90% 的修改经评估后保留） |

**关键健康指标监控（持续）：**

```python
# 通过 Observability 层（08-observability）持续监控
metrics_to_watch = [
    "evolution.cycle_duration_seconds",       # 每轮自进化耗时
    "evolution.modification_apply_rate",      # 修改被保留的比率
    "evolution.rollback_rate",               # 回滚率（越低越好）
    "evolution.skill_extraction_rate",        # 每次成功任务的技能提取率
    "evolution.skill_reuse_rate",            # 技能复用率
    "evolution.human_approval_pending",      # 待人类审批的修改数量
    "evolution.safety_block_count",          # 被安全约束拦截的次数
]
```

---

> **与前沿研究的关联**：本文档对应 `fusion-index.md` 中的 Section 10（自进化）。参考项目的跟踪优先级：DSPy 的 optimizer 设计演进（高优先级）> Voyager 的 skill_library 范式（中优先级）> SWE-agent 的 ACI 设计（中优先级）> ADAS 的 meta_agent 取舍（中优先级）。
>
> **实施阶段**：自进化工程对应 `implementation-plan.md` 的 Phase 8+，在前 7 个 Phase（LLM 接入 → 可观测性 → 部署运行时）完成后实施。TrajectoryStore 可在 Phase 3 提前埋点，为 Phase 8 的自进化积累初始数据。
