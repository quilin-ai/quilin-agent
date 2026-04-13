# 规划工程（Planning Engineering）

## 一、问题定义

### 规划是 Agent 的核心大脑

大多数人在接触 LLM 应用时，会误以为"调用 LLM 得到回答"就是 Agent。实际上，真正意义上的 Agent 与简单 LLM 调用的本质区别在于：**Agent 具备规划能力**——能够自主理解用户意图、分解任务、选择推理策略、动态修正偏差、并判断何时停止。

没有规划层的"Agent"本质上只是一个 stateless 的 LLM 调用包装，无法处理任何超过单轮的任务。而一旦引入规划，Agent 就从"问答机器"进化为"自主执行系统"。

### 核心挑战（五大难题）

**1. 意图识别（Intent Classification）**

用户输入往往是模糊的。"帮我查一下最新的 Python 版本"和"帮我把这段代码用最新 Python 版本重写"都是用户的日常表达，但一个是纯问答，一个需要多步执行。错误的意图分类会导致：
- 过度规划：简单问题启动复杂工具链，浪费资源
- 规划不足：复杂任务直接 LLM 回答，结果错误
- 澄清缺失：关键信息不足时强行推进，导致失败

**2. 任务分解（Task Decomposition）**

复杂目标需要被拆解为可执行的子任务序列。但子任务之间存在依赖关系（A 完成后才能执行 B），部分子任务可以并行，部分必须串行。如何正确建模这种 DAG 结构，并处理运行时的动态变化，是任务分解的核心难题。

**3. 策略选择（Strategy Selection）**

不同任务类型需要不同的推理策略：
- 纯推理类任务 → 链式思考（CoT）
- 需要工具交互的任务 → ReAct 循环
- 高度复杂、需要全局规划的任务 → PlanAndExecute
- 无法一次完成、需要探索的任务 → 树搜索（LATS）

单一策略（绝大多数框架只有 ReAct）无法覆盖所有场景。

**4. 动态修正（Dynamic Replanning）**

计划执行过程中，现实往往与预期不符：工具调用失败、返回结果偏离预期、步骤超时、依赖数据发生变化。如何在这些情况下动态调整计划，而不是简单报错退出，是生产级 Agent 的核心能力。

**5. 终止判断（Termination Detection）**

Agent 需要知道"什么时候该停"。过早停止导致任务未完成；无法停止导致无限循环耗尽资源。成功判定、最大步数、死循环检测、用户中断、资源耗尽——每种终止条件都有独立的检测逻辑和处理策略。

### 业界现状与不足

当前主流 Agent 框架的规划能力评估：

| 框架 | 意图识别 | 任务分解 | 多策略切换 | 动态重规划 | 检查点 |
|------|---------|---------|-----------|-----------|--------|
| LangGraph | 弱（条件边实现） | 弱 | 无 | 支持（需手动） | 支持 |
| AutoGen | 无 | 弱 | 无 | 弱 | 无 |
| CrewAI | 无 | 角色级别 | 无 | 无 | 无 |
| DSPy | 无 | 无 | 支持（编译期） | 无 | 无 |
| Pydantic AI | 无 | 无 | 无 | 无 | 无 |
| **Quilin** | **4分类** | **DAG** | **3策略+手动** | **4级修正** | **支持** |

绝大多数框架只有 ReAct 循环（think-act-observe），缺乏意图分类前置过滤、动态重规划机制和多策略切换能力。Quilin 的规划工程旨在填补这一空白。

---

## 二、设计方案

### 2.1 意图识别（Intent Classification）——核心特色

意图识别是规划工程的第一道关卡，也是 Quilin 区别于其他框架的核心特色。每一个用户请求都必须经过意图分类，才能进入后续的规划流程。

#### 四分类体系

```
┌─────────────────────────────────────────────────────────┐
│                    用户输入（User Input）                 │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │     规则快速通道         │
            │  （关键词 + 启发式匹配）  │
            └──────────┬──────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    命中规则        未命中规则      模糊情况
         │             │             │
         ▼             ▼             ▼
    直接分类       LLM 判断       LLM 判断
                       │
                       ▼
         ┌─────────────────────────────┐
         │         意图分类器           │
         │   IntentClassifier (LLM)    │
         └──────────────┬──────────────┘
                        │
         ┌──────────────┼──────────────┬──────────────┐
         ▼              ▼              ▼              ▼
   SIMPLE_QA     SINGLE_TOOL     MULTI_STEP    CLARIFICATION
   （直接回答）   （单工具调用）   （多步规划）   （信息不足）
         │              │              │              │
         ▼              ▼              ▼              ▼
    LLM 直接        选工具         任务分解       向用户
    生成答案        并执行         + 策略选择      追问
```

**SIMPLE_QA（简单问答）**

特征：无需工具调用即可直接回答的问题。知识型、解释型、建议型。
- 触发规则：无工具调用关键词、问题可以通过 LLM 知识直接回答
- 示例："Python 中 GIL 是什么？" / "给我解释一下 CAP 定理"
- 处理：跳过工具层，LLM 直接生成答案，一轮结束

**SINGLE_TOOL（单步工具）**

特征：需要且仅需要一次工具调用即可完成的任务。
- 触发规则：明确的单一操作动词（搜索/查询/获取），对象和目标明确
- 示例："查一下今天 BTC 的价格" / "搜索 LangGraph 的最新文档"
- 处理：直接映射到对应工具，调用一次，返回结果

