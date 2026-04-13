# Quilin Agent 实现规划

## Context

当前骨架只有 1 个 642 行的 Harness.py（接口定义 + 空循环），layers/ 和 plugins/ 全空，0 个测试，0 个实际 Provider。目标是借助开源力量缝合出一个比 OpenClaw、Hermes Agent、Claude Code、Codex、Manus 都要强的 Agent。

---

## 竞品核心能力对照

| 能力 | Claude Code | Codex | Manus | Hermes | OpenClaw | **我们要做到** |
|------|------------|-------|-------|--------|----------|-------------|
| Agent 循环 | ReAct + 扩展思考 | Rust sandbox loop | 多 Agent 图编排 | 学习闭环 | 网关+插件 | **ReAct + Plan&Execute 双模式 + 扩展思考** |
| 工具系统 | 内置 8 种 + MCP | Shell + patch + MCP | Agent 专用工具 | 40+ 工具 + MCP + 技能 | 插件 SDK + MCP | **内置 10+ 种 + MCP 动态发现 + 自创工具** |
| 记忆 | CLAUDE.md + 会话内 | AGENTS.md + 会话内 | 无持久化 | 4 层 + 自进化 | Session + Context | **4 层分级 + 向量检索 + KG + 自反思 + 项目记忆** |
| 浏览器/电脑 | 无（靠 MCP） | 无 | 全浏览器 + Computer Use | 无 | Canvas + A2UI | **5 种浏览器方案 + SessionManager + Computer Use** |
| 沙箱 | 无（仅权限提示） | OS 级隔离（最强） | Docker | Docker/Daytona/Modal | K8s Operator | **Docker 隔离 + 本地轻量沙箱 + 云沙箱可选** |
| 自进化 | 无 | 无 | 无 | DSPy + GEPA（唯一） | 无 | **上游监控 + Claude 智能缝合 + 技能自创** |
| 多 Agent | 并行 Sub-agent | 无 | 多角色专业 Agent | 子 Agent | 多 Agent 路由 | **Supervisor + Worker + 并行 + 辩论 + A2A** |
| 模型锁定 | 仅 Anthropic | 仅 OpenAI | 闭源 | 任意模型 | 任意模型 | **单一模型 + litellm（任意模型可配置）** |

## 我们的独特优势（别人没有的）

1. **融合 6 大模型架构精华** — 系统性研究 MiniMax/GLM/Qwen/MAI-UI/UI-TARS/DeepSeek 的设计方法，内化为 7 个跨模型设计模式
2. **9 层 x Top 10 上游监控 + 自动缝合** — 持续进化，不是一次性开发
3. **4 层分级记忆 + 真正的 KG + 自反思** — 比 Hermes 更系统化
4. **5 种浏览器方案自动路由 + 统一 SessionManager** — 比 Manus 更全面
5. **所有层通过 MCP 协议通信** — 最标准化的架构
6. **内建步骤验证 + 元验证** — 不只过滤输出，还验证每一步推理是否正确

---

## 模型接入策略（单一模型 + litellm）

Agent 接入**单一模型**，通过 litellm 统一接口。以下 6 个模型仅作**设计参考**：

| 模型 | 研究的强项 | 提炼的设计方法 |
|------|-----------|--------------|
| MiniMax M2.7 | 自进化 | Agent 自主修改 scaffold 闭环 |
| GLM-5.1 | 思考模式 | 三种思考模式 + Keep-recent-k |
| Qwen3-VL 235B | 视觉理解 | DeepStack 多层视觉特征融合 |
| MAI-UI 32B | GUI 定位 | Zoom-In 两段式 + Device-Cloud |
| UI-TARS-2 | 移动端自动化 | 分层记忆 + 数据飞轮 |
| DeepSeek V3.2 | 验证机制 | 自验证 + 元验证 |

详细设计参考见 [model-architecture-insights.md](./model-architecture-insights.md)。

### 7 个跨模型设计模式（内化到 Harness）

| # | 设计模式 | 来源 | 融入的 Harness 组件 | Phase |
|---|---------|------|-------------------|-------|
| 1 | 分层记忆 | UI-TARS-2, GLM-5.1 | OmniMem（Working/Episodic + Keep-recent-k） | 3 |
| 2 | 混合动作空间 | MAI-UI, UI-TARS-2 | ToolRouter（4 类动作统一调度） | 1 |
| 3 | 自进化闭环 | MiniMax M2.7 | SelfEvolution（分析失败 -> 修改 scaffold -> 评估） | 7 |
| 4 | 两段式定位 | MAI-UI | BrowserProvider（Zoom-In 视觉模式） | 6 |
| 5 | 成本感知调用 | MAI-UI Device-Cloud | InferenceConfig（同一模型按复杂度调参数） | 0 |
| 6 | 思考模式控制 | GLM-5.1 | ThinkingMode（off/interleaved/preserved） | 0 |
| 7 | 内建验证 | DeepSeek, UI-TARS-2 | Verifier（步骤验证 + 元验证） | 2 |

