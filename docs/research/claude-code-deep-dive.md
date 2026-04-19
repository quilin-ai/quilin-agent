# Claude Code v2.1.88 深度调研报告

> 调研日期：2026-04-14
> 仓库：/Users/raysonmeng/repo/claude-code（本地泄露源码）
> 版本/Commit：v2.1.88
> 调研深度：deep
> 关注领域：01-LLM 接入, 02-上下文, 03-记忆, 04-规划, 05-工具, 06-多 Agent, 07-安全护栏, 08-可观测性, 09-部署运行时, 10-自进化, 11-Agent Mesh

---

## 1. 仓库概览

- **定位**：Anthropic 官方 CLI Agent 工具——在终端中直接调用 Claude 模型完成代码生成、文件编辑、系统操作等任务的 Agent 框架
- **语言**：TypeScript（核心 ~512K 行），构建工具为 Bun
- **核心依赖**：`@anthropic-ai/sdk`（API 调用）、`zod/v4`（输入校验）、`diff`（缓存差异检测）、`shell-quote`（Bash 命令解析）、React/Ink（TUI 渲染）
- **活跃度**：GitHub 最活跃的 Agent 项目之一，Anthropic 官方维护，持续高频迭代
- **License**：非公开发行（泄露源码），与 Apache 2.0 兼容性存疑——**仅供调研学习，不得直接移植代码**
- **构建系统特征**：使用 `bun:bundle` 提供编译期 `feature()` 宏，实现 ant-only 功能的死代码消除（详见架构映射）

---

## 2. 架构映射

### 入口与核心抽象

```
用户输入
  │
  ▼
query() ─── 外层包装，跟踪 consumedCommandUuids，通知 lifecycle
  │
  ▼
queryLoop() ─── while(true) 状态机，1,488 行（L241-L1729）
  │
  ├─ 1. 上下文压缩 5 层流水线
  │     applyToolResultBudget → snipCompact → microCompact → contextCollapse → autoCompact
  │
  ├─ 2. 模型调用 + 流式处理
  │     StreamingToolExecutor (流式并发) / runTools (批次并发)
  │     callModel() → streaming → tool_use block 检测 → 即时执行
  │
  ├─ 3. 错误恢复
  │     prompt_too_long → reactive_compact
  │     max_output_tokens → 8k→64k 升级 → 多轮恢复(最多 3 次)
  │     model fallback → 切换备用模型
  │
  ├─ 4. 工具执行 + 结果收集
  │     权限检查 → 工具调用 → 结果归一化 → 附件注入
  │
  └─ 5. 状态转移
        State 对象携带 messages、toolUseContext、tracking
        7+ 个 continue 站点，每个都构造新 State
```

**关键纠正**：外部分析常说"88 行核心循环"——实际 `queryLoop()` 函数体从 L241 到 L1729，共 **1,488 行**。这不是一个简洁的循环，而是一个包含了压缩、流式、恢复、执行、附件等完整 Agent 生命周期的巨型状态机。

