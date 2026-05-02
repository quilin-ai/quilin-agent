# 多 Agent 工程（Multi-Agent Engineering）

> **实现状态（2026-04-30 校准）**
> - ✅ **已实现**：Planning delegation policy / long-task integration 的规则层已在 Iter C 落地；同进程 Supervisor/Sub-Agent runtime 尚未落地。
> - 🚧 **部分实现 / 延期**：Supervisor 规则与进度协议仍是 spec；mesh 依赖 11-agent-mesh，Iter D 只落 Rust stub，不启用跨进程通信。
> - Linear 后续项：[QUI-9](https://linear.app/quilin-agent/issue/QUI-9/iter-f-implement-multi-agent-supervisor-runtime)；Agent Mesh runtime 见 [QUI-10](https://linear.app/quilin-agent/issue/QUI-10/iter-f-land-agent-mesh-runtime-path)。

> **ADR-001 对齐说明**：同构 Agent 在 TS 进程内 spawn；异构 Agent 通过 Agent Mesh 通信（见 [11-agent-mesh](../11-agent-mesh/README.md)）。mesh 上怎么做事情由用户决定，Quilin 不设计编排策略。本文档中的 Python 代码示例仅表达设计意图。`quilin/` 路径为规划参考。详见 [Core Loop](../00-core-loop/README.md)。

## 一、问题定义

### 为什么单 Agent 不够？

单个 Agent 在一个线性的 ReAct 循环中运行，面对以下场景时会遭遇根本性瓶颈：

| 场景 | 单 Agent 的问题 | 多 Agent 的解法 |
|------|----------------|----------------|
| 任务过于复杂 | 上下文窗口溢出，思维链断裂 | 分解子任务，各 Agent 独立持有上下文 |
| 需要不同专长 | 一个模型无法同时精通代码/安全/法律 | 专家 Agent 各司其职（Coder/Reviewer/Legal）|
| 串行太慢 | 每步都要等 LLM 推理，无法并发 | 并行 Agent 同时处理不同分支 |
| 需要对抗偏差 | 单一视角容易产生确认偏差 | 多 Agent 辩论/互审，发现盲点 |
| 需要持续运行 | 单 Agent 长任务容易超时或丢失状态 | 多 Agent 接力，局部失败不影响全局 |

### 多 Agent 的核心挑战

多 Agent 系统引入了分布式系统的经典难题：

1. **任务分配**：Supervisor 如何决定谁做什么？需要能力声明、负载感知、优先级调度
2. **结果聚合**：多个 Agent 返回不同答案时，如何合并成一个最终输出？
3. **冲突解决**：Agent A 说"做 X"，Agent B 说"做 Y"，需要仲裁机制
4. **共享状态**：哪些记忆/上下文在 Agent 间可见？全局共享 vs 局部隔离
5. **死锁检测**：Agent A 等 B，B 等 C，C 等 A，系统陷入永久等待
6. **级联失败**：一个 Agent 崩溃导致依赖它的所有 Agent 也失败
7. **幂等性**：重试某个 Agent 任务时，不能产生重复的副作用

### 业界现状（2026 年 4 月）

多 Agent 已从实验阶段进入工程化阶段：

- **OpenAI** 于 2025 年 3 月发布 Agents SDK（Swarm 正式版），内置 Handoff 机制
- **Google** 发布 A2A 协议（Agent-to-Agent），定义跨 Agent 的标准通信格式
- **Microsoft** 推出 Magentic-One（通用多 Agent 编排）和 Agent Framework（替代 AutoGen）
- **Anthropic** 在 Claude SDK 中原生支持多 Agent 子任务（claude-code sub-agents）
- 主流框架（LangGraph / CrewAI / AutoGen）的多 Agent 能力已趋于成熟，生产可用

---

## 二、设计方案

### 编排模式全览

| 模式 | 适用场景 | 特点 |
|------|---------|------|
| **顺序** | 强依赖的流水线任务 | Agent A → B → C，简单可靠，无法并发 |
| **并行** | 独立子任务 | A / B / C 同时执行，合并结果，最快 |
| **层级（Supervisor-Worker）** | 复杂任务分解 | Supervisor 分配任务，Workers 执行，递归可嵌套 |
| **辩论** | 需要多角度验证 | 多 Agent 对同一问题各自推理，再投票/综合 |
| **流水线** | 数据逐级处理 | 每个 Agent 处理一个阶段，传递中间结果 |
| **动态** | 任务结构不确定 | 运行时根据需要创建/销毁 Agent |

### 核心设计哲学：非阻塞 Supervisor（默认架构）

> **设计原则**：主 Agent = 永远可用的 Supervisor，只负责用户 I/O + 任务分发 + 结果汇总。所有具体任务执行委派给 Sub-Agent。**主 Agent 永远不被阻塞。**

在所有编排模式中，**Supervisor-Worker 是 Quilin 的默认架构**，而非可选项。这源于一个关键用户痛点：

```
❌ 现有 Agent（OpenClaw / Hermes / Claude Code / Codex）的问题：
   用户："做任务 A"
   Agent 主线程开始执行任务 A...（占用中）
   用户："做任务 B" / "任务 A 什么进度了？" / "取消任务 A"
   Agent：（无响应，主线程被阻塞）

✅ Quilin 的设计：
   用户："做任务 A"
   Supervisor：收到，已派给 Sub-Agent-1 执行 → 即刻空闲
   用户："做任务 B"
   Supervisor：收到，已派给 Sub-Agent-2 执行 → 即刻空闲
   用户："任务 A 什么进度了？"
   Supervisor：查询 Sub-Agent-1 状态 → 立即返回进度报告
   用户："取消任务 A"
   Supervisor：终止 Sub-Agent-1 → 即刻确认
```

**任务分发策略**：

| 任务类型 | 分发方式 | 说明 |
|---------|---------|------|
| 简单问答 | Supervisor 直接回答 | 不需要 spawn Sub-Agent（如闲聊、短问答） |
| 单一任务 | 单个 Sub-Agent | 如"写一个函数"、"修复某个 bug" |
| 可拆分复杂任务 | Multi-Sub-Agent 并行 | 如"重构这个模块"→ 拆分为代码分析 + 重构 + 测试 |
| 多独立任务 | Multi-Sub-Agent 并行 | 用户一次下达多个不相关任务 |

**Supervisor 职责边界**：

```python
class SupervisorResponsibilities:
    """Supervisor 只做这些事，绝不做具体任务执行"""
    
    ALLOWED = [
        "接收用户输入",
        "意图识别与任务分解（快模型：Haiku 4.5，≤5s 预算）",
        "选择/创建 Sub-Agent",
        "分配任务给 Sub-Agent",
        "监控 Sub-Agent 状态",
        "收集/聚合 Sub-Agent 结果（聚合本身仍走快模型，不做深推理）",
        "向用户返回结果",
        "响应用户的进度查询",
        "处理任务取消/重试请求",
        "空闲时触发自进化（见 10-self-evolution 2.12）",
    ]
    
    FORBIDDEN = [
        "直接执行代码修改/文件操作",
        "直接调用外部 API/浏览器",
        "调用慢模型（Sonnet 4.6 / Opus 4.7）做推理——必须 spawn Sub-Agent 承接",
        "任何单步 LLM 调用预算 > 5s 的操作（硬超时：监督器级别 SLO）",
        "任何可能阻塞用户交互的操作",
    ]
```

**D-06 双模型分工（2026-04-18 定稿）**：

| 场景 | 模型 | 延迟预算 | 执行位置 |
|------|------|---------|---------|
| 意图识别 / 任务分解 / 进度聚合 | **Haiku 4.5**（快模型） | ≤5s | **Supervisor 进程内**，同步调用 |
| 代码生成 / 深度推理 / 长任务 | **Sonnet 4.6 或 Opus 4.7**（慢模型） | 无上限（用户可取消） | **Sub-Agent 进程**，异步 spawn |
| 纯规则决策（路由 / 配额检查） | 无 LLM | <50ms | Supervisor 进程内 |

**硬约束**：
- Supervisor 进程内绝不调用慢模型，哪怕"只要问一下"也不行——统一按 spawn Sub-Agent 处理。这避免了"快 fallback 慢"导致的阻塞雪崩。
- 快模型单次调用超过 5s 预算 → 直接 timeout，降级为"我再看看"+ spawn Sub-Agent 继续。用户看到 Supervisor 依然可交互。
- Sub-Agent 结果聚合若需要 LLM，用**快模型**做简单合并；如果需要深思（合并冲突、多方意见调和），则再 spawn 一个 summary Sub-Agent。

**与空闲自进化的联动**：当 Supervisor 处于真正空闲状态（无用户输入 AND 无 pending Sub-Agent 任务）时，自动进入空闲自进化模式（详见 [10-self-evolution 2.12](../10-self-evolution/README.md)）。

### Supervisor-Worker 完整流程

```
┌──────────────────────────────────────────────────────────────┐
│                    Supervisor Agent                           │
│                                                              │
│  ① 接收复杂任务                                               │
│  ② 任务分解（Task Decomposition）                              │
│       ├── SubTask-1: "搜索相关论文"                            │
│       ├── SubTask-2: "分析数据集"                              │
│       └── SubTask-3: "生成可视化"                              │
│  ③ 分配给 Worker（能力匹配 + 负载均衡）                          │
│  ④ 并行监控所有 Worker 状态                                     │
│  ⑤ 收集结果（等待 / 超时处理）                                   │
│  ⑥ 结果聚合（投票 / 合并 / LLM 综合）                            │
│  ⑦ 输出最终结果                                               │
└───────────────┬──────────────────────────────────────────────┘
                │ spawn + monitor + collect
    ┌───────────┼───────────────────────┐
    ▼           ▼                       ▼
┌────────┐  ┌────────┐            ┌────────────┐
│Worker-1│  │Worker-2│            │  Worker-3  │
│(Search)│  │(Analyst│            │(Visualizer)│
│        │  │        │            │            │
│可递归  │  │可递归  │            │  可递归    │
│spawn   │  │spawn   │            │  spawn     │
│子Worker│  │子Worker│            │  子Worker  │
└────────┘  └────────┘            └────────────┘
    │              │                    │
    ▼              ▼                    ▼
AgentResult    AgentResult         AgentResult
    └──────────────┴────────────────────┘
                   │
              聚合层（Aggregator）
                   │
              最终输出（Final Output）
```

### SubAgent Protocol 伪代码

```python
from typing import Protocol
from dataclasses import dataclass
from enum import Enum

class AgentStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED  = "failed"
    TIMEOUT = "timeout"

@dataclass
class AgentResult:
    agent_id: str
    status:   AgentStatus
    output:   str | None
    error:    str | None
    duration_ms: int

class SubAgent(Protocol):
    """所有 Worker Agent 必须实现的接口"""
    agent_id:     str
    role:         str           # 角色描述，e.g. "代码审核专家"
    capabilities: list[str]     # 声明能力，e.g. ["python", "security"]

    async def spawn(
        self,
        task:    str,
        context: dict,
        timeout: float = 60.0,
    ) -> str:
        """创建子 Agent 执行任务，返回 agent_id"""
        ...

    async def monitor(self, agent_id: str) -> AgentStatus:
        """查询 Agent 当前状态"""
        ...

    async def collect(self, agent_id: str) -> AgentResult:
        """阻塞直到 Agent 完成，返回结果"""
        ...

    async def terminate(self, agent_id: str) -> None:
        """强制终止 Agent（超时/取消时调用）"""
        ...
```

### Sub-Agent 进度汇报协议（Progress Reporting Protocol）

> **核心问题**：用户把任务交给 Sub-Agent 后，如果几分钟没有反馈，不知道是在正常执行还是卡住了。必须有主动的进度汇报机制。

进度汇报通过两种触发方式协同工作：

| 触发方式 | 适用场景 | 说明 |
|---------|---------|------|
| **Checkpoint-based**（检查点触发） | 任务有明确步骤 | 每完成一个关键步骤主动汇报 |
| **Heartbeat-based**（心跳触发） | 长时间无检查点 | 定时发送"我还活着"的状态报告 |

```python
from dataclasses import dataclass, field
from enum import Enum

class ProgressLevel(Enum):
    """进度报告的详细程度"""
    MINIMAL   = "minimal"     # 仅状态（running/done/failed）
    SUMMARY   = "summary"     # 状态 + 一句话描述
    DETAILED  = "detailed"    # 状态 + 描述 + 步骤列表 + 中间产物

@dataclass
class ProgressReport:
    """Sub-Agent 进度报告"""
    agent_id: str
    task_id: str
    timestamp: float
    
    # 进度信息
    status: AgentStatus                     # PENDING / RUNNING / SUCCESS / FAILED
    progress_pct: float = 0.0               # 0.0 ~ 1.0，粗略估计
    current_step: str = ""                  # 当前正在做什么
    steps_completed: int = 0                # 已完成步骤数
    steps_total: int = 0                    # 预估总步骤数（0 = 未知）
    
    # 触发类型
    trigger: str = "checkpoint"             # "checkpoint" | "heartbeat"
    
    # 可选详情
    intermediate_output: str | None = None  # 中间产物（如部分代码）
    error_hint: str | None = None           # 遇到问题时的提示
    estimated_remaining_s: int | None = None  # 预估剩余时间（秒）

class ProgressReporter(Protocol):
    """Sub-Agent 必须实现的进度汇报接口"""
    
    async def report_checkpoint(
        self,
        step_name: str,
        progress_pct: float,
        intermediate_output: str | None = None,
    ) -> None:
        """关键步骤完成时调用"""
        ...
    
    async def start_heartbeat(
        self,
        interval_s: float = 30.0,
    ) -> None:
        """启动心跳，每 interval_s 秒自动发送状态"""
        ...
    
    async def stop_heartbeat(self) -> None:
        """任务完成时停止心跳"""
        ...
```

**Supervisor 端的进度聚合**：

```python
class SupervisorProgressAggregator:
    """Supervisor 聚合所有 Sub-Agent 的进度报告"""
    
    def __init__(self):
        self._reports: dict[str, ProgressReport] = {}  # agent_id -> latest report
        self._subscribers: list[Callable] = []          # 进度变更订阅者
    
    def on_progress(self, report: ProgressReport) -> None:
        """接收 Sub-Agent 进度报告"""
        self._reports[report.agent_id] = report
        for subscriber in self._subscribers:
            subscriber(report)
    
    def get_summary(self) -> dict:
        """获取所有 Sub-Agent 的进度摘要（供 WebUI 或 IM 展示）"""
        return {
            "total_agents": len(self._reports),
            "running": sum(1 for r in self._reports.values() if r.status == AgentStatus.RUNNING),
            "completed": sum(1 for r in self._reports.values() if r.status == AgentStatus.SUCCESS),
            "failed": sum(1 for r in self._reports.values() if r.status == AgentStatus.FAILED),
            "overall_progress": self._calc_overall_progress(),
            "agents": {
                aid: {
                    "status": r.status.value,
                    "progress": r.progress_pct,
                    "current_step": r.current_step,
                    "estimated_remaining_s": r.estimated_remaining_s,
                }
                for aid, r in self._reports.items()
            },
        }
```

**IM 场景下的主动推送策略**：

在 IM 工具（Telegram/Slack/微信）中，用户无法看到 WebUI Dashboard，因此 Supervisor 需要主动推送进度：

| 推送条件 | 内容 | 示例 |
|---------|------|------|
| Sub-Agent 开始执行 | 任务确认 + 预估时间 | "✅ 已开始执行，预计 2 分钟完成" |
| 完成关键检查点 | 步骤进度 | "📌 步骤 2/5 完成：代码分析已完成，开始重构..." |
| 超过 60s 无检查点 | 心跳状态 | "⏳ 仍在执行中（已运行 90s），当前：运行测试..." |
| 遇到问题需决策 | 问题描述 + 选项 | "⚠️ 发现 2 种修复方案，需要你选择：A)... B)..." |
| 任务完成 | 结果摘要 | "✅ 任务完成！修复了 3 个文件，通过全部测试" |
| 任务失败 | 错误摘要 + 建议 | "❌ 任务失败：测试超时。建议：检查网络连接" |

**配置项**（用户可调）：

```yaml
progress_reporting:
  heartbeat_interval_s: 30         # 心跳间隔
  im_push_min_interval_s: 15      # IM 推送最短间隔（防刷屏）
  im_push_on_checkpoint: true      # 检查点时推送 IM
  im_push_on_heartbeat: false      # 心跳时推送 IM（默认关闭，避免太吵）
  webui_realtime: true             # WebUI 实时展示
  detail_level: "summary"          # minimal | summary | detailed
```

### 结果聚合策略

```python
from enum import Enum
from typing import Callable

class AggregationStrategy(Enum):
    VOTE     = "vote"       # 多数投票
    WEIGHTED = "weighted"   # 加权合并
    LLM      = "llm"        # LLM 综合推理
    DEBATE   = "debate"     # 辩论收敛

# 1. 投票策略（适合分类/判断类任务）
def vote_aggregate(results: list[AgentResult]) -> str:
    from collections import Counter
    outputs = [r.output for r in results if r.status == AgentStatus.SUCCESS]
    return Counter(outputs).most_common(1)[0][0]

# 2. 加权合并（按 Agent 可信度评分）
def weighted_aggregate(
    results:    list[AgentResult],
    weights:    dict[str, float],       # agent_id -> 可信度评分
) -> str:
    # 对数值型输出做加权平均；对文本型按权重选择最高评分 Agent 的输出
    scored = sorted(
        [(weights.get(r.agent_id, 1.0), r.output)
         for r in results if r.status == AgentStatus.SUCCESS],
        reverse=True,
    )
    return scored[0][1]

# 3. LLM 综合（适合开放型文本任务）
async def llm_aggregate(
    results:   list[AgentResult],
    llm_client,                          # 共享 LLMClient 实例
) -> str:
    all_outputs = "\n---\n".join(
        f"Agent {r.agent_id}:\n{r.output}"
        for r in results if r.status == AgentStatus.SUCCESS
    )
    prompt = f"以下是多个专家 Agent 的分析结果：\n{all_outputs}\n\n请综合所有观点，给出最终答案。"
    return await llm_client.complete(prompt)

# 4. 辩论收敛（适合需要高质量答案的任务）
async def debate_aggregate(
    agents:     list[SubAgent],
    question:   str,
    rounds:     int = 3,
) -> str:
    """多 Agent 多轮辩论，直到达成共识"""
    positions = {a.agent_id: "" for a in agents}
    for round_num in range(rounds):
        for agent in agents:
            others_views = "\n".join(
                f"{aid}: {pos}"
                for aid, pos in positions.items()
                if aid != agent.agent_id and pos
            )
            context = {
                "question":    question,
                "round":       round_num,
                "others_views": others_views,
            }
            result = await agent.collect(
                await agent.spawn(question, context)
            )
            positions[agent.agent_id] = result.output or ""
        # 检查是否收敛（所有 Agent 输出相似度 > 阈值）
        if _is_converged(list(positions.values())):
            break
    return list(positions.values())[-1]
```

### 死锁检测与超时

```python
import asyncio
from collections import defaultdict

class DeadlockDetector:
    """基于等待图的死锁检测（循环依赖检测）"""

    def __init__(self):
        # wait_graph[A] = {B, C} 表示 A 正在等待 B 和 C
        self.wait_graph: dict[str, set[str]] = defaultdict(set)

    def add_wait(self, waiter: str, waiting_for: str) -> None:
        self.wait_graph[waiter].add(waiting_for)

    def remove_wait(self, waiter: str, waiting_for: str) -> None:
        self.wait_graph[waiter].discard(waiting_for)

    def has_cycle(self) -> tuple[bool, list[str]]:
        """DFS 检测循环，返回 (has_cycle, cycle_path)"""
        visited, rec_stack = set(), set()

        def dfs(node: str, path: list[str]) -> list[str] | None:
            visited.add(node)
            rec_stack.add(node)
            for neighbor in self.wait_graph.get(node, set()):
                if neighbor not in visited:
                    result = dfs(neighbor, path + [neighbor])
                    if result is not None:
                        return result
                elif neighbor in rec_stack:
                    return path + [neighbor]   # 发现环
            rec_stack.discard(node)
            return None

        for node in list(self.wait_graph):
            if node not in visited:
                cycle = dfs(node, [node])
                if cycle:
                    return True, cycle
        return False, []


class AgentTimeoutManager:
    """全局超时 + 单 Agent 超时 + 降级策略"""

    def __init__(
        self,
        global_timeout:  float = 300.0,  # 整个任务超时（秒）
        agent_timeout:   float = 60.0,   # 单个 Agent 超时
        fallback_output: str   = "",     # 超时后的降级默认输出
    ):
        self.global_timeout  = global_timeout
        self.agent_timeout   = agent_timeout
        self.fallback_output = fallback_output

    async def run_with_timeout(
        self,
        coro,
        agent_id: str,
    ) -> AgentResult:
        try:
            result = await asyncio.wait_for(coro, timeout=self.agent_timeout)
            return result
        except asyncio.TimeoutError:
            # 降级策略：返回空结果，不阻塞整体流程
            return AgentResult(
                agent_id    = agent_id,
                status      = AgentStatus.TIMEOUT,
                output      = self.fallback_output,
                error       = f"Agent {agent_id} timed out after {self.agent_timeout}s",
                duration_ms = int(self.agent_timeout * 1000),
            )
```

### 并行执行设计

```python
import asyncio
from quilin.core.llm   import LLMClient
from quilin.core.memory import MemoryStore

class ParallelExecutor:
    """
    基于 asyncio.Task 的轻量级并行执行器。
    - 共享 LLMClient（避免重复初始化，节省连接资源）
    - 共享 MemoryStore（支持 Agent 间记忆可见性控制）
    """

    def __init__(
        self,
        llm_client:    LLMClient,
        memory_store:  MemoryStore,
        max_concurrency: int = 10,         # 最大并发 Agent 数
    ):
        self.llm_client      = llm_client
        self.memory_store    = memory_store
        self._semaphore      = asyncio.Semaphore(max_concurrency)
        self._detector       = DeadlockDetector()
        self._timeout_mgr    = AgentTimeoutManager()

    async def run_parallel(
        self,
        tasks: list[tuple[SubAgent, str, dict]],  # [(agent, task, context)]
    ) -> list[AgentResult]:
        """并行执行多个 Agent 任务，自动处理超时和死锁"""
        async def _run_one(agent: SubAgent, task: str, ctx: dict):
            async with self._semaphore:
                aid = await agent.spawn(task, ctx)
                return await self._timeout_mgr.run_with_timeout(
                    agent.collect(aid), aid
                )

        coroutines = [_run_one(a, t, c) for a, t, c in tasks]
        results    = await asyncio.gather(*coroutines, return_exceptions=True)

        # 将异常转换为 FAILED AgentResult
        return [
            r if isinstance(r, AgentResult)
            else AgentResult(
                agent_id    = f"unknown-{i}",
                status      = AgentStatus.FAILED,
                output      = None,
                error       = str(r),
                duration_ms = 0,
            )
            for i, r in enumerate(results)
        ]
```

### 通信架构

> **D-05 边界**：跨进程 / 跨机器 / 跨网络的 Agent 通信**全部归 [11-agent-mesh](../11-agent-mesh/README.md) 管辖**，本领域不再定义 `AgentMessage` / A2A / Agent Card 等数据结构。本领域只涉及：
> - **同进程内**的 Sub-Agent 编排（`spawn_subagent` / `await_result`），直接通过 Python/TS 函数调用 + asyncio task 完成，不进入消息总线。
> - 对外调用 mesh 时使用 11 暴露的 SDK（`MeshClient.send(msg)` / `MeshClient.subscribe(topic)`），数据结构、序列化、service discovery、A2A 协议、Agent Card 等都由 11-agent-mesh 权威定义。
>
> 这样避免 06 和 11 定义两套等价但不同步的消息类型（原稿中 `AgentMessage` 就是典型例子）。迁移节点见 ADR-001：mesh 能力在 **Iter D** 才启用；在此之前 06 只做同进程编排，不需要跨进程消息。

**Supervisor 跨 Agent 调用最小 API**（供本领域调用 11 的 thin wrapper）：

```python
from quilin.mesh import MeshClient   # 由 11-agent-mesh 提供

async def call_remote_agent(agent_id: str, payload: dict) -> dict:
    """本领域唯一的跨进程调用入口——序列化 / routing / timeout 全部委派给 11。"""
    client = MeshClient.default()
    return await client.request(agent_id, payload, timeout_s=30)
```

> 同进程 Sub-Agent spawn 不经过 MeshClient；只有当目标 Agent 不在当前进程（Iter F+ mesh runtime 场景）才走 mesh。

---

## 三、Top 10 参考项目

### 深入研究（前 5）

#### 1. AutoGen（Microsoft）⭐ ~50k

- **仓库**：[microsoft/autogen](https://github.com/microsoft/autogen)
- **核心机制**：`ConversableAgent` 两两对话循环；`GroupChat` 的 `speaker_selection` 机制（round_robin / auto / custom）
- **亮点**：支持 Human-in-the-loop，Agent 可以随时请求人类输入；代码执行沙箱内置
- **局限**：AutoGen 0.x 已进入维护模式，v0.4+ 重构为 AutoGen Core，API 不兼容
- **吸收要点**：对话终止条件设计（`is_termination_msg`）、GroupChat Speaker 选择算法

#### 2. CrewAI ⭐ ~48k

- **仓库**：[crewAIInc/crewAI](https://github.com/crewAIInc/crewAI)
- **核心机制**：`Agent(role, goal, backstory)` 三要素定义角色；`Task` 绑定 Agent；`Crew` 编排执行
- **亮点**：`delegation=True` 允许 Agent 将子任务委托给其他 Agent；内置 RAG 记忆
- **局限**：强依赖 LangChain 工具生态，定制化需要深入框架内部
- **吸收要点**：角色定义三要素模式、任务委托机制、`Process.hierarchical` 层级编排

#### 3. LangGraph ⭐ ~126k（含 LangChain 整体生态）

- **仓库**：[langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)
- **核心机制**：状态图（StateGraph）；`Command` 模式控制 Agent 间路由；`MessagesState` 共享消息历史
- **亮点**：原生支持多 Agent 作为图节点；Checkpoint 持久化支持长期任务；流式输出
- **局限**：学习曲线较高，图定义比较冗长
- **吸收要点**：`Command(goto=agent_id, update=state_delta)` 路由模式；Supervisor 作为图节点的实现方式

#### 4. OpenAI Agents SDK ⭐ ~19k

- **仓库**：[openai/openai-agents-python](https://github.com/openai/openai-agents-python)
- **核心机制**：`Agent(handoffs=[...])` 声明式转交；`Runner.run()` 执行循环；Swarm 模式
- **亮点**：Handoff 最简洁（只需在 Agent 定义中列出可转交的目标 Agent）；上下文自动传递
- **局限**：强绑定 OpenAI API，其他 LLM 需要适配
- **吸收要点**：Handoff 声明式设计；Swarm 的轻量级多 Agent 实现；`Runner` 的执行循环设计

#### 5. MetaGPT ⭐ ~44k

- **仓库**：[geekan/MetaGPT](https://github.com/geekan/MetaGPT)
- **核心机制**：SOP（Standard Operating Procedure）驱动；`Role/Action/Environment` 三层架构；文档驱动的中间产物传递
- **亮点**：将人类组织工作流程（产品经理→架构师→工程师→QA）映射为 Agent 协作；每个 `Action` 产生可追溯文档
- **局限**：预设 SOP 较固定，动态任务适应性不如 AutoGen/LangGraph
- **吸收要点**：SOP 工作流映射思想；`Environment` 作为共享消息板；Action 产出文档的中间传递模式

### 持续观察（后 5）

#### 6. Microsoft Magentic-One ⭐（含于 AutoGen ~50k）

- **仓库**：[microsoft/autogen/magentic-one](https://github.com/microsoft/autogen/tree/main/python/packages/autogen-magentic-one)
- **定位**：通用多 Agent 编排系统，含 WebSurfer / FileSurfer / Coder / ComputerTerminal 四种专门 Agent
- **关注点**：Orchestrator 如何动态选择下一个 Agent；任务进度跟踪机制

#### 7. Google A2A Protocol ⭐（协议规范）

- **仓库**：[google/a2a](https://github.com/google/a2a)
- **定位**：标准协议而非框架，定义 Agent Card / Task / Artifact 等概念
- **关注点**：协议规范本身；与 MCP 的互补关系；Harness 的 A2A 集成设计

#### 8. CAMEL ⭐ ~18k

- **仓库**：[camel-ai/camel](https://github.com/camel-ai/camel)
- **定位**：角色扮演通信框架，两个 Agent 通过角色扮演协作解决问题
- **关注点**：`RolePlaying` 会话的实现；Agent 间的思维链传递

#### 9. ChatDev ⭐ ~26k

- **仓库**：[OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev)
- **定位**：软件开发多 Agent，模拟软件公司组织（CEO/CTO/程序员/测试员）
- **关注点**：软件开发 SOP 的 Agent 映射；代码生成质量保证机制

#### 10. Agency Swarm ⭐ ~5k

- **仓库**：[VRSEN/agency-swarm](https://github.com/VRSEN/agency-swarm)
- **定位**：自定义 Agent 群，强调 Agency（机构）概念和工具共享
- **关注点**：Agent 间工具共享设计；`Agency` 通信拓扑定义

---

## 四、吸收内化方案

### AutoGen → ConversableAgent 对话循环

**吸收机制**：两 Agent 持续对话直到达成一致（`is_termination_msg`）

```python
# 在 Supervisor 中内化 AutoGen 的对话循环思想
class SupervisorDialogLoop:
    """
    Supervisor 与单个 Worker 进行多轮对话，直到任务完成。
    灵感来自 AutoGen ConversableAgent。
    """
    async def run_dialog(
        self,
        supervisor: SubAgent,
        worker:     SubAgent,
        task:       str,
        max_turns:  int = 10,
    ) -> AgentResult:
        context   = {"task": task, "history": []}
        last_msg  = task
        for turn in range(max_turns):
            # Worker 回应
            w_result = await worker.collect(
                await worker.spawn(last_msg, context)
            )
            context["history"].append({"role": "worker", "content": w_result.output})

            # 终止条件检查（类比 AutoGen is_termination_msg）
            if self._is_done(w_result.output):
                return w_result

            # Supervisor 评估并给出下一轮指令
            s_result = await supervisor.collect(
                await supervisor.spawn(
                    f"Worker 回复：{w_result.output}\n\n请评估是否完成，若未完成给出改进指令。",
                    context,
                )
            )
            last_msg = s_result.output or ""
            context["history"].append({"role": "supervisor", "content": last_msg})

        return w_result  # 达到最大轮次，返回最后结果
```

### CrewAI → 角色定义三要素

**吸收机制**：`role / goal / backstory` 三要素 + 任务委托 `delegation` 机制

```python
@dataclass
class AgentRole:
    """
    CrewAI 角色定义三要素，内化为 Harness 的 Agent 角色系统。
    """
    role:      str    # 角色名称，e.g. "高级代码审核员"
    goal:      str    # 角色目标，e.g. "发现安全漏洞和性能瓶颈"
    backstory: str    # 背景故事，e.g. "拥有 10 年安全审计经验，熟悉 OWASP Top 10"

    def to_system_prompt(self) -> str:
        return (
            f"你是一名{self.role}。\n"
            f"你的目标是：{self.goal}\n"
            f"背景：{self.backstory}\n"
            f"请基于以上身份和目标来完成任务。"
        )
```

### LangGraph → Command 路由 + 共享状态

**吸收机制**：`Command(goto, update)` 控制 Agent 间路由；`MessagesState` 共享消息历史

```python
from typing import Literal
from dataclasses import dataclass, field

@dataclass
class HarnessState:
    """
    内化 LangGraph MessagesState，作为多 Agent 共享状态。
    所有 Agent 读写同一个状态实例（通过 StateManager 保护并发安全）。
    """
    task:         str         = ""
    messages:     list[dict]  = field(default_factory=list)
    current_agent: str        = "supervisor"
    results:      dict        = field(default_factory=dict)
    is_done:      bool        = False

@dataclass
class Command:
    """
    内化 LangGraph Command 模式，控制 Supervisor 的路由决策。
    """
    goto:   str          # 下一个要执行的 Agent id，"__end__" 表示结束
    update: dict         # 要更新的状态字段

    @classmethod
    def end(cls, final_output: str) -> "Command":
        return cls(goto="__end__", update={"is_done": True, "final_output": final_output})
```

### OpenAI Agents SDK → Handoff 声明式设计

**吸收机制**：Agent 只需声明 `handoffs` 列表，上下文自动传递

```python
@dataclass
class AgentConfig:
    """
    内化 OpenAI Agents SDK 的 Handoff 声明式设计。
    Agent 在配置时声明可转交的目标 Agent，运行时自动路由。
    """
    agent_id:     str
    role:         AgentRole
    handoffs:     list[str]      # 可转交的目标 agent_id 列表
    tools:        list[str]      # 可使用的工具名列表
    model:        str = "claude-sonnet-4-6"

    def can_handoff_to(self, agent_id: str) -> bool:
        return agent_id in self.handoffs
```

### MetaGPT → SOP 工作流映射

**吸收机制**：将标准作业流程映射为 Agent 协作拓扑；每个阶段输出文档作为下一阶段输入

```python
@dataclass
class SOPStep:
    """MetaGPT SOP 步骤，每步对应一个专家 Agent"""
    step_id:       str
    agent_role:    AgentRole
    input_keys:    list[str]     # 需要从共享状态读取的字段
    output_key:    str           # 产出写入共享状态的键名
    prompt_template: str         # 该步骤的任务提示模板

class SOPWorkflow:
    """
    SOP 驱动的多 Agent 工作流，灵感来自 MetaGPT。
    适合有固定流程的任务（如：需求→设计→编码→测试→文档）。
    """
    def __init__(self, steps: list[SOPStep]):
        self.steps = steps

    async def run(self, initial_input: dict) -> dict:
        state = dict(initial_input)
        for step in self.steps:
            inputs  = {k: state[k] for k in step.input_keys if k in state}
            task    = step.prompt_template.format(**inputs)
            # 每步产出文档，传递给下一步
            result  = await self._run_step(step, task)
            state[step.output_key] = result
        return state
```

---

## 五、与 Harness 组件映射

### 组件文件路径

| 组件 | 文件路径 | 职责 |
|------|---------|------|
| **Supervisor** | `quilin/orchestration/supervisor.py` | 任务分解 + 分配 + 结果聚合 |
| **Agent 抽象** | `quilin/core/agent.py` | `SubAgent` Protocol + `AgentRole` + `AgentConfig` |
| **AgentPool** | `quilin/orchestration/pool.py` | Agent 实例管理 + 负载均衡 + 能力索引 |
| **ParallelExecutor** | `quilin/orchestration/executor.py` | asyncio 并行 + 超时 + 死锁检测 |
| **Aggregator** | `quilin/orchestration/aggregator.py` | 四种聚合策略实现 |
| **A2AClient** | `quilin/orchestration/a2a.py` | A2A 协议客户端 + Agent Card 发布 |
| **MCPBus** | `quilin/core/mcp_bus.py` | 三级通信统一消息总线 |
| **DeadlockDetector** | `quilin/orchestration/deadlock.py` | 等待图 + 循环检测 |
| **StateManager** | `quilin/orchestration/state.py` | `HarnessState` 并发安全读写 |
| **ProgressAggregator** | `quilin/orchestration/progress.py` | Sub-Agent 进度聚合 + WebUI/IM 推送 |

### 能力实现状态

> **状态校准（2026-04-30）**：本表保留 2026-04-18 目标拆解。当前只有 Planning 层 delegation policy 已落地；其余 runtime 能力仍以顶部状态块为准。

| 能力 | 当前状态 | 待实现 | 吸收来源 |
|------|---------|--------|---------|
| 多 Agent 编排 | 单 Agent 循环 | `supervisor.py` Orchestration Provider | LangGraph / CrewAI |
| SubAgent spawn | 未实现 | `agent.py` + `LifecycleManager` | AutoGen / OpenAI SDK |
| 并行执行 | 未实现 | `executor.py` asyncio.gather | LangGraph |
| 结果聚合 | 未实现 | `aggregator.py` 四种策略 | AutoGen 辩论模式 |
| 死锁检测 | 未实现 | `deadlock.py` 等待图 DFS | 分布式系统经典算法 |
| 对话循环 | 未实现 | `supervisor.py` DialogLoop | AutoGen ConversableAgent |
| 角色定义 | 未实现 | `agent.py` AgentRole | CrewAI role/goal/backstory |
| SOP 工作流 | 未实现 | `orchestration/sop.py` | MetaGPT SOP |
| Handoff 路由 | 未实现 | `orchestration/router.py` | OpenAI Agents SDK |
| 本机通信 | 未实现 | `mcp_bus.py` + Unix Socket | — |
| 内网通信 | 未实现 | `mcp_bus.py` + gRPC | — |
| 网络通信 | 未实现 | `mcp_bus.py` + HTTPS/WebSocket | — |
| A2A 协议 | 未实现 | `a2a.py` Agent Card + 消息路由 | Google A2A |
| 非阻塞 Supervisor | 未实现 | Supervisor 默认架构 + 任务分发策略 | Quilin 原创 |
| 进度汇报协议 | 未实现 | `progress.py` Checkpoint + Heartbeat + IM 推送 | Quilin 原创 |

### 核心接口完整伪代码

```python
# quilin/orchestration/supervisor.py

class Supervisor:
    """
    Harness 多 Agent Supervisor，整合所有设计方案。
    """

    def __init__(
        self,
        pool:       "AgentPool",
        executor:   "ParallelExecutor",
        aggregator: "Aggregator",
        state_mgr:  "StateManager",
        detector:   "DeadlockDetector",
    ):
        self.pool       = pool
        self.executor   = executor
        self.aggregator = aggregator
        self.state      = state_mgr
        self.detector   = detector

    async def run(self, task: str) -> str:
        """主入口：接收复杂任务，协调所有 Worker，返回最终结果"""
        # 1. 任务分解
        subtasks = await self._decompose(task)

        # 2. 为每个子任务选择合适的 Worker
        assignments = [
            (self.pool.select(subtask), subtask, {"parent_task": task})
            for subtask in subtasks
        ]

        # 3. 注册等待关系（死锁检测）
        for agent, _, _ in assignments:
            self.detector.add_wait("supervisor", agent.agent_id)

        # 4. 并行执行
        results = await self.executor.run_parallel(assignments)

        # 5. 清理等待关系
        for agent, _, _ in assignments:
            self.detector.remove_wait("supervisor", agent.agent_id)

        # 6. 结果聚合
        return await self.aggregator.aggregate(
            results,
            strategy=AggregationStrategy.LLM,
        )

    async def _decompose(self, task: str) -> list[str]:
        """使用 LLM 将复杂任务分解为子任务列表"""
        ...
```

---

## 六、验证标准

### 功能验证

| 验证项 | 指标 | 验证方法 |
|--------|------|---------|
| Supervisor-Worker 编排 | 成功分配并收集 ≥ 3 个并行 Worker 结果 | 集成测试：并行数学计算任务 |
| SubAgent spawn/collect | spawn 到 collect 延迟 < Agent timeout | 单元测试：mock Worker |
| 结果聚合-投票 | 3/5 多数结果正确率 > 90% | 单元测试：已知答案数据集 |
| 结果聚合-LLM | LLM 综合质量人工评分 ≥ 4/5 | 人工评估：10 个复杂问题 |
| 死锁检测 | 人为构造 A→B→C→A 循环，必须在 5s 内检测 | 单元测试：构造等待图 |
| 超时处理 | Agent 超时后整体任务仍能返回降级结果 | 集成测试：注入慢 Agent |
| 对话循环终止 | 达到 `is_done` 条件后不超过 1 轮多余对话 | 单元测试：mock termination |
| A2A Agent Card 发布 | 外部 HTTP GET 能正确获取 Agent Card JSON | 端到端测试 |

### 性能验证

| 指标 | 目标 | 测量方法 |
|------|------|---------|
| 10 个并行 Worker 吞吐 | 总时间 ≤ 最慢单 Worker × 1.2 | 压测：10 个等时长 mock Worker |
| Supervisor 分解延迟 | < 3s（含 LLM 推理） | 基准测试：100 次采样 p95 |
| MCPBus 本机消息延迟 | < 5ms（p99） | 微基准：1000 次本机消息 |
| 内存：100 Agent 并发 | RSS 增量 < 500MB | 内存压测：asyncio 并发上限 |

### 可靠性验证

| 场景 | 预期行为 |
|------|---------|
| 单个 Worker 崩溃 | 其他 Worker 继续；聚合层使用降级结果 |
| 网络分区（Level 3）| 自动降级到缓存；超时后返回错误（不挂起）|
| LLM API 限流 | 指数退避重试；超过 3 次后 Worker 标记 FAILED |
| 递归 spawn 深度超限 | 第 5 层 spawn 直接返回 FAILED，不再递归 |
| 消息重复投递 | 基于 `msg_id` 幂等去重，不重复执行 |

### 代码质量验证

- [ ] `SubAgent` Protocol 所有方法均有类型注解
- [ ] 单元测试覆盖率 ≥ 80%（`quilin/orchestration/` 目录）
- [ ] 死锁检测有专项测试（循环/非循环各 5 个用例）
- [ ] 所有 Agent 通信通过 `MCPBus`，禁止直接调用其他 Agent 的内部方法
- [ ] `AgentResult` 不可变（dataclass frozen=True），聚合层创建新对象
