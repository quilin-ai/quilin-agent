# Roadmap Reassess — Multi-Agent + Self-Evolution（2026-04-26）

> 触发：原 Iter F plan（2026-04-19）打算 hand-roll gRPC mesh + AgentMesh SDK + trajectory analyzer。一周内生态显著前移，重新评估是否换框架。
> 范围：multi-agent orchestration + self-evolution / trajectory optimization 两个层面。
> 当前 Quilin 状态：mesh-sdk stub Iter D 已落、runtime 待 Iter F；Skills（B3a）已落 SKILL.md + frontmatter；trajectory 分析仍是 hand-rolled spec。

## 1. Multi-Agent 框架横评（2026-04 时点）

| 框架 | 最新版本 / 时间 | Stars | Supervisor / sub-agent | 通信机制 | TS+Py 双栈 | Production-ready |
|------|------------|-------|----------------------|--------|-----------|-----------------|
| **Microsoft Agent Framework 1.0** | v1.0 GA（2026-04-07）；前身 AutoGen v0.4 + Semantic Kernel 合并 | AutoGen 56.8k，新 repo 增长中 | graph-based workflow（sequential/concurrent/handoff/group chat），**checkpoint + 持久化** | actor model + 事件驱动；A2A + MCP 标准 | .NET + Python（**无原生 TS**） | 是。AutoGen 转入 maintenance，新项目走 Agent Framework |
| **OpenAI Agents SDK** | Python 已 GA；TypeScript GA；2026-04-15 重大更新（sandbox + subagent + code mode 公测） | openai-agents-python 高活跃 | 原生 **handoff** + **subagent**（公测）+ guardrails；triage agent 模式 | 函数调用 + handoff；MCP 已支持 | 是（py + ts 等价） | 是，配套 sandbox runtime |
| **Anthropic Claude Agent SDK** | TS V2 preview（2026-04），Python 同步迭代 | 官方 SDK，模型原生 | **原生 sub-agent spawning**（SubagentStart / SubagentStop hooks），fresh context per sub-agent，多 sub-agent 并发 | tool-use-first：sub-agent 作为 tool；MCP 客户端原生 | 是（py + ts） | 是。已是 Claude Code 自身 runtime |
| **CrewAI** | 2026 早期 40k+ stars；Crews + Flows | ~40k | role-based crew + Flows（事件驱动） | role 协作 + Flow event | Python 主，TS 第三方 | 高（Fortune 500 ~60% 使用，450M agent/月） |
| **LangGraph** | v1.1.3（2026-03-30），Deep Agent templates | 高 | **state machine + dynamic sub-agent spawn**，durable execution | 有向图 + checkpoint + HITL | py 主，js 镜像（langgraphjs） | 是，长跑稳态有口碑 |
| **AG2（AutoGen 社区 fork）** | Beta，事件驱动多 provider | 48.4k | 类 AutoGen 0.2 conversation + group chat | streaming events | Python | 中等（社区驱动） |
| **MetaGPT** | MGX 产品上线（2025-02），论文持续 | 高 | 角色 SOP（PM / Architect / Engineer / QA） | 工件传递 | Python | 偏 SaaS 软件工厂场景 |
| **PydanticAI** | v1.85.1（2026-04-22） | 16.5k+ | type-safe agent + graph + durable execution | 工具调用 + graph | Python | 是，已用于 Bedrock AgentCore |

来源：见末尾 Sources。

## 2. Self-Evolution / Trajectory Optimization

| 框架 | 状态 | 形态 | 与 Quilin 已落组件的关系 |
|------|------|------|---------------------|
| **DSPy 3.1** | 2026 官方版；GEPA / MIPROv2 / SIMBA optimizer 全量；agent loop 一等公民 | 程序化 prompt + weight 优化；**trajectory 是一等输入** | 直接替代 hand-rolled trajectory analyzer 的可能性最大 |
| **GEPA**（DSPy 子模块 + 独立 repo） | Nature 路线；NousResearch 已用它做 Hermes Agent self-evolution | 反射式 prompt 进化 + 文本 gradient + Pareto 筛选 | 与 Quilin 的 idle evolution / skill optimizer 高度对齐 |
| **TextGrad** | Nature 发表；活跃维护 | PyTorch 风格的文本反向传播；可优化 system prompt / tool description / skill | DSPy 的轻量替代，更接近"梯度"心智模型 |
| **Anthropic Skills（M0/M1/M2）** | 已成 Claude Code 内部生产形态（数百 skill）；公开 repo `anthropics/skills` | SKILL.md + frontmatter + script | Quilin B3a 已落同形态，**对齐成功** |
| **OpenAI Reflection / Self-Critic** | 未单独 SDK 化；散落在 Agents SDK 的 guardrail / handoff | 工程模式而非框架 | 不构成替代方案 |
| **AutoGen Studio** | 仍属 Microsoft Research；low-code GUI；self-improving agent 在 roadmap | 调试器 + JSON spec | 与 Quilin Dashboard 重叠，价值有限 |

