# 上下文工程（Context Engineering）

Quilin Agent 的核心本质是一个**上下文工程自动化流水线**，9 大能力层各自负责上下文生命周期的一个环节。

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
[长时记忆] OmniMem：提炼成 KG 三元组/向量索引
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
    """系统提示构建器——动态组装 system prompt 各个模块"""

    def build(
        self,
        role_persona: str,          # 角色定义（如 "你是一个专业的代码审查助手"）
        tool_descriptions: list[str],  # 当前可用工具的描述列表
        memory_summary: str,        # 长时记忆的摘要（gbrain / OmniMem 提取）
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
├── OmniMem                  ←→  ContextManager.gather()  [Memory 来源]
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
