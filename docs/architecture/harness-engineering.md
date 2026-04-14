# Harness Engineering（脚手架工程）

> Quilin Agent 的顶层架构概念。本文档综合了 OpenAI、Anthropic、Martin Fowler、LangChain、Manus 等行业最前沿的 harness 工程实践，将散落在 11 个工程领域中的 harness 相关设计统一为一个显式的一等架构理念。

---

## 一、什么是 Harness Engineering

**Harness**（脚手架）是包裹在 LLM 外面的一切——system prompt、工具定义、上下文组装、记忆注入、安全护栏、推理策略、Agent Loop。它决定了同一个 LLM 在不同场景下表现天差地别。

行业已形成共识定义：

> **"Harness engineering is the design and implementation of systems that constrain what an AI agent can do, inform the agent about what it should do, verify that the agent did it correctly, and correct the agent when it goes wrong."** — nxcode.io
>
> **"Everything in an AI agent except the model itself."** — HumanLayer
>
> **"The model is a CPU. Your agent needs an operating system."** — snowan.gitbook.io

**Harness Engineering 不是新概念**——它是系统提示工程、上下文工程、工具工程、记忆工程等的统称。但将它显式命名为一个工程学科，意味着：

1. **它是可系统化设计的**，不是靠直觉调 prompt
2. **它是可测量的**，有明确的性能指标（任务成功率、token 效率、用户满意度）
3. **它是可进化的**——Quilin 的自进化系统本质上就是在自动优化 harness

### 与相关学科的区分

| 概念 | 范围 | 关注点 |
|------|------|--------|
| Prompt Engineering | 单次交互 | 写好一次 prompt |
| Context Engineering | 模型上下文窗口 | 喂给模型的信息 |
| **Harness Engineering** | **整个 Agent 系统** | **环境、约束、反馈、生命周期** |
| Agent Engineering | Agent 内部架构 | 内部路由和设计 |
| Platform Engineering | 基础设施 | 部署、扩缩容、运维 |

Harness Engineering 包含 Context Engineering，并吸纳 Prompt Engineering 的模式，但运作在系统层面。

---

## 二、行业实证

### 2.1 Harness 改变一切的证据

| 来源 | 实验 | 结果 |
|------|------|------|
| **LangChain OPENDEV** | 仅改 harness，模型不变 | Terminal Bench 2.0 从 52.8% → 66.5%（**+13.7 pp**），排名从 Top 30 → Top 5 |
| **OpenAI 内部产品** | 全 agent 生成，0 行人写代码 | 5 个月，1M+ 行代码，~1500 PR，约 1/10 传统时间 |
| **Anthropic C 编译器** | 16 个 Claude 并行 | 2000 sessions，2B input tokens，$20K → 100K 行 Rust 编译器，99% 测试通过 |
| **Stripe Minions** | 交替确定性（lint/test）与 agentic（写代码）节点 | 1000+ PR/周 |
| **Manus** | 6 个月 5 次重写 | 每次重写都在**删减**复杂度，模型越强 harness 越轻 |
| **HumanLayer Terminal Bench** | 同一模型在不同 harness 中 | Opus 4.6 在 Claude Code 中排 #33，换 harness 后排 #5 |

### 2.2 缺乏 Harness 的代价（生产力悖论）

| 来源 | 发现 |
|------|------|
| **METR 研究**（246 真实任务） | 有 AI 辅助的开发者反而**慢 19%**，但自认为快了 20% |
| **DORA 2024** | AI 采用率 +25pp，组织吞吐量 -1.5%，稳定性 -7.2% |
| **Faros AI**（10,000 开发者） | 任务完成 +21%，PR 合并 +98%，但 review 时间 +91% |
| **ETH Zurich** | LLM 生成的 agentfile 反而**降低**性能，多耗 20%+ token |

**结论**：没有 harness 的 AI 工具产生"个人层面的收益幻觉，组织层面的实际损失"。Harness 是将 AI 能力转化为真实生产力的必要条件。

