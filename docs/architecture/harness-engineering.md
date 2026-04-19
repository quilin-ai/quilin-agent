# Harness Engineering（脚手架工程）

> Quilin Agent 的顶层架构概念。详细论证与行业实证见 [overview.md 附录 A](./overview.md#附录-a-e-t-c-s-l-v-历史分类) 与 `docs/research/`。对话工程作为 `02-context/conversation-engineering/` 子模块，Iter F 解冻。
>
> **小节编号说明**：§二/六/十二/十四 已合并到 [overview.md 附录 A](./overview.md#附录-a-e-t-c-s-l-v-历史分类) 与各 `engineering/*/README.md`，编号保留原位以便回溯外链锚点（§三/四/七/十三）。

---

## 一、什么是 Harness Engineering

**Harness**（脚手架）= 包裹在 LLM 外的一切：system prompt、工具定义、上下文组装、记忆注入、安全护栏、推理策略、Agent Loop。

> "Harness engineering is the design and implementation of systems that constrain what an AI agent can do, inform the agent about what it should do, verify that it did it correctly, and correct it when it goes wrong." — nxcode.io

意义：harness 是**可系统化设计、可测量、可进化**的工程学科。LangChain 仅改 harness 就让 Terminal Bench 从 52.8%→66.5%（+13.7 pp），HumanLayer 验证同一 Opus 4.6 从排名 #33 跃至 #5——harness 影响可超过模型换代。

| 概念 | 范围 | 关注点 |
|------|------|--------|
| Prompt Engineering | 单次交互 | 写好一次 prompt |
| Context Engineering | 模型窗口 | 喂给模型的信息 |
| **Harness Engineering** | **整个 Agent 系统** | **环境、约束、反馈、生命周期** |
| Platform Engineering | 基础设施 | 部署、运维 |

---

## 三、Harness 控制模型

**前馈 × 反馈**（Martin Fowler 框架）：只有反馈→反复犯错；只有前馈→规则未验证。两者缺一不可。前馈例：文档、架构规则、bootstrap 脚本；反馈例：测试、lint、代码审查。

**计算型 vs 推理型**：计算型（确定性、毫秒级、高可靠，如 lint/类型检查）保效率；推理型（LLM-as-judge、秒到分钟、概率性）保语义。优先计算型，推理型补盲区。

**可验证性等级**（L1 形式化 → L2 可测试 → L3 规则型 → L4 启发式 → L5 不可验证）：Quilin 主攻 L2-L3，经自进化系统探索 L4 边界。

---

## 四、4 种生产架构模式

| 模式 | 代表 | 核心结构 | 适用 |
|------|------|---------|------|
| 单线程主循环 | Claude Code | `while (!done) { llm → tools }`，sub-agent 深度 ≤1 | 大多数任务 |
| 中间件栈 | LangChain DeepAgents | `before_agent / wrap_model_call / before_tool_call` 钩子 | 细粒度循环控制 |
| 协议优先 App Server | OpenAI Codex | Thread → Turn → Item；JSON-RPC over stdio | 多表面（CLI/IDE/Web） |
| 初始化器 + 工作者 | Anthropic long-run | Initializer 一次性建环境，Worker 每 session 读 progress + commit | 超上下文窗口的多日任务 |

**Quilin 选择**：模式 1 为核心 + 模式 2 的 pre/post guardrails 中间件 + 模式 4 的 SQLite checkpoint + progress 文件持久化，外加 AgentMesh SDK adapter（Iter D）用于 P2P 异构互联。

---

## 五、Quilin 的 Harness 架构

Agent Loop（< 200 行 TS）+ 12 个激活工程领域（01..11, 13）+ 1 parked 子模块（`02-context/conversation-engineering/`）共同构成 harness。历史六组件（E-T-C-S-L-V）↔ 领域编号的完整映射见 [overview.md 附录 A](./overview.md#附录-a-e-t-c-s-l-v-历史分类)。各子系统（prompt 组装、记忆注入、工具定义、安全护栏、策略切换、token 预算、可观测性、自进化 scaffold、Semantic Graph 协调）的详细设计分散在 `docs/engineering/01..13/README.md`，此处不再重复索引。

**核心洞察**：LLM 是发动机，Harness 是整辆车。用户体验取决于整辆车。

---

## 七、Harness 设计原则

1. **约束悖论**：约束越多，能力越强（OpenAI 刚性架构、Stripe lint、Manus 删工具皆印证）。
2. **Build to Delete**：模型越强 harness 越轻；Manus 6 个月 5 次重写都在**删减**；Sonnet 4.5 的 workaround 到 Opus 4.5 就不需要。
3. **地图而非手册**：AGENTS.md < 100 行，渐进式披露；上下文是稀缺资源，巨大指令文件挤掉任务和代码。
4. **仓库即真理之源**：agent 看不到的东西不存在。架构决策、规范、部署流程必须版本控制。
5. **Agent 可读性优先**：代码库首先为 agent 可读性优化，人类审美次之。
6. **机械化执行，局部自治**：中央执行边界（约束、正确性），局部允许自治（解决方案表达）。
7. **最小化然后迭代**：200-500 行 MVP，观察失败再加固；不要预设计理想 harness。
8. **反馈循环速度决定效果**：秒级反馈赢，数小时反馈崩。**第一步不是建 harness，而是缩短反馈循环。**
9. **Harnessability**：代码库结构决定可治理程度——强类型、清晰边界、显式约定都是 affordances。

---

## 八、Harness 成熟度模型

| 级别 | 范围 | 投入 | 特征 |
|------|------|------|------|
| L1 个人 | 单开发者 | 2-4 h | Agent Loop + 3-5 工具 + CLAUDE.md + pre-commit + 测试套件 |
| L2 团队 | 小团队 | 1-2 d | AGENTS.md + CI 架构约束 + 共享 prompt 模板 |
| L3 生产 | 组织级 | 1-2 w | 自定义中间件 + 可观测性 + 熵管理 + harness 版本化 + A/B |
| L4 自进化 | 持续 | 持续 | 轨迹分析 + scaffold 自修改 + 技能自创 + 用户自助吸收 |

**Quilin**：架构按 L4 设计，实施按 L1→L4 渐进。

---

## 九、常见反模式

| # | 反模式 | 正确做法 |
|---|--------|---------|
| 1 | 在理解失败前过度工程化 | 最小 harness + 失败驱动加固 |
| 2 | 上下文灌水 | 精准选取 > 全面倾倒 |
| 3 | 静态 harness | 为定期重写而设计 |
| 4 | 过早复杂多 agent | 从单线程开始 |
| 5 | 只测 happy path | 测溢出/失败/死循环 |
| 6 | 超大单体 prompt | 分层 prompt |
| 7 | 知识 agent 不可达 | 仓库为唯一真源 |
| 8 | 移除错误信息 | 错误信息是隐式反馈，保留 |
| 9 | 完成前无验证关卡 | 退出前强制自检 |
| 10 | 忽视 KV-cache 经济学 | 10x 成本差异 |

---

## 十、核心度量

| 指标 | 目标 |
|------|------|
| KV-Cache 命中率 | > 80% |
| 任务成功率 | > 85% |
| Token 效率（有效/总） | > 60% |
| 首次正确率 | > 70% |
| 验证完成率 | > 95% |
| 工具选择正确率 | > 90% |
| 护栏假阳性率 | < 1% |
| 死循环频率 | < 5% |
| 重试至解决比 | < 2 |
| 自进化改进率 | > 5% / 月 |

**Harness-only 基准方法**：模型不变只改 harness，测量 delta——隔离 harness 贡献的唯一可靠方式。

---

## 十一、Harness 与模型的关系

2×2 矩阵：{强模型 × 强 harness} = Quilin 目标；{弱模型 × 强 harness} = 超水平发挥；{强模型 × 弱 harness} = 浪费好模型；{弱 × 弱} = 最弱。

**Quilin 策略**：模型是用户选的（via Vercel AI SDK v6），harness 是我们的核心竞争力——把 harness 做到极致，让任何模型都能超水平发挥。

---

## 十三、与竞品的 Harness 对比

| 维度 | Claude Code | Codex | LangChain | Manus | **Quilin** |
|------|------------|-------|-----------|-------|-----------|
| 架构 | 单线程主循环 | 协议优先 App Server | 中间件栈 | 单线程 + 文件外存 | 主循环 + 中间件 + checkpoint |
| 记忆 | CLAUDE.md | AGENTS.md + docs/ | Agent State | 文件系统 + todo 复述 | 4 层 OmniMem + KG + 自反思 |
| 工具 | ACI 精心设计 | 最小集 | 可组合 hook | 删 80% 更好 | 4 类动作空间 + 自创 |
| 安全 | 权限提示 | OS 沙箱 | 中间件 | — | 4 层验证 + Two-Strike + 步骤验证 |
| 策略切换 | 固定 ReAct | 无 | Reasoning Sandwich | 无 | Direct/ReAct/Plan-Execute/Tree 动态切换 |
| 上下文经济学 | 基础 | Thread/Turn/Item | 循环检测 | 极致（KV+掩码+复述） | KV-cache + 压缩 + 预估 |
| 熵管理 | 无 | 无 | 无 | 人工重写删减 | 定期清理 + 自进化 |
| 可观测性 | 基础日志 | 事件流 | trace | — | OTel 全链路 + eval 驱动 |
| **自进化** | **无** | **无** | **无** | **人工重写** | **轨迹分析 + scaffold 自修改 + 用户自助吸收** |

---

## 参考

18 篇行业文献（OpenAI、Anthropic、Martin Fowler、LangChain、Manus、Epsilla、HumanLayer、snowan、Infralovers、ICSE 2026 等）的完整引用清单 → `docs/research/` 子目录。
