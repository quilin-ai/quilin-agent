# OmniAgent-Harness 工程文档体系设计规格

> 日期：2026-04-13
> 状态：设计完成，待实施

## 一、背景与目标

OmniAgent-Harness 的核心理念是**融合全球最强 Agent 开源项目精华**。当前 `docs/` 下有 5 个工程文档（其中 2 个仅为空壳），缺乏统一结构，且未系统性地参考业界最强开源项目。

**目标**：
1. 将工程文档从 5 个扩充到 **10 个领域**，覆盖完整 Agent 所需的所有工程能力
2. 每个文档达到 **B 级详细工程规格**（接口定义、数据流、配置项、性能约束）
3. 每个领域参考 **Top 10 开源项目**（前 3-5 深入分析，后 5-7 纳入观察）
4. 建立**融合索引**，标注每个功能的来源项目/commit/代码路径，支撑上游监控自动更新

## 二、目录结构（方案 B：按架构分层）

```
docs/
├── architecture/
│   ├── overview.md                    # 架构总览（10 领域全景图 + 导航）
│   └── fusion-index.md                # 融合索引（按领域分组，逐功能标注来源）
├── engineering/
│   ├── 01-llm-integration.md          # LLM 接入工程
│   ├── 02-context.md                  # 上下文工程
│   ├── 03-memory.md                   # 记忆工程
│   ├── 04-planning.md                 # 规划工程
│   ├── 05-tool.md                     # 工具工程
│   ├── 06-multi-agent.md              # 多 Agent 工程
│   ├── 07-safety-guardrails.md        # 安全护栏工程
│   ├── 08-observability.md            # 可观测性工程
│   ├── 09-deployment-runtime.md       # 部署运行时工程
│   └── 10-self-evolution.md           # 自进化工程
├── research/
│   └── model-architecture-insights.md # 6 模型设计参考（已有）
└── implementation-plan.md             # 8 Phase 实施计划（已有）
```

## 三、文件迁移方案

| 当前路径 | 目标路径 | 动作 |
|---------|---------|------|
| `docs/context-engineering.md` (151行) | `docs/engineering/02-context.md` | 迁移 + 按统一结构扩充 |
| `docs/tool-engineering.md` (613行) | `docs/engineering/05-tool.md` | 迁移 + 按统一结构补充缺失节 |
| `docs/memory-engineering.md` (18行) | `docs/engineering/03-memory.md` | 迁移 + 全部重写 |
| `docs/planning-engineering.md` (18行) | `docs/engineering/04-planning.md` | 迁移 + 全部重写 |
| `docs/multi-agent-engineering.md` (121行) | `docs/engineering/06-multi-agent.md` | 迁移 + 大幅扩充 |
| `docs/model-architecture-insights.md` (352行) | `docs/research/model-architecture-insights.md` | 仅迁移 |
| `docs/implementation-plan.md` (363行) | `docs/implementation-plan.md` | 保留原位 |
| — | `docs/architecture/overview.md` | 新建 |
| — | `docs/architecture/fusion-index.md` | 新建 |
| — | `docs/engineering/01-llm-integration.md` | 新建 |
| — | `docs/engineering/07-safety-guardrails.md` | 新建 |
| — | `docs/engineering/08-observability.md` | 新建 |
| — | `docs/engineering/09-deployment-runtime.md` | 新建 |
| — | `docs/engineering/10-self-evolution.md` | 新建 |

迁移后删除原文件，更新 `CLAUDE.md` 中的目录结构说明。

## 四、工程文档统一结构模板

每个 `engineering/*.md` 遵循以下结构：

