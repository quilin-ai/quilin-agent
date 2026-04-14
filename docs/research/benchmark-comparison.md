# 四大标杆 Agent 跨项目对比总结

> 调研日期：2026-04-14
> 对比项目：Claude Code v2.1.88 / Codex CLI / OpenClaw / Hermes Agent
> 源码总量：2,034K 行（512K TS + 831K Rust/TS + 296K TS + 395K Python）
> 关联调研：[claude-code-deep-dive](./claude-code-deep-dive.md) | [codex-deep-dive](./codex-deep-dive.md) | [openclaw-deep-dive](./openclaw-deep-dive.md) | [hermes-agent-deep-dive](./hermes-agent-deep-dive.md)

---

## 一、基础数据对比

| 维度 | Claude Code | Codex CLI | OpenClaw | Hermes Agent |
|------|------------|-----------|----------|--------------|
| **代码量** | 512K 行 | 831K 行 | 296K 行 | 395K 行 |
| **主语言** | TypeScript (Bun) | Rust + TypeScript | TypeScript (Node.js) | Python |
| **开源方式** | npm source map 泄露 | MIT 开源 | MIT 开源 | MIT 开源 |
| **核心循环** | async generator | submission_loop + Op dispatch | Pi agent embedded | AIAgent.run_conversation() |
| **循环范式** | yield 事件流 | 消息队列 + 异步分发 | createAgentSession() | ReAct + 迭代预算 |
| **构建系统** | Bun (全量打包) | Cargo (92 crate workspace) | pnpm monorepo | pip + pyproject.toml |
| **运行时** | Bun (CLI) | Tokio async runtime | Node.js 22.12+ | Python 3.10+ |

---

## 二、11 领域关联评分汇总

| 领域 | Claude Code | Codex | OpenClaw | Hermes | 最高分 | 最佳参考 |
|------|:---------:|:-----:|:--------:|:------:|:-----:|---------|
| 01-LLM 接入 | 4 | 4 | 4 | 3 | 4 | Claude Code / Codex（并列）|
| 02-上下文 | **5** | **5** | **5** | **5** | **5** | **全部**（行业共识最强领域）|
| 03-记忆 | 3 | 2 | **5** | 4 | **5** | **OpenClaw**（dreaming 系统）|
| 04-规划 | 2 | 3 | 4 | 4 | 4 | **OpenClaw**（死锁检测）/ **Hermes**（预算 refund）|
| 05-工具 | **5** | **5** | 3 | **5** | **5** | Claude Code + Codex + Hermes（三方互补）|
| 06-多 Agent | 2 | 4 | 3 | 2 | 4 | **Codex**（ThreadManager + SharedServices）|
| 07-安全护栏 | **5** | **5** | 3 | 4 | **5** | **Claude Code** + **Codex**（两大安全标杆）|
| 08-可观测性 | 3 | 4 | 2 | 1 | 4 | **Codex**（W3C Trace + OTel）|
| 09-部署运行时 | 3 | 4 | 4 | 2 | 4 | **Codex**（SQ/EQ）/ **OpenClaw**（双队列）|
| 10-自进化 | 1 | 2 | 2 | 3 | 3 | **Hermes**（唯一有 nudge 自进化）|
| 11-Agent Mesh | 0 | 1 | 1 | 0 | 1 | **无**（全行业空白，Quilin 独有机会）|
| **平均** | **3.0** | **3.5** | **3.3** | **3.0** | | |

### 关键发现

1. **02-上下文**全员满分——这是行业公认最核心的工程挑战
2. **05-工具**和**07-安全护栏**是最成熟的领域，三个项目各得 5 分
3. **11-Agent Mesh** 全行业接近 0 分——**这是 Quilin 最大的差异化机会**
4. **10-自进化**全行业最弱（最高仅 3 分）——**这是 Quilin 第二大差异化机会**
5. **03-记忆** OpenClaw 远超其他——dreaming 系统是行业最先进实现

