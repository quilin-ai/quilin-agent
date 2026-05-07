# 上下文工程（Context Engineering）

> **实现状态（2026-04-30 校准）**
> - ✅ **已实现**：`packages/agent-core/src/context/` — PromptBuilder / PromptSessionAssembler、ContextManager、TokenBudgetAllocator、cache stability metadata、TemporalAwareness、MemoryBridge、InjectionScanner、skills catalog / hot_skills / post-compact skills restore 接线。
> - 🚧 **部分实现 / 延期**：完整相关性选择、token-aware compressor、runtime delta channel 仍未作为独立模块落地；reasoning sanitizer 已独立落地。
> - Linear 后续项：[QUI-15](https://linear.app/quilin-agent/issue/QUI-15/02-context-relevance-selection-compression-and-runtime-delta-channel)（相关性选择/压缩）、[QUI-90](https://linear.app/quilin-agent/issue/QUI-90/m2-接入-context-budget-到-repl-使-token-预算可视化且可联动)（context budget REPL 可视化）；Conversation Engineering parked scope 见 [QUI-13](https://linear.app/quilin-agent/issue/QUI-13/iter-f-unpark-conversation-engineering-after-core-loop-stability)。

> **ADR-001 对齐说明**：核心语言已决策为 TypeScript（见 [Core Loop](../00-core-loop/README.md)）。本文档中的 Python 代码示例仅表达设计意图，实施时将以 TS 重写。`quilin/` 路径为规划参考，最终目录结构以实施时为准。
>
> **2026-04-18 D-05 集成**：对话工程（原独立领域 12-）降级为本领域子模块 [`conversation-engineering/`](./conversation-engineering/README.md)，parked 至 Iter F。ContextAssembler 统一 own 所有 prompt 组装，对话工程只贡献 6 层"活人感"配方。

Quilin Agent 的核心本质是一个**上下文工程自动化流水线**，11 大能力领域各自负责上下文生命周期的一个环节。

---

## 一、问题定义

### 1.1 什么是上下文工程

上下文工程（Context Engineering）是指在 Agent 系统中，对送入 LLM 的 token 序列进行**系统性的设计、组装、压缩与管理**的工程学科。区别于单次 Prompt 的人工调优，上下文工程处理的是：

- 动态变化的多源信息（历史记忆、用户输入、工具结果、感知内容）
- 有限的上下文窗口（128K～2M tokens）下的预算分配
- 多轮 Agent 循环中的信息生命周期管理

**核心矛盾**：Agent 掌握的信息量永远大于 LLM 窗口能放下的量，且 LLM 对上下文不同位置的注意力分布极不均匀（Lost in the Middle 问题）。

### 1.2 9 层与上下文的关系

```
用户输入
  │
  ▼
[Guard]        ← 输入安检：过滤注入/有害内容（控制什么能进入上下文）
  │
  ▼
[Memory]       ← 召回相关记忆（往上下文里塞历史经验）
[Perception]   ← 理解图片/文档/语音（把多模态转成文本上下文）
  │
  ▼
[Context = Memory + Perception + Tools描述 + 系统提示]
  │
  ▼
[Planning]     ← LLM 基于上下文做推理规划
[LLM Brain]    ← 实际推理引擎
  │
  ▼
[Tools]        ← 执行动作，结果回填上下文
[Orchestration]← 多步/多 Agent 编排
  │
  ▼
[Guard]        ← 输出安检：校验结果是否安全合规
[Obs]          ← 记录这轮都发生了什么（不影响上下文，但让你看得见）
  │
  ▼
输出
```

- **Guard（安全护栏层）**：控制上下文的边界——什么能进、什么能出
- **Obs（可观测层）**：不直接参与上下文，但让你看懂和优化上下文的构造过程

### 1.3 核心挑战清单

| 挑战 | 描述 | 影响层 |
|------|------|--------|
| 窗口溢出 | 信息量超出模型最大 token 限制 | 全部层 |
| Lost in the Middle | LLM 对中间位置信息注意力低 | Planning/LLM Brain |
| 上下文污染 | 不相关信息干扰推理质量 | Memory/Selection |
| 重复计算 | 不变的系统提示反复编码 | 成本/延迟 |
| 多源信息融合 | Memory + Perception + Tool 结果格式不统一 | ContextManager |
| 时序不一致 | 不同来源的信息时间戳混乱 | Timing |
| Token 成本 | 每次调用都传完整历史导致费用爆炸 | Budgeting/Caching |
| **任务中断** | **执行到一半 token 耗尽，前面的消耗全浪费，用户需手动恢复** | **Estimation/Planning** |

> **关键需求：任务前 Token 预估**
>
> 执行到一半因 token 不足而中断是体验最差的场景之一。Quilin 必须在任务开始前预估消耗，并在余量不足时主动建议拆分：
>
> | 余量状态 | 行为 |
> |---------|------|
> | 充足（预估 < 70% 余量） | 正常执行 |
> | 紧张（预估 70%-100% 余量） | 提醒用户预计消耗量和剩余量，让用户决定是否继续 |
> | 不足（预估 > 余量） | 主动给出任务拆分方案，每个子任务附带预估消耗 |
>
> 预估依据：任务类型、涉及文件大小、预期工具调用轮数、历史同类任务的实际消耗。预估算法需在本模块（Context/Budget）实现，拆分建议需联动 04-Planning（任务分解）。

---

## 二、设计方案

### 2.1 上下文管理的 7 项职责

```
上下文管理
├── 1. 收集（Gathering）    — 从哪里拿信息
├── 2. 筛选（Selection）    — 哪些该放进来
├── 3. 压缩（Compression）  — 太长了怎么缩
├── 4. 排布（Arrangement）  — 放在什么位置
├── 5. 预算（Budgeting）    — 每部分分多少 token
├── 6. 时序（Timing）       — 什么时候更新上下文
└── 7. 缓存（Caching）      — 不变的部分别重复计算
```

#### 1. 收集（Gathering）

上下文原料来源：
- Memory 召回的历史经验
- Perception 解析的图片/文档内容
- Tool 返回的 API 结果
- 用户当前输入
- 系统提示 / 人设 / 规则
- 其他 Agent 的中间结果（多 Agent 场景）

#### 2. 筛选（Selection）

拿到信息后判断**跟当前任务的相关性**：
- 向量相似度、关键词匹配、LLM rerank
- **该丢的信息比该留的重要** — 噪音会严重干扰推理质量

#### 3. 压缩（Compression）

上下文压缩主要由 Memory 层的分层架构实现——**记忆层级本身就是一个渐进压缩管道**：

```
[短时记忆] 100 条对话消息，token 快爆了
     │
     ▼  Memory 层压缩
[中时记忆] Hindsight Reflect：把 100 条总结成 5 条关键点
     │
     ▼  Memory 层压缩
[长时记忆] quilin-mem：提炼成 KG 三元组/向量索引
     │
     ▼  Memory 层压缩
[超长时记忆] gbrain：只留最核心的经验和模式
```

除 Memory 层外，其他压缩点：

| 压缩位置 | 做什么 | 对应层 |
|----------|--------|--------|
| Memory Reflect | 多轮对话 → 摘要 | Memory |
| Context Build | 只召回 top-K 相关记忆，不是全塞 | ContextManager |
| Perception | 一张 10MB 的图 → 一段 200 token 的描述 | Perception |
| Tool 结果裁剪 | API 返回 5000 行 JSON → 只取关键字段 | Tools |
| Planning | 上一轮完整 trace → 压缩成 "已完成步骤 1-3" | Planning |

#### 4. 排布（Arrangement）

LLM 对上下文不同位置的注意力不同（Lost in the Middle 问题）：

```
[系统提示]          ← 注意力高
[背景知识/记忆]      ← 注意力低（中间地带）
[工具描述]          ← 注意力低
[对话历史]          ← 注意力低
[最近几轮对话]       ← 注意力高
[当前用户输入]       ← 注意力最高
```

**最重要的信息要放开头和结尾**，中间放可以丢失一些也不影响的内容。

#### 5. 预算（Budgeting）

```
模型窗口 128K tokens
├── 系统提示:     ~2K   (固定)
├── 记忆:        ~10K   (动态，按相关性装填)
├── 工具 schema:  ~5K   (当前可用工具)
├── 对话历史:     ~80K  (最近的完整保留，远的压缩)
├── 当前输入:     ~1K
└── 预留输出:     ~30K  (留给模型生成)
```

预算不是固定的——简单问题给记忆少一点、工具多一点；复杂推理反过来。

#### 6. 时序（Timing）

- **每轮都变的**：用户输入、对话历史、工具结果
- **偶尔变的**：记忆召回（新任务时重新检索）
- **很少变的**：系统提示、工具 schema
- **触发式更新**：Agent 发现信息不够 → 主动再召回一次

#### 6.1 时间感知能力（Temporal Awareness）

当前绝大多数 Agent 把 session 当成无时间的文本流——消息之间的"沉默"被完全忽略。但沉默本身就是信息：用户走了、用户在忙、用户睡了、用户完成了线下任务回来了。Quilin 必须理解时间。

**三层时间感知**：

| 层级 | 触发条件 | Agent 行为 | 实现位置 |
|------|---------|-----------|---------|
| **会话内间隔感知** | 同 session 两条消息间隔 > 阈值 | 结合上下文中的"未完成动作"主动询问进展，而非继续催促用户去做可能已完成的事 | ContextManager.build_context() |
| **绝对时间感知** | 当前时间处于深夜/凌晨/节假日，或用户连续工作 > 4h | 关怀提醒（"已经很晚了"、"连续工作 4 小时了"） | System prompt 注入 |
| **跨 session 时间线** | 新 session 开始，距上次 session 已过 > 阈值 | 主动衔接上次未完成话题（"距上次聊已过 3 天，X 方案落地了吗？"） | 03-Memory 离开上下文 + ContextManager |

**间隔阈值与响应策略**：

| 间隔时长 | 分类 | 响应策略 |
|---------|------|---------|
| < 5 分钟 | 正常对话 | 无特殊处理 |
| 5-30 分钟 | 短暂离开 | 轻量衔接："接着刚才的..." |
| 30 分钟 - 4 小时 | 中度离开 | 主动询问："你回来了，之前聊到 X..." |
| 4-24 小时 | 长时间离开 | 总结上次 + 询问进展："过了半天了，你之前说要处理的 Y 搞定了吗？" |
| > 24 小时 | 跨天 | 完整衔接："距上次已过 N 天。上次我们聊到..." + 检查未完成动作清单 |

**ContextManager 时间注入实现**：

在 `build_context()` 的 system prompt 组装阶段，注入以下时间上下文：

```
[时间上下文]
当前时间: 2026-04-15 02:37 (UTC+8, 凌晨)
距上条消息: 6 小时 22 分钟
用户本次 session 持续: 4 小时 15 分钟
上次 session 未完成动作:
  - "去线下和团队对齐 API 设计方案"（用户主动提出，未报告结果）
  - "review PR #42"（Agent 建议，未确认执行）
```

**ContextSource 扩展**：

每条 ContextSource 增加 `gap_since_last` 字段：

```python
@dataclass
class ContextSource:
    source_type: str
    content: str
    token_count: int
    relevance_score: float
    timestamp: float
    metadata: dict
    gap_since_last: float | None = None  # 距上条消息的秒数，None 表示首条
```

**与 03-Memory 联动**：

时间感知依赖 03-Memory 的 **Departure Context**（离开上下文）功能：
- 每次检测到用户长时间未响应（> 30 分钟），quilin-mem 自动记录当前上下文状态
- 记录内容：最后讨论话题、未完成的用户承诺/动作、Agent 待确认事项
- 新消息到达时，ContextManager 优先检索 Departure Context 并注入 system prompt

#### 7. 缓存（Caching）

系统提示 + 工具 schema 每次调用都一样，利用 Prompt Caching（Anthropic / OpenAI 都支持）：
- 缓存命中 → 费用降低 90%，首 token 延迟更低
- 关键是把不变的部分放在 prompt 前面，变化的放后面

### 2.2 核心接口定义（Protocol 伪代码）

```python
from typing import Protocol, runtime_checkable
from dataclasses import dataclass

# ──────────────────────────────────────────────
# 数据结构
# ──────────────────────────────────────────────

@dataclass
class ContextSource:
    """单条上下文原料"""
    source_type: str        # "memory" | "perception" | "tool" | "user" | "system"
    content: str
    token_count: int
    relevance_score: float  # 0.0 ~ 1.0，用于筛选排序
    timestamp: float
    metadata: dict

@dataclass
class AssembledContext:
    """组装完成的上下文，送入 LLM"""
    system_prompt: str
    messages: list[dict]    # OpenAI 消息格式
    total_tokens: int
    budget_breakdown: dict  # 各部分 token 占用
    cache_prefix_end: int   # 可缓存前缀的结束位置

@dataclass
class BudgetPolicy:
    """Token 预算策略"""
    task_type: str          # "simple_qa" | "deep_reasoning" | "tool_use" | "multi_agent"
    total_budget: int
    system_ratio: float     # 系统提示占比
    memory_ratio: float     # 记忆占比
    tools_ratio: float      # 工具描述占比
    history_ratio: float    # 对话历史占比
    output_reserve: int     # 为输出预留的 token

# ──────────────────────────────────────────────
# 核心 Protocol 接口
# ──────────────────────────────────────────────

@runtime_checkable
class ContextManager(Protocol):
    """上下文管理器——负责完整的上下文工程流水线"""

    def gather(self, query: str, state: dict) -> list[ContextSource]:
        """1. 收集：从各层拉取上下文原料"""
        ...

    def select(
        self,
        sources: list[ContextSource],
        budget: BudgetPolicy,
    ) -> list[ContextSource]:
        """2. 筛选：按相关性排序 + rerank，去掉噪音"""
        ...

    def compress(
        self,
        sources: list[ContextSource],
        target_tokens: int,
    ) -> list[ContextSource]:
        """3. 压缩：超限时对各来源进行摘要/裁剪"""
        ...

    def build_context(
        self,
        sources: list[ContextSource],
        policy: BudgetPolicy,
    ) -> AssembledContext:
        """4+5. 排布 + 预算：按位置策略组装，分配 token 预算"""
        ...

    def get_cache_prefix(self, context: AssembledContext) -> str:
        """7. 缓存：返回可被 prompt cache 的不变前缀"""
        ...


@runtime_checkable
class SystemPromptBuilder(Protocol):
    """系统提示构建器——动态组装 system prompt 各个模块
    
    注意：此接口为早期简化设计，正式实现方案见 2.5 节的分段式
    SystemPromptBuilder（register/build 模式）。保留此处作为概念参考。
    """

    def build(
        self,
        role_persona: str,          # 角色定义（如 "你是一个专业的代码审查助手"）
        tool_descriptions: list[str],  # 当前可用工具的描述列表
        memory_summary: str,        # 长时记忆的摘要（gbrain / quilin-mem 提取）
        constraint_rules: list[str],   # 安全约束 / 输出格式规则
        extra_context: str = "",    # 其他动态注入内容
    ) -> str:
        """返回组装好的完整 system prompt 字符串"""
        ...

    def estimate_tokens(self, prompt: str) -> int:
        """估算 prompt token 数，用于预算规划"""
        ...


@runtime_checkable
class TokenBudgetAllocator(Protocol):
    """Token 预算分配器——根据任务类型动态分配各部分预算"""

    TASK_PROFILES: dict[str, BudgetPolicy]
    # 示例预置策略：
    # "simple_qa":    system=5%, memory=10%, tools=5%,  history=50%, output=30%
    # "deep_reasoning": system=3%, memory=20%, tools=5%, history=42%, output=30%
    # "tool_use":     system=5%, memory=10%, tools=20%, history=40%, output=25%
    # "multi_agent":  system=8%, memory=15%, tools=15%, history=37%, output=25%

    def allocate(
        self,
        task_type: str,
        total_window: int,
        overrides: dict | None = None,
    ) -> BudgetPolicy:
        """返回该任务类型的预算策略，支持局部覆盖"""
        ...

    def rebalance(
        self,
        policy: BudgetPolicy,
        actual_usage: dict[str, int],
    ) -> BudgetPolicy:
        """根据实际使用情况动态再平衡（某部分未用完则将预算让给其他部分）"""
        ...
```

### 2.3 上下文组装流水线数据流图

```
                     ┌─────────────────────────────────────────┐
                     │           上下文组装流水线                  │
                     └─────────────────────────────────────────┘

  用户输入 ──────────────────────────────────────────────┐
  (query)                                              │
                                                       ▼
  ┌──────────┐   raw     ┌──────────┐  scored  ┌──────────────┐
  │  Memory  │──sources──►          │          │              │
  │  Layer   │           │  gather  │──────────►   select     │
  │          │           │          │  rerank   │  (filter +  │
  ├──────────┤           │          │           │  relevance) │
  │Perception│──sources──►          │           │              │
  │  Layer   │           └──────────┘           └──────┬───────┘
  │          │                                         │
  ├──────────┤                                         │ filtered sources
  │  Tools   │──schemas──►  SystemPromptBuilder        │
  │  Layer   │             (role+tools+memory+rules)   │
  └──────────┘                    │                    │
                                  │ system_prompt      ▼
                            ┌─────▼──────────────────────────┐
                            │         compress               │
                            │   (摘要/裁剪，token 感知)        │
                            └─────────────────┬──────────────┘
                                              │
                                    ┌─────────▼──────────┐
                                    │  TokenBudgetAllocator│
                                    │  (按任务类型分配预算)   │
                                    └─────────┬────────────┘
                                              │ BudgetPolicy
                                    ┌─────────▼────────────┐
                                    │    build_context      │
                                    │  (排布 + 组装消息列表)  │
                                    │                       │
                                    │ [SYSTEM]              │
                                    │ [MEMORY/BG]  ← 中间   │
                                    │ [TOOLS]      ← 中间   │
                                    │ [HISTORY]    ← 中间   │
                                    │ [RECENT]     ← 高注意 │
                                    │ [USER INPUT] ← 最高   │
                                    └─────────┬────────────┘
                                              │ AssembledContext
                                    ┌─────────▼────────────┐
                                    │   prompt cache check  │
                                    │ (不变前缀标记缓存边界)  │
                                    └─────────┬────────────┘
                                              │
                                    ┌─────────▼────────────┐
                                    │      LLM Brain        │
                                    │   (实际推理调用)        │
                                    └──────────────────────┘
```

### 2.4 配置项设计

```yaml
# quilin/config.yaml 上下文工程相关配置
context:
  # 预算策略
  budget:
    default_task_type: "deep_reasoning"
    model_window_tokens: 131072       # 128K
    output_reserve_tokens: 30000
    task_profiles:
      simple_qa:
        memory_ratio: 0.10
        tools_ratio: 0.05
        history_ratio: 0.55
      deep_reasoning:
        memory_ratio: 0.20
        tools_ratio: 0.05
        history_ratio: 0.42
      tool_use:
        memory_ratio: 0.10
        tools_ratio: 0.20
        history_ratio: 0.40
      multi_agent:
        memory_ratio: 0.15
        tools_ratio: 0.15
        history_ratio: 0.37

  # 筛选策略
  selection:
    top_k_memories: 20
    relevance_threshold: 0.65         # 低于此分数的记忆不放入上下文
    rerank_enabled: true
    rerank_model: "cross-encoder"

  # 压缩策略
  compression:
    enabled: true
    strategy: "hierarchical"          # "truncate" | "summarize" | "hierarchical"
    summarize_threshold: 0.85         # 窗口使用率超此值时触发压缩

  # 缓存策略
  caching:
    prompt_cache_enabled: true
    cache_system_prompt: true
    cache_tool_schemas: true
    min_cacheable_tokens: 1024        # 低于此 token 数不缓存
```

### 2.5 提示词工程（Prompt Engineering）——上下文工程的子集

> **核心观点**：提示词工程是上下文工程的一个特化维度。上下文工程管理送入 LLM 的全部 token 序列（记忆、工具结果、对话历史、系统提示……），提示词工程专注其中"系统提示"这一块的设计、组装、优化与防护。二者不是并列关系，而是包含关系。

Agent 发展到今天，单靠手写一段 system prompt 已远远不够。Claude Code、Codex、OpenClaw、Hermes 四大主流 Agent 的源码显示：系统提示本身已经变成一个**工程系统**——有模块化组装、有缓存分层、有安全扫描、有模型适配。以下 7 个设计模式从它们的实践中提炼而来，每个模式对应前述 7 项上下文职责中的一项或多项。

#### 模式 1：静态/动态缓存边界（对应职责 7-缓存）

**问题**：系统提示每次 LLM 调用都完整发送。一个 5000 token 的 system prompt，100 次调用就是 50 万 token 的输入成本，其中 90% 的内容（身份、规则、工具描述）根本没变过。

**业界实践**：

| Agent | 实现 | 源码位置 |
|-------|------|---------|
| **Claude Code** | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'`，将 prompt 数组拆成静态前缀和动态后缀两段。静态段（身份、规则、工具）被 Anthropic prompt cache 命中，动态段（env、memory、MCP）每轮重算 | `src/constants/prompts.ts:114-115` |
| **OpenClaw** | `SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n"`，`splitSystemPromptCacheBoundary()` 将 prompt 一分为二，动态文件（如 `heartbeat.md`）显式归入 `DYNAMIC_CONTEXT_FILE_BASENAMES` | `src/agents/system-prompt-cache-boundary.ts` |
| **Hermes** | `apply_anthropic_cache_control()` 实现 `system_and_3` 策略：缓存 system prompt + 最近 3 条非 system 消息（共 4 个 breakpoint），减少 ~75% 成本 | `agent/prompt_caching.py` |
| **Codex** | 基础 instructions 在连续请求间保持稳定一致（`prompt_caching.rs` 测试验证），turn 间的变化通过 developer/user delta message 注入而非改写 base prompt。不是显式 cache boundary，但效果等价：基础 prompt 天然可缓存 | `codex-rs/core/tests/suite/prompt_caching.rs`, `codex-rs/core/src/context_manager/updates.rs` |

**为什么这样做**：Anthropic/OpenAI 的 prompt cache 机制要求前缀 token 完全一致才能命中。任何中间的微小变化都会导致缓存失效。因此**把不变的放前面、变化的放后面**是硬约束，不是优化建议。命中后：输入成本降低 90%（Anthropic cached token 0.1x 价格）、首 token 延迟降低 50%+。

**Quilin 采纳方案**：

```typescript
// packages/agent-core/src/context/prompt-sections.ts

/** 标记静态/动态分界点 */
export const PROMPT_CACHE_BOUNDARY = '__QUILIN_CACHE_BOUNDARY__';

interface SystemPromptSection {
  name: string;
  compute: () => string;
  /** 更新频率：static = 永不变，per_session = session 内冻结，per_turn = 每轮重算 */
  updateFrequency: 'static' | 'per_session' | 'per_turn';
}

// 静态 sections（identity, rules, tool-guidance）→ boundary 之前
// 动态 sections（memory, env, temporal, mcp）→ boundary 之后
```

`PromptBuilder.build()` 返回 `AssembledPrompt { staticPrefix, dynamicSuffix }`，`static` + `per_session` 段归入 `staticPrefix`，`per_turn` 段归入 `dynamicSuffix`。Iter A 只维护此 metadata 分界，不改 `Message.content` 或 `LLMClient` 接口；真正的 `cache_control: { type: "ephemeral" }` API 标记延后到 LLM transport 小迭代。

#### 模式 2：分段式模块化组装（对应职责 4-排布 + 5-预算）

**问题**：一个单体 `build()` 方法把身份、工具、记忆、规则全部拼成一个字符串——增删改任何一段都要改这个巨函数，而且无法对单个段做 token 预算控制。

**业界实践**：

| Agent | 实现 | 源码位置 |
|-------|------|---------|
| **Claude Code** | `systemPromptSection(name, computeFn)` 工厂函数注册命名段。静态段：`getSimpleIntroSection()`、`getSimpleDoingTasksSection()`、`getUsingYourToolsSection()` 等 7 个。动态段通过 `resolveSystemPromptSections()` 按名称注册，`DANGEROUS_uncachedSystemPromptSection()` 标记必须每轮重算的段 | `src/constants/systemPromptSections.ts`, `src/constants/prompts.ts` |
| **OpenClaw** | 上下文文件按 `CONTEXT_FILE_ORDER` 排序（`agents.md=10, soul.md=20, identity.md=30 ...`），3 种 PromptMode（`full/minimal/none`）控制子 Agent 场景下段的取舍，`ProviderSystemPromptContribution` 允许 LLM provider 覆盖任意段 | `src/agents/system-prompt.ts`, `src/agents/system-prompt-contribution.ts` |
| **Hermes** | `_build_system_prompt()` 严格 11 层顺序：Identity → Tool guidance → Subscription → Tool-use enforcement → Memory snapshot → User profile → Skills → Context files → Timestamp → Env hints → Platform hints | `run_agent.py:3121-3286` |
| **Codex** | 模板文件分段标题（General, Editing constraints, Plan tool, Special requests, Frontend, Presenting work, Final formatting），运行时通过 `{{ personality }}` 占位符注入模型定制内容 | `codex-rs/core/gpt-5.2-codex_prompt.md` |

**为什么这样做**：

1. **可组合**——每个段独立注册，增删段不影响其他段。Claude Code 的 MCP 段随 MCP server 连接/断开动态出现/消失，不需要改主流程
2. **可预算**——每个段可以独立做 token 预算控制。25 个工具的 schema 可能占 3000 token，通过段级预算限制可以动态决定放多少
3. **可缓存**——段按 `updateFrequency` 自动分组（`static`/`per_session` → 前缀，`per_turn` → 后缀），最大化缓存命中
4. **可测试**——每个段独立函数，单测容易写

**Quilin 采纳方案**（超越 2.2 的原始 `SystemPromptBuilder`）：

```typescript
// packages/agent-core/src/context/prompt-builder.ts

interface PromptSection {
  /** 段名，用于调试和日志 */
  name: string;
  /** 排序权重，数值越小越靠前 */
  order: number;
  /** 计算段内容 */
  compute: (ctx: BuildContext) => string | null;
  /** 更新频率：static = 不变可缓存，per_session = session 内冻结，per_turn = 每轮重算 */
  updateFrequency: 'static' | 'per_session' | 'per_turn';
  /** 可选的 token 上限（超过则截断） */
  maxTokens?: number;
}

interface SystemPromptBuilder {
  /** 注册一个段 */
  register(section: PromptSection): void;
  /** 移除一个段 */
  unregister(name: string): void;
  /** 组装全部段，返回 { staticPrefix, dynamicSuffix, sectionTokens, totalTokens } */
  build(ctx: BuildContext): AssembledPrompt;
  /** 估算总 token */
  estimateTokens(): number;
}
```

> **与 2.2 的关系**：2.2 定义的 `SystemPromptBuilder.build(role_persona, tool_descriptions, memory_summary, constraint_rules)` 是早期简化设计。本节的分段式 `register/build` 模式取代它成为正式实现方案。2.2 的接口保留为概念参考。

#### 模式 3：模型特异性提示适配（对应职责 1-收集 + 4-排布）

**问题**：不同 LLM 对指令的敏感度、tool use 格式、role 名称各不相同。一套 system prompt 喂给所有模型会导致行为不一致——有的模型需要强调"你必须调用工具"，有的会忽略中间段落。

**业界实践**：

| Agent | 实现 | 源码位置 |
|-------|------|---------|
| **Hermes** | 为不同模型族注入不同的行为指导：`OPENAI_MODEL_EXECUTION_GUIDANCE`（GPT 专用：`<tool_persistence>`, `<mandatory_tool_use>`, `<act_dont_ask>`）、`GOOGLE_MODEL_OPERATIONAL_GUIDANCE`（Gemini 专用：绝对路径、先验证后操作、并行 tool call）；通过 `DEVELOPER_ROLE_MODELS` 对 GPT-5/Codex 使用 `developer` role 而非 `system` | `agent/prompt_builder.py` |
| **Codex** | 按模型版本维护独立的 prompt 模板文件（`gpt-5.2-codex_prompt.md`, `gpt-5.2-codex_instructions_template.md`），模板中有 `{{ personality }}` 占位符注入模型级定制 | `codex-rs/core/templates/model_instructions/` |
| **OpenClaw** | `ProviderSystemPromptContribution { stablePrefix?, dynamicSuffix?, sectionOverrides? }` 允许每个 LLM provider 覆盖默认 prompt 的任意段 | `src/agents/system-prompt-contribution.ts` |

**为什么这样做**：LLM 的 instruction following 能力差异巨大。GPT 系列需要 XML tag 强调重点才不会跳过工具调用；Gemini 对路径格式敏感，必须用绝对路径。用统一 prompt 喂不同模型，产出质量可差 20-40%。

**Quilin 采纳方案**：

```typescript
// packages/agent-core/src/context/model-adapter.ts

interface ModelPromptAdapter {
  /** 模型族标识符（如 "anthropic", "openai", "google"） */
  modelFamily: string;
  /** 返回该模型族专用的额外 prompt sections */
  getModelSections(): PromptSection[];
  /** 返回该模型 API 的 role 名称映射 */
  getRoleMapping(): { system: string; user: string; assistant: string };
}
```

在 `SystemPromptBuilder.build()` 时根据当前 model 注入对应 adapter 的 sections。Quilin 使用 Vercel AI SDK v6，SDK 层面已统一了多 provider 接口，model adapter 仅处理**行为差异**（prompt 内容），不处理 API 格式差异（SDK 已解决）。

#### 模式 4：上下文文件注入安全扫描（对应职责 2-筛选）

**问题**：用户项目中的 `.claude.md`、`AGENTS.md`、`SOUL.md` 等文件会被注入 system prompt。攻击者可以在这些文件中植入恶意指令（prompt injection），让 Agent 泄露密钥、执行破坏性操作。

**业界实践**：

| Agent | 实现 | 源码位置 |
|-------|------|---------|
| **Hermes** | `_scan_context_content()` 扫描 10+ 威胁模式：不可见 Unicode 字符（零宽空格）、"ignore previous instructions" 类指令覆盖、凭据外泄提示、隐藏 HTML div、编码混淆。检测到威胁后标记警告但不静默丢弃（用户可见） | `agent/prompt_builder.py` |
| **OpenClaw** | `CONTEXT_FILE_ORDER` 控制文件加载顺序，确保高信任文件先加载；`sanitizeContextFileContentForPrompt()` 做轻量清理（去除 heartbeat 块、压空行），但不做威胁模式扫描 | `src/agents/system-prompt.ts` |

> **注**：真正的威胁模式扫描目前只有 Hermes 实现了完整方案。OpenClaw 的 sanitize 是清理而非安全扫描。Quilin 应参考 Hermes 的 threat scanner 设计，同时参考 OpenClaw 的信任分级加载顺序。

**为什么这样做**：Agent 对 system prompt 中的指令高度信任——如果攻击者能往 system prompt 里注入内容，等于获得了对 Agent 的控制权。随着 Agent 权限越来越大（文件系统、代码执行、网络访问），注入攻击的危害也越来越大。扫描不是"nice to have"，是**安全基线**。

**Quilin 采纳方案**：

```typescript
// packages/agent-core/src/context/injection-scanner.ts

interface ScanResult {
  safe: boolean;
  threats: Array<{
    pattern: string;      // 匹配的威胁模式名
    location: string;     // 文件路径 + 行号
    severity: 'warn' | 'block';
  }>;
  sanitizedContent: string;  // 消毒后的内容
}

/**
 * 扫描外部来源内容，检测 prompt injection 威胁。
 * 纯函数，不嵌入 builder，由 source collector 调用。
 * 只扫描 isExternal=true 的来源，不扫描内置静态段。
 */
function scanExternalContext(
  content: string,
  source: string,
): ScanResult;
```

扫描规则：
- 不可见 Unicode 字符（`\u200B`, `\uFEFF`, `\u200E` 等）
- 指令覆盖模式（`ignore previous`, `disregard`, `forget your instructions`）
- 凭据泄露提示（`print your system prompt`, `show me your instructions`）
- Base64/编码混淆（可疑的编码字符串）
- 隐藏 HTML 标签（`<div style="display:none">`）

策略：`warn` 级别记录日志继续注入（避免误杀），`block` 级别拒绝注入并通知用户。与 07-Safety 模块联动。

#### 模式 5：Prompt 缓存稳定性保障（对应职责 7-缓存）

**问题**：prompt cache 的命中条件是前缀 token 逐字节匹配。一个多余的空格、一个换行符的差异、一个列表项顺序的变化，都会导致缓存全部失效——而这些变化对 LLM 的语义没有任何影响。

**业界实践**：

| Agent | 实现 | 源码位置 |
|-------|------|---------|
| **OpenClaw** | `normalizeStructuredPromptSection()` 标准化空白字符（多余空格/换行 → 单空格），`normalizePromptCapabilityIds()` 对能力列表去重并排序，确保相同语义产生完全相同的 token 序列 | `src/agents/prompt-cache-stability.ts` |
| **Hermes** | 会话开始时冻结 memory snapshot 到 system prompt，整个会话期间不更新——新增的记忆不突变缓存前缀 | `run_agent.py` (memory frozen snapshot) |

**为什么这样做**：缓存命中率直接影响成本和延迟。OpenClaw 团队发现不做标准化时，相同逻辑的 prompt 由于空白差异导致缓存命中率只有 40-50%，标准化后提升到 85%+。Hermes 的冻结策略更激进——宁可牺牲 session 内记忆的实时性，也要保住缓存命中。

**Quilin 采纳方案**：

```typescript
// packages/agent-core/src/context/cache-stability.ts

/** 标准化 prompt section，确保相同语义产生相同 token 序列 */
function normalizeSection(content: string): string {
  // 1. 合并连续空白为单空格
  // 2. 统一换行符为 \n
  // 3. 去除尾部空白
  // 注意：不对自然语言内容排序，只对结构化列表排序
}

/** 对结构化标识符列表去重并排序（仅限 capability IDs、tool names 等） */
function normalizeSortedList(items: string[]): string[];

/** 比较两个 section 是否语义等价（用于判断是否需要更新缓存） */
function sectionSemanticEqual(a: string, b: string): boolean;
```

与 Hermes 的冻结策略结合：每个 section 通过 `updateFrequency`（`static` / `per_session` / `per_turn`）声明更新频率。`per_session` 的 section（如 memory snapshot、environment）在 session 内冻结（`PromptBuilder.sessionCache`），不突变缓存前缀，最大化缓存稳定性。

#### 模式 6：工具行为指导与 Tool Schema 分离（对应职责 1-收集 + 4-排布）

**问题**：LLM 的 tool use 有两层信息——JSON schema（告诉模型工具的参数格式）和行为指导（告诉模型什么时候该用、怎么用好）。混在一起会导致 schema 膨胀，而且行为指导频繁变化会破坏 schema 的缓存。

**业界实践**：

| Agent | 实现 | 源码位置 |
|-------|------|---------|
| **Claude Code** | Tool JSON schema 通过 API `tools` 参数传入（由 Vercel AI SDK 处理），行为指导（何时用、注意事项）写在 system prompt 的静态段 `getUsingYourToolsSection()` 中 | `src/constants/prompts.ts` |
| **Hermes** | `TOOL_USE_ENFORCEMENT_GUIDANCE`（强制模型调用工具而非口头描述）、`SKILLS_GUIDANCE`（技能使用最佳实践，技能目录与按需加载详见 [13-技能工程](../13-skills/README.md)）、`SESSION_SEARCH_GUIDANCE`（搜索策略）分别作为独立段注入 system prompt；Tool schema 走 API 的 `tools` 字段 | `agent/prompt_builder.py` |
| **OpenClaw** | `tools.md` 作为 order=50 的上下文文件注入，内容是工具使用策略；实际的 tool definition 通过 `@modelcontextprotocol/sdk` 的 tool API 注册 | `src/agents/system-prompt.ts` |

**为什么这样做**：

1. **缓存友好**——tool schema 通过 API 参数传入，走独立的缓存通道；行为指导写在静态 system prompt 段里，也能被缓存。二者解耦后各自稳定
2. **Token 效率**——schema 本身只是结构化描述，行为指导才是影响模型决策的关键。分开后可以对行为指导做更精细的 token 预算控制
3. **模型适配**——不同模型对 tool use 的遵从度不同（如 Hermes 发现 GPT 系列需要额外的 `<mandatory_tool_use>` 标签），行为指导段可以按模型定制而不影响 schema

**Quilin 采纳方案**：

- Tool JSON schema 通过 Vercel AI SDK v6 的 `tools` 参数注册，不进入 system prompt
- 工具行为指导作为 `PromptSection { name: "tool-guidance", order: 40, updateFrequency: 'static' }` 注入静态 system prompt
- 模型特异的工具使用强化指令由 `ModelPromptAdapter.getModelSections()` 提供

#### 模式 7：运行时增量侧信道（Delta Channel）（对应职责 6-时序 + 7-缓存）

**问题**：不是所有运行时变化都应该塞回 system prompt。如果每轮都把最新的会话状态、用户偏好变化、工具结果全部重写进 base prompt，缓存永远命不中。但如果完全不更新，Agent 的行为就与当前上下文脱节。需要一个机制区分"什么进 base prompt"和"什么走侧信道"。

**业界实践**：

| Agent | 实现 | 源码位置 |
|-------|------|---------|
| **Codex** | 基础 instructions 保持稳定，turn 间的设置变化通过 developer/user delta message 注入——只发送变化的部分，不重写整个 prompt。恢复（resume）和压缩（compaction）时也依赖这种分离 | `codex-rs/core/src/context_manager/updates.rs`, `codex-rs/core/src/codex.rs` |
| **OpenClaw** | 3 种 PromptMode（`full/minimal/none`）——主 Agent 用 full，子 Agent 用 minimal 或 none，大幅减少子 Agent 的 base prompt 体积。`DYNAMIC_CONTEXT_FILE_BASENAMES`（如 `heartbeat.md`）显式标记为"不进 base prompt，走动态通道" | `src/agents/system-prompt.ts` |
| **Hermes** | 会话开始时冻结 memory snapshot 到 system prompt，整个 session 内新增的记忆不突变 base prompt，而是在需要时通过 tool call 按需查询 | `run_agent.py` |

**为什么这样做**：

1. **缓存命中率**——base prompt 越稳定，cache 命中率越高。Hermes 的冻结策略宁可牺牲实时性也要保缓存
2. **Resume/Compaction**——Codex 的 delta channel 让会话恢复和上下文压缩成为可能：base prompt 不变，只需重放 delta
3. **子 Agent 效率**——OpenClaw 的 PromptMode 让子 Agent 不需要携带主 Agent 的完整 prompt，大幅节省 token

**Quilin 采纳方案**：

`PromptSection` 的 `updateFrequency` 字段直接支持这个模式：

- `static` → 进 base prompt，被缓存
- `per_session` → session 开始时冻结到 base prompt，session 内不更新
- `per_turn` → 走动态后缀，每轮重算

此外，为子 Agent 场景定义 `PromptProfile`：

```typescript
type PromptProfile = 'full' | 'minimal' | 'none';

// full: 主 Agent，所有段都加载
// minimal: 子 Agent，只加载 identity + rules + task-specific 段
// none: 纯工具调用 Agent，不注入 system prompt
```

### 2.6 提示词工程模式总览与上下文职责映射

| 模式 | 解决的问题 | 对应上下文职责 | 取长于 |
|------|-----------|---------------|--------|
| 静态/动态缓存边界 | 系统提示重复发送的成本 | 7-缓存 | Claude Code, OpenClaw, Hermes |
| 分段式模块化组装 | 单体 prompt 的可维护性 | 4-排布 + 5-预算 | Claude Code, OpenClaw, Hermes, Codex |
| 模型特异性适配 | 不同 LLM 的行为差异 | 1-收集 + 4-排布 | Hermes, Codex, OpenClaw |
| 注入安全扫描 | 外部文件的 prompt injection | 2-筛选 | Hermes（主）, OpenClaw（信任分级） |
| 缓存稳定性保障 | 无意义变化导致缓存失效 | 7-缓存 | OpenClaw, Hermes |
| 工具指导/Schema 分离 | Tool 信息的组织与缓存 | 1-收集 + 4-排布 | Claude Code, Hermes, OpenClaw |
| 运行时增量侧信道 | 运行时变化破坏缓存 | 6-时序 + 7-缓存 | Codex, OpenClaw, Hermes |

---

## 三、Top 10 参考项目

| # | 项目 | GitHub Stars (2026) | 核心上下文能力 | 类型 |
|---|------|---------------------|----------------|------|
| 1 | [LangChain](https://github.com/langchain-ai/langchain) | ~119K | ChatPromptTemplate + MessagesPlaceholder 消息模型 | 深入 |
| 2 | [LlamaIndex](https://github.com/run-llama/llama_index) | ~44K | SentenceSplitter + 检索增强 + ResponseSynthesizer | 深入 |
| 3 | [DSPy](https://github.com/stanfordnlp/dspy) | ~28K | Signature 声明式 prompt 编程 + 自动优化 | 深入 |
| 4 | [Semantic Kernel](https://github.com/microsoft/semantic-kernel) | ~27K | KernelFunction + PromptTemplate + 多后端记忆 | 深入 |
| 5 | [Instructor](https://github.com/567-labs/instructor) | ~11K | Pydantic 驱动结构化输出 + 自动重试修正 | 深入 |
| 6 | [Haystack](https://github.com/deepset-ai/haystack) | ~23K | Pipeline 式上下文组装 + RAG pipeline | 观察 |
| 7 | [AutoGen](https://github.com/microsoft/autogen) | ~40K+ | 多角色对话上下文管理 + 角色切换 | 观察 |
| 8 | [CrewAI](https://github.com/crewAIInc/crewAI) | ~44K | 角色 + 任务 prompt 模板 + 工作流上下文 | 观察 |
| 9 | [PydanticAI](https://github.com/pydantic/pydantic-ai) | ~15K | 类型安全 prompt + 依赖注入式上下文 | 观察 |
| 10 | [Guidance](https://github.com/guidance-ai/guidance) | ~19K | 约束解码 + token 级别模板控制 | 观察 |

---

## 四、吸收内化方案

### 4.1 LangChain — 消息模型设计

**核心贡献**：将 LLM 的"一大段文字"拆分成有语义的消息对象。

LangChain 将上下文分成三类消息：`SystemMessage`（系统配置/角色）、`HumanMessage`（用户输入）、`AIMessage`（模型历史输出）。`ChatPromptTemplate` 将这三类组合成模板，`MessagesPlaceholder` 作为占位符，在运行时注入动态历史列表，实现了模板结构与运行时数据的解耦。

**对 Harness 的启发**：
- 采用同样的三类消息分类，`AssembledContext.messages` 使用 OpenAI 标准格式 `{"role": "system/user/assistant", "content": "..."}`
- `SystemPromptBuilder` 的输出对应 `SystemMessage`
- 对话历史以 `HumanMessage + AIMessage` 交替形式存入 `messages` 列表
- 注意 MessagesPlaceholder 本身不自动管理 token 限制，需要 Harness 的 `TokenBudgetAllocator` 在注入前完成裁剪

### 4.2 LlamaIndex — 上下文压缩与检索增强

**核心贡献**：将文档分块、向量检索与上下文组装形成完整 RAG 流水线。

`SentenceSplitter` 按句子边界切分文档为 Node（避免语义截断），每个 Node 附带 token 计数，检索时根据向量相似度打分，只取 top-K 相关片段送入上下文。`ResponseSynthesizer` 则将多个检索片段合并为连贯上下文，支持"精炼"（refine）和"树状合并"（tree_summarize）两种策略。

**对 Harness 的启发**：
- Memory 层存储的记忆 chunk 应按句子/段落边界切分，附带 token 计数元数据
- `select()` 方法实现向量相似度过滤，`relevance_threshold` 配置项对应 LlamaIndex 的 similarity_cutoff
- 多记忆片段合并时参考 refine 策略（逐步精炼而非直接拼接），减少上下文中的冗余

### 4.3 DSPy — 签名式声明式编程

**核心贡献**：将"写 prompt"变成"声明输入/输出类型"，把 prompt 优化交给框架自动处理。

DSPy `Signature` 用自然语言声明 LM 任务的输入字段和输出字段（如 `question -> answer`），`Module` 组合多个 Signature 形成复杂推理链。框架自动根据签名生成初始 prompt，并通过 `Teleprompter`（如 BootstrapFewShot、MIPROv2）自动优化 prompt 措辞——开发者不再手写 prompt 字符串。

**对 Harness 的启发**：
- `SystemPromptBuilder` 的参数（role、tools、memory_summary、rules）本质上就是 DSPy Signature 的输入字段——可以引入声明式配置替代硬编码模板字符串
- 未来可对接 DSPy 优化器，自动找到最优的系统提示措辞，而不是靠工程师手写
- Harness 的 `config.yaml` 中的 prompt 模板部分可以设计为类似 Signature 的声明式格式

### 4.4 Semantic Kernel — 内核函数注册与 Prompt 编排

**核心贡献**：将 LLM 调用和原生函数统一注册为 `KernelFunction`，在 Prompt 模板中直接嵌入函数调用。

Semantic Kernel 的 `KernelFunction` 既可以是 LLM semantic function（prompt 模板驱动），也可以是 native function（Python/C# 代码）。`PromptTemplate` 使用 `{{$variable}}` 和 `{{plugin.function}}` 两种占位符，前者注入变量，后者直接调用函数并将结果内联进 prompt。`TemplateEngine` 负责在渲染时解析和执行这些调用。框架还内置多个记忆后端（内存、Redis、Azure Cognitive Search）用于跨会话的上下文持久化。

**对 Harness 的启发**：
- `SystemPromptBuilder` 可以支持类似的双占位符机制：变量注入（`{role_persona}`）+ 函数内联（动态获取最新工具描述）
- 工具描述不应硬编码在 system prompt 里，而是由 `PluginRegistry` 动态生成并注入
- 多后端记忆存储的设计（开发用内存、生产用向量数据库）与 Harness 的 `LayerProvider` 协议一致

### 4.5 Instructor — 结构化输出约束与自动重试

**核心贡献**：用 Pydantic model 约束 LLM 输出格式，输出不合法时自动将错误信息注入 prompt 并重试。

Instructor 将 Pydantic 模型作为输出 schema，调用时通过 `response_model` 参数传入期望类型，框架自动将 schema 转为 JSON Schema 或函数调用格式附加到 prompt 中。当 LLM 输出无法通过 Pydantic 校验时，Instructor 将校验错误信息（`ValidationError`）自动构造为新的 `HumanMessage` 追加进上下文，触发重试——这是一种"错误信息驱动的上下文增强"模式。

**对 Harness 的启发**：
- Tool 调用结果、Planning 输出均应定义 Pydantic schema，确保格式可验证
- `ContextManager.build_context()` 在 Tool 调用失败后，应将错误信息作为新的上下文源追加（而不是静默失败）
- 重试时的上下文增量（错误 + 修正指令）应计入 TokenBudgetAllocator，避免重试循环导致 token 溢出

### 4.6 后 5 项观察要点

| 项目 | 关键上下文设计 | Harness 参考点 |
|------|--------------|----------------|
| **Haystack** | ComponentBase + Pipeline 的有向图组装，每个组件声明 input/output 端口 | MCPBus 的消息路由可参考其端口声明模式 |
| **AutoGen** | 每个 Agent 维护独立的 `messages` 列表，通过 `GroupChat` 合并多角色历史 | 多 Agent 场景下各 Agent 的上下文隔离与共享策略 |
| **CrewAI** | Task 对象携带 context 字段，完成的 Task 输出自动成为下一个 Task 的上下文 | Planning 层的步骤结果自动流转机制 |
| **PydanticAI** | 依赖注入式上下文（`RunContext[Deps]`），类型安全地传递 Agent 运行时依赖 | Harness state 字典可升级为类型化的 RunContext |
| **Guidance** | 约束解码在 token 生成级别插入规则（regex/CFG），无需 prompt 描述格式 | 结构化输出的终极保障，与 Instructor 的校验重试互补 |

---

## 五、与 Harness 组件映射

### 5.1 实现状态（对应 Harness.py）

> **状态校准（2026-04-30）**：本节的 Harness.py 表是早期设计快照。当前 TS 实现已迁移到 `packages/agent-core/src/context/`；下表保留历史语境，不再作为当前待办清单。

| 上下文职责 | 当前状态 | 待实现 |
|-----------|---------|--------|
| 收集 | `build_context` 只从 Memory 拿 | 加 Perception/Tool/多 Agent 来源 |
| 筛选 | `memories[:20]` 直接截断 | 加相关性排序 + rerank |
| 压缩 | `reflect()` 做了基础的 | 加分层摘要 + token 感知裁剪 |
| 排布 | 未实现 | 加 prompt 模板 + 位置策略 |
| 预算 | 未实现 | 加 Context Budget Manager |
| 时序 | 每轮重建 | 加增量更新 + 触发式召回 |
| 缓存 | 未实现 | 加 prompt prefix 缓存 |

### 5.2 Harness 组件与上下文模块对应关系

```
Quilin（quilin/core/Harness.py）
├── quilin-mem              ←→  ContextManager.gather()  [Memory 来源]
│                                ContextManager.compress() [4 层压缩管道]
├── PluginRegistry           ←→  SystemPromptBuilder（工具描述动态注入）
├── MCPBus                   ←→  ContextManager.gather()  [多 Agent 来源]
├── build_context()          ←→  ContextManager.build_context() [待重构]
│    当前：只 memories[:20]
│    目标：完整 7 步流水线
├── reflect()                ←→  ContextManager.compress() [中时记忆摘要]
└── （待添加）
     ├── ContextBudgetManager ←→  TokenBudgetAllocator
     ├── PromptCacheManager   ←→  ContextManager.get_cache_prefix()
     └── ContextAssembler     ←→  SystemPromptBuilder + 排布策略
```

### 5.3 新增模块规划（优先级排序）

| 优先级 | 模块 | 文件路径 | 解决的问题 |
|--------|------|----------|------------|
| P0 | ContextBudgetManager | `quilin/context/budget.py` | 窗口溢出、预算分配 |
| P0 | ContextAssembler | `quilin/context/assembler.py` | 排布策略、多源融合 |
| P1 | SystemPromptBuilder | `quilin/context/prompt_builder.py` | 动态 system prompt |
| P1 | RelevanceSelector | `quilin/context/selector.py` | 筛选、rerank |
| P2 | PromptCacheManager | `quilin/context/cache.py` | 缓存命中率 |
| P2 | ContextCompressor | `quilin/context/compressor.py` | 分层摘要压缩 |

### 5.4 重构路径：`build_context()` 演进

**当前实现（Harness.py 片段）**
```python
# 现状：简单截断，无预算、无筛选、无排布
def build_context(self, state):
    memories = state.get("memories", [])
    return "\n".join(memories[:20])  # 直接截断，噪音未过滤
```

**目标实现（重构后）**
```python
def build_context(self, state: HarnessState) -> AssembledContext:
    query = state["current_input"]
    task_type = state.get("task_type", "deep_reasoning")

    # 1. 收集（多源）
    sources = self.context_manager.gather(query, state)

    # 2. 筛选（相关性过滤）
    policy = self.budget_allocator.allocate(task_type, total_window=131072)
    filtered = self.context_manager.select(sources, policy)

    # 3. 压缩（token 感知）
    compressed = self.context_manager.compress(filtered, policy.total_budget)

    # 4+5. 排布 + 预算
    assembled = self.context_manager.build_context(compressed, policy)

    # 7. 缓存前缀标记
    assembled.cache_prefix_end = self.cache_manager.mark_prefix(assembled)

    return assembled
```

### 5.5 MemoryBridge（D-05：02 ↔ 03 边界）

**定位**：quilin-mem（03）的 recall 结果到 ContextSource 的**薄适配层**，是 02-Context 与 03-Memory 之间唯一的数据转换点。

**权威实现**：[`packages/agent-core/src/context/draft/memory-bridge.ts`](../../packages/agent-core/src/context/draft/memory-bridge.ts)

**合同**（TS）：

```typescript
export interface MemoryRecallResult {
  readonly content: string
  readonly score: number
  readonly timestamp: number
  readonly layer: 'working' | 'episodic' | 'semantic' | 'skill'
}

export function recallResultsToSources(
  results: readonly MemoryRecallResult[],
  options: { threshold: number },
): ContextSource[]
```

**设计原则**：
- **不做关键词抽取**：查询字符串直接透传给 quilin-mem，由 03 侧的检索器自己做 query expansion / CJK n-gram / vector encode（D-05 要求分层只在一侧做）。
- **只做转换 + 阈值过滤**：score < threshold 的结果直接丢弃；其余按 `ContextSource` schema 打平，标记 `sourceType='memory'` / `isExternal=true` / `metadata.layer`。
- **无状态**：不维护任何缓存；每次 `build_context()` 都现转，避免跨 turn 数据漂移。

**与 03 的接口约定**（由 quilin-mem MCP Server 返回）：
- `layer` 字段用于下游的 layer_priority 权重计算（见 03 §混合检索）。
- `score` 已在 03 侧做过综合评分（vector + time_decay + layer_priority + task_relevance），02 不二次加权，只做 cutoff。
- `timestamp` 单位：Unix ms，供 ContextAssembler 排序使用。

**反模式（禁止）**：
- ❌ 在 MemoryBridge 里调用 embedding / 跑 rerank（这是 03 的事）。
- ❌ 在 MemoryBridge 里写回 quilin-mem（单向流，写入只能通过 03 自己的 `MemoryStore` API）。
- ❌ 把 `ContextSource` 反向转回 `MemoryRecallResult` 发回 03（单向流，只能 01 → 03 提交 `ProfileSignal` 或完整对话 turn）。

---

## 六、验证标准

### 6.1 单元测试

#### ContextManager.build_context() 组装正确性

```python
# tests/unit/context/test_assembler.py
class TestContextAssembler:

    def test_message_order_follows_arrangement_policy(self):
        """验证排布策略：系统提示在前，用户输入在最后"""
        sources = make_test_sources()
        context = assembler.build_context(sources, default_policy)
        messages = context.messages
        assert messages[0]["role"] == "system"
        assert messages[-1]["role"] == "user"

    def test_total_tokens_within_budget(self):
        """验证组装后总 token 数不超过预算"""
        policy = BudgetPolicy(task_type="simple_qa", total_budget=10000, ...)
        context = assembler.build_context(sources, policy)
        assert context.total_tokens <= policy.total_budget

    def test_low_relevance_sources_excluded(self):
        """验证相关性低于阈值的记忆被过滤掉"""
        low_rel_source = ContextSource(relevance_score=0.3, ...)
        sources = [high_rel_source, low_rel_source]
        filtered = selector.select(sources, policy)
        assert low_rel_source not in filtered

    def test_multi_source_types_gathered(self):
        """验证收集到 Memory + Perception + Tool 三类来源"""
        sources = context_manager.gather("test query", mock_state)
        source_types = {s.source_type for s in sources}
        assert "memory" in source_types
        assert "tool" in source_types
        assert "perception" in source_types
```

#### TokenBudgetAllocator 预算分配逻辑

```python
# tests/unit/context/test_budget.py
class TestTokenBudgetAllocator:

    def test_task_profiles_sum_to_one(self):
        """验证各任务类型的比例之和等于 1（除去输出预留）"""
        for task_type in ["simple_qa", "deep_reasoning", "tool_use", "multi_agent"]:
            policy = allocator.allocate(task_type, total_window=131072)
            ratio_sum = policy.system_ratio + policy.memory_ratio + \
                        policy.tools_ratio + policy.history_ratio
            assert abs(ratio_sum - 1.0) < 0.01

    def test_tool_use_gives_more_tools_budget(self):
        """验证 tool_use 任务类型工具预算高于 simple_qa"""
        tool_use = allocator.allocate("tool_use", 131072)
        simple_qa = allocator.allocate("simple_qa", 131072)
        assert tool_use.tools_ratio > simple_qa.tools_ratio

    def test_rebalance_redistributes_unused_budget(self):
        """验证实际使用低于分配时，剩余预算转移到其他部分"""
        policy = allocator.allocate("deep_reasoning", 131072)
        # 假设 memory 实际只用了一半
        actual = {"memory": policy.total_budget * policy.memory_ratio * 0.5}
        rebalanced = allocator.rebalance(policy, actual)
        assert rebalanced.history_ratio > policy.history_ratio  # 多余转给历史

    def test_override_param_respected(self):
        """验证局部覆盖参数生效"""
        policy = allocator.allocate("simple_qa", 131072, overrides={"output_reserve": 50000})
        assert policy.output_reserve == 50000
```

#### SystemPromptBuilder 模板渲染

```python
# tests/unit/context/test_prompt_builder.py
class TestSystemPromptBuilder:

    def test_all_sections_present_in_output(self):
        """验证角色、工具、记忆摘要、约束规则都出现在输出中"""
        prompt = builder.build(
            role_persona="你是代码审查助手",
            tool_descriptions=["tool_a: 搜索代码", "tool_b: 执行测试"],
            memory_summary="用户偏好 Python，不喜欢过度注释",
            constraint_rules=["不输出个人信息", "始终用中文回复"],
        )
        assert "代码审查" in prompt
        assert "tool_a" in prompt
        assert "Python" in prompt
        assert "不输出个人信息" in prompt

    def test_empty_memory_summary_handled_gracefully(self):
        """验证记忆摘要为空时不产生多余空行/占位符"""
        prompt = builder.build(
            role_persona="助手",
            tool_descriptions=[],
            memory_summary="",
            constraint_rules=[],
        )
        assert "{memory_summary}" not in prompt  # 未渲染的占位符不应出现

    def test_token_estimate_within_10_percent(self):
        """验证 token 估算误差在 10% 以内"""
        prompt = builder.build(...)
        estimated = builder.estimate_tokens(prompt)
        actual = count_tokens_exact(prompt)  # 用 tiktoken 精确计数
        assert abs(estimated - actual) / actual < 0.10
```

### 6.2 集成测试

#### 上下文超限时自动压缩

```python
# tests/integration/context/test_compression.py
class TestContextCompression:

    def test_overflow_triggers_compression(self):
        """验证总 token 超过预算时自动触发压缩"""
        # 构造超大记忆来源（超过预算 2 倍）
        huge_sources = [make_source(tokens=5000) for _ in range(30)]  # 150K tokens
        policy = BudgetPolicy(total_budget=50000, ...)

        compressed = context_manager.compress(huge_sources, policy.total_budget)
        total = sum(s.token_count for s in compressed)
        assert total <= policy.total_budget

    def test_compression_preserves_high_relevance_content(self):
        """验证压缩后高相关性内容被保留，低相关性内容被丢弃"""
        high_rel = make_source(relevance_score=0.9, content="关键信息A")
        low_rel = make_source(relevance_score=0.2, content="无关信息B")
        compressed = context_manager.compress([high_rel, low_rel], target_tokens=100)
        contents = [s.content for s in compressed]
        assert "关键信息A" in str(contents)

    def test_different_task_types_get_different_budgets(self):
        """验证不同任务类型的预算动态调整生效"""
        simple_context = full_pipeline("simple_qa", same_sources)
        reasoning_context = full_pipeline("deep_reasoning", same_sources)
        # deep_reasoning 应给 memory 更多 token
        assert reasoning_context.budget_breakdown["memory"] > \
               simple_context.budget_breakdown["memory"]
```

### 6.3 端到端测试

#### 完整 Agent 循环中上下文组装正确性

```python
# tests/e2e/test_agent_loop.py
class TestAgentLoopContextE2E:

    @pytest.mark.e2e
    def test_full_agent_cycle_with_context_assembly(self):
        """验证完整一轮 Agent 循环：上下文组装 → LLM 调用 → 结果正确"""
        harness = Quilin.from_config("config.yaml")
        state = harness.init_state()
        state["current_input"] = "帮我分析这段代码的性能瓶颈"
        state["memories"] = load_test_memories()

        # 运行一轮循环
        result = harness.run_one_cycle(state)

        # 验证上下文组装
        assert result["assembled_context"].total_tokens <= 131072
        assert result["assembled_context"].messages[0]["role"] == "system"

        # 验证 LLM 调用发生且有合理输出
        assert result["llm_response"] is not None
        assert len(result["llm_response"]) > 10

        # 验证工具调用结果回填了上下文
        if result.get("tool_calls"):
            assert any(
                m.get("role") == "tool"
                for m in result["assembled_context"].messages
            )

    @pytest.mark.e2e
    def test_prompt_cache_hit_on_second_call(self):
        """验证第二次调用命中 prompt 缓存，延迟降低"""
        harness = Quilin.from_config("config.yaml")
        t1 = time_call(harness, "第一次调用，无缓存")
        t2 = time_call(harness, "第二次调用，应命中缓存")
        # 缓存命中时 TTFT (首 token 延迟) 应显著降低
        assert t2["ttft"] < t1["ttft"] * 0.5  # 至少快 50%

    @pytest.mark.e2e
    def test_context_not_corrupted_across_multi_turn(self):
        """验证多轮对话中上下文累积正确，无重复消息"""
        harness = Quilin.from_config("config.yaml")
        state = harness.init_state()
        for i in range(5):
            state["current_input"] = f"第 {i+1} 轮问题"
            state = harness.run_one_cycle(state)

        messages = state["last_assembled_context"].messages
        # 无重复消息
        contents = [m["content"] for m in messages]
        assert len(contents) == len(set(contents))
```

### 6.4 验收指标

| 指标 | 目标值 | 测量方式 |
|------|--------|----------|
| 单元测试覆盖率 | ≥ 80% | `pytest --cov=quilin/context` |
| 上下文 token 溢出率 | 0% | E2E 测试监控 |
| Prompt Cache 命中率 | ≥ 70% | Anthropic API 返回的 cache_read_tokens |
| 上下文组装延迟 | < 50ms | 性能基准测试 |
| 相关性筛选准确率 | ≥ 85% | 与 ground truth 记忆集对比 |
| 重试成功率（结构化输出） | ≥ 95% | Instructor 重试日志统计 |