```markdown
# {领域名称}工程（{English Name} Engineering）

## 一、问题定义
- 这个领域要解决什么核心问题
- 业界现状与痛点

## 二、设计方案
- 架构设计（含 ASCII 图）
- 核心接口定义（Protocol/ABC 伪代码）
- 数据流与交互流程
- 配置项设计

## 三、Top 10 参考项目
| # | 项目 | Stars | 吸收点 | 深度 |
|---|------|-------|--------|------|
| 1 | xxx  | xxxk  | xxx    | 深入 |
| ...| ... | ...   | ...    | 观察 |

前 3-5 个标注"深入"——详细分析其设计并说明如何内化
后 5-7 个标注"观察"——简述特色，纳入上游监控池

## 四、吸收内化方案
- 从每个"深入"项目具体吸收什么
- 如何融合到 Harness 组件中
- 与其他领域的交互点

## 五、与 Harness 组件映射
- 对应的类/模块/文件
- 接口定义（输入/输出/错误处理）
- 性能约束与边界条件

## 六、验证标准
- 单元测试要点
- 集成测试场景
- 端到端验证方法
```

## 五、10 个工程领域定义

### 领域职责与组件映射

| # | 领域 | 核心职责 | Harness 组件 |
|---|------|---------|-------------|
| 01 | LLM 接入 | 单一模型封装、litellm 统一接口、ThinkingMode 三模式、InferenceConfig 成本感知调参、流式输出、token 计数 | `LLMClient`, `ThinkingMode`, `InferenceConfig` |
| 02 | 上下文 | 系统提示组装、上下文生命周期（收集→排序→压缩→注入）、动态 prompt 模板、token 预算分配 | `ContextManager`, `SystemPrompt` |
| 03 | 记忆 | 4 层分级存储（Working/Episodic/Semantic/Skill）、向量检索 + KG、记忆压缩淘汰、自动反思、项目记忆持久化 | `OmniMem`, `MemoryStore`, `Reflector` |
| 04 | 规划 | 意图识别、任务分解（DAG）、推理策略（ReAct/PlanAndExecute/CoT）、动态重规划、终止条件判断 | `AgentState`, `_node_plan`, `_node_decide` |
| 05 | 工具 | 4 类混合动作空间、Tool 注册/发现/调用、MCP 客户端、内置工具集、浏览器方案、工具自创 | `ToolRouter`, `ToolRegistry`, `MCPClient` |
| 06 | 多 Agent | 编排模式（顺序/并行/层级/辩论）、SubAgent 生命周期、3 级通信、A2A 协议 | `Supervisor`, `Agent`, `LifecycleManager` |
| 07 | 安全护栏 | 输入验证、输出审查、步骤验证 + 元验证、权限分级（AUTO/DEFAULT/STRICT）、Hooks | `Verifier`, `PermissionManager`, `HookRunner` |
| 08 | 可观测性 | OpenTelemetry 追踪、指标收集（token/延迟/成本/成功率）、结构化日志、调试回放 | `Tracer`, `Metrics`, `Logger` |
| 09 | 部署运行时 | Docker 沙箱 + 本地降级、安全策略、会话管理、CLI 入口、配置管理 | `Sandbox`, `SessionManager`, `CLI` |
| 10 | 自进化 | 轨迹记录、失败分析、scaffold 自修改、技能自创、评估对比、上游监控缝合 | `SelfEvolution`, `TrajectoryStore`, `SkillManager` |

### 领域间依赖关系

```
01-LLM ──→ 02-Context ──→ 04-Planning ──→ 05-Tool
                │                              │
                └──→ 03-Memory                 └──→ 06-MultiAgent
                                                      │
07-Safety ← 横切所有领域（验证层）                        │
08-Observability ← 横切所有领域（追踪层）                  │
09-Deployment ← 运行时基础设施                           │
10-SelfEvolution ←── 依赖 01-06 全部 ──────────────────┘
```

## 六、各领域内容大纲

### 01-llm-integration.md — LLM 接入工程