---

## 三、核心架构模式对比

### 3.1 Agent Loop 设计

| 维度 | Claude Code | Codex | OpenClaw | Hermes |
|------|------------|-------|----------|--------|
| **实现方式** | async generator (yield) | async-channel + Op enum | embedded Pi session.run() | while 循环 + 工具调用 |
| **核心行数** | ~1,500 行 (query.ts) | ~8,100 行 (codex.rs) | ~2,500 行 (attempt.ts) | ~2,300 行 (run_agent.py) |
| **状态管理** | 闭包内 mutable State | Arc\<Session\> + 消息队列 | SessionManager 缓存 | AIAgent 实例属性 |
| **终止条件** | Terminal 返回值 | Op::Interrupt / 完成 | session.run() 返回 | max_iterations / 预算耗尽 |
| **错误恢复** | Continue 变体追踪 | fallback model | provider failover + 10+ 分类 | 3 次失败放弃 + 模型切换 |
| **流式输出** | SSE → yield StreamEvent | tokio broadcast | block streaming | callback 函数 |
| **Quilin 启示** | yield 模式最轻量 | Op enum 最可扩展 | 嵌入式最简洁 | 迭代预算最精细 |

### 3.2 上下文管理（全员 5 分，最核心对比）

| 维度 | Claude Code | Codex | OpenClaw | Hermes |
|------|------------|-------|----------|--------|
| **Prompt Cache** | 12+ 维度 hash 检测 break + sticky latching | 精确前缀匹配 + 完全无状态 | Anthropic cache_control 断点 | 三位置 cache_control 断点 |
| **压缩策略** | 5 层：toolResult→snip→micro→collapse→auto | 双路径：远程 /compact + 本地 LLM | ContextEngine.compact() + write lock | 四阶段：保护头尾→选候选→LLM 摘要→验证 |
| **Token 预算** | autoCompactTracking + 跨压缩追踪 | auto_compact_limit 阈值 | 可插拔 ContextEngine trait | 50% 阈值触发 |
| **差异化设计** | 工具结果持久化到磁盘 | context diff 增量注入 | transcript DAG 重写 | "Remaining Work" 而非 "Next Steps" |

### 3.3 工具系统

| 维度 | Claude Code | Codex | OpenClaw | Hermes |
|------|------------|-------|----------|--------|
| **调度模式** | concurrent-safe 分批 (max 10) | Op 枚举分发 + MCP 全生命周期 | Pi 内置 + 自定义注入 | 自注册 + Toolset 组合 + 白名单并行 |
| **权限模型** | 2 阶段 XML Classifier + 三级对话 | Guardian AI + 5 维细粒度审批 | 工具策略与审批 | approval 工具 + 预算压力隔离 |
| **MCP 集成** | 原生 + Deferred Tools | McpConnectionManager 完整生命周期 | 可选 MCP 插件 | mcp>=1.2.0 可选 |
| **沙箱** | 本地文件系统限制 | bubblewrap/Seatbelt/Windows Sandbox | 无显式沙箱 | 6 种执行后端 |
| **工具修复** | — | BANNED_PREFIX_SUGGESTIONS | — | 3 级修复（lowercase→normalize→Levenshtein） |

### 3.4 记忆系统

| 维度 | Claude Code | Codex | OpenClaw | Hermes |
|------|------------|-------|----------|--------|
| **架构** | CLAUDE.md + Auto Memory | AGENTS.md + memories | 3 阶段 Dreaming (light/deep/REM) | 5 层 (L1-L5) + 8 插件 |
| **持久化** | 文件系统 (markdown) | 文件系统 (markdown) | 文件 + 定时聚合 + health tracking | SQLite FTS5 + Markdown |
| **跨会话** | sessionStorage + memdir | AGENTS.md 持久 | health-based recovery (< 35% 触发) | Honcho 辩证式建模 |
| **自动维护** | auto-compact 时摘要 | 无 | cron dreaming（6h/24h/7d） | turn-based nudge（每 10 轮） |
| **创新度** | ★★ | ★ | ★★★★★ | ★★★★ |