**MULTI_STEP（多步任务）**

特征：需要多次工具调用、多轮推理、中间结果依赖的复杂任务。
- 触发规则：任务描述含有"然后/接着/并且/最后"等序列词，或目标复合
- 示例："从 GitHub 拉取最新代码，运行测试，如果失败发邮件通知"
- 处理：进入任务分解 → 策略选择 → 迭代执行

**CLARIFICATION（澄清请求）**

特征：信息严重不足，无法在不追问的情况下合理执行。
- 触发规则：代词指代不明、缺少关键参数、任务目标模糊
- 示例："帮我处理一下那个文件" / "按照之前说的方式做"
- 处理：生成追问文本，等待用户补充，重新分类

#### 分类策略：双通道架构

```
用户输入
    │
    ├──→ 规则通道（< 1ms）
    │       ├── 关键词匹配（"搜索"/"查询"/"列出" → SINGLE_TOOL）
    │       ├── 长度启发（< 20 词 + 问号 → SIMPLE_QA 候选）
    │       ├── 指代词检测（"那个"/"之前"/"上面说的" → CLARIFICATION）
    │       └── 复杂度词组（"然后"/"接着"/"并且" → MULTI_STEP 候选）
    │
    └──→ LLM 通道（100-500ms，规则通道不确定时触发）
            ├── 分类 Prompt 含有 4 类定义 + 少样本示例
            ├── 输出结构化 JSON：{intent, confidence, reason}
            └── confidence < 0.7 时降级到 CLARIFICATION
```

规则通道优先，命中则直接使用；LLM 通道作为兜底保障分类质量。两通道并不互斥，规则命中后 LLM 仍可以异步校验并更新置信度。

---

### 2.2 任务分解 DAG 设计

当意图分类为 MULTI_STEP 时，触发任务分解器。将复杂目标转换为有向无环图（DAG）结构。

#### DAG 节点结构

```python
@dataclass
class SubTask:
    id: str                          # 唯一标识符
    name: str                        # 简短名称
    description: str                 # 详细描述
    estimated_steps: int             # 预估执行步数
    priority: int                    # 优先级（1=最高）
    status: SubTaskStatus            # pending/running/done/failed
    dependencies: list[str]          # 依赖的 subtask id 列表
    result: dict[str, Any] | None    # 执行结果（done 后填充）
    retry_count: int = 0             # 已重试次数
    max_retries: int = 3             # 最大重试次数
```

#### DAG 示例（"从 GitHub 拉代码并运行测试"）

```
        ┌──────────────────┐
        │ T1: clone_repo   │  依赖：无
        │ 预估步数：1       │
        └────────┬─────────┘
                 │
        ┌────────▼─────────┐
        │ T2: install_deps │  依赖：T1
        │ 预估步数：2       │
        └────────┬─────────┘
                 │
       ┌─────────┴──────────┐
       │                    │
┌──────▼──────┐    ┌────────▼────────┐
│ T3: run_    │    │ T4: run_        │  依赖：T2（并行）
│ unit_tests  │    │ integration_    │
│ 预估步数：3  │    │ tests           │
└──────┬──────┘    │ 预估步数：5      │
       │           └────────┬────────┘
       │                    │
       └─────────┬──────────┘
                 │
        ┌────────▼─────────┐
        │ T5: notify_      │  依赖：T3 + T4
        │ results          │  （汇聚节点）
        │ 预估步数：1       │
        └──────────────────┘
```

#### DAG 支持的动态操作

- **添加子任务**：执行中发现遗漏的步骤，可插入 DAG
- **删除子任务**：发现某步骤已由其他结果覆盖，可剪枝
- **修改依赖**：执行路径变化时重新连接边
- **优先级调整**：实时调整子任务的执行顺序

---

### 2.3 推理策略切换器（Strategy Switcher）

Quilin 支持三种内置推理策略，根据意图类型和任务复杂度自动选择，也支持用户手动指定。

#### 三种推理策略

**策略 A：ReAct（默认，覆盖 90% 场景）**

```
┌─────────┐
│  Think  │ ← LLM 推理当前状态，决定下一步动作
└────┬────┘
     │
┌────▼────┐
│   Act   │ ← 调用工具（MCP 协议）
└────┬────┘
     │
┌────▼────┐
│ Observe │ ← 接收工具返回结果，更新状态
└────┬────┘
     │
     └─── → Think（循环，直到终止条件）
```

适用：绝大多数有工具调用的任务，步骤数未知但不超过 20 步。

**策略 B：PlanAndExecute（复杂长任务）**

```
┌──────────────────────────────┐
│  Phase 1: Plan Generation    │
│  LLM 一次性生成完整执行计划   │
│  输出：步骤列表 + 预期结果    │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Phase 2: Step Execution     │  ← 逐步执行，每步对照计划
│  execute step_1 → verify     │
│  execute step_2 → verify     │
│  ...                         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Phase 3: Plan Comparison    │  ← 全部完成后对照原计划验收
│  预期输出 vs 实际输出         │
│  不符合 → 触发重规划          │
└──────────────────────────────┘
```

适用：步骤数可预估（10-50 步）、有明确成功标准的复杂任务。

**策略 C：CoT（纯推理，无工具调用）**

```
Question: [用户输入]
           │
           ▼
Let me think step by step:
  Step 1: [分析前提条件]
  Step 2: [推导中间结论]
  Step 3: [验证一致性]
  ...
  Conclusion: [最终答案]
```