### State 类型（L204-L217）

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined  // 上一次迭代为什么 continue
}
```

**设计决策**：State 是可变的，但每次 continue 都通过 `state = { ... }` 整体替换（而非分散赋值），在可变性与可追踪性之间取得了平衡。`transition` 字段让测试可以断言恢复路径是否触发，无需检查消息内容。

### 设计决策

| 决策 | 选择 | 理由 | 我们的评价 |
|------|------|------|-----------|
| Agent Loop 实现 | `while(true)` + async generator，非框架 | 避免框架抽象泄漏，1,488 行可完全掌控 | **值得借鉴**：Quilin ADR-001 已确认同款方案 |
| 状态管理 | 单一 State 对象，每次 continue 整体替换 | 避免 9 个分散赋值，transition 字段支持测试断言 | **巧妙**：类似 Redux 的 action reason |
| 上下文压缩 | 5 层递进流水线，而非单一策略 | 每层处理不同粒度（工具结果 → 片段 → 微压缩 → 段落折叠 → 全量摘要） | **核心创新**：Quilin 02-Context 的首要参考 |
| 工具执行时机 | 流式执行（StreamingToolExecutor），模型还在输出就开始执行 | 减少端到端延迟 | **激进但有效**：需要处理 fallback 丢弃场景 |
| 权限模型 | 2 阶段 XML 分类器 + 4 快速路径绕过 | 安全（Stage 1 快，Stage 2 严）且不牺牲延迟 | **精密**：Quilin 07-Safety 的首要参考 |
| 构建期功能开关 | `feature('XXX')` 编译期消除死代码 | ant-only 功能不泄露到外部构建 | **实用**：Quilin 可借鉴做 edition 区分 |
| Prompt Cache 检测 | 两阶段（预记录哈希 + 后检查 token 下降） | 精确定位哪个维度导致缓存失效 | **过度工程但有价值**：仅关键路径需要 |

---

## 3. 核心文件分析

### 3.1 `src/query.ts`（1,729 行）—— Agent Loop 核心

- **职责**：整个 Agent 的主循环。`query()` 是外层包装，`queryLoop()` 是内层 `while(true)` 状态机
- **核心结构**：
  - L1-100：条件导入，`feature()` 编译期门控（REACTIVE_COMPACT, CONTEXT_COLLAPSE, EXPERIMENTAL_SKILL_SEARCH, TEMPLATES）
  - L204-217：`State` 类型，跨迭代可变状态
  - L241-307：`queryLoop()` 入口，State 初始化，`budgetTracker` 创建
  - L307-550：主循环体开始——技能预取、查询链追踪、**5 层压缩流水线**按序执行
  - L550-850：流式处理区——StreamingToolExecutor 初始化、模型选择、API 调用、tool_use block 在流中检测并即时派发执行
  - L850-1000：后流式处理——cached microcompact 边界、FallbackTriggeredError 处理（模型降级）、abort 处理
  - L1000-1180：错误恢复链——prompt_too_long 恢复（contextCollapse drain → reactiveCompact）、max_output_tokens 升级（8k→64k→多轮恢复最多 3 次）
  - L1185-1357：恢复耗尽处理、stop hooks、token budget 续写（带递减回报检测）
  - L1360-1729：工具执行派发（流式 vs 批次 `runTools`）、工具摘要生成（异步 Haiku）、中断处理、附件注入、记忆预取、技能发现注入、maxTurns 检查

- **创新点**：
  1. **5 层上下文压缩流水线**：每次循环迭代按序执行 `applyToolResultBudget → snipCompact → microCompact → contextCollapse → autoCompact`，粒度从工具结果级到全量对话摘要递进
  2. **State 整体替换 + transition reason**：7+ 个 continue 站点，每个都 `state = { ...next, transition: { reason: 'xxx' } }`，让状态变迁可观测可测试
  3. **Tombstone 消息**：流式 fallback 时，为已发出但未完成的 assistant 消息生成 tombstone，避免孤儿消息
  4. **taskBudgetRemaining 跨压缩追踪**：压缩后服务端只看到摘要，客户端需自行追踪剩余预算（L282-291）
  5. **`using` 关键字管理 memoryPrefetch**：利用 TC39 Explicit Resource Management 自动清理（L301-304）

- **可吸收**：5 层压缩流水线的分层思想、State + transition 模式、错误恢复链
- **注意事项**：1,488 行单函数是重大可维护性风险。Quilin 应将其拆分为独立的 Phase 模块

### 3.2 `src/services/tools/StreamingToolExecutor.ts`（530 行）—— 流式工具执行器

- **职责**：在模型仍在流式输出时开始执行工具，支持并发控制和有序结果发射
- **核心结构**：
  - L40-62：类定义，`tools` 数组、`siblingAbortController`（子级，杀死兄弟进程）、`discarded` 标志
  - L76-124：`addTool()` — 判断并发安全性，入队并触发 `processQueue()`
  - L129-151：`canExecuteTool()` + `processQueue()` — 并发控制核心逻辑
  - L153-200：`createSyntheticErrorMessage()` — 为 sibling_error、user_interrupted、streaming_fallback 三种场景生成合成错误
  - L265-405：`executeTool()` — 每个工具有独立的 `toolAbortController`（siblingAbortController 的子级），Bash 错误级联取消兄弟工具
  - L412-440：`getCompletedResults()` — 非阻塞，按顺序发射已完成结果 + 立即发射进度消息
  - L453-490：`getRemainingResults()` — 阻塞等待，使用 `Promise.race` + `progressAvailableResolve` 信号

- **创新点**：
  1. **三级 AbortController 树**：`toolUseContext.abortController`（用户级）→ `siblingAbortController`（兄弟级）→ `toolAbortController`（单工具级）。Bash 错误只触发 sibling 级，不影响父级查询循环
  2. **选择性错误级联**：只有 Bash 错误取消兄弟（命令链有隐式依赖），Read/WebFetch 等独立工具的错误不级联（L358-363）
  3. **结果有序发射**：并发执行但按工具接收顺序发射结果，维护消息一致性
  4. **进度消息即时旁路**：progress 消息不参与排序队列，立即 yield（L368-375）
  5. **`discard()` 机制**：流式 fallback 时丢弃所有待处理工具，防止旧 tool_use_id 泄漏到重试

- **可吸收**：三级 abort 树、选择性错误级联策略、流式工具执行模式
- **注意事项**：bubble-up 逻辑精密但脆弱（L305-317 的 `addEventListener('abort')` 回调），注释引用了 #21056 回归——说明这段代码出过严重 bug

### 3.3 `src/services/tools/toolOrchestration.ts`（188 行）—— 工具编排（非流式路径）

- **职责**：将工具调用分区为并发安全批次和串行批次，分别执行
- **核心结构**：
  - L8-12：`getMaxToolUseConcurrency()` — 环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，默认 10
  - L19-82：`runTools()` — 迭代分区后的批次，并发批次用 `runToolsConcurrently`，串行批次用 `runToolsSerially`
  - L91-116：`partitionToolCalls()` — reduce 算法，检查每个工具的 `isConcurrencySafe`，连续的并发安全工具合入同一批次
  - L118-150：`runToolsSerially()` — 串行执行，context modifier 立即生效
  - L152-177：`runToolsConcurrently()` — 使用 `all()` 工具函数实现有界并行执行

- **创新点**：
  1. **Partition 算法**：连续的 read-only 工具合并为一个并发批次，非 read-only 工具单独成批。简单但有效——避免了复杂的依赖图分析
  2. **保守错误处理**：`isConcurrencySafe` 解析失败时默认 `false`（L106-107），shell-quote 解析异常也安全降级
  3. **Context modifier 延迟应用**：并发批次中的 context modifier 在整个批次完成后才应用（L54-62），避免竞态

- **可吸收**：Partition 算法思路、保守降级策略
- **注意事项**：这是 StreamingToolExecutor 出现前的旧路径。两套并行路径增加了维护负担

### 3.4 `src/services/tools/toolExecution.ts`（1,745 行）—— 工具执行 + 权限检查

- **职责**：单个工具的执行入口，包含权限检查、错误分类、OTel 追踪
- **核心结构**：
  - L150-171：`classifyToolError()` — telemetry 安全的错误分类（存活于代码压缩后）
  - L181-250：OTel 权限决策来源映射（rule、hook、classifier、mode）
  - L264-270：`MessageUpdateLazy` 类型，包含 contextModifier
  - L337-490：`runToolUse()` — 查找工具（支持别名回退到 `getAllBaseTools`），处理 abort，委派到 `streamedCheckPermissionsAndCallTool`
  - L492-550：`streamedCheckPermissionsAndCallTool()` — 使用 `Stream` 类合并进度事件和最终结果为单一 async iterable

- **创新点**：
  1. **别名回退机制**：工具改名后旧名仍可用，通过 `tool.aliases` 查找（L337-380）
  2. **`classifyToolError()` 的 telemetry 安全设计**：错误分类字符串在代码压缩后仍然有意义，而不是被混淆（L150-171）

- **可吸收**：工具别名机制、错误分类模式
- **注意事项**：1,745 行说明权限检查逻辑与工具执行耦合过深，应拆分

### 3.5 `src/utils/permissions/permissions.ts`（1,486 行）—— 权限引擎

- **职责**：决定一个工具是否可以执行。核心函数 `hasPermissionsToUseTool()`
- **核心结构**：
  - L109-131：规则来源常量，`getAllowRules`/`getDenyRules`/`getAskRules` 提取
  - L238-302：`toolMatchesRule()` — MCP 服务器级匹配，支持通配符
  - L400-471：`runPermissionRequestHooksForHeadlessAgent()` — 非交互 Agent 的 hook 权限
  - L473-700：`hasPermissionsToUseTool()` — 主权限检查流程

- **权限决策流（auto 模式）**：

```
tool.checkPermissions(input, context) → 'ask'?
  │
  ├─ Step A: safetyCheck 且 !classifierApprovable → 直接返回 ask（不可绕过）
  │
  ├─ Step B: requiresUserInteraction? → 直接返回 ask
  │
  ├─ Step C: acceptEdits 快速路径
  │     模拟 acceptEdits 模式重新调用 checkPermissions
  │     如果返回 allow → 自动批准（省去分类器调用）
  │
  ├─ Step D: 安全工具白名单快速路径
  │     内置的安全工具列表（Read、Grep 等）→ 自动批准
  │
  └─ Step E: 2 阶段 XML 分类器
        classifyYoloActionXml() → shouldBlock?