### 3.5 安全护栏

| 维度 | Claude Code | Codex | OpenClaw | Hermes |
|------|------------|-------|----------|--------|
| **层级** | deny rules → LLM classifier → user dialog | exec_policy DSL → Guardian AI → sandbox → network proxy | 工具审批 + 边界检查 + 置信度阈值 | 预算隔离 + 上下文文件威胁检测 + skills_guard |
| **自动化** | 90%+ 走快速路径（Stage 1: 64 tokens） | 声明式 .rules 文件 + 防火墙式匹配 | 置信度双阈值（recovery 90% / auto-write 97%） | 预算压力信息仅 UI 显示，不注入 LLM |
| **硬件级** | 无 | bubblewrap + Landlock (Linux) / Seatbelt (macOS) | 无 | 无 |
| **创新度** | ★★★★★ | ★★★★★ | ★★★ | ★★★★ |

### 3.6 自进化能力

| 维度 | Claude Code | Codex | OpenClaw | Hermes |
|------|------------|-------|----------|--------|
| **当前状态** | 无（静态 harness） | Skills 热加载 | 弱（dreaming 聚合） | nudge-based 后台 review |
| **技能管理** | 无 | SkillsWatcher 文件监控 | 无 | skill_manager_tool 创建/编辑 |
| **学习闭环** | 无 | 无 | REM dreaming（创意关联） | memory + skill nudge（每 10 轮/次） |
| **RL 训练** | 无 | 无 | 无 | Atropos 环境 + AgenticOPDEnv (opt-in) |
| **与 Quilin 差距** | 极大 | 大 | 大 | 中等 |

---

## 四、关键创新点跨项目归纳

### 4.1 每个项目最独特的 Top 3 创新

| 项目 | #1 创新 | #2 创新 | #3 创新 |
|------|--------|--------|--------|
| **Claude Code** | 2 阶段 XML 权限 Classifier（Stage1 64 tokens 快速路径） | 5 层上下文压缩管线 | 工具安全属性自声明（isDestructive/isReadOnly/isConcurrencySafe） |
| **Codex** | SQ/EQ 双队列异步架构 | 5 维细粒度审批（GranularApprovalConfig） | W3C Trace Context 全链路追踪 |
| **OpenClaw** | 3 阶段记忆 Dreaming（light/deep/REM + health recovery） | ContextEngine 7 生命周期 Trait | Plan-Action 死锁检测 + act-now steer |
| **Hermes** | refund() 迭代预算（区分思考 vs 廉价 RPC） | 预算压力隔离（#7915 教训：压力信息不注入 LLM） | 工具名 3 级自修复（lowercase → normalize → Levenshtein） |

### 4.2 多项目共识（行业趋势）

| 趋势 | 证据 | 对 Quilin 的意义 |
|------|------|-----------------|
| **上下文压缩是最关键的工程挑战** | 4/4 项目得 5 分；每个都有独立的压缩管线 | Quilin 02-上下文 必须作为 Phase 0 最高优先级 |
| **Prompt Cache 经济学主导成本** | Claude Code 12 维 hash 检测；Codex 精确前缀匹配；Hermes 3 位置断点 | 必须从第一天就设计 cache-friendly 的 prompt 组装 |
| **工具安全需要多层防线** | Claude Code 3 层；Codex 4 层；Hermes 预算隔离 | 07-安全护栏不能只有一层 |
| **记忆系统仍在探索期** | 4 个项目 4 种完全不同的方案 | Quilin OmniMem 有机会定义新标准 |
| **自进化是行业空白** | 最高仅 3 分（Hermes 的 nudge），无项目有真正的轨迹分析 | **Quilin 核心差异化得到验证** |
| **Agent Mesh 全行业缺失** | 最高仅 1 分，无项目有跨进程 Agent 发现 | **Quilin 11-Agent Mesh 是独有创新** |
| **无状态设计是共识** | Codex 完全无状态；Claude Code 近似无状态；Hermes 系统提示单次构建 | Quilin 应采用无状态 prompt 重建模式 |