## 3. Quilin 契合度打分（0-10）

评分维度：mesh / sub-agent parity（25%）+ TS+Python 双栈（20%）+ OSS 许可与中立性（15%）+ production-ready（20%）+ Anthropic 模型亲和度（20%）。

| 框架 | 分数 | 关键评注 |
|------|------|---------|
| **Anthropic Claude Agent SDK** | **9.0** | 原生 sub-agent + hooks + MCP；与 Quilin 已用模型同源；TS+Py 双栈；"sub-agent as tool" 心智与 06-multi-agent supervisor 几乎 1:1 |
| OpenAI Agents SDK | 7.5 | sub-agent + sandbox 公测在路上；TS+Py 等价；但 OpenAI-centric，与 Quilin "model-agnostic + Anthropic 优先" 略错位 |
| Microsoft Agent Framework 1.0 | 6.5 | GA + checkpoint 强；**无 TS**，.NET/Py 栈错配 Quilin 选型 |
| LangGraph | 6.5 | 长跑/HITL/durable 顶配；图心智重，与 Quilin "< 200 lines core loop"哲学冲突 |
| CrewAI | 5.5 | role-based 适合业务编排，supervisor 模型不够灵活；TS 第三方 |
| AG2 / AutoGen 0.4（maintenance） | 4.0 | maintenance mode；走它等于跟错主线 |
| **DSPy + GEPA** | **8.5** | self-evolution 的事实 SOTA；trajectory-native；可与任意 supervisor 共栈 |
| TextGrad | 7.0 | DSPy 的轻量替代，接入更小但生态更窄 |

## 4. 与原 plan 的 delta

**原计划（Iter F）**
- Multi-agent runtime：hand-roll gRPC mesh（mesh-sdk Iter D 已 stub）+ 自研 AgentMesh SDK；supervisor / spawn / heartbeat 全部自写。
- Self-evolution：自研 trajectory analyzer + idle evolution loop + skill creation + User Insight Engine。

**生态变化（一周内）**
- **2026-04-07**：Microsoft Agent Framework 1.0 GA（AutoGen + SK 合并），AutoGen 转 maintenance —— 自研 mesh 的"自由度"参照系已易主。
- **2026-04-15**：OpenAI Agents SDK 加入 sandbox + subagent；TS+Py 双栈对齐。
- **Claude Agent SDK V2 preview**：sub-agent + hooks + MCP 已是模型原生能力，**任何自研 supervisor 都在重复 Anthropic 已发的轮子**。
- **DSPy 3.1 + GEPA**：trajectory-driven 自进化已经从论文走到生产（Hermes Agent 已用 DSPy + GEPA 做 skill / prompt / 代码进化），自研 trajectory analyzer 价值边际下降。

**Delta 结论**
- mesh-sdk Iter D stub 保留为 Rust crate 占位即可；**runtime 不应继续 hand-roll gRPC**。改用 Claude Agent SDK 的 sub-agent + hooks 作为 supervisor 主路径，gRPC mesh 仅在跨进程 / 跨机场景里作为 transport（Iter F 后再视需要补）。
- 自研 trajectory analyzer 调整为"DSPy GEPA wrapper + Quilin-flavored adapter"，把已有的 OmniMem + Skill 喂给 GEPA optimizer，不再写优化算法。

## 5. R5 推荐

**Multi-Agent 推荐：Anthropic Claude Agent SDK（TS）+ MCP（Python providers）**
1. **模型亲和度最高**：Quilin 选型已锁 Anthropic 主模型，sub-agent / hooks 是 Claude 本机一等公民，spawn 行为与 Sonnet/Opus 训练分布一致，胜过任何"通用框架 + Anthropic provider"组合。
2. **TS + Python 双栈零摩擦**：与 ADR-001 / ADR-002 选型完全对齐；OpenAI Agents SDK 等价但 OpenAI-centric；Microsoft Agent Framework 无 TS。
3. **正好替代自研 mesh 的核心场景**：sub-agent fresh context + SubagentStart/Stop hooks + MCP transport 已覆盖 06-multi-agent §2 的 supervisor / spawn / progress reporting；Iter D 的 mesh-sdk stub 可降级为"跨主机 transport"，不再承担 supervisor 职责。