```

- **创新点**：
  1. **4 快速路径绕过分类器**：大多数工具调用无需走分类器，显著降低延迟和成本
  2. **Denial tracking with fallback-to-prompting**：连续拒绝计数器，达到阈值后从 auto-deny 回退到交互式提示（防止 Agent 死锁）
  3. **dontAsk 模式变换**：在函数末尾统一将 'ask' 转为 'deny'，保证所有路径都经过转换
  4. **PowerShell 特殊处理**：PS 在 auto 模式下默认需要交互确认（`iex (iwr ...)` 是高危模式），ant-only 构建才放行

- **可吸收**：4 快速路径架构、denial tracking + fallback 机制、分层权限模型
- **注意事项**：1,486 行的单文件权限逻辑是技术债。Quilin 应按层拆分

### 3.6 `src/utils/permissions/yoloClassifier.ts`（1,495 行）—— LLM 权限分类器

- **职责**：使用 LLM 判断工具调用是否安全（"YOLO" = You Only Live Once，即 auto 模式的核心大脑）
- **核心结构**：
  - L54-69：编译期条件模板加载（BASE_PROMPT, EXTERNAL/ANTHROPIC_PERMISSIONS_TEMPLATE）
  - L252-285：分类器工具 schema——`classify_result`，含 thinking/shouldBlock/reason 字段
  - L302-360：`buildTranscriptEntries()` — 提取 user text + assistant tool_use blocks（排除 assistant text 防止分类器操纵）
  - L384-442：`toCompactBlock()`/`toCompact()` — JSONL transcript 序列化，使用每个工具的 `toAutoClassifierInput` 投影
  - L460-540：`buildClaudeMdMessage()` + `buildYoloSystemPrompt()` — 分类器系统提示组装
  - L541-663：**2 阶段 XML 分类器核心**
  - L683-750：`getClassifierThinkingConfig()` — 自适应 thinking headroom

- **2 阶段 XML 分类器工作原理**：

```
Stage 1 (xml_s1_h2): 快速判断
  - suffix: "Err on the side of blocking. <block> immediately."
  - max_tokens: 64（极短）
  - 响应: <block>yes</block> 或 <block>no</block>
  - 如果 Stage 1 返回 <block>no</block> → 允许（快速路径）