---

## 五、对 Quilin 的综合吸收建议

### 5.1 必须吸收（P0 — 高价值 + 低冲突）

| # | 功能 | 来源 | 吸收方式 | 目标领域 | 工作量 |
|---|------|------|---------|---------|--------|
| 1 | **上下文压缩管线** | Claude Code 5 层 + Hermes 4 阶段 | 融合重写 | 02-上下文 | 3-5 天 |
| 2 | **工具安全属性自声明** | Claude Code `isDestructive/isReadOnly/isConcurrencySafe` | 直接移植 | 05-工具, 07-安全 | 1-2 天 |
| 3 | **2 阶段权限 Classifier** | Claude Code Stage1(64 tokens) → Stage2(thinking) | 借鉴重写 | 07-安全护栏 | 3-5 天 |
| 4 | **refund() 迭代预算** | Hermes `IterationBudget` + execute_code 退还 | 直接移植 | 04-规划 | 1-2 天 |
| 5 | **预算压力隔离** | Hermes #7915 教训：压力信息仅 UI，不注入 LLM | 直接移植 | 07-安全护栏 | 0.5 天 |
| 6 | **自注册工具系统** | Hermes `registry.register()` + Toolset 组合 | 借鉴 TS decorator 版 | 05-工具 | 2-3 天 |
| 7 | **ContextEngine Trait** | OpenClaw 7 生命周期方法 | 借鉴重写 TS 版 | 02-上下文 | 3-5 天 |
| 8 | **3 阶段记忆 Dreaming** | OpenClaw light/deep/REM + health recovery | 融合到 OmniMem | 03-记忆 | 5-8 天 |

### 5.2 借鉴思路重写（P1 — 需适配）

| # | 功能 | 来源 | 适配点 | 目标领域 | 工作量 |
|---|------|------|-------|---------|--------|
| 9 | SQ/EQ 双队列架构 | Codex | TS 用 async channel 替代 Rust mpsc | 09-运行时 | 3-5 天 |
| 10 | StreamingToolExecutor | Claude Code | 3 级 AbortController 树 + 有序结果 | 05-工具 | 2-3 天 |
| 11 | W3C Trace Context | Codex | OTel SDK TS 版 | 08-可观测性 | 2-3 天 |
| 12 | 10+ 故障分类 | OpenClaw FailoverError | 适配 litellm 错误体系 | 01-LLM | 2-3 天 |
| 13 | Plan-Action 死锁检测 | OpenClaw | 检测纯规划循环 → 注入 act-now | 04-规划 | 2-3 天 |
| 14 | 工具名 3 级修复 | Hermes | lowercase → normalize → Levenshtein (0.7) | 05-工具 | 1-2 天 |
| 15 | Deferred Tools + ToolSearch | Claude Code | `shouldDefer/alwaysLoad/searchHint` 协议 | 05-工具 | 1-2 天 |
| 16 | ThreadManager 共享服务 | Codex | 子 Agent 共享 LLM/MCP 实例 | 06-多 Agent | 2-3 天 |
| 17 | ArcSwap 热更新 | Codex | TS 用 AtomicReference 模式 | 09-运行时, 10-自进化 | 1-2 天 |
| 18 | `<memory-context>` 围栏 | Hermes | OmniMem 上下文构建统一包裹 | 03-记忆 | 1 天 |

### 5.3 明确不吸收