---

## 三、Harness 控制模型

### 3.1 前馈控制 + 反馈控制（Martin Fowler 框架）

Martin Fowler 提出 Harness 的核心是两种控制机制的平衡：

```
                    ┌──────────────────────────────────┐
                    │        Harness 控制模型           │
                    │                                    │
                    │   ┌─────────────┐ ┌────────────┐  │
                    │   │  Feedforward│ │  Feedback   │  │
                    │   │  前馈（引导）│ │  反馈（传感）│  │
                    │   └──────┬──────┘ └──────┬─────┘  │
                    │          │                │         │
                    │          ▼                ▼         │
                    │   行动前预防性       行动后观察性     │
                    │   提高一次成功率     支撑自纠正      │
                    │                                    │
                    │   例：文档、架构规则  例：测试、lint  │
                    │     bootstrap 脚本     代码审查      │
                    └──────────────────────────────────┘
```

**关键平衡**：只有反馈 → 反复犯错；只有前馈 → 规则得不到验证。两者缺一不可。

### 3.2 计算型控制 vs 推理型控制

| 维度 | 计算型（Computational） | 推理型（Inferential） |
|------|----------------------|---------------------|
| 基础 | 确定性，CPU | 语义型，GPU/NPU |
| 速度 | 毫秒到秒 | 秒到分钟 |
| 可靠性 | 高（确定性结果） | 概率性（但语义丰富） |
| 例子 | 测试、lint、类型检查、结构分析 | 代码审查 agent、LLM-as-judge |
| 成本 | 低 | 高 |

**策略**：计算型控制保效率，推理型控制保语义。优先使用计算型，推理型仅在计算型无法覆盖时使用。

### 3.3 可验证性等级（Infralovers 框架）

Harness 的效果与任务的可验证性直接相关：

| 等级 | 类型 | 验证方式 | Harness 效果 |
|------|------|---------|-------------|
| L1 | 形式化（数学证明） | 精确自动化 | 极强 |
| L2 | 可测试（代码、CI/CD） | 自动测试，秒级反馈 | 强 |
| L3 | 规则型（合规、编码标准） | 规则检查，需人工审核 | 中等 |
| L4 | 启发式（客服、研究、内容） | 评估模型/人工反馈 | 有限 |
| L5 | 不可验证（创意策略、伦理决策） | 无客观裁判 | 极弱 |

**Quilin 的定位**：主要覆盖 L2-L3（代码任务 + 规则验证），通过自进化系统探索 L4 边界。

---

## 四、4 种生产架构模式

行业已收敛到 4 种主要的 harness 架构模式：

### 4.1 单线程主循环（Claude Code 模式）

```
while (!done) {
    response = llm.chat(messages, tools)
    if (response.tool_calls) execute(tools)
    messages.append(result)
}
```

- 一个扁平的消息列表，无复杂线程
- Sub-agent 深度限制为 1
- **适用**：大多数任务，提供可控的自主性

### 4.2 中间件栈（LangChain DeepAgents 模式）

```
Agent Request
  → LocalContextMiddleware    (代码库映射)
  → LoopDetectionMiddleware   (防死循环)
  → ReasoningSandwichMiddleware (计算优化)
  → PreCompletionChecklistMiddleware (验证)
  → Agent Response
```

- 可组合的 hook：`before_agent`, `wrap_model_call`, `before_tool_call`, `after_tool_call`
- **适用**：需要细粒度循环控制和模块化能力组合

### 4.3 协议优先应用服务器（OpenAI Codex 模式）

三个原语：**Thread**（持久会话）→ **Turn**（一次工作单元）→ **Item**（原子 I/O）

- JSON-RPC over stdio 实现 client-server 通信
- 同一个 harness 驱动 CLI、IDE、Web 三种界面
- **适用**：多表面部署（CLI、IDE、Web）

### 4.4 初始化器 + 工作者（长任务模式）