Stage 2 (xml_s2_t2): 深度推理（仅 Stage 1 返回 yes 时触发）
  - suffix: "Review the classification process and follow it carefully..."
  - 请求 <thinking> 然后 <block>
  - 比 Stage 1 更审慎，减少误阻
```

- **创新点**：
  1. **2 阶段设计**：Stage 1 快（64 token）处理 90%+ 明显安全的调用，Stage 2 严（带 thinking）只处理可疑调用。成本和延迟大幅降低
  2. **Transcript 安全投影**：排除 assistant text，每个工具通过 `toAutoClassifierInput()` 只暴露安全相关的最小输入（L302-360）
  3. **`stripThinking()` 防御**：解析前先移除 `<thinking>` 块，防止思维链中的 `<block>` 标签干扰解析（L567-571）
  4. **自适应 thinking headroom**：alwaysOnThinking 模型不能 disable thinking，改为增加 max_tokens padding（L683-698）

- **可吸收**：2 阶段分类器架构、transcript 安全投影、阶段化决策思路
- **注意事项**：分类器本身调用 LLM，增加了延迟和成本。Quilin 可考虑本地小模型作为 Stage 0

### 3.7 `src/services/api/promptCacheBreakDetection.ts`（727 行）—— Prompt Cache 监控

- **职责**：两阶段检测 prompt cache 失效，精确定位失效原因
- **核心结构**：
  - L28-69：`PreviousState` 类型——追踪 12+ 维度：systemHash, toolsHash, cacheControlHash, perToolHashes, model, fastMode, betas, autoModeActive, effortValue, extraBodyHash, cacheDeletionsPending...
  - L101-107：`MAX_TRACKED_SOURCES=10`，按 querySource+agentId 键追踪
  - L160-196：哈希计算（`Bun.hash` 优先，djb2Hash 降级）
  - L247-430：`recordPromptState()` Phase 1——预调用哈希记录，检测 12+ 维度的变化
  - L437+：`checkResponseForCacheBreak()` Phase 2——检查实际 `cache_read_tokens` 是否下降超过 `MIN_CACHE_MISS_TOKENS=2000`

- **两阶段工作原理**：

```
Phase 1 (recordPromptState): API 调用前
  - 计算当前 system prompt / tool schemas / model / betas 等的哈希
  - 与上次记录对比，标记哪些维度发生了变化
  - 存入 pendingChanges（但不触发事件）

Phase 2 (checkResponseForCacheBreak): API 调用后
  - 检查 response.usage.cache_read_tokens 是否显著下降
  - 如果下降 > 2000 tokens 且 Phase 1 记录了变化 → 确认 cache break
  - 输出精确的变化维度（如 "toolSchemasChanged: AgentTool description mutated"）
  - 考虑 TTL 过期（5min cache 自然失效 ≠ break）
