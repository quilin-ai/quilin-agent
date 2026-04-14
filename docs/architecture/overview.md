# Quilin Agent 架构总览

> 融合全球最强 Agent 开源项目精华的自进化 Agent 框架
>
> **技术栈**：Bun (TS 运行时) + pnpm + Vitest | CPython 3.14 + uv + pytest | Rust 1.94 + cargo | Vercel AI SDK v6 (LLM 抽象) | Docker Dev Container | just (跨语言编排)

---

## Harness Engineering：顶层组织原则

Quilin 的整体架构就是一个 **Harness**——包裹在 LLM 外面的一切。行业实证表明 harness 质量的影响可以超过模型换代的影响（LangChain 仅改 harness 即提升 13.7 pp，Opus 4.6 换 harness 排名从 #33 跳到 #5）。

**Quilin 的策略**：把 harness 做到极致，让任意模型都能超水平发挥。模型是用户选的（via litellm），harness 是我们的核心竞争力。

详见 [harness-engineering.md](./harness-engineering.md)，涵盖：行业实证、前馈/反馈控制模型、4 种生产架构模式、9 条设计原则、上下文经济学、成熟度模型、反模式。

---

## 架构全景图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Quilin Harness                                      │
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
│  ═══════════════════════ 横切关注点 ═══════════════════════════════════    │
│                                                                             │
│  ▓▓▓  07-Safety  ▓▓▓  前馈+反馈 — 输入/输出双向验证，约束即生产力  ▓▓▓▓▓   │
│  ░░░  08-Observability  ░░░  反馈 — OTel 追踪 + 评估驱动开发  ░░░░░░░░   │
│                                                                             │
│  ═══════════════════════ 基础设施层 ═══════════════════════════════════    │
│                                                                             │
│  ▒▒▒  09-Deployment  ▒▒▒  运行时基础 — CLI / Docker / 热更新 / 熵管理 ▒▒   │
│                                                                             │
│  ████  10-SelfEvolution  ████  前馈+反馈 — 轨迹分析 + 自修改 + 吸收  ████  │
│                                                                             │
│  ◆◆◆  11-AgentMesh  ◆◆◆  内置能力 — 启动即加入 mesh 网络  ◆◆◆◆◆◆◆◆◆   │
│                                                                             │
│  ★★★  12-ConversationEng  ★★★  前馈 — 6 层活人感 + 风格模式  ★★★★★★  │
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

### 做什么

**自研极简 Agent Loop（< 200 行 TS）**
不使用 LangGraph 或任何外部 Agent 框架。四大标杆（Claude Code、Codex、OpenClaw、Hermes）全部使用自研循环，详见 [ADR-001](../adr/adr-001-core-loop-and-language.md)。

**三语言架构 — TS (核心) + Python (ML) + Rust (基础设施)**
TypeScript 实现 Agent 核心循环和 E-T-C-S-L-V 六组件；Python 封装 ML Provider（向量检索、KG、DSPy）为独立 MCP Server；Rust 处理 Agent Mesh 网络层和 WASM 沙箱。

**单一模型 + Vercel AI SDK v6 统一接口**
用户通过 Vercel AI SDK v6（630M+ 周下载，25+ providers）接入任意模型（GPT-4o、Claude、Gemini、本地模型等），框架内部不绑定任何特定供应商。

**E-T-C-S-L-V 六组件 = LLM 可调用的能力层**
六组件不再是固定状态图节点，而是作为 LLM 可自主调用的能力暴露。LLM 自己决定何时查记忆、何时调工具、何时结束。

**12 领域 × Top 10 上游监控 + 自动缝合**
持续追踪 ~100 个顶级开源项目的新版本，通过 Claude-powered diff 分析自动生成融合补丁，保持框架与社区最佳实践同步。

### 怎么做（Harness 设计原则）

**约束悖论 — 约束越多，能力越强**
所有成功团队（OpenAI、Stripe、Manus、Vercel）都在限制 agent 的自由度。刚性架构、强制 lint、最小工具集——约束是能力的倍增器。

**Build to Delete — 为删除而构建**
每个 harness 组件编码了一个关于"模型做不到什么"的假设。模型升级时假设过时，组件就成了负债。Manus 6 个月重写 5 次，每次都在删减。

**KV-Cache 经济学主导成本**
cached input tokens 比 uncached 便宜 10 倍。只追加不修改上下文、掩码工具而非删除、稳定 prompt 前缀——这些决定了 10 倍的成本差异。

**仓库即真理之源**
agent 看不到的东西不存在。所有架构决策、规范、部署流程必须在仓库中版本控制。AGENTS.md 是地图（< 100 行），不是百科全书。

**最小化然后迭代**
最小可行 harness：200-500 行代码。先跑起来，观察失败，针对性加固。不要预设计理想 harness。