**核心设计**：
- LLMClient 单一封装（`litellm.acompletion`）
- ThinkingMode 三模式（OFF/INTERLEAVED/PRESERVED，GLM-5.1 启发）
- InferenceConfig 成本感知调参（同一模型按任务复杂度调 temperature/max_tokens，MAI-UI 启发）
- 流式输出（`chat_stream`）+ token 计数
- 工具调用格式归一化（OpenAI function calling schema）

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | litellm | 统一模型接口、provider 归一化 | 深入 |
| 2 | LangChain LLM | 回调系统、缓存策略 | 深入 |
| 3 | LlamaIndex LLM | 结构化输出、重试策略 | 深入 |
| 4 | vLLM | 高性能推理、PagedAttention | 深入 |
| 5 | SGLang | 前端语言、RadixAttention | 深入 |
| 6 | Ollama | 本地推理、模型管理 | 观察 |
| 7 | Haystack | Pipeline 式调用 | 观察 |
| 8 | TGI | 生产部署推理 | 观察 |
| 9 | BentoML | 模型服务化 | 观察 |
| 10 | MLX | Apple 芯片优化推理 | 观察 |

### 02-context.md — 上下文工程

**核心设计**：
- 上下文生命周期：收集 → 排序 → 压缩 → 注入
- 系统提示动态组装（角色 + 工具描述 + 记忆摘要 + 约束）
- Token 预算分配策略（系统提示 / 记忆 / 工具结果 / 用户对话各占多少）
- 上下文窗口压缩（超限时的裁剪策略）

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | LangChain | 消息模型、prompt 模板、回调链 | 深入 |
| 2 | LlamaIndex | 上下文压缩、检索增强组装 | 深入 |
| 3 | DSPy | 签名式 prompt 编程 | 深入 |
| 4 | Semantic Kernel | 内核函数 + prompt 编排 | 深入 |
| 5 | Instructor | 结构化输出、重试 + 修正 | 深入 |
| 6 | Haystack | Pipeline 式上下文组装 | 观察 |
| 7 | AutoGen | 多角色 prompt 管理 | 观察 |
| 8 | CrewAI | 角色 + 任务 prompt 模板 | 观察 |
| 9 | Pydantic AI | 类型安全 prompt | 观察 |
| 10 | Guidance | 约束解码、模板控制 | 观察 |

### 03-memory.md — 记忆工程

**核心设计**：
- 4 层分级：Working（keep-recent-k）/ Episodic（LLM 摘要压缩）/ Semantic（向量+KG）/ Skill（技能模板）
- 混合检索：向量相似度 + 时间衰减 + 层级权重
- 记忆淘汰：LRU + 重要性评分 + 容量阈值
- 自动反思（Reflector）：从经验提炼模式，写入 Semantic 层
- 项目记忆：MEMORY.md 持久化

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | Mem0 | 自适应记忆层、用户/Agent/会话三级 | 深入 |
| 2 | Graphiti | 时序知识图谱、episode → KG | 深入 |
| 3 | Letta (MemGPT) | 虚拟上下文管理、分页记忆 | 深入 |
| 4 | LangMem | 长期记忆管理、LangGraph 集成 | 深入 |
| 5 | Cognee | 知识图谱 + 向量混合检索 | 深入 |
| 6 | Hindsight | 反思驱动记忆、经验提炼 | 观察 |
| 7 | Zep | 会话记忆 + 事实提取 | 观察 |
| 8 | MemPalace | 空间记忆隐喻 | 观察 |
| 9 | SuperMemory | 浏览器记忆扩展 | 观察 |
| 10 | AgentMemory | 轻量级 Agent 记忆 | 观察 |

### 04-planning.md — 规划工程

**核心设计**：
- 意图识别：用户输入 → 分类（简单问答 / 单步工具 / 多步任务 / 澄清请求）
- 任务分解：复杂目标 → 子任务 DAG
- 推理策略切换：ReAct（默认 90%）/ PlanAndExecute / CoT
- 动态重规划：执行偏差检测 → 方案修正
- 终止条件：成功判定 / 最大步数 / 死循环检测 / 用户中断

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | LangGraph | 状态机编排、条件路由、检查点 | 深入 |
| 2 | DSPy | 自动 prompt 优化、签名编程 | 深入 |
| 3 | OpenAI Agents SDK | Handoff 机制、Guardrails 集成 | 深入 |
| 4 | Pydantic AI | 类型安全 Agent 循环、依赖注入 | 深入 |
| 5 | AutoGen | 多轮对话规划、代码执行循环 | 深入 |
| 6 | CrewAI | 角色+任务+流程编排 | 观察 |
| 7 | Semantic Kernel | Planner + Stepwise | 观察 |
| 8 | LATS | 蒙特卡洛树搜索规划 | 观察 |
| 9 | HuggingGPT | 模型选择即规划 | 观察 |
| 10 | MetaGPT | SOP 驱动规划 | 观察 |