```

- **创新点**：
  1. **Per-tool 哈希差分**：当 toolsHash 整体变化时，逐工具对比找出具体是哪个工具的描述变了（L282-286）
  2. **Sticky-on Latching**：AFK_MODE、CACHE_EDITING 等 beta header 一旦启用就锁定不变（session-stable），防止中途翻转导致 cache bust
  3. **Lazy 计算**：per-tool hash 和 diffable content 只在需要时计算（common case: 没有变化，跳过 N 次 jsonStringify）

- **可吸收**：多维度缓存监控思路（Quilin 08-Observability 可参考）
- **注意事项**：727 行的缓存监控暗示 prompt cache 的成本足够高以至于值得这种投入。Quilin 如果不自己管 cache，此文件参考价值有限

### 3.8 `src/services/api/claude.ts`（3,419 行）—— API 调用层

- **职责**：构建和发送 Anthropic API 请求，管理缓存策略、effort 参数、流式响应
- **核心结构**（选读关键段落）：
  - L272-331：`getExtraBodyParams()` — 解析 `CLAUDE_CODE_EXTRA_BODY` 环境变量，支持 anti-distillation opt-in
  - L333-356：`getPromptCachingEnabled()` — 按模型禁用缓存
  - L358-434：`getCacheControl()` + `should1hCacheTTL()` — 1 小时 TTL 缓存，session-stable latching，GrowthBook allowlist 模式匹配
  - L440-501：`configureEffortParams()` + `configureTaskBudgetParams()` — effort 参数处理（string/numeric）、task budget wire format
  - L1017-1400：`queryModel()` — 主 API 调用函数：off-switch 检查、deferred tools/ToolSearch 逻辑、cached microcompact 设置、全局缓存策略、工具 schema 构建、消息归一化链、fingerprint 计算、系统提示组装

- **创新点**：
  1. **Session-stable latching**：beta header（如 `AFK_MODE_BETA_HEADER`）通过 bootstrap state 锁定——一旦检测到就永远保留，中途不翻转。防止 GrowthBook flag 变化导致 cache bust
  2. **Anti-distillation opt-in**：通过 `CLAUDE_CODE_EXTRA_BODY` 注入 `anthropic_internal` 参数（L272-331），暗示模型侧有 distillation 防护机制
  3. **Deferred tools + ToolSearch**：大量工具（MCP）通过 `defer_loading: true` 延迟加载，模型需先调用 ToolSearch 才能使用。减少初始 prompt 大小

- **可吸收**：session-stable latching 思路、deferred tools 模式（对 Quilin 05-Tool 有价值）
- **注意事项**：3,419 行巨型文件，混合了缓存策略、API 协议、功能开关等多个关注点

### 3.9 `src/services/compact/autoCompact.ts` + `microCompact.ts` —— 上下文压缩

- **职责**：autoCompact 管理自动压缩的触发和追踪；microCompact 处理工具结果级的精细压缩

#### autoCompact.ts
- **核心常量**：
  - `AUTOCOMPACT_BUFFER_TOKENS = 13,000` — 自动压缩触发缓冲区
  - `WARNING_THRESHOLD_BUFFER_TOKENS = 20,000` — 警告阈值
  - `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` — 连续失败断路器（BQ 数据：1,279 个 session 出现 50+ 次连续失败，浪费 ~250K API calls/day）
  - `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20,000` — 摘要输出预留（p99.99 实际为 17,387 tokens）

- `getEffectiveContextWindowSize(model)` = context_window - reserved_output_tokens(20k)

#### microCompact.ts
- **COMPACTABLE_TOOLS 白名单**：FileRead, Shell(所有变体), Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite
- **Cached microcompact**（ant-only, `feature('CACHED_MICROCOMPACT')`门控）：
  - 惰性初始化模块和状态，避免外部构建导入
  - `pendingCacheEdits` 用于 prompt cache 保持——微压缩可能删除已缓存的内容，需要 pinned cache edits 修补

- **创新点**：
  1. **断路器模式**：连续 3 次自动压缩失败后停止重试（数据驱动的阈值：250K API calls/day 浪费）
  2. **p99.99 驱动的参数**：20K 摘要预留基于实际 p99.99 数据（17,387 tokens）
  3. **Cached microcompact 与 prompt cache 协同**：压缩时通过 cache_edits 维护缓存一致性，而非简单地 bust cache

- **可吸收**：断路器 + 数据驱动的参数调优思路（Quilin 02-Context 压缩子系统）
- **注意事项**：`feature()` 门控使得外部构建看不到 cached microcompact 的完整实现

#### compact.ts（完整压缩流程，~1,300 行）

`compact.ts` 是压缩子系统的主文件，协调完整的会话压缩流程。

- **核心常量**：
  - `POST_COMPACT_MAX_FILES_TO_RESTORE = 5` — 压缩后最多恢复 5 个最近读取的文件到上下文
  - `POST_COMPACT_TOKEN_BUDGET = 50,000` — 恢复文件的总 token 预算
  - `POST_COMPACT_MAX_TOKENS_PER_FILE = 5,000` — 单文件恢复上限
  - `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5,000` — 单 skill 恢复上限（注释：verify=18.7KB, claude-api=20.1KB）
  - `POST_COMPACT_SKILLS_TOKEN_BUDGET = 25,000` — skill 总恢复预算（约容纳 5 个 skill）
  - `MAX_COMPACT_STREAMING_RETRIES = 2` — 流式摘要重试次数
  - `MAX_PTL_RETRIES = 3` — 压缩请求本身触发 prompt-too-long 时的重试次数

- **关键函数**：
  - `stripImagesFromMessages()` — 压缩前剥离图片/文档块，替换为 `[image]`/`[document]` 标记。避免压缩 API 调用本身触发 prompt-too-long，尤其在 CCD 频繁贴图场景
  - `stripReinjectedAttachments()` — 剥离会被压缩后重新注入的附件（skill_discovery/skill_listing），避免摘要污染
  - `truncateHeadForPTLRetry()` — CC-1180 修复：当压缩请求本身触发 prompt-too-long，从头部按 API-round 分组逐步截断，保证至少留一个分组可摘要
  - `compactConversation()` — 压缩主流程：PreCompact hooks -> 流式摘要（含 PTL 重试循环）-> 清理缓存 -> 并行恢复（文件附件 + async agent 附件）-> 重新注入 deferred tools/agent listing/MCP instructions delta -> SessionStart hooks -> 生成 boundary marker

- **Post-compact 恢复策略**：
  1. 从 `readFileState` 中取最近 5 个文件，每个上限 5K tokens，总预算 50K tokens
  2. 恢复当前 plan（如有）
  3. 恢复 plan mode 指令（如在 plan mode 中）
  4. 恢复已调用的 skills（per-skill 5K tokens 上限，总计 25K tokens）
  5. 重新广播 deferred tools / agent listing / MCP instructions delta（因压缩吃掉了之前的 delta 附件）
  6. 重新运行 SessionStart hooks

- **Forked Agent 压缩路径**：
  - 默认启用 prompt cache 共享（`tengu_compact_cache_prefix` 实验 2026.01 确认：关闭时 98% cache miss）
  - 通过 `runForkedAgent()` 在独立 agent 中执行摘要，复用主线程的 prompt cache prefix
  - 关键约束：不能设置 `maxOutputTokens`，否则会导致 thinking config 不匹配，使 cache 失效
  - Fallback：forked agent 失败时退回直接流式调用

- **创新点**：
  1. **压缩请求的自我保护**：压缩本身也可能 prompt-too-long，用 `truncateHeadForPTLRetry` 逐步截断（CC-1180），而非让用户卡死
  2. **Forked Agent + prompt cache 共享**：压缩在独立 agent 中执行但共享主线程缓存前缀，既隔离了压缩逻辑又避免了缓存浪费
  3. **Post-compact 全量恢复**：不是简单地用摘要替换全部上下文，而是系统性恢复文件、plan、skills、delta 附件，确保模型压缩后不失忆
  4. **图片剥离 + 附件去重**：压缩前精细化清理避免信息爆炸，压缩后精细化恢复确保关键上下文不丢

- **可吸收**：post-compact 恢复策略（文件/plan/skill/delta 四层恢复）、压缩请求自保护的 PTL 重试机制（Quilin 02-Context）
- **注意事项**：forked agent 路径依赖 prompt cache prefix 共享机制，Quilin 需评估是否有类似需求

### 3.10 `src/Tool.ts`（792 行）—— 工具类型定义与注册

- **职责**：定义 Tool 接口、ToolUseContext 上下文类型、工具查找函数
- **核心结构**：
  - L90-94：`QueryChainTracking` 类型——chainId + depth，追踪查询链
  - L158-300：`ToolUseContext` — **巨型上下文对象**，携带 options、abortController、readFileState、appState 访问器、MCP clients、agent 定义、文件读取限制、denial tracking、content replacement state 等 40+ 字段
  - L362-560：`Tool` 类型——完整的工具接口定义

- **Tool 接口关键方法**：

| 方法 | 职责 |
|------|------|
| `call()` | 工具执行入口 |
| `checkPermissions()` | 工具特定的权限检查 |
| `isConcurrencySafe()` | 是否可与其他工具并发 |
| `isReadOnly()` | 是否只读 |
| `isDestructive()` | 是否不可逆（删除、覆盖、发送） |
| `interruptBehavior()` | 用户中断时的行为（cancel 或 block） |
| `shouldDefer` | 是否延迟加载（需 ToolSearch） |
| `alwaysLoad` | 是否始终加载（即使 ToolSearch 启用） |
| `toAutoClassifierInput()` | 为安全分类器提供紧凑输入表示 |
| `backfillObservableInput()` | 回填可观测输入（不修改原始 API 输入，保护 prompt cache） |
| `maxResultSizeChars` | 结果超限时持久化到磁盘，避免上下文溢出 |

- **创新点**：
  1. **Tool 即安全契约**：每个工具自声明 `isDestructive`、`isReadOnly`、`isConcurrencySafe`、`interruptBehavior`、`checkPermissions`，安全属性分散在工具定义中而非集中管理
  2. **`toAutoClassifierInput()` 投影**：每个工具控制暴露给分类器的最小信息（如 Bash 只暴露命令，Edit 只暴露路径+内容概要），而非传递完整输入
  3. **`backfillObservableInput()` 的 prompt cache 保护**：只在副本上回填（SDK stream、transcript、hooks 看到的是副本），原始 API 输入不可变
  4. **Deferred loading 协议**：`shouldDefer` + `alwaysLoad` + `searchHint` 三字段配合 ToolSearch 实现按需加载

- **可吸收**：Tool 接口设计（Quilin 05-Tool 的核心参考）、安全属性自声明模式、deferred loading 协议
- **注意事项**：`ToolUseContext` 有 40+ 字段，是 God Object 反模式。Quilin 应拆分为 PermissionContext、ExecutionContext、UIContext 等

---

## 4. 创新点清单

| # | 创新点 | 描述 | 对 Quilin 的价值 | 关联领域 |
|---|--------|------|-----------------|---------|
| 1 | 5 层上下文压缩流水线 | applyToolResultBudget → snipCompact → microCompact → contextCollapse → autoCompact，粒度从工具结果级到全量摘要递进 | **极高**：Quilin 02-Context 的首要参考。分层思路比单一压缩策略灵活得多 | 02-上下文 |
| 2 | `feature()` 编译期死代码消除 | `bun:bundle` 提供的 `feature('XXX')` 宏，ant-only 代码在外部构建中被彻底消除 | **高**：Quilin 可用于 edition（社区版/企业版）区分 | 09-部署运行时 |
| 3 | 2 阶段 XML 权限分类器 | Stage 1 快速判断（64 token）→ Stage 2 深度推理（带 thinking），90%+ 调用走 Stage 1 快速路径 | **极高**：Quilin 07-Safety 的核心架构参考 | 07-安全护栏 |
| 4 | StreamingToolExecutor | 模型还在流式输出就开始执行工具，三级 AbortController 树，选择性错误级联 | **高**：显著降低端到端延迟。Quilin 05-Tool 应实现 | 05-工具 |
| 5 | 两阶段 Prompt Cache 检测 | Phase 1 预记录 12+ 维度哈希，Phase 2 检查实际 token 下降，精确定位失效原因 | **中**：对 Quilin 08-Observability 有参考价值，但 Quilin 可能不自己管 cache | 08-可观测性 |
| 6 | Tool 安全属性自声明 | 每个工具自声明 isDestructive / isReadOnly / isConcurrencySafe / interruptBehavior / checkPermissions | **极高**：Quilin 05-Tool 和 07-Safety 的接口设计参考 | 05-工具, 07-安全护栏 |
| 7 | Denial tracking + fallback-to-prompting | 连续拒绝计数器达阈值后从 auto-deny 回退到交互式提示 | **高**：防止 Agent 因权限拒绝死锁 | 07-安全护栏 |
| 8 | Session-stable latching | Beta header 一旦启用就锁定不变，防止中途 GrowthBook flag 变化导致 cache bust | **中**：配置稳定性思路，Quilin 09-部署运行时可参考 | 09-部署运行时 |
| 9 | Max output tokens 恢复链 | 8k→64k 升级 → 多轮恢复（最多 3 次）→ "resume directly, no apology" 元消息 | **高**：Quilin 01-LLM 接入的容错策略 | 01-LLM 接入 |
| 10 | 工具结果持久化到磁盘 | 超过 `maxResultSizeChars` 的结果存入文件，上下文只保留预览+文件路径 | **高**：优雅处理大结果，Quilin 02-Context 可借鉴 | 02-上下文 |
| 11 | Deferred tools + ToolSearch | 大量工具延迟加载（`shouldDefer: true`），模型需先搜索才能使用 | **高**：Quilin 05-Tool 的工具数量扩展方案 | 05-工具 |
| 12 | Partition 算法（并发批次） | 连续 read-only 工具合并为并发批次，write 工具独立成串行批次 | **中**：简单有效的并发策略 | 05-工具 |
| 13 | Tombstone 消息 | 流式 fallback 时为孤儿 assistant 消息生成 tombstone | **低**：边缘场景处理 | 02-上下文 |
| 14 | Memory prefetch（`using` 资源管理） | 利用 TC39 Explicit Resource Management 在 turn 开始时预取记忆 | **中**：Quilin 03-记忆的预取策略参考 | 03-记忆 |
| 15 | 断路器模式（autocompact 失败限制） | 连续 3 次失败停止重试，基于线上数据（250K API calls/day 浪费）的阈值 | **高**：数据驱动的运维优化，Quilin 通用 | 08-可观测性 |

---

## 5. Quilin 关联评分

| 领域 | 评分 (0-5) | 具体关联 |
|------|-----------|---------|
| 01-LLM 接入 | 4 | max_output_tokens 恢复链（8k→64k→多轮）、effort 参数配置、model fallback 机制。`configureEffortParams()` 和 `configureTaskBudgetParams()` 的参数处理逻辑可直接参考 |
| 02-上下文 | **5** | **最强关联**。5 层压缩流水线是 Quilin OmniMem 上下文管理的首要参考。工具结果持久化、taskBudgetRemaining 跨压缩追踪、p99.99 驱动的参数调优——每个都是核心设计输入 |
| 03-记忆 | 3 | Memory prefetch 机制、`filterDuplicateMemoryAttachments`（去重）、`nestedMemoryAttachmentTriggers`（触发器）。但 Claude Code 的记忆系统相对简单（CLAUDE.md 文件 + session memory），与 Quilin 的 OmniMem 4 层架构差距大 |
| 04-规划 | 2 | Plan mode 影响模型选择（`getRuntimeMainLoopModel` 在 plan mode 时切换模型）。但 Claude Code 没有显式的任务分解或策略切换——它的"规划"更多靠模型本身的推理能力 |
| 05-工具 | **5** | **最强关联之一**。Tool 接口设计（安全属性自声明）、StreamingToolExecutor、Partition 算法、Deferred tools + ToolSearch、工具别名机制——全部是 Quilin 工具工程的核心参考 |
| 06-多 Agent | 2 | `agentId` + `querySource` 区分主线程和子 Agent、`createSubagentContext` 克隆上下文、消息队列 agent 作用域隔离。但 Claude Code 的多 Agent 本质是 fork 子进程执行独立任务，不是 Quilin 设想的同构/异构 mesh |
| 07-安全护栏 | **5** | **最强关联之一**。2 阶段 XML 分类器、4 快速路径绕过、Denial tracking + fallback、Tool 安全属性自声明、safetyCheck classifierApprovable 分级——这是业界最精密的 Agent 权限系统之一 |
| 08-可观测性 | 3 | OTel 权限决策来源映射、prompt cache break 检测（精确到维度）、`queryCheckpoint()` 性能追踪、断路器 + 数据驱动阈值。但 Claude Code 的可观测性更偏向内部诊断，不是面向用户的 |
| 09-部署运行时 | 3 | `feature()` 编译期功能开关（edition 区分）、session-stable latching（配置稳定性）、`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 等环境变量调优。CLI 架构本身与 Quilin 的部署模型不同 |
| 10-自进化 | 1 | Skill discovery prefetch、`dynamicSkillDirTriggers`——暗示动态技能发现机制。但 Claude Code 没有真正的自进化能力（不自修改 scaffold），Quilin 的 10-SelfEvolution 远超其设计范围 |
| 11-Agent Mesh | 0 | **无关联**。Claude Code 是单实例 CLI 工具，不涉及 Agent 间网络通信、服务发现、能力注册等 mesh 概念 |