```
Initializer Agent (运行一次)
  → 创建 init.sh, feature-list.json, 初始 commit
  → 建立环境和规范

Worker Agent (每个 session)
  → 读取 progress 文件和 git 日志
  → 验证已有功能
  → 实现一个 feature
  → 更新 progress + git commit
```

- 进度通过持久化文件跟踪（claude-progress.txt, todo.md）
- **适用**：跨越数小时/数天、超出单个上下文窗口的任务

### Quilin 的选择

Quilin 采用**模式 1（单线程主循环）作为核心**，同时融合模式 2 的中间件思想（Guardrails middleware）和模式 4 的长任务支持（checkpoint + 断点续行）：

```
Agent Loop (模式 1)
  + Guardrails pre/post hooks (模式 2 的中间件)
  + SQLite checkpoint + progress files (模式 4 的状态持久化)
  + Agent Mesh SDK adapter (独有：P2P 异构互联)
```

---

## 五、Quilin 的 Harness 架构

Quilin 的整体架构就是一个 harness。E-T-C-S-L-V 六组件 + 11 个工程领域共同构成了这个 harness：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Quilin Harness                                │
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  Agent Loop (< 200 行 TS)                                │  │
│   │  while (!state.isTerminal) {                              │  │
│   │      prompt = assemble(system, memories, context, msgs)   │  │
│   │      response = llm.chat(prompt, tools)                   │  │
│   │      if (response.tool_calls) execute(tools)              │  │
│   │      checkpoint(state)                                    │  │
│   │  }                                                        │  │
│   └──────────────────────────────────────────────────────────┘  │
│        │              │              │              │             │
│   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐       │
│   │    C    │   │    T    │   │    V    │   │    S    │       │
│   │ Context │   │  Tools  │   │ Verify  │   │  State  │       │
│   └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘       │
│        │              │              │              │             │
│   ╔════╧══════════════╧══════════════╧══════════════╧═════════╗ │
│   ║              Harness 组成层                                ║ │
│   ║                                                            ║ │
│   ║  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────┐   ║ │
│   ║  │ System  │ │ Memory  │ │ Tool    │ │  Safety      │   ║ │
│   ║  │ Prompt  │ │ Inject  │ │ Defs    │ │  Guardrails  │   ║ │
│   ║  │  组装   │ │  注入   │ │  定义   │ │   护栏       │   ║ │
│   ║  └─────────┘ └─────────┘ └─────────┘ └──────────────┘   ║ │
│   ║  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────┐   ║ │
│   ║  │ Strategy│ │ Token   │ │ Obs     │ │  Self-Evolve │   ║ │
│   ║  │ Switch  │ │ Budget  │ │ Trace   │ │  Scaffold    │   ║ │
│   ║  │ 策略切换│ │ 预算管理│ │ 可观测  │ │  自修改      │   ║ │
│   ║  └─────────┘ └─────────┘ └─────────┘ └──────────────┘   ║ │
│   ╚════════════════════════════════════════════════════════════╝ │
│                              │                                   │
│                         ┌────▼────┐                              │
│                         │   LLM   │  ← 任意模型（via litellm）   │
│                         └─────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

**核心洞察**：LLM 是发动机，Harness 是整辆车。用户体验取决于整辆车，不只是发动机。

---

## 六、Harness 的 8 个组成部分

### 6.1 System Prompt 组装

**对应领域**：[02-上下文工程](../engineering/02-context/README.md) | **控制类型**：前馈

LLM 看到的第一段文字决定了它的行为模式。system prompt 不是静态模板，而是每次调用动态组装的产物：

```
system_prompt = base_identity            # 你是 Quilin Agent
             + project_context           # 当前项目的 CLAUDE.md / 目录结构
             + memory_context            # 召回的相关记忆
             + tool_descriptions         # 可用工具的描述
             + active_constraints        # 当前活跃的安全约束
             + team_context              # mesh 上的团队信息（如果有）
```