完整 9 条原则详见 [harness-engineering.md §七](./harness-engineering.md#七harness-设计原则)。

---

## 12 大工程领域导航

| # | 领域 | 控制类型 | 描述 | 文档 | Phase |
|---|------|---------|------|------|-------|
| 01 | LLM 接入 | — | 单一模型封装、ThinkingMode、InferenceConfig | [01-llm-integration](../engineering/01-llm-integration/README.md) | 0 |
| 02 | 上下文 | 前馈 | 系统提示组装、token 预算、KV-cache 优化 | [02-context](../engineering/02-context/README.md) | 0 |
| 03 | 记忆 | 前馈 | 4 层分级存储、向量+KG 检索、自动反思 | [03-memory](../engineering/03-memory/README.md) | 0-1 |
| 04 | 规划 | 前馈 | 意图识别、任务分解、推理策略切换 | [04-planning](../engineering/04-planning/README.md) | 1 |
| 05 | 工具 | 前馈+反馈 | 4 类混合动作空间、MCP 客户端、浏览器 | [05-tool](../engineering/05-tool/README.md) | 0-2 |
| 06 | 多 Agent | 前馈+反馈 | 同构 spawn + 上下文防火墙 | [06-multi-agent](../engineering/06-multi-agent/README.md) | 2 |
| 07 | 安全护栏 | 前馈+反馈 | 4 层验证、权限分级、约束即生产力 | [07-safety-guardrails](../engineering/07-safety-guardrails/README.md) | 1 |
| 08 | 可观测性 | 反馈 | OTel 追踪、指标、评估驱动开发 | [08-observability](../engineering/08-observability/README.md) | 1 |
| 09 | 部署运行时 | — | CLI、配置管理、热更新、熵管理 | [09-deployment-runtime](../engineering/09-deployment-runtime/README.md) | 1-2 |
| 10 | 自进化 | 前馈+反馈 | 轨迹分析、scaffold 自修改、用户自助吸收 | [10-self-evolution](../engineering/10-self-evolution/README.md) | 2 |
| 11 | Agent Mesh | — | 内置能力，启动即加入 AgentMesh 网络 | [11-agent-mesh](../engineering/11-agent-mesh/README.md) | 2 |
| 12 | 对话工程 | 前馈 | 6 层活人感架构、风格模式配置、关系建模 | [12-conversation-engineering](../engineering/12-conversation-engineering/README.md) | 2 |

> **控制类型**来自 [harness-engineering.md §三](./harness-engineering.md#三harness-控制模型)：前馈（行动前引导）、反馈（行动后观察纠正）。
>
> **Phase** 对应 [implementation-plan.md](../implementation-plan.md) 的三阶段迁移：Phase 0 (PoC)、Phase 1 (核心)、Phase 2 (高级)。

---

## E-T-C-S-L-V 六组件架构

六组件从"状态图的固定节点"重新定位为"LLM 可调用的能力层"（详见 [ADR-001](../adr/adr-001-core-loop-and-language.md)）：

| 组件 | 全称 | Harness 角色 | 控制类型 | 职责 |
|------|------|-------------|---------|------|
| E | Execution | AgentState + checkpoint | — | 承载 Agent 调用生命周期、状态持久化（SQLite） |
| T | Tools | MCP Tool Registry | 前馈+反馈 | 工具注册与调度，MCP 连接外部工具服务器，自检能力 |
| C | Context | System prompt 组装 | 前馈 | 融合记忆召回 + 环境信息，管理 token 预算和 KV-cache |
| S | State | SQLite-backed state | — | 消息数组即核心状态，checkpoint 和崩溃恢复 |
| L | Lifecycle | 进程管理 + 心跳 | — | 管理 Agent 启动、完成、失败事件，优雅关闭 |
| V | Verification | Guardrails middleware | 前馈+反馈 | 输入/输出双向验证，步骤验证，元验证 |

---

## Agent Loop 核心设计

Agent 主循环是一个极简的 while-loop（目标 < 200 行 TS），不使用 LangGraph 或任何外部框架：

```
while (!state.isTerminal) {
    // 1. 组装 prompt (system + memories + context + messages)
    // 2. 调用 LLM，流式接收响应
    // 3. 如果响应包含 tool_calls → 并行执行 → 结果追加到 messages
    // 4. 如果响应是 assistant message → 检查是否需要继续
    // 5. checkpoint 当前状态
}
```

**核心洞察**：LLM 自己决定何时调用工具、何时查记忆、何时结束。E-T-C-S-L-V 作为可调用的工具/能力暴露给 LLM，而非固定的节点顺序。Loop 简单，子系统复杂——这是四大标杆项目的共同智慧。

Quilin 选择**单线程主循环**作为核心，同时融合中间件思想（Guardrails pre/post hooks）和长任务支持（checkpoint + 断点续行）。详见 [harness-engineering.md §四](./harness-engineering.md#四4-种生产架构模式)。

---

## 7 个跨模型设计模式

从 6 个前沿模型中提炼的设计模式，已内化进 Harness 对应组件：

| # | 设计模式 | 来源模型 | 融入的 Harness 组件 | Phase |
|---|---------|---------|-------------------|-------|
| 1 | 分层记忆 | UI-TARS-2, GLM-5.1 | `OmniMem`（4 层：SHORT/MID/LONG/ULTRA） | 0-1 |
| 2 | 混合动作空间 | MAI-UI, UI-TARS-2 | `ToolRouter`（代码/浏览器/Shell/MCP 四类） | 0 |
| 3 | 自进化闭环 | MiniMax M2.7 | `SelfEvolution`（轨迹分析 + scaffold 自修改） | 2 |
| 4 | 两段式定位 | MAI-UI | `BrowserProvider`（粗定位 + Zoom-In 精定位） | 2 |
| 5 | 成本感知调用 | MAI-UI | `InferenceConfig`（按任务复杂度选模型规格） | 0 |
| 6 | 思考模式控制 | GLM-5.1 | `ThinkingMode`（thinking/non-thinking 动态切换） | 0 |
| 7 | 内建验证 | DeepSeek, UI-TARS-2 | `Verifier`（输入+输出双向 Guardrails） | 1 |

详见 [model-architecture-insights.md](../research/model-architecture-insights.md)

---

## 竞品对比（精简版）

| 能力 | Claude Code | Codex | Manus | **Quilin Agent** |
|------|------------|-------|-------|-----------------|
| 架构模式 | 单线程主循环 | 协议优先 App Server | 单线程 + 文件外存 | 主循环 + 中间件 hook + checkpoint |
| 工具系统 | 内置 8 种 + MCP | Shell + patch + MCP | 最小工具集 | 内置 10+ + MCP 动态发现 + 自创工具 + CLI-Anything |
| 记忆 | CLAUDE.md + 会话内 | AGENTS.md + docs/ | 文件系统外存 + todo 复述 | 4 层分级 + 向量+KG + 自反思 + 用户画像 |
| 安全 | 权限提示 + hooks | OS 级沙箱 | — | 默认 AUTO 权限 + 2-stage Classifier + 4 层验证 |
| 上下文经济学 | 基础 | Thread/Turn/Item | 极致 KV-cache 优化 | KV-cache + 压缩 + 预估 + 掩码 + 时间感知 |
| 自进化 | 无 | 无 | 重写删减（人工） | 轨迹分析 + scaffold 自修改 + User Insight Engine |
| 用户理解 | Auto Memory（被动） | 无 | 无 | 主动画像收集 + 持续学习 + 三层时间感知 + Aha Moment |
| Benchmark | 内部评测 | SWE-bench | 内部 | SWE-bench + GAIA + BFCL 公开榜单参赛 |
| Dashboard | 无 | 无 | 有（Web UI） | 独立 WebUI Dashboard（任务/记忆/指标/拓扑全局可视化） |
| 主线程不阻塞 | Sub-agent 并行（主线程可能阻塞） | 无 | 主线程会阻塞 | Supervisor 永不阻塞 + Sub-Agent 进度汇报协议 |
| 空闲自进化 | 无 | 无 | 无 | 两种计费模式 + 空闲时自动进化 + 透明汇报 |
| 对话工程 | 基础人格 | 无 | 无 | 6 层活人感 + 3 种风格模式（原版/自定义/活人感） |

> 完整 harness 维度对比（含 LangChain、Stripe 等 6 家）详见 [harness-engineering.md §十三](./harness-engineering.md#十三与竞品的-harness-对比)。

---

## 实施路线图

详见 [ADR-001 迁移路径](../adr/adr-001-core-loop-and-language.md#5-迁移路径) 和 [implementation-plan.md](../implementation-plan.md)。

三阶段迁移：

```
Phase 0 (PoC): TS Agent Loop + 1 个 Python MCP Provider，跑通端到端
    │
    ▼
Phase 1 (核心): TS 核心完整替代旧 Harness — ToolRouter, Context, Guardrails, Lifecycle, Plugins
    │
    ▼
Phase 2 (高级): Streaming UI + Agent Mesh + 自进化 + WASM 沙箱
```

---

## 其他架构文档

| 文档 | 描述 |
|------|------|
| [harness-engineering.md](./harness-engineering.md) | Harness 工程完整参考——综合 16 篇行业文献，涵盖控制模型、架构模式、设计原则、经济学、成熟度模型、反模式 |
| [deep-code-research-methodology.md](../research/deep-code-research-methodology.md) | 对上游仓库进行标准化 6 步调研的流程定义，同时适用于官方调研和用户自助吸收 |
| [model-architecture-insights.md](../research/model-architecture-insights.md) | 6 模型架构设计参考 → 7 个跨模型设计模式 |

---

*本文档为架构地图，每节点到为止。各领域深度设计请通过上方链接导航至对应工程文档。*
