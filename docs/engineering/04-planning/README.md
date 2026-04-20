# 规划工程（Planning Engineering）

> **实现状态（Iter C，2026-04-20 Opus 4.7 revision）**
> - ✅ **已实现**：无（Iter C 未启动）
> - 🚧 **进行中**：spec 撰写（本文件）
> - 💭 **未开始**：Intent / Decomposition / Strategy / Replan / Planner tool — 全部待 Iter C 开工
>
> **本次修订要点**（相对 2026-04-18 骨架，基于 Opus 4.7 复查 + 2025-11~2026-04 外部研究）：
> - ✘ **删除 LangGraph / Python 代码示例** —— 对齐 ADR-001 minimal TS core loop，Python 仅作 ML provider
> - ✘ **反转"DAG 默认"为 Linear-first IR + optional dependency edges** —— 大多数任务本质线性，强制 DAG 过度建模
> - ✘ **替换"四级修正"为显式 Replan 状态机** —— 4 类触发 + 3 级 replan，防 task drift
> - ✓ **新增三段式 Intent 分类**：deterministic override → tiny classifier → main LLM ABSTAIN fallback
> - ✓ **新增 Skills / Memory / Multi-Agent 接口章节** —— Planning 是 orchestration 层，不做 knowledge loading 或 自由 delegate
> - ✓ **吸收 2025-11~2026-04 最新研究**：OpenHands V1 event-sourced state (arXiv 2511.03690)、BATS budget tracker (arXiv 2511.17006)、PALADIN recovery-as-first-class、RETO local repair (arXiv 2602.18968)、IntentGuard ABSTAIN class、Plan-Execute-Verify-Replan (arXiv 2603.11445)
>
> **ADR 对齐**：本 spec 的所有运行时实现遵循 [ADR-001](../../adr/adr-001-core-loop-and-language.md)（核心循环 TS、无 LangGraph）和 [ADR-002](../../adr/adr-002-project-skeleton.md)（packages/agent-core 结构）。

---

## 一、问题定义

### 规划是 Agent 的核心大脑

大多数人以为"调用 LLM 得到回答"就是 Agent。实际上，真正的 Agent 与简单 LLM 调用的本质区别在于：**Agent 具备规划能力**——自主理解意图、分解任务、选择策略、动态修正偏差、判断终止。

没有规划层的"Agent"只是 stateless LLM 调用的包装，无法处理超过单轮的任务。引入规划后，Agent 从"问答机器"进化为"自主执行系统"。

### 五大核心挑战

**1. 意图识别（Intent Recognition）** — 用户输入常模糊。"帮我查一下最新 Python 版本"和"帮我把这段代码用最新 Python 版本重写"，前者是纯问答，后者需多步执行。错误分类导致三种失败模式：过度规划（简单问题启动工具链）、规划不足（复杂任务直接 LLM 回答）、澄清缺失（信息不够强行推进）。

**2. 任务分解（Task Decomposition）** — 复杂目标需拆解为可执行子任务。关键在**粒度控制**：分得太粗 replan 成本高，分得太细 planning overhead 爆炸。

**3. 策略选择（Strategy Selection）** — 不同任务需不同推理策略：纯推理→CoT、工具交互→ReAct、长步骤→PlanAndExecute。单策略框架（只有 ReAct）无法覆盖所有场景。

**4. 动态修正（Dynamic Replanning）** — 执行中现实与预期偏离：工具失败、结果异常、依赖变化。如何动态调整计划而非报错退出，是生产级 Agent 的核心能力。**关键发现（2026 Agent Drift study）**：长链条执行会发生 goal drift，必须主动对照原始 intent。

**5. 终止判断（Termination Detection）** — Agent 需知道"何时停"。过早停=任务未完成；无法停=无限循环耗资源。

### 业界现状与 Quilin 定位

| 框架 | 意图识别 | 任务分解 | 多策略 | 动态重规划 | Checkpoint | Event-sourced |
|------|---------|---------|--------|-----------|-----------|---------------|
| LangGraph | 弱（条件边） | 弱 | 无 | 手动 | 支持 | 部分 |
| AutoGen | 无 | 弱 | 无 | 弱 | 无 | 无 |
| CrewAI | 无 | 角色级 | 无 | 无 | 无 | 无 |
| DSPy | 无 | 无 | 编译期 | 无 | 无 | 无 |
| OpenHands V1 | 无 | Dependency tree（大型迁移） | 无 | 有 | 支持 | ✓ |
| Claude Code | 无（纯 LLM） | 纯 LLM 驱动 | 无 | 有 | 部分 | 无 |
| **Quilin Iter C** | **三段式 + ABSTAIN** | **Linear-first + optional DAG** | **3 策略 + 用户 override** | **4 触发 + 3 级 replan** | **✓** | **✓ 借鉴 OpenHands V1** |

---

## 二、设计方案

### 2.1 意图识别（Intent Recognition）—— 三段式流水线

#### 四分类体系（保留）