适用：纯推理题、数学计算、逻辑分析，无需访问外部资源。

#### 策略选择矩阵

| 意图类型 | 复杂度 | 工具需求 | 选择策略 |
|---------|--------|---------|---------|
| SIMPLE_QA | 任意 | 无 | CoT |
| SINGLE_TOOL | 低 | 1 个工具 | ReAct（1步） |
| MULTI_STEP | 中（≤20步） | 多工具 | ReAct |
| MULTI_STEP | 高（>20步） | 多工具 | PlanAndExecute |
| MULTI_STEP | 探索性 | 不确定 | ReAct + 动态重规划 |
| 用户指定 | — | — | 强制使用指定策略 |

---

### 2.4 动态重规划（Dynamic Replanning）

计划执行偏差不可避免，Quilin 实现四级修正策略，从轻到重依次升级。

#### 偏差检测机制

```
每步执行后自动检查：
  ├── 工具返回值格式是否符合预期 Schema
  ├── 实际耗时 vs 预估耗时（超过 2x → 警告）
  ├── 步骤计数 vs 预估步数（超过 2x → 触发重规划评估）
  ├── 连续失败次数（≥3次 → 强制重规划）
  └── 内容相似度检测（连续 N 步输出高度相似 → 死循环预警）
```

#### 四级修正策略（递进式）

```
偏差检测触发
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Level 1：原地重试（Retry）                              │
│  条件：工具偶发失败，retry_count < max_retries           │
│  操作：使用相同参数重新调用，指数退避                    │
│  成本：极低（无 LLM 调用）                               │
└──────────────────────────┬──────────────────────────────┘
                           │ 重试失败
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Level 2：计划局部调整（Patch）                          │
│  条件：单个子任务失败，但其他步骤不受影响                │
│  操作：LLM 生成替代方案（换工具/换参数/跳过）            │
│  成本：低（1次 LLM 调用，局部 context）                 │
└──────────────────────────┬──────────────────────────────┘
                           │ 调整无效
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Level 3：检查点回滚（Rollback）                         │
│  条件：多个步骤失败，当前路径不可行                      │
│  操作：回退到最近的检查点，重新规划从检查点开始的子图    │
│  成本：中（从检查点重新执行部分步骤）                    │
└──────────────────────────┬──────────────────────────────┘
                           │ 回滚后仍失败
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Level 4：完全重规划（Full Replan）                      │
│  条件：根本假设错误，整体方案不可行                      │
│  操作：基于完整执行历史，LLM 重新生成整个计划            │
│  成本：高（全量 context，完整 LLM 推理）                │
└─────────────────────────────────────────────────────────┘
```

#### 检查点机制

```
AgentState 检查点（每 N 步自动保存）：
  checkpoint = {
      "step": current_step,
      "dag": current_dag_snapshot,
      "variables": state.variables.copy(),
      "completed_tasks": [t.id for t in done_tasks],
      "timestamp": datetime.utcnow().isoformat()
  }

  保存策略：
    - 每 5 步自动触发
    - 子任务 done 时触发
    - 用户中断前触发
    - 最多保留最近 5 个检查点（滑动窗口）
```

---

### 2.5 终止条件矩阵

| 终止条件 | 触发机制 | 优先级 | 处理策略 |
|---------|---------|-------|---------|
| **成功判定** | LLM 判断任务目标已完成 | 最高 | 输出最终结果，正常退出 |
| **用户中断** | 用户发送中断信号（Ctrl+C/API cancel） | 高 | 保存检查点，输出当前进度，安全退出 |
| **最大步数** | `state.iteration >= max_iterations`（默认 50） | 中 | 输出部分结果 + 截断警告，标记 `partial_complete` |
| **死循环检测** | 连续 5 步动作类型完全相同 | 中 | 强制终止 + 输出诊断报告 |
| **资源耗尽** | Token 预算消耗 > 80%（可配置） | 中 | 生成摘要性输出，优雅退出 |
| **不可恢复错误** | Level 4 重规划后仍失败 | 低 | 详细错误报告，建议用户干预 |

---

### 2.6 AgentState 状态机设计

AgentState 是规划层与 LangGraph 状态图的桥梁，扩展自 `Harness.py` 中的基础 `AgentState`。

```
                        ┌─────────┐
                        │  start  │
                        └────┬────┘
                             │
                        ┌────▼────────┐
                        │verify_input │
                        └────┬────────┘
                             │ 通过
                        ┌────▼────────┐
                        │build_context│ ← Memory recall
                        └────┬────────┘
                             │
                        ┌────▼────┐
         ┌──── replan ──│  plan   │←────────────────┐
         │              └────┬────┘                 │
         │                   │                      │
         │    ┌──────────────▼──────────────┐       │
         │    │     intent_classify         │       │
         │    │  SIMPLE_QA/SINGLE_TOOL/     │       │
         │    │  MULTI_STEP/CLARIFICATION   │       │
         │    └──────────────┬──────────────┘       │
         │                   │ MULTI_STEP            │
         │    ┌──────────────▼──────────────┐       │
         │    │     task_decompose          │       │
         │    │     strategy_select         │       │
         │    └──────────────┬──────────────┘       │
         │                   │                      │
         │              ┌────▼─────────┐            │
         │              │execute_tools │            │
         │              └────┬─────────┘            │
         │                   │                      │
         │              ┌────▼─────────┐            │
         │              │verify_output │            │
         │              └────┬─────────┘            │
         │                   │                      │
         │              ┌────▼─────────┐            │
         │              │   reflect    │            │
         │              └────┬─────────┘            │
         │                   │                      │
         │              ┌────▼─────────┐            │
         └──────────────│    decide    │────────────┘
                        └────┬─────────┘
                     完成/超时 │
                        ┌────▼─────────┐
                        │     end      │
                        └──────────────┘
```

