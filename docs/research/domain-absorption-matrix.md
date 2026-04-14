# 11 领域 × 71 创新点吸收矩阵

> 日期：2026-04-14（初版 66 项）→ 2026-04-15（新增 EverOS 5 项）
> 数据来源：[claude-code-deep-dive](./claude-code-deep-dive.md) | [codex-deep-dive](./codex-deep-dive.md) | [openclaw-deep-dive](./openclaw-deep-dive.md) | [hermes-agent-deep-dive](./hermes-agent-deep-dive.md) | [benchmark-comparison](./benchmark-comparison.md) | [EverOS](https://github.com/EverMind-AI/EverOS)
> 编号规则：CC=#1-15（Claude Code）、CX=#16-33（Codex CLI）、OC=#34-48（OpenClaw）、HA=#49-66（Hermes Agent）、**EV=#67-71（EverOS）**

---

## 01-LLM 接入（7 项创新）

**行业评分**：CC=4, CX=4, OC=4, HA=3 | **最佳参考**：Claude Code / Codex（并列）

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 17 | **双循环 Agent 引擎**：外层 submission_loop 分发 Op，内层 run_turn 驱动多步工具执行 | Codex | **P0** | 借鉴重写 |
| 9 | **Max output tokens 恢复链**：8k→64k 升级→多轮恢复（最多 3 次）→"resume directly, no apology" 元消息 | Claude Code | P1 | 借鉴重写 |
| 39 | **10+ 失败模式分类**：rate_limit/auth/billing/overloaded/timeout/model_not_found 分类恢复 | OpenClaw | P1 | 直接移植 |
| 29 | **Pre-warming ModelClientSession**：跨 retry 复用 WebSocket session 和 sticky routing | Codex | P2 | 借鉴思路 |
| 45 | **思维级别降级重试**：Compaction LLM 调用失败时降低思维复杂度重试 | OpenClaw | P2 | 借鉴思路 |
| 48 | **Auth profile 轮换 + 冷却**：多 key 管理 + 失败冷却 + 分类恢复 | OpenClaw | P2 | 借鉴思路 |
| 59 | **Veto 式廉价模型路由**：30+ 关键词 + 160 字符/28 词阈值快速判断是否需要强模型 | Hermes | P2 | 借鉴扩展 |

> **不吸收**：#62 三 API 模式统一（Hermes）— litellm 已覆盖，手动维护三套 API 是反模式。

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #17 双循环引擎 | Quilin ADR-001 确定 < 200 行核心循环，但缺乏对消息分发层和工具执行层的清晰分离。Codex 的 Dispatch Loop + Turn Loop 分层为 Quilin 提供了最佳参考。**分层让 core loop 保持精简，同时不损失扩展性** |
| #9 恢复链 | 模型输出截断是高频场景（8k 默认限制），Claude Code 的恢复链保证了任务不因 token 限制中断。Quilin 作为通用框架必须处理此场景 |
| #39 故障分类 | Quilin 通过 litellm 接入多模型，错误类型比单一 provider 更多样。10+ 分类让恢复策略精准，避免"一刀切重试" |
| #59 Veto 路由 | Hermes 的启发式太简单，但"先廉价判断再走强模型"的思路与 Quilin InferenceConfig 互补。作为 Stage 0 快速路径有价值 |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **首 token 延迟** (TTFT) | p95 < 800ms（冷启动）, p95 < 300ms（热） | OTel span: `llm.first_token_latency` | 用户感知的响应速度 |
| **output 截断率** | < 1% 的 turn 因 max_tokens 中断 | 计数器: `llm.output_truncated_total` / `llm.turn_total` | 恢复链是否有效 |
| **故障恢复成功率** | > 95% 的可恢复错误在 3 次内恢复 | 比率: `llm.recovery_success` / `llm.recovery_attempt` | 系统鲁棒性 |
| **模型切换延迟** | < 200ms（同 provider）, < 2s（跨 provider） | OTel span: `llm.model_switch_latency` | 降档/升档的流畅度 |
| **模型路由准确率** | Veto 快速路径分流后，强模型调用减少 > 30%，任务完成率不降 | A/B 实验: 有无 Veto 路由的任务完成率对比 | 成本优化 vs 质量平衡 |

---

## 02-上下文工程（15 项创新 — 最密集领域）

**行业评分**：CC=5, CX=5, OC=5, HA=5 | **全员满分 — 行业公认最核心工程挑战**

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 1 | **5 层压缩流水线**：toolResult→snipCompact→microCompact→contextCollapse→autoCompact | Claude Code | **P0** | 融合重写 |
| 34 | **ContextEngine 7 生命周期 trait**：beforeModelCall/afterModelCall/compact/ownsCompaction 等可插拔接口 | OpenClaw | **P0** | 借鉴重写 |
| 51 | **四阶段压缩**：prune→head→tail-budget→LLM summary，迭代更新摘要 | Hermes | **P0** | 融合入 #1 |
| 52 | **"Remaining Work" 而非 "Next Steps"**：防止模型将摘要待办当做活跃指令执行 | Hermes | **P0** | 直接采纳 |
| 28 | **上下文差分注入**：reference_context_item 作为基线，只注入变化的上下文 | Codex | **P0** | 借鉴重写 |
| 10 | **工具结果持久化到磁盘**：超过 maxResultSizeChars 的结果存文件，上下文只保留预览+路径 | Claude Code | P1 | 借鉴重写 |
| 41 | **Session write lock + Checkpoint**：Compaction 的双保险——锁保一致性，快照保可恢复 | OpenClaw | P1 | 借鉴重写 |
| 47 | **transcript DAG 重写**：branch-and-reappend 模式保留历史完整性 | OpenClaw | P1 | 借鉴思路 |
| 56 | **system prompt 单次构建 + 缓存**：最大化 Anthropic prefix cache 命中率 | Hermes | P1 | 直接采纳 |
| 64 | **Tool pair 完整性保护**：孤立结果移除 + 缺失结果 stub | Hermes | P1 | 直接移植 |
| 19 | **模型降档压缩**：切换到更小上下文窗口时，用旧模型执行 compact | Codex | P2 | 借鉴思路 |
| 20 | **双路径 Compact**：OpenAI 用远程 /compact，其他用本地 LLM 压缩 | Codex | P2 | 参考设计 |
| 35 | **ES Proxy 旧引擎兼容**：自动检测旧 API→参数降级重试 | OpenClaw | P2 | 参考思路 |
| 63 | **12+ 平台专用提示词**：WhatsApp/Telegram/Discord/WeChat 等平台适配 | Hermes | P2 | 参考设计 |
| 13 | **Tombstone 消息**：流式 fallback 时为孤儿 assistant 消息生成占位符 | Claude Code | — | 不吸收 |

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #1+#51 压缩管线融合 | 4/4 项目都有独立压缩管线，说明这是**工程刚需**。Claude Code 的 5 层粒度最细（从工具结果级到全量摘要），Hermes 的 4 阶段流程最清晰（迭代更新摘要）。**融合两者：采用 Hermes 的阶段流程 + Claude Code 的粒度分层** |
| #34 ContextEngine trait | OpenClaw 把上下文引擎抽象为 7 个生命周期方法 + ownsCompaction 声明，实现了**完全可插拔**。这是 Quilin 02-上下文工程缺失的核心抽象。**定义 Quilin 的 ContextEngine 接口是第一优先级** |
| #52 "Remaining Work" | 微小但关键。"Next Steps" 会让模型把摘要中的待办理解为"现在要做"，导致重复执行或混乱。**一个命名变更避免一类系统性 bug** |
| #28 差分注入 | Codex 每次 turn 不重发完整 system prompt，而是只发变化部分。直接减少 30%+ token 消耗。**经济效益最直接** |
| #13 Tombstone | 仅处理流式 fallback 时的孤儿消息，边缘场景，优先级极低 |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **prompt cache 命中率** | > 90%（稳态运行时） | 比率: `context.cache_hit` / `context.cache_total` | 直接决定 API 成本（命中时成本降 90%） |
| **压缩比** | 平均 > 3:1（原始 token / 压缩后 token） | 直方图: `context.compression_ratio` | 有效上下文窗口利用率 |
| **压缩后信息保留率** | > 85%（通过"知识测试"题集评估） | 离线评测: 压缩前后对同一组问题的回答准确率对比 | 压缩质量——防止压缩过度导致"失忆" |
| **差分注入 token 节省率** | 每轮节省 > 30% system prompt token | 差值: `context.full_prompt_tokens` - `context.diff_prompt_tokens` | 成本优化 |
| **token 预算利用率** | 稳态 75-90% | 比率: `context.used_tokens` / `context.budget_tokens` | 太低=浪费上下文窗口，太高=频繁压缩 |
| **压缩触发频率** | 每个 session 平均 < 3 次 | 计数器: `context.compact_triggered` per session | 频繁压缩=预算设计不合理 |
| **压缩延迟** | p95 < 5s | OTel span: `context.compact_duration` | 用户感知的"卡顿" |

---

## 03-记忆工程（10 项创新 — 新增 EverOS 4 项）

**行业评分**：CC=3, CX=2, OC=5, HA=4, **EV=5** | **最佳参考**：OpenClaw（dreaming）+ **EverOS（Foresight + HyperMem，LoCoMo 92.73%）**

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 36 | **三阶段记忆梦境**：light（6h 去重合并）/ deep（24h 跨会话整合）/ REM（7d 创造性关联），health < 35% 触发恢复 | OpenClaw | **P0** | 融合到 OmniMem |
| 67 | **Foresight Memory（前瞻记忆）**：从对话中提取预测性记忆，带时间有效窗口（start_time/end_time），到期前主动提醒。**全行业独有** | EverOS | **P0** | 融合到 OmniMem auto-reflect |
| 68 | **HyperMem 3 层超图**：Topic → Episode → Fact，超边捕捉多对多关联，注意力加权聚合，LoCoMo 92.73%（碾压 Mem0 66.88%） | EverOS | P1 | OmniMem Layer 3 KG 升级 |
| 69 | **MemCell 原子单元**：所有记忆从边界检测的原子单元 (MemCell) 派生，保证完整溯源链（每条 Episode/Foresight/Fact 可追溯到源 MemCell） | EverOS | P1 | 借鉴重写 |
| 21 | **Memory Mode Pollution**：MCP/WebSearch 调用标记线程为 polluted，阻止外部数据被持久化为长期记忆 | Codex | P1 | 借鉴重写 |
| 37 | **置信度双阈值**：恢复置信度 90% vs 自动写入 97%，高不确定性需人工确认 | OpenClaw | P1 | 借鉴重写 |
| 55 | **\<memory-context\> fence**：防止模型将回忆内容当做用户消息处理，sanitize_context() 过滤逃逸 | Hermes | P1 | 直接采纳 |
| 70 | **双模检索（轻量 + Agentic）**：简单查询走 BM25+向量 RRF 无 LLM 调用；复杂查询走 LLM 扩展查询 + 多轮检索 + Qwen3-Reranker | EverOS | P2 | 借鉴思路 |
| 60 | **Honcho 辩证记忆**：peer card + 语义搜索 + 辩证 Q&A + 结论持久化 | Hermes | P2 | 概念参考 |
| 14 | **Memory prefetch**：利用 TC39 Explicit Resource Management 在 turn 开始时预取记忆 | Claude Code | P2 | 借鉴思路 |

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #36 三阶段梦境 | **行业最先进的记忆维护方案**。模拟人类记忆巩固节律（light=短期整理，deep=跨域整合，REM=创造性关联）。Quilin OmniMem 4 层是存储架构，dreaming 是整理策略——**两者正交，可直接组合** |
| #67 Foresight Memory | **全行业独有创新，0 → 1 的能力**。从对话中提取带时间窗口的预测性记忆（如"用户下周三有 deadline"），到期前主动提醒。**直接支撑 Quilin 的时间感知 + Aha Moment 设计哲学**。没有任何竞品（Claude、Hermes、OpenClaw、Mem0）有前瞻记忆——Agent 不只记住过去，还能预见未来 |
| #68 HyperMem 超图 | OmniMem Layer 3 当前用 KG 三元组（pairwise 关系），HyperMem 的超图能表达**多对多高阶关联**（如"用户同时关注 A/B/C 三个技术且都用于项目 X"）。LoCoMo 92.73% vs Mem0 66.88% 证明超图在多跳检索上的显著优势。**但引入超图增加了存储复杂度，P1 实施** |
| #69 MemCell 原子单元 | 所有记忆从同一原子单元派生保证了**完整溯源链**——任何一条记忆都能追溯到源对话。当记忆出错时可以定位源头修正。**记忆可审计性是生产级系统的必要能力** |
| #21 Pollution 标记 | Agent 调用 WebSearch/MCP 获取的外部数据如果被直接记忆化，会导致**记忆污染**（把网页内容当成自己的经验）。这是 Quilin OmniMem 必须处理的安全边界 |
| #37 双阈值 | 记忆写入需要置信度判断。90% 阈值允许恢复旧记忆（容错），97% 阈值防止低质量数据写入。**避免记忆系统的"信噪比退化"** |
| #55 fence | 模型可能把回忆内容误解为用户当前输入。用 XML 标签围栏 + 逃逸过滤是简单有效的防御。**1 天工作量，避免一类难以调试的 bug** |
| #70 双模检索 | 简单查询无需 LLM 介入（BM25+向量 RRF 即可），复杂查询才升级到 LLM 扩展 + 多轮检索。**检索成本按需分级，与 Quilin 成本感知设计哲学一致** |
| #60 辩证记忆 | Honcho 的辩证 Q&A 理念创新（让 AI peer 互相质询），但 Quilin 有 OmniMem 统一架构，不需要额外的记忆插件层。**仅参考其辩证质询的思路** |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **记忆检索精度** (top-5 recall) | > 80% | 离线评测: 给定查询，相关记忆是否在前 5 个结果中 | 回忆质量 |
| **梦境整理冗余度降低** | 每次 dreaming 后冗余记忆减少 > 40% | 比率: dreaming 前后的去重记忆条目数 | 记忆系统"健康度" |
| **跨会话记忆命中率** | > 70%（用户再次提到先前信息时能正确回忆） | 标注测试: 跨会话信息召回准确率 | 长期用户体验 |
| **记忆污染率** | < 2% 的长期记忆来自外部数据源 | 审计: 抽样检查 long-term memory 的数据来源标记 | 数据质量 |
| **记忆写入置信度分布** | 自动写入 > 97% 的占比 > 80%；人工确认的 90-97% 区间占比 < 15% | 直方图: `memory.write_confidence` | 系统自主性 vs 安全性平衡 |
| **Health score 分布** | < 35%（触发恢复）的占比 < 5% | gauge: `memory.health_score` per workspace | dreaming 策略是否有效 |
| **Foresight 命中率** | > 60% 的前瞻记忆在时间窗口内被触发并产生用户正向反馈 | 比率: `memory.foresight_triggered_positive` / `memory.foresight_triggered` | 前瞻记忆是否有价值 |
| **LoCoMo benchmark 得分** | > 90%（对标 EverOS HyperMem 92.73%） | 离线评测: LoCoMo 标准测试集 | 记忆系统综合检索质量 |
| **记忆溯源完整率** | > 99% 的记忆条目可追溯到源 MemCell | 审计: `memory.traceable` / `memory.total` | 记忆可审计性 |

---

## 04-规划工程（3 项创新）

**行业评分**：CC=2, CX=3, OC=4, HA=4 | **最佳参考**：OpenClaw（死锁检测）+ Hermes（预算 refund）

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 49 | **refund() 迭代预算**：execute_code 等编程式工具免费，预算不计入廉价 RPC 调用 | Hermes | **P0** | 直接移植 |
| 40 | **规划-行动死锁检测**：检测 Agent 只规划不行动，注入 "act-now steer" 打破循环 | OpenClaw | **P0** | 借鉴重写 |
| 30 | **Pending Input 中途注入**：模型运行时用户可提交 pending input，下次循环迭代时注入 | Codex | P2 | 借鉴思路 |

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #49 refund() | **解决了一个根本矛盾**：Agent 需要迭代次数限制防止无限循环，但编程式工具调用（文件读取、命令执行）本质上是"廉价操作"，不应占用预算。Hermes 的 refund 机制让 execute_code 调用后退还预算。**无此机制，Agent 读 5 个文件就用完预算，根本做不了复杂任务** |
| #40 死锁检测 | Agent **只规划不行动**是最常见的失效模式之一。当模型输出连续 N 次都是规划内容而无实际工具调用时，注入 "act-now steer" 消息打破循环。**简单有效，直接解决高频 Agent 失效** |
| #30 Pending Input | 用户在 Agent 执行过程中发现方向不对，需要立即纠正。Codex 允许用户提交 pending input，在下个循环迭代时注入。**增强人类对 Agent 的实时掌控力**，但实现复杂度较高，P2 |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **有效迭代占比** | refund 后 > 80% 的迭代产生实质性进展 | 比率: `planning.effective_iterations` / `planning.total_iterations` | 预算利用效率 |
| **预算内任务完成率** | > 90% 的任务在预算内完成 | 比率: `planning.completed_in_budget` / `planning.total_tasks` | 预算设定是否合理 |
| **死锁检测触发率** | < 5% 的 session 触发死锁检测 | 计数器: `planning.deadlock_detected` / `planning.session_total` | 模型质量指标（高触发率=模型倾向"空谈"） |
| **死锁恢复成功率** | > 80% 的死锁在 act-now steer 后成功恢复 | 比率: `planning.deadlock_recovered` / `planning.deadlock_detected` | steer 策略是否有效 |
| **refund 占比** | 30-50% 的迭代被 refund（说明 Agent 正常使用工具） | 直方图: `planning.refund_rate` per session | 过低=Agent 不用工具；过高=设计不合理 |

---

## 05-工具工程（7 项创新）

**行业评分**：CC=5, CX=5, OC=3, HA=5 | **三方互补**

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 6 | **Tool 安全属性自声明**：每个工具自声明 isDestructive / isReadOnly / isConcurrencySafe / interruptBehavior / checkPermissions | Claude Code | **P0** | 直接移植 |
| 53 | **自注册工具系统**：import 时 register()，RLock 支持 MCP 动态刷新，deregister 全清重建 | Hermes | **P0** | 借鉴 TS decorator 版 |
| 4 | **StreamingToolExecutor**：模型还在流式输出就开始执行工具，三级 AbortController 树，选择性错误级联 | Claude Code | P1 | 借鉴重写 |
| 11 | **Deferred Tools + ToolSearch**：shouldDefer/alwaysLoad/searchHint 三字段协议，模型需先搜索才能使用 | Claude Code | P1 | 借鉴重写 |
| 54 | **工具名三级修复**：lowercase→normalize→Levenshtein (cutoff=0.7) | Hermes | P1 | 直接移植 |
| 12 | **Partition 算法**：连续 read-only 工具合并为并发批次，write 工具独立成串行批次 | Claude Code | P2 | 借鉴思路 |
| 61 | **白名单并行工具执行**：11 个已知只读工具，max 8 workers 并行 | Hermes | P2 | 与 #12 融合 |

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #6 安全属性自声明 | **将安全属性分散到每个工具定义中，而非集中管理**。每个工具最清楚自己是否破坏性、是否只读、是否可并发。这让安全审查和并发调度都基于工具自己的声明，而非外部硬编码的列表。**Quilin 05-Tool 和 07-Safety 的接口基石** |
| #53 自注册 | Hermes 的工具在 import 时自动注册到全局 registry，新增工具零配置。MCP 动态刷新时 nuke-and-repave（全清重建）保证一致性。**Quilin 的 @registerTool() 装饰器应基于此模式** |
| #4 StreamingToolExecutor | 传统做法：等模型全部输出完再执行工具。Claude Code 在模型**还在输出时**就开始执行已解析的工具调用。对 10+ 工具的 turn 可节省数秒延迟。**显著提升端到端响应速度** |
| #54 工具名修复 | 模型经常输出错误的工具名（大小写错误、连字符/下划线混淆、近似名）。三级修复：精确匹配→标准化→模糊匹配，避免因工具名错误导致整个 turn 失败。**低成本高回报** |
| #12+#61 并发策略 | Claude Code 的 Partition 算法（基于工具属性动态分批）比 Hermes 的白名单（硬编码 11 个工具）更通用。**融合：用 #6 的安全属性声明驱动 #12 的 Partition 算法** |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **工具调度延迟** | p95 < 100ms（从模型输出工具调用到开始执行） | OTel span: `tool.dispatch_latency` | 端到端响应速度 |
| **流式执行节省时间** | 多工具 turn 端到端延迟减少 > 40% | 对比: StreamingToolExecutor vs 串行执行的 `turn.duration` | StreamingToolExecutor 的 ROI |
| **并发工具吞吐量** | > 5 工具/秒（read-only 批次） | 速率: `tool.concurrent_batch_throughput` | 并发调度效率 |
| **工具名修复成功率** | > 85% 的错误工具名被正确修复 | 比率: `tool.name_repair_success` / `tool.name_repair_attempt` | 模型容错能力 |
| **Deferred Tools 命中率** | ToolSearch 首次搜索命中率 > 90% | 比率: `tool.deferred_search_hit` / `tool.deferred_search_total` | 工具发现效率 |
| **工具注册一致性** | MCP 动态刷新后 0 孤儿工具 | 审计: 刷新前后的工具集对比 | 注册系统可靠性 |

---

## 06-多 Agent 工程（2 项创新）

**行业评分**：CC=2, CX=4, OC=3, HA=2 | **最佳参考**：Codex（ThreadManager + SharedServices）

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 27 | **ThreadManager 共享服务**：所有子线程共享 auth, models, mcp, skills 实例，避免重复初始化 | Codex | P1 | 借鉴重写 |
| 26 | **ForkSnapshot 模式**：TruncateBeforeNthUserMessage / Interrupted 两种 fork 策略 | Codex | P2 | 参考设计 |

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #27 共享服务 | 创建子 Agent 时，LLM client、MCP connections、auth tokens 等重型资源如果每次重建，创建延迟 > 3s。共享父 Agent 的资源实例可降到 < 500ms。**Quilin 06-多 Agent 的 Homogeneous Spawn 必须有资源共享层** |
| #26 ForkSnapshot | 子 Agent 不一定需要完整对话历史。Codex 提供两种截断策略——按用户消息数截断或从中断点开始。**在 Quilin 的 Agent Mesh 场景下参考，但实现需适配跨进程通信** |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **子 Agent 创建延迟** | < 500ms（资源共享时） | OTel span: `agent.spawn_latency` | 多 Agent 协作的启动开销 |
| **共享资源复用率** | > 90% 的资源来自共享池，< 10% 需重新创建 | 比率: `agent.resource_shared` / `agent.resource_total` | 资源利用效率 |
| **子 Agent 上下文大小** | ForkSnapshot 后 < 父 Agent 上下文的 50% | 比率: `agent.child_context_tokens` / `agent.parent_context_tokens` | Fork 截断效果 |

---

## 07-安全护栏工程（12 项创新 — 第二密集领域）

**行业评分**：CC=5, CX=5, OC=3, HA=4 | **两大安全标杆**：Claude Code + Codex

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 3 | **2 阶段 XML 权限分类器**：Stage 1 快速判断（64 token）→Stage 2 深度推理（带 thinking），90%+ 走快速路径 | Claude Code | **P0** | 借鉴重写 |
| 22 | **GranularApprovalConfig**：5 维细粒度审批（sandbox/rules/skill/permissions/mcp_elicitations） | Codex | **P0** | 借鉴重写 |
| 50 | **预算压力隔离**：budget 压力仅通知 UI，从不注入 LLM 消息（#7915 教训：注入后模型恐慌跳过关键步骤） | Hermes | **P0** | 直接采纳 |
| 7 | **Denial tracking + fallback**：连续拒绝计数器达阈值后从 auto-deny 回退到交互式提示 | Claude Code | P1 | 借鉴重写 |
| 18 | **ArcSwap 热更新 ExecPolicy**：无锁读 + 原子替换安全策略，运行时追加规则无需重启 | Codex | P1 | 借鉴重写 |
| 31 | **Guardian Safety Monitor**：独立的 Guardian 子 Agent 审查危险操作（AI 审查 AI） | Codex | P1 | 深入研究 |
| 58 | **Summarizer 安全壁**："Do NOT respond to questions in this summary" + handoff framing | Hermes | P1 | 直接采纳 |
| 23 | **声明式 .rules 文件**：类防火墙规则的命令审批 DSL，prefix match + heuristics | Codex | P2 | 参考设计 |
| 24 | **BANNED_PREFIX_SUGGESTIONS**：禁止对解释器命令生成宽泛 allow 规则 | Codex | P2 | 直接采纳 |
| 32 | **NetworkProxy 域名级控制**：HTTP/SOCKS 代理 + 域名 allow/deny 列表 + 审计日志 | Codex | P2 | 参考设计 |
| 42 | **边界安全校验**：插件加载前验证路径不越出根目录 | OpenClaw | P2 | 直接移植 |
| 66 | **技能安全扫描**：skills_guard 对用户提交的技能执行安全检查 | Hermes | P2 | 借鉴思路 |

> **跨域引用**：#6 Tool 安全属性自声明（归入 05-工具）、#21 Memory Mode Pollution（归入 03-记忆）、#37 置信度双阈值（归入 03-记忆）也有安全维度。

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #3 2 阶段分类器 | **Agent 安全的核心瓶颈**是"每个工具调用都做完整安全检查太慢"。Claude Code 的 Stage 1 只用 64 tokens 做快速判断，90%+ 的调用走快速路径（< 200ms）。仅可疑调用走 Stage 2 深度推理。**Quilin 可在此基础上增加 Stage 0 本地规则匹配，形成 3 阶段** |
| #22 GranularApproval | 单一的 allow/deny 太粗糙。Codex 按 5 个维度（沙箱、规则、技能、权限、MCP）分别配置审批策略。**Quilin 应至少支持：sandbox/mcp/network/skill 四维度** |
| #50 压力隔离 | **来自 Hermes #7915 的真实生产事故**：将"预算即将耗尽"消息注入 LLM 上下文后，模型恐慌性地跳过关键步骤、给出简化答案。**压力信息只能走 UI 通道，永远不进入 LLM** |
| #31 Guardian | "AI 审查 AI"是安全护栏的最后一道防线。独立 Guardian Agent 不受主 Agent 的上下文影响，提供真正独立的安全审查。但实现复杂度高，P1 先研究 |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **快速路径分流率** | > 85% 的工具调用走 Stage 1 快速路径 | 比率: `safety.stage1_fast_path` / `safety.total_checks` | 安全检查对延迟的影响 |
| **分类器延迟** | Stage 1: p95 < 200ms; Stage 2: p95 < 2s | OTel span: `safety.classifier_latency` by stage | 用户感知的"权限等待" |
| **误拒率** (False Positive) | < 5%（合法操作被错误拒绝） | 用户反馈标注 + 自动审计 | 用户体验（过高=Agent 不可用） |
| **漏放率** (False Negative) | < 0.1%（危险操作被放行） | 安全审计 + 红队测试 | 安全底线（不可妥协） |
| **连续拒绝恢复率** | Denial tracking 触发后 > 90% 恢复到正常工作流 | 比率: `safety.denial_recovered` / `safety.denial_triggered` | 防止 Agent 死锁 |
| **热更新延迟** | 安全策略更新 < 100ms，无请求中断 | OTel span: `safety.policy_update_latency` | 运维灵活性 |

---

## 08-可观测性工程（4 项创新）

**行业评分**：CC=3, CX=4, OC=2, HA=1 | **最佳参考**：Codex（W3C Trace + OTel）

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 25 | **W3C Trace Context 集成**：每个 Submission 携带 traceparent/tracestate，支持端到端追踪 | Codex | **P0** | 直接采纳 |
| 15 | **断路器模式**：连续 3 次失败停止重试，基于线上数据（250K API calls/day 浪费）的阈值 | Claude Code | P1 | 借鉴重写 |
| 5 | **两阶段 Prompt Cache 检测**：Phase 1 预记录 12+ 维度哈希，Phase 2 检查 token 下降，精确定位失效原因 | Claude Code | P2 | 参考设计 |
| 33 | **日志异步批量写入**：tracing Layer→mpsc→批量 SQLite INSERT，try_send 不阻塞 | Codex | P2 | 参考模式 |

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #25 W3C Trace Context | **唯一能实现跨 Agent 端到端追踪的标准**。Quilin 的 Agent Mesh 场景中，一个请求可能经过多个 Agent，没有标准化的 trace propagation 就无法做分布式追踪。**从第一天就集成 W3C traceparent** |
| #15 断路器 | Claude Code 基于 250K API calls/day 的线上数据确定了"3 次连续失败停止重试"的阈值。**数据驱动的运维优化**。Quilin 应实现通用断路器，初始阈值参考 Claude Code |
| #5 Cache 检测 | Quilin 通过 litellm 接多模型，不直接管理 Anthropic prompt cache。但检测思路（预记录哈希→对比实际 token）可参考用于 Quilin 自己的 cache 优化 |
| #33 异步写入 | try_send（队列满时丢弃）而非 send（阻塞）是正确选择——日志不应影响核心功能。但 Quilin 应直接用 OTel exporter，不需要自建 SQLite 日志 |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **端到端追踪覆盖率** | > 95% 的请求可被完整追踪 | 审计: 有 traceparent 的请求占比 | 故障定位能力 |
| **追踪上下文传播完整性** | 跨 Agent Mesh 的 trace 传播丢失率 < 1% | 比率: 完整 trace / 发起 trace | 分布式追踪质量 |
| **断路器触发频率** | < 1% 的 session 触发断路器 | 计数器: `observability.circuit_breaker_opened` | 系统健康度（高触发=依赖不稳定） |
| **日志/指标写入延迟** | p99 < 10ms（异步写入不阻塞主路径） | OTel span: `observability.write_latency` | 可观测性系统自身不成为瓶颈 |

---

## 09-部署运行时工程（7 项创新）

**行业评分**：CC=3, CX=4, OC=4, HA=2 | **最佳参考**：Codex（SQ/EQ）+ OpenClaw（双队列）

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 16 | **SQ/EQ 队列对架构**：SQ bounded(512) + EQ unbounded，分离用户输入与 Agent 处理，提供背压控制 | Codex | **P0** | 借鉴 TS 版 |
| 38 | **双队列调度**：Session 级串行 + 全局级并发的两层队列 | OpenClaw | P1 | 与 #16 融合 |
| 2 | **feature() 编译期功能开关**：构建时消除 edition-specific 代码 | Claude Code | P2 | 参考思路 |
| 43 | **Partial snapshot on abort**：中断时保存已生成内容，不丢失部分结果 | OpenClaw | P2 | 借鉴思路 |
| 44 | **Symbol.for 全局单例**：解决 ESM 多路径 import 的实例不一致 | OpenClaw | P2 | 直接采纳 |
| 46 | **两级注册模式**：cli-metadata（轻量）vs full（完整）加速 CLI 启动 | OpenClaw | P2 | 借鉴思路 |
| 57 | **写竞争 jitter 重试**：应用层 15 次随机 sleep（20-150ms） | Hermes | P2 | 评估需要性 |

> **不吸收**：#8 Session-stable latching（Claude Code）— 与 Anthropic API beta header 绑定，Quilin 有自己的配置管理。

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #16 SQ/EQ | **解决 Agent 系统的核心并发问题**：用户输入和 Agent 处理需要不同的排队策略。SQ（bounded, 背压）防止用户消息淹没系统；EQ（unbounded, 异步）确保 Agent 事件不丢失。**Quilin 的 E-T-C-S-L-V 工具调用可直接基于此模式** |
| #38 双队列 | 与 #16 互补。Session 级串行保证单用户请求有序，全局级并发允许多用户并行。**融合后形成三层：SQ（入站）→ Session Lane（有序）→ EQ（Agent 事件）** |
| #46 两级注册 | CLI 启动时加载所有工具的完整定义很慢。两级注册：先加载元数据（轻量），实际使用时再加载完整定义。**与 #11 Deferred Tools 理念一致，从不同角度优化启动性能** |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **冷启动时间** | < 3s（到 mesh 就绪，所有能力可用） | OTel span: `runtime.cold_start_duration` | 用户首次体验 |
| **SQ 背压触发率** | < 0.1%（正常负载下几乎不触发） | 计数器: `runtime.sq_backpressure_events` | 系统是否过载 |
| **EQ 消息积压** | 峰值 < 100 条（正常 < 10） | gauge: `runtime.eq_queue_depth` | Agent 处理是否跟上 |
| **热更新延迟** | 配置/策略更新 < 100ms，无请求中断 | OTel span: `runtime.hot_update_latency` | 运维灵活性 |
| **中断时数据保留率** | Partial snapshot 保留 > 80% 已生成内容 | 比率: 保存的 token 数 / 中断前已输出 token 数 | 用户体验（不因中断丢失工作） |

---

## 10-自进化工程（3 项创新 — 新增 EverOS 1 项）

**行业评分**：CC=1, CX=2, OC=2, HA=3, **EV=3** | **最高仅 3 分 — Quilin 核心差异化得到验证**

| # | 创新点 | 来源 | 优先级 | 吸收方式 |
|---|--------|------|:------:|---------|
| 65 | **Nudge 式后台回顾**：完整 Agent fork 在 daemon 线程中执行后台回顾，每 10 轮触发一次 | Hermes | P2 | 作为 L0 基线 |
| 18 | **ArcSwap 热更新 ExecPolicy**：无锁读 + 原子替换策略，自进化修改安全规则无需重启 | Codex | P1 | 借鉴 TS 版 |
| 71 | **EvoAgentBench**：首个标准化 Agent 自进化 benchmark，5 领域 train/test 分割，评估 Agent 从轨迹中提取技能的能力 | EverOS | P1 | 直接用作验证集 |

> **跨域引用**：#18 同时归入 07-安全护栏（作为热更新机制的直接受益者）。

### 判断依据

| 创新 | 为什么吸收（或不吸收） |
|------|---------------------|
| #65 Nudge 自进化 | **全行业最接近"自进化"的实现**——但仍然很原始（仅周期性后台回顾，无轨迹分析/scaffold 自修改/技能创建）。作为 Quilin 10-SelfEvolution 的 L0 baseline：先实现最低成本的后台回顾，再在此基础上叠加轨迹分析、主动进化。**不是目标，而是起点** |
| #18 热更新 | 自进化的前提是**运行时能应用修改**。如果每次进化结果都需要重启才能生效，自进化就失去了意义。ArcSwap 模式让安全规则/配置/scaffold 可以在运行时原子替换。**自进化的基础设施** |
| #71 EvoAgentBench | **首个标准化的 Agent 自进化评测集**。5 个领域（代码、数据分析、网页、系统管理、创意写作）的 train/test 分割，评估 Agent 从执行轨迹中提取可复用技能的能力。Quilin 10-SelfEvolution 需要标准化验证，EvoAgentBench 免费提供了现成的评测基础设施 |

### 可观测指标

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **自进化触发频率** | 每 10 轮 turn 触发 1 次后台回顾（可配置） | 计数器: `evolution.nudge_triggered` per session | 进化活跃度 |
| **进化后性能不退化率** | > 99%（进化后的任务完成率不低于进化前） | A/B 对比: 进化前后的 benchmark 得分 | **核心安全指标：进化不能让系统变差** |
| **技能创建成功率** | > 80% 的自动创建技能通过验证 | 比率: `evolution.skill_validated` / `evolution.skill_created` | 进化质量 |
| **热更新应用成功率** | > 99.9% | 比率: `evolution.hot_update_success` / `evolution.hot_update_attempt` | 基础设施可靠性 |
| **回滚率** | < 5% 的进化需要回滚 | 比率: `evolution.rollback` / `evolution.applied` | 进化决策质量 |

---

## 11-Agent Mesh 工程（0 项创新 — 全行业空白）

**行业评分**：CC=0, CX=1, OC=1, HA=0 | **无参考 — Quilin 完全原创**

**全部 66 个创新点中，没有任何一项直接关联 Agent Mesh。**

这验证了 Quilin 的战略判断：
- 4 个标杆项目、2,034K 行代码、66 个创新点——**没有一个涉及跨进程 Agent 发现、消息路由或去中心化通信**
- Codex 的 ThreadManager（#27）和 ForkSnapshot（#26）是进程内多 Agent，不是 mesh
- OpenClaw 的嵌入式 Pi agent 是单进程模式

**11-Agent Mesh 是 Quilin + AgentMesh 项目的独有赛道**，无需吸收任何外部创新，完全原创设计。

### 可观测指标（原创设计，参考 11-Agent Mesh 工程规格）

| 指标 | 目标值 | 测量方式 | 业务意义 |
|------|-------|---------|---------|
| **mesh 就绪延迟** | < 2s（meshd 已运行时） | OTel span: `mesh.startup_latency` | 启动到可被发现的时间 |
| **出站消息延迟** | < 50ms（本机 agent 间） | OTel span: `mesh.send_latency` | Agent 间通信效率 |
| **入站推送延迟** | < 20ms（meshd 到 Quilin 回调） | OTel span: `mesh.receive_latency` | 消息投递实时性 |
| **Agent 发现准确率** | 100%（本机已注册 agent 全部可发现） | 审计: discover 结果 vs 已注册列表 | 服务发现可靠性 |
| **断连检测时间** | < 5s | OTel span: `mesh.disconnect_detection` | 故障感知速度 |
| **重连延迟** | < 3s（meshd 重启后） | OTel span: `mesh.reconnect_latency` | 恢复能力 |

---

## 全局汇总

### 按优先级统计

| 优先级 | 数量 | 分布 |
|:------:|:----:|------|
| **P0** | 13 | 02-上下文(5)、05-工具(2)、07-安全(3)、04-规划(2)、**03-记忆(1: EverOS Foresight)** |
| **P1** | 22 | 跨所有领域（新增 EverOS 3 项：#68 HyperMem、#69 MemCell、#71 EvoAgentBench） |
| **P2** | 23 | 跨所有领域（新增 EverOS 1 项：#70 双模检索） |
| 不吸收 | 3 | #8 Session-stable latching, #13 Tombstone, #62 三 API 统一 |

### 13 项 P0 创新一览

| # | 创新 | 来源 | 目标领域 | 工作量 |
|---|------|------|---------|--------|
| 1 | 5 层压缩流水线 | CC | 02-上下文 | 3-5d |
| 34 | ContextEngine 7 生命周期 trait | OC | 02-上下文 | 3-5d |
| 51 | 四阶段压缩（与 #1 融合） | HA | 02-上下文 | — |
| 52 | "Remaining Work" 命名 | HA | 02-上下文 | 0.5d |
| 28 | 上下文差分注入 | CX | 02-上下文 | 2-3d |
| 6 | Tool 安全属性自声明 | CC | 05-工具 | 1-2d |
| 53 | 自注册工具系统 | HA | 05-工具 | 2-3d |
| 3 | 2 阶段 XML 权限分类器 | CC | 07-安全 | 3-5d |
| 22 | GranularApprovalConfig | CX | 07-安全 | 2-3d |
| 50 | 预算压力隔离 | HA | 07-安全 | 0.5d |
| 49 | refund() 迭代预算 | HA | 04-规划 | 1-2d |
| 40 | 规划-行动死锁检测 | OC | 04-规划 | 2-3d |
| 36 | 三阶段记忆梦境 | OC | 03-记忆 | 5-8d |
| **67** | **Foresight Memory（前瞻记忆）** | **EverOS** | **03-记忆** | **3-5d** |
| 17 | 双循环 Agent 引擎 | CX | 01-LLM | 3-5d |
| 16 | SQ/EQ 队列对架构 | CX | 09-运行时 | 3-5d |
| 25 | W3C Trace Context | CX | 08-可观测 | 2-3d |

> 注：#51 与 #1 融合实现，#36 三阶段梦境工作量最大（5-8 天）但价值也最高。**#67 Foresight Memory 是全行业独有创新，直接支撑 Quilin 的时间感知 + Aha Moment 设计哲学。**

### 按来源项目统计

| 来源 | P0 | P1 | P2 | 总贡献 |
|------|:--:|:--:|:--:|:------:|
| Claude Code | 3 | 5 | 4 | 12/15 |
| Codex CLI | 4 | 5 | 7 | 16/18 |
| OpenClaw | 3 | 4 | 5 | 12/15 |
| Hermes Agent | 4 | 5 | 6 | 15/18 |
| **EverOS** | **1** | **3** | **1** | **5/5** |

**吸收覆盖率**：71 项中 68 项建议吸收（96%），3 项明确不吸收。

### 实施路线图

```
Phase 0 — PoC 核心（5 领域 × 13 项 P0）:
  02-上下文: ContextEngine Trait + 压缩管线融合 + 差分注入 + "Remaining Work"
  05-工具:   安全属性自声明 + 自注册系统
  07-安全:   2 阶段 Classifier + 5 维审批 + 压力隔离
  04-规划:   refund 预算 + 死锁检测
  03-记忆:   三阶段 Dreaming + Foresight Memory（EverOS）融入 OmniMem
  01-LLM:    双循环引擎
  09-运行时: SQ/EQ 队列对
  08-可观测:  W3C Trace Context

Phase 1 — 核心完善（22 项 P1）:
  跨所有领域的 P1 项目
  03-记忆: HyperMem 超图升级 + MemCell 原子单元
  10-自进化: EvoAgentBench 验证集集成

Phase 2 — 差异化（23 项 P2 + 原创设计）:
  10-自进化: Hermes L0 基线 + Quilin 原创轨迹分析 + User Insight Engine
  06-多Agent: Codex 共享服务模式
  11-Mesh:   AgentMesh SDK（完全原创，无外部参考）
```