| 类别 | 特征 | 示例 | 处理路径 |
|------|------|------|---------|
| `SIMPLE_QA` | 无需工具，LLM 知识可答 | "Python GIL 是什么？" | 跳过工具，LLM 直出 |
| `SINGLE_TOOL` | 一次工具调用完成 | "查今天 BTC 价格" | 单 tool call |
| `MULTI_STEP` | 多步 / 多工具 / 结果依赖 | "拉代码，跑测试，发邮件" | 进入 Decompose → Strategy → Execute |
| `CLARIFICATION` | 信息不足无法执行 | "帮我处理那个文件" | 生成追问 |
| `ABSTAIN`（新增） | 分类器低置信度 | 歧义输入 | 升级到 L3 Main LLM |

#### 三段式分类流水线

```
┌──────────────────────────────────────────────────────────────┐
│  L1  规则快筛（Deterministic Override）                      │
│  - 关键词 / 指代词 / 长度启发                                │
│  - <1ms，~50% 请求在此分流                                   │
│  - 高置信度命中 → 直接返回                                    │
│  - 低置信度 / 未命中 → 传递到 L2                              │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  L2  Tiny Classifier（DeBERTa-xsmall ONNX 或本地 2B LLM）    │
│  - 22M 参数级编码器 / 2B 级本地 LLM                          │
│  - CPU <20ms，成本接近零                                     │
│  - 输出 4 类 + ABSTAIN（共 5 维度概率）                      │
│  - 置信度 ≥ threshold → 返回分类结果                         │
│  - ABSTAIN 或低置信度 → 升级到 L3                            │
│  - ⚠ Iter C M1 才接入，D-21 spike 通过后启用                 │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  L3  Main LLM Fallback（Sonnet / Opus）                      │
│  - 仅对 ABSTAIN 样本触发（预期 ~5%）                         │
│  - 包含少样本 + 解释性 prompt                                │
│  - 输出：{intent, confidence, reason, extracted_entities}    │
│  - 最坏情况 <500ms                                           │
└──────────────────────────────────────────────────────────────┘
```

**设计原则**：
- **Cost asymmetry**：L1 几乎零成本，L2 本地推理几乎零成本，L3 贵但少用。端到端平均成本远低于"每请求都 LLM"方案（实测参考：Medium Hybrid Validation 2026-02 切 70% LLM cost）。
- **ABSTAIN > 错分**（借鉴 IntentGuard 2026-03）：L2 不确定时主动升级，而非强行分类。
- **L2 可选**：Iter C M0 不含 L2，M1 接入，M2 优化。

#### Intent 分类器接口（TS）

```typescript
// packages/agent-core/src/planning/intent.ts

export type Intent =
  | 'SIMPLE_QA'
  | 'SINGLE_TOOL'
  | 'MULTI_STEP'
  | 'CLARIFICATION';

export type ClassificationPath = 'L1_rule' | 'L2_classifier' | 'L3_llm';

export interface IntentClassification {
  readonly intent: Intent;
  readonly confidence: number;        // [0, 1]
  readonly path: ClassificationPath;
  readonly latencyMs: number;
  readonly reason?: string;           // L3 才填
}

export interface IntentClassifier {
  classify(input: string, ctx: PlanContext): Promise<IntentClassification>;
}
```

---

### 2.2 任务分解（Task Decomposition）—— Linear-first IR

> **重大修订**：本节反转了 2026-04-18 骨架的"DAG 默认"设计。理由见 §六·Open Questions 中的 Decomposition 讨论。

#### 默认形态：Linear Plan

MULTI_STEP 任务默认产出**线性子任务列表**（linear plan），不强制 DAG。

```typescript
export interface LinearPlan {
  readonly kind: 'linear';
  readonly subtasks: ReadonlyArray<SubTask>;
}
```

#### 升级为 DAG 的触发条件（严格）

**仅在满足以下任一条件**时，planner 才生成 DAG：

1. LLM 在分解时**显式标注**子任务集合"可并行"（explicit parallel hint）
2. 检测到多子任务读同一资源但写不同资源（独立写集）
3. 用户通过 `--parallel` flag 要求并行

```typescript
export interface DagPlan {
  readonly kind: 'dag';
  readonly subtasks: ReadonlyArray<SubTask>;
  readonly edges: ReadonlyArray<readonly [string, string]>;  // from → to
}

export type Plan = LinearPlan | DagPlan;
```

#### 粒度硬上限（防膨胀）

| 约束 | 值 | 理由 |
|------|-----|------|
| 递归深度 | **≤ 2 层** | Plan → SubTask → executable step；更深说明 prompt 或任务粒度不对 |
| 单次分解 subtasks 数 | **≤ 10** | 超过 10 意味着需要分批，不是单 plan |
| 总节点数 | **≤ 20** | 防 re-decompose 爆炸 |
| 每个 leaf re-decompose 次数 | **≤ 1** | 避免递归分解循环 |

超限即视为异常：planner 必须降级（拆多批 / 返 CLARIFICATION）而非违规产出。

#### Atomic Action 原则

每个 subtask 强制满足（借鉴 OpenHands V1 + oneuptime 2026-01）：

