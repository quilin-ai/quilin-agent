# Agent 工程文档体系实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 10 个领域的详细工程规格文档 + 架构总览 + 融合索引，为 OmniAgent-Harness 提供完整的设计蓝图。

**Architecture:** 按方案 B 组织：`architecture/`（总览+索引）、`engineering/`（10 个领域文档）、`research/`（模型参考）。每个工程文档遵循统一 6 节结构（问题定义/设计方案/Top 10 项目/吸收内化/组件映射/验证标准）。每个领域研究 Top 10 开源项目，前 3-5 深入分析，后 5-7 纳入观察。

**Tech Stack:** Markdown 文档、Web 搜索（GitHub Stars/特色/API 设计）、现有 Harness.py 组件映射

**重要约束:** 本计划仅涉及文档撰写，不涉及任何代码实现。

---

## 文件结构

### 新建文件
| 文件 | 职责 |
|------|------|
| `docs/architecture/overview.md` | 架构总览：10 领域全景图 + 导航 |
| `docs/architecture/fusion-index.md` | 融合索引：按领域分组，逐功能标注来源项目 |
| `docs/engineering/01-llm-integration.md` | LLM 接入工程规格 |
| `docs/engineering/02-context.md` | 上下文工程规格（迁移自 context-engineering.md） |
| `docs/engineering/03-memory.md` | 记忆工程规格（迁移自 memory-engineering.md，全部重写） |
| `docs/engineering/04-planning.md` | 规划工程规格（迁移自 planning-engineering.md，全部重写） |
| `docs/engineering/05-tool.md` | 工具工程规格（迁移自 tool-engineering.md） |
| `docs/engineering/06-multi-agent.md` | 多 Agent 工程规格（迁移自 multi-agent-engineering.md） |
| `docs/engineering/07-safety-guardrails.md` | 安全护栏工程规格 |
| `docs/engineering/08-observability.md` | 可观测性工程规格 |
| `docs/engineering/09-deployment-runtime.md` | 部署运行时工程规格 |
| `docs/engineering/10-self-evolution.md` | 自进化工程规格 |
| `docs/research/model-architecture-insights.md` | 迁移自 docs 根目录 |

### 修改文件
| 文件 | 修改内容 |
|------|---------|
| `CLAUDE.md` | 更新 Directory Structure 章节 |

### 删除文件（迁移后）
| 文件 | 原因 |
|------|------|
| `docs/context-engineering.md` | 迁移到 engineering/02-context.md |
| `docs/tool-engineering.md` | 迁移到 engineering/05-tool.md |
| `docs/memory-engineering.md` | 迁移到 engineering/03-memory.md |
| `docs/planning-engineering.md` | 迁移到 engineering/04-planning.md |
| `docs/multi-agent-engineering.md` | 迁移到 engineering/06-multi-agent.md |
| `docs/model-architecture-insights.md` | 迁移到 research/ |

---

### Task 1: 目录结构迁移

**Files:**
- Create: `docs/architecture/` (目录)
- Create: `docs/engineering/` (目录)
- Create: `docs/research/` (目录)
- Modify: `CLAUDE.md`

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p docs/architecture docs/engineering docs/research
```

- [ ] **Step 2: 迁移现有文件**

```bash
mv docs/context-engineering.md docs/engineering/02-context.md
mv docs/tool-engineering.md docs/engineering/05-tool.md
mv docs/memory-engineering.md docs/engineering/03-memory.md
mv docs/planning-engineering.md docs/engineering/04-planning.md
mv docs/multi-agent-engineering.md docs/engineering/06-multi-agent.md
mv docs/model-architecture-insights.md docs/research/model-architecture-insights.md
```

- [ ] **Step 3: 更新 CLAUDE.md 目录结构**

将 CLAUDE.md 中的 Directory Structure 章节替换为：

```markdown
## Directory Structure