**`_node_plan` 决策逻辑：**
1. 调用 `IntentClassifier.classify()` 获取意图类型
2. 若为 SIMPLE_QA → 直接走 LLM 生成，跳过工具层
3. 若为 CLARIFICATION → 生成追问，进入等待状态
4. 若为 MULTI_STEP → 调用 `TaskDecomposer.decompose()`，再调用 `StrategyRunner.select()`
5. 将规划结果存入 `state.variables["plan"]`，包含 `intent_type`、`dag`、`strategy`、`tool_calls`

**`_node_decide` 终止/继续/重规划判断：**
1. 检查 `plan.is_complete` — LLM 的完成判断
2. 检查 `state.is_terminal` — 步数/状态机终止条件
3. 检查 `deviation_detector.check()` — 偏差检测是否触发重规划
4. 返回 `"end"`（正常结束）/ `"plan"`（继续循环）/ `"replan"`（重规划）

---

### 2.7 核心接口定义（Protocol）

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, runtime_checkable


# ---------------------------------------------------------------------------
# 数据结构定义
# ---------------------------------------------------------------------------

class IntentType(Enum):
    SIMPLE_QA = "simple_qa"           # 直接回答，无需工具
    SINGLE_TOOL = "single_tool"       # 单次工具调用
    MULTI_STEP = "multi_step"         # 多步任务，需要规划
    CLARIFICATION = "clarification"   # 信息不足，需要追问


class Strategy(Enum):
    REACT = "react"                   # 默认：Think-Act-Observe 循环
    PLAN_AND_EXECUTE = "plan_and_execute"  # 先生成完整计划，再执行
    COT = "chain_of_thought"          # 纯推理，无工具调用


class SubTaskStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class TerminationReason(Enum):
    SUCCESS = "success"
    MAX_STEPS = "max_steps"
    DEAD_LOOP = "dead_loop"
    USER_INTERRUPT = "user_interrupt"
    RESOURCE_EXHAUSTED = "resource_exhausted"
    UNRECOVERABLE_ERROR = "unrecoverable_error"


@dataclass
class SubTask:
    id: str
    name: str
    description: str
    estimated_steps: int
    priority: int
    status: SubTaskStatus = SubTaskStatus.PENDING
    dependencies: list[str] = field(default_factory=list)
    result: dict[str, Any] | None = None
    retry_count: int = 0
    max_retries: int = 3


@dataclass
class TaskDAG:
    tasks: dict[str, SubTask]         # task_id → SubTask
    edges: list[tuple[str, str]]      # (from_id, to_id) 依赖边
    root_tasks: list[str]             # 无依赖的起始任务

    def get_ready_tasks(self) -> list[SubTask]:
        """返回所有依赖已完成、状态为 pending 的子任务。"""
        ...

    def mark_done(self, task_id: str, result: dict[str, Any]) -> None:
        """标记子任务完成并存储结果。"""
        ...

    def is_complete(self) -> bool:
        """判断整个 DAG 是否全部完成。"""
        ...


@dataclass
class Deviation:
    """执行偏差描述。"""
    step: int
    expected: dict[str, Any]
    actual: dict[str, Any]
    error_type: str                   # tool_failure / unexpected_result / timeout / dead_loop
    severity: int                     # 1=轻微, 2=中等, 3=严重, 4=不可恢复


@dataclass
class Plan:
    """规划结果。"""
    intent_type: IntentType
    strategy: Strategy
    dag: TaskDAG | None               # SIMPLE_QA / SINGLE_TOOL 时为 None
    tool_calls: list[dict[str, Any]]  # 当前步骤的工具调用列表
    is_complete: bool = False
    checkpoint: dict[str, Any] | None = None


@dataclass
class Context:
    """规划上下文。"""
    task: str
    history: list[dict[str, Any]]
    memories: list[dict[str, Any]]
    environment: dict[str, Any]
    iteration: int
    max_iterations: int


# ---------------------------------------------------------------------------
# Planner Protocol：规划层统一接口
# ---------------------------------------------------------------------------

@runtime_checkable
class Planner(Protocol):
    """
    规划层核心接口。
    所有规划实现（LangGraph/DSPy/PydanticAI 适配器）必须遵循此 Protocol。
    """

    async def classify_intent(
        self,
        user_input: str,
        context: Context,
    ) -> tuple[IntentType, float]:
        """
        意图识别。
        返回：(意图类型, 置信度)
        置信度 < 0.7 时建议降级为 CLARIFICATION。
        """
        ...

    async def decompose(
        self,
        task: str,
        context: Context,
    ) -> TaskDAG:
        """
        任务分解，返回子任务 DAG。
        仅在 intent_type == MULTI_STEP 时调用。
        """
        ...

    async def select_strategy(
        self,
        intent: IntentType,
        complexity: float,          # 0.0~1.0，由 LLM 或规则估算
        user_override: str | None,  # 用户手动指定策略
    ) -> Strategy:
        """
        推理策略选择。
        complexity > 0.7 且 intent == MULTI_STEP → PlanAndExecute
        否则默认 ReAct；SIMPLE_QA → CoT。
        """
        ...

    async def replan(
        self,
        current_state: Any,         # AgentState
        deviation: Deviation,
    ) -> Plan:
        """
        动态重规划。
        根据偏差严重程度选择 Level 1-4 修正策略。
        返回修订后的 Plan。
        """
        ...

    async def should_terminate(
        self,
        state: Any,                 # AgentState
    ) -> tuple[bool, TerminationReason | None]:
        """
        终止判断。
        返回：(是否终止, 终止原因)
        """
        ...

    async def generate_clarification(
        self,
        user_input: str,
        missing_info: list[str],
    ) -> str:
        """
        生成追问文本。
        仅在 intent_type == CLARIFICATION 时调用。
        """
        ...