---

## 分阶段实施计划（单一模型 + 8 Phase）

### Phase 0: LLM 接入层重写 + 最小可运行循环

**目标**：删除多模型路由，建立单一模型 + litellm 接入；跑通端到端 LLM 调用循环。

**关键决策**：
- 只接入**单一模型**，通过 litellm 统一 API
- 思考模式控制（GLM-5.1 启发）和推理深度控制（MAI-UI 启发）在单一模型上实现
- MCPBus 从"万物中枢"降级为仅对接外部 MCP Server，内部组件直接调用

**重写 llm.py**（删除 ~250 行多模型代码，新写 ~120 行）：
```python
class ThinkingMode(Enum):           # <- 模式6: GLM-5.1 启发
    OFF = "off"                     # 简单工具调用
    INTERLEAVED = "interleaved"     # 每步独立思考
    PRESERVED = "preserved"         # 跨轮连续思考

@dataclass(frozen=True)
class InferenceConfig:              # <- 模式5: 成本感知（调同一模型参数，不是选不同模型）
    thinking_mode: ThinkingMode = ThinkingMode.INTERLEAVED
    temperature: float = 0.0
    max_tokens: int = 4096

class LLMClient:                    # 替代原 LLMProvider + LLMRouter
    """单一模型封装（litellm.acompletion）"""
    async def chat(messages, tools, config, ...) -> LLMResponse
    async def chat_stream(messages, config, ...) -> AsyncIterator[str]
```

**删除**：`ModelRole`、`LLMRouter`、`DEFAULT_FALLBACK_CHAIN`、`create_router_from_config`

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/core/llm.py` | 重写 | 删除多模型路由，LLMClient + ThinkingMode + InferenceConfig |
| `quilin/core/messages.py` | 保留 | 已完成，无需修改 |
| `quilin/core/system_prompt.py` | 新建 | 系统提示模板，支持动态组装 |
| `quilin/cli.py` | 新建 | CLI 入口 `python -m quilin "你的任务"` |
| `quilin/core/Harness.py` | 修改 | `_node_plan` 接入 LLMClient，内部组件直接调用 |
| `quilin/config.yaml` | 修改 | 单一模型配置块 |
| `requirements.txt` | 修改 | 加 `litellm>=1.40` |

**融入设计模式**：模式5（成本感知）+ 模式6（三种思考模式）

**验证**：`python -m quilin "What is 2+2?"` -> LLMClient 调用配置的模型 -> 拿到响应

---

### Phase 1: 核心工具系统 + 混合动作空间

**目标**：让 Agent 能调用工具。实现 4 类动作空间（模式2: 混合动作空间）。

**ToolRouter 4 类动作空间**（MAI-UI/UI-TARS-2 启发）：
```
ToolRouter
  |-- 程序化工具：file_read/write/edit、bash、glob、grep、web_search...
  |-- 交互操作：ask_user（一等公民）、show_progress
  |-- 控制操作：terminate、pause、resume
  +-- GUI 操作：预留接口（Phase 6 实现）
```

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/tools/base.py` | 新建 | Tool 基类 + ToolRegistry，4 类动作定义 |
| `quilin/tools/file_ops.py` | 新建 | ReadFile/WriteFile/EditFile |
| `quilin/tools/bash.py` | 新建 | BashTool，asyncio subprocess + 超时 |
| `quilin/tools/search.py` | 新建 | GlobTool + GrepTool |
| `quilin/core/Harness.py` | 修改 | 重构 ToolRouter + `_node_execute_tools` |

**融入设计模式**：模式2（混合动作空间）

**验证**：`python -m quilin "读取 README.md 并总结"` -> Agent 调用 ReadFile -> 总结

**依赖**：Phase 0

---

### Phase 2: 对话管理 + 验证层 + 权限