**行业洞察**：
- **给 agent 一张地图，不是一本 1000 页的手册**（OpenAI）。AGENTS.md 应是目录，不是百科全书。
- **人写的指令优于 LLM 生成的**（ETH Zurich）。LLM 生成的 agentfile 降低性能且多耗 20%+ token。
- **保持简短**（HumanLayer）。HumanLayer 的 CLAUDE.md 不超过 60 行。
- **渐进式披露**（OpenAI/HumanLayer）。agent 从小的稳定入口点开始，按需加载更深的文档。

### 6.2 记忆注入

**对应领域**：[03-记忆工程](../engineering/03-memory/README.md) | **控制类型**：前馈

Harness 在每轮推理前从 OmniMem 召回相关记忆，注入上下文。这让 LLM "记住"跨会话的知识。

4 层记忆对 harness 的影响：
- **SHORT**（当前对话）→ 直接在消息数组中
- **MID**（跨轮摘要）→ 注入 system prompt 的 memory 区域
- **LONG**（向量+KG）→ 按相关性检索后注入
- **ULTRA**（gbrain）→ 深层语义理解，影响策略选择

**行业洞察**：
- **结构化笔记 > 全量保留**（Anthropic）。agent 写笔记到外部文件（如 claude-progress.txt），按需读取，不在上下文中保留所有历史。
- **文件系统就是外部记忆**（Manus）。plan、progress、中间结果太大放不进上下文时，写到文件再读回来。

### 6.3 工具定义

**对应领域**：[05-工具工程](../engineering/05-tool/README.md) | **控制类型**：前馈 + 反馈

Harness 决定 LLM 能调用哪些工具、工具描述怎么写、参数怎么定义。**工具描述的质量直接影响 LLM 的工具选择正确率**。

**行业洞察**：
- **工具越少越好**（Manus/HumanLayer）。Vercel 发现删掉 80% 的工具后 agent 表现**更好**。工具过多推 agent 进"笨蛋区"。
- **掩码而非删除**（Manus）。移除工具会使 KV-cache 失效并混淆模型。用前缀 logit 掩码（如 `browser_*`, `shell_*`）替代。
- **CLI 优于 MCP**（HumanLayer）。对于常见操作（GitHub、Docker、数据库），经过训练的 CLI 工具比冗长的 MCP server 更高效。
- **自定义 lint 错误 = 隐式修复指令**（OpenAI）。lint 错误信息写成修复指导，agent 读到错误就知道怎么改。

### 6.4 安全护栏

**对应领域**：[07-安全护栏工程](../engineering/07-safety-guardrails/README.md) | **控制类型**：前馈 + 反馈

```
输入 → [Guard: 注入检测 + PII 脱敏] → LLM → [Guard: 安全检查 + 格式校验] → 输出
                                         │
                                    [Guard: 步骤验证 — 每次工具调用后验证结果合理性]
```

**行业洞察**：
- **Stripe 策略**：交替确定性节点（lint/test）和 agentic 节点（写代码），强制验证关卡，agent 不得绕过。重试上限 2 次，超过即上报人类。
- **OpenAI 策略**：刚性分层架构（Types → Config → Repo → Service → Runtime → UI），单向依赖，自定义 linter + 结构测试机械化执行。
- **权限分级**（多来源共识）：Safe（read/list → 自动通过）、Moderate（write/edit → 确认或白名单）、Dangerous（shell/网络/git push → 明确授权）。

### 6.5 推理策略切换

**对应领域**：[04-规划工程](../engineering/04-planning/README.md) | **控制类型**：前馈

| 任务类型 | 策略 | 说明 |
|---------|------|------|
| 简单问答 | Direct | 不规划，直接回答 |
| 单步工具 | ReAct | 思考→行动→观察 |
| 多步任务 | Plan & Execute | 先规划 DAG，再逐步执行 |
| 探索性任务 | Tree Search | 多路径探索，回溯 |

**行业洞察**：
- **"Reasoning Sandwich"**（LangChain）：在规划和验证两端分配最大算力，中间执行阶段用较少算力。
- **自评估无效，外部评估有效**（Anthropic）：agent 会自信地赞扬自己的工作。需要独立的 evaluator agent。