- **单一目的**（do one thing）— 好：`clone_repo`；坏：`deploy_everything`
- **显式 preconditions** — 必须满足的前置条件集合
- **显式 effects** — 完成后对 world state 的影响
- **estimated_tokens** — 与 02-Context 的 token 预估联动，防止生成明知超预算的 plan

```typescript
export interface SubTask {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly estimatedTokens: number;
  readonly estimatedSteps: number;
  readonly preconditions: ReadonlyArray<string>;   // 字符串化的状态断言
  readonly effects: ReadonlyArray<string>;         // 完成后更新的 world state key
  readonly skillHint?: string;                     // 可选：推荐使用的 SKILL.md name
  status: 'pending' | 'running' | 'done' | 'failed';
  retryCount: number;
  decomposeCount: number;
}
```

#### Token 预算联动

Planner 在分解时必须调用 `ContextManager.estimateRemaining()`（02-Context 提供）：

- 若 `sum(subtask.estimatedTokens) > remaining` → planner **不得**直接产出该 plan
- 替代策略：
  1. 生成"按优先级分批"建议，返给用户选择
  2. 或产出简化 plan（丢弃低优先级 subtask）
  3. **绝不生成明知会中途断掉的 plan**

#### Decomposer 接口

```typescript
export interface TaskDecomposer {
  decompose(task: string, intent: Intent, ctx: PlanContext): Promise<Plan>;
}
```

---

### 2.3 策略选择（Strategy Selection）

#### 三策略（保留）

| 策略 | 适用 | 核心循环 |
|------|------|---------|
| `CoT` | 纯推理，无工具 | 单次 LLM 调用，prompt 中含 "Let's think step by step" |
| `ReAct` | 默认，≤20 步有工具 | Think → Act → Observe → 循环 |
| `PlanAndExecute` | >20 步或 DAG | Plan-once → Step-execute-verify → Plan-compare |

#### 选择矩阵（规则驱动，非 LLM）

| Intent | Plan 类型 | 预估步数 | 用户 override | 选择 |
|--------|----------|---------|--------------|------|
| SIMPLE_QA | null | - | - | CoT |
| SINGLE_TOOL | null | 1 | - | ReAct (1 步) |
| MULTI_STEP | Linear | ≤ 20 | - | ReAct |
| MULTI_STEP | Linear | > 20 | - | PlanAndExecute |
| MULTI_STEP | DAG | - | - | PlanAndExecute |
| * | * | * | 指定 | 强制使用用户指定 |

```typescript
export type Strategy = 'CoT' | 'ReAct' | 'PlanAndExecute';

export interface StrategySelector {
  select(intent: Intent, plan: Plan | null, userOverride?: Strategy): Strategy;
}
```

---

### 2.4 动态重规划（Dynamic Replanning）—— 显式状态机

> **重大修订**：本节替换了 2026-04-18 骨架的"四级修正"设计。理由：原设计把触发条件散落在 loop 里的 if/else，运行时难追溯、难测试。现改为**显式状态机 + 4 类触发 + 3 级 replan**。

#### Replan 状态机

```
                ┌──────────────────────────────────────────┐
                │                                          │
                ▼                                          │
         ┌─────────────┐  tool_failure    ┌──────────────┐ │
         │  Executing  ├─────────────────▶│ LocalRepair  │ │
         └──────┬──────┘  (3 次内)        └──────┬───────┘ │
                │                                │         │
                │  ┌───── trigger ──────────────┘         │
                │  │
                │  ├─ ProgressFailure → LocalRearrange ──┤
                │  ├─ WorldStateMismatch → LocalRedecompose
                │  ├─ BudgetPressure → GlobalReplan OR   │
                │  │  SummaryExit
                │  └─ UserInterrupt → 抢占，进入 Clarify  │
                │
                ▼
         ┌──────────────┐
         │  Terminated  │
         └──────────────┘
```

#### 4 类触发条件

**1. ProgressFailure（进展失败）**
- 单 leaf 连续 retry > **3** 次 → LocalRearrange
- 连续 **2** 轮无 forward progress（state hash 不变）→ LocalRearrange

**2. BudgetPressure（预算压力）**
- Token budget ≥ **70%** → 准备 summary exit
- Turn budget ≥ **80%** maxTurns → 强制 summary exit
- Retry token > **15%** 基线预算（SRE retry budget 模式，参考 Tianpan 2026-04 blog）→ LocalRedecompose

**3. WorldStateMismatch（世界状态失配）**
- Tool 结果推翻 subtask precondition（file not found / server down / enum 值已过期）→ LocalRedecompose
- 关键依赖变化（如主干 schema 更新）→ GlobalReplan

**4. UserInterrupt（用户中断，最高优先级）**
- Ctrl+C / API cancel / 显式 interrupt tool call
- 立即抢占 currentLeaf，保存 checkpoint，进入 Clarification 模式等待新指令

#### 3 级 Replan

| 级别 | 作用域 | LLM 成本 | 何时触发 |
|------|-------|---------|---------|
| **L-Rearrange** | 只改当前 leaf 参数 / 工具，不动 plan 结构 | 1 次 LLM 局部调用 | ProgressFailure（默认尝试） |
| **L-Redecompose** | 当前 leaf 重新分解（不超过 max_redecompose），其他 branch 保留 | 1 次 LLM decompose | L-Rearrange 失败 或 WorldStateMismatch |
| **G-Replan** | 基于完整历史全量重新生成 plan | 全量 LLM 重推 | 前提被推翻 / 用户重定向 / 反复失败 |

