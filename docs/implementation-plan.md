# Quilin Agent 实现规划

> **状态**：Phase 0 已完成（v0.0.3），准备进入模块专项优化
>
> **语言架构**：TS (核心) + Python (ML Provider) + Rust (基础设施)，详见 [ADR-001](./adr/adr-001-core-loop-and-language.md)

## Context

旧 Python Harness 已删除（ADR-001 结论：不用 LangGraph，自研极简 Loop）。当前状态：

- 12 个工程领域的设计文档已完成
- ~100 个上游子模块已配置
- 核心架构决策已定稿（ADR-001）
- Phase 0 已完成（v0.0.3）：Agent Loop + OmniMem MCP + REPL + 78 tests

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

### Phase 0: 概念验证 (PoC) ✅ 已完成

**目标**：TS Agent Loop + 1 个 Python MCP Provider，跑通端到端。

**完成标记**：v0.0.3（2026-04-15）

**已交付**：
- TS 项目骨架（pnpm + tsconfig） ✅
- 极简 Agent Loop（< 200 行 TS while-loop） ✅
  - LLM 调用 + tool dispatch + streaming (ReadableStream) + checkpoint (SQLite)
- OmniMem Python MCP Server（store + recall + reset） ✅
- TS Loop 通过 MCP stdio 调用 Python OmniMem ✅
- OmniMem SQLite 持久化 + FTS5 中文模糊检索 ✅
- REPL 交互界面 + session restore（`just dev` / `just resume`） ✅
- BasicContextManager 多源组装 + 优先级 + 截断 ✅
- ToolRouter + MCP Client Bridge ✅
- 47 TS tests + 31 Python tests 全绿 ✅

**涉及工程领域**：01-LLM 接入、02-上下文、05-工具（基础）

**验证**：
- 基础验证：一个完整的 ask → recall memory → LLM → respond 流程跑通 ✅
- Benchmark harness：推迟到后续阶段

**推迟到模块专项的内容**：
- Context 动态组装 → 02-context 专项
- InferenceConfig 动态调整 → 01-llm 专项
- CI/CD → 工程保障任务
- Dev Container → 有多人协作需求时再做

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

### 迭代式模块专项路线图

> **核心原则**：先把单 Agent 做强，再做大。不按 12 领域平铺推进，而按产品价值和依赖关系分 6 个迭代包递进。

```
Phase 0 (PoC) ✅
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Iter A: Grounded Context (02)                      │
│  ├── 多源 ContextSource 动态组装                     │
│  ├── Token budget + 优先级策略                       │  ← CI 并行补
│  └── Temporal awareness 注入                        │
├─────────────────────────────────────────────────────┤
│  Iter B: Useful Tools (05 + 07-lite)                │
│  ├── 多 MCP Server 管理                             │
│  ├── 内置工具（文件/命令/网络）                       │
│  └── 工具分类 + 最小安全分层                         │
├─────────────────────────────────────────────────────┤
│  Iter C: Planning Core (04 + 01-dynamic)            │
│  ├── 意图识别 + 任务分流                             │
│  ├── Step / retry budget                            │
│  └── 动态 InferenceConfig + ThinkingMode            │
├─────────────────────────────────────────────────────┤
│  Iter D: Operability (08 + 09-lite)                 │
│  ├── OTel spans / metrics / request IDs             │
│  ├── 基础配置管理                                    │
│  └── GitHub Actions CI 三语言矩阵                    │
├─────────────────────────────────────────────────────┤
│  Iter E: Memory Depth & Personality (03-adv + 12)   │
│  ├── OmniMem 4 层分级 + 向量 + KG                    │
│  ├── User Profile Store + auto-reflect              │
│  └── 6 层对话工程 + 3 种风格模式                      │
├─────────────────────────────────────────────────────┤
│  Iter F: Scale-Out (06 + 11 + 10)                   │
│  ├── 多 Agent 编排 + 非阻塞 Supervisor               │
│  ├── AgentMesh SDK 内置接入                          │
│  └── 自进化 + User Insight Engine                    │
└─────────────────────────────────────────────────────┘
    │
    ▼
Benchmark 参赛（贯穿各迭代，能力就绪即提交）
```

---

### Iteration A: Grounded Context — 上下文工程

**主轴**：`02-Context`　**搭配**：`03-light` 改进、`12-light` 基础