### 05-tool.md — 工具工程

**核心设计**：
- 4 类混合动作空间（程序化 / 交互 / 控制 / GUI）
- Tool 基类 + ToolRegistry 注册发现
- 内置工具：file_read/write/edit、bash、glob、grep、web_search/fetch
- MCP 客户端：连接外部 MCP Server，自动注册发现的工具
- 工具自创：Agent 运行时生成新工具并注册
- 浏览器 5 种方案 + SessionManager + Zoom-In 两段式定位

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | MCP SDK | 标准工具协议、客户端/服务器 | 深入 |
| 2 | browser-use | 浏览器自动化、视觉+DOM 混合 | 深入 |
| 3 | Playwright | 底层浏览器引擎 | 深入 |
| 4 | Crawl4AI | 异步爬取、LLM 友好输出 | 深入 |
| 5 | Stagehand | AI 原生浏览器操作 | 深入 |
| 6 | Firecrawl | 网页 → 结构化数据 | 观察 |
| 7 | ComputerUse (Anthropic) | 屏幕级操作 | 观察 |
| 8 | Exa | 语义搜索 API | 观察 |
| 9 | Tavily | Agent 优化搜索 | 观察 |
| 10 | SerpAPI | 搜索引擎结构化 | 观察 |

### 06-multi-agent.md — 多 Agent 工程

**核心设计**：
- 编排模式：顺序 / 并行 / 层级（Supervisor-Worker）/ 辩论 / 动态
- SubAgent 生命周期：spawn → monitor → collect → terminate
- 3 级通信：本机（IPC）/ 内网（gRPC）/ 网络（HTTPS）
- A2A 协议：Agent Card 发布 + 跨实例任务分发
- 结果聚合：投票 / 加权合并 / LLM 综合

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | AutoGen | 多 Agent 对话、代码执行 | 深入 |
| 2 | CrewAI | 角色分工、任务委托 | 深入 |
| 3 | LangGraph | 多 Agent 状态图 | 深入 |
| 4 | OpenAI Agents SDK | Swarm 模式、Handoff | 深入 |
| 5 | MetaGPT | SOP 驱动多 Agent | 深入 |
| 6 | Microsoft Magentic-One | 通用多 Agent 编排 | 观察 |
| 7 | Google A2A | Agent 间标准协议 | 观察 |
| 8 | CAMEL | 角色扮演通信 | 观察 |
| 9 | ChatDev | 软件开发多 Agent | 观察 |
| 10 | Agency Swarm | 自定义 Agent 群 | 观察 |

### 07-safety-guardrails.md — 安全护栏工程

**核心设计**：
- 输入验证：prompt injection 检测、有害内容过滤、schema 校验
- 输出审查：安全检查 + 格式校验 + 敏感信息过滤
- 步骤验证（DeepSeek 启发）：每次工具调用后 LLM 验证结果是否符合预期
- 元验证：验证过程本身是否正确
- 权限分级：AUTO / DEFAULT / STRICT
- Hooks：PreToolUse / PostToolUse / Stop

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | Guardrails AI | 结构化验证框架、validators | 深入 |
| 2 | NeMo Guardrails | 对话流控制、Colang 语言 | 深入 |
| 3 | LLM Guard | 输入/输出扫描、多种检测器 | 深入 |
| 4 | Lakera Guard | prompt injection 检测 | 深入 |
| 5 | Presidio | PII 检测与脱敏 | 深入 |
| 6 | Rebuff | 多层 prompt injection 防御 | 观察 |
| 7 | Prompt Guard (Meta) | 开源 injection 分类器 | 观察 |
| 8 | ShieldGemma (Google) | 安全分类模型 | 观察 |
| 9 | LangKit (WhyLabs) | LLM 输出质量监控 | 观察 |
| 10 | Garak | LLM 漏洞扫描器 | 观察 |