```

---

### 2.8 配置项设计

在 `quilin/config.yaml` 的 `planning` 节：

```yaml
planning:
  # 意图识别
  intent:
    use_rule_fast_path: true        # 启用关键词规则快速通道
    llm_confidence_threshold: 0.7  # 低于此值降级为 CLARIFICATION
    rule_keywords:
      single_tool: ["搜索", "查询", "查找", "获取", "列出", "search", "fetch"]
      clarification: ["那个", "之前", "上面说的", "the thing", "as before"]

  # 策略选择
  strategy:
    default: "react"                # 默认策略
    complexity_threshold: 0.7      # 超过此值切换到 PlanAndExecute
    allow_user_override: true       # 允许用户手动指定策略

  # 执行控制
  execution:
    max_iterations: 50             # 最大循环步数
    checkpoint_interval: 5        # 每 N 步保存检查点
    max_checkpoints: 5            # 最多保留检查点数量
    dead_loop_window: 5           # 连续 N 步相同动作触发死循环检测

  # 动态重规划
  replanning:
    max_retries_per_task: 3        # 单任务最大重试次数
    replan_on_step_overrun: 2.0   # 步数超过预估 2x 时评估重规划
    token_budget_pct: 0.8         # token 预算使用 80% 时触发摘要退出
```

---

## 三、Top 10 参考项目

### 深入研究（前 5）

| # | 项目 | Stars（2026-04） | 核心规划特色 | GitHub |
|---|------|----------------|-------------|--------|
| 1 | LangGraph | ~126k | 状态机编排、条件路由、检查点持久化、中断/恢复 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| 2 | DSPy | ~16k | Signature/Module 编程范式、自动 prompt 优化、Optimizer | [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy) |
| 3 | OpenAI Agents SDK | ~20.7k | Runner 循环、Handoff 机制、Guardrails 集成 | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) |
| 4 | Pydantic AI | ~16k | 依赖注入、结构化结果、类型安全工具定义 | [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) |
| 5 | AutoGen | ~56.8k | ConversableAgent、GroupChat、代码执行器 | [microsoft/autogen](https://github.com/microsoft/autogen) |

### 观察参考（后 5）

| # | 项目 | Stars（2026-04） | 核心规划特色 | GitHub |
|---|------|----------------|-------------|--------|
| 6 | CrewAI | ~48.4k | 角色+任务+流程编排、Role-based planning | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) |
| 7 | Semantic Kernel | ~27.5k | Planner + Stepwise 规划、Function Calling 抽象 | [microsoft/semantic-kernel](https://github.com/microsoft/semantic-kernel) |
| 8 | LATS | ~1.5k | 蒙特卡洛树搜索规划、ICML 2024、探索性任务 | [lapisrocks/LanguageAgentTreeSearch](https://github.com/lapisrocks/LanguageAgentTreeSearch) |
| 9 | HuggingGPT (JARVIS) | ~24k | 模型选择即规划、LLM 作为 Controller | [microsoft/JARVIS](https://github.com/microsoft/JARVIS) |
| 10 | MetaGPT | ~61k | SOP 驱动规划、角色模拟软件公司流程 | [geekan/MetaGPT](https://github.com/geekan/MetaGPT) |

---

## 四、吸收内化方案

### 4.1 LangGraph → AgentState 状态机设计

**吸收点：** StateGraph + 条件边 + 检查点持久化

LangGraph 的核心创新是将 Agent 循环建模为**显式状态图**，而非隐式的 while 循环。每个节点是一个函数，每条边是一个条件路由。这使得状态转换完全可追溯、可调试、可回放。

Quilin 的 `AgentState` 直接继承这一思想，`_build_graph()` 方法构建的字典结构正是 LangGraph StateGraph 的简化实现。重点吸收：

1. **检查点持久化**：LangGraph 的 `MemorySaver` / `SqliteSaver` 机制启发了 Quilin 的检查点设计。每 N 步将 `AgentState.variables` 快照到 OmniMem 的 LONG tier，用于 Level 3 回滚重规划。
2. **条件边路由**：`_node_decide` 的三路分支（end/plan/replan）直接对应 LangGraph 的 `add_conditional_edges`，决策逻辑完全内化在节点函数中。
3. **中断/恢复**：LangGraph 的 `interrupt_before/interrupt_after` 机制启发了用户中断时的安全保存逻辑。

### 4.2 DSPy → 推理策略的可编程优化

**吸收点：** Module 编程范式 + Optimizer 自动调优

DSPy 的核心思想是：不要手写 prompt，而是定义 `Signature`（输入输出规范），让编译器自动优化 prompt。这与传统"精心设计 prompt"的范式完全相反。

Quilin 的吸收体现在两个层面：

1. **策略选择的可编程化**：`StrategyRunner` 的策略不是硬编码在 if-else 中，而是通过 `Strategy` 枚举 + 配置矩阵驱动，类似 DSPy 的 Module 组合方式，未来可以接入 DSPy Optimizer 自动调优 `select_strategy` 的 prompt。
2. **意图分类的 Signature 化**：`classify_intent` 的 LLM 调用可以包装为 DSPy `Predict` 模块，使意图分类的 prompt 可以通过少样本优化（BootstrapFewShot）自动改进，无需人工调整。

### 4.3 OpenAI Agents SDK → Handoff 机制与 Runner 循环

**吸收点：** Handoff 任务转交 + Runner 简洁实现

OpenAI Agents SDK 的 `Runner.run()` 循环极为简洁，其核心是：LLM 决定下一步动作，执行工具，将结果追加到对话历史，循环直到没有更多工具调用。这种实现简洁优雅，适合单 Agent 场景。

`Handoff` 机制允许一个 Agent 将任务转交给另一个专业 Agent，这是多 Agent 场景下任务分配的核心模式。

Quilin 的吸收：

1. **Runner 循环简洁性**：`Quilin.run()` 的主循环结构参考了 Runner 的简洁设计，while + state transition 的模式与 SDK 内核一致。
2. **Handoff 启发的任务转交**：当某个子任务需要特殊能力时（例如需要视觉模型处理图片），TaskDAG 中的子任务可以通过 MCP 消息转交给对应的 Perception 层 Provider，这正是 Handoff 思想的体现。

### 4.4 Pydantic AI → 类型安全与依赖注入

**吸收点：** 工具定义类型安全 + 依赖注入模式

Pydantic AI 的最大创新是将 Python 类型系统深度融入 Agent 工具定义，所有工具的输入输出都有明确的 Pydantic 模型约束，在开发时即可发现类型错误。

依赖注入（`RunContext[Dependencies]`）让 Agent 可以在不同环境下注入不同的实现（测试时注入 Mock，生产时注入真实服务）。

Quilin 的吸收：

1. **Protocol + 类型注解**：`Planner Protocol` 的所有方法均有完整类型注解，`SubTask`/`TaskDAG`/`Plan` 等数据结构使用 `@dataclass` 而非裸 dict。
2. **依赖注入模式**：`Planner` 的具体实现（LangGraph adapter / DSPy adapter）通过 `PluginRegistry` 注入，与 Pydantic AI 的 `RunContext` 设计思路一致，便于测试替换。

### 4.5 AutoGen → 多轮对话规划模式

**吸收点：** ConversableAgent 循环 + 代码执行验证

AutoGen 的 `ConversableAgent.generate_reply()` 循环是多轮对话规划的经典实现：每个 Agent 根据对话历史生成回复，多个 Agent 通过 GroupChat 协作完成任务。

代码执行器（`LocalCommandLineCodeExecutor`）允许 Agent 生成代码并立即执行验证结果，这是"规划即代码"模式的核心。

Quilin 的吸收：

1. **多轮对话历史**：`AgentState.history` 保存完整的节点转换历史，每次 `_node_plan` 都将历史传递给规划器，类似 AutoGen 的对话历史管理。
2. **执行验证循环**：PlanAndExecute 策略的 Phase 3（对照检查）直接受 AutoGen 代码执行器验证模式启发，每步执行后对照预期验证，不符合则触发重规划。

---

## 五、与 Harness 组件映射

### 组件目录结构

```
quilin/
├── core/
│   └── Harness.py                   # AgentState / Quilin 主循环
└── planning/
    ├── __init__.py
    ├── planner.py                   # Planner Protocol + 默认实现
    ├── classifier.py                # IntentClassifier（意图识别）
    ├── decomposer.py                # TaskDecomposer（任务分解 DAG）
    ├── strategies.py                # StrategyRunner（ReAct/PlanAndExecute/CoT）
    └── correction.py                # DynamicReplanner（偏差检测 + 重规划）