---

## 6. 吸收计划

### 建议吸收

| 功能 | 吸收方式 | 预估工作量 | 优先级 |
|------|---------|-----------|--------|
| 5 层上下文压缩流水线 | **借鉴思路重写**：分层架构借鉴，但实现需适配 Quilin 的 OmniMem 4 层记忆和 MCP 工具体系 | 3-5 天 | P0 |
| Tool 接口安全属性自声明 | **借鉴思路重写**：`isConcurrencySafe`、`isDestructive`、`isReadOnly`、`interruptBehavior`、`checkPermissions` 的接口设计直接借鉴 | 1-2 天 | P0 |
| 2 阶段 XML 分类器架构 | **借鉴思路重写**：Stage 1 快速 / Stage 2 深度的两阶段思路借鉴。Quilin 可用本地小模型做 Stage 0 | 3-5 天 | P0 |
| StreamingToolExecutor 模式 | **借鉴思路重写**：三级 abort 树、选择性错误级联、有序结果发射的架构借鉴 | 2-3 天 | P1 |
| Denial tracking + fallback | **借鉴思路重写**：连续拒绝计数器 + 阈值回退的策略直接借鉴 | 0.5 天 | P1 |
| Deferred tools + ToolSearch | **借鉴思路重写**：`shouldDefer` / `alwaysLoad` / `searchHint` 三字段协议 | 1-2 天 | P1 |
| Max output tokens 恢复链 | **借鉴思路重写**：8k→64k 升级 + 多轮恢复 + "resume directly" 元消息 | 0.5 天 | P2 |
| Partition 算法（并发批次） | **借鉴思路重写**：简单但有效，可直接实现 | 0.5 天 | P2 |
| `feature()` 编译期功能开关 | **仅参考**：Quilin 使用 TS + Python + Rust 三语言，需要跨语言的 feature flag 方案 | — | P2 |
| 断路器模式 | **借鉴思路重写**：通用的连续失败限制策略 | 0.5 天 | P2 |