**目标**：多轮对话管理；输入/输出/步骤级验证（模式7）；工具权限分级。

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/core/conversation.py` | 新建 | ConversationManager，消息历史 + token 计数 + 压缩 |
| `quilin/core/permissions.py` | 新建 | PermissionManager，AUTO/DEFAULT/STRICT 三级 |
| `quilin/core/hooks.py` | 新建 | HookRunner，PreToolUse/PostToolUse/Stop |
| `quilin/core/Harness.py` | 修改 | 增强 Verifier（步骤验证 + 元验证） |

**Verifier 增强**（模式7: 内建验证，DeepSeek/UI-TARS-2 启发）：
- 输入验证：注入检测、有害内容过滤
- **步骤验证**（新增）：每次工具调用后，用 LLM 验证结果是否符合预期
- 输出验证：安全检查 + 格式校验
- **元验证**（新增）：验证过程本身是否正确

**融入设计模式**：模式7（内建验证）

**验证**：执行 `rm` 前弹出确认；步骤验证检测到异常时触发重试

**依赖**：Phase 1

---

### Phase 3: 记忆系统（分层记忆）

**目标**：替换 list.append 记忆，实现 Working/Episodic/Semantic/Skill 四层分级记忆（模式1）。

**OmniMem 重构**（UI-TARS-2/GLM-5.1 启发）：
```
OmniMem（修正后）
  |-- Working Memory：最近 k 轮完整内容（k=5），不压缩
  |-- Episodic Memory：更早轮次的语义压缩摘要，Discard-all at threshold
  |-- Semantic Memory：向量索引 + KG 三元组，跨会话持久化
  +-- Skill Memory：Agent 自创的技能/成功轨迹模板（为 Phase 7 准备）
```

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/memory/working.py` | 新建 | Working Memory，keep-recent-k + 阈值丢弃 |
| `quilin/memory/episodic.py` | 新建 | Episodic Memory，LLM 驱动摘要压缩 |
| `quilin/memory/store.py` | 新建 | MemoryStore ABC + SQLiteMemoryStore |
| `quilin/memory/retriever.py` | 新建 | 混合检索（向量 + 时间衰减 + 层级权重） |
| `quilin/memory/reflect.py` | 新建 | Reflector，LLM 驱动自动反思 |
| `quilin/memory/project_memory.py` | 新建 | ProjectMemory，MEMORY.md 持久化 |
| `quilin/core/Harness.py` | 修改 | 重构 OmniMem + ContextManager |

**融入设计模式**：模式1（分层记忆）

**验证**："记住 X" -> 持久化 -> 新会话能想起；超过 k 轮后旧内容被压缩

**依赖**：Phase 2

---

### Phase 4: 可观测性 + MCP 集成

**目标**：运行追踪、指标收集；MCP 从内部总线变为外部工具服务器连接。

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/observability/tracer.py` | 新建 | OpenTelemetry spans，每个节点/LLM/工具都追踪 |
| `quilin/observability/metrics.py` | 新建 | token 用量、延迟、工具成功率、成本估算 |
| `quilin/observability/logger.py` | 新建 | 结构化 JSON 日志 |
| `quilin/mcp/client.py` | 新建 | MCPClient，连接 MCP Server（stdio/SSE） |
| `quilin/mcp/manager.py` | 新建 | MCPServerManager，管理多个 MCP Server |
| `quilin/tools/mcp_tool.py` | 新建 | MCP 发现的工具自动注册为 Tool |

**验证**：一次运行后能导出完整 trace；连接外部 MCP server 能发现工具

**依赖**：Phase 1（ToolRouter）；**可与 Phase 2/3 并行**

---

### Phase 5: 沙箱执行环境

**目标**：安全运行 Agent 生成的代码。

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/sandbox/executor.py` | 新建 | DockerSandbox + LocalSandbox fallback |
| `quilin/sandbox/policy.py` | 新建 | 安全策略（网络隔离、文件限制、超时） |
| `quilin/tools/code_exec.py` | 新建 | CodeExecutionTool，路由到沙箱 |

**验证**：Agent 写 Python -> 沙箱执行 -> 返回结果；恶意代码被阻止

**依赖**：Phase 1；**可与 Phase 2/3/4 并行**

---

### Phase 6: 浏览器 + GUI 操作

**目标**：Browser Use / Computer Use 能力，实现两段式定位（模式4）。

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/browser/provider.py` | 新建 | Playwright 浏览器操作 + Zoom-In 定位 |
| `quilin/browser/session.py` | 新建 | SessionManager，Cookie/Profile 持久化 |
| `quilin/tools/web_search.py` | 新建 | WebSearchTool（Exa/Tavily） |
| `quilin/tools/web_fetch.py` | 新建 | WebFetchTool（URL -> Markdown） |
| `quilin/tools/browser.py` | 新建 | BrowserTool，注册到 ToolRouter GUI 类别 |

**Zoom-In 两段式定位**（模式4，MAI-UI 启发）：
1. 整张截图 -> 模型预测大概坐标 (x, y)
2. 以 (x, y) 为中心裁剪放大 -> 模型重新预测精确坐标

**融入设计模式**：模式4（两段式定位）

**验证**：Agent 能打开网页 -> 截图 -> 理解 -> 点击目标元素

**依赖**：Phase 1；**可与 Phase 2/3/4 并行**

---

### Phase 7: 规划引擎 + 自进化 + 多 Agent

**目标**：高级规划、Agent 自进化闭环（模式3）、多 Agent 编排。

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `quilin/planning/decomposer.py` | 新建 | 任务分解（复杂任务 -> 子步骤 DAG） |
| `quilin/planning/strategies.py` | 新建 | ReAct / PlanAndExecute / CoT |
| `quilin/planning/correction.py` | 新建 | 动态重规划，执行偏差时自动修正 |
| `quilin/evolution/trajectory.py` | 新建 | TrajectoryStore，记录完整运行轨迹 |
| `quilin/evolution/analyzer.py` | 新建 | 失败分析 + 改进建议 |
| `quilin/evolution/self_modify.py` | 新建 | Scaffold 自修改（提示词/工具配置/工作流） |
| `quilin/evolution/skill_manager.py` | 新建 | 技能自创 + 技能库管理 |
| `quilin/orchestration/supervisor.py` | 新建 | Supervisor 模式，主 Agent 分配子任务 |
| `quilin/core/agent.py` | 新建 | Agent 抽象，支持 spawn 子 Agent |

**自进化闭环**（模式3，MiniMax M2.7 启发）：
```
分析失败轨迹 -> 规划修改 -> 修改 scaffold 代码
  -> 运行评估 -> 对比结果 -> 决定保留/回滚