```

### 组件接口映射表

| 组件 | 文件路径 | 核心接口 | 关联节点 |
|------|---------|---------|---------|
| `IntentClassifier` | `quilin/planning/classifier.py` | `classify(user_input, context) → (IntentType, float)` | `_node_plan` |
| `TaskDecomposer` | `quilin/planning/decomposer.py` | `decompose(task, context) → TaskDAG` | `_node_plan` |
| `StrategyRunner` | `quilin/planning/strategies.py` | `select(intent, complexity) → Strategy` / `run(strategy, dag)` | `_node_plan` / `_node_execute_tools` |
| `DynamicReplanner` | `quilin/planning/correction.py` | `check_deviation(step_result) → Deviation | None` / `replan(state, deviation) → Plan` | `_node_decide` |
| `AgentState` | `quilin/core/Harness.py` | `transition(next_node)` / `is_terminal` | 所有节点 |

### 完整 Provider 适配器接口

```python
# quilin/planning/planner.py

from quilin.core.Harness import LayerProvider, MCPMessage
from quilin.planning.types import (
    Plan, Context, Deviation, IntentType, Strategy
)


class PlanningProvider(LayerProvider):
    """
    规划层 Provider 适配器基类。
    具体实现：LangGraphPlanningProvider / DSPyPlanningProvider 等。
    """

    @property
    def name(self) -> str: ...

    @property
    def layer(self) -> str:
        return "planning"

    async def initialize(self, config: dict) -> None:
        """加载模型、初始化分类器和策略引擎。"""
        ...

    async def execute(self, payload: dict) -> dict:
        """
        通过 MCP 协议接收规划请求。
        payload 包含：
          - method: "generate_plan" | "replan" | "classify_intent" | "reflect"
          - task: str
          - context: dict
          - state: dict（序列化的 AgentState）
        """
        method = payload.get("method")
        if method == "generate_plan":
            return await self._handle_generate_plan(payload)
        elif method == "replan":
            return await self._handle_replan(payload)
        elif method == "classify_intent":
            return await self._handle_classify(payload)
        elif method == "reflect":
            return await self._handle_reflect(payload)
        return {"error": f"unknown method: {method}"}

    async def healthcheck(self) -> bool:
        """检查 LLM 连接是否正常。"""
        ...

    async def shutdown(self) -> None: ...