### 6.6 Token 预算管理

**对应领域**：[02-上下文工程](../engineering/02-context/README.md) | **控制类型**：前馈

Harness 管理有限的 token 窗口。这是行业公认的最关键也最困难的 harness 组件之一。

**行业洞察（5 条核心教训，来自 Manus / Anthropic）**：

1. **KV-Cache 经济学主导一切**：cached input tokens 比 uncached 便宜 10 倍。在 100:1 的输入输出比下，cache 效率决定总成本。这是最重要的单一指标。
2. **只追加，不修改**：永远不修改之前的消息——这会使下游 KV-cache 失效。使用确定性 JSON 序列化和稳定的 key 排序。
3. **掩码工具，不删除工具**：移除工具使 cache 失效且混淆模型。用 logit mask 替代。
4. **文件系统就是外部记忆**：plan / progress / 中间结果写到文件中。压缩必须可逆：即使删了内容也要保留 URL/路径。
5. **任务复述操纵注意力**：50+ 工具调用后 agent 会迷失目标。强制持续重写 todo.md 文件，保持目标在最近的注意力窗口中。

**Quilin 扩展**：
- 85-92% 容量阈值触发自动压缩
- 任务开始前预估 token 消耗，余量不足时主动建议拆分

### 6.7 可观测性

**对应领域**：[08-可观测性工程](../engineering/08-observability/README.md) | **控制类型**：反馈

Harness 的每一步都产生 trace，让开发者能看到和 agent 看到了什么上下文、为什么选择这个工具、执行花了多久、总共花了多少 token / 钱。

**行业洞察**：
- **OpenAI 的可观测性栈**：每个 worktree 一套完整的本地可观测性栈（Victoria Logs + Metrics + Traces），agent 用 LogQL/PromQL/TraceQL 查询，验证后拆除。
- **评估驱动开发**（Anthropic）：先写 eval 再让 agent 实现功能。Eval 是产品团队和研究团队之间最高带宽的沟通渠道。
- **Harness-only 基准测试**（snowan）：模型保持不变，只改 harness，测量 delta。这隔离了 harness 对能力的贡献。

### 6.8 自进化 Scaffold

**对应领域**：[10-自进化工程](../engineering/10-self-evolution/README.md) | **控制类型**：前馈 + 反馈

**这是 Quilin 的核心差异化**。Harness 不是静态的——它能自己改自己：

```
运行任务 → 记录轨迹 → 分析失败 → 修改 scaffold → 验证改进 → 保留/回滚
```

**行业洞察**：
- **Entropy 管理 = 垃圾回收**（OpenAI）：agent 复制仓库中已有的模式——包括不好的模式。需要定期运行清理 agent 扫描偏差、更新质量评分、开重构 PR。OpenAI 团队曾花 20% 时间清理 "AI slop"，后来自动化了这个过程。
- **Build to Delete**（多来源共识）：每个 harness 组件在下个模型发布时就可能成为负担。Manus 在 6 个月内做了 5 次重写，每次都在删减复杂度。模型越强，需要的 harness 越轻。
- **假设过时性**（Anthropic）：harness 中的每个组件都编码了一个关于"模型做不到什么"的假设。这些假设需要持续压测。Sonnet 4.5 需要的上下文焦虑 workaround，在 Opus 4.5 中就不需要了。

加上**用户自助吸收**（吸收 GitHub 仓库的能力来升级自己的 harness），形成官方+用户双向进化的生态。

---

## 七、Harness 设计原则

从 16 篇文献中提炼的 9 条核心设计原则：

### 原则 1：约束悖论 — 约束越多，能力越强

> "The more you constrain the agent, the more capable it becomes."

所有成功团队都在限制 agent 的自由度，而非扩展它：OpenAI 执行刚性架构、Stripe 强制 lint、Manus 删工具不加工具、Vercel 剥离到最简。

