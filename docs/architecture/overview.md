# Quilin Agent 架构总览

> 融合全球最强 Agent 开源项目精华的自进化 Agent 框架

---

## 架构全景图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Quilin Agent                                   │
│                                                                             │
│   用户输入                                                                  │
│      │                                                                      │
│      ▼                                                                      │
│  ┌───────┐    ┌───────────┐    ┌──────────┐    ┌───────────┐              │
│  │  01   │───▶│    02     │───▶│    04    │───▶│    05     │              │
│  │  LLM  │    │  Context  │    │ Planning │    │   Tool    │              │
│  │  接入  │    │  上下文   │    │   规划   │    │   工具    │              │
│  └───────┘    └─────┬─────┘    └──────────┘    └─────┬─────┘              │
│      ▲              │                                  │                   │
│      │              ▼                                  ▼                   │
│      │         ┌───────────┐                   ┌──────────────┐           │
│      └─────────│    03     │                   │      06      │           │
│   反思回流      │  Memory   │                   │  MultiAgent  │           │
│                │   记忆    │◀──────────────────│    多Agent   │           │
│                └───────────┘   协作结果存储     └──────────────┘           │
│                                                        │                   │
│                                              ┌─────────┘                   │
│                                              ▼                             │
│                                         最终输出                            │
│                                                                             │
│  ══════════════════════════════════════════════════════════════════════    │
│                                                                             │
│  ▓▓▓  07-Safety  ▓▓▓  横切所有领域 — 输入/输出双向验证护栏  ▓▓▓▓▓▓▓▓▓▓▓   │
│  ░░░  08-Observability  ░░░  横切所有领域 — OTel 追踪与指标  ░░░░░░░░░░   │
│                                                                             │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│  ▒▒▒  09-Deployment  ▒▒▒  运行时基础设施 — Docker / CLI / 配置  ▒▒▒▒▒▒▒   │
│                                                                             │
│  ████  10-SelfEvolution  ████  依赖 01-06 全部 — 轨迹分析+自修改  ████    │
└─────────────────────────────────────────────────────────────────────────────┘

数据流向：
  01-LLM ──▶ 02-Context ──▶ 04-Planning ──▶ 05-Tool ──▶ 执行结果
                  │                                          │
                  └──▶ 03-Memory ◀────────────────── reflect │
                            │                                │
                            └──▶ 10-SelfEvolution ◀─────────┘
                                  （轨迹分析 + scaffold 自修改）