**Self-Evolution 推荐：DSPy 3.1 + GEPA optimizer**
1. **trajectory-native**：GEPA 直接吃 OmniMem 已经在产出的 episodic trace，无需再造 trajectory schema；NousResearch / Hermes 已经把它跑成 production loop，可直接抄。
2. **Skill 路径天然契合**：GEPA 进化的就是 prompt + tool description + 代码片段，与 Quilin Skills（13 域）SKILL.md + frontmatter 形态对齐，evolved skill 落盘即可被 Skill loader 重新发现。
3. **opt-in idle evolution 安全闭环**：DSPy 的 compile/optimize 离线运行特性 + WriteAuthority gate（07 §2.6.4）天然搭配——optimizer 输出 patch，仍走 human-reviewed PR 注入，不破坏 READ-ONLY 默认。

**保留 hand-rolled 的部分**
- WriteAuthority gate / 4-tier 安全模型 / Skill loader / OmniMem 4-tier：Quilin 差异化护城河，不替换。
- mesh-sdk Rust stub：保留为 Iter F 跨进程 transport 占位，但 supervisor 语义改由 Claude Agent SDK 承担。

**风险与跟进项**
- Claude Agent SDK V2 仍在 preview —— 接入前需在 spike 里跑通"主 Agent + 3 sub-agent 并发 + hook 拦截 + MCP tool"四件套，再决定是否 commit。
- DSPy 3.1 与 Bun runtime 不直接兼容（DSPy 是 Python）—— 需要把 evolution loop 放在 `providers/` 下作为独立 MCP/CLI 服务，agent-core 走 IPC 调用。
- AutoGen 维护态意味着 mesh-sdk 中**任何借鉴 AutoGen 0.2/0.4 API 形态的痕迹都要重打分**。

## Sources

- [microsoft/autogen](https://github.com/microsoft/autogen) — 56.8k stars, AutoGen v0.4 重构 + 转 maintenance
- [Microsoft Agent Framework 1.0 GA（VSM, 2026-04-06）](https://visualstudiomagazine.com/articles/2026/04/06/microsoft-ships-production-ready-agent-framework-1-0-for-net-and-python.aspx)
- [Microsoft Agent Framework 1.0 announcement](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)
- [OpenAI Agents SDK update（TechCrunch, 2026-04-15）](https://techcrunch.com/2026/04/15/openai-updates-its-agents-sdk-to-help-enterprises-build-safer-more-capable-agents/)
- [OpenAI: The next evolution of the Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)
- [openai/openai-agents-python](https://github.com/openai/openai-agents-python)
- [OpenAI Agents SDK TypeScript](https://openai.github.io/openai-agents-js/)
- [Anthropic Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [TS V2 interface preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK hooks（含 SubagentStart/Stop）](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [crewAIInc/crewAI](https://github.com/crewaiinc/crewai) — 40k+ stars
- [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) — v1.1.3（2026-03-30）
- [ag2ai/ag2](https://github.com/ag2ai/ag2) — 48.4k stars，AutoGen 社区 fork
- [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT)
- [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) — v1.85.1（2026-04-22），16.5k+ stars
- [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy) — 3.1.0
- [DSPy GEPA 优化器文档](https://dspy.ai/api/optimizers/GEPA/overview/)
- [gepa-ai/gepa](https://github.com/gepa-ai/gepa)
- [zou-group/textgrad](https://github.com/zou-group/textgrad) — Nature 2024
- [anthropics/skills](https://github.com/anthropics/skills) — Anthropic Skills 公开样本（与 Quilin B3a 同形态）
- [NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) — DSPy + GEPA 实跑 self-evolution 案例
- [EvoAgentX/Awesome-Self-Evolving-Agents（survey）](https://github.com/EvoAgentX/Awesome-Self-Evolving-Agents)
- [Composio: Claude Agents SDK vs OpenAI Agents SDK vs Google ADK（2026）](https://composio.dev/content/claude-agents-sdk-vs-openai-agents-sdk-vs-google-adk)
