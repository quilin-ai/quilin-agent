# 竞品 Issue 吸收：OpenClaw 与 Hermes Agent / Competitor Issue Intake: OpenClaw and Hermes Agent

## 采集范围 / Collection Scope

This note was collected on 2026-05-02 Asia/Shanghai, which is 2026-05-01 in the United States. It uses current GitHub open issue data for `openclaw/openclaw` and `NousResearch/hermes-agent`, prioritizing comments（GitHub 评论数）, reactions（GitHub 反应数）, and repeated themes across unresolved issues.

本笔记采集于 Asia/Shanghai 时间 2026-05-02，也就是美国时间 2026-05-01。数据来自 `openclaw/openclaw` 和 `NousResearch/hermes-agent` 当前 GitHub open issues（尚未关闭的问题），优先看 comments（GitHub 评论数）、reactions（GitHub 反应数）和未解决 issue 中反复出现的主题。

The GitHub GraphQL API（GitHub 的结构化查询接口）returned 3,446 open issues for OpenClaw and 2,761 open issues for Hermes Agent. I sampled the top 100 open issues by comment count and the top 25 open issues by reaction ranking for each repository; this is a high-signal intake sample, not a full statistical census.

GitHub GraphQL API（GitHub 的结构化查询接口）返回 OpenClaw 当前 3,446 个 open issues，Hermes Agent 当前 2,761 个 open issues。我对每个仓库采样了按评论数排序的前 100 个 open issues，以及按 reaction 排名的前 25 个 open issues；这是高信号吸收样本，不是完整统计普查。

No new Linear（项目任务系统）issue was created. All follow-up suggestions below map to existing Linear issues, usually as future comments or acceptance-criteria refinements.

本次没有新建 Linear（项目任务系统）issue。下面所有后续建议都映射到既有 Linear issue，优先作为后续 comment 或验收标准补充。

## 分类口径 / Classification

The categories are product（产品体验）, architecture（系统边界、数据模型或跨模块契约）, runtime（运行时可靠性、性能、进程、容器或网络）, safety（权限、秘密、审计或供应链风险）, and docs-DX（documentation and developer experience，文档与开发者体验）.

分类包括 product（产品体验）、architecture（系统边界、数据模型或跨模块契约）、runtime（运行时可靠性、性能、进程、容器或网络）、safety（权限、秘密、审计或供应链风险）和 docs-DX（documentation and developer experience，文档与开发者体验）。

Observability（可观测性）appears in the Linear mappings, but it is not a separate classification bucket in this note; those findings are classified as runtime or docs-DX depending on whether the primary gap is runtime evidence or operator/developer feedback.

Observability（可观测性）会出现在 Linear 映射中，但它不是本笔记的独立分类桶；这些 finding 会根据主要缺口归入 runtime 或 docs-DX，取决于问题核心是运行时证据还是操作者/开发者反馈。

## OpenClaw 高频缺口 / OpenClaw High-Signal Gaps

### OpenClaw 1. 跨平台与部署可用性 / Cross-Platform and Deployment Readiness