**为什么第一**：当前最大产品短板不是"记不住"，而是"记住了也没系统性喂回模型"。`BasicContextManager` 已存在但只喂了一个硬编码 prompt source。

**范围**：
- System prompt 拆为多个 `ContextSource`，每个有 priority + maxTokens
  - `identity` — Agent 身份 + 人设（固定）
  - `memory` — OmniMem recall 结果（动态，每轮按相关性装填）
  - `session` — 当前会话上下文摘要（动态）
  - `environment` — 运行时环境信息（系统、时间、可用工具列表）
  - `temporal` — 时间感知注入（会话内间隔 + 绝对时间 + 跨 session 时间线）
  - `tool-hints` — 当前可用工具的 schema 描述（动态）
  - `user-instructions` — 用户自定义规则（类似 CLAUDE.md，可选）
- Token budget 管理：按 source priority 填充，超限截断低优先级
- Lost-in-the-Middle aware 排布：重要信息放首尾
- 每轮调用前自动重建 context（已有基础，需扩展）

**验证标准**：
- [ ] system prompt 由 ≥3 个独立 source 动态组装
- [ ] Token budget 超限时自动截断低优先级 source
- [ ] memory recall 结果自动注入 context（不再只靠 tool call）
- [ ] temporal awareness：agent 知道"距离上次对话过了多久"
- [ ] 所有 source 有对应的单元测试

**涉及工程领域**：02-Context（主）、03-Memory（recall 集成）、01-LLM（context window 感知）

**参考 spec**：[02-context/README.md](engineering/02-context/README.md)

---

### Iteration B: Useful Tools — 工具系统 + 安全基础

**主轴**：`05-Tool`　**搭配**：`07-Safety-lite`

**为什么第二**：没有更丰富的工具和基本安全分层，agent 的任务上限很低——只能聊天 + 记忆，不能"做事"。工具和安全必须绑定推进：更强的工具没有安全分层 = 风险放大器。

**范围**：

工具系统（05）：
- 多 MCP Server 连接管理（当前只连 OmniMem 一个）
  - 动态注册 / 发现 / 断线重连
  - 工具名冲突解决（namespace 前缀）
- 内置工具（至少实现以下 3 类）
  - `file_read` / `file_write` / `file_list` — 文件操作
  - `shell_exec` — 命令执行（带 timeout + output capture）
  - `web_fetch` — HTTP 请求（GET/POST，带响应截断）
- 工具分类体系
  - `read` — 只读操作，默认 AUTO 放行
  - `write` — 写操作，默认 AUTO 放行但记日志
  - `exec` — 执行操作，默认 CONFIRM
  - `high-risk` — 危险操作（删除、网络写入等），强制 CONFIRM

安全基础（07-lite）：
- 权限分级：AUTO / CONFIRM / DENY 三级
- 默认 AUTO 模式（与 Claude Code auto mode 对齐）
- 工具执行前 pre-hook：检查分类 → 决定是否需要确认
- 工具执行后 post-hook：记录执行结果 + 异常检测
- 超时保护：工具执行超时自动中断
- 错误恢复：工具失败不崩溃 agent loop，返回错误信息给 LLM

**验证标准**：
- [ ] 同时连接 ≥2 个 MCP Server（OmniMem + 至少一个新 provider）
- [ ] 内置工具 file_read / shell_exec / web_fetch 可用
- [ ] 工具按 read/write/exec/high-risk 分类
- [ ] AUTO 模式下 read 工具直接执行，high-risk 工具要求确认
- [ ] 工具超时后 agent loop 正常恢复
- [ ] 所有工具有对应的单元测试 + 集成测试

**涉及工程领域**：05-Tool（主）、07-Safety（基础分层）

**参考 spec**：[05-tool/README.md](engineering/05-tool/README.md)、[07-safety-guardrails/README.md](engineering/07-safety-guardrails/README.md)

---

### Iteration C: Planning Core — 规划引擎

**主轴**：`04-Planning`　**搭配**：`01-dynamic`（InferenceConfig 动态调整并入此迭代）

**为什么第三**：Planning 的价值建立在 context（A）和 tool space（B）之上。没有好的 context 喂给 LLM，规划不稳定；没有工具，规划只能空转。

**范围**：

规划引擎（04）：
- 意图识别：判断用户请求是"简单问答"还是"多步任务"
  - 简单问答：直接回答，不走 planning
  - 多步任务：生成 plan → 逐步执行 → 汇报结果