```

### 性能约束

| 操作 | SLA | 备注 |
|------|-----|------|
| 规则快速通道（意图分类） | < 5ms | 纯内存操作，无 LLM 调用 |
| LLM 意图分类 | < 800ms | 使用 haiku 级别模型 |
| 任务分解（DAG 生成） | < 2s | 复杂任务允许延长到 5s |
| 策略选择 | < 50ms | 规则矩阵匹配，无 LLM |
| 单步 ReAct 循环 | < 3s | 包含工具调用等待 |
| Level 1-2 重规划 | < 1s | 局部调整，少量 LLM 调用 |
| Level 3-4 重规划 | < 10s | 完整重规划，接受延迟 |

---

## 六、验证标准

### 6.1 单元测试

#### 意图识别（4 类各提供测试用例）

```python
import pytest
from quilin.planning.classifier import IntentClassifier
from quilin.planning.types import IntentType, Context

# 测试用例覆盖矩阵（每类至少 5 个用例）

SIMPLE_QA_CASES = [
    ("Python 中的 GIL 是什么？", IntentType.SIMPLE_QA),
    ("解释一下 CAP 定理", IntentType.SIMPLE_QA),
    ("比较 REST 和 GraphQL 的优缺点", IntentType.SIMPLE_QA),
    ("什么是向量数据库？", IntentType.SIMPLE_QA),
    ("ReAct 和 CoT 有什么区别？", IntentType.SIMPLE_QA),
]

SINGLE_TOOL_CASES = [
    ("搜索最新的 GPT-5 新闻", IntentType.SINGLE_TOOL),
    ("查询今天 BTC 的价格", IntentType.SINGLE_TOOL),
    ("获取 LangGraph 的最新版本号", IntentType.SINGLE_TOOL),
    ("列出当前目录下的所有 Python 文件", IntentType.SINGLE_TOOL),
    ("fetch the README of langchain-ai/langgraph", IntentType.SINGLE_TOOL),
]

MULTI_STEP_CASES = [
    ("从 GitHub 拉取代码，运行测试，然后发邮件", IntentType.MULTI_STEP),
    ("分析这份报告，找出关键指标，然后生成可视化图表", IntentType.MULTI_STEP),
    ("搜索竞品信息，整理成表格，并给出建议", IntentType.MULTI_STEP),
    ("读取 CSV 文件，清洗数据，然后训练一个分类模型", IntentType.MULTI_STEP),
    ("check the API status, if down send alert, else log success", IntentType.MULTI_STEP),
]

CLARIFICATION_CASES = [
    ("帮我处理一下那个文件", IntentType.CLARIFICATION),
    ("按照之前说的方式做", IntentType.CLARIFICATION),
    ("继续", IntentType.CLARIFICATION),
    ("做那件事", IntentType.CLARIFICATION),
    ("update it", IntentType.CLARIFICATION),
]


@pytest.mark.unit
@pytest.mark.parametrize("user_input,expected_intent", SIMPLE_QA_CASES)
async def test_classify_simple_qa(classifier: IntentClassifier, ctx: Context, user_input, expected_intent):
    intent, confidence = await classifier.classify(user_input, ctx)
    assert intent == expected_intent
    assert confidence >= 0.7


@pytest.mark.unit
@pytest.mark.parametrize("user_input,expected_intent", CLARIFICATION_CASES)
async def test_classify_clarification(classifier: IntentClassifier, ctx: Context, user_input, expected_intent):
    intent, confidence = await classifier.classify(user_input, ctx)
    assert intent == expected_intent
```

#### 任务分解 DAG 正确性

```python
@pytest.mark.unit
async def test_dag_dependency_order(decomposer: TaskDecomposer, ctx: Context):
    """验证 DAG 依赖关系正确，ready_tasks 不包含未完成依赖的任务。"""
    dag = await decomposer.decompose("拉代码、安装依赖、运行测试", ctx)

    # T2 依赖 T1，T1 未完成时 T2 不应在 ready_tasks 中
    ready = dag.get_ready_tasks()
    ready_ids = {t.id for t in ready}

    for task in dag.tasks.values():
        if task.dependencies:
            for dep_id in task.dependencies:
                if dep_id not in [t.id for t in dag.tasks.values() if t.status == SubTaskStatus.DONE]:
                    assert task.id not in ready_ids


@pytest.mark.unit
async def test_dag_parallel_execution(decomposer: TaskDecomposer, ctx: Context):
    """验证并行任务同时出现在 ready_tasks 中。"""
    dag = await decomposer.decompose("并行执行单元测试和集成测试", ctx)
    ready = dag.get_ready_tasks()
    assert len(ready) >= 2, "并行任务应同时可执行"