### 08-observability.md — 可观测性工程

**核心设计**：
- OpenTelemetry spans：每个 LangGraph 节点 / LLM 调用 / 工具执行
- 指标：token 用量、延迟分布、工具成功率、成本估算
- 结构化 JSON 日志
- 调试回放：完整轨迹可视化
- 导出：Langfuse / Jaeger / Prometheus

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | Langfuse | 开源 LLM 观测平台、trace/score | 深入 |
| 2 | OpenLLMetry | OTel 原生 LLM 追踪 | 深入 |
| 3 | Arize Phoenix | LLM 评估 + 追踪 | 深入 |
| 4 | LangSmith | 调试回放、数据集管理 | 深入 |
| 5 | AgentOps | Agent 专用观测 | 深入 |
| 6 | Helicone | 代理层观测、缓存 | 观察 |
| 7 | Braintrust | 评估 + 日志 | 观察 |
| 8 | Weave (W&B) | 实验追踪 | 观察 |
| 9 | LunaryAI | 开源 LLM 监控 | 观察 |
| 10 | Traceloop | OTel SDK for LLM | 观察 |

### 09-deployment-runtime.md — 部署运行时工程

**核心设计**：
- Docker 沙箱（aiodocker）+ 无 Docker 时降级到 subprocess
- 安全策略：网络隔离、文件系统限制、执行超时、资源配额
- 会话管理：Cookie/Profile 持久化、多会话隔离
- CLI 入口：`python -m omniharness "你的任务"`
- 配置管理：config.yaml + 环境变量覆盖

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | E2B | 云端代码沙箱、SDK 设计 | 深入 |
| 2 | Modal | Serverless 容器、GPU 调度 | 深入 |
| 3 | Daytona | 开发环境即服务 | 深入 |
| 4 | Docker SDK (Python) | 容器管理 API | 深入 |
| 5 | Fly.io Machines | 轻量 VM、快速启动 | 深入 |
| 6 | Firecracker | 微虚拟机 | 观察 |
| 7 | gVisor | 用户态内核沙箱 | 观察 |
| 8 | Kata Containers | 轻量 VM 容器 | 观察 |
| 9 | Nsjail | 进程级沙箱 | 观察 |
| 10 | Seatbelt (macOS) | macOS 沙箱 | 观察 |

### 10-self-evolution.md — 自进化工程

**核心设计**：
- 轨迹记录：完整运行轨迹持久化
- 失败分析：LLM 驱动的失败模式识别
- Scaffold 自修改（MiniMax M2.7 启发）：修改提示词 / 工具配置 / 工作流
- 技能自创：成功轨迹 → 可复用技能模板
- 评估对比：修改前 vs 修改后 A/B 测试
- 上游监控缝合：sync-upstreams.py → Claude 分析 diff → 融合补丁

**Top 10 参考方向**：
| # | 项目 | 吸收点 | 深度 |
|---|------|--------|------|
| 1 | DSPy | 自动 prompt 优化、编译器范式 | 深入 |
| 2 | Voyager (Minecraft) | 技能库 + 自动课程 | 深入 |
| 3 | OpenHands (OpenDevin) | 软件开发 Agent、沙箱执行 | 深入 |
| 4 | SWE-agent | 代码修复 Agent、ACI 设计 | 深入 |
| 5 | ADAS | Agent 自动搜索 + 自修改 | 深入 |
| 6 | AutoGPT Forge | Agent 基准框架 | 观察 |
| 7 | Eureka | LLM 驱动奖励函数生成 | 观察 |
| 8 | Language Agent Tree Search | 蒙特卡洛搜索 | 观察 |
| 9 | AgentTuning | Agent 指令微调 | 观察 |
| 10 | GEPA (Hermes) | 通用自进化协议 | 观察 |