| 功能 | 来源 | 不吸收理由 |
|------|------|-----------|
| Monolithic 单文件架构 | Hermes (10K 行 run_agent.py) | Quilin 模块化设计更优 |
| OpenAI Responses API 强绑定 | Codex | Quilin 通过 litellm 保持多模型抽象 |
| 平台原生沙箱 (Seatbelt/Landlock) | Codex | 太重，Quilin 优先 WASM 跨平台方案 |
| Gateway WebSocket 路由层 | OpenClaw | Quilin 用 MCP stdio + gRPC + HTTP SSE |
| 25+ 通道适配器 | OpenClaw | 应用层，非框架职责 |
| bun:bundle feature() 宏 | Claude Code | Bun 特有，Quilin 构建体系不同 |
| 3 API 模式手动适配 | Hermes | litellm 已统一 |
| 8 种记忆插件共存 | Hermes | OmniMem 统一架构更优 |
| GrowthBook 功能开关 | Claude Code | Quilin 不用 GrowthBook |
| SQLite 日志持久化 | Codex | Quilin 应直接输出到 OTel 平台 |

### 5.4 需要进一步设计决策的冲突点

| 冲突点 | Quilin 现有设计 | 各项目方案 | 建议 |
|--------|---------------|-----------|------|
| **Agent Loop 大小** | ADR-001: < 200 行核心 | Claude Code ~1,500 行、Codex ~8,100 行 | **保持目标，但要分清楚**——core loop 保持 <200 行，压缩/恢复/权限拆成独立模块 |
| **无状态 vs 有状态** | 未明确决策 | Codex 完全无状态 + 每次重建 prompt；Hermes 系统提示单次构建 | **采纳 Codex 无状态设计**——cache-friendly，但系统提示可缓存 |
| **压缩层数** | 未详细设计 | Claude Code 5 层、Hermes 4 阶段、OpenClaw ContextEngine.compact() | **融合为 Quilin 版管线**——需要在 02-上下文中做详细设计 |
| **权限 Classifier** | 07-安全: 4 层验证 | Claude Code LLM classifier、Codex Guardian AI | **两者互补**——快速路径 + 深度审查双阶段 |
| **记忆维护策略** | OmniMem 自动反思 | OpenClaw cron dreaming、Hermes turn-based nudge | **融合**——OmniMem 4 层是存储，dreaming 是整理策略 |

---

## 六、按 Quilin 11 领域的吸收路线图

| 领域 | 最佳参考 | 具体吸收内容 | 优先级 |
|------|---------|------------|--------|
| 01-LLM 接入 | Codex + OpenClaw | 10+ 故障分类 + 精准恢复策略；max_output_tokens 恢复链 | P1 |
| 02-上下文 | **全部**（最高优先） | ContextEngine Trait（OpenClaw）+ 压缩管线（Claude Code + Hermes 融合）+ context diff 增量注入（Codex）+ prompt cache 策略 | **P0** |
| 03-记忆 | **OpenClaw** + Hermes | 3 阶段 Dreaming + health tracking 融入 OmniMem；Honcho 辩证式参考；`<memory-context>` 围栏 | **P0** |
| 04-规划 | Hermes + OpenClaw | refund() 迭代预算；Plan-Action 死锁检测 + act-now steer | P1 |
| 05-工具 | Claude Code + Hermes + Codex | 安全属性自声明 + 自注册系统 + StreamingToolExecutor + Deferred Tools + 工具名修复 + MCP 全生命周期 | **P0** |
| 06-多 Agent | Codex | ThreadManager 共享服务；ForkSnapshot 子 Agent 创建 | P2 |
| 07-安全护栏 | **Claude Code + Codex** | 2 阶段 Classifier + 5 维细粒度审批 + 预算压力隔离 + 声明式策略文件 | **P0** |
| 08-可观测性 | Codex | W3C Trace Context 全链路 + 结构化 OTel spans + 异步批量写入 | P1 |
| 09-部署运行时 | Codex + OpenClaw | SQ/EQ 双队列 + ArcSwap 热更新 + 双队列调度 + 2 级注册启动加速 | P1 |
| 10-自进化 | Hermes（L0 基线） | nudge-based 后台 review 作为 L0；Quilin 在此基础上叠加轨迹分析 + scaffold 自修改 | P2 |
| 11-Agent Mesh | **无参考**（Quilin 独有） | 全行业空白，AgentMesh SDK 设计完全原创 | P2 |