```

#### 终止条件判断逻辑

```python
@pytest.mark.unit
async def test_terminate_on_max_steps(planner: Planner):
    """验证超过最大步数时触发终止。"""
    state = AgentState(iteration=51, max_iterations=50)
    should_stop, reason = await planner.should_terminate(state)
    assert should_stop is True
    assert reason == TerminationReason.MAX_STEPS


@pytest.mark.unit
async def test_terminate_on_dead_loop(planner: Planner):
    """验证连续相同动作触发死循环终止。"""
    state = AgentState()
    # 模拟连续 5 步调用相同工具
    state.variables["recent_actions"] = ["search"] * 5
    should_stop, reason = await planner.should_terminate(state)
    assert should_stop is True
    assert reason == TerminationReason.DEAD_LOOP
```

---

### 6.2 集成测试

#### ReAct 循环端到端（Think→Act→Observe 多轮）

```python
@pytest.mark.integration
async def test_react_multi_round(harness: Quilin):
    """
    测试 ReAct 循环的多轮执行：
    任务：搜索 LangGraph 最新版本，然后搜索其 changelog
    预期：至少 2 次工具调用，结果包含版本信息
    """
    ctx = await harness.run(
        task="搜索 LangGraph 最新版本号，然后找到对应的 changelog 内容"
    )

    assert ctx.status == "completed"
    tool_calls_total = sum(
        trace_item.get("tool_count", 0)
        for trace_item in ctx.trace
        if trace_item["node"] == "execute_tools"
    )
    assert tool_calls_total >= 2, "多步任务应至少有 2 次工具调用"
    assert ctx.outputs.get("tool_results"), "应有工具调用结果"
```

#### 动态重规划触发（故意让工具失败 → 触发重规划）

```python
@pytest.mark.integration
async def test_replan_on_tool_failure(harness: Quilin, mock_failing_tool):
    """
    测试工具失败触发重规划：
    前 3 次工具调用强制失败，验证 Level 1 重试 → Level 2 调整发生
    """
    mock_failing_tool.fail_count = 3  # 前 3 次调用失败

    ctx = await harness.run(task="搜索最新 AI 新闻并总结")

    replan_events = [t for t in ctx.trace if t.get("node") == "decide" and t.get("action") == "replan"]
    assert len(replan_events) >= 1, "工具失败后应触发重规划"
    assert ctx.status == "completed", "重规划后应成功完成任务"
```

#### 检查点保存 / 恢复

```python
@pytest.mark.integration
async def test_checkpoint_save_and_restore(harness: Quilin):
    """
    测试检查点机制：
    执行 10 步后中断，从检查点恢复，验证状态一致性
    """
    # 执行前 5 步后获取检查点
    checkpoint = await harness.get_latest_checkpoint(run_id="test-run")
    assert checkpoint is not None

    # 从检查点恢复
    restored_ctx = await harness.resume_from_checkpoint(checkpoint)
    assert restored_ctx.status in ("completed", "running")
    assert restored_ctx.outputs.get("iterations", 0) > 0
```

---

### 6.3 端到端测试

#### E2E-1：简单问答直接回答（不调工具）

```
输入：Python 中的装饰器是什么？
预期行为：
  ✓ 意图分类 → SIMPLE_QA（< 800ms）
  ✓ 跳过工具层（tool_count = 0）
  ✓ LLM 直接输出答案（< 3s）
  ✓ 回答包含"装饰器"核心概念解释
  ✓ 整体耗时 < 5s
```

#### E2E-2：复杂任务自动分解 + 逐步执行

```
输入：帮我搜索最新的 3 个 Python Web 框架，
      然后对比它们的 GitHub stars 和主要特性，
      最后生成一个 Markdown 对比表格
预期行为：
  ✓ 意图分类 → MULTI_STEP
  ✓ 任务分解为 ≥ 3 个子任务（搜索×3 + 对比 + 生成）
  ✓ 策略选择 → PlanAndExecute（复杂度高）
  ✓ 工具调用 ≥ 4 次
  ✓ 最终输出包含 Markdown 表格
  ✓ 整体耗时 < 60s
```

#### E2E-3：执行偏差时自动修正计划

```
输入：获取 example.com 的内容并分析其 SEO 结构
      （注：第一次请求超时，模拟网络不稳定）
预期行为：
  ✓ 首次工具调用失败 → Level 1 重试
  ✓ 重试成功 → 继续执行（无感知）
      或
  ✓ 重试失败 → Level 2 调整（换镜像源/换工具）
  ✓ 最终完成分析，状态为 completed
  ✓ trace 中包含重试/重规划事件记录
```

#### 验收指标汇总

| 指标 | 目标值 | 测试覆盖 |
|------|--------|---------|
| 意图分类准确率（4类） | ≥ 90% | 20 个标注测试用例 |
| 规则通道命中率 | ≥ 60% | 节省 LLM 调用 |
| 任务分解 DAG 正确率 | ≥ 85% | 依赖顺序验证 |
| 动态重规划成功率 | ≥ 80% | 工具失败场景 |
| 检查点恢复无数据丢失 | 100% | 幂等性验证 |
| 单元测试覆盖率 | ≥ 80% | pytest --cov |
| SIMPLE_QA 平均耗时 | < 5s | 性能基准测试 |
| MULTI_STEP 平均耗时 | < 60s | 端到端基准 |
