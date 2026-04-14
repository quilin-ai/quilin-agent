# Quilin Agent 实现规划

> **状态**：规划中（ADR-001 已定稿，等待全部工程文档对齐后进入实施）
>
> **语言架构**：TS (核心) + Python (ML Provider) + Rust (基础设施)，详见 [ADR-001](./adr/adr-001-core-loop-and-language.md)

## Context

旧 Python Harness 已删除（ADR-001 结论：不用 LangGraph，自研极简 Loop）。当前状态：

- 12 个工程领域的设计文档已完成
- ~100 个上游子模块已配置
- 核心架构决策已定稿（ADR-001）
- 代码 = 0 行（规划完成后才写代码）

---

## 竞品核心能力对照

| 能力 | Claude Code | Codex | Manus | Hermes | OpenClaw | **Quilin 目标** |
|------|------------|-------|-------|--------|----------|----------------|
| Agent 循环 | TS→Rust, ~88 行 while-loop | Rust, Tokio async | 多 Agent 图编排 | Python 学习闭环 | TS, Pi agent RPC | 自研极简 Loop (< 200 行 TS) + E-T-C-S-L-V 能力层 |
| 工具系统 | 内置 8 种 + MCP | Shell + patch + MCP | Agent 专用工具 | 40+ 工具 + MCP | 插件 SDK + MCP | 内置 10+ + MCP 动态发现 + 自创工具 |
| 记忆 | CLAUDE.md + 会话内 | AGENTS.md + 会话内 | 无持久化 | 4 层 + 自进化 | Session + Context | 4 层分级 + 向量+KG + 自反思 |
| 浏览器 | 无（靠 MCP） | 无 | 全浏览器 + Computer Use | 无 | Canvas + A2UI | 5 种方案 + Zoom-In 两段式定位 |
| 沙箱 | 无 | OS 级隔离 | Docker | Docker/Daytona | K8s | Docker + 本地降级 |
| 自进化 | 无 | 无 | 无 | DSPy + GEPA | 无 | 轨迹分析 + scaffold 自修改 + 技能自创 |
| 多 Agent | 并行 Sub-agent | 无 | 多角色 | 子 Agent | 多 Agent 路由 | 同构 + 异构（内置 Agent Mesh） |
| Mesh 互联 | 无 | 无 | 无 | 无 | 无 | 天然接入 AgentMesh，启动即可发现/通信 |
| 热更新 | 无 | 无 | 无 | 无 | 无（#1 投诉：更新不稳定） | 热更新 + 更新策略可选 + 更新后主动告知 |
| Token 预估 | 无（断了才知道） | 无 | 无 | 无 | 无 | 任务前预估消耗 + 余量不足主动建议拆分 |
| 用户理解 | Auto Memory（被动） | 无 | 无 | Honcho 辩证式 | 无 | 主动画像收集 + 持续学习 + Aha Moment 引擎 |
| 时间感知 | 部分（凌晨提醒） | 无 | 无 | 无 | 无 | 三层时间感知（会话内间隔 + 绝对时间 + 跨 session 时间线） |
| 权限模式 | auto mode（需手动开启） | Guardian AI | 无 | 预算隔离 | 工具审批 | 默认 AUTO + CRITICAL 强制确认 + 2-stage Classifier |
| 工具 CLI 覆盖 | 无 | 无 | 无 | 无 | 无 | CLI-Anything 集成，GUI 工具自动生成 CLI wrapper |
| Dashboard | 无 | 无 | 有（Web UI） | 无 | 有（Web Console） | 独立 WebUI Dashboard（任务/记忆/指标/拓扑全局可视化） |
| Benchmark 验证 | 内部评测 | SWE-bench 参赛 | 内部 | 无 | 无 | SWE-bench + GAIA + BFCL 公开榜单参赛 |
| 主线程不阻塞 | Sub-agent 并行（主线程仍可能被占用） | 无 | 多 Agent 但主线程会阻塞 | 无 | 无 | Supervisor 永不阻塞 + Sub-Agent 进度汇报协议 |
| 空闲自进化 | 无 | 无 | 无 | 无 | 无 | 两种计费模式（订阅闲置配额 / API 每日预算）+ 透明汇报 |
| 对话工程（活人感） | 基础人格 | 无 | 无 | 无 | 无 | 6 层活人感架构 + 3 种风格模式（原版/自定义/活人感） |