- 任务分解：将复杂任务拆成可执行的 step 序列
- Step budget：限制单个任务最大步数，防止无限循环
- Retry budget：单步失败后的重试策略（最多 N 次）
- 进度跟踪：每步执行后更新 state，支持中断恢复

动态推理配置（01-dynamic）：
- 按任务复杂度自动调整 InferenceConfig
  - 简单问答：低 temperature、少 maxTokens
  - 复杂推理：高 temperature、多 maxTokens、开启 ThinkingMode
- ThinkingMode 动态切换：thinking / non-thinking
- 成本感知：预估本轮 token 消耗，余量不足时建议拆分

**验证标准**：
- [ ] 简单问答不触发 planning，多步任务自动分解
- [ ] Step budget 生效：达到上限后终止并汇报
- [ ] 工具调用失败后自动重试（≤ retry budget）
- [ ] InferenceConfig 按任务类型动态切换
- [ ] Token 预估：任务前给出消耗预估

**涉及工程领域**：04-Planning（主）、01-LLM（动态配置）、02-Context（planning context 注入）

**参考 spec**：[04-planning/README.md](engineering/04-planning/README.md)、[01-llm-integration/README.md](engineering/01-llm-integration/README.md)

---

### Iteration D: Operability — 可运维

**主轴**：`08-Observability`　**搭配**：`09-lite`

**为什么在这**：前三个迭代把单 Agent 做强之后，后续扩展（多 Agent / 自进化）没有 observability 不可调、不可诊断。这是扩展层的工程前置。

**范围**：

可观测性（08）：
- OTel 集成：spans + traces + metrics
  - 每次 LLM 调用一个 span（模型、tokens、延迟、finish reason）
  - 每次工具调用一个 span（工具名、耗时、成功/失败）
  - 每轮 agent loop 一个 trace（串联 LLM + 工具调用链）
- Request ID：每次用户输入分配唯一 ID，贯穿整个处理链路
- 结构化 metrics（JSON stdout，已有基础，需扩展）
  - token 消耗统计（累计 / 每轮 / 每次调用）
  - 工具调用频次和成功率
  - 响应延迟分布

配置管理（09-lite）：
- 统一配置文件：`~/.quilin/config.toml`（或 YAML）
  - LLM provider + model + API key
  - Memory 路径
  - 权限模式（auto / confirm）
  - 日志级别
- 环境变量覆盖（已有基础，需规范化）
- `quilin config show` / `quilin config set` CLI 命令

CI/CD（工程保障）：
- GitHub Actions workflow：`.github/workflows/ci.yml`
  - TS：`bun run vitest run`（packages/agent-core）
  - Python：`uv run pytest`（providers/memory）
  - Rust：`cargo test`（crates/，目前为空但预留）
  - 触发条件：push to master + PR
- Lint 检查：Biome（TS）+ Ruff（Python）+ Clippy（Rust）

**验证标准**：
- [ ] LLM 调用和工具调用有 OTel span
- [ ] Request ID 贯穿完整调用链
- [ ] `~/.quilin/config.toml` 可配置 provider / model / 权限模式
- [ ] CI 在 GitHub Actions 上三语言测试全绿
- [ ] `quilin config show` 输出当前配置

**涉及工程领域**：08-Observability（主）、09-Deployment（配置管理）

**参考 spec**：[08-observability/README.md](engineering/08-observability/README.md)、[09-deployment-runtime/README.md](engineering/09-deployment-runtime/README.md)

**CI 特别说明**：CI 不属于 12 领域之一，但它是工程 guardrail。建议与 Iteration A 并行补上，不等 D 才做。在路线图中标注为"并行工程保障"。

---

### Iteration E: Memory Depth & Personality — 记忆深度 + 对话人格

**主轴**：`03-Memory-advanced`　**搭配**：`12-ConversationEng`

**为什么不更早**：Memory 当前瓶颈在使用层（Iter A 解决 context 组装），不在存储层。对话工程脱离 context 和 memory grounding 会流于表面润色。A/B/C/D 完成后，agent 已经"会用记忆"、"能做事"、"能规划"、"可观测"，这时做深度记忆和人格才有真实的体验提升。

**范围**：