**纪律**：默认优先 L-Rearrange → L-Redecompose → G-Replan，不能直接跳 G-Replan（除非 UserInterrupt 指定）。

#### Local Repair（子状态机）

单 tool call 失败不直接触发 Replan，先本地修复（借鉴 RETO 2026 arXiv 2602.18968）：

1. **Schema fix** — 按 JSON schema 修复格式错误
2. **Param rewrite** — 用 LLM 根据错误信息改参数
3. **Tool substitute** — 尝试替代工具（同 capability tag）

三次尝试内成功 → 返回 Executing；超预算 → 升级到 Replan。

#### Goal Drift 防御（新增）

参考 2026 Agent Drift study / POMDP drift model：

- 每 **5 步**强制对照原 `intent vector`
- 当前 state embedding 与 intent embedding cosine similarity < **0.65** → 警告 task drift
- 三次警告 → 强制 G-Replan 或进入 CLARIFICATION（问用户"还在做原任务吗？"）

#### 接口

```typescript
export type ReplanTrigger =
  | { kind: 'ProgressFailure'; leaf: string; retries: number; staleTurns: number }
  | { kind: 'BudgetPressure'; tokenPct: number; turnPct: number; retryPct: number }
  | { kind: 'WorldStateMismatch'; violated: ReadonlyArray<string>; severity: 'leaf' | 'global' }
  | { kind: 'UserInterrupt'; userInput: string }
  | { kind: 'GoalDrift'; similarity: number };

export type PlanPatch =
  | { level: 'L-Rearrange'; leafId: string; changes: LeafChange }
  | { level: 'L-Redecompose'; leafId: string; newSubtasks: ReadonlyArray<SubTask> }
  | { level: 'G-Replan'; newPlan: Plan };

export interface Replanner {
  repair(leafId: string, error: ToolError): Promise<RepairOutcome>;
  replan(state: PlanningState, trigger: ReplanTrigger): Promise<PlanPatch>;
}
```

---

### 2.5 终止判断（Termination Detection）

| 终止条件 | 触发机制 | 优先级 | 处理 |
|---------|---------|-------|------|
| **Success** | LLM 判定目标达成 | 最高 | 输出结果，正常退出 |
| **UserInterrupt** | Ctrl+C / cancel | 高 | 保存 checkpoint，保留进度 |
| **MaxSteps** | `iteration >= maxIterations`（默认 50） | 中 | 部分输出 + `partial_complete` 标记 |
| **DeadLoop** | 连续 5 步动作类型完全相同 | 中 | 强制终止 + 诊断报告 |
| **ResourceExhausted** | Token budget > **80%** | 中 | 摘要式输出，优雅退出 |
| **UnrecoverableError** | G-Replan 后仍失败 | 低 | 详细错误报告，建议人工干预 |
| **GoalDrift** | similarity 三次警告 | 低 | 暂停进入 CLARIFICATION |

```typescript
export type TerminationReason =
  | 'Success' | 'UserInterrupt' | 'MaxSteps'
  | 'DeadLoop' | 'ResourceExhausted' | 'UnrecoverableError' | 'GoalDrift';

export interface TerminationDecision {
  readonly terminate: boolean;
  readonly reason?: TerminationReason;
}
```

---

### 2.6 PlanningState —— Event-sourced（借鉴 OpenHands V1）

所有状态转换产生**不可变 event**，支持确定性回放 + pause/resume。

```typescript
// packages/agent-core/src/planning/state.ts

export interface AgentEvent {
  readonly seq: number;
  readonly timestamp: number;
  readonly kind:
    | 'intent_classified'
    | 'task_decomposed'
    | 'subtask_started'
    | 'subtask_done'
    | 'tool_called'
    | 'tool_returned'
    | 'local_repair'
    | 'replan'
    | 'terminated';
  readonly payload: unknown;
}

export interface BudgetLedger {
  readonly tokenSpent: number;
  readonly tokenBudget: number;
  readonly turnSpent: number;
  readonly turnBudget: number;
  readonly retryTokenSpent: number;   // for SRE retry budget
}

export type PlanPhase =
  | 'classifying'
  | 'decomposing'
  | 'executing'
  | 'repairing'
  | 'replanning'
  | 'terminated';

export interface PlanningState {
  readonly runId: string;
  readonly intent: IntentClassification | null;
  readonly plan: Plan | null;
  readonly currentLeafId: string | null;
  readonly phase: PlanPhase;
  readonly budget: BudgetLedger;
  readonly events: ReadonlyArray<AgentEvent>;
  readonly checkpoints: ReadonlyArray<Checkpoint>;
}

export interface Checkpoint {
  readonly id: string;
  readonly atEventSeq: number;
  readonly stateSnapshot: PlanningState;
  readonly storageRef: string;        // OmniMem episodic tier
}
```