**English.** Signal: the most-commented and most-reacted OpenClaw issue is [#75 Linux/Windows Clawdbot Apps](https://github.com/openclaw/openclaw/issues/75), with 104 comments and 82 reactions in the GitHub API sample. Related unresolved friction appears in [#9443 prebuilt Android APK releases](https://github.com/openclaw/openclaw/issues/9443), [#14593 Docker skill install fails because brew is missing](https://github.com/openclaw/openclaw/issues/14593), [#31331 Docker sandbox workspace mount failure](https://github.com/openclaw/openclaw/issues/31331), [#40540 Windows update EBUSY](https://github.com/openclaw/openclaw/issues/40540), [#39038 Windows node startup hang](https://github.com/openclaw/openclaw/issues/39038), and [#53599 remote browser relay regression](https://github.com/openclaw/openclaw/issues/53599).

**中文。** 信号：OpenClaw 评论数和反应数最高的 issue 是 [#75 Linux/Windows Clawdbot Apps](https://github.com/openclaw/openclaw/issues/75)，在 GitHub API 样本中有 104 条评论和 82 个 reaction。相关未解决摩擦还包括 [#9443 预构建 Android APK 发布](https://github.com/openclaw/openclaw/issues/9443)、[#14593 Docker 中技能安装失败，因为缺少 brew](https://github.com/openclaw/openclaw/issues/14593)、[#31331 Docker sandbox 工作区挂载失败](https://github.com/openclaw/openclaw/issues/31331)、[#40540 Windows 更新时 EBUSY](https://github.com/openclaw/openclaw/issues/40540)、[#39038 Windows 节点启动卡住](https://github.com/openclaw/openclaw/issues/39038) 和 [#53599 远程浏览器 relay 回归](https://github.com/openclaw/openclaw/issues/53599)。

**English.** Classification: product, runtime, docs-DX. Quilin should absorb this as an installation and runtime matrix, not as a cosmetic packaging task: Linux, Windows, Docker（容器运行环境）, browser relay, sandbox mounts, and update flows need smoke tests and explicit support tiers.

**中文。** 分类：product、runtime、docs-DX。Quilin 应把它吸收为安装与运行时矩阵，而不是表层打包任务：Linux、Windows、Docker（容器运行环境）、browser relay（浏览器中继）、sandbox mounts（沙箱挂载）和 update flows（更新流程）都需要 smoke tests（冒烟测试）和明确支持等级。

**English.** Linear mapping: add evidence and acceptance details to QUI-21 for packaging and hot update, QUI-62 for DockerSandbox and sandbox lifecycle, and QUI-76 for documentation drift checks.

**中文。** Linear 映射：把证据和验收细节补到 QUI-21（打包与热更新）、QUI-62（DockerSandbox 与沙箱生命周期）和 QUI-76（文档漂移检查）。

### OpenClaw 2. 消息通道交付边界 / Messaging Channel Delivery Boundaries

**English.** Signal: [#25592 text between tool calls leaks to messaging channels](https://github.com/openclaw/openclaw/issues/25592) has 24 comments and describes internal agent narration reaching Slack and iMessage. Related issues show repeated boundary leaks: [#65867 Gemini final tags leak into delivered messages](https://github.com/openclaw/openclaw/issues/65867), [#48979 Telegram cannot send images via read tool](https://github.com/openclaw/openclaw/issues/48979), [#12602 Slack Block Kit support](https://github.com/openclaw/openclaw/issues/12602), [#50880 steer queue mode silently degrades](https://github.com/openclaw/openclaw/issues/50880), [#67793 collect queue mode not batching](https://github.com/openclaw/openclaw/issues/67793), [#39476 A2A（Agent-to-Agent，智能体到智能体协议） sessions_send duplicates messages](https://github.com/openclaw/openclaw/issues/39476), and [#27445 announceTarget for sub-agent completion](https://github.com/openclaw/openclaw/issues/27445). A2A appears here as an inter-agent message path, not only as a network protocol.

**中文。** 信号：[#25592 tool calls 之间的文本泄漏到消息通道](https://github.com/openclaw/openclaw/issues/25592) 有 24 条评论，描述了 Agent 内部叙述进入 Slack 和 iMessage。相关 issue 反复显示边界泄漏：[#65867 Gemini final tags 泄漏到已发送消息](https://github.com/openclaw/openclaw/issues/65867)、[#48979 Telegram 不能发送 read tool 读取的图片](https://github.com/openclaw/openclaw/issues/48979)、[#12602 Slack Block Kit 支持](https://github.com/openclaw/openclaw/issues/12602)、[#50880 steer queue mode 静默降级](https://github.com/openclaw/openclaw/issues/50880)、[#67793 collect queue mode 没有批量合并](https://github.com/openclaw/openclaw/issues/67793)、[#39476 A2A sessions_send 产生重复消息](https://github.com/openclaw/openclaw/issues/39476) 和 [#27445 sub-agent 完成通知的 announceTarget](https://github.com/openclaw/openclaw/issues/27445)。A2A（Agent-to-Agent，智能体到智能体协议）在这里是智能体间消息路径，不只是网络协议。

**English.** Classification: product, architecture, runtime. Quilin should define an explicit delivery contract for internal text, final user-visible text, tool progress, attachments, rich messages, parent-session events, and channel mirrors.

**中文。** 分类：product、architecture、runtime。Quilin 应定义显式交付契约，覆盖 internal text（内部文本）、final user-visible text（最终用户可见文本）、tool progress（工具进度）、attachments（附件）、rich messages（富消息）、parent-session events（父会话事件）和 channel mirrors（通道镜像）。

**English.** Linear mapping: route to QUI-66 for Core Loop step contracts and explicit stop states, QUI-61 for durable sub-agent completion delivery, QUI-63 for Agent Card and A2A/MCP（Model Context Protocol，模型上下文协议）interop, and QUI-20 for observable delivery traces. MCP matters because tool and agent-message boundaries should share identity and correlation metadata.

**中文。** Linear 映射：映射到 QUI-66（Core Loop 步骤契约和显式终止状态）、QUI-61（可恢复 sub-agent 完成交付）、QUI-63（Agent Card 与 A2A/MCP 互操作）和 QUI-20（可观测交付轨迹）。MCP（Model Context Protocol，模型上下文协议）重要，是因为工具边界和 Agent 消息边界应共享身份与关联元数据。

### OpenClaw 3. 记忆、上下文与压缩生命周期 / Memory, Context, and Compression Lifecycle

**English.** Signal: recurring OpenClaw issues focus on state loss, context bloat, and inconsistent memory behavior: [#12590 memoryFlush does not fire reliably](https://github.com/openclaw/openclaw/issues/12590), [#73306 Active Memory plugin times out](https://github.com/openclaw/openclaw/issues/73306), [#67419 bootstrap files re-injected every turn](https://github.com/openclaw/openclaw/issues/67419), [#22438 tiered bootstrap loading](https://github.com/openclaw/openclaw/issues/22438), [#29387 agentDir bootstrap files silently ignored](https://github.com/openclaw/openclaw/issues/29387), [#43747 memory management is in chaos](https://github.com/openclaw/openclaw/issues/43747), [#45608 pre-reset agentic memory flush](https://github.com/openclaw/openclaw/issues/45608), [#2597 context/state lost after compaction or reset](https://github.com/openclaw/openclaw/issues/2597), and [#45438 structuredClone session-store cache leak](https://github.com/openclaw/openclaw/issues/45438).

**中文。** 信号：OpenClaw 反复出现状态丢失、上下文膨胀和记忆行为不一致：[#12590 memoryFlush 不可靠](https://github.com/openclaw/openclaw/issues/12590)、[#73306 Active Memory plugin 超时](https://github.com/openclaw/openclaw/issues/73306)、[#67419 bootstrap files 每轮重复注入](https://github.com/openclaw/openclaw/issues/67419)、[#22438 分层 bootstrap 加载](https://github.com/openclaw/openclaw/issues/22438)、[#29387 agentDir 中的 bootstrap files 被静默忽略](https://github.com/openclaw/openclaw/issues/29387)、[#43747 记忆管理混乱](https://github.com/openclaw/openclaw/issues/43747)、[#45608 reset 前的 agentic memory flush](https://github.com/openclaw/openclaw/issues/45608)、[#2597 compaction 或 reset 后上下文/状态丢失](https://github.com/openclaw/openclaw/issues/2597) 和 [#45438 structuredClone session-store cache 泄漏](https://github.com/openclaw/openclaw/issues/45438)。

**English.** Classification: architecture, runtime, product. Quilin should absorb the pattern as a single memory lifecycle: compaction, reset, bootstrap scoping, memory flush, retrieval, and cache budget must share one tested contract.

**中文。** 分类：architecture、runtime、product。Quilin 应把这个模式吸收为单一记忆生命周期：compaction（压缩）、reset（重置）、bootstrap scoping（启动上下文作用域）、memory flush（记忆冲刷）、retrieval（检索）和 cache budget（缓存预算）必须共享一个可测试契约。

**English.** Linear mapping: add source evidence to QUI-51 and QUI-65 for memory observer and fact stream, QUI-49 and QUI-60 for context relevance and compression, and QUI-73 for long-memory evaluation.

**中文。** Linear 映射：把来源证据补到 QUI-51 和 QUI-65（memory observer 与 fact stream）、QUI-49 和 QUI-60（context relevance 与 compression），以及 QUI-73（长期记忆评测）。

### OpenClaw 4. Gateway 进程与控制面稳定性 / Gateway Process and Control-Plane Stability

**English.** Signal: runtime instability clusters around gateway restarts, process ownership, slow control APIs（Application Programming Interfaces，应用程序接口）, and long-running memory pressure: [#73323 gateway runtime degradation on Windows](https://github.com/openclaw/openclaw/issues/73323), [#73303 gateway restart hangs for minutes](https://github.com/openclaw/openclaw/issues/73303), [#75688 gateway 100 percent CPU and node.list latency](https://github.com/openclaw/openclaw/issues/75688), [#75591 plugin manifest read 100+ times per request](https://github.com/openclaw/openclaw/issues/75591), [#48183 Feishu monitor memory leak](https://github.com/openclaw/openclaw/issues/48183), [#22676 signal daemon stop race](https://github.com/openclaw/openclaw/issues/22676), [#75398 CLI（Command-Line Interface，命令行界面） commands trigger gateway restart](https://github.com/openclaw/openclaw/issues/75398), [#75774 duplicate link-cli child processes and memory leak](https://github.com/openclaw/openclaw/issues/75774), and [#74630 correlated 2026.4.24-2026.4.26 regression cluster](https://github.com/openclaw/openclaw/issues/74630).

**中文。** 信号：运行时不稳定集中在 gateway restart（网关重启）、process ownership（进程归属）、慢控制 API（Application Programming Interface，应用程序接口）和长进程内存压力：[#73323 Windows gateway runtime 降级](https://github.com/openclaw/openclaw/issues/73323)、[#73303 gateway restart 卡住数分钟](https://github.com/openclaw/openclaw/issues/73303)、[#75688 gateway 100% CPU 与 node.list 高延迟](https://github.com/openclaw/openclaw/issues/75688)、[#75591 每次请求重复读取 plugin manifest 100+ 次](https://github.com/openclaw/openclaw/issues/75591)、[#48183 Feishu monitor 内存泄漏](https://github.com/openclaw/openclaw/issues/48183)、[#22676 signal daemon stop race](https://github.com/openclaw/openclaw/issues/22676)、[#75398 CLI 命令触发 gateway restart](https://github.com/openclaw/openclaw/issues/75398)、[#75774 重复 link-cli 子进程和内存泄漏](https://github.com/openclaw/openclaw/issues/75774) 和 [#74630 2026.4.24 到 2026.4.26 相关回归簇](https://github.com/openclaw/openclaw/issues/74630)。

**English.** Classification: runtime, architecture, docs-DX. Quilin should treat daemon lifecycle as a first-class runtime subsystem with process locks, idempotent read-only commands, child-process accounting, and latency/memory budgets.

**中文。** 分类：runtime、architecture、docs-DX。Quilin 应把 daemon lifecycle（守护进程生命周期）作为一等运行时子系统，覆盖 process locks（进程锁）、幂等只读命令、child-process accounting（子进程计数）和延迟/内存预算。

**English.** Linear mapping: map to QUI-21 for daemon and hot update runtime, QUI-20 and QUI-66 for traceable step and process events, and QUI-62 where sandbox/process lifecycle overlaps.

**中文。** Linear 映射：映射到 QUI-21（daemon 与热更新运行时）、QUI-20 和 QUI-66（可追踪步骤与进程事件），以及与沙箱/进程生命周期重叠的 QUI-62。

### OpenClaw 5. 技能、插件与安全边界 / Skills, Plugins, and Safety Boundaries

**English.** Signal: OpenClaw's skill and plugin ecosystem is powerful but exposes security, provenance, and operator-cost gaps: [#18677 skill install security scan hook](https://github.com/openclaw/openclaw/issues/18677), [#11829 API key protection roadmap](https://github.com/openclaw/openclaw/issues/11829), [#50090 Community Skill Development and ClawHub](https://github.com/openclaw/openclaw/issues/50090), [#14593 Docker skill install failure](https://github.com/openclaw/openclaw/issues/14593), [#29195 Codex session permission docs](https://github.com/openclaw/openclaw/issues/29195), [#6615 denylist support for exec approvals](https://github.com/openclaw/openclaw/issues/6615), [#38248 per-hour spending ceiling](https://github.com/openclaw/openclaw/issues/38248), and [#29387 bootstrap rules silently ignored](https://github.com/openclaw/openclaw/issues/29387). LLM（Large Language Model，大语言模型）cost and secret exposure show up as safety problems, not only billing problems.

**中文。** 信号：OpenClaw 的技能和插件生态很强，但暴露了安全、来源记录和操作成本缺口：[#18677 skill install 安全扫描 hook](https://github.com/openclaw/openclaw/issues/18677)、[#11829 API key 保护路线图](https://github.com/openclaw/openclaw/issues/11829)、[#50090 Community Skill Development and ClawHub](https://github.com/openclaw/openclaw/issues/50090)、[#14593 Docker 技能安装失败](https://github.com/openclaw/openclaw/issues/14593)、[#29195 Codex session 权限文档](https://github.com/openclaw/openclaw/issues/29195)、[#6615 exec approvals denylist 支持](https://github.com/openclaw/openclaw/issues/6615)、[#38248 每小时成本上限](https://github.com/openclaw/openclaw/issues/38248) 和 [#29387 bootstrap 安全规则被静默忽略](https://github.com/openclaw/openclaw/issues/29387)。LLM（Large Language Model，大语言模型）成本和 secret（密钥）暴露应被视为安全问题，不只是账单问题。

**English.** Classification: safety, architecture, docs-DX, runtime. Quilin should keep skill installation, external plugin execution, tool permission, spend caps, and provenance under the same WriteAuthority（统一写权限门）and policy-record path.

**中文。** 分类：safety、architecture、docs-DX、runtime。Quilin 应把技能安装、外部插件执行、工具权限、成本上限和 provenance（来源记录）都纳入同一个 WriteAuthority（统一写权限门）和 policy-record（策略记录）路径。

**English.** Linear mapping: map to QUI-53 and QUI-64 for safety taxonomy and action-level verification, QUI-56 and QUI-67 for skills manifest/provenance/registry checks, and QUI-59 plus QUI-74 for model routing and spend-cap baselines.

**中文。** Linear 映射：映射到 QUI-53 和 QUI-64（安全分类与动作级验证）、QUI-56 和 QUI-67（技能 manifest、provenance 和 registry 检查），以及 QUI-59 与 QUI-74（模型路由和成本上限基线）。

## Hermes Agent 高频缺口 / Hermes Agent High-Signal Gaps

### Hermes 1. 结构化长期记忆与自进化来源记录 / Structured Long-Term Memory and Self-Evolution Provenance

**English.** Signal: Hermes Agent has a strong cluster around memory architecture and self-improvement quality: [#6323 mempalace external memory support](https://github.com/NousResearch/hermes-agent/issues/6323) has 16 comments and 25 reactions, while related open issues include [#8457 persistent session memory](https://github.com/NousResearch/hermes-agent/issues/8457), [#346 structured memory system](https://github.com/NousResearch/hermes-agent/issues/346), [#509 cognitive memory operations](https://github.com/NousResearch/hermes-agent/issues/509), [#11590 UnifiedContextEngine plugin](https://github.com/NousResearch/hermes-agent/issues/11590), [#11692 receipts for self-improving agents](https://github.com/NousResearch/hermes-agent/issues/11692), [#2670 memory flush overwrites live memory](https://github.com/NousResearch/hermes-agent/issues/2670), [#5563 production memory persistence field report](https://github.com/NousResearch/hermes-agent/issues/5563), [#14192 SessionDB search loses surrounding context](https://github.com/NousResearch/hermes-agent/issues/14192), and [#13265 skills system architecture defects](https://github.com/NousResearch/hermes-agent/issues/13265).

**中文。** 信号：Hermes Agent 在记忆架构和自我改进质量上有强烈聚类：[#6323 mempalace external memory support](https://github.com/NousResearch/hermes-agent/issues/6323) 有 16 条评论和 25 个 reaction，相关 open issues 包括 [#8457 持久会话记忆](https://github.com/NousResearch/hermes-agent/issues/8457)、[#346 结构化记忆系统](https://github.com/NousResearch/hermes-agent/issues/346)、[#509 认知记忆操作](https://github.com/NousResearch/hermes-agent/issues/509)、[#11590 UnifiedContextEngine 插件](https://github.com/NousResearch/hermes-agent/issues/11590)、[#11692 自改进 Agent 的 receipts（可追溯凭据）](https://github.com/NousResearch/hermes-agent/issues/11692)、[#2670 memory flush 覆盖实时记忆](https://github.com/NousResearch/hermes-agent/issues/2670)、[#5563 生产使用中的记忆持久化问题](https://github.com/NousResearch/hermes-agent/issues/5563)、[#14192 SessionDB search 丢失周边上下文](https://github.com/NousResearch/hermes-agent/issues/14192) 和 [#13265 Skills 系统架构缺陷](https://github.com/NousResearch/hermes-agent/issues/13265)。

**English.** Classification: architecture, product, safety. Quilin is already directionally aligned through quilin-mem（Quilin 的四层记忆系统）, but should explicitly add contradiction handling, provenance receipts for learned skills/facts, and memory evaluation gates before enabling broader idle evolution.

**中文。** 分类：architecture、product、safety。Quilin 通过 quilin-mem（Quilin 的四层记忆系统）方向上已经对齐，但应显式加入 contradiction handling（矛盾处理）、learned skills/facts（学到的技能与事实）的 provenance receipts（来源凭据），并在更广泛 idle evolution（空闲自进化）前加入记忆评测门禁。

**English.** Linear mapping: map to QUI-51 and QUI-65 for memory observer and fact stream, QUI-73 for long-memory evaluation, and QUI-56 plus QUI-67 for skill provenance and quality gates.

**中文。** Linear 映射：映射到 QUI-51 和 QUI-65（memory observer 与 fact stream）、QUI-73（长期记忆评测），以及 QUI-56 与 QUI-67（技能来源记录与质量门禁）。

### Hermes 2. 多 Agent、互操作与平台入口 / Multi-Agent, Interop, and Messaging Entry Points

**English.** Signal: Hermes users repeatedly ask for multi-agent and platform routing primitives: [#514 A2A protocol support](https://github.com/NousResearch/hermes-agent/issues/514) has 9 comments and 10 reactions, [#73 Matrix protocol support](https://github.com/NousResearch/hermes-agent/issues/73) also has 9 comments and 10 reactions, and related issues include [#7517 native multi-agent support](https://github.com/NousResearch/hermes-agent/issues/7517), [#9514 single-daemon multi-agent isolation](https://github.com/NousResearch/hermes-agent/issues/9514), [#9459 delegate_task agent profiles](https://github.com/NousResearch/hermes-agent/issues/9459), and [#1501 Langfuse tracing for subagents and gateway sessions](https://github.com/NousResearch/hermes-agent/issues/1501).

**中文。** 信号：Hermes 用户反复要求多 Agent 和平台路由原语：[#514 A2A protocol support](https://github.com/NousResearch/hermes-agent/issues/514) 有 9 条评论和 10 个 reaction，[#73 Matrix protocol support](https://github.com/NousResearch/hermes-agent/issues/73) 也有 9 条评论和 10 个 reaction；相关 issue 包括 [#7517 原生 multi-agent 支持](https://github.com/NousResearch/hermes-agent/issues/7517)、[#9514 单 daemon 多 Agent 隔离](https://github.com/NousResearch/hermes-agent/issues/9514)、[#9459 delegate_task agent profiles](https://github.com/NousResearch/hermes-agent/issues/9459) 和 [#1501 subagent 与 gateway session 的 Langfuse tracing](https://github.com/NousResearch/hermes-agent/issues/1501)。

**English.** Classification: architecture, product, runtime. Quilin should keep the first runtime slice local-first: typed handoff, profile/workspace isolation, durable inbox events, and traceable sub-agent progress before LAN or distributed mesh scope.

**中文。** 分类：architecture、product、runtime。Quilin 的第一块运行时切片应保持本机优先：typed handoff（结构化任务移交）、profile/workspace isolation（配置与工作区隔离）、durable inbox events（可恢复收件箱事件）和可追踪 sub-agent 进度应先于 LAN（Local Area Network，局域网）或分布式 mesh 范围。

**English.** Linear mapping: map to QUI-54 and QUI-63 for Agent Mesh, A2A, Agent Card, and MCP Streamable HTTP decisions, plus QUI-9 and QUI-61 for durable supervisor/sub-agent runtime, and QUI-20 plus QUI-66 for tracing.

**中文。** Linear 映射：映射到 QUI-54 和 QUI-63（Agent Mesh、A2A、Agent Card 与 MCP Streamable HTTP 决策），以及 QUI-9 和 QUI-61（可恢复 supervisor/sub-agent runtime），还有 QUI-20 与 QUI-66（tracing 可观测）。

### Hermes 3. Provider 与工具调用边界硬化 / Provider and Tool-Call Boundary Hardening

**English.** Signal: Hermes has many unresolved provider and tool-schema failures: [#18478 duplicate tool names cause strict-provider 400 failures](https://github.com/NousResearch/hermes-agent/issues/18478), [#8270 OpenRouter HTTP 400 while curl works](https://github.com/NousResearch/hermes-agent/issues/8270), [#15551 custom endpoints do not execute commands](https://github.com/NousResearch/hermes-agent/issues/15551), [#18470 custom OpenAI-compatible providers drop temperature and parallel_tool_calls](https://github.com/NousResearch/hermes-agent/issues/18470), [#12153 custom provider model validation fails](https://github.com/NousResearch/hermes-agent/issues/12153), [#17452 dotted model names are mangled](https://github.com/NousResearch/hermes-agent/issues/17452), [#17212 DeepSeek reasoning_content 400](https://github.com/NousResearch/hermes-agent/issues/17212), [#12068 memory tool JSON parse failure](https://github.com/NousResearch/hermes-agent/issues/12068), [#6839 lazy tool schema loading](https://github.com/NousResearch/hermes-agent/issues/6839), and [#18074 Anthropic Tool Search for MCP tools](https://github.com/NousResearch/hermes-agent/issues/18074).

**中文。** 信号：Hermes 有大量未解决的 provider（模型供应商）和 tool-schema（工具结构定义）失败：[#18478 重复 tool names 导致严格 provider 返回 400](https://github.com/NousResearch/hermes-agent/issues/18478)、[#8270 OpenRouter HTTP 400 但 curl 可用](https://github.com/NousResearch/hermes-agent/issues/8270)、[#15551 custom endpoints 不执行命令](https://github.com/NousResearch/hermes-agent/issues/15551)、[#18470 custom OpenAI-compatible providers 丢失 temperature 和 parallel_tool_calls](https://github.com/NousResearch/hermes-agent/issues/18470)、[#12153 custom provider model validation 失败](https://github.com/NousResearch/hermes-agent/issues/12153)、[#17452 带点的 model names 被改写](https://github.com/NousResearch/hermes-agent/issues/17452)、[#17212 DeepSeek reasoning_content 400](https://github.com/NousResearch/hermes-agent/issues/17212)、[#12068 memory tool JSON parse 失败](https://github.com/NousResearch/hermes-agent/issues/12068)、[#6839 lazy tool schema loading](https://github.com/NousResearch/hermes-agent/issues/6839) 和 [#18074 Anthropic Tool Search for MCP tools](https://github.com/NousResearch/hermes-agent/issues/18074)。

**English.** Classification: runtime, architecture, docs-DX. Quilin should treat provider adapters as live-tested contracts: normalized request fields, tool-name deduplication at the API boundary, provider-specific reasoning replay rules, deferred tool loading, and structured errors must be part of the LLM integration baseline.

**中文。** 分类：runtime、architecture、docs-DX。Quilin 应把 provider adapters（模型供应商适配器）视为需要实机测试的契约：标准化请求字段、API 边界的 tool-name deduplication（工具名去重）、供应商特定 reasoning replay（推理内容回放）规则、deferred tool loading（延迟工具加载）和 structured errors（结构化错误）都应成为 LLM 集成基线的一部分。

**English.** Linear mapping: map to QUI-48, QUI-59, and QUI-74 for provider routing, live matrix, fallback, and cost metrics; map tool-schema pressure to QUI-52, QUI-18, and QUI-22.

**中文。** Linear 映射：映射到 QUI-48、QUI-59 和 QUI-74（provider routing、live matrix、fallback 与成本指标）；工具结构压力映射到 QUI-52、QUI-18 和 QUI-22。

### Hermes 4. 部署、路径与平台适配可靠性 / Deployment, Path, and Platform Adapter Reliability

**English.** Signal: Hermes has repeated deployment and path handling failures: [#18482 Docker home directory permission denied](https://github.com/NousResearch/hermes-agent/issues/18482), [#18060 Path.home bypasses HERMES_HOME](https://github.com/NousResearch/hermes-agent/issues/18060), [#9792 hermes command not found in external interactive shells](https://github.com/NousResearch/hermes-agent/issues/9792), [#9153 Docker image missing dashboard command](https://github.com/NousResearch/hermes-agent/issues/9153), [#13655 stale gateway PID（Process Identifier，进程标识符） restart loop](https://github.com/NousResearch/hermes-agent/issues/13655), [#18086 Telegram updater goes silent forever](https://github.com/NousResearch/hermes-agent/issues/18086), [#18101 Slack background process updates leak into wrong thread](https://github.com/NousResearch/hermes-agent/issues/18101), [#17875 Feishu topic progress messages create new topics](https://github.com/NousResearch/hermes-agent/issues/17875), and [#18106 Email IMAP decode error](https://github.com/NousResearch/hermes-agent/issues/18106). PID files and home-directory rules are product reliability surfaces.

**中文。** 信号：Hermes 反复出现部署和路径处理失败：[#18482 Docker home directory permission denied](https://github.com/NousResearch/hermes-agent/issues/18482)、[#18060 Path.home 绕过 HERMES_HOME](https://github.com/NousResearch/hermes-agent/issues/18060)、[#9792 外部交互 shell 中找不到 hermes 命令](https://github.com/NousResearch/hermes-agent/issues/9792)、[#9153 Docker image 缺少 dashboard command](https://github.com/NousResearch/hermes-agent/issues/9153)、[#13655 stale gateway PID restart loop](https://github.com/NousResearch/hermes-agent/issues/13655)、[#18086 Telegram updater 永久静默](https://github.com/NousResearch/hermes-agent/issues/18086)、[#18101 Slack 后台进程更新泄漏到错误 thread](https://github.com/NousResearch/hermes-agent/issues/18101)、[#17875 Feishu topic progress messages 创建新 topic](https://github.com/NousResearch/hermes-agent/issues/17875) 和 [#18106 Email IMAP decode error](https://github.com/NousResearch/hermes-agent/issues/18106)。PID（Process Identifier，进程标识符）文件和 home-directory（主目录）规则都是产品可靠性界面。

**English.** Classification: runtime, product, docs-DX. Quilin should require deployment-mode invariants for home paths, mounted workspaces, daemon ownership, virtual environments, platform adapter reconnects, and thread/topic correlation.

**中文。** 分类：runtime、product、docs-DX。Quilin 应要求部署模式不变量，覆盖 home paths（主目录路径）、mounted workspaces（挂载工作区）、daemon ownership（守护进程归属）、virtual environments（虚拟环境）、平台适配器重连和 thread/topic correlation（线程/话题关联）。

**English.** Linear mapping: map to QUI-21 for runtime packaging and daemon behavior, QUI-62 for sandbox/container lifecycle, QUI-20 and QUI-66 for platform event traces, and QUI-57 plus QUI-69 for docs/process automation where install docs drift.

**中文。** Linear 映射：映射到 QUI-21（运行时打包和 daemon 行为）、QUI-62（沙箱/容器生命周期）、QUI-20 和 QUI-66（平台事件追踪），以及在安装文档漂移处映射到 QUI-57 与 QUI-69（docs/process 自动化）。

### Hermes 5. 安全、凭证与审计 / Safety, Credentials, and Auditability

**English.** Signal: the highest-comment Hermes issue by comments is [#487 cryptographic audit trail](https://github.com/NousResearch/hermes-agent/issues/487), with 21 comments. Related unresolved gaps include [#4656 credential proxy daemon](https://github.com/NousResearch/hermes-agent/issues/4656), [#10695 Python dependency CVE（Common Vulnerabilities and Exposures，通用漏洞披露编号） reports](https://github.com/NousResearch/hermes-agent/issues/10695), [#18083 over-broad dangerous rm regex](https://github.com/NousResearch/hermes-agent/issues/18083), [#10376 profile isolation is incomplete](https://github.com/NousResearch/hermes-agent/issues/10376), [#14218 orphaned credential pool entries](https://github.com/NousResearch/hermes-agent/issues/14218), [#18072 stale auth status](https://github.com/NousResearch/hermes-agent/issues/18072), and [#15272 Nix（声明式包管理与构建系统） build hash broken on main](https://github.com/NousResearch/hermes-agent/issues/15272). CVE items are supply-chain risk, while over-broad command rules are usability and safety debt at the same time.

**中文。** 信号：Hermes 评论数最高的 issue 是 [#487 cryptographic audit trail](https://github.com/NousResearch/hermes-agent/issues/487)，有 21 条评论。相关未解决缺口包括 [#4656 credential proxy daemon](https://github.com/NousResearch/hermes-agent/issues/4656)、[#10695 Python dependency CVE（Common Vulnerabilities and Exposures，通用漏洞披露编号） reports](https://github.com/NousResearch/hermes-agent/issues/10695)、[#18083 过宽的 dangerous rm 正则](https://github.com/NousResearch/hermes-agent/issues/18083)、[#10376 profile isolation 不完整](https://github.com/NousResearch/hermes-agent/issues/10376)、[#14218 orphaned credential pool entries](https://github.com/NousResearch/hermes-agent/issues/14218)、[#18072 stale auth status](https://github.com/NousResearch/hermes-agent/issues/18072) 和 [#15272 Nix（声明式包管理与构建系统） build hash 在 main 上失效](https://github.com/NousResearch/hermes-agent/issues/15272)。CVE 属于供应链风险，而过宽命令规则同时是易用性债务和安全债务。

**English.** Classification: safety, runtime, docs-DX. Quilin should absorb optional hash-chained audit records, credential broker boundaries, profile-isolation enforcement, precise dangerous-action classifiers, and dependency-audit gates.

**中文。** 分类：safety、runtime、docs-DX。Quilin 应吸收可选 hash-chained audit records（哈希链审计记录）、credential broker boundaries（凭证代理边界）、profile-isolation enforcement（配置隔离强制）、精确 dangerous-action classifiers（危险动作分类器）和 dependency-audit gates（依赖审计门禁）。

**English.** Linear mapping: map to QUI-53 and QUI-64 for action-level policy records and verification, QUI-72 for safety regression evidence, QUI-19 for production threat modeling, and QUI-20 plus QUI-66 where audit joins observability.

**中文。** Linear 映射：映射到 QUI-53 和 QUI-64（动作级策略记录与验证）、QUI-72（安全回归证据）、QUI-19（生产威胁模型），以及审计与可观测性结合处的 QUI-20 与 QUI-66。

### Hermes 6. CLI 与 TUI 可观测运维体验 / CLI and TUI Observable Operator Experience

**English.** Signal: Hermes has many smaller but repeated operator-experience issues: [#18127 in-flight gateway session observability](https://github.com/NousResearch/hermes-agent/issues/18127), [#5884 prompt_toolkit crash during setup](https://github.com/NousResearch/hermes-agent/issues/5884), [#5346 Shift+Enter newline support](https://github.com/NousResearch/hermes-agent/issues/5346), [#4807 CLI（Command-Line Interface，命令行界面） unreadable on light terminals](https://github.com/NousResearch/hermes-agent/issues/4807), [#18080 dashboard themes are hard to read](https://github.com/NousResearch/hermes-agent/issues/18080), [#4059 argument-level tab completion](https://github.com/NousResearch/hermes-agent/issues/4059), [#18110 sudo status misreported](https://github.com/NousResearch/hermes-agent/issues/18110), and [#2788 cron jobs never run or fail without useful information](https://github.com/NousResearch/hermes-agent/issues/2788). CLI and TUI（Terminal User Interface，终端界面）quality is part of production trust, not polish.

**中文。** 信号：Hermes 有许多较小但重复的 operator-experience（运维使用体验）问题：[#18127 in-flight gateway session observability](https://github.com/NousResearch/hermes-agent/issues/18127)、[#5884 setup 期间 prompt_toolkit 崩溃](https://github.com/NousResearch/hermes-agent/issues/5884)、[#5346 Shift+Enter 换行支持](https://github.com/NousResearch/hermes-agent/issues/5346)、[#4807 CLI 在浅色终端不可读](https://github.com/NousResearch/hermes-agent/issues/4807)、[#18080 dashboard themes 难读](https://github.com/NousResearch/hermes-agent/issues/18080)、[#4059 参数级 tab completion](https://github.com/NousResearch/hermes-agent/issues/4059)、[#18110 sudo 状态误报](https://github.com/NousResearch/hermes-agent/issues/18110) 和 [#2788 cron 不运行或失败时没有有用信息](https://github.com/NousResearch/hermes-agent/issues/2788)。CLI（Command-Line Interface，命令行界面）和 TUI（Terminal User Interface，终端界面）质量是生产信任的一部分，不只是打磨。

**English.** Classification: product, docs-DX, runtime. Quilin should add operator-facing status contracts for resume, cron, background work, sudo/readiness checks, and dashboard trace surfaces.

**中文。** 分类：product、docs-DX、runtime。Quilin 应为 resume（恢复会话）、cron（定时任务）、background work（后台任务）、sudo/readiness checks（权限与就绪检查）和 dashboard trace surfaces（仪表盘追踪界面）增加面向操作者的状态契约。

**English.** Linear mapping: map to QUI-20 and QUI-66 for observable runtime events, QUI-57 and QUI-69 for docs/process checks, QUI-21 for runtime readiness, and QUI-45 for component-deferred triage when the work does not fit a current implementation slice.

**中文。** Linear 映射：映射到 QUI-20 和 QUI-66（可观测运行时事件）、QUI-57 和 QUI-69（文档/流程检查）、QUI-21（运行时就绪），以及当工作不适合当前实现切片时映射到 QUI-45（组件延后工作整理）。

## Quilin 吸收优先级 / Quilin Intake Priority

**English.** Priority 1 is provider/tool boundary hardening: strict provider 400s, duplicate tool names, reasoning replay, cost failover, and deferred tool loading appear repeatedly in Hermes and also show up in OpenClaw cost and provider issues. This should tighten QUI-48, QUI-59, QUI-74, QUI-52, and QUI-22.

**中文。** 优先级 1 是 provider/tool boundary hardening（模型供应商与工具边界硬化）：严格 provider 400、重复工具名、reasoning replay、成本 failover（失败回退）和 deferred tool loading 在 Hermes 反复出现，也在 OpenClaw 成本与供应商问题中出现。应补强 QUI-48、QUI-59、QUI-74、QUI-52 和 QUI-22。

**English.** Priority 2 is durable delivery: both trackers show message leaks, dropped sub-agent completions, queue semantics gaps, wrong threads, and final/internal text confusion. This should tighten QUI-61, QUI-63, QUI-66, QUI-20, and QUI-9.

**中文。** 优先级 2 是 durable delivery（可恢复交付）：两个 tracker 都出现消息泄漏、sub-agent 完成通知丢失、队列语义缺口、错误 thread 和最终/内部文本混淆。应补强 QUI-61、QUI-63、QUI-66、QUI-20 和 QUI-9。

**English.** Priority 3 is memory lifecycle and context economics: compaction, reset, bootstrap, memory flush, retrieval, and structured memory all need one contract plus evaluation. This should tighten QUI-51, QUI-65, QUI-73, QUI-49, and QUI-60.

**中文。** 优先级 3 是 memory lifecycle and context economics（记忆生命周期与上下文成本）：compaction、reset、bootstrap、memory flush、retrieval 和 structured memory 都需要一个统一契约和评测。应补强 QUI-51、QUI-65、QUI-73、QUI-49 和 QUI-60。

**English.** Priority 4 is deployment/process reality: Docker, Windows/Linux, home paths, daemon locks, child-process leaks, and update flows are common unresolved pain. This should tighten QUI-21, QUI-62, QUI-20, and QUI-76.

**中文。** 优先级 4 是 deployment/process reality（部署与进程现实）：Docker、Windows/Linux、home paths、daemon locks、child-process leaks 和 update flows 都是常见未解决痛点。应补强 QUI-21、QUI-62、QUI-20 和 QUI-76。

**English.** Priority 5 is safety and provenance: skill install hooks, secret access, credential brokers, audit chains, profile isolation, and dependency audits should stay connected instead of becoming separate guardrail silos. This should tighten QUI-53, QUI-64, QUI-72, QUI-19, QUI-56, and QUI-67.

**中文。** 优先级 5 是 safety and provenance（安全与来源记录）：skill install hooks、secret access、credential brokers、audit chains、profile isolation 和 dependency audits 应保持连接，不应变成彼此独立的护栏孤岛。应补强 QUI-53、QUI-64、QUI-72、QUI-19、QUI-56 和 QUI-67。