## Quilin 独特优势

1. **融合 6 大模型架构精华** — 7 个跨模型设计模式内化进框架
2. **11 领域 × Top 10 上游监控 + 自动缝合** — 持续进化，不是一次性开发
3. **4 层分级记忆 + KG + 自反思** — 解决 OpenClaw 记忆失灵 + 跨项目污染
4. **内置 Agent Mesh** — 天然接入去中心化 Agent 通信网络
5. **热更新 + 主动通知** — 解决 OpenClaw/Hermes 更新断连痛点
6. **自进化带验证** — 不是 Hermes 的盲目自信，每次 scaffold 修改都有评估
7. **Agentic 人味** — 主动收集用户背景、持续学习用户画像、User Insight Engine 产生 Aha Moment
8. **三层时间感知** — 会话内间隔感知 + 绝对时间感知 + 跨 session 时间线衔接，理解"沉默"本身是信息
9. **默认最大信任** — AUTO 权限模式为默认，只有 CRITICAL 操作才问人，参考 Claude Code auto mode
10. **CLI-Anything 工具全覆盖** — GUI-only 工具自动生成 CLI wrapper，所有工具都可通过命令行调用
11. **WebUI Dashboard** — 独立全局可视化面板（任务状态、记忆浏览、工具统计、Agent 拓扑、token 指标）
12. **Benchmark 实证** — 参加 8 大类 30+ 公开 benchmark（SWE-bench/GAIA/BFCL/WebArena/AgentHarm 等），在每个榜单上真实碾压所有 Agent
13. **主 Agent 永不阻塞** — Supervisor 架构为默认，所有任务执行委派 Sub-Agent，用户随时可交互；WebUI 实时进度 + IM 主动汇报
14. **空闲自进化经济学** — 用户不在时自动利用闲置配额/每日预算做记忆整合、scaffold 改进、技能扩充、浏览相关内容，下次上线透明汇报
15. **对话工程（活人感）** — 6 层架构（句子表面/话轮结构/观点判断/关系建模/时间连续性/元层面），让 Agent 不像工具而像一个有个性的真人；3 种风格模式可配置切换

---

## 7 个跨模型设计模式

| # | 设计模式 | 来源 | 融入的组件 | Phase |
|---|---------|------|-----------|-------|
| 1 | 分层记忆 | UI-TARS-2, GLM-5.1 | OmniMem（4 层：SHORT/MID/LONG/ULTRA） | 1 |
| 2 | 混合动作空间 | MAI-UI, UI-TARS-2 | ToolRouter（代码/浏览器/Shell/MCP 四类） | 0 |
| 3 | 自进化闭环 | MiniMax M2.7 | SelfEvolution（轨迹分析 + scaffold 自修改） | 2 |
| 4 | 两段式定位 | MAI-UI | BrowserProvider（Zoom-In 视觉模式） | 2 |
| 5 | 成本感知调用 | MAI-UI | InferenceConfig（按任务复杂度调参数） | 0 |
| 6 | 思考模式控制 | GLM-5.1 | ThinkingMode（thinking/non-thinking 动态切换） | 0 |
| 7 | 内建验证 | DeepSeek, UI-TARS-2 | Verifier（步骤验证 + 元验证） | 1 |

详见 [model-architecture-insights.md](./research/model-architecture-insights.md)

---

## 三阶段迁移计划