**不可变性约定**：
- State transitions 通过纯函数 `applyEvent(state, event) → newState`
- 历史回放：`events.reduce(applyEvent, initialState)` 重建任意时刻 state
- Checkpoint = `{ atEventSeq, stateSnapshot }`，存 OmniMem episodic tier

---

### 2.7 Planner Protocol（统一接口）

```typescript
// packages/agent-core/src/planning/planner.ts

export interface PlanContext {
  readonly task: string;
  readonly conversationHistory: ReadonlyArray<Message>;
  readonly memoryRecall: ReadonlyArray<MemoryItem>;      // 从 OmniMem 拉
  readonly skillCatalog: ReadonlyArray<SkillDescriptor>; // 从 SkillsManager 拉
  readonly budget: BudgetLedger;
  readonly iteration: number;
}

export interface Planner {
  classifyIntent(input: string, ctx: PlanContext): Promise<IntentClassification>;
  decompose(task: string, intent: Intent, ctx: PlanContext): Promise<Plan>;
  selectStrategy(intent: Intent, plan: Plan | null, override?: Strategy): Strategy;
  replan(state: PlanningState, trigger: ReplanTrigger): Promise<PlanPatch>;
  shouldTerminate(state: PlanningState): TerminationDecision;
  generateClarification(input: string, missing: ReadonlyArray<string>): Promise<string>;
}
```

---

### 2.8 配置（quilin/config.yaml `planning` 节）

```yaml
planning:
  intent:
    l1_rule:
      enabled: true
      keywords:
        single_tool: ["搜索", "查询", "查找", "获取", "列出", "search", "fetch", "get"]
        clarification: ["那个", "之前", "上面说的", "the thing", "as before", "it"]
        multi_step_hint: ["然后", "接着", "并且", "最后", "then", "after that"]

    l2_classifier:
      enabled: false              # Iter C M0 不启用，M1 随 D-21 spike 结果启用
      backend: "deberta_onnx"     # 或 "qwen_local_2b"
      model_path: "<TBD, pending D-21 spike>"
      confidence_threshold: 0.85
      abstain_below: 0.65

    l3_fallback:
      enabled: true
      model_ref: "llm.main"       # 引用 01-llm 主模型
      trigger: "abstain_or_low_confidence"

  decomposition:
    default_ir: "linear"
    max_depth: 2
    max_subtasks_per_plan: 10
    max_total_nodes: 20
    max_redecompose_per_leaf: 1
    upgrade_to_dag_on:
      - "explicit_parallel_hint"
      - "independent_writes"
      - "user_parallel_flag"

  strategy:
    default: "react"
    plan_and_execute_threshold_steps: 20
    allow_user_override: true

  replan:
    triggers:
      progress_failure:
        max_leaf_retries: 3
        max_stale_turns: 2
      budget_pressure:
        token_budget_exit_pct: 0.70
        turn_budget_exit_pct: 0.80
        retry_token_cap_pct: 0.15
      world_state_mismatch:
        leaf_severity_upgrade_to_g_replan: false
      goal_drift:
        check_every_n_steps: 5
        similarity_threshold: 0.65
        max_warnings: 3

    local_repair:
      max_attempts: 3
      strategies: ["schema_fix", "param_rewrite", "tool_substitute"]

  termination:
    max_iterations: 50
    checkpoint_every_n_steps: 5
    max_checkpoints: 5
    dead_loop_window: 5
```

---

### 2.9 与 Skills / Memory / Multi-Agent 接口（新增章节）

Planning 是 **orchestration 层**，**不做**：
- 自己读 SKILL.md 文件（不跨边界）
- 把 live plan state 写 semantic memory（不污染长期知识）
- 让 LLM 自由决定 delegate 对象（无 guardrail 风险）

#### 2.9.1 Skills 接口

```
Planner 依赖 SkillsManager 的 descriptor-only 视图，不直接访问文件系统。
```

```typescript
export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly estimatedTokens: number;
  readonly tags: ReadonlyArray<string>;
}

export interface SkillsManager {
  listCatalog(): Promise<ReadonlyArray<SkillDescriptor>>;        // 启动时拉
  load(name: string): Promise<SkillContent>;                     // 按需加载全文
}
```

**调用顺序**：
1. `Planner.decompose()` 启动前先 `listCatalog()` 拉 descriptor（轻量，只含元数据）
2. 对每个 subtask 匹配 `skillHint`（embedding similarity + rule）
3. `subtask.status = running` 前，`SkillsManager.load(skillHint)` 拉全文注入 execution prompt
4. Subtask 完成后，skill 用量 → OmniMem semantic tier（跨 session 学习"这个 skill 对这类任务有效"）

#### 2.9.2 Memory 分层写入

| 数据 | Tier | 生命周期 | 读取时机 |
|------|------|---------|---------|
| 当前 plan tree + currentLeaf + events | **working** | session 结束清空 | 每步 replan 判断 |
| Final plan + replan history + failure causes | **episodic** | 持久化 | 相似任务召回、debug 回看 |
| 复盘提炼的稳定策略（"这类任务适合 PlanAndExecute"） | **semantic** | 长期，需显式沉淀 | 下次 classifyIntent / selectStrategy 时召回 |