```

---

## 核心设计哲学

**单一模型 + litellm 统一接口**
用户通过 litellm 接入任意模型（GPT-4o、Claude、Gemini、本地模型等），框架内部不绑定任何特定供应商。

**6 模型设计参考 → 7 个跨模型设计模式（内化，不接入）**
深度分析 MiniMax M2.7 / GLM-5.1 / Qwen3-VL / MAI-UI / UI-TARS-2 / DeepSeek V3.2 六个前沿模型的架构，提炼出 7 个可移植的设计模式，内化进 Harness 各组件，不依赖这些模型运行。

**9 层 × Top 10 上游监控 + 自动缝合**
持续追踪 90 个顶级开源项目的新版本，通过 Claude-powered diff 分析自动生成融合补丁，保持框架与社区最佳实践同步。

**内部组件直接调用，MCP 仅对接外部 Server**
核心六组件（E-T-C-S-L-V）之间通过 MCPBus 进行结构化消息传递，MCP 对外则用于连接第三方工具服务器，两者职责清晰分离。

**E-T-C-S-L-V 六组件架构**
每次 Agent 调用都经由六个组件的协作完成，详见下节。

---

## 10 大工程领域导航

| # | 领域 | 描述 | 文档 | Phase |
|---|------|------|------|-------|
| 01 | LLM 接入 | 单一模型封装、ThinkingMode、InferenceConfig | [01-llm-integration.md](../engineering/01-llm-integration.md) | 0 |
| 02 | 上下文 | 系统提示组装、上下文生命周期、token 预算 | [02-context.md](../engineering/02-context.md) | 0 |
| 03 | 记忆 | 4 层分级存储、向量+KG 检索、自动反思 | [03-memory.md](../engineering/03-memory.md) | 3 |
| 04 | 规划 | 意图识别、任务分解、推理策略切换 | [04-planning.md](../engineering/04-planning.md) | 2 |
| 05 | 工具 | 4 类混合动作空间、MCP 客户端、浏览器 | [05-tool.md](../engineering/05-tool.md) | 1, 6 |
| 06 | 多 Agent | 编排模式、SubAgent、A2A 协议 | [06-multi-agent.md](../engineering/06-multi-agent.md) | 7 |
| 07 | 安全护栏 | 4 层验证、权限分级、Hooks | [07-safety-guardrails.md](../engineering/07-safety-guardrails.md) | 2 |
| 08 | 可观测性 | OTel 追踪、指标、结构化日志 | [08-observability.md](../engineering/08-observability.md) | 4 |
| 09 | 部署运行时 | Docker 沙箱、CLI、配置管理 | [09-deployment-runtime.md](../engineering/09-deployment-runtime.md) | 5 |
| 10 | 自进化 | 轨迹分析、scaffold 自修改、技能自创 | [10-self-evolution.md](../engineering/10-self-evolution.md) | 7 |

---

## E-T-C-S-L-V 六组件架构

每次 `Quilin.run()` 调用都由六个核心组件协同驱动，职责边界清晰：

| 组件 | 全称 | 对应类 | 职责 |
|------|------|--------|------|
| E | Execution（执行层） | `ExecutionContext` | 承载单次 Agent 调用的完整生命周期：run_id、任务、输入输出、执行轨迹 |
| T | Tools（工具层） | `ToolRouter` | 工具路由与调用，通过 MCPBus 分发工具请求至各 Provider |
| C | Context（上下文层） | `ContextManager` | 融合记忆召回 + 环境信息，组装每轮推理所需的完整上下文 |
| S | State（状态层） | `AgentState` | 维护状态机当前节点、历史路径、循环计数，控制图遍历终止条件 |
| L | Lifecycle（生命周期层） | `LifecycleManager` | 管理 Agent 运行的启动、完成、失败事件，并向可观测性层发布通知 |
| V | Verification（验证层） | `Verifier` | 对输入和输出双向执行 Guardrails 检查，异常时短路至 error 节点 |

---

## LangGraph 状态机

Agent 主循环由一个 LangGraph 风格的状态图驱动，共 8 个节点：

```
                    ┌──────────┐
                    │  start   │
                    └────┬─────┘
                         │
                         ▼
                  ┌──────────────┐   blocked
                  │ verify_input │──────────────▶ [ error ]
                  └──────┬───────┘
                         │ pass
                         ▼
                  ┌──────────────┐
                  │build_context │  (Memory recall + 环境信息)
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
              ┌──▶│    plan      │  (LLM 推理 + 规划)
              │   └──────┬───────┘
              │          │
              │          ▼
              │   ┌──────────────┐
              │   │execute_tools │  (工具调用)
              │   └──────┬───────┘
              │          │
              │          ▼
              │   ┌──────────────┐   blocked
              │   │verify_output │──────────────▶ [ error ]
              │   └──────┬───────┘
              │          │ pass
              │          ▼
              │   ┌──────────────┐
              │   │   reflect    │  (存储记忆 + 自动反思)
              │   └──────┬───────┘
              │          │
              │          ▼
              │   ┌──────────────┐
              │   │   decide     │
              │   └──────┬───────┘
              │          │
              │    ┌─────┴──────┐
              │    │            │
              │ continue      done
              └────┘            │
                                ▼
                            [ end ]