> 对应 [ADR-001 迁移路径](./adr/adr-001-core-loop-and-language.md#5-迁移路径)

### Phase 0: 概念验证 (PoC)

**目标**：TS Agent Loop + 1 个 Python MCP Provider，跑通端到端。

**范围**：
- TS 项目骨架（pnpm + tsconfig）
- 极简 Agent Loop（< 200 行 TS while-loop）
  - LLM 调用 + tool dispatch + streaming (ReadableStream) + checkpoint (SQLite)
- 将 OmniMem recall/store 封装为 Python MCP Server
- TS Loop 通过 MCP stdio 调用 Python OmniMem

**涉及工程领域**：01-LLM 接入、02-上下文、05-工具（基础）

**验证**：
- 基础验证：一个完整的 ask → recall memory → LLM → respond 流程跑通
- **Benchmark-ready 里程碑**：能提交 SWE-bench Verified 并获得有竞争力的分数

> **为什么 Phase 0 就要 benchmark-ready？**
>
> GAIA 排行榜前 6 名全部使用同一模型（Anthropic），差异全在 harness——这直接验证了 Quilin "harness 是核心竞争力"的论点。只有在公开榜单上证明自己，才能从"最强缝合怪"的口号变成可验证的事实。Phase 0 的退出标准不是"能跑"，而是"能打"。
>
> **全量 Benchmark 竞赛计划（8 大类 30+ 个 Benchmark）**：
>
> | 类别 | Benchmark | 优先级 | 衡量的能力 | Phase |
> |------|-----------|-------|-----------|-------|
> | **1. 软件工程/编码** | SWE-bench Verified | P0 | 代码 Agent 综合能力（500 真实 GitHub issue） | 0 |
> | | SWE-bench Pro (SEAL) | P0 | SWE-bench 更严格变体 | 0 |
> | | Terminal-Bench 2.0 | P1 | 终端操作 + 命令行任务 | 1 |
> | | LiveCodeBench | P1 | 实时编程竞赛题目（防数据泄露） | 1 |
> | | Aider Polyglot | P2 | 多语言编辑能力 | 2 |
> | | MLE-bench | P2 | ML 工程全流程 | 2 |
> | | HumanEval / BigCodeBench | P2 | 函数级代码生成 | 2 |
> | **2. 通用助手/多步任务** | GAIA | P0 | 通用 Agent 多步推理 + 工具使用（466 任务） | 1 |
> | | HLE (Humanity's Last Exam) | P1 | 人类终极考试（跨学科极难） | 2 |
> | | APEX-Agents | P1 | Agent 综合能力评测 | 2 |
> | | AssistantBench | P2 | 日常助手任务 | 2 |
> | **3. 浏览器/网页操作** | WebArena | P1 | 浏览器 Agent 端到端任务完成率 | 2 |
> | | VisualWebArena | P2 | 视觉浏览器交互 | 2 |
> | | Mind2Web | P2 | 网页理解与导航 | 2 |
> | | WebVoyager | P2 | 网页探索任务 | 2 |
> | | BrowseComp | P2 | 浏览能力综合评测 | 2 |
> | **4. 桌面/OS 级** | OSWorld | P2 | 桌面操作系统任务 | 2+ |
> | | Windows Agent Arena | P2 | Windows 环境 Agent 评测 | 2+ |
> | | AndroidWorld / AndroidLab | P2 | Android 平台 Agent | 2+ |
> | | Theta CUB | P2 | 跨平台 UI 操作 | 2+ |
> | **5. 工具调用** | BFCL v4 | P0 | 工具调用准确率（单/多工具、多轮） | 1 |
> | | τ-bench (Tau-bench) | P1 | 工具使用 Agent 基准 | 1 |
> | | ToolBench / API-Bank / Nexus | P2 | API 调用与编排 | 2 |
> | **6. 推理/抽象** | ARC-AGI-2/3 | P2 | 抽象推理 + 少样本学习 | 2+ |
> | | FrontierMath | P2 | 前沿数学推理 | 2+ |
> | | GPQA Diamond | P2 | 专家级科学问答 | 2 |
> | **7. 科研/专业** | ScienceAgentBench | P2 | 科研实验 Agent | 2+ |
> | | BixBench | P2 | 生物信息学 Agent | 2+ |
> | | RE-Bench | P2 | 软件逆向工程 | 2+ |
> | **8. 安全/对齐** | AgentHarm | P1 | Agent 安全与有害行为检测 | 2 |
> | | InjecAgent | P1 | prompt 注入防御 | 2 |
> | | Cybench | P2 | 网络安全 Agent 评测 | 2+ |
>
> **综合/元 Leaderboard**（同步追踪）：Epoch AI Capabilities Index, Scale SEAL, HELM, LMSys Arena, Vellum, Artificial Analysis, Onyx AI
>
> **SWE-bench Verified 现状（2026-04）**：前 10 名在 77.8-80.9%（Mythos 93.9% 为异常值）。首次进 Top 10 需 ~78%+。
>
> **GAIA 现状（2026-04）**：第一名 44.8%，难度远高于 SWE-bench。
>
> **攻略策略**：Phase 0 先攻 SWE-bench Verified/Pro → Phase 1 扩展到 GAIA/BFCL/τ-bench → Phase 2 全面铺开 → Phase 2+ 覆盖 OS 级/科研/安全等垂直领域

**关键架构决策（ADR-001 已定）**：
| 决策 | 选择 | 理由 |
|------|------|------|
| Agent 框架 | 不用 LangGraph，自研 | 四大标杆一致选择 |
| 核心语言 | TypeScript | Streaming 生态 + 前端同构 + MCP SDK 最成熟 |
| ML Provider | Python MCP Server | ML 库生态无可替代 |
| 跨语言通信 | MCP stdio | 90% 场景适用，~5ms 延迟 |
| 状态管理 | 消息数组 + SQLite checkpoint | "the only state is a message array" |
| LLM 抽象 | Vercel AI SDK v6 | 630M+ 周下载，25+ providers，TS 生态最强 LLM 抽象层 |

---

### Phase 1: 核心能力迁移

**目标**：TS 核心完整实现 11 个工程领域的基础能力。

**范围**：
- E-T-C-S-L-V 六组件完整实现
  - ToolRouter → MCP Client Manager（管理多个 MCP Server 连接）
  - ContextManager → 自动 system prompt 组装 + token 预算管理
  - Verifier → Guardrails middleware（pre/post hooks）
  - LifecycleManager → 进程管理 + 心跳 + 优雅关闭
  - PluginRegistry → 动态 MCP Server 发现与注册
- OmniMem 4 层记忆系统
- 规划引擎（意图识别 + 任务分解）
- 安全护栏（4 层验证）
- 可观测性（OTel 追踪 + 结构化日志）
- 部署运行时（CLI 入口 + 配置管理）
- 所有 Python ML Provider 封装为独立 MCP Server

**涉及工程领域**：01-10 全部

**验证**：完整的 Agent 对话循环，能调工具、能记忆、能规划、能验证

---

### Phase 2: 高级能力

**目标**：Streaming UI + Agent Mesh + 自进化 + 高级工具。

**范围**：
- **Streaming Chat UI**：HTTP SSE streaming → React 前端实时对话展示
- **WebUI Dashboard**：独立全局可视化面板（非聊天界面附属）
  - 任务状态一览（进行中/完成/失败）
  - 记忆内容浏览与管理（OmniMem 4 层可视化）
  - 工具使用统计与历史
  - Agent 运行指标（token 消耗、延迟、成功率、成本）
  - 多 Agent 拓扑可视化（配合 11-Agent Mesh）
  - 数据源：08-Observability 的 OTel 数据 + 03-Memory 存储
- Agent Mesh 内置接入（SDK adapter 连接 meshd）
- 自进化系统（轨迹分析 + scaffold 自修改 + 技能自创）+ **User Insight Engine**
- WASM 插件沙箱（Rust）
- 浏览器操作（5 种方案 + Zoom-In 两段式）
- 多 Agent 编排（同构 spawn + 异构 mesh）+ **非阻塞 Supervisor 默认架构**
- **Sub-Agent 进度汇报协议**（Checkpoint + Heartbeat + IM 主动推送）
- 热更新系统
- **空闲自进化经济学**（两种计费模式 + 空闲检测 + 透明汇报）
- CLI-Anything 集成（GUI 工具 → CLI wrapper 自动生成）
- **对话工程**（6 层活人感架构：句子/话轮/观点/关系/时间/元层面 + 3 种风格模式）

**涉及工程领域**：06-多 Agent、10-自进化、11-Agent Mesh、12-对话工程、05-工具（浏览器 + CLI-Anything）、08-可观测性（Dashboard + 进度面板）、09-部署（热更新 + 空闲进化配置）

**验证**：
- mesh.discover() 能看到其他 agent
- 自进化模块运行 10+ 次后自动调整系统提示，成功率提升
- 热更新后主动通知用户变更内容
- **Dashboard 可访问，展示实时 Agent 状态和历史指标**
- **User Insight Engine 能基于积累数据主动产生用户洞察**
- **GAIA benchmark 提交并获得 Top 10 排名**
- **主 Agent 始终可响应用户输入，即使 Sub-Agent 正在执行任务**
- **Sub-Agent 进度在 WebUI 实时可见，IM 场景下主动推送进度**
- **空闲自进化运行后，下次用户上线时收到活动摘要**

---

## 并行策略

```
Phase 0 (PoC)
    │
    ▼
Phase 1 (核心)  ←── 11 个领域的基础能力串行推进
    │
    ├── 关键路径：LLM → 工具 → 上下文 → 记忆 → 规划 → 安全
    │
    └── 可并行：可观测性、部署运行时
    │
    ▼
Phase 2 (高级)  ←── 高级能力可并行推进
    │
    ├── Streaming Chat UI + WebUI Dashboard
    ├── Agent Mesh 接入
    ├── 自进化 + User Insight Engine
    ├── 浏览器操作 + CLI-Anything
    ├── 对话工程（6 层活人感）
    ├── 热更新
    └── 8 大类 benchmark 全量参赛
```

---

## 12 工程领域 × Phase 映射

| # | 领域 | Phase 0 | Phase 1 | Phase 2 |
|---|------|---------|---------|---------|
| 01 | LLM 接入 | LLMClient + litellm | ThinkingMode + InferenceConfig | - |
| 02 | 上下文 | 基础 prompt 组装 + 时间感知注入 | token 预算 + 压缩策略 | - |
| 03 | 记忆 | OmniMem MCP PoC + 用户画像基础 | 4 层完整实现 + User Profile Store | gbrain ULTRA 层 + User Insight Engine + 空闲记忆维护 |
| 04 | 规划 | - | 意图识别 + 任务分解 | 动态重规划 |
| 05 | 工具 | 基础 tool dispatch | MCP Client Manager + 内置工具 | 浏览器 + 自创工具 + CLI-Anything |
| 06 | 多 Agent | - | 同构 spawn | 异构 mesh 互联 + 非阻塞 Supervisor 默认架构 + 进度汇报协议 |
| 07 | 安全护栏 | - | 4 层验证 + 权限分级（默认 AUTO） | 红队自动化 |
| 08 | 可观测性 | - | OTel + 结构化日志 | Langfuse 集成 + WebUI Dashboard + Sub-Agent 进度面板 + IM 汇报 |
| 09 | 部署运行时 | - | CLI + 配置管理 | 热更新系统 |
| 10 | 自进化 | - | 轨迹记录 | scaffold 自修改 + 技能自创 + User Insight Engine + 空闲自进化经济学 |
| 11 | Agent Mesh | - | - | 内置 meshd 接入 |
| 12 | 对话工程 | - | - | 6 层活人感架构 + 风格模式配置 |