**纪律**（针对 2026-04-18 骨架反转）：
- ❌ live plan state **不进** semantic tier
- ❌ 失败 plan **不立刻**进 semantic（需复盘后人工/LLM 提炼）
- ✅ 仅稳定策略 + 跨任务通用经验进 semantic

#### 2.9.3 Multi-Agent Delegation（规则路由）

> Delegation 决策 **不给 LLM 自由发挥**，Iter C 阶段走规则路由。

**触发条件**（必须**全部**满足）：
1. Subtask 独立（`preconditions` 不依赖其他运行中 subtask 的 `effects`）
2. 剩余步骤 ≥ **3** 步（overhead 摊销下限）
3. 无共享写集（`writeScope` 不与其他 running subtask 冲突）
4. 风险级别 ≤ main Agent tier（不下放高风险写操作）

**选择器优先级**（全部通过 06-multi-agent 的 `AgentPool.select(criteria)`）：
1. Capability match — subtask 需要的 tool capability 集合
2. Skill / tag match — 历史上处理过类似任务的 sub-agent
3. Affinity — CPU-bound / IO-bound / 独立 context 需求
4. Risk level — 写权限层级

```typescript
export interface DelegationCriteria {
  readonly subtaskId: string;
  readonly requiredCapabilities: ReadonlyArray<string>;
  readonly skillTags: ReadonlyArray<string>;
  readonly affinity: 'cpu' | 'io' | 'isolated_context';
  readonly riskLevel: 'low' | 'medium' | 'high';
}

export interface DelegationPolicy {
  shouldDelegate(subtask: SubTask, state: PlanningState): boolean;
  buildCriteria(subtask: SubTask): DelegationCriteria;
}
```

**Main Agent 不执行**（契合 CLAUDE.md 的"非阻塞 Supervisor"设计）：
- 所有 subtask 要么 delegate，要么标记 inline 但由 Executor 独立 coroutine 跑
- Main Agent 永远可接新用户输入 / 中断 / 监控

---

## 三、参考项目

### 核心参考（必看，Iter C 实现直接引用）

| # | 项目 / 论文 | 为何看 | 引用点 |
|---|-----------|--------|--------|
| 1 | **OpenHands V1** (arXiv:2511.03690) | Event-sourced state + 模块化 SDK + 多 Agent DAG 执行 | §2.6 event-sourced state, §2.9.3 delegation |
| 2 | **Claude Code sub-agent 架构** (Prafull Salunke 2026-02) | Main Agent orchestrator + 独立 context subagent pool | §2.9.3 non-blocking main agent |
| 3 | **IntentGuard** (HuggingFace 2026-03, perfecXion/intentguard) | DeBERTa-v3-xsmall (22M) + ABSTAIN class，生产级分类器 | §2.1 L2 classifier candidate |
| 4 | **BATS** (arXiv:2511.17006) | Budget-aware test-time scaling tracker | §2.4 BudgetPressure trigger |
| 5 | **RETO** (arXiv:2602.18968) | Local repair before global replan | §2.4 Local Repair 子状态机 |
| 6 | **PALADIN** (OpenReview 2025) | Failure recovery as first-class learning objective | §2.4 Replan 纪律 |
| 7 | **Plan-Execute-Verify-Replan** (arXiv:2603.11445) | DAG + verification + adaptive replan | §2.4 G-Replan 触发 |
| 8 | **Agent Drift study** (2026 POMDP drift model) | Task drift 形式化 + plan-ahead > step-by-step | §2.4 Goal Drift 防御 |
| 9 | **Hybrid Validation Pattern** (Medium 2026-02) | 规则 + LLM fallback，切 70% cost | §2.1 三段式设计依据 |
| 10 | **Retry Budget for LLM Agents** (Tianpan 2026-04) | SRE retry budget 模式 | §2.4 retry_token_cap_pct |

### 观察参考（按需）

LangGraph / DSPy / OpenAI Agents SDK / Pydantic AI / AutoGen / CrewAI / Semantic Kernel / LATS / HuggingGPT / MetaGPT —— 详见 2026-04-18 骨架，不再复述。注意：**Iter C 不引入任何以上作为运行时依赖**（ADR-001）。

---

## 四、验证标准

### 4.1 单元测试（vitest）

#### Intent 分类（每类 ≥ 5 用例，共 20 基础 + 20 边界 = 40）

```typescript
// packages/agent-core/src/planning/__tests__/intent.test.ts

describe('IntentClassifier L1 规则通道', () => {
  it.each([
    ['Python GIL 是什么？', 'SIMPLE_QA', 0.7],
    ['搜索最新 GPT-5 新闻', 'SINGLE_TOOL', 0.9],
    ['帮我处理那个文件', 'CLARIFICATION', 0.9],
    ['拉代码然后跑测试', 'MULTI_STEP', 0.8],
  ])('classifies %s as %s', async (input, expected, minConf) => {
    const result = await classifier.classify(input, ctx);
    expect(result.intent).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(minConf);
    expect(result.path).toBe('L1_rule');
  });
});

describe('IntentClassifier L3 fallback', () => {
  it('escalates to L3 on ambiguous input', async () => {
    const result = await classifier.classify('update it', ctx);
    expect(result.path).toBe('L3_llm');
  });
});
```