---

## 七、战略结论

### Quilin 的两大差异化优势已被验证

1. **10-自进化**：四大标杆中最好的 Hermes 也只有 nudge-based 后台 review（得分 3/5），无项目有真正的轨迹分析、scaffold 自修改或数据驱动的技能创建。Quilin 的自进化设计远超行业前沿。

2. **11-Agent Mesh**：全行业 0-1 分。无项目有跨进程 Agent 发现、消息路由或去中心化通信。Quilin + AgentMesh 是完全原创的赛道。

### 吸收优先级排序

```
Phase 0 (PoC 必须):
  02-上下文 → ContextEngine Trait + 压缩管线 + cache 策略
  05-工具   → 安全属性 + 自注册 + StreamingToolExecutor
  07-安全   → 2 阶段 Classifier + 预算压力隔离
  03-记忆   → Dreaming 融入 OmniMem

Phase 1 (核心完善):
  01-LLM    → 故障分类 + 恢复链
  04-规划   → refund 预算 + 死锁检测
  08-可观测  → W3C Trace + OTel
  09-运行时  → SQ/EQ + 热更新

Phase 2 (差异化):
  10-自进化  → Hermes L0 基线 + Quilin 原创轨迹分析
  06-多Agent → Codex 共享服务模式
  11-Mesh   → AgentMesh SDK（完全原创）
```

### 关键风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 压缩管线融合复杂度 | 4 个项目 4 种方案，融合可能过度工程化 | 先实现最小可用版本（Hermes 4 阶段），再渐进增强 |
| 权限 Classifier 的 LLM 依赖 | 每次工具调用额外 1 次 LLM 调用（虽然 64 tokens 很轻量） | Stage 0 先用本地规则匹配，Stage 1 才走 LLM |
| 记忆 Dreaming 的资源消耗 | 3 个 cron job 持续运行 | health threshold 触发，空闲时执行 |
| Agent Loop 膨胀 | 参考项目都 1,500-8,100 行 | 严格遵守 ADR-001 < 200 行核心，辅助逻辑拆模块 |

---

## 八、参考来源

| # | 来源 | 类型 | 主要贡献 |
|---|------|------|---------|
| 1 | [Claude Code 深度调研](./claude-code-deep-dive.md) | 源码调研 | 权限 Classifier、压缩管线、工具安全属性 |
| 2 | [Codex CLI 深度调研](./codex-deep-dive.md) | 源码调研 | SQ/EQ 架构、沙箱隔离、W3C Trace |
| 3 | [OpenClaw 深度调研](./openclaw-deep-dive.md) | 源码调研 | ContextEngine Trait、Dreaming、死锁检测 |
| 4 | [Hermes Agent 深度调研](./hermes-agent-deep-dive.md) | 源码调研 | refund 预算、nudge 自进化、工具修复 |
| 5 | [知乎 Hermes 全面解读](https://zhuanlan.zhihu.com/p/2022015752258027715) | 第三方分析 | 6 大核心能力全景、RL 闭环、工业级 ReAct |
| 6 | [OpenAI: Unrolling the Codex Agent Loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | 官方博文 | Prompt 构建层次、缓存策略、无状态设计 |
| 7 | [openclaw-docs](https://github.com/yeuxuan/openclaw-docs) | 社区文档 | 276 篇教程、函数级源码剖析 |
| 8 | [claude-code-analysis](https://github.com/liuup/claude-code-analysis) | 社区分析 | 18 章完整架构、Memory/Tool/Sandbox 详解 |