### 原则 2：Build to Delete — 为删除而构建

每个 harness 组件在下一代模型发布时就是负债。设计时就为模块化拆除做准备。不要过度工程化控制流——模型升级时脆弱的"智能"逻辑会断裂。

### 原则 3：地图而非手册 — 渐进式披露

给 agent 一张小地图（AGENTS.md < 100 行），指向更深的文档。不要给它 1000 页的手册：
- 上下文是稀缺资源。巨大的指令文件挤掉了任务、代码和相关文档。
- 太多指导 = 没有指导。当一切都"重要"时，什么都不重要。
- 静态大文件会腐烂。agent 分不清什么还有效。

### 原则 4：仓库即真理之源

agent 看不到的东西不存在。Slack 讨论、Google Docs、人脑中的知识——如果不在仓库里，就对 agent 不可见。所有架构决策、规范、部署流程必须版本控制。

### 原则 5：Agent 可读性优先

代码库首先为 agent 的可读性优化，而非人类的审美偏好。只要输出正确、可维护、对未来的 agent 运行可读，就够了。

### 原则 6：机械化执行，局部自治

中央层面执行边界（约束、正确性、可重现性），局部层面允许自治（解决方案的表达方式）。这与大型工程平台组织的管理方式相同。

### 原则 7：最小化然后迭代

> "Start simple. Observe failures. Add infrastructure in response to real problems, not anticipated ones."

最小可行 harness：200-500 行代码，2-4 小时。先跑起来，观察失败，针对性加固。不要预设计理想 harness。

### 原则 8：反馈循环速度决定效果

LangChain OPENDEV 赢了，因为 Terminal Bench 2.0 秒级反馈。如果反馈循环需要数小时或数天，harness 模式在真实条件下崩溃。**第一步不是建 harness，而是缩短反馈循环。**

### 原则 9：Harnessability — 可治理性

代码库的结构属性决定了 agent 能被治理的程度（Martin Fowler 称之为"环境 affordances"）：
- 强类型系统 → 自动类型检查传感器
- 清晰模块边界 → 架构约束可执行
- 框架抽象 → 减少 agent 决策面
- 显式约定 → 可检测的模式

---

## 八、Harness 成熟度模型

| 级别 | 范围 | 投入 | 特征 |
|------|------|------|------|
| **L1 个人** | 单开发者 | 2-4 小时 | Agent Loop + 3-5 工具 + CLAUDE.md + pre-commit hooks + 测试套件 |
| **L2 团队** | 小团队 | 1-2 天 | AGENTS.md + CI 中的架构约束 + 共享 prompt 模板 + 文档即代码验证 |
| **L3 生产** | 组织级 | 1-2 周 | 自定义中间件 + 可观测性集成 + 定期熵管理 + harness 版本控制 + A/B 评估 + 升级策略 |
| **L4 自进化** | 持续进化 | 持续 | 轨迹分析 + scaffold 自修改 + 技能自创 + 用户自助吸收 + harness-only 基准测试 |

**Quilin 的目标**：直接从 L1 设计到 L4 的架构，但按 L1 → L2 → L3 → L4 渐进实施。

---

## 九、常见反模式

从行业经验中总结的 10 大错误：

| # | 反模式 | 正确做法 |
|---|--------|---------|
| 1 | 在理解失败之前过度工程化 | 先建最小 harness，观察失败再加固 |
| 2 | 上下文灌水 | 精准选取 > 全面倾倒 |
| 3 | 静态 harness | 为定期重写而设计（模型升级时） |
| 4 | 过早复杂的多 agent 编排 | 从单线程开始 |
| 5 | 只测试 happy path | 测试溢出、失败、死循环、部分完成 |
| 6 | 超大单体 prompt | 分层 prompt 便于调试 |
| 7 | 知识不可被 agent 访问 | 仓库为唯一真理之源 |
| 8 | 从上下文中移除错误信息 | 错误信息提供隐式反馈，保留它们 |
| 9 | 完成前无验证关卡 | 任务退出前要求验证 |
| 10 | 忽视 KV-cache 经济学 | 这决定 10 倍的成本差异 |