```
omniagent-harness/
├── upstreams/                  # 90 git submodules (auto-synced, --depth 1)
│   ├── memory-*/               # Layer 1: Memory
│   ├── llm-*/                  # Layer 2: LLM Brain / Inference
│   ├── perception-*/           # Layer 3: Perception / Multimodal
│   └── ...                     # Layers 4-9
├── omniharness/                # Core fused code
│   ├── core/Harness.py         # Main entry: OmniHarness class + LangGraph state machine
│   ├── core/messages.py        # Message/ToolCall/ToolResult dataclasses
│   ├── core/llm.py             # LLM 接入（待重写为单一模型 + litellm）
│   ├── layers/                 # Per-layer provider adapters
│   ├── plugins/                # Pluggable Top10 implementations
│   └── config.yaml             # SOTA combination config
├── docs/
│   ├── architecture/
│   │   ├── overview.md         # 架构总览（10 领域全景图 + 导航）
│   │   └── fusion-index.md     # 融合索引（功能来源追踪）
│   ├── engineering/
│   │   ├── 01-llm-integration.md   # LLM 接入工程
│   │   ├── 02-context.md           # 上下文工程
│   │   ├── 03-memory.md            # 记忆工程
│   │   ├── 04-planning.md          # 规划工程
│   │   ├── 05-tool.md              # 工具工程
│   │   ├── 06-multi-agent.md       # 多 Agent 工程
│   │   ├── 07-safety-guardrails.md # 安全护栏工程
│   │   ├── 08-observability.md     # 可观测性工程
│   │   ├── 09-deployment-runtime.md # 部署运行时工程
│   │   └── 10-self-evolution.md    # 自进化工程
│   ├── research/
│   │   └── model-architecture-insights.md  # 6 模型设计参考
│   └── implementation-plan.md  # 8 Phase 实施计划
├── scripts/                    # Automation scripts
├── Dockerfile
├── requirements.txt
└── readme.md
```
```

- [ ] **Step 4: 验证迁移完整性**

```bash
# 确认新目录下文件存在
ls -la docs/architecture/ docs/engineering/ docs/research/
# 确认旧文件已删除（除 implementation-plan.md 外）
ls docs/*.md
# 应该只剩 implementation-plan.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: restructure docs into architecture/engineering/research layout"
```

---

### Task 2: 撰写架构总览 (overview.md)

**Files:**
- Create: `docs/architecture/overview.md`

**前置研究:**
- 读取 `omniharness/core/Harness.py` 了解 E-T-C-S-L-V 六组件
- 读取 `docs/research/model-architecture-insights.md` 了解 7 个跨模型设计模式
- 读取 `docs/implementation-plan.md` 了解 8 Phase 路线图

- [ ] **Step 1: 撰写 overview.md**

按以下结构撰写，每节简洁（地图定位，不展开详细设计）：

```markdown
# OmniAgent-Harness 架构总览

## 一句话定位
融合全球最强 Agent 开源项目精华的自进化 Agent 框架。
单一模型接入（litellm），10 大工程领域全覆盖，9 层 x Top 10 上游持续监控。

## 架构全景图
（ASCII Art：展示 10 个工程领域的关系 + 数据流向，参考设计规格中的依赖关系图）

01-LLM ──→ 02-Context ──→ 04-Planning ──→ 05-Tool
                │                              │
                └──→ 03-Memory                 └──→ 06-MultiAgent
07-Safety ← 横切所有领域（验证层）
08-Observability ← 横切所有领域（追踪层）
09-Deployment ← 运行时基础设施
10-SelfEvolution ← 依赖 01-06 全部

## 核心设计哲学
- 单一模型 + litellm（用户可配置任意模型）
- 6 模型设计参考 → 7 个跨模型设计模式（内化，不接入）
- 9 层 x Top 10 上游监控 + 自动缝合
- 内部组件直接调用，MCP 仅对接外部 Server
- E-T-C-S-L-V 六组件架构

## 10 大工程领域导航
（表格：编号、领域、一句话描述、文档链接、对应 implementation-plan.md Phase）

## E-T-C-S-L-V 六组件架构
（表格：Execution/Tools/Context/State/Lifecycle/Verification 与 Harness.py 类的映射）

## LangGraph 状态机
（8 节点流程图：verify_input → build_context → plan → execute_tools → verify_output → reflect → decide → end/loop）

## 7 个跨模型设计模式
（简表 + 链接到 research/model-architecture-insights.md，每个模式一行：编号、模式名、来源模型、融入的 Harness 组件）

## 竞品对比
（Claude Code / Codex / Manus / Hermes / OpenClaw vs 我们，引用 implementation-plan.md 中的对比表）

## 8 Phase 实施路线图
（链接到 implementation-plan.md，展示关键路径和并行策略图）
```

- [ ] **Step 2: 检查所有内部链接正确**

确认文档中所有相对链接指向正确路径：
- `../engineering/01-llm-integration.md` 等 10 个工程文档链接
- `../research/model-architecture-insights.md`
- `../implementation-plan.md`

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/overview.md
git commit -m "docs: add architecture overview as navigation hub for 10 engineering domains"
```

---

### Task 3: 撰写 01-llm-integration.md — LLM 接入工程

**Files:**
- Create: `docs/engineering/01-llm-integration.md`

**前置研究:**
- Web 搜索以下项目获取最新 Stars、核心特色、API 设计（深入 5 个）：
  - litellm: GitHub Stars、completion API、provider 归一化机制
  - LangChain LLM: 回调系统、BaseChatModel 接口、缓存策略
  - LlamaIndex LLM: 结构化输出、重试机制、CustomLLM 接口
  - vLLM: PagedAttention、AsyncLLMEngine 接口、吞吐指标
  - SGLang: RadixAttention、前端 DSL 设计
- 读取 `docs/research/model-architecture-insights.md` 中 ThinkingMode 和 InferenceConfig 设计
- 读取 `omniharness/core/messages.py` 了解已有消息格式

- [ ] **Step 1: 研究 Top 5 深入项目**

对每个深入项目，搜集：
1. GitHub Stars 数（当前最新）
2. 核心 API 接口设计（关键类/函数签名）
3. 我们具体要吸收的设计点
4. 参考的代码路径（GitHub 仓库中的文件路径）

- [ ] **Step 2: 研究 Top 5 观察项目**

对 Ollama/Haystack/TGI/BentoML/MLX，搜集 Stars 和一句话特色。

- [ ] **Step 3: 撰写文档 — 一、问题定义**

```markdown
# LLM 接入工程（LLM Integration Engineering）

## 一、问题定义

Agent 需要一个统一的 LLM 调用层，解决以下问题：
- 模型供应商 API 碎片化（OpenAI/Anthropic/Google/本地部署各不同）
- 推理深度控制（简单任务 vs 复杂推理需要不同参数配置）
- 思考模式管理（何时开启/关闭/保持扩展思考）
- 流式输出与 token 计数的统一抽象
- 工具调用格式的归一化

### 业界现状与痛点
（概述：各框架的 LLM 抽象层差异，为什么 litellm 是最佳基座）
```

- [ ] **Step 4: 撰写文档 — 二、设计方案**

包含：
- LLMClient 架构图（ASCII Art）
- ThinkingMode 三模式设计（OFF/INTERLEAVED/PRESERVED）+ 切换逻辑
- InferenceConfig 成本感知调参策略（按任务复杂度调 temperature/max_tokens/thinking_budget）
- 流式输出 AsyncIterator 接口
- token 计数（输入/输出/思考 token 分别计数）
- 工具调用格式归一化（OpenAI function calling schema → litellm 统一处理）
- Protocol/ABC 伪代码：LLMClient 接口定义

- [ ] **Step 5: 撰写文档 — 三、Top 10 参考项目**

填入研究结果的完整表格（Stars 用最新数据）。对深入项目各写 3-5 行分析。

- [ ] **Step 6: 撰写文档 — 四、吸收内化方案**

按深入项目逐个说明：
- litellm → LLMClient 的 provider 归一化、异步调用、模型别名
- LangChain → 回调钩子设计（on_llm_start/end/error）、缓存层
- LlamaIndex → 结构化输出 Pydantic 集成、指数退避重试
- vLLM → 本地部署时的 AsyncEngine 对接模式
- SGLang → RadixAttention 前缀缓存策略启发

- [ ] **Step 7: 撰写文档 — 五、与 Harness 组件映射**

```markdown
## 五、与 Harness 组件映射

| 组件 | 文件路径 | 接口 |
|------|---------|------|
| LLMClient | `omniharness/core/llm.py` | `chat(messages, tools, config) -> LLMResponse` |
| ThinkingMode | `omniharness/core/llm.py` | Enum: OFF/INTERLEAVED/PRESERVED |
| InferenceConfig | `omniharness/core/llm.py` | @dataclass(frozen=True) |
| Message/ToolCall/LLMResponse | `omniharness/core/messages.py` | 已完成 |

### 接口定义（伪代码）
（LLMClient Protocol 完整定义：chat/chat_stream/count_tokens）

### 性能约束
- 首 token 延迟 < 500ms（本地模型）/ < 2s（云端 API）
- 流式输出 token-by-token，不缓冲
- 并发请求：支持 asyncio 并发多个 chat 调用
```

- [ ] **Step 8: 撰写文档 — 六、验证标准**

```markdown
## 六、验证标准

### 单元测试
- LLMClient.chat() mock 测试：验证消息格式转换、tool schema 传递
- ThinkingMode 切换：三种模式分别调用时参数正确
- InferenceConfig 参数合规性校验

### 集成测试
- litellm + OpenAI API：端到端调用返回 LLMResponse
- litellm + 本地 Ollama：本地模型调用成功
- 流式输出：AsyncIterator 能逐 token 产出

### 端到端验证
- `python -m omniharness "What is 2+2?"` → LLMClient 调用模型 → 返回正确答案
```

- [ ] **Step 9: Commit**

```bash
git add docs/engineering/01-llm-integration.md
git commit -m "docs: add LLM integration engineering spec with Top 10 project analysis"
```

---

### Task 4: 扩充 02-context.md — 上下文工程

**Files:**
- Modify: `docs/engineering/02-context.md` (迁移自 context-engineering.md，151 行已有内容)

**前置研究:**
- Web 搜索深入项目（LangChain/LlamaIndex/DSPy/Semantic Kernel/Instructor）获取 Stars 和上下文管理相关设计
- 现有 151 行已覆盖：9 层关系、压缩设计、7 项职责、预算分配，需补充：Top 10 项目、吸收方案、组件映射、验证标准

- [ ] **Step 1: 研究 Top 5 深入项目的上下文管理设计**

对每个项目搜集其上下文/prompt 管理的核心设计：
- LangChain: ChatPromptTemplate、MessagesPlaceholder、回调链
- LlamaIndex: ContextWindow、SentenceSplitter、ResponseSynthesizer
- DSPy: Signature、Module 编程范式、自动 prompt 优化
- Semantic Kernel: KernelFunction、PromptTemplate、TemplateEngine
- Instructor: 结构化输出、Retry with patch、validation

- [ ] **Step 2: 重构现有内容为统一结构**

将现有 151 行内容重新组织到统一 6 节结构中：
- 现有"9 层与上下文的关系" → 移入"一、问题定义"
- 现有"上下文压缩" → 移入"二、设计方案"
- 现有"7 项职责" → 移入"二、设计方案"
- 现有"实现状态" → 移入"五、与 Harness 组件映射"

- [ ] **Step 3: 补充缺失节**

新增：
- "三、Top 10 参考项目" — 完整表格 + 深入项目分析
- "四、吸收内化方案" — 逐项目说明吸收点
- 扩充"五、与 Harness 组件映射" — 加入接口定义伪代码、性能约束
- 新增"六、验证标准" — 测试要点

- [ ] **Step 4: 补充设计方案中缺失的接口定义**

在"二、设计方案"中增加：
- ContextManager Protocol 伪代码
- SystemPromptBuilder 接口
- TokenBudgetAllocator 策略
- 数据流图（上下文组装流水线）

- [ ] **Step 5: Commit**

```bash
git add docs/engineering/02-context.md
git commit -m "docs: expand context engineering spec with Top 10 projects and unified structure"
```

---

### Task 5: 重写 03-memory.md — 记忆工程

**Files:**
- Rewrite: `docs/engineering/03-memory.md` (当前仅 18 行空壳)

**前置研究:**
- Web 搜索深入项目获取最新信息：
  - Mem0: GitHub Stars、自适应记忆层设计、API（add/search/get_all）
  - Graphiti: 时序知识图谱设计、Episode → KG 转换机制
  - Letta (MemGPT): 虚拟上下文管理、分页记忆、Block 系统
  - LangMem: 长期记忆 API、LangGraph 集成方式
  - Cognee: 知识图谱 + 向量混合检索设计
- 读取 `docs/research/model-architecture-insights.md` 中 OmniMem 4 层设计和 UI-TARS-2/GLM-5.1 分层记忆启发

- [ ] **Step 1: 研究 Top 5 深入项目**

搜集每个项目的：
1. GitHub Stars
2. 记忆存储架构（向量/KG/混合）
3. 记忆管理 API（增/删/查/更新）
4. 独特设计（Mem0 的自适应、Graphiti 的时序 KG、Letta 的分页等）
5. 参考代码路径

- [ ] **Step 2: 撰写完整文档**

按统一 6 节结构从头撰写完整文档：

**一、问题定义**：
- Agent 为什么需要记忆？（跨会话持续性、经验积累、个性化）
- 记忆的核心挑战（存储效率、检索精度、淘汰策略、反思机制）
- 业界现状（大多数框架只有会话内记忆，缺乏真正的长期记忆和知识图谱）

**二、设计方案**：
- OmniMem 4 层架构图（Working/Episodic/Semantic/Skill）
- 每层的存储格式、容量、淘汰策略
- Working Memory: keep-recent-k（GLM-5.1 启发），完整保留最近 k 轮
- Episodic Memory: LLM 驱动摘要压缩，Discard-all at threshold
- Semantic Memory: 向量索引 + KG 三元组，跨会话持久化
- Skill Memory: 成功轨迹模板化（为自进化准备）
- 混合检索策略（向量相似度 × 时间衰减 × 层级权重 × 任务相关性）
- Reflector 自动反思流程图
- MemoryStore ABC + SQLiteMemoryStore 接口
- 配置项设计（k 值、压缩阈值、向量维度、KG 后端等）

**三、Top 10 参考项目**：完整表格

**四、吸收内化方案**：
- Mem0 → OmniMem 的自适应记忆层（用户级/Agent 级/会话级三层）
- Graphiti → Semantic Memory 的 KG 构建（Episode → Entity → Relation 流水线）
- Letta → Working Memory 的分页管理（Block 系统 + 虚拟上下文）
- LangMem → 与 LangGraph 状态图的记忆集成方式
- Cognee → 混合检索（向量 + KG 联合查询）

**五、与 Harness 组件映射**：
- OmniMem 类结构、MemoryStore Protocol、Reflector 接口
- 性能约束（检索延迟 < 100ms、单会话存储 < 50MB）

**六、验证标准**

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/03-memory.md
git commit -m "docs: add comprehensive memory engineering spec with 4-tier OmniMem design"
```

---

### Task 6: 重写 04-planning.md — 规划工程

**Files:**
- Rewrite: `docs/engineering/04-planning.md` (当前仅 18 行空壳)

**前置研究:**
- Web 搜索深入项目：
  - LangGraph: 状态机 API、条件路由、检查点、中断机制
  - DSPy: Signature/Module/Optimizer 编程范式
  - OpenAI Agents SDK: Handoff 机制、Runner 循环、Guardrails
  - Pydantic AI: Agent 循环、依赖注入、结构化结果
  - AutoGen: ConversableAgent、GroupChat、代码执行器

- [ ] **Step 1: 研究 Top 5 深入项目**

搜集每个项目的：
1. GitHub Stars
2. Agent 循环核心设计（状态机/对话/编译器）
3. 规划策略（ReAct/PlanAndExecute/自定义）
4. 意图识别/任务分解方式
5. 参考代码路径

- [ ] **Step 2: 撰写完整文档**

**一、问题定义**：
- 规划的核心问题（意图识别、任务分解、策略选择、动态修正、终止判断）
- 业界现状（大多数框架只有 ReAct 循环，缺乏动态重规划和意图分类）

**二、设计方案**：
- 意图识别 4 分类（简单问答/单步工具/多步任务/澄清请求）+ 分类策略
- 任务分解 DAG 设计（节点=子任务、边=依赖、属性=优先级/预估步数）
- 推理策略切换器：ReAct（默认 90%）/ PlanAndExecute / CoT / 手动指定
- 动态重规划：偏差检测（预期 vs 实际输出比对）→ 方案修正 → 回退到检查点
- 终止条件矩阵（成功判定/最大步数/死循环检测/用户中断/资源耗尽）
- AgentState 状态机与 LangGraph 节点映射
- _node_plan 和 _node_decide 的决策逻辑

**三至六**：同上结构

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/04-planning.md
git commit -m "docs: add planning engineering spec with intent recognition and strategy switching"
```

---

### Task 7: 扩充 05-tool.md — 工具工程

**Files:**
- Modify: `docs/engineering/05-tool.md` (迁移自 tool-engineering.md，613 行)

**前置研究:**
- Web 搜索深入项目：
  - MCP SDK: 最新协议版本、客户端 API、stdio/SSE 传输
  - browser-use: 浏览器自动化 API、视觉+DOM 混合策略
  - Playwright: Python API、Page/Locator 设计
  - Crawl4AI: 异步爬取设计、LLM 友好输出格式
  - Stagehand: AI 原生操作 API

**说明:** 现有 613 行已非常详细（6 维度、浏览器方案、SessionManager 等），主要补充统一结构中缺失的节。

- [ ] **Step 1: 分析现有内容覆盖情况**

读取完整 05-tool.md（迁移后），标记哪些节已有、哪些缺失：
- 一、问题定义 → 已有（6 维度）
- 二、设计方案 → 已有（浏览器方案、MCP、调用方式），需补充 4 类混合动作空间完整设计
- 三、Top 10 参考项目 → 缺失
- 四、吸收内化方案 → 缺失
- 五、与 Harness 组件映射 → 部分有
- 六、验证标准 → 缺失

- [ ] **Step 2: 研究 Top 5 深入项目**

- [ ] **Step 3: 补充缺失节（三/四/六），扩充现有节（二/五）**

在文档末尾按统一结构追加缺失的节，在现有节中插入补充内容：
- 在"二、设计方案"中增加：Tool Protocol 伪代码、ToolRegistry 接口、4 类混合动作空间完整定义（MAI-UI/UI-TARS-2 启发）
- 新增"三、Top 10 参考项目"完整表格
- 新增"四、吸收内化方案"
- 扩充"五、与 Harness 组件映射"加入接口伪代码
- 新增"六、验证标准"

- [ ] **Step 4: Commit**

```bash
git add docs/engineering/05-tool.md
git commit -m "docs: expand tool engineering spec with Top 10 projects and unified structure"
```

---

### Task 8: 扩充 06-multi-agent.md — 多 Agent 工程

**Files:**
- Modify: `docs/engineering/06-multi-agent.md` (迁移自 multi-agent-engineering.md，121 行)

**前置研究:**
- Web 搜索深入项目：
  - AutoGen: ConversableAgent API、GroupChat 设计、代码执行器
  - CrewAI: Agent/Task/Crew/Flow 设计、角色定义
  - LangGraph: Multi-agent 编排、Command 模式、Handoff
  - OpenAI Agents SDK: Swarm 模式、Agent Handoff、RunContext
  - MetaGPT: SOP 驱动、Role/Action/Environment 设计

**说明:** 现有 121 行已有编排模式、SubAgent、3 级通信、A2A 协议的框架，需要按统一结构重组并大幅扩充。

- [ ] **Step 1: 重组现有内容到统一结构**

- 现有"编排模式" → "二、设计方案"
- 现有"SubAgent" → "二、设计方案"
- 现有"通信架构" → "二、设计方案"
- 现有"A2A 协议" → "二、设计方案"（子节）
- 现有"对应 Harness 组件" → "五、与 Harness 组件映射"

- [ ] **Step 2: 研究 Top 5 深入项目**

- [ ] **Step 3: 补充所有缺失节 + 扩充设计方案**

新增：
- "一、问题定义" — 为什么需要多 Agent、单 Agent 的瓶颈
- "三、Top 10 参考项目"
- "四、吸收内化方案"
- "六、验证标准"

扩充设计方案：
- Supervisor-Worker 完整流程图
- SubAgent spawn/monitor/collect Protocol 伪代码
- 结果聚合策略（投票/加权/LLM 综合）的具体设计
- 死锁检测与超时机制

- [ ] **Step 4: Commit**

```bash
git add docs/engineering/06-multi-agent.md
git commit -m "docs: expand multi-agent engineering spec with Top 10 projects and orchestration design"
```

---

### Task 9: 撰写 07-safety-guardrails.md — 安全护栏工程

**Files:**
- Create: `docs/engineering/07-safety-guardrails.md`

**前置研究:**
- Web 搜索深入项目：
  - Guardrails AI: Guard 类设计、Validator 接口、结构化验证
  - NeMo Guardrails: Colang 语言、对话流控制、Rails 定义
  - LLM Guard: Scanner 接口、输入/输出检测器种类
  - Lakera Guard: prompt injection 检测 API 和分类方法
  - Presidio: Analyzer/Anonymizer 设计、实体识别器
- 读取 `docs/research/model-architecture-insights.md` 中 DeepSeek V3.2 验证机制设计

- [ ] **Step 1: 研究 Top 5 深入项目**

- [ ] **Step 2: 撰写完整文档**

**一、问题定义**：
- Agent 安全风险分类（prompt injection、有害输出、权限滥用、数据泄露、工具误用）
- 业界现状（大多数框架安全是后补的，缺乏步骤级和元验证）

**二、设计方案**：
- 4 层验证架构图（输入验证 → 步骤验证 → 输出验证 → 元验证）
- 输入验证：injection 检测器链（规则 + ML 模型 + LLM 判断三级）
- 步骤验证（DeepSeek 启发）：每次工具调用后 LLM 评估"结果是否符合预期"
- 输出验证：安全检查 + PII 脱敏 + 格式校验
- 元验证：验证过程本身的正确性（避免验证器被绕过）
- 权限分级设计（AUTO/DEFAULT/STRICT）
- Hooks 系统（PreToolUse/PostToolUse/Stop）触发和处理流程
- Verifier Protocol 伪代码
- PermissionManager 决策树

**三至六**：同上结构

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/07-safety-guardrails.md
git commit -m "docs: add safety guardrails engineering spec with 4-layer verification design"
```

---

### Task 10: 撰写 08-observability.md — 可观测性工程

**Files:**
- Create: `docs/engineering/08-observability.md`

**前置研究:**
- Web 搜索深入项目：
  - Langfuse: Trace/Span/Generation/Score API、SDK 集成方式
  - OpenLLMetry: OTel Instrumentor 设计、自动埋点
  - Arize Phoenix: 评估框架、Trace 可视化
  - LangSmith: RunTree 设计、数据集管理、回放
  - AgentOps: Session/Event 模型、Agent 专用指标

- [ ] **Step 1: 研究 Top 5 深入项目**

- [ ] **Step 2: 撰写完整文档**

**一、问题定义**：
- Agent 可观测性的独特挑战（多步推理追踪、工具链路、LLM 调用成本、调试回放）
- 与传统应用可观测性的区别（Trace 粒度、指标种类、日志结构）

**二、设计方案**：
- OpenTelemetry 集成架构图（Agent → Spans → Exporter → 后端）
- Span 层级设计：Session Span → Turn Span → Node Span → LLM/Tool Span
- 指标体系：token 用量（输入/输出/思考分别）、延迟（首token/完成）、工具成功率、成本估算、步数统计
- 结构化 JSON 日志格式定义
- 调试回放设计：完整轨迹存储 + 时间线可视化 + 单步重放
- Exporter 适配层（Langfuse/Jaeger/Prometheus/自定义）
- Tracer/Metrics/Logger Protocol 伪代码

**三至六**：同上结构

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/08-observability.md
git commit -m "docs: add observability engineering spec with OTel integration design"
```

---

### Task 11: 撰写 09-deployment-runtime.md — 部署运行时工程

**Files:**
- Create: `docs/engineering/09-deployment-runtime.md`

**前置研究:**
- Web 搜索深入项目：
  - E2B: Sandbox API 设计、代码执行接口、文件系统操作
  - Modal: Function/Image/Volume 抽象、GPU 调度
  - Daytona: Workspace 设计、Dev Container 集成
  - Docker SDK (Python): Container/Image API、异步操作
  - Fly.io Machines: Machine API、快速启停

- [ ] **Step 1: 研究 Top 5 深入项目**

- [ ] **Step 2: 撰写完整文档**

**一、问题定义**：
- Agent 代码执行的安全隔离需求
- 本地开发 vs 生产部署的不同约束
- CLI 交互设计的用户体验

**二、设计方案**：
- 沙箱架构图（DockerSandbox ← SandboxProtocol → LocalSandbox）
- DockerSandbox 设计：镜像管理、容器生命周期、文件挂载、网络策略
- LocalSandbox 降级方案：subprocess + 文件系统限制 + 超时
- 安全策略配置：网络隔离级别、文件系统读写范围、CPU/内存限额、执行超时
- 会话管理：SessionManager 设计（创建/恢复/销毁、Cookie 持久化）
- CLI 入口设计：参数解析、配置加载、交互模式 vs 单次模式
- 配置管理：config.yaml 结构 + 环境变量覆盖优先级
- Sandbox/SessionManager Protocol 伪代码

**三至六**：同上结构

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/09-deployment-runtime.md
git commit -m "docs: add deployment runtime engineering spec with sandbox and CLI design"
```

---

### Task 12: 撰写 10-self-evolution.md — 自进化工程

**Files:**
- Create: `docs/engineering/10-self-evolution.md`

**前置研究:**
- Web 搜索深入项目：
  - DSPy: Optimizer/Compiler 设计、Signature/Module 接口、BootstrapFewShot
  - Voyager: Skill Library 设计、Automatic Curriculum、代码生成验证循环
  - OpenHands (OpenDevin): AgentController 设计、沙箱执行、Observation/Action 循环
  - SWE-agent: ACI (Agent-Computer Interface) 设计、搜索/编辑/测试工具链
  - ADAS: Agent 搜索空间定义、元 Agent 自修改机制
- 读取 `docs/research/model-architecture-insights.md` 中 MiniMax M2.7 自进化闭环设计

- [ ] **Step 1: 研究 Top 5 深入项目**

- [ ] **Step 2: 撰写完整文档**

**一、问题定义**：
- 为什么 Agent 需要自进化（静态 scaffold 的局限、任务多样性、持续改进）
- 自进化 vs 手动调优的效率差异
- 业界现状（只有 MiniMax M2.7 和 DSPy 有真正的自动优化）

**二、设计方案**：
- 自进化闭环架构图（MiniMax M2.7 启发）：
  ```
  运行任务 → 记录轨迹 → 分析失败 → 规划修改
       ↑                                    ↓
       └── 决定保留/回滚 ← 评估对比 ← 执行修改
  ```
- TrajectoryStore 设计：记录完整运行轨迹（输入/每步推理/工具调用/输出/成功与否）
- 失败分析器：LLM 驱动的失败模式分类（工具选择错误/推理偏差/信息不足/策略不当）
- Scaffold 自修改范围：系统提示调整 / 工具配置修改 / 推理策略切换 / 工作流重构
- 技能自创：成功轨迹 → 参数化模板 → Skill Memory 存储 → 未来任务复用
- A/B 评估框架：同一任务集修改前后对比，统计成功率/步数/token 消耗
- 安全约束：修改范围白名单、回滚机制、人类审批门槛
- 上游监控缝合：sync-upstreams.py 检测更新 → Claude 分析 diff → 生成融合补丁 → 评估 → 合并
- SelfEvolution/TrajectoryStore/SkillManager Protocol 伪代码

**三至六**：同上结构

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/10-self-evolution.md
git commit -m "docs: add self-evolution engineering spec with trajectory analysis and skill creation"
```

---

### Task 13: 撰写融合索引 (fusion-index.md)

**Files:**
- Create: `docs/architecture/fusion-index.md`

**前置依赖:** Task 3-12 完成后，汇总所有领域的 Top 10 项目和功能点。

- [ ] **Step 1: 汇总所有领域的研究成果**

从 10 个工程文档中提取每个领域的 Top 10 项目和具体吸收的功能点。

- [ ] **Step 2: 撰写融合索引**

```markdown
# 融合索引（Fusion Index）

> 标注每个功能的来源项目、commit、相关代码路径，
> 便于上游更新时同步跟进。
>
> 最近更新：2026-04-13

## 索引说明

- 状态：📋 规划中 | 🔄 吸收中 | ✅ 已内化 | 👀 观察中
- 深度：深入（前 3-5）| 观察（后 5-7）
- 版本/Commit 记录参考时的具体版本，用于上游更新时做 diff 对比

## 统计概览

| 领域 | 深入项目 | 观察项目 | 功能点总数 | 已内化 | 进行中 |
|------|---------|---------|-----------|--------|--------|
| 01 LLM 接入 | 5 | 5 | N | 0 | 0 |
| ... | ... | ... | ... | ... | ... |
| **合计** | **~50** | **~50** | **~N** | **0** | **0** |

## 01 — LLM 接入
| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
（从 01-llm-integration.md 的研究成果填入）

## 02 — 上下文
（从 02-context.md 填入）

...

## 10 — 自进化
（从 10-self-evolution.md 填入）
```

- [ ] **Step 3: 验证索引完整性**

检查：
- 10 个领域都有对应章节
- 每个领域的深入项目都有至少 3 个功能点
- 所有状态标注正确（首次创建应全部为 📋 规划中）
- 统计概览数据与各章节一致

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/fusion-index.md
git commit -m "docs: add fusion index tracking 100 upstream projects across 10 engineering domains"
```

---

### Task 14: 最终验证与 CLAUDE.md 更新

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 全局完整性检查**

```bash
# 检查所有文件存在
ls -la docs/architecture/overview.md docs/architecture/fusion-index.md
ls -la docs/engineering/0{1..9}-*.md docs/engineering/10-*.md
ls -la docs/research/model-architecture-insights.md
ls -la docs/implementation-plan.md

# 检查旧文件已清理
ls docs/context-engineering.md docs/tool-engineering.md docs/memory-engineering.md docs/planning-engineering.md docs/multi-agent-engineering.md 2>&1 | grep "No such file"
```

- [ ] **Step 2: 检查所有文档内部链接**

验证 overview.md 中的 10 个工程文档链接、fusion-index.md 链接、各文档之间的交叉引用都指向正确路径。

- [ ] **Step 3: 确认 CLAUDE.md 目录结构已更新**

读取 CLAUDE.md 确认 Directory Structure 章节反映新的目录布局。

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "docs: complete 10-domain engineering doc system with architecture overview and fusion index"
```