#### Decomposer（linear-first + DAG upgrade）

```typescript
describe('TaskDecomposer', () => {
  it('produces linear plan by default', async () => {
    const plan = await decomposer.decompose(
      '搜索竞品，整理表格，给出建议',
      'MULTI_STEP',
      ctx,
    );
    expect(plan.kind).toBe('linear');
    expect(plan.subtasks.length).toBeLessThanOrEqual(10);
  });

  it('upgrades to DAG on explicit parallel hint', async () => {
    const plan = await decomposer.decompose(
      '并行跑单元测试和集成测试',
      'MULTI_STEP',
      ctx,
    );
    expect(plan.kind).toBe('dag');
  });

  it('enforces depth ≤ 2', async () => {
    // re-decompose 同一 leaf 2 次应失败
    const plan = await decomposer.decompose(complexTask, 'MULTI_STEP', ctx);
    const leafId = plan.subtasks[0].id;
    await decomposer.redecompose(leafId, plan);
    await expect(decomposer.redecompose(leafId, plan)).rejects.toThrow(/max_redecompose/);
  });

  it('refuses plan exceeding token budget', async () => {
    ctx.budget.tokenBudget = 1000;
    // mock subtasks summing to 2000 tokens
    await expect(decomposer.decompose(hugeTask, 'MULTI_STEP', ctx))
      .rejects.toThrow(/token_budget_exceeded/);
  });
});
```

#### Replanner 状态机

```typescript
describe('Replanner', () => {
  it('triggers LocalRearrange on 3 consecutive leaf retries', async () => {
    const trigger: ReplanTrigger = {
      kind: 'ProgressFailure',
      leaf: 'T3',
      retries: 3,
      staleTurns: 0,
    };
    const patch = await replanner.replan(state, trigger);
    expect(patch.level).toBe('L-Rearrange');
  });

  it('escalates to G-Replan on WorldStateMismatch with global severity', async () => {
    const trigger: ReplanTrigger = {
      kind: 'WorldStateMismatch',
      violated: ['api_schema_changed'],
      severity: 'global',
    };
    const patch = await replanner.replan(state, trigger);
    expect(patch.level).toBe('G-Replan');
  });

  it('respects UserInterrupt as highest priority', async () => {
    // even during executing, UserInterrupt preempts
    const trigger: ReplanTrigger = { kind: 'UserInterrupt', userInput: 'stop' };
    const patch = await replanner.replan(state, trigger);
    expect(patch.level).toBe('G-Replan');
  });
});
```

#### Goal Drift 检测

```typescript
describe('GoalDriftDetector', () => {
  it('warns when similarity drops below 0.65', async () => {
    const state = makeStateWithDriftedActions();
    const warnings = driftDetector.check(state);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('forces G-Replan after 3 warnings', async () => {
    // 连续 3 个 check point 都低于 threshold
    const trigger = driftDetector.accumulate(3);
    expect(trigger.kind).toBe('GoalDrift');
  });
});
```

### 4.2 集成测试

- **E2E SIMPLE_QA 直答**：跳过工具，< 5s
- **E2E MULTI_STEP Linear**：至少 3 subtasks，ReAct 循环，< 60s
- **E2E Local Repair 成功**：首次 tool 失败，3 次内修复，不触发 replan
- **E2E L-Redecompose**：precondition 失败后局部重分解，保留其他 branch
- **E2E G-Replan on UserInterrupt**：执行中用户中断 → 抢占 → clarification → 新指令
- **E2E Checkpoint Resume**：5 步后中断，从 checkpoint 恢复，事件回放一致

### 4.3 验收指标

| 指标 | 目标 | 方法 |
|------|------|------|
| Intent 分类准确率（4 类）L1+L2 | ≥ 90% | 40 标注用例 |
| L1 规则通道命中率 | ≥ 50% | 统计 path 分布 |
| L2 分类器（M1 启用后）recall / FPR / p95 | 等 D-21 spike 完成后定 | 外部 gate |
| Decomposer DAG 正确率（依赖顺序） | ≥ 85% | 20 手造任务 |
| Replan 成功率（故障场景） | ≥ 80% | 注入 tool 失败 |
| Checkpoint 恢复无数据丢失 | 100% | event replay 幂等性 |
| 单元测试覆盖率 | ≥ 80% | `bun run test --coverage` |

---

## 五、Iter C 交付范围 + 阶段划分

### M0 — Linear Planning MVP（2-3 周）

- **Intent**: L1 规则 + L3 LLM fallback（**无 L2**）
- **Decomposition**: Linear-first，硬上限约束
- **Strategy**: ReAct + CoT（**无 PlanAndExecute**）
- **Replan**: L-Rearrange + Local Repair（**无 L-Redecompose / G-Replan**）
- **Termination**: Success + MaxSteps + UserInterrupt + DeadLoop
- **Event-sourced state**: ✓（minimal subset）
- **Skills 接口**: descriptor-only catalog
- **Memory**: working + episodic（**无 semantic 写入**）
- **Multi-Agent**: **不启用 delegation**（main Agent 内联执行）