---

## 十、核心度量

| 指标 | 定义 | 目标 | 来源 |
|------|------|------|------|
| KV-Cache 命中率 | 命中缓存的 token / 总输入 token | > 80% | Manus, snowan |
| 任务成功率 | 一次交互完成用户目标的比例 | > 85% | 内部 |
| Token 效率 | 有效 token / 总 token | > 60% | 内部 |
| 首次正确率 | 不需要重试就正确完成的比例 | > 70% | 内部 |
| 验证完成率 | 提交前完成自检的比例 | > 95% | snowan |
| 工具选择正确率 | 第一次就选对工具的比例 | > 90% | 内部 |
| 护栏假阳性率 | 合法操作被误拦截的比例 | < 1% | 内部 |
| 死循环频率 | 重复失败方案的比例 | < 5% | snowan |
| 重试至解决比 | 每个任务的 CI 轮次 | < 2 | snowan |
| 自进化改进率 | 自进化后任务成功率的提升幅度 | > 5%/月 | 内部 |

**Harness-only 基准方法**：保持模型不变，只改 harness 配置，测量 delta。这是隔离 harness 贡献的唯一可靠方式。

---

## 十一、Harness 与模型的关系

```
                        Harness 质量
                    低              高
                ┌──────────┬──────────┐
        强      │  浪费     │  最强     │
  模型  模型    │  好模型   │  Quilin   │
  能力          │  烂包装   │  的目标   │
                ├──────────┼──────────┤
        弱      │  最弱     │  超水平   │
        模型    │          │  发挥     │
                └──────────┴──────────┘
```

**Quilin 的策略**：把 harness 做到极致，让任何模型都能超水平发挥。模型是用户选的（via litellm），harness 是我们的核心竞争力。

**行业验证**：LangChain 在同一模型上仅改 harness 就提升 13.7 pp。HumanLayer 发现 Opus 4.6 在不同 harness 中的排名从 #33 跳到 #5。这证明 harness 质量的影响可以超过模型换代的影响。

---

## 十二、11 个工程领域的 Harness 角色映射

| 领域 | Harness 角色 | 控制类型 | 重要性 |
|------|-------------|---------|--------|
| 01-LLM 接入 | 发动机接口（连接任意模型） | — | 基础 |
| **02-上下文** | **整车底盘（prompt 组装 + token 预算 + KV-cache）** | **前馈** | **核心** |
| **03-记忆** | **导航系统（跨会话知识积累）** | **前馈** | **核心** |
| **04-规划** | **自动驾驶（策略选择 + 任务分解 + 重规划）** | **前馈** | **核心** |
| **05-工具** | **手脚（与外界交互 + 自检能力）** | **前馈+反馈** | **核心** |
| 06-多 Agent | 车队协作（多车协同 + 上下文防火墙） | 前馈+反馈 | 高级 |
| **07-安全护栏** | **安全带 + ABS（约束即生产力）** | **前馈+反馈** | **核心** |
| 08-可观测性 | 仪表盘（运行状态可见 + eval 驱动） | 反馈 | 重要 |
| 09-部署运行时 | 车库和加油站（运行环境 + 熵管理） | — | 基础 |
| **10-自进化** | **自动调校（harness 自己改自己 + 用户自助吸收）** | **前馈+反馈** | **核心差异化** |
| 11-Agent Mesh | 车联网（与其他 agent 通信） | — | 内置能力 |

---

## 十三、与竞品的 Harness 对比