记忆深度（03-advanced）：
- OmniMem 4 层分级
  - SHORT — 当前会话消息（已有）
  - MID — Hindsight Reflect 摘要（多轮对话 → 关键点提炼）
  - LONG — 向量索引 + KG 三元组（跨 session 持久化）
  - ULTRA — gbrain 核心经验和模式（最高层压缩）
- 向量检索：embedding + cosine similarity（Python MCP Server）
- Knowledge Graph：三元组存储 + 关系查询（Python MCP Server）
- User Profile Store：主动收集用户身份 / 偏好 / 行为模式
- Auto-reflect：每 N 轮自动生成 session 摘要，提升到 MID 层
- 记忆去重 / 冲突检测 / 遗忘策略

对话工程（12）：
- 6 层活人感架构
  - L1 句子表面：自然语气、避免模板化
  - L2 话轮结构：适时追问、主动引导
  - L3 观点判断：有立场、敢表达
  - L4 关系建模：记住用户偏好、建立关系连续性
  - L5 时间连续性：理解"上次聊到哪了"
  - L6 元层面：自我认知、能解释自己的推理过程
- 3 种风格模式
  - `native` — 原版 LLM 风格
  - `custom` — 用户自定义 persona
  - `alive` — 完整 6 层活人感
- 风格配置开关：`~/.quilin/config.toml` 中 `[conversation]` 节

**验证标准**：
- [ ] 记忆自动从 SHORT 提升到 MID（reflect 生成摘要）
- [ ] 向量检索：语义相似的记忆能被 recall 命中
- [ ] User Profile Store：agent 主动询问并记住用户身份
- [ ] 风格模式切换：`alive` 模式下对话明显更自然
- [ ] 跨 session 关系连续性：重新启动后 agent 知道"上次聊了什么"

**涉及工程领域**：03-Memory（主）、12-ConversationEng（主）、02-Context（memory context 增强）

**参考 spec**：[03-memory/README.md](engineering/03-memory/README.md)、[12-conversation-engineering/README.md](engineering/12-conversation-engineering/README.md)

---

### Iteration F: Scale-Out — 规模化扩展

**主轴**：`06-MultiAgent` + `11-AgentMesh` + `10-SelfEvolution`

**前提条件**：单 Agent 已强（A/B/C）、稳（D）、有深度记忆和人格（E）。多 Agent 和自进化在单 Agent 不够强的情况下只会放大混乱。

**范围**：

多 Agent 编排（06）：
- 同构 spawn：主 Agent 派生相同类型的 Sub-Agent 并行执行
- 异构协作：不同能力的 Agent 协作（如 coder + reviewer + tester）
- 非阻塞 Supervisor：主 Agent 永不阻塞，所有执行委派 Sub-Agent
- Sub-Agent 进度汇报协议（Checkpoint + Heartbeat）
- WebUI 实时进度可视化 + IM 主动推送

Agent Mesh 接入（11）：
- AgentMesh SDK adapter：启动即加入 mesh 网络
- mesh.discover()：发现其他 agent
- mesh.send() / mesh.receive()：跨 agent 消息通信
- 能力声明与查询：每个 agent 注册自己的 capability

自进化（10）：
- 轨迹分析：记录每次任务的完整执行路径
- Scaffold 自修改：基于轨迹分析自动调整 system prompt / 工具配置
- 技能自创：识别重复模式 → 封装为新工具
- User Insight Engine：用户行为模式挖掘 → 主动洞察 → Aha Moment
- 空闲自进化经济学：两种计费模式（订阅闲置配额 / API 每日预算）
- 热更新系统 + 更新后主动告知用户

**验证标准**：
- [ ] 主 Agent 派生 Sub-Agent 并行执行，主线程不阻塞
- [ ] mesh.discover() 能看到其他 agent
- [ ] 自进化运行 10+ 次后自动调整系统提示，任务成功率可测量
- [ ] User Insight Engine 基于积累数据产生用户洞察
- [ ] 空闲自进化运行后，下次上线时收到活动摘要
- [ ] 热更新后主动通知用户变更内容

**涉及工程领域**：06-MultiAgent、11-AgentMesh、10-SelfEvolution、08-Observability（Dashboard）、09-Deployment（热更新）

**参考 spec**：[06-multi-agent/README.md](engineering/06-multi-agent/README.md)、[11-agent-mesh/README.md](engineering/11-agent-mesh/README.md)、[10-self-evolution/README.md](engineering/10-self-evolution/README.md)