```

**融入设计模式**：模式3（自进化闭环）

**验证**：连续运行 10+ 次后，自进化模块自动调整系统提示，后续成功率提升

**依赖**：Phase 0-3 全部完成

---

### Phase 8: 集成测试 + 端到端验证

**目标**：全链路测试，确保所有 Phase 协同工作。

**文件清单**：

| 文件 | 动作 | 说明 |
|------|------|------|
| `tests/conftest.py` | 新建 | 共享 fixtures（mock LLM、mock tools） |
| `tests/test_llm.py` | 新建 | LLMClient 测试 |
| `tests/test_tools.py` | 新建 | 每个工具的 execute 测试 |
| `tests/test_harness.py` | 新建 | 端到端 Agent 循环测试 |
| `tests/test_memory.py` | 新建 | 存储、检索、反思测试 |
| `tests/test_conversation.py` | 新建 | 上下文窗口管理测试 |
| `pyproject.toml` | 新建 | 替换 requirements.txt，加 dev 依赖 |

**验证**：`pytest` 全部通过，覆盖率 >= 80%

**依赖**：所有 Phase（但每个 Phase 完成后即写对应单元测试）

---

## 并行策略

```
Phase 0 --> Phase 1 --> Phase 2 --> Phase 3 --> Phase 7 --> Phase 8
                 |                                  ^
                 |-- Phase 4 (可观测+MCP) ----------|
                 |-- Phase 5 (沙箱) ---------------|
                 +-- Phase 6 (浏览器) -------------|
```

- **关键路径**：0 -> 1 -> 2 -> 3 -> 7 -> 8
- **Phase 4/5/6 可并行**：它们只依赖 Phase 1 的 ToolRouter 接口
- Phase 7 需要 Phase 0-3 全部完成（自进化需要完整的记忆和验证基础）
- Phase 8 贯穿始终（每个 Phase 完成后写测试）

---

## 关键架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| LLM 抽象 | litellm + LLMClient | litellm 统一 API；单一模型，用户可配置切换 |
| 设计参考 | 6 模型架构研究 | 提炼 7 个设计模式，内化到框架（不是接入多模型） |
| Agent 循环 | ReAct（默认）+ Plan&Execute（可选） | ReAct 覆盖 90% 场景 |
| 工具 schema | OpenAI function calling 格式 | 行业标准，litellm 统一归一化 |
| 记忆持久化 | SQLite + 可选向量库 | 零配置本地跑，生产换 Postgres |
| 子 Agent | asyncio.Task + 共享 LLMClient | 轻量，无 IPC 开销 |
| MCP | MCP 客户端（mcp SDK） | 标准协议，复用 MCP Server 生态；内部组件直接调用不走 MCP |
| 沙箱 | Docker 容器（aiodocker） | 真正隔离；无 Docker 时降级到 subprocess |
| 可观测性 | OpenTelemetry | 厂商无关，可导出到 Langfuse/Jaeger 等 |

## 验证方式（每个 Phase）

- **Phase 0**: `python -m quilin "What is 2+2?"` -> LLM 回答
- **Phase 1**: `python -m quilin "读取 README.md 并总结"` -> 调用 ReadFile -> 总结
- **Phase 2**: 执行 `rm` 前弹出确认；步骤验证检测异常时触发重试
- **Phase 3**: "记住 X" -> 持久化 -> 新会话能想起
- **Phase 4**: 运行产生完整 trace；连接外部 MCP Server 能发现工具
- **Phase 5**: Agent 写代码 -> Docker 中安全执行
- **Phase 6**: Agent 打开网页 -> 截图理解 -> 点击元素
- **Phase 7**: 复杂任务自动分解；自进化模块调整提示词后成功率提升
- **Phase 8**: `pytest` 全部通过，覆盖率 >= 80%
