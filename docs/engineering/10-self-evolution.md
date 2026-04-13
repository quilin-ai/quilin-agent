# 自进化工程（Self-Evolution Engineering）

> 本文档是 Quilin Agent 工程规格系列的第 10 篇，也是最具野心的一篇。自进化是让 Agent 能够从失败中学习、自动改进自身 scaffold（提示词/工具配置/工作流）的能力——这是我们区别于绝大多数竞品的核心竞争力。核心设计受 MiniMax M2.7 的自进化闭环启发，系统化地融合了 DSPy、Voyager、ADAS 等最前沿的自动优化研究成果。

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

### 2.4 Scaffold 自修改（核心创新）

这是自进化中最具创新性、也最需要谨慎设计的部分。自修改按风险等级分为 4 层，从低风险到高风险递进。

**修改层级矩阵：**

```
Level 1（低风险）：系统提示调整
┌─────────────────────────────────────────────────────┐
│ 修改内容：增/删规则、调整示例、补充约束              │
│ 审批要求：无需人工确认，自动应用                     │
│ 回滚复杂度：即时（1 秒内）                          │
│ 影响范围：全局行为偏好                              │
└─────────────────────────────────────────────────────┘

Level 2（中风险）：工具配置修改
┌─────────────────────────────────────────────────────┐
│ 修改内容：添加/禁用工具、调整工具优先级、修改参数    │
│ 审批要求：无需人工确认，沙箱验证后自动应用           │
│ 回滚复杂度：即时（切换配置文件）                    │
│ 影响范围：可用工具集合                              │
└─────────────────────────────────────────────────────┘

Level 3（高风险）：推理策略切换
┌─────────────────────────────────────────────────────┐
│ 修改内容：ReAct→PlanAndExecute、调整 ThinkingMode   │
│ 审批要求：需人类确认（发送审批请求，24h 内响应）     │
│ 回滚复杂度：即时（策略枚举切换）                    │
│ 影响范围：所有任务的推理过程                        │
└─────────────────────────────────────────────────────┘

Level 4（极高风险）：工作流重构
┌─────────────────────────────────────────────────────┐
│ 修改内容：修改状态机节点顺序、添加新节点、删除节点  │
│ 审批要求：必须人类确认 + 完整 A/B 测试报告          │
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
      │       "confidence": 0.87
      │     }
      │
      ├── Level 1-2：直接提交沙箱验证
      └── Level 3-4：发送人类审批请求 → 等待确认 → 沙箱验证
```

**Scaffold 版本控制：**
每次修改都会生成新的版本号，格式 `scaffold-v{major}.{minor}.{patch}`：
- patch：Level 1 修改（自动）
- minor：Level 2 修改（自动）
- major：Level 3-4 修改（需人工）

### 2.5 技能自创系统（Voyager 启发）

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
        └── 4. 生成技能模板（存储到 Skill Memory）
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
│  Layer 2：修改频率限制                                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ • Level 1-2 修改：最多 1 次/小时                     │  │
│  │ • Level 3 修改：最多 1 次/天，需人类确认             │  │
│  │ • Level 4 修改：最多 1 次/周，需人类确认             │  │
│  │ • 连续 3 次修改均未改善 → 暂停自进化 48 小时        │  │
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

**人类审批流程（Level 3-4）：**

```
自进化引擎生成修改方案
        │
        ▼
发送审批请求（含：修改内容、理由、预期收益、风险评估）
        │
        ├── 24 小时内无响应 → 取消本次修改，记录待审批队列
        │
        ├── 人类拒绝 → 记录拒绝原因 → 送回失败分析器参考
        │
        └── 人类批准 → 进入沙箱验证 → A/B 评估 → 上线
```

### 2.8 上游监控自动缝合

自进化不只针对 Agent 自身行为，也包括对 90 个上游项目更新的智能吸收。

**缝合流程：**

```
sync-upstreams.py 检测到上游 commit
        │
        ▼
git diff 提取变更内容
        │
        ▼
Claude 分析 diff：
  ① 这个更新涉及哪个功能点？
  ② 我们是否已经吸收了这个功能的旧版本？
  ③ 这个更新是否比我们的实现更好？
  ④ 如何将这个更新融合到 Harness 中？
        │
        ├── 不相关 → 记录到 fusion-index.md（观察状态）
        │
        └── 相关 → 生成融合补丁建议
                    │
                    ▼
              merge-with-claude.sh 生成 PR
                    │
                    ▼
              人类审核 → 合并 → 更新 fusion-index.md
```

**相关性判断逻辑（Claude prompt 关键部分）：**

```
判断标准：
1. 功能相关性：这个 diff 修改的功能是否在我们的吸收计划中？
   参考 fusion-index.md 中的"吸收中"或"规划中"条目
2. 质量提升：新版本是否解决了我们已知的问题？
3. 破坏性：这个更新是否会破坏我们现有的集成？
4. 工作量：吸收这个更新大约需要多少工作量？

输出格式：
{
  "relevance": "high|medium|low|none",
  "affected_components": ["组件列表"],
  "integration_suggestion": "具体建议",
  "estimated_effort": "small|medium|large"
}
```

### 2.9 核心接口定义

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

OmniMem（记忆层）← Skill Memory（Layer 4）
    └── SkillManager 直接写入 Skill Memory 层
    └── SkillManager 读取 Skill Memory 获取复用技能

Verifier（验证层）
    └── ABEvaluator 借用 Verifier 的沙箱执行能力运行评估任务

LLMRouter（LLM 层）
    └── FailureAnalyzer 使用"强模型"（默认 claude-opus-4-5）进行失败分析
    └── ScaffoldModifier 使用"中等模型"生成修改方案

sync-upstreams.py（脚本层）
    └── 触发上游监控自动缝合流程
    └── 读取 fusion-index.md 确定监控目标
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
    │                        └──→ 写入 Skill Memory
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
    relevance_threshold: "medium"  # 最低相关性阈值才触发缝合
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

> **与上游监控的关联**：本文档对应 `fusion-index.md` 中的 Section 10（自进化）。上游项目的监控优先级：DSPy 的 optimizer 更新（高优先级）> Voyager 的 skill_library 更新（中优先级）> SWE-agent 的 ACI 更新（中优先级）> ADAS 的 meta_agent 更新（中优先级）。
>
> **实施阶段**：自进化工程对应 `implementation-plan.md` 的 Phase 8+，在前 7 个 Phase（LLM 接入 → 可观测性 → 部署运行时）完成后实施。TrajectoryStore 可在 Phase 3 提前埋点，为 Phase 8 的自进化积累初始数据。