| Harness 维度 | Claude Code | Codex | LangChain | Stripe | Manus | **Quilin** |
|-------------|------------|-------|-----------|--------|-------|-----------|
| 架构模式 | 单线程主循环 | 协议优先 App Server | 中间件栈 | 确定性/agentic 交替 | 单线程 + 文件外存 | 主循环 + 中间件 hook + checkpoint |
| Prompt 组装 | 极强（详尽 system prompt + CLAUDE.md） | AGENTS.md 作为目录 | 分层 prompt | Blueprint 工作流 | KV-cache 优先 | 动态组装 + token 预算 + cache 优化 |
| 记忆 | CLAUDE.md（文件级） | AGENTS.md + docs/ | Agent State | — | 文件系统外存 + todo 复述 | 4 层 + KG + 自反思 |
| 工具管理 | 精心设计（ACI 原则） | 最小工具集 | 可组合 hook | 500+ MCP 工具 | 删掉 80% 更好 | 4 类动作空间 + 自创工具 |
| 安全 | 权限提示 + hooks | OS 级沙箱 | 中间件 | 强制验证 + 重试上限 2 | — | 4 层验证 + 步骤验证 + 元验证 |
| 策略切换 | 无（固定 ReAct） | 无 | Reasoning Sandwich | 无 | 无 | 按任务类型动态切换 |
| 上下文经济学 | 基础 | Thread/Turn/Item | 循环检测 | — | 极致（KV-cache 优先，掩码工具，复述） | KV-cache + 压缩 + 预估 + 掩码 |
| 熵管理 | 无 | 无 | 无 | — | 定期重写删减 | 定期 + 自进化 |
| 可观测性 | 基础日志 | App Server 事件流 | trace | — | — | OTel 全链路 + eval 驱动 |
| **自进化** | **无** | **无** | **无** | **无** | **重写删减（人工）** | **轨迹分析 + scaffold 自修改 + 用户自助吸收** |

---

## 十四、参考来源

| # | 来源 | 核心贡献 |
|---|------|---------|
| 1 | [OpenAI: Harness Engineering](https://openai.com/index/harness-engineering/) | 零人写代码实验、仓库即真理之源、agent 可读性、熵管理 |
| 2 | [OpenAI: Unlocking the Codex Harness](https://openai.com/index/unlocking-the-codex-harness/) | Thread/Turn/Item 协议原语、JSON-RPC App Server 架构 |
| 3 | [Martin Fowler: Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) | 前馈/反馈控制模型、计算/推理控制、Harnessability 概念 |
| 4 | [HumanLayer: Skill Issue](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents) | 6 大组件、上下文防火墙、ETH Zurich 研究引用 |
| 5 | [nxcode.io: Complete Guide](https://www.nxcode.io/resources/news/harness-engineering-complete-guide-ai-agent-codex-2026) | 三支柱（上下文/约束/熵管理）、三成熟度级别、实战案例 |
| 6 | [snowan: How to Build Agent Harness](https://snowan.gitbook.io/study-notes/ai-blogs/how-to-build-agent-harness) | 六层架构、四种模式、5 条上下文教训、10 大错误、5 团队经验 |
| 7 | [Infralovers: Why the Frame Matters](https://www.infralovers.com/blog/2026-03-13-harness-engineering-rahmen-wichtiger-als-modell/) | 生产力悖论、可验证性等级、METR/DORA 数据 |
| 8 | [Anthropic: Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 初始化器+编码器模式、进度文件、session 启动仪式 |
| 9 | [Anthropic: Building C Compiler](https://www.anthropic.com/engineering/building-c-compiler) | 16 agent 并行、文件锁任务分配、测试驱动 agent |
| 10 | [Anthropic: Managed Agents](https://www.anthropic.com/engineering/managed-agents) | Brain/Hands/Session 解耦、惰性供给、假设过时性 |
| 11 | [Anthropic: Harness Design Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 多 agent 专业化、Sprint 契约、自评估无效 |
| 12 | [Anthropic: Demystifying Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Eval 框架、pass@k/pass^k、评估驱动开发 |
| 13 | [Anthropic: Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 上下文有限资源理论、JIT 检索、sub-agent 隔离 |
| 14 | [Zhang Handong: Harness Engineering from CC](https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/) | Claude Code 7 论文框架、微压缩、YOLO 分类器 |