## 七、融合索引设计

文件：`docs/architecture/fusion-index.md`

### 格式

```markdown
# 融合索引（Fusion Index）

> 标注每个功能的来源项目、commit、相关代码路径，
> 便于上游更新时同步跟进。

## 索引说明
- 状态：📋 规划中 | 🔄 吸收中 | ✅ 已内化 | 👀 观察中
- 深度：深入（前 3-5）| 观察（后 5-7）

## 01 — LLM 接入
| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| 统一模型接口 | litellm | v1.40+ | litellm/main.py | 📋 | 深入 |
| ... | ... | ... | ... | ... | ... |

## 02 — 上下文
...
（10 个领域各一节）
```

### 设计要点

1. **每行一个功能点** — 粒度到具体能力
2. **状态流转** — `📋 规划中 → 🔄 吸收中 → ✅ 已内化`
3. **观察项目也纳入** — `👀 观察中`，上游突破时可升级
4. **版本/Commit 锁定** — 上游更新时做 diff 对比
5. **与 `sync-upstreams.py` 联动** — 脚本扫描此文件获取监控目标

## 八、架构总览设计

文件：`docs/architecture/overview.md`

定位为"地图"而非"详细设计"，每个部分点到为止，通过链接导航到具体文档。

### 内容结构

```markdown
# OmniAgent-Harness 架构总览

## 一句话定位
## 架构全景图（ASCII Art：10 领域关系图 + 数据流向）
## 核心设计哲学
## 10 大工程领域导航（表格 + 链接）
## E-T-C-S-L-V 六组件架构
## LangGraph 状态机（8 节点流程图）
## 7 个跨模型设计模式（简表 + 链接到 research/）
## 竞品对比（Claude Code / Codex / Manus / Hermes / OpenClaw vs 我们）
## 8 Phase 实施路线图（链接到 implementation-plan.md）
```

## 九、实施顺序

文档撰写按以下顺序进行（考虑领域依赖关系）：

| 步骤 | 文件 | 说明 |
|------|------|------|
| 1 | `architecture/overview.md` | 全局入口，先建地图 |
| 2 | `engineering/01-llm-integration.md` | 基础层，其他领域依赖 |
| 3 | `engineering/02-context.md` | 迁移 + 扩充现有内容 |
| 4 | `engineering/03-memory.md` | 全部重写（空壳） |
| 5 | `engineering/04-planning.md` | 全部重写（空壳） |
| 6 | `engineering/05-tool.md` | 迁移 + 补充缺失节 |
| 7 | `engineering/06-multi-agent.md` | 迁移 + 大幅扩充 |
| 8 | `engineering/07-safety-guardrails.md` | 新建 |
| 9 | `engineering/08-observability.md` | 新建 |
| 10 | `engineering/09-deployment-runtime.md` | 新建 |
| 11 | `engineering/10-self-evolution.md` | 新建 |
| 12 | `architecture/fusion-index.md` | 汇总所有领域的参考项目 |

每个文档撰写时需要：
1. 研究该领域 Top 10 项目的最新状态（Stars、核心特色、API 设计）
2. 深入分析前 3-5 个项目的架构设计
3. 提炼吸收方案并映射到 Harness 组件
4. 同步更新 fusion-index.md 对应章节

## 十、与现有规划的关系

- **`implementation-plan.md`（8 Phase）**：定义了代码实施顺序，本设计规格定义的是文档体系
- **`model-architecture-insights.md`**：迁移到 `research/` 目录，作为设计参考文档
- **`CLAUDE.md`**：文档体系完成后需更新目录结构说明
- **`config.yaml`**：9 层 Provider 配置与 10 个工程领域的映射关系需在 overview.md 中说明