---

## 模块依赖图

```
已具备底座（Phase 0）
├── 01-lite: Vercel AI SDK + StreamingLLMClient
├── 03-lite: SQLite + FTS5 OmniMem
├── 05-lite: ToolRouter + MCP Client Bridge
└── REPL / checkpoint / justfile / pino JSON 日志

核心智能层（Iter A → B → C，有依赖顺序）
├── 02-Context 是最中心的上游
│   ├── 消费 03-Memory（recall 结果注入 context）
│   ├── 直接影响 04-Planning（context 质量决定 plan 质量）
│   └── 也是 12-ConversationEng 的地基
├── 05-Tool + 07-Safety 是一对绑定模块
│   ├── 更强的工具没有 safety = 风险放大器
│   └── safety 没有 tool taxonomy = 空规则
├── 04-Planning 依赖 02 + 05
│   ├── 没 context → 规划不稳
│   └── 没 tools → 规划空转
└── 01-dynamic（InferenceConfig）是横切能力，并入 04

工程保障层（Iter D，与 A 并行启动 CI 部分）
├── 08-Observability 是 06/10/11 的前置
│   └── 没 traces/metrics → 多 Agent 和自进化不可调
├── 09-Deployment 依赖一定程度的 08
└── CI 不属于 12 领域，但是工程 guardrail

深度体验层（Iter E，依赖 A/B/C/D 完成）
├── 03-advanced 依赖 02（context 使用层先就位）
└── 12-ConversationEng 依赖 02 + 03

扩展层（Iter F，依赖单 Agent 已强+稳+可观测）
├── 06-MultiAgent 依赖 02/04/05/07/08
├── 11-AgentMesh 依赖 06 + 08 + 09
└── 10-SelfEvolution 依赖 07 + 08 + 09
```

---

## 12 工程领域 × 迭代映射

| # | 领域 | Phase 0 ✅ | Iter A | Iter B | Iter C | Iter D | Iter E | Iter F |
|---|------|-----------|--------|--------|--------|--------|--------|--------|
| 01 | LLM 接入 | LLMClient + Streaming | — | — | 动态 InferenceConfig + ThinkingMode | — | — | — |
| 02 | 上下文 | BasicContextManager（单源） | **多源组装 + budget + temporal** | — | planning context 注入 | — | memory context 增强 | — |
| 03 | 记忆 | SQLite + FTS5 recall | recall 集成到 context | — | — | — | **4 层 + 向量 + KG + Profile** | — |
| 04 | 规划 | — | — | — | **意图识别 + 任务分解 + budget** | — | — | 动态重规划 |
| 05 | 工具 | ToolRouter + MCP Client | — | **多 MCP + 内置工具 + 分类** | — | — | — | 浏览器 + CLI-Anything + 自创 |
| 06 | 多 Agent | — | — | — | — | — | — | **同构 spawn + Supervisor** |
| 07 | 安全护栏 | — | — | **权限三级 + pre/post hook** | — | — | — | 红队自动化 |
| 08 | 可观测性 | pino JSON 日志 | — | — | — | **OTel + metrics + request ID** | — | Dashboard + 进度面板 |
| 09 | 部署运行时 | justfile + REPL CLI | — | — | — | **配置管理 + CI** | — | 热更新 |
| 10 | 自进化 | — | — | — | — | — | — | **轨迹分析 + 自修改 + Insight** |
| 11 | Agent Mesh | — | — | — | — | — | — | **meshd 接入** |
| 12 | 对话工程 | — | — | — | — | — | **6 层活人感 + 风格模式** | — |

---

## Benchmark 参赛策略

Benchmark harness 不绑定特定迭代，而是**能力就绪即提交**：

| Benchmark | 前置能力 | 最早可参赛 |
|-----------|---------|-----------|
| SWE-bench Verified / Pro | 05-Tool（文件+命令）+ 04-Planning | Iter C 完成后 |
| BFCL v4 | 05-Tool（多工具调用）| Iter B 完成后 |
| GAIA | 02 + 04 + 05（完整 harness）| Iter C 完成后 |
| τ-bench | 05-Tool | Iter B 完成后 |
| AgentHarm / InjecAgent | 07-Safety | Iter D 完成后 |
| WebArena | 05-Tool（浏览器）| Iter F |
| ARC-AGI | 04-Planning（深度推理）| Iter F |