### 明确不吸收

| 功能 | 理由 |
|------|------|
| Prompt cache break 两阶段检测 | Quilin 使用 litellm 多模型，不直接管理 Anthropic prompt cache。过度工程 |
| Session-stable latching | 与 Anthropic API 特定的 beta header 机制绑定。Quilin 有自己的配置管理 |
| Tombstone 消息机制 | 边缘场景处理，优先级极低 |
| Cached microcompact + cache_edits | ant-only 功能，与 Anthropic 内部缓存协议绑定 |
| `classifyToolError()` telemetry 安全设计 | 过于细节，Quilin 的错误分类可以更简单 |
| GrowthBook feature flag 集成 | Quilin 不使用 GrowthBook |

### 与现有设计的冲突

| 冲突点 | 现有设计（Quilin） | Claude Code 做法 | 建议 |
|--------|-------------------|-----------------|------|
| Agent Loop 实现 | ADR-001 已确认 < 200 行 TS 核心循环 | queryLoop 实际 1,488 行 | **不冲突但需警惕**：保持核心循环精简，将压缩、恢复、权限等拆分为独立 Phase 模块。200 行只是核心调度逻辑，不含所有功能 |
| 工具安全模型 | 07-Safety 设计 4 层验证 | permissions.ts 1,486 行单文件 + yoloClassifier.ts 1,495 行 | **架构一致，实现要拆分**：Quilin 应按层拆分权限逻辑，避免 Claude Code 的巨文件问题 |
| 上下文管理 | OmniMem 4 层 (working/episodic/semantic/skill) | 5 层压缩流水线（粒度不同） | **互补**：OmniMem 是记忆分层，5 层流水线是压缩分层。两者正交，可组合使用 |
| 记忆系统 | 4 层 + vector + KG | CLAUDE.md 文件 + session memory + memory prefetch | **Quilin 远超**：Claude Code 的记忆系统简陋。Quilin 无需参考其记忆实现，只参考 prefetch 策略 |
| 多 Agent | 同构 spawn + 异构 mesh | fork 子进程 + agentId 隔离 | **不同层次**：Claude Code 是进程内子 agent，Quilin 是跨进程/跨机器 mesh。不冲突 |

---

## 附录：核心文件索引

| 文件路径 | 行数 | 核心职责 |
|---------|------|---------|
| `src/query.ts` | 1,729 | Agent Loop 核心状态机 |
| `src/services/tools/StreamingToolExecutor.ts` | 530 | 流式工具执行 + 并发控制 |
| `src/services/tools/toolOrchestration.ts` | 188 | 工具批次编排（非流式路径） |
| `src/services/tools/toolExecution.ts` | 1,745 | 工具执行 + 权限检查入口 |
| `src/utils/permissions/permissions.ts` | 1,486 | 权限引擎 |
| `src/utils/permissions/yoloClassifier.ts` | 1,495 | 2 阶段 XML 权限分类器 |
| `src/services/api/promptCacheBreakDetection.ts` | 727 | Prompt Cache 监控 |
| `src/services/api/claude.ts` | 3,419 | API 调用 + 缓存策略 |
| `src/services/compact/autoCompact.ts` | ~300 | 自动压缩触发与追踪 |
| `src/services/compact/microCompact.ts` | ~200 | 工具结果微压缩 |
| `src/Tool.ts` | 792 | Tool 接口 + ToolUseContext 定义 |