```

最大迭代次数默认 50 次，超出或计划标记 `is_complete` 时强制终止。

---

## 7 个跨模型设计模式

从 6 个前沿模型中提炼的设计模式，已内化进 Harness 对应组件：

| # | 设计模式 | 来源模型 | 融入的 Harness 组件 | Phase |
|---|---------|---------|-------------------|-------|
| 1 | 分层记忆 | UI-TARS-2, GLM-5.1 | `OmniMem`（4 层：SHORT/MID/LONG/ULTRA） | 3 |
| 2 | 混合动作空间 | MAI-UI, UI-TARS-2 | `ToolRouter`（代码/浏览器/Shell/MCP 四类） | 1 |
| 3 | 自进化闭环 | MiniMax M2.7 | `SelfEvolution`（轨迹分析 + scaffold 自修改） | 7 |
| 4 | 两段式定位 | MAI-UI | `BrowserProvider`（粗定位 + Zoom-In 精定位） | 6 |
| 5 | 成本感知调用 | MAI-UI | `InferenceConfig`（按任务复杂度选模型规格） | 0 |
| 6 | 思考模式控制 | GLM-5.1 | `ThinkingMode`（thinking/non-thinking 动态切换） | 0 |
| 7 | 内建验证 | DeepSeek, UI-TARS-2 | `Verifier`（输入+输出双向 Guardrails） | 2 |

详见 [model-architecture-insights.md](../research/model-architecture-insights.md)

---

## 竞品对比

| 能力 | Claude Code | Codex | Manus | Hermes | OpenClaw | **Quilin Agent** |
|------|------------|-------|-------|--------|----------|-----------------------|
| Agent 循环 | ReAct + 扩展思考 | Rust sandbox loop | 多 Agent 图编排 | 学习闭环 | 网关+插件 | ReAct + Plan&Execute 双模式 + 扩展思考 |
| 工具系统 | 内置 8 种 + MCP | Shell + patch + MCP | Agent 专用工具 | 40+ 工具 + MCP | 插件 SDK + MCP | 内置 10+ + MCP 动态发现 + 自创工具 |
| 记忆 | CLAUDE.md + 会话内 | AGENTS.md + 会话内 | 无持久化 | 4 层 + 自进化 | Session + Context | 4 层分级 + 向量+KG + 自反思 |
| 浏览器 | 无（靠 MCP） | 无 | 全浏览器 + Computer Use | 无 | Canvas + A2UI | 5 种方案 + Zoom-In 两段式定位 |
| 沙箱 | 无 | OS 级隔离 | Docker | Docker/Daytona | K8s | Docker + 本地降级 |
| 自进化 | 无 | 无 | 无 | DSPy + GEPA | 无 | 轨迹分析 + scaffold 自修改 + 技能自创 |
| 多 Agent | 并行 Sub-agent | 无 | 多角色 | 子 Agent | 多 Agent 路由 | Supervisor + Worker + 辩论 + A2A |

---

## 8 Phase 实施路线图

```
Phase 0: LLM 接入 + 上下文基础
    │
    ▼
Phase 1: 工具系统（内置工具 + MCP 客户端）
    │
    ├──▶ Phase 4: 可观测性（OTel + 结构化日志）──┐
    │                                            │
    ├──▶ Phase 5: 沙箱运行时（Docker + CLI）──────┤
    │                                            │
    └──▶ Phase 6: 浏览器支持（5 种方案）──────────┤
    │                                            │
    ▼                                            │
Phase 2: 安全护栏 + 规划层                       │
    │                                            │
    ▼                                            │
Phase 3: 分层记忆（OmniMem 4 层）                │
    │                                            │
    ▼           ◀───────────────────────────────┘
Phase 7: 多 Agent + 自进化
    │
    ▼
Phase 8: 全系统集成 + 生产就绪
```

关键路径：Phase 0 → 1 → 2 → 3 → 7 → 8（串行核心能力）
并行加速：Phase 4（可观测）、Phase 5（沙箱）、Phase 6（浏览器）可在 Phase 1 完成后并行推进。

详见 [implementation-plan.md](../implementation-plan.md)

---

*本文档为架构地图，每节点到为止。各领域深度设计请通过上方链接导航至对应工程文档。*