**验收**：MULTI_STEP 任务端到端跑通（搜索竞品 → 整理表格 → 生成建议），≤ 20 步，Replan 只支持 L-Rearrange。

### M1 — Tiny Classifier + L-Redecompose（+ 1-2 周，D-21 spike 通过后）

- **Intent**: + L2 DeBERTa-xsmall ONNX 或本地 Qwen2.5-1.5B（D-21 gate 通过后）
- **Replan**: + L-Redecompose + Goal Drift 检测
- **Memory**: + 复盘沉淀到 semantic（opt-in）

**验收**：L2 分类器 recall ≥ 85%，Goal Drift 检测覆盖率 100%。

### M2 — DAG + PlanAndExecute + Multi-Agent（+ 2-3 周）

- **Decomposition**: + DAG 升级（explicit parallel / independent writes）
- **Strategy**: + PlanAndExecute（> 20 步任务）
- **Replan**: + G-Replan
- **Multi-Agent**: + 规则 delegation（06-multi-agent 联动）

**验收**：长任务（50+ 步）端到端跑通，至少 1 次 delegation 到 sub-agent。

---

## 六、Open Questions / 待后续决策

### Q1. Linear-first vs DAG-first 之争的收敛记录

2026-04-20 revision 反转为 Linear-first。理由：
- 大多数任务本质线性（oneuptime 2026-01 研究）
- 强制 DAG 让 planner 过度建模，token + bug 面增加
- Linear 是 DAG 的退化形式，不损失表达力；按需升级零成本

**残留风险**：Linear 执行引擎是否需要额外支持"软并发"（声明独立但不强依赖 DAG）？M2 决定。

### Q2. L2 Tiny Classifier 落地 —— DeBERTa vs 本地 2B LLM

D-21 spike（Task #97 follow-up）正在跑对比实验。候选：
- DeBERTa-v3-xsmall (22M, ONNX INT8) — IntentGuard 同款
- Qwen2.5-1.5B-Instruct (本地 ollama)
- Haiku 4.5（云端对照臂）

**Gate**（Codex 挑战后拆分）：
- 本地路径：recall ≥85% + FPR ≤5% + p95 ≤50ms + cost ~$0
- 云端路径：recall ≥85% + FPR ≤5% + p95 relaxed + cost cap $X / 1k calls

### Q3. Goal Drift threshold 的校准

`similarity_threshold: 0.65` 是默认值，需在 M1 上线后收集真实数据校准。校准数据源：用户手动标注的"偏离"事件 + episodic memory 中标记为 "drift" 的 session。

### Q4. Replan 成本 vs 收益

G-Replan 成本高（全量 LLM 重推）但生产中发生率应 <5%。M2 上线后需监控：
- Replan 占总 LLM token 的百分比（目标 <10%）
- L-Rearrange → L-Redecompose → G-Replan 的升级比例（目标金字塔形，大部分在 L-Rearrange 解决）

### Q5. Skills descriptor 的 token 成本

假设 100 skills × 200 tokens = 20k tokens 注入 Planner context。M2 前需评估：
- 是否需要 skill catalog 的二次筛选（embedding-based pre-filter）？
- 或者 descriptor 精简到 50 tokens 以内？

---

## 七、与其他工程领域的关联

| 领域 | 关联点 |
|------|--------|
| [01 LLM Integration](../01-llm-integration/README.md) | Planner 用 `llm.main` 做 L3 fallback 和 decompose |
| [02 Context](../02-context/README.md) | `ContextManager.estimateRemaining()` 用于 token 预算约束 |
| [03 Memory](../03-memory/README.md) | Plan 状态按 working/episodic/semantic 三层写入 |
| [05 Tools](../05-tool/README.md) | Subtask execute 通过 tool registry，tool_call 产生 AgentEvent |
| [06 Multi-Agent](../06-multi-agent/README.md) | M2 delegation 调用 `AgentPool.select(criteria)` |
| [07 Safety](../07-safety-guardrails/README.md) | Delegation risk level 由 07 提供；UserInterrupt 对齐 07 的抢占协议 |
| [08 Observability](../08-observability/README.md) | AgentEvent 序列即天然的 trace 流，`recordSpan(event)` 注入 OTel |
| [13 Skills](../13-skills/README.md) | `SkillsManager.listCatalog() / load(name)` 是 Planning 唯一入口 |

---

## 八、变更历史

| 日期 | 版本 | 修订人 | 要点 |
|------|------|--------|------|
| 2026-04-17 | v0.1 | Codex + Claude | 初版骨架：4 分类 + DAG-default + 四级修正 + Python 示例 |
| 2026-04-18 | v0.2 | Claude | 加入 ADR-001 对齐说明 + Token 预算约束 |
| **2026-04-20** | **v1.0** | **Claude (Opus 4.7 revision)** | **基于外部研究全量重写**：反转 Linear-first / 三段式 Intent / 状态机 Replan / TS Protocol / Skills-Memory-MultiAgent 接口章节 |
